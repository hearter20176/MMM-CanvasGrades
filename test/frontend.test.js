"use strict";

// Front-end tests for MMM-CanvasGrades.js: fake DOM, fake interval timers, fake clock.
// Run with: node --test test/frontend.test.js (no dependencies).

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { FakeElement, textOf, textsOf, hasClass, install } = require("./support/fake-dom.js");

let definition = null;
global.Module = {
	register(name, def) {
		assert.equal(name, "MMM-CanvasGrades");
		definition = def;
	}
};
const warnings = [];
global.Log = { info() {}, warn: (m) => warnings.push(m), error: (m) => warnings.push(m) };
install(global);

const MODULE_FILE = path.join(__dirname, "..", "MMM-CanvasGrades.js");
require(MODULE_FILE);
const spec = definition;

// ---- Fake intervals ----
const realSetInterval = global.setInterval;
const realClearInterval = global.clearInterval;
let intervals = [];
beforeEach(() => {
	intervals = [];
	global.setInterval = (fn, ms) => {
		const t = { fn, ms };
		intervals.push(t);
		return t;
	};
	global.clearInterval = (t) => {
		intervals = intervals.filter((x) => x !== t);
	};
});
afterEach(() => {
	global.setInterval = realSetInterval;
	global.clearInterval = realClearInterval;
});

// ---- Clock: local noon on a Tuesday ----
const MIN = 60000;
const HOUR = 3600000;
const NOW = new Date(2026, 9, 6, 12, 0, 0).getTime();
const local = (y, mo, d, h = 12, mi = 0) => new Date(y, mo, d, h, mi, 0).toISOString();

function payload(name, over = {}) {
	const p = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "payloads", name + ".json"), "utf8"));
	p.instanceId = "module_1_MMM-CanvasGrades";
	if (typeof p.fetchedAt === "number") p.fetchedAt = NOW - (Date.parse("2026-10-06T16:00:00Z") - p.fetchedAt);
	return Object.assign(p, over);
}

function make(config = {}, clock = { now: NOW }) {
	const m = Object.create(spec);
	m.identifier = "module_1_MMM-CanvasGrades";
	m.hidden = false;
	m.config = Object.assign({}, spec.defaults, { locale: "en-US" }, config);
	m.sent = [];
	m.domUpdates = [];
	m.clock = clock;
	m._now = () => clock.now;
	m.sendSocketNotification = (n, p) => m.sent.push([n, p]);
	m.updateDom = (speed) => m.domUpdates.push(speed);
	m.start();
	return m;
}

function feed(m, p) {
	m.socketNotificationReceived("CANVASGRADES_STATE", p);
	return m.getDom();
}

const has = (root, sel) => root.querySelector(sel) !== null;
const count = (root, sel) => root.querySelectorAll(sel).length;

// ---- Registration and filtering ----

test("start sends exactly one REGISTER with instanceId and config", () => {
	const m = make({ canvasUrl: "https://canvas.example.edu" });
	assert.equal(m.sent.length, 1);
	assert.equal(m.sent[0][0], "CANVASGRADES_REGISTER");
	assert.equal(m.sent[0][1].instanceId, "module_1_MMM-CanvasGrades");
	assert.equal(m.sent[0][1].config, m.config);
});

test("defaults cover the documented options and styles are declared", () => {
	for (const key of [
		"canvasUrl",
		"students",
		"layout",
		"showMissing",
		"maxMissing",
		"errorGraceSeconds",
		"pauseBetween",
		"cache",
		"timeFormat",
		"animationSpeed",
		"locale",
		"staleAfter"
	]) {
		assert.ok(key in spec.defaults, key);
	}
	assert.deepEqual(spec.getStyles(), ["font-awesome.css", "MMM-CanvasGrades.css"]);
	assert.equal(spec.defaults.layout, "full");
	assert.equal(spec.defaults.showRecentGrades, 0);
});

