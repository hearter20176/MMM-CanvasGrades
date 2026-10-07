"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
require("./support/mm-stubs");
const {
	DEFAULTS,
	normalizeConfig,
	resolveToken,
	inQuietHours,
	msUntilQuietEnd,
	instanceSignature
} = require("../lib/config");

const base = { canvasUrl: "https://canvas.example.edu", accessToken: "test-token-DO-NOT-USE-0000" };

describe("normalizeConfig", () => {
	it("round-trips defaults without warnings", () => {
		const { cfg, warnings } = normalizeConfig({ ...base });
		assert.deepEqual(warnings, []);
		for (const key of Object.keys(DEFAULTS)) {
			if (["canvasUrl", "accessToken", "staleAfter", "subjectIcons", "subjectColors"].includes(key)) continue;
			assert.deepEqual(cfg[key], DEFAULTS[key], key);
		}
		assert.equal(cfg.staleAfter, 2 * 1800000 + 300000);
	});

	it("falls back with exactly one warning naming the option for each invalid enum", () => {
		for (const option of ["nameDisplay", "gradeDisplay", "scoreType", "gradingPeriod", "assignmentScoreDisplay"]) {
			const { cfg, warnings } = normalizeConfig({ ...base, [option]: "bogus" });
			assert.equal(cfg[option], DEFAULTS[option]);
			assert.equal(warnings.length, 1, option);
			assert.match(warnings[0], new RegExp(option));
			assert.ok(!warnings[0].includes("bogus"));
		}
	});

	it("clamps and coerces numbers", () => {
		assert.equal(normalizeConfig({ ...base, updateInterval: 1000 }).cfg.updateInterval, 300000);
		assert.equal(normalizeConfig({ ...base, updateInterval: 9e12 }).cfg.updateInterval, 86400000);
		assert.equal(normalizeConfig({ ...base, maxMissing: 0 }).cfg.maxMissing, 1);
		assert.equal(normalizeConfig({ ...base, maxMissing: 99 }).cfg.maxMissing, 30);
		assert.equal(normalizeConfig({ ...base, missingLookbackDays: -1 }).cfg.missingLookbackDays, 0);
		assert.equal(normalizeConfig({ ...base, maxCourseNameLength: "30" }).cfg.maxCourseNameLength, 30);
		assert.equal(normalizeConfig({ ...base, requestTimeout: 1 }).cfg.requestTimeout, 5000);
		assert.equal(normalizeConfig({ ...base, requestTimeout: 60000 }).cfg.requestTimeout, 30000);
		assert.equal(normalizeConfig({ ...base, showRecentGrades: 50 }).cfg.showRecentGrades, 10);
		const bad = normalizeConfig({ ...base, maxMissing: "lots" });
		assert.equal(bad.cfg.maxMissing, 8);
		assert.equal(bad.warnings.length, 1);
	});

	it("resolves staleAfter", () => {
		assert.equal(normalizeConfig({ ...base, updateInterval: 600000 }).cfg.staleAfter, 1500000);
		assert.equal(normalizeConfig({ ...base, updateInterval: 600000, staleAfter: 1000 }).cfg.staleAfter, 600000);
		assert.equal(normalizeConfig({ ...base, updateInterval: 600000, staleAfter: 7200000 }).cfg.staleAfter, 7200000);
	});

	it("coerces booleans and warns on junk", () => {
		assert.equal(normalizeConfig({ ...base, showMissing: "false" }).cfg.showMissing, false);
		const junk = normalizeConfig({ ...base, inferMissing: "maybe" });
		assert.equal(junk.cfg.inferMissing, true);
		assert.equal(junk.warnings.length, 1);
	});

	it("normalises canvasUrl", () => {
		const url = (value) => normalizeConfig({ canvasUrl: value }).cfg.canvasUrl;
		assert.equal(url("https://canvas.example.edu/"), "https://canvas.example.edu");
		assert.equal(url("https://canvas.example.edu/api/v1"), "https://canvas.example.edu");
		assert.equal(url("https://canvas.example.edu/api/v1/"), "https://canvas.example.edu");
		assert.equal(url("https://canvas.example.edu/lms/?x=1#y"), "https://canvas.example.edu/lms");
		assert.equal(url("http://canvas.example.edu"), "");
		assert.equal(url("not a url"), "");
		assert.equal(url(""), "");
		assert.equal(url(42), "");
		assert.equal(url("https://user:pw@canvas.example.edu"), "");
	});

	it("never puts canvasUrl or token values in warnings", () => {
		const { warnings } = normalizeConfig({ canvasUrl: "nope-host", accessToken: "tok en", gradeDisplay: "x" });
		for (const warning of warnings) {
			assert.ok(!warning.includes("nope-host"));
			assert.ok(!warning.includes("tok en"));
		}
	});

	it("coerces ids to strings and dedups", () => {
		const { cfg } = normalizeConfig({
			...base,
			students: [2001, "2001", " 2002 ", "", null],
			courses: [1001, 1002, 1001],
			excludeCourses: 1005
		});
		assert.deepEqual(cfg.students, ["2001", "2002"]);
		assert.deepEqual(cfg.courses, ["1001", "1002"]);
		assert.deepEqual(cfg.excludeCourses, ["1005"]);
	});

	it("cleans label maps", () => {
		const { cfg } = normalizeConfig({
			...base,
			studentLabels: { 2001: "  A.  ", 2002: "" },
			courseLabels: { 1001: "Math &amp; Co" }
		});
		assert.deepEqual(cfg.studentLabels, { 2001: "A." });
		assert.deepEqual(cfg.courseLabels, { 1001: "Math & Co" });
	});

	it("validates pauseBetween", () => {
		assert.deepEqual(normalizeConfig({ ...base, pauseBetween: ["22:00", "06:00"] }).cfg.pauseBetween, [
			"22:00",
			"06:00"
		]);
		assert.deepEqual(normalizeConfig({ ...base, pauseBetween: ["01:00", "05:30"] }).cfg.pauseBetween, [
			"01:00",
			"05:30"
		]);
		for (const bad of [["22:00", "22:00"], ["25:00", "06:00"], ["22:00"], "22:00-06:00", ["22:0", "06:00"]]) {
			const result = normalizeConfig({ ...base, pauseBetween: bad });
			assert.equal(result.cfg.pauseBetween, null);
			assert.equal(result.warnings.length, 1);
		}
		assert.equal(normalizeConfig({ ...base, pauseBetween: null }).warnings.length, 0);
	});

	it("validates locale", () => {
		assert.equal(normalizeConfig({ ...base, locale: "de-DE" }).cfg.locale, "de-DE");
		const bad = normalizeConfig({ ...base, locale: "not_a_locale!!" });
		assert.equal(bad.cfg.locale, "");
		assert.equal(bad.warnings.length, 1);
	});
});

