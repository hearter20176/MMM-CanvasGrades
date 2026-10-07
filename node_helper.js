"use strict";

// MMM-CanvasGrades node_helper: one entry point for every Canvas call. Per module instance it runs a
// polling state machine (running, backoff, auth_failed, config_error), keeps the last good snapshot,
// and publishes a sanitized view model. The token never leaves this process.

const fs = require("node:fs");
const path = require("node:path");
const NodeHelper = require("node_helper");
const Log = require("logger");
const {
	normalizeConfig,
	resolveToken,
	configDir,
	inQuietHours,
	msUntilQuietEnd,
	instanceSignature,
	sha256
} = require("./lib/config");
const { createClient, CanvasError } = require("./lib/canvas-client");
const grades = require("./lib/grades");

const PREFIX = "[MMM-CanvasGrades]";
const NOTIFICATION_REGISTER = "CANVASGRADES_REGISTER";
const NOTIFICATION_STATE = "CANVASGRADES_STATE";
const CACHE_MAGIC = "MMM-CanvasGrades-cache";
const MAX_CACHE_FILES = 8;
const CACHE_NAME = /^canvas-grades-cache-[0-9a-f]{16}\.json$/;
const CACHE_KEEP = 8;
const CACHE_MAX_AGE_MS = 30 * 24 * 3600 * 1000;
const MAX_CACHE_BYTES = 5 * 1024 * 1024;
const OBSERVEE_CACHE_MS = 24 * 3600 * 1000;
const SLOW_RETRY_MS = 6 * 3600 * 1000;
const TRANSIENT_KINDS = ["network", "timeout", "server", "throttled"];

const CONFIG_HINTS = {
	url: "canvasUrl is missing or not an https address",
	token: "no token set (accessToken, accessTokenFile or CANVAS_ACCESS_TOKEN)",
	url_and_token:
		"canvasUrl is missing or not an https address, and no token is set (accessToken, accessTokenFile or CANVAS_ACCESS_TOKEN)"
};

const log = {
	debug: (message) => Log.debug(`${PREFIX} ${message}`),
	info: (message) => Log.info(`${PREFIX} ${message}`),
	warn: (message) => Log.warn(`${PREFIX} ${message}`),
	error: (message) => Log.error(`${PREFIX} ${message}`)
};