test("ignores other instances and other notification names", () => {
	const m = make();
	m.socketNotificationReceived(
		"CANVASGRADES_STATE",
		payload("ok-two-students", { instanceId: "module_9_MMM-CanvasGrades" })
	);
	m.socketNotificationReceived("SOMETHING_ELSE", payload("ok-two-students"));
	m.socketNotificationReceived("CANVASGRADES_STATE", null);
	assert.equal(m.view, null);
	assert.equal(m.domUpdates.length, 0);
	m.socketNotificationReceived("CANVASGRADES_STATE", payload("ok-two-students"));
	assert.equal(m.domUpdates.length, 1);
	assert.equal(m.domUpdates[0], 1000);
});

// ---- States ----

test("loading before any payload and for status loading", () => {
	const m = make();
	let root = m.getDom();
	assert.ok(hasClass(root, "cg-root") && hasClass(root, "cg-state-loading") && hasClass(root, "cg-layout-full"));
	assert.deepEqual(textsOf(root, ".cg-status"), ["Loading grades..."]);
	root = feed(m, payload("loading"));
	assert.ok(hasClass(root, "cg-state-loading"));
});

test("ok state: missing block comes before courses (full layout)", () => {
	const m = make();
	const root = feed(m, payload("ok-two-students"));
	assert.ok(hasClass(root, "cg-state-ok"));
	assert.ok(!hasClass(root, "cg-stale"));
	const [a, b] = root.querySelectorAll(".cg-student");
	const names = a.children.map((c) => c.className.split(" ")[0]);
	assert.ok(names.indexOf("cg-missing") !== -1);
	assert.ok(names.indexOf("cg-missing") < names.indexOf("cg-courses"));
	assert.ok(names.indexOf("cg-courses") < names.indexOf("cg-recent"));
	assert.equal(a.querySelectorAll(".cg-missing-item").length, 3);
	assert.equal(a.querySelectorAll(".cg-missing-item.cg-missing-inferred").length, 1);
	assert.equal(a.querySelectorAll(".cg-missing-icon").length, 3);
	assert.equal(a.querySelector(".cg-missing-icon").attributes["aria-hidden"], "true");
	assert.equal(a.querySelectorAll(".cg-course").length, 4);
	assert.deepEqual(textsOf(a, ".cg-course-grade"), ["A-", "B+ 87.2%", "--", "91.4%"]);
	assert.ok(a.querySelector(".cg-course-grade.cg-grade-both"));
	assert.ok(a.querySelector(".cg-course.cg-course-hidden"));
	assert.deepEqual(textsOf(a, ".cg-badge-count"), ["1", "2", "2"]);
	assert.equal(textOf(a.querySelector(".cg-period-note")), "total");
	assert.ok(!has(a, ".cg-clear"));
	assert.ok(has(b, ".cg-clear"));
	assert.ok(!has(root, ".cg-footer"));
});

test("missing items render name, course, due, points", () => {
	const m = make();
	const root = feed(m, payload("ok-two-students"));
	const first = root.querySelector(".cg-missing-item");
	assert.equal(textOf(first.querySelector(".cg-missing-name")), "Chapter 4 Quiz");
	assert.equal(textOf(first.querySelector(".cg-missing-course")), "Biology");
	assert.equal(textOf(first.querySelector(".cg-missing-points")), "20 pts");
	assert.match(textOf(first.querySelector(".cg-missing-due")), /^(\d+ days ago|yesterday|Sep \d+)/);
});

test("overflow shows +N more", () => {
	const m = make();
	const root = feed(m, payload("ok-two-students"));
	assert.deepEqual(textsOf(root, ".cg-more"), ["+2 more"]);
});