describe("resolveToken", () => {
	let dir;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-token-"));
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});
	const cfgWith = (extra) => normalizeConfig({ canvasUrl: "https://canvas.example.edu", ...extra }).cfg;

	it("prefers inline over file over env", () => {
		const file = path.join(dir, "canvas-token");
		fs.writeFileSync(file, "file-token-0000\n");
		const env = { CANVAS_ACCESS_TOKEN: "env-token-0000" };
		assert.equal(
			resolveToken(cfgWith({ accessToken: "inline-0000", accessTokenFile: file }), {
				env,
				configDir: os.tmpdir()
			}).token,
			"inline-0000"
		);
		const fromFile = resolveToken(cfgWith({ accessTokenFile: file }), { env, configDir: os.tmpdir() });
		assert.equal(fromFile.token, "file-token-0000");
		assert.equal(fromFile.source, "file");
		assert.equal(resolveToken(cfgWith({}), { env, configDir: os.tmpdir() }).token, "env-token-0000");
		assert.equal(resolveToken(cfgWith({}), { env: {}, configDir: os.tmpdir() }).ok, false);
	});

	it("trims file content", () => {
		const file = path.join(dir, "canvas-token");
		fs.writeFileSync(file, "  abc123  \r\n");
		assert.equal(
			resolveToken(cfgWith({ accessTokenFile: file }), { env: {}, configDir: os.tmpdir() }).token,
			"abc123"
		);
	});

	it("does not fall through to env for an empty or unreadable file", () => {
		const env = { CANVAS_ACCESS_TOKEN: "env-token-0000" };
		const empty = path.join(dir, "canvas-token-empty");
		fs.writeFileSync(empty, "  \n");
		const emptyResult = resolveToken(cfgWith({ accessTokenFile: empty }), { env, configDir: os.tmpdir() });
		assert.equal(emptyResult.ok, false);
		assert.equal(emptyResult.error.kind, "token_file");
		assert.equal(emptyResult.error.code, "EMPTY");
		const missing = resolveToken(cfgWith({ accessTokenFile: path.join(dir, "canvas-token-missing") }), {
			env,
			configDir: os.tmpdir()
		});
		assert.equal(missing.ok, false);
		assert.equal(missing.error.kind, "token_file");
		assert.equal(missing.error.code, "ENOENT");
		assert.equal(missing.error.file, "canvas-token-missing");
		assert.ok(!JSON.stringify(missing.error).includes(dir));
	});

	it("refuses a token file outside the MagicMirror config folder", () => {
		const config = path.join(dir, "config");
		fs.mkdirSync(config);
		fs.writeFileSync(path.join(config, "canvas-token"), "inside-0000");
		fs.writeFileSync(path.join(dir, "elsewhere-token"), "outside-0000");
		const deps = { env: {}, configDir: config };
		assert.equal(
			resolveToken(cfgWith({ accessTokenFile: path.join(config, "canvas-token") }), deps).token,
			"inside-0000"
		);
		for (const file of [path.join(dir, "elsewhere-token"), path.join(config, "..", "elsewhere-token"), config]) {
			const result = resolveToken(cfgWith({ accessTokenFile: file }), deps);
			assert.equal(result.ok, false, file);
			assert.equal(result.error.kind, "token_file");
			assert.equal(result.error.code, "OUTSIDE_CONFIG");
			assert.ok(!JSON.stringify(result).includes("outside-0000"));
		}
	});

	it("only accepts files named canvas-token*, whatever they contain", () => {
		const config = path.join(dir, "config");
		fs.mkdirSync(config);
		const deps = { env: {}, configDir: config };
		for (const name of ["canvas-token", "canvas-token-2", "Canvas-Token.txt"]) {
			fs.writeFileSync(path.join(config, name), "ok-token-0000");
			assert.equal(
				resolveToken(cfgWith({ accessTokenFile: path.join(config, name) }), deps).token,
				"ok-token-0000",
				name
			);
		}
		for (const name of [
			"homeassistant-token",
			"birdfy-ha-token",
			"config.js",
			"my-canvas-token",
			"token",
			".env"
		]) {
			fs.writeFileSync(path.join(config, name), "OTHER-SERVICE-SECRET-xyz789");
			const result = resolveToken(cfgWith({ accessTokenFile: path.join(config, name) }), deps);
			assert.equal(result.ok, false, name);
			assert.equal(result.error.kind, "token_file");
			assert.equal(result.error.code, "BAD_NAME");
			assert.ok(!JSON.stringify(result).includes("xyz789"), "content is never returned");
		}
	});

	it("resolves relative paths against global.root_path", () => {
		fs.mkdirSync(path.join(dir, "config"));
		fs.writeFileSync(path.join(dir, "config", "canvas-token"), "rooted-0000");
		const previous = global.root_path;
		global.root_path = dir;
		try {
			assert.equal(
				resolveToken(cfgWith({ accessTokenFile: "config/canvas-token" }), { env: {}, configDir: os.tmpdir() })
					.token,
				"rooted-0000"
			);
		} finally {
			global.root_path = previous;
		}
	});

	it("rejects tokens that cannot be an HTTP header value", () => {
		assert.equal(
			resolveToken(cfgWith({ accessToken: "has space" }), { env: {}, configDir: os.tmpdir() }).ok,
			false
		);
		const file = path.join(dir, "canvas-token-multi");
		fs.writeFileSync(file, "line1\nline2");
		assert.equal(
			resolveToken(cfgWith({ accessTokenFile: file }), { env: {}, configDir: os.tmpdir() }).error.code,
			"INVALID"
		);
	});

	it("flags a loose token file mode using an injected fs", () => {
		const fake = (mode) => ({ readFileSync: () => "loose-0000\n", statSync: () => ({ mode }) });
		const cfg = cfgWith({ accessTokenFile: "/etc/canvas-token" });
		assert.equal(
			resolveToken(cfg, { env: {}, configDir: "/etc", fs: fake(0o100644), platform: "linux" }).loose,
			true
		);
		assert.equal(
			resolveToken(cfg, { env: {}, configDir: "/etc", fs: fake(0o100600), platform: "linux" }).loose,
			false
		);
		assert.equal(
			resolveToken(cfg, { env: {}, configDir: "/etc", fs: fake(0o100644), platform: "win32" }).loose,
			false
		);
	});

	it("flags a token file readable by others (POSIX only)", { skip: process.platform === "win32" }, () => {
		const file = path.join(dir, "canvas-token-loose");
		fs.writeFileSync(file, "loose-0000", { mode: 0o644 });
		fs.chmodSync(file, 0o644);
		assert.equal(resolveToken(cfgWith({ accessTokenFile: file }), { env: {}, configDir: os.tmpdir() }).loose, true);
		fs.chmodSync(file, 0o600);
		assert.equal(
			resolveToken(cfgWith({ accessTokenFile: file }), { env: {}, configDir: os.tmpdir() }).loose,
			false
		);
	});
});

