/* MMM-CanvasGrades
 *
 * Shows a Canvas observer's students: course grades, missing assignments (flagged first),
 * and optionally recently graded work. This file never talks to Canvas and never uses the
 * access token: it only exchanges socket notifications with node_helper
 * (CANVASGRADES_REGISTER out, CANVASGRADES_STATE in) and renders the display-ready view
 * model the helper sends.
 */

var CANVASGRADES_TRANSIENT = ["network", "timeout", "server", "throttled"];
var CANVASGRADES_ERROR_KINDS = [
	"config",
	"token_file",
	"auth",
	"forbidden",
	"no_students",
	"network",
	"timeout",
	"server",
	"throttled"
];
var CANVASGRADES_ERROR_TEXT = {
	config: "Canvas URL or token not set",
	token_file: "Canvas token file could not be read",
	auth: "Canvas token rejected - generate a new one",
	no_students: "No linked students found for this account",
	forbidden: "Canvas denied access for this account",
	network: "Cannot reach Canvas",
	timeout: "Cannot reach Canvas",
	server: "Cannot reach Canvas",
	throttled: "Canvas rate limit - retrying"
};
var CANVASGRADES_STALE_SUFFIX = {
	network: " - Canvas unreachable",
	timeout: " - Canvas unreachable",
	server: " - Canvas unreachable",
	throttled: " - rate limited",
	auth: " - token rejected"
};
var CANVASGRADES_GRADE_KINDS = ["letter", "percent", "both", "none"];
var CANVASGRADES_DEFAULT_STALE_MS = 2 * 1800000 + 300000;