test("nothing-missing state shows the calm line in both layouts", () => {
	for (const layout of ["full", "compact"]) {
		const m = make({ layout });
		const root = feed(m, payload("nothing-missing"));
		assert.ok(hasClass(root, "cg-state-ok"));
		assert.equal(count(root, ".cg-clear"), 2);
		assert.deepEqual(textsOf(root, ".cg-clear-text"), ["Nothing missing", "Nothing missing"]);
		assert.ok(has(root, ".cg-clear-icon.fa-circle-check"));
		assert.ok(!has(root, ".cg-missing"));
	}
});

test("nothing-missing with no course rows (showCourseGrades false) renders only that line", () => {
	const m = make({ showCourseGrades: false });
	const p = payload("single-student");
	p.students[0].courses = [];
	p.students[0].missing = [];
	p.students[0].missingTotal = 0;
	p.students[0].recent = [];
	const root = feed(m, p);
	const student = root.querySelector(".cg-student");
	assert.equal(student.children.length, 1);
	assert.ok(hasClass(student.children[0], "cg-clear"));
});

test("showMissing false never claims nothing is missing", () => {
	const m = make({ showMissing: false });
	const p = payload("single-student");
	p.students[0].missing = [];
	p.students[0].missingTotal = 0;
	p.students[0].courses.forEach((c) => (c.missingCount = 0));
	const root = feed(m, p);
	assert.ok(!has(root, ".cg-clear"));
	assert.ok(!has(root, ".cg-missing"));
});

test("no-courses notice", () => {
	const m = make();
	const p = payload("single-student");
	p.students[0] = { label: "Student A", notice: "no_courses", courses: [], missing: [], missingTotal: 0, recent: [] };
	const root = feed(m, p);
	assert.deepEqual(textsOf(root, ".cg-notice"), ["No active courses"]);
	assert.ok(!has(root, ".cg-courses"));
	assert.ok(!has(root, ".cg-clear"));
});

test("stale: dim class and each footer variant", () => {
	const cases = [
		["network", "Updated 2 h ago - Canvas unreachable"],
		["timeout", "Updated 2 h ago - Canvas unreachable"],
		["server", "Updated 2 h ago - Canvas unreachable"],
		["throttled", "Updated 2 h ago - rate limited"],
		["auth", "Updated 2 h ago - token rejected"]
	];
	for (const [kind, text] of cases) {
		const m = make();
		const p = payload("stale-network");
		p.error = { kind, terminal: kind === "auth", detail: null };
		const root = feed(m, p);
		assert.ok(hasClass(root, "cg-stale"), kind);
		assert.deepEqual(textsOf(root, ".cg-footer"), [text], kind);
		assert.ok(has(root, ".cg-footer.cg-footer-stale"));
		assert.ok(has(root, ".cg-student"), "data is kept");
	}
	// stale by age only, no error
	const m = make();
	const p = payload("stale-network", { error: null });
	const root = feed(m, p);
	assert.deepEqual(textsOf(root, ".cg-footer"), ["Updated 2 h ago"]);
	// relative text variants
	assert.equal(m._relativeAge(30000), "just now");
	assert.equal(m._relativeAge(5 * MIN), "5 min ago");
	assert.equal(m._relativeAge(3 * HOUR), "3 h ago");
	assert.equal(m._relativeAge(50 * HOUR), "2 d ago");
});

test("partial footer, alone and joined with stale text", () => {
	const m = make();
	let root = feed(m, payload("partial"));
	assert.deepEqual(textsOf(root, ".cg-footer"), ["Some courses could not be loaded"]);
	assert.ok(has(root, ".cg-footer.cg-footer-partial"));
	assert.ok(!has(root, ".cg-footer-stale"));
	assert.ok(has(root, ".cg-course.cg-course-failed"));
	assert.ok(!hasClass(root, "cg-stale"));
	root = feed(m, payload("partial", { error: { kind: "network", terminal: false, detail: null } }));
	assert.deepEqual(textsOf(root, ".cg-footer"), [
		"Updated 5 min ago - Canvas unreachable - Some courses could not be loaded"
	]);
});