module.exports = NodeHelper.create({
	start() {
		this._init();
		log.info("helper started");
	},

	stop() {
		for (const inst of Array.from(this.instances.values())) this._stopInstance(inst);
		this.instances.clear();
	},

	_init() {
		if (this.instances) return;
		this.instances = new Map();
		this.cachePaths = new Map();
		this.pinnedOrigin = "";
		this.queue = Promise.resolve();
		this.fetchImpl = null;
		this.sleepImpl = null;
	},

	// ---- overridable seams (tests) ------------------------------------------------------------
	_now() {
		return Date.now();
	},

	_random() {
		return Math.random();
	},

	_setTimer(fn, ms) {
		const timer = setTimeout(fn, ms);
		if (timer && typeof timer.unref === "function") timer.unref();
		return timer;
	},

	_clearTimer(timer) {
		clearTimeout(timer);
	},

	_sleep(ms) {
		if (this.sleepImpl) return this.sleepImpl(ms);
		return new Promise((resolve) => this._setTimer(resolve, ms));
	},

	// Global serial queue: one Canvas request in flight across all module instances.
	_enqueue(fn) {
		const run = this.queue.then(fn, fn);
		this.queue = run.then(
			() => undefined,
			() => undefined
		);
		return run;
	},

	// ---- socket entry -------------------------------------------------------------------------
	socketNotificationReceived(notification, payload) {
		if (notification !== NOTIFICATION_REGISTER) return;
		this._init();
		try {
			if (!payload || typeof payload.instanceId !== "string" || !payload.instanceId) return;
			this._register(payload.instanceId, payload.config);
		} catch (err) {
			log.error(`register failed (${err && err.name ? err.name : "error"})`);
		}
	},

	_resolveToken(cfg) {
		return resolveToken(cfg, this.tokenDeps || {});
	},

	_register(instanceId, rawConfig) {
		const existing = this.instances.get(instanceId);
		let input = rawConfig;
		if (existing && input !== null && typeof input === "object") {
			// the socket accepts registrations from any client, so a re-register may never redirect the token
			// to another host or point it at another file
			const probe = normalizeConfig(input).cfg;
			const lock = existing.lock;
			if (
				probe.canvasUrl !== lock.canvasUrl ||
				probe.accessToken !== lock.accessToken ||
				probe.accessTokenFile !== lock.accessTokenFile
			) {
				log.warn("a re-registration tried to change canvasUrl or the token source; the change was ignored");
				input = { ...input, ...lock };
			}
		}
		const { cfg, warnings } = normalizeConfig(input);
		const lock = existing
			? existing.lock
			: { canvasUrl: cfg.canvasUrl, accessToken: cfg.accessToken, accessTokenFile: cfg.accessTokenFile };
		const tokenInfo = this._resolveToken(cfg);
		const sig = instanceSignature(cfg, tokenInfo.descriptor);
		if (existing && existing.sig === sig) {
			this._publish(existing, true);
			return;
		}
		const refused = this._checkPin(cfg, tokenInfo);
		if (existing) this._stopInstance(existing);
		for (const warning of warnings) log.warn(warning);
		const inst = {
			id: instanceId,
			sig,
			cfg,
			lock,
			generation: 0,
			phase: "running",
			timer: null,
			controller: new AbortController(),
			inFlight: false,
			runPromise: null,
			paused: false,
			snapshot: null,
			lastError: null,
			failures: 0,
			retryAfterMs: 0,
			rejectedTokenHash: "",
			authRetryAt: 0,
			observees: null,
			missingMode: null,
			refused,
			notFoundKey: "",
			cacheEnabled: false,
			cachePath: "",
			lastPublished: null,
			nextRunAt: 0
		};
		this.instances.set(instanceId, inst);
		this._startInstance(inst);
	},

	// Every stored token (file or environment, all sources together) may only ever be sent to ONE Canvas origin
	// per process: the first registration with a usable token wins, and CANVAS_URL (if set) is a hard pin. A token
	// written inline in the config belongs to the caller and needs no pin. Returns a refusal reason, or "".
	_checkPin(cfg, tokenInfo) {
		if (tokenInfo.source !== "file" && tokenInfo.source !== "env") return "";
		if (!cfg.canvasUrl) return "";
		const env = (this.tokenDeps && this.tokenDeps.env) || process.env;
		const origin = new URL(cfg.canvasUrl).origin;
		const hard = typeof env.CANVAS_URL === "string" ? env.CANVAS_URL.trim() : "";
		if (hard) {
			const pinned = normalizeConfig({ canvasUrl: hard }).cfg.canvasUrl;
			if (!pinned) return "CANVAS_URL is set but is not a valid https address";
			if (new URL(pinned).origin !== origin) return "canvasUrl does not match CANVAS_URL";
		}
		if (this.pinnedOrigin && this.pinnedOrigin !== origin)
			return "stored tokens are already bound to a different Canvas host";
		// only a usable token claims the pin, so a bogus registration cannot lock the real one out
		if (!this.pinnedOrigin && tokenInfo.ok) this.pinnedOrigin = origin;
		return "";
	},

	// ---- lifecycle ----------------------------------------------------------------------------
	_startInstance(inst) {
		const cfg = inst.cfg;
		if (inst.refused) {
			inst.phase = "config_error";
			this._refuse(inst);
			this._publish(inst, true);
			return;
		}
		const tokenInfo = this._resolveToken(cfg);
		const detail = this._configDetail(cfg, tokenInfo);
		if (detail) {
			inst.phase = "config_error";
			inst.lastError = { kind: "config", terminal: true, detail };
			log.error(`configuration incomplete: ${CONFIG_HINTS[detail]}; no requests will be made`);
			this._publish(inst, true);
			return;
		}
		if (!tokenInfo.ok) {
			this._enterTokenFileError(inst, tokenInfo);
			this._publish(inst, true);
			return;
		}
		this._noteTokenSource(inst, tokenInfo);
		if (cfg.cache) this._setupCache(inst);
		this._readCache(inst);
		this._publish(inst, true);
		this._run(inst);
	},

	_refuse(inst, reason) {
		if (reason) inst.refused = reason;
		inst.phase = "config_error";
		inst.lastError = { kind: "config", terminal: true, detail: "origin_pinned" };
		log.error(`canvasUrl refused: ${inst.refused}; no requests will be made`);
	},

	_stopInstance(inst) {
		if (inst.timer) this._clearTimer(inst.timer);
		inst.timer = null;
		inst.controller.abort();
		inst.generation += 1;
		inst.phase = "stopped";
		if (inst.cachePath && this.cachePaths.get(inst.cachePath) === inst.id) this.cachePaths.delete(inst.cachePath);
		if (this.instances.get(inst.id) === inst) this.instances.delete(inst.id);
	},

	_configDetail(cfg, tokenInfo) {
		const noUrl = cfg.canvasUrl === "";
		const noToken = !tokenInfo.ok && tokenInfo.error && tokenInfo.error.kind === "no_token";
		if (noUrl && noToken) return "url_and_token";
		if (noUrl) return "url";
		if (noToken) return "token";
		return null;
	},

	_enterTokenFileError(inst, tokenInfo) {
		inst.phase = "config_error";
		const info = tokenInfo.error || {};
		inst.lastError = { kind: "token_file", terminal: true, detail: info.code === "BAD_NAME" ? "bad_name" : null };
		if (info.code === "BAD_NAME") {
			log.error(
				`accessTokenFile "${info.file}" refused: the file must be named canvas-token or canvas-token-<anything>; its content was not read`
			);
		} else {
			log.error(`accessTokenFile could not be read (${info.file || "file"}, ${info.code || "error"})`);
		}
		this._schedule(inst, inst.cfg.updateInterval, "token_file");
	},

	_noteTokenSource(inst, tokenInfo) {
		if (tokenInfo.loose && !inst.looseWarned) {
			inst.looseWarned = true;
			log.warn("accessTokenFile is readable by other users; chmod 600 recommended");
		}
	},

	// ---- scheduling ---------------------------------------------------------------------------
	_schedule(inst, delayMs, reason) {
		if (inst.timer) this._clearTimer(inst.timer);
		inst.timer = null;
		if (inst.phase === "stopped") return;
		const now = this._now();
		let delay = Math.max(0, Math.round(delayMs));
		const pause = inst.cfg.pauseBetween;
		if (pause) {
			const target = new Date(now + delay);
			if (inQuietHours(pause, target)) delay += msUntilQuietEnd(pause, target) + 500;
		}
		const generation = inst.generation;
		inst.nextRunAt = now + delay;
		inst.nextReason = reason;
		inst.timer = this._setTimer(() => {
			inst.timer = null;
			if (inst.generation !== generation || inst.phase === "stopped") return;
			this._onTimer(inst);
		}, delay);
	},

	_onTimer(inst) {
		if (inst.phase === "config_error") {
			if (inst.lastError && inst.lastError.kind === "token_file") this._recheckTokenFile(inst);
			return;
		}
		if (inst.phase === "auth_failed") {
			this._authCheck(inst);
			return;
		}
		this._run(inst);
	},

	_recheckTokenFile(inst) {
		const tokenInfo = this._resolveToken(inst.cfg);
		if (!tokenInfo.ok) {
			this._schedule(inst, inst.cfg.updateInterval, "token_file");
			return;
		}
		inst.phase = "running";
		inst.lastError = null;
		this._noteTokenSource(inst, tokenInfo);
		this._publish(inst, false);
		this._run(inst);
	},

	_authCheck(inst) {
		const tokenInfo = this._resolveToken(inst.cfg);
		if (!tokenInfo.ok) {
			this._enterTokenFileError(inst, tokenInfo);
			this._publish(inst, false);
			return;
		}
		const changed = sha256(tokenInfo.token) !== inst.rejectedTokenHash;
		if (changed || this._now() >= inst.authRetryAt) {
			inst.phase = "running";
			this._run(inst);
			return;
		}
		this._schedule(inst, inst.cfg.updateInterval, "auth_check");
	},

	_backoffDelay(kind, failures, cfg, retryAfterMs = 0) {
		const exponent = Math.min(Math.max(failures - 1, 0), 20);
		const throttled = kind === "throttled";
		let delay = throttled
			? Math.min(900000, 30000 * 2 ** exponent)
			: Math.max(60000, Math.min(900000, 60000 * 2 ** exponent));
		delay *= 0.8 + this._random() * 0.4;
		delay = Math.min(delay, cfg.updateInterval);
		if (!throttled) delay = Math.max(delay, 60000);
		if (throttled && retryAfterMs > 0) delay = Math.max(delay, retryAfterMs);
		return Math.round(delay);
	},

	// ---- one polling run ----------------------------------------------------------------------
	_run(inst) {
		if (inst.phase === "stopped" || inst.inFlight) return inst.runPromise;
		const now = this._now();
		const pause = inst.cfg.pauseBetween;
		// with no data (or only stale cached data), one fetch is made even inside the quiet window
		const fresh = inst.snapshot !== null && now - inst.snapshot.fetchedAt <= inst.cfg.staleAfter;
		if (pause && inQuietHours(pause, new Date(now)) && fresh) {
			inst.paused = true;
			this._publish(inst, false);
			this._schedule(inst, msUntilQuietEnd(pause, new Date(now)) + 500, "quiet_end");
			return Promise.resolve();
		}
		if (inst.paused) {
			inst.paused = false;
			this._publish(inst, false);
		}
		inst.inFlight = true;
		inst.runPromise = this._runCycle(inst)
			.catch((err) => log.error(`cycle failed unexpectedly (${err && err.name ? err.name : "error"})`))
			.finally(() => {
				inst.inFlight = false;
			});
		return inst.runPromise;
	},

	async _runCycle(inst) {
		const generation = inst.generation;
		const stale = () => inst.generation !== generation;
		const tokenInfo = this._resolveToken(inst.cfg);
		if (!tokenInfo.ok) {
			if (tokenInfo.error && tokenInfo.error.kind === "token_file") {
				this._enterTokenFileError(inst, tokenInfo);
				this._publish(inst, false);
			} else {
				inst.phase = "config_error";
				inst.lastError = { kind: "config", terminal: true, detail: "token" };
				this._publish(inst, false);
			}
			return;
		}
		const pinReason = this._checkPin(inst.cfg, tokenInfo);
		if (pinReason) {
			this._refuse(inst, pinReason);
			this._publish(inst, false);
			return;
		}
		this._noteTokenSource(inst, tokenInfo);
		if (inst.phase === "config_error") inst.phase = "running";

		try {
			const result = await this._fetchSnapshot(inst, tokenInfo.token);
			if (stale()) return;
			inst.phase = "running";
			inst.failures = 0;
			inst.lastError = null;
			inst.snapshot = {
				fetchedAt: this._now(),
				partial: result.partial,
				notFound: result.notFoundCount,
				multiStudent: result.students.length > 1,
				students: result.students
			};
			this._writeCache(inst);
			const missingTotal = result.students.reduce((sum, student) => sum + student.missingTotal, 0);
			log.info(
				`cycle complete: ${result.students.length} student(s), ${missingTotal} missing${result.partial ? ", partial" : ""}`
			);
			this._publish(inst, false);
			this._schedule(inst, inst.cfg.updateInterval, "interval");
		} catch (err) {
			if (stale()) return;
			this._handleError(inst, err, tokenInfo.token);
		}
	},

	_handleError(inst, err, token) {
		const kind = err instanceof CanvasError ? err.kind : "internal";
		if (kind === "aborted") return;
		if (kind === "auth") {
			inst.phase = "auth_failed";
			inst.lastError = { kind: "auth", terminal: true, detail: null };
			inst.rejectedTokenHash = sha256(token);
			inst.authRetryAt = this._now() + SLOW_RETRY_MS;
			inst.observees = null;
			log.error("Canvas rejected the access token; generate a new one");
			this._publish(inst, false);
			this._schedule(inst, inst.cfg.updateInterval, "auth_check");
			return;
		}
		if (kind === "no_students") {
			inst.phase = "running";
			inst.lastError = { kind: "no_students", terminal: false, detail: null };
			log.warn("no linked students found for this account");
			this._publish(inst, false);
			this._schedule(inst, inst.cfg.updateInterval, "interval");
			return;
		}
		if (kind === "forbidden" || kind === "not_found") {
			inst.phase = "running";
			inst.observees = null;
			inst.lastError = { kind: "forbidden", terminal: false, detail: null };
			log.warn("Canvas denied access to a required resource");
			this._publish(inst, false);
			this._schedule(inst, SLOW_RETRY_MS, "slow_retry");
			return;
		}
		const transient = TRANSIENT_KINDS.includes(kind) ? kind : "server";
		if (kind === "internal") log.error(`unexpected error during cycle (${err && err.name ? err.name : "error"})`);
		inst.phase = "backoff";
		inst.failures += 1;
		inst.lastError = { kind: transient, terminal: false, detail: null };
		const delay = this._backoffDelay(transient, inst.failures, inst.cfg, err && err.retryAfterMs);
		log.warn(`Canvas request failed (${transient}); retrying in ${Math.round(delay / 1000)} s`);
		this._publish(inst, false);
		this._schedule(inst, delay, "backoff");
	},

	// ---- Canvas data --------------------------------------------------------------------------
	_client(inst, token) {
		return createClient({
			baseUrl: inst.cfg.canvasUrl,
			token,
			timeoutMs: inst.cfg.requestTimeout,
			signal: inst.controller.signal,
			fetchImpl: (...args) => (this.fetchImpl || globalThis.fetch)(...args),
			sleep: (ms) => this._sleep(ms),
			log,
			schedule: (fn) => this._enqueue(fn)
		});
	},

	async _getStudents(client, inst) {
		const now = this._now();
		let list = inst.observees && now - inst.observees.at <= OBSERVEE_CACHE_MS ? inst.observees.list : null;
		if (!list) {
			list = await client.getAll("/users/self/observees");
			if (list.length === 0) {
				const courses = await client.getAll("/courses", {
					enrollment_state: "active",
					include: ["observed_users"]
				});
				list = grades.observeesFromCourses(courses);
			}
			// an empty list is never cached, so a newly linked student appears on the next cycle
			inst.observees = list.length > 0 ? { at: now, list } : null;
		}
		const { selected, notFound } = grades.selectStudents(list, inst.cfg);
		const notFoundKey = notFound.join(",");
		if (notFoundKey !== inst.notFoundKey) {
			inst.notFoundKey = notFoundKey;
			if (notFound.length > 0) log.warn(`configured students not linked to this account: ${notFoundKey}`);
		}
		if (selected.length === 0) throw new CanvasError("no_students", "No linked students found");
		return { selected, notFoundCount: notFound.length };
	},

	async _getMissingAssignments(client, inst, studentId, courseIds) {
		if (inst.missingMode === "unusable" || courseIds.length === 0) return null;
		const variants = {
			self: () =>
				client.getAll("/users/self/missing_submissions", {
					observed_user_id: studentId,
					course_ids: courseIds,
					include: ["course"],
					filter: ["submittable"]
				}),
			child: () =>
				client.getAll(`/users/${encodeURIComponent(studentId)}/missing_submissions`, {
					include: ["course"],
					filter: ["submittable"]
				})
		};
		const order = inst.missingMode
			? [inst.missingMode, inst.missingMode === "self" ? "child" : "self"]
			: ["self", "child"];
		for (const variant of order) {
			try {
				const result = await variants[variant]();
				inst.missingMode = variant;
				return result;
			} catch (err) {
				if (!(err instanceof CanvasError) || (err.kind !== "forbidden" && err.kind !== "not_found")) throw err;
			}
		}
		inst.missingMode = "unusable";
		log.info(
			"missing_submissions endpoint is not available for this account; deriving missing work from submissions"
		);
		return null;
	},

	async _fetchSnapshot(inst, token) {
		const cfg = inst.cfg;
		const client = this._client(inst, token);
		const now = this._now();
		const { selected: students, notFoundCount } = await this._getStudents(client, inst);
		const views = [];
		let partial = false;

		for (const student of students) {
			const sid = student.id;
			let courseList;
			try {
				courseList = await client.getAll(`/users/${encodeURIComponent(sid)}/courses`, {
					enrollment_state: "active",
					state: ["available"],
					include: ["total_scores", "current_grading_period_scores", "term"]
				});
			} catch (err) {
				if (err instanceof CanvasError && (err.kind === "not_found" || err.kind === "forbidden"))
					inst.observees = null;
				throw err;
			}
			const courses = grades.selectCourses(courseList, cfg);
			const courseIds = courses.map((course) => String(course.id));

			const missingAssignments = cfg.showMissing
				? await this._getMissingAssignments(client, inst, sid, courseIds)
				: null;
			// submissions are always fetched when they feed anything: the endpoint is merged with them, never trusted alone
			const needSubmissions = cfg.showMissing || cfg.showRecentGrades > 0;

			const submissionsByCourse = new Map();
			const failedCourseIds = new Set();
			if (needSubmissions) {
				for (const courseId of courseIds) {
					try {
						const subs = await client.getAll(
							`/courses/${encodeURIComponent(courseId)}/students/submissions`,
							{
								student_ids: [sid],
								include: ["assignment"]
							}
						);
						submissionsByCourse.set(courseId, subs);
					} catch (err) {
						if (
							err instanceof CanvasError &&
							["forbidden", "not_found", "bad_response"].includes(err.kind)
						) {
							failedCourseIds.add(courseId);
							partial = true;
							log.debug(`submissions unavailable for course ${courseId} (${err.kind})`);
						} else {
							throw err;
						}
					}
				}
			}
			views.push(
				grades.buildStudentView({
					student,
					courses,
					submissionsByCourse,
					failedCourseIds,
					missingAssignments,
					cfg,
					now
				})
			);
		}
		return { students: views, partial, notFoundCount };
	},

	// ---- publishing ---------------------------------------------------------------------------
	_buildPayload(inst) {
		const snapshot = inst.snapshot;
		const err = inst.lastError;
		let status = "loading";
		if (snapshot) status = "ok";
		else if (err) status = "error";
		return {
			instanceId: inst.id,
			status,
			error: err ? { kind: err.kind, terminal: err.terminal === true, detail: err.detail || null } : null,
			fetchedAt: snapshot ? snapshot.fetchedAt : null,
			staleAfterMs: inst.cfg.staleAfter,
			partial: snapshot ? snapshot.partial === true : false,
			studentsNotFound: snapshot && Number.isInteger(snapshot.notFound) ? snapshot.notFound : 0,
			paused: inst.paused === true,
			multiStudent: snapshot ? snapshot.multiStudent === true : false,
			students: snapshot ? snapshot.students : []
		};
	},

	_publish(inst, force) {
		if (inst.phase === "stopped") return;
		const payload = this._buildPayload(inst);
		const json = JSON.stringify(payload);
		if (!force && json === inst.lastPublished) return;
		inst.lastPublished = json;
		this.sendSocketNotification(NOTIFICATION_STATE, payload);
	},

	// ---- cache file ---------------------------------------------------------------------------
	// The path is derived here from the Canvas origin and the student selection; nothing in a socket
	// payload ever chooses a file name, so a client cannot make the helper write anywhere.
	_setupCache(inst) {
		if (this.cachePaths.size >= MAX_CACHE_FILES) {
			log.warn("too many cache files in use; running without cache");
			return;
		}
		const cfg = inst.cfg;
		const hash = sha256(
			JSON.stringify([
				new URL(cfg.canvasUrl).origin,
				cfg.students,
				cfg.courses,
				cfg.excludeCourses,
				cfg.students.length ? "" : inst.id
			])
		).slice(0, 16);
		const file = path.join(configDir(this.tokenDeps || {}), `canvas-grades-cache-${hash}.json`);
		const owner = this.cachePaths.get(file);
		if (owner && owner !== inst.id && this.instances.has(owner)) {
			log.warn("another module instance already uses this cache file; running without cache");
			return;
		}
		this.cachePaths.set(file, inst.id);
		inst.cachePath = file;
		inst.cacheEnabled = true;
	},

	// Returns the parsed cache, or null unless the path is a regular file (never a symlink) holding a v1 cache.
	_loadCacheFile(file) {
		try {
			const stat = fs.lstatSync(file);
			if (!stat.isFile() || stat.size > MAX_CACHE_BYTES) return null;
			const data = JSON.parse(fs.readFileSync(file, "utf8"));
			return data && data.magic === CACHE_MAGIC && data.version === 1 ? data : null;
		} catch {
			return null;
		}
	},

	// Removes stale cache files of earlier configurations. Only regular files with our name pattern and a valid
	// v1 marker are ever candidates; files used by a live instance are kept; the newest CACHE_KEEP files are
	// kept, and anything older than CACHE_MAX_AGE_MS goes.
	_pruneCaches() {
		try {
			const dir = configDir(this.tokenDeps || {});
			const owned = new Set();
			for (const [file, id] of this.cachePaths) if (this.instances.has(id)) owned.add(file);
			const found = [];
			for (const name of fs.readdirSync(dir)) {
				if (!CACHE_NAME.test(name)) continue;
				const file = path.join(dir, name);
				const stat = fs.lstatSync(file);
				if (!stat.isFile() || !this._loadCacheFile(file)) continue;
				found.push({ file, mtime: stat.mtimeMs });
			}
			found.sort((a, b) => b.mtime - a.mtime);
			const now = this._now();
			found.forEach((entry, index) => {
				if (owned.has(entry.file)) return;
				if (index < CACHE_KEEP && now - entry.mtime <= CACHE_MAX_AGE_MS) return;
				try {
					fs.unlinkSync(entry.file);
				} catch {
					// already gone or not removable; try again after a later write
				}
			});
		} catch {
			// pruning is best effort
		}
	},

	_readCache(inst) {
		if (!inst.cacheEnabled) return;
		const data = this._loadCacheFile(inst.cachePath);
		if (!data || data.sig !== inst.sig || typeof data.fetchedAt !== "number" || !Array.isArray(data.students))
			return;
		inst.snapshot = {
			fetchedAt: data.fetchedAt,
			partial: data.partial === true,
			notFound: Number.isInteger(data.notFound) ? data.notFound : 0,
			multiStudent: data.multiStudent === true,
			students: data.students
		};
		log.info("loaded cached snapshot");
	},

	_writeCache(inst) {
		if (!inst.cacheEnabled || !inst.snapshot) return;
		const target = inst.cachePath;
		const tmp = `${target}.tmp`;
		const disable = (reason) => {
			inst.cacheEnabled = false;
			log.warn(`cache file not written (${reason}); cache disabled`);
		};
		try {
			// never replace something that is not one of our own cache files
			let exists = true;
			try {
				fs.lstatSync(target);
			} catch (err) {
				if (err && err.code === "ENOENT") exists = false;
				else throw err;
			}
			if (exists && !this._loadCacheFile(target)) return disable("existing file is not a cache file");
			try {
				fs.unlinkSync(tmp);
			} catch (err) {
				if (!err || err.code !== "ENOENT") throw err;
			}
			const body = JSON.stringify({
				magic: CACHE_MAGIC,
				version: 1,
				sig: inst.sig,
				fetchedAt: inst.snapshot.fetchedAt,
				partial: inst.snapshot.partial,
				notFound: inst.snapshot.notFound,
				multiStudent: inst.snapshot.multiStudent,
				students: inst.snapshot.students
			});
			fs.writeFileSync(tmp, body, { mode: 0o600, flag: "wx" });
			fs.renameSync(tmp, target);
			this._pruneCaches();
		} catch (err) {
			disable(err && err.code ? err.code : "error");
		}
	}
});