Module.register("MMM-CanvasGrades", {
	defaults: {
		// --- Canvas connection (read by node_helper only) ---
		canvasUrl: "",
		accessToken: "",
		accessTokenFile: "",

		// --- Students ---
		students: [],
		studentLabels: {},
		nameDisplay: "short",
		// "auto" (only with more than one student), true, false
		showStudentName: "auto",

		// --- Courses ---
		courses: [],
		excludeCourses: [],
		courseLabels: {},
		maxCourseNameLength: 24,
		gradeDisplay: "auto",
		scoreType: "current",
		gradingPeriod: "current",
		showCourseGrades: true,

		// --- Missing work ---
		showMissing: true,
		maxMissing: 8,
		missingLookbackDays: 30,
		inferMissing: true,

		// --- Recent grades ---
		showRecentGrades: 0,
		recentGradesDays: 7,
		assignmentScoreDisplay: "auto",

		// --- Display ---
		// "full" (wide regions) or "compact" (side columns)
		layout: "full",
		// 12 or 24
		timeFormat: 12,
		// Browser locale when empty
		locale: "",
		animationSpeed: 1000,
		// A transient outage with no data is shown as "loading" for this many seconds first
		errorGraceSeconds: 120,

		// --- Update behaviour (read by node_helper only) ---
		updateInterval: 1800000,
		requestTimeout: 20000,
		staleAfter: 0,
		pauseBetween: null,
		cache: false
	},

	MAX_TEXT: 160,
	MAX_STUDENTS: 10,
	MAX_COURSES: 40,
	MAX_MISSING: 50,
	MAX_RECENT: 20,
	TICK_MS: 60000,

	getStyles() {
		// MagicMirror's vendored Font Awesome for the icons
		return ["font-awesome.css", "MMM-CanvasGrades.css"];
	},

	start() {
		this.view = null;
		this.firstErrorSeenAt = 0;
		this.tickTimer = null;
		this.suspended = false;
		this.lastRenderKey = "";

		this.sendSocketNotification("CANVASGRADES_REGISTER", {
			instanceId: this.identifier,
			config: this.config
		});
		this._startTick();
	},

	suspend() {
		this.suspended = true;
		this._stopTick();
	},

	resume() {
		this.suspended = false;
		this._startTick();
		this.updateDom(0);
	},

	notificationReceived(notification, payload, sender) {
		if (notification !== "MODULE_DOM_CREATED" && notification !== "MODULE_DOM_UPDATED") return;
		// MM sends these only to the module they concern; ignore anything from another module.
		if (sender) return;
		// MM can drop the resume() callback when a render lands inside the show fade; the module
		// is visibly on screen, so stop treating it as suspended.
		if (this.suspended && this.hidden === false) {
			this.suspended = false;
			this._startTick();
		}
	},

	socketNotificationReceived(notification, payload) {
		if (notification !== "CANVASGRADES_STATE") return;
		if (!payload || typeof payload !== "object") return;
		if (payload.instanceId !== this.identifier) return;

		var view = this._cleanView(payload);
		this.view = view;

		var transient =
			view.status === "error" &&
			!!view.error &&
			!view.error.terminal &&
			CANVASGRADES_TRANSIENT.indexOf(view.error.kind) !== -1;
		if (!transient) {
			this.firstErrorSeenAt = 0;
		} else if (!this.firstErrorSeenAt) {
			this.firstErrorSeenAt = this._now();
		}

		this.updateDom(this._animationSpeed());
	},

	_now() {
		return Date.now();
	},

	// ---- Timers ----

	// MM drops resume() callbacks in some show-fade races, so "suspended" only counts while
	// MM also reports the module hidden.
	_isSuspended() {
		return this.suspended && this.hidden !== false;
	},

	_startTick() {
		this._stopTick();
		if (this._isSuspended()) return;
		var self = this;
		this.tickTimer = setInterval(function () {
			self._tick();
		}, this.TICK_MS);
	},

	_stopTick() {
		if (this.tickTimer) {
			clearInterval(this.tickTimer);
			this.tickTimer = null;
		}
	},

	// Re-renders only when something visible would change (relative times, stale, grace expiry).
	_tick() {
		var key;
		try {
			key = this._renderKey(this._now());
		} catch {
			return;
		}
		if (key !== this.lastRenderKey) this.updateDom(0);
	},

	// ---- Config guards (front-end options only) ----

	_layout() {
		return this.config.layout === "compact" ? "compact" : "full";
	},

	_showStudentName() {
		var v = this.config.showStudentName;
		return v === true || v === false ? v : "auto";
	},

	_timeFormat() {
		return Number(this.config.timeFormat) === 24 ? 24 : 12;
	},

	_locale() {
		return typeof this.config.locale === "string" && this.config.locale ? this.config.locale : undefined;
	},

	_graceMs() {
		var n = Number(this.config.errorGraceSeconds);
		return (isFinite(n) && n >= 0 ? n : 120) * 1000;
	},

	_animationSpeed() {
		var n = Number(this.config.animationSpeed);
		return isFinite(n) && n >= 0 ? n : 1000;
	},

	// ---- Payload cleaning (everything here came over the socket: treat as untrusted) ----

	_text(value, max) {
		if (typeof value !== "string" && !(typeof value === "number" && isFinite(value))) return "";
		var s = String(value).replace(/\s+/g, " ").trim();
		var cap = max || this.MAX_TEXT;
		if (s.length > cap) {
			var chars = Array.from(s);
			if (chars.length > cap) s = chars.slice(0, cap).join("");
		}
		return s;
	},

	_count(value) {
		var n = typeof value === "number" ? value : NaN;
		if (!isFinite(n) || n < 0) return 0;
		return Math.min(Math.floor(n), 9999);
	},

	_list(value, max) {
		if (!Array.isArray(value)) return [];
		return value.length > max ? value.slice(0, max) : value;
	},

	_cleanError(error) {
		if (!error || typeof error !== "object") return null;
		var kind = CANVASGRADES_ERROR_KINDS.indexOf(error.kind) !== -1 ? error.kind : "network";
		var terminal = error.terminal === true || kind === "config" || kind === "token_file" || kind === "auth";
		return { kind: kind, terminal: terminal };
	},

	_cleanView(payload) {
		var status = payload.status === "ok" || payload.status === "error" ? payload.status : "loading";
		var fetchedAt = typeof payload.fetchedAt === "number" && isFinite(payload.fetchedAt) ? payload.fetchedAt : null;
		var staleAfterMs =
			typeof payload.staleAfterMs === "number" && isFinite(payload.staleAfterMs) && payload.staleAfterMs > 0
				? payload.staleAfterMs
				: CANVASGRADES_DEFAULT_STALE_MS;
		var students = [];
		var list = this._list(payload.students, this.MAX_STUDENTS);
		for (var i = 0; i < list.length; i++) {
			var s = this._cleanStudent(list[i]);
			if (s) students.push(s);
		}
		return {
			status: status,
			error: this._cleanError(payload.error),
			fetchedAt: fetchedAt,
			staleAfterMs: staleAfterMs,
			partial: payload.partial === true,
			paused: payload.paused === true,
			studentsNotFound: this._count(payload.studentsNotFound),
			multiStudent: payload.multiStudent === true || students.length > 1,
			students: students
		};
	},

	_cleanStudent(s) {
		if (!s || typeof s !== "object") return null;
		var courses = [];
		var cl = this._list(s.courses, this.MAX_COURSES);
		for (var i = 0; i < cl.length; i++) {
			var c = cl[i];
			if (!c || typeof c !== "object") continue;
			var kind = CANVASGRADES_GRADE_KINDS.indexOf(c.gradeKind) !== -1 ? c.gradeKind : "none";
			courses.push({
				name: this._text(c.name),
				gradeText: this._text(c.gradeText) || "--",
				gradeKind: kind,
				hidden: c.hidden === true,
				periodFallback: c.periodFallback === true,
				missingCount: this._count(c.missingCount),
				failed: c.failed === true
			});
		}
		var missing = [];
		var ml = this._list(s.missing, this.MAX_MISSING);
		for (var j = 0; j < ml.length; j++) {
			var m = ml[j];
			if (!m || typeof m !== "object") continue;
			missing.push({
				name: this._text(m.name),
				course: this._text(m.course),
				dueAt: typeof m.dueAt === "string" ? m.dueAt : null,
				pointsText: this._text(m.pointsText),
				inferred: m.inferred === true
			});
		}
		var recent = [];
		var rl = this._list(s.recent, this.MAX_RECENT);
		for (var k = 0; k < rl.length; k++) {
			var r = rl[k];
			if (!r || typeof r !== "object") continue;
			recent.push({
				name: this._text(r.name),
				course: this._text(r.course),
				scoreText: this._text(r.scoreText) || "--",
				late: r.late === true,
				excused: r.excused === true,
				hidden: r.hidden === true
			});
		}
		var missingTotal = this._count(s.missingTotal);
		if (missingTotal < missing.length) missingTotal = missing.length;
		return {
			label: this._text(s.label, 80),
			notice: s.notice === "no_courses" ? "no_courses" : null,
			courses: courses,
			missing: missing,
			missingTotal: missingTotal,
			recent: recent
		};
	},

	// ---- Display state ----

	// Returns { name: "loading" | "error" | "ok", errorKind, stale, footer }.
	_displayState(now) {
		var v = this.view;
		if (!v || v.status === "loading") return { name: "loading", errorKind: "", stale: false, footer: "" };

		if (v.status === "error") {
			var kind = v.error ? v.error.kind : "network";
			var transient = CANVASGRADES_TRANSIENT.indexOf(kind) !== -1 && !(v.error && v.error.terminal);
			if (transient && this.firstErrorSeenAt && now - this.firstErrorSeenAt < this._graceMs()) {
				return { name: "loading", errorKind: "", stale: false, footer: "" };
			}
			return { name: "error", errorKind: kind, stale: false, footer: "" };
		}

		var age = v.fetchedAt === null ? 0 : now - v.fetchedAt;
		// A negative age means the clock is behind the helper's (no NTP yet): treat as fresh.
		var stale = !v.paused && (age > v.staleAfterMs || !!v.error);
		var parts = [];
		if (stale) {
			var suffix =
				v.error && CANVASGRADES_STALE_SUFFIX[v.error.kind] ? CANVASGRADES_STALE_SUFFIX[v.error.kind] : "";
			parts.push("Updated " + this._relativeAge(age) + suffix);
		}
		if (v.partial) parts.push("Some courses could not be loaded");
		return { name: "ok", errorKind: "", stale: stale, footer: parts.join(" - ") };
	},

	_relativeAge(ms) {
		if (!isFinite(ms) || ms < 60000) return "just now";
		var min = Math.floor(ms / 60000);
		if (min < 60) return min + " min ago";
		var h = Math.floor(min / 60);
		if (h < 24) return h + " h ago";
		return Math.floor(h / 24) + " d ago";
	},

	// Everything that can change on a minute tick without a new payload.
	_renderKey(now) {
		var st = this._displayState(now);
		var due = [];
		if (st.name === "ok" && this._layout() === "full") {
			for (var i = 0; i < this.view.students.length; i++) {
				var list = this.view.students[i].missing;
				for (var j = 0; j < list.length; j++) due.push(this._dueText(list[j].dueAt, now));
			}
		}
		return [st.name, st.errorKind, st.stale ? "1" : "0", st.footer, due.join("|")].join("#");
	},

	_startOfDay(d) {
		return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
	},

	_formatTime(d) {
		var s;
		try {
			s = d.toLocaleTimeString(this._locale(), {
				hour: "numeric",
				minute: "2-digit",
				hour12: this._timeFormat() === 12
			});
		} catch {
			s = d.toLocaleTimeString();
		}
		return s.replace(/\s+/g, " ");
	},

	_formatDay(d, options) {
		try {
			return d.toLocaleDateString(this._locale(), options);
		} catch {
			return d.toDateString();
		}
	},

	_dueText(iso, now) {
		if (typeof iso !== "string" || !iso) return "";
		var ms = Date.parse(iso);
		if (isNaN(ms)) return "";
		var due = new Date(ms);
		var today = new Date(now === undefined ? this._now() : now);
		var days = Math.round((this._startOfDay(due) - this._startOfDay(today)) / 86400000);
		if (days === 0) return ms > today.getTime() ? "due " + this._formatTime(due) : "due today";
		if (days === 1) return "due tomorrow";
		if (days >= 2 && days <= 6) return "due " + this._formatDay(due, { weekday: "short" });
		if (days > 6) return "due " + this._formatDay(due, { month: "short", day: "numeric" });
		if (days === -1) return "yesterday";
		if (days >= -13) return -days + " days ago";
		return this._formatDay(due, { month: "short", day: "numeric" });
	},

	// ---- DOM ----

	_el(tag, className, text) {
		var el = document.createElement(tag);
		if (className) el.className = className;
		if (text !== undefined && text !== "") el.textContent = text;
		return el;
	},

	_icon(classes) {
		var i = this._el("i", classes);
		i.setAttribute("aria-hidden", "true");
		return i;
	},

	getDom() {
		try {
			var now = this._now();
			var st = this._displayState(now);
			this.lastRenderKey = this._renderKey(now);
			var layout = this._layout();
			var root = this._el(
				"div",
				"cg-root cg-layout-" + layout + " cg-state-" + st.name + (st.stale ? " cg-stale" : "")
			);

			if (st.name === "loading") {
				root.appendChild(this._el("div", "cg-status", "Loading grades..."));
				return root;
			}
			if (st.name === "error") {
				var text = CANVASGRADES_ERROR_TEXT[st.errorKind] || CANVASGRADES_ERROR_TEXT.network;
				root.appendChild(this._el("div", "cg-status cg-status-error", text));
				return root;
			}

			var notFound = this.view.studentsNotFound;
			if (notFound > 0) {
				root.appendChild(
					this._el(
						"div",
						"cg-notice",
						notFound + " configured " + (notFound === 1 ? "student" : "students") + " not found"
					)
				);
			}
			var students = this.view.students;
			for (var i = 0; i < students.length; i++) {
				root.appendChild(this._studentDom(students[i], layout));
			}
			if (st.footer) {
				var cls =
					"cg-footer" +
					(st.stale ? " cg-footer-stale" : "") +
					(this.view.partial ? " cg-footer-partial" : "");
				root.appendChild(this._el("div", cls, st.footer));
			}
			return root;
		} catch {
			return this._el("div", "cg-root cg-empty");
		}
	},

	_studentDom(s, layout) {
		var box = this._el("div", "cg-student");
		var mode = this._showStudentName();
		var showName = mode === "auto" ? this.view.multiStudent : mode;
		if (showName && s.label) box.appendChild(this._el("div", "cg-student-name", s.label));
		if (s.notice === "no_courses") box.appendChild(this._el("div", "cg-notice", "No active courses"));

		var wantMissing = this.config.showMissing !== false;
		var noneMissing = wantMissing && s.missing.length === 0 && s.missingTotal === 0 && !this._anyCourseMissing(s);
		// Compact normally shows missing work only as badges; with no course rows to carry them,
		// fall back to the list so missing work is never silently hidden.
		var listMissing = s.missing.length > 0 && (layout === "full" || s.courses.length === 0);

		if (listMissing) box.appendChild(this._missingDom(s));
		if (noneMissing && s.notice !== "no_courses") {
			var clear = this._el("div", "cg-clear");
			clear.appendChild(this._icon("cg-clear-icon fa-solid fa-circle-check"));
			clear.appendChild(this._el("span", "cg-clear-text", "Nothing missing"));
			box.appendChild(clear);
		}
		if (s.courses.length > 0) box.appendChild(this._coursesDom(s));
		if (layout === "full" && s.recent.length > 0) box.appendChild(this._recentDom(s));
		return box;
	},

	_anyCourseMissing(s) {
		for (var i = 0; i < s.courses.length; i++) {
			if (s.courses[i].missingCount > 0) return true;
		}
		return false;
	},

	_missingDom(s) {
		var now = this._now();
		var box = this._el("div", "cg-missing");
		for (var i = 0; i < s.missing.length; i++) {
			var m = s.missing[i];
			var item = this._el("div", "cg-missing-item" + (m.inferred ? " cg-missing-inferred" : ""));
			item.appendChild(this._icon("cg-missing-icon fa-solid fa-circle-exclamation"));
			item.appendChild(this._el("span", "cg-missing-name", m.name));
			item.appendChild(this._el("span", "cg-missing-course", m.course));
			var due = this._dueText(m.dueAt, now);
			if (due) item.appendChild(this._el("span", "cg-missing-due", due));
			if (m.pointsText) item.appendChild(this._el("span", "cg-missing-points", m.pointsText));
			box.appendChild(item);
		}
		var extra = s.missingTotal - s.missing.length;
		if (extra > 0) box.appendChild(this._el("div", "cg-more", "+" + extra + " more"));
		return box;
	},

	_coursesDom(s) {
		var box = this._el("div", "cg-courses");
		for (var i = 0; i < s.courses.length; i++) {
			var c = s.courses[i];
			var cls =
				"cg-course" +
				(c.hidden ? " cg-course-hidden" : "") +
				(c.failed ? " cg-course-failed" : "") +
				(c.missingCount > 0 ? " cg-course-has-missing" : "");
			var row = this._el("div", cls);
			row.appendChild(this._el("span", "cg-course-name", c.name));
			row.appendChild(this._el("span", "cg-course-grade cg-grade-" + c.gradeKind, c.gradeText));
			if (c.periodFallback) row.appendChild(this._el("span", "cg-period-note", "total"));
			if (c.missingCount > 0) {
				var badge = this._el("span", "cg-badge");
				badge.setAttribute("aria-label", c.missingCount + " missing");
				badge.appendChild(this._icon("cg-badge-icon fa-solid fa-circle-exclamation"));
				badge.appendChild(this._el("span", "cg-badge-count", String(c.missingCount)));
				row.appendChild(badge);
			}
			box.appendChild(row);
		}
		return box;
	},

	_recentDom(s) {
		var box = this._el("div", "cg-recent");
		for (var i = 0; i < s.recent.length; i++) {
			var r = s.recent[i];
			var item = this._el("div", "cg-recent-item");
			item.appendChild(this._el("span", "cg-recent-name", r.name));
			item.appendChild(this._el("span", "cg-recent-course", r.course));
			item.appendChild(this._el("span", "cg-recent-score", r.scoreText));
			if (r.late) {
				var late = this._el("span", "cg-marker cg-marker-late");
				late.appendChild(this._icon("fa-solid fa-clock"));
				late.appendChild(this._el("span", "", "late"));
				item.appendChild(late);
			}
			if (r.excused && r.scoreText !== "EX")
				item.appendChild(this._el("span", "cg-marker cg-marker-excused", "EX"));
			if (r.hidden) {
				var hid = this._el("span", "cg-marker cg-marker-hidden");
				hid.setAttribute("aria-label", "grade hidden");
				hid.appendChild(this._icon("fa-solid fa-eye-slash"));
				item.appendChild(hid);
			}
			box.appendChild(item);
		}
		return box;
	}
});