test("paused suppresses the stale dim and footer", () => {
	const m = make();
	const root = feed(m, payload("stale-network", { paused: true, error: null }));
	assert.ok(!hasClass(root, "cg-stale"));
	assert.ok(!has(root, ".cg-footer"));
});

test("error state for every kind (terminal and forbidden/no_students show at once)", () => {
	const texts = {
		config: "Canvas URL or token not set",
		token_file: "Canvas token file could not be read",
		auth: "Canvas token rejected - generate a new one",
		no_students: "No linked students found for this account",
		forbidden: "Canvas denied access for this account"
	};
	for (const [kind, text] of Object.entries(texts)) {
		const m = make();
		const root = feed(
			m,
			payload("error-auth", {
				error: { kind, terminal: ["config", "token_file", "auth"].includes(kind), detail: null }
			})
		);
		assert.ok(hasClass(root, "cg-state-error"), kind);
		assert.deepEqual(textsOf(root, ".cg-status.cg-status-error"), [text], kind);
		assert.equal(root.children.length, 1);
	}
	const m = make();
	const root = feed(m, payload("error-config"));
	assert.deepEqual(textsOf(root, ".cg-status"), ["Canvas URL or token not set"]);
});

test("transient errors: grace shows loading, then error on a tick", () => {
	const clock = { now: NOW };
	const cases = {
		network: "Cannot reach Canvas",
		timeout: "Cannot reach Canvas",
		server: "Cannot reach Canvas",
		throttled: "Canvas rate limit - retrying"
	};
	for (const [kind, text] of Object.entries(cases)) {
		clock.now = NOW;
		const m = make({ errorGraceSeconds: 120 }, clock);
		let root = feed(m, payload("error-auth", { error: { kind, terminal: false, detail: null } }));
		assert.ok(hasClass(root, "cg-state-loading"), kind);
		m.getDom();
		m.domUpdates.length = 0;
		clock.now = NOW + 60 * 1000;
		intervals[intervals.length - 1].fn();
		assert.equal(m.domUpdates.length, 0, "still within grace");
		clock.now = NOW + 121 * 1000;
		intervals[intervals.length - 1].fn();
		assert.deepEqual(m.domUpdates, [0]);
		root = m.getDom();
		assert.ok(hasClass(root, "cg-state-error"));
		assert.deepEqual(textsOf(root, ".cg-status"), [text]);
	}
});

test("an ok payload clears the grace marker", () => {
	const clock = { now: NOW };
	const m = make({ errorGraceSeconds: 120 }, clock);
	feed(m, payload("error-auth", { error: { kind: "network", terminal: false, detail: null } }));
	assert.equal(m.firstErrorSeenAt, NOW);
	clock.now = NOW + 30000;
	feed(m, payload("ok-two-students"));
	assert.equal(m.firstErrorSeenAt, 0);
	clock.now = NOW + 90000;
	feed(m, payload("error-auth", { error: { kind: "network", terminal: false, detail: null } }));
	assert.equal(m.firstErrorSeenAt, NOW + 90000);
	// a repeated transient error does not extend the grace
	clock.now = NOW + 100000;
	feed(m, payload("error-auth", { error: { kind: "server", terminal: false, detail: null } }));
	assert.equal(m.firstErrorSeenAt, NOW + 90000);
});

test("errorGraceSeconds 0 shows the error at once", () => {
	const m = make({ errorGraceSeconds: 0 });
	const root = feed(m, payload("error-auth", { error: { kind: "network", terminal: false, detail: null } }));
	assert.ok(hasClass(root, "cg-state-error"));
});