describe("quiet hours", () => {
	const wrap = ["22:00", "06:00"];
	const same = ["01:00", "05:00"];
	const at = (h, m = 0, day = 6) => new Date(2026, 9, day, h, m, 0, 0);

	it("detects windows including ones wrapping midnight", () => {
		assert.equal(inQuietHours(wrap, at(23, 30)), true);
		assert.equal(inQuietHours(wrap, at(2, 0)), true);
		assert.equal(inQuietHours(wrap, at(6, 0)), false);
		assert.equal(inQuietHours(wrap, at(12, 0)), false);
		assert.equal(inQuietHours(wrap, at(22, 0)), true);
		assert.equal(inQuietHours(same, at(3, 0)), true);
		assert.equal(inQuietHours(same, at(5, 0)), false);
		assert.equal(inQuietHours(null, at(3, 0)), false);
	});

	it("computes time until the window ends across midnight", () => {
		assert.equal(msUntilQuietEnd(wrap, at(23, 0)), 7 * 3600 * 1000);
		assert.equal(msUntilQuietEnd(wrap, at(5, 0)), 3600 * 1000);
		assert.equal(msUntilQuietEnd(same, at(3, 30)), 90 * 60 * 1000);
	});
});

describe("instanceSignature", () => {
	const sig = (extra = {}, descriptor = "env") =>
		instanceSignature(normalizeConfig({ ...base, ...extra }).cfg, descriptor);

	it("is stable for the same config and ignores display-only options", () => {
		assert.equal(sig(), sig());
		assert.equal(sig({ layout: "compact", timeFormat: 24, animationSpeed: 5, errorGraceSeconds: 1 }), sig());
	});

	it("changes with each signature option", () => {
		const reference = sig();
		const variants = {
			canvasUrl: "https://other.example.edu",
			students: ["2001"],
			courses: ["1001"],
			excludeCourses: ["1005"],
			studentLabels: { 2001: "A" },
			courseLabels: { 1001: "Alg" },
			nameDisplay: "full",
			maxCourseNameLength: 30,
			gradeDisplay: "both",
			scoreType: "final",
			gradingPeriod: "all",
			showCourseGrades: false,
			showMissing: false,
			maxMissing: 3,
			missingLookbackDays: 10,
			inferMissing: false,
			showRecentGrades: 2,
			recentGradesDays: 3,
			assignmentScoreDisplay: "percent",
			updateInterval: 600000,
			requestTimeout: 9000,
			staleAfter: 9000000,
			pauseBetween: ["22:00", "06:00"],
			cache: true,
			locale: "de-DE"
		};
		for (const [option, value] of Object.entries(variants)) {
			assert.notEqual(sig({ [option]: value }), reference, option);
		}
		assert.notEqual(sig({}, "inline:abc"), reference);
	});

	it("does not change when the token file content changes but its path does not", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-sig-"));
		try {
			const file = path.join(dir, "canvas-token");
			fs.writeFileSync(file, "first-0000");
			const cfg = normalizeConfig({ ...base, accessToken: "", accessTokenFile: file }).cfg;
			const before = instanceSignature(cfg, resolveToken(cfg, { env: {}, configDir: os.tmpdir() }).descriptor);
			fs.writeFileSync(file, "second-0000");
			const after = instanceSignature(cfg, resolveToken(cfg, { env: {}, configDir: os.tmpdir() }).descriptor);
			assert.equal(before, after);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