test("stale by clock advance alone: render key changes, updateDom called once", () => {
	const clock = { now: NOW };
	const m = make({}, clock);
	feed(m, payload("ok-two-students"));
	m.getDom();
	m.domUpdates.length = 0;
	intervals[0].fn();
	assert.equal(m.domUpdates.length, 0, "unchanged tick does not update");
	clock.now = NOW + 70 * MIN;
	intervals[0].fn();
	assert.deepEqual(m.domUpdates, [0]);
	const root = m.getDom();
	assert.ok(hasClass(root, "cg-stale"));
	m.domUpdates.length = 0;
	intervals[0].fn();
	assert.equal(m.domUpdates.length, 0);
});

test("clock behind fetchedAt is not stale (E18)", () => {
	const m = make();
	const root = feed(m, payload("ok-two-students", { fetchedAt: NOW + 10 * HOUR }));
	assert.ok(!hasClass(root, "cg-stale"));
	assert.ok(!has(root, ".cg-footer"));
});

test("relative due text changes trigger a re-render on tick", () => {
	const clock = { now: NOW };
	const m = make({}, clock);
	const p = payload("ok-two-students");
	p.students[0].missing[0].dueAt = local(2026, 9, 6, 15, 0);
	feed(m, p);
	assert.equal(textOf(m.getDom().querySelector(".cg-missing-due")), "due 3:00 PM");
	m.domUpdates.length = 0;
	clock.now = NOW + 4 * HOUR;
	intervals[0].fn();
	assert.deepEqual(m.domUpdates, [0]);
	assert.equal(textOf(m.getDom().querySelector(".cg-missing-due")), "due today");
});

// ---- Student names ----

test("showStudentName: auto, true, false", () => {
	let m = make();
	let root = feed(m, payload("ok-two-students"));
	assert.deepEqual(textsOf(root, ".cg-student-name"), ["Student A", "Student B"]);

	m = make();
	root = feed(m, payload("single-student"));
	assert.equal(count(root, ".cg-student-name"), 0);

	m = make({ showStudentName: true });
	root = feed(m, payload("single-student"));
	assert.deepEqual(textsOf(root, ".cg-student-name"), ["Student A"]);

	m = make({ showStudentName: false });
	root = feed(m, payload("ok-two-students"));
	assert.equal(count(root, ".cg-student-name"), 0);

	m = make({ showStudentName: "bogus" });
	root = feed(m, payload("ok-two-students"));
	assert.equal(count(root, ".cg-student-name"), 2, "falls back to auto");
});

test("empty label never renders a name element", () => {
	const m = make({ showStudentName: true });
	const p = payload("ok-two-students");
	p.students[0].label = "   ";
	p.students[1].label = "";
	const root = feed(m, p);
	assert.equal(count(root, ".cg-student-name"), 0);
});

// ---- Layouts ----

test("compact: no missing list, no recent grades, badges present", () => {
	const m = make({ layout: "compact" });
	const root = feed(m, payload("ok-two-students"));
	assert.ok(hasClass(root, "cg-layout-compact"));
	assert.ok(!has(root, ".cg-missing"));
	assert.ok(!has(root, ".cg-recent"));
	assert.equal(count(root, ".cg-badge"), 3);
	assert.ok(has(root, ".cg-badge .cg-badge-icon.fa-circle-exclamation"));
	assert.ok(has(root, ".cg-course-grade"));
});

test("compact with no course rows still lists missing work", () => {
	const m = make({ layout: "compact", showCourseGrades: false });
	const p = payload("single-student");
	p.students[0].courses = [];
	const root = feed(m, p);
	assert.ok(has(root, ".cg-missing"));
});

test("full: all sections including recent markers", () => {
	const m = make({ layout: "full" });
	const root = feed(m, payload("ok-two-students"));
	assert.ok(has(root, ".cg-missing") && has(root, ".cg-courses") && has(root, ".cg-recent"));
	assert.equal(count(root, ".cg-recent-item"), 4);
	assert.ok(has(root, ".cg-marker.cg-marker-late .fa-clock"));
	assert.equal(textOf(root.querySelector(".cg-marker-late")), "late");
	assert.ok(has(root, ".cg-marker.cg-marker-hidden .fa-eye-slash"));
	// Excused with score text "EX": a single EX, no duplicate marker
	const excusedItem = root
		.querySelectorAll(".cg-recent-item")
		.filter((el) => textsOf(el, ".cg-recent-score")[0] === "EX")[0];
	assert.ok(excusedItem);
	assert.equal(textOf(excusedItem).split("EX").length - 1, 1);
	assert.ok(!has(excusedItem, ".cg-marker-excused"));
	assert.deepEqual(textsOf(root, ".cg-recent-score").slice(0, 2), ["92 / 100", "Complete"]);
});

test("excused with a different score text still gets the EX marker", () => {
	const m = make();
	const p = payload("ok-two-students");
	p.students[1].recent[0].scoreText = "--";
	const root = feed(m, p);
	assert.deepEqual(textsOf(root, ".cg-marker-excused"), ["EX"]);
});

test("invalid layout and timeFormat fall back", () => {
	const m = make({ layout: "wide", timeFormat: 7 });
	const root = feed(m, payload("ok-two-students"));
	assert.ok(hasClass(root, "cg-layout-full"));
	assert.equal(m._timeFormat(), 12);
});

// ---- Due text ----

test("due text table", () => {
	const m = make();
	const due = (iso) => m._dueText(iso, NOW);
	assert.equal(due(local(2026, 9, 6, 15, 30)), "due 3:30 PM");
	assert.equal(due(local(2026, 9, 6, 8, 0)), "due today");
	assert.equal(due(local(2026, 9, 7, 9, 0)), "due tomorrow");
	assert.equal(due(local(2026, 9, 9, 9, 0)), "due Fri");
	assert.equal(due(local(2026, 9, 12, 9, 0)), "due Mon");
	assert.equal(due(local(2026, 9, 20, 9, 0)), "due Oct 20");
	assert.equal(due(local(2026, 9, 5, 23, 59)), "yesterday");
	assert.equal(due(local(2026, 9, 3, 23, 59)), "3 days ago");
	assert.equal(due(local(2026, 8, 23, 23, 59)), "13 days ago");
	assert.equal(due(local(2026, 8, 22, 23, 59)), "Sep 22");
	assert.equal(due(null), "");
	assert.equal(due("not a date"), "");
	assert.equal(due(""), "");
});

test("due text honours 24 hour format", () => {
	const m = make({ timeFormat: 24 });
	assert.equal(m._dueText(local(2026, 9, 6, 15, 30), NOW), "due 15:30");
});

test("missing item without a date has no due element", () => {
	const m = make();
	const root = feed(m, payload("long-names"));
	const items = root.querySelectorAll(".cg-missing-item");
	assert.equal(items.length, 2);
	assert.ok(!has(items[1], ".cg-missing-due"));
	assert.ok(!has(items[1], ".cg-missing-points"));
	assert.ok(hasClass(items[1], "cg-missing-inferred"));
});

// ---- Untrusted text ----

test("markup in names renders as literal text; no innerHTML in the module", () => {
	const m = make();
	const evil = "<img src=x onerror=alert(1)>";
	const p = payload("ok-two-students");
	p.students[0].label = evil;
	p.students[0].courses[0].name = evil;
	p.students[0].missing[0].name = evil;
	p.students[0].recent[0].name = evil;
	const root = feed(m, p);
	assert.equal(textOf(root.querySelector(".cg-student-name")), evil);
	assert.equal(textOf(root.querySelector(".cg-course-name")), evil);
	assert.equal(textOf(root.querySelector(".cg-missing-name")), evil);
	assert.equal(textOf(root.querySelector(".cg-recent-name")), evil);
	assert.ok(!has(root, "img"));
	const src = fs.readFileSync(MODULE_FILE, "utf8");
	assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(src));
	assert.ok(!/console\./.test(src));
	assert.ok(!/accessToken\b[^:]/.test(src.replace(/accessToken: ""/, "")), "module never reads the token");
});

test("long, emoji and RTL names do not throw and stay capped", () => {
	const m = make();
	const root = feed(m, payload("long-names"));
	assert.ok(hasClass(root, "cg-state-ok"));
	for (const el of root.querySelectorAll(".cg-course-name")) assert.ok(Array.from(textOf(el)).length <= 160);
	for (const el of root.querySelectorAll(".cg-missing-name")) assert.ok(Array.from(textOf(el)).length <= 160);
	assert.ok(textOf(root.querySelector(".cg-student-name")).includes("‍"));
});

// ---- Robustness ----

test("malformed payloads never throw", () => {
	const bad = [
		{ instanceId: "module_1_MMM-CanvasGrades" },
		{ instanceId: "module_1_MMM-CanvasGrades", status: 42, students: "nope", error: "x" },
		{
			instanceId: "module_1_MMM-CanvasGrades",
			status: "ok",
			students: [
				null,
				5,
				"x",
				{},
				{
					courses: [null, 1, { name: { a: 1 }, gradeText: [], missingCount: "9" }],
					missing: [null, { dueAt: 5 }],
					recent: [false]
				}
			]
		},
		{
			instanceId: "module_1_MMM-CanvasGrades",
			status: "ok",
			fetchedAt: "yesterday",
			staleAfterMs: -4,
			students: []
		},
		{ instanceId: "module_1_MMM-CanvasGrades", status: "error", error: { kind: { x: 1 } } },
		{
			instanceId: "module_1_MMM-CanvasGrades",
			status: "ok",
			error: { kind: "weird", terminal: "yes" },
			students: [{ label: { toString: null }, missingTotal: -3 }]
		}
	];
	for (const p of bad) {
		const m = make();
		assert.doesNotThrow(() => feed(m, p));
		const root = m.getDom();
		assert.ok(hasClass(root, "cg-root"));
		assert.doesNotMatch(textOf(root), /undefined|NaN|\[object/);
	}
});

test("oversized arrays are capped", () => {
	const m = make();
	const p = payload("single-student");
	const st = p.students[0];
	st.courses = Array.from({ length: 500 }, (_, i) => ({
		name: "C" + i,
		gradeText: "A",
		gradeKind: "letter",
		missingCount: 0
	}));
	st.missing = Array.from({ length: 500 }, (_, i) => ({ name: "M" + i, course: "C", dueAt: null }));
	st.recent = Array.from({ length: 500 }, (_, i) => ({ name: "R" + i, course: "C", scoreText: "1" }));
	p.students = Array.from({ length: 50 }, () => st);
	const root = feed(m, p);
	assert.equal(count(root, ".cg-student"), spec.MAX_STUDENTS);
	assert.equal(root.querySelector(".cg-student").querySelectorAll(".cg-course").length, spec.MAX_COURSES);
	assert.equal(root.querySelector(".cg-student").querySelectorAll(".cg-missing-item").length, spec.MAX_MISSING);
	assert.equal(root.querySelector(".cg-student").querySelectorAll(".cg-recent-item").length, spec.MAX_RECENT);
});

test("a render failure yields cg-empty and does not throw", () => {
	const m = make();
	feed(m, payload("ok-two-students"));
	m._coursesDom = () => {
		throw new Error("boom");
	};
	let root;
	assert.doesNotThrow(() => {
		root = m.getDom();
	});
	assert.ok(root instanceof FakeElement);
	assert.ok(hasClass(root, "cg-root") && hasClass(root, "cg-empty"));
	assert.equal(root.children.length, 0);
});

test("getDom does not call updateDom or send notifications", () => {
	const m = make();
	feed(m, payload("ok-two-students"));
	const updates = m.domUpdates.length;
	const sent = m.sent.length;
	m.getDom();
	m.getDom();
	assert.equal(m.domUpdates.length, updates);
	assert.equal(m.sent.length, sent);
});

// ---- Timers (A5) ----

test("one interval after start; suspend clears; resume restores exactly one", () => {
	const m = make();
	assert.equal(intervals.length, 1);
	assert.equal(intervals[0].ms, 60000);
	m.suspend();
	m.hidden = true;
	assert.equal(intervals.length, 0);
	m.resume();
	assert.equal(intervals.length, 1);
	assert.equal(m.domUpdates[m.domUpdates.length - 1], 0);
	for (let i = 0; i < 10; i++) {
		m.suspend();
		m.resume();
		m.resume();
	}
	assert.equal(intervals.length, 1);
	m.suspend();
	m.suspend();
	assert.equal(intervals.length, 0);
});

test("MODULE_DOM_UPDATED without sender restarts the tick when visible; with a sender it is ignored", () => {
	const m = make();
	m.suspend();
	m.hidden = true;
	assert.equal(intervals.length, 0);
	m.notificationReceived("MODULE_DOM_UPDATED", null, undefined);
	assert.equal(intervals.length, 0, "still hidden");
	m.hidden = false;
	m.notificationReceived("MODULE_DOM_UPDATED", null, { name: "MMM-Other" });
	assert.equal(intervals.length, 0, "sender ignored");
	m.notificationReceived("SOMETHING_ELSE", null, undefined);
	assert.equal(intervals.length, 0);
	m.notificationReceived("MODULE_DOM_UPDATED", null, undefined);
	assert.equal(intervals.length, 1);
	assert.equal(m.suspended, false);
	m.notificationReceived("MODULE_DOM_CREATED", null, undefined);
	assert.equal(intervals.length, 1, "no accumulation");
});

test("a tick with nothing changed does not call updateDom", () => {
	const m = make();
	feed(m, payload("nothing-missing"));
	m.getDom();
	m.domUpdates.length = 0;
	for (let i = 0; i < 5; i++) intervals[0].fn();
	assert.equal(m.domUpdates.length, 0);
});

// ---- studentsNotFound ----

const topNotices = (root) => root.children.filter((el) => hasClass(el, "cg-notice"));

test("studentsNotFound notice: plural, singular, and in stale and partial states", () => {
	const m = make();
	let root = feed(m, payload("students-not-found"));
	assert.deepEqual(topNotices(root).map(textOf), ["2 configured students not found"]);
	assert.equal(root.children[0].className, "cg-notice", "notice is at the top of the card");
	assert.ok(has(root, ".cg-student"));
	root = feed(m, payload("students-not-found", { studentsNotFound: 1 }));
	assert.deepEqual(topNotices(root).map(textOf), ["1 configured student not found"]);
	root = feed(m, payload("students-not-found", { fetchedAt: NOW - 3 * HOUR }));
	assert.ok(hasClass(root, "cg-stale"));
	assert.equal(topNotices(root).length, 1);
	root = feed(m, payload("students-not-found", { partial: true }));
	assert.equal(topNotices(root).length, 1);
	assert.ok(has(root, ".cg-footer-partial"));
});

test("studentsNotFound hidden for 0, missing, and garbage values", () => {
	for (const v of [0, undefined, -3, "2", null, NaN, Infinity, {}, [], true]) {
		const m = make();
		const root = feed(m, payload("students-not-found", { studentsNotFound: v }));
		assert.equal(topNotices(root).length, 0, String(v));
		assert.ok(has(root, ".cg-student"));
	}
	const m = make();
	const p = payload("students-not-found");
	delete p.studentsNotFound;
	assert.equal(topNotices(feed(m, p)).length, 0);
});

test("studentsNotFound is not shown in loading or error states", () => {
	const m = make();
	assert.equal(count(feed(m, payload("error-auth", { studentsNotFound: 2 })), ".cg-notice"), 0);
});
