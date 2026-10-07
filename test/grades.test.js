"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { normalizeConfig } = require("../lib/config");
const g = require("../lib/grades");
const { loadFixture } = require("./support/fake-fetch");

const NOW = Date.parse("2026-10-06T16:00:00Z");
const DAY = 86400000;
const iso = (offsetDays) => new Date(NOW + offsetDays * DAY).toISOString();

const makeCfg = (extra = {}) =>
	normalizeConfig({ canvasUrl: "https://canvas.example.edu", accessToken: "tok", ...extra }).cfg;

const assignment = (extra = {}) => ({
	id: "5900",
	course_id: "1001",
	name: "Sample Task",
	due_at: iso(-3),
	points_possible: 10,
	grading_type: "points",
	submission_types: ["online_upload"],
	published: true,
	locked_for_user: false,
	...extra
});
const submission = (extra = {}, asg = {}) => {
	const a = assignment(asg);
	return {
		id: "99000",
		assignment_id: a.id,
		workflow_state: "unsubmitted",
		score: null,
		grade: null,
		entered_score: null,
		missing: false,
		late: false,
		excused: false,
		submitted_at: null,
		graded_at: null,
		posted_at: null,
		late_policy_status: null,
		cached_due_date: a.due_at,
		assignment: a,
		...extra
	};
};
const kindOf = (sub, cfgExtra = {}) => g.classifySubmission(sub, makeCfg(cfgExtra), NOW);

describe("text helpers", () => {
	it("decodes named and numeric entities once", () => {
		assert.equal(
			g.cleanText("Tom &amp; Jerry &lt;3 &quot;q&quot; &#39;s&#39; &apos;x&apos; &#x41;&#66;"),
			`Tom & Jerry <3 "q" 's' 'x' AB`
		);
		assert.equal(g.cleanText("&amp;lt;"), "&lt;");
		assert.equal(g.cleanText("a&nbsp;&nbsp;b"), "a b");
	});

	it("keeps literal markup as text", () => {
		assert.equal(g.cleanText("<b>bold</b> <img src=x onerror=1>"), "<b>bold</b> <img src=x onerror=1>");
	});

	it("removes control characters, collapses whitespace and handles bad entity code points", () => {
		assert.equal(g.cleanText("a\u0000b\u0007c\t\n d   e\u0085"), "abc d e");
		assert.equal(g.cleanText("x&#0;y&#1114112;z&#xD800;"), "xyz");
		assert.equal(g.cleanText(null), "");
		assert.equal(g.cleanText({}), "");
		assert.equal(g.cleanText(42), "42");
		assert.equal(g.cleanText(NaN), "");
	});

	it("truncates by grapheme, counting a ZWJ family emoji as one", () => {
		const family = "\u{1F468}‍\u{1F469}‍\u{1F467}";
		assert.equal(g.truncate(family.repeat(6), 5), `${family}${family}...`);
		assert.equal(g.truncate("abcdefghij", 8), "abcde...");
		assert.equal(g.truncate("abcdefgh", 8), "abcdefgh", "exact length is untouched");
		assert.equal(g.truncate("abcdefghi", 8), "abcde...");
		const long = g.truncate(family.repeat(10), 6);
		assert.equal(Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(long)).length, 6);
		assert.ok(!long.includes("�"));
	});

	it("leaves RTL text intact and caps cleanText length", () => {
		const rtl = "مرحبا بالعالم";
		assert.equal(g.cleanText(rtl), rtl);
		assert.equal(g.cleanText("x".repeat(500), 120).length, 120);
		assert.ok(g.cleanText("x".repeat(500), 120).endsWith("..."));
	});

	it("formats percent and numbers", () => {
		assert.equal(g.formatPercent(91.45), "91.5%");
		assert.equal(g.formatPercent(90), "90%");
		assert.equal(g.formatPercent(89.04), "89%");
		assert.equal(g.formatPercent(0), "0%");
		assert.equal(g.formatPercent(NaN), "--");
		assert.equal(g.formatPercent(Infinity), "--");
		assert.equal(g.formatPercent("90"), "--");
		assert.equal(g.formatPercent(91.4, "de-DE"), "91,4%");
		assert.equal(g.formatNumber(18), "18");
		assert.equal(g.formatNumber(17.505), "17.51");
		assert.equal(g.formatNumber(undefined), "--");
		assert.equal(g.formatPercent(91.4, "bad locale!!"), "91.4%");
	});
});

describe("selectStudents / labels", () => {
	const observees = loadFixture("observees");

	it("returns all observees for an empty config and keeps config order otherwise", () => {
		assert.deepEqual(
			g.selectStudents(observees, makeCfg()).selected.map((s) => s.id),
			["2001", "2002"]
		);
		const ordered = g.selectStudents(observees, makeCfg({ students: ["2002", "2001"] }));
		assert.deepEqual(
			ordered.selected.map((s) => s.id),
			["2002", "2001"]
		);
	});

	it("reports unknown ids and tolerates garbage input", () => {
		const result = g.selectStudents(
			[...observees, null, { name: "no id" }, "x"],
			makeCfg({ students: ["2001", "9999"] })
		);
		assert.deepEqual(result.notFound, ["9999"]);
		assert.equal(result.selected.length, 1);
		assert.deepEqual(g.selectStudents(null, makeCfg()), { selected: [], notFound: [] });
	});

	it("discovers observees from the observer course list as a fallback", () => {
		const found = g.observeesFromCourses(loadFixture("observer-courses-observed-users"));
		assert.deepEqual(found.map((u) => u.id).sort(), ["2001", "2002"]);
		const idOnly = g.observeesFromCourses([
			{ id: "1", enrollments: [{ type: "observer", associated_user_id: 77 }] }
		]);
		assert.deepEqual(idOnly, [{ id: "77" }]);
		assert.deepEqual(
			g.selectStudents(found, makeCfg({ students: ["2002"] })).selected.map((u) => u.id),
			["2002"]
		);
	});

	it("labels students by nameDisplay, with studentLabels taking precedence", () => {
		const user = { id: "2001", name: "Student Alpha Beta", short_name: "Stu" };
		assert.equal(g.studentLabel(user, makeCfg({ nameDisplay: "full" })), "Student Alpha Beta");
		assert.equal(g.studentLabel(user, makeCfg({ nameDisplay: "short" })), "Stu");
		assert.equal(g.studentLabel(user, makeCfg({ nameDisplay: "initials" })), "S.A.B.");
		assert.equal(g.studentLabel(user, makeCfg({ nameDisplay: "none" })), "");
		assert.equal(g.studentLabel(user, makeCfg({ nameDisplay: "none", studentLabels: { 2001: "Kid" } })), "Kid");
		assert.equal(g.studentLabel({ id: "1", name: "Student Alpha" }, makeCfg({ nameDisplay: "short" })), "Student");
		assert.equal(g.studentLabel({ id: "1" }, makeCfg({ nameDisplay: "initials" })), "");
	});
});

describe("selectCourses", () => {
	const courses = loadFixture("courses-student-a");
	const ids = (list) => list.map((c) => c.id);

	it("keeps all available courses in Canvas order by default", () => {
		assert.deepEqual(ids(g.selectCourses(courses, makeCfg())), ["1001", "1002", "1003", "1004", "1005"]);
	});

	it("applies include-only order then exclusions", () => {
		assert.deepEqual(ids(g.selectCourses(courses, makeCfg({ courses: ["1004", "1001", "9999"] }))), [
			"1004",
			"1001"
		]);
		assert.deepEqual(ids(g.selectCourses(courses, makeCfg({ excludeCourses: ["1005"] }))), [
			"1001",
			"1002",
			"1003",
			"1004"
		]);
		assert.deepEqual(
			ids(g.selectCourses(courses, makeCfg({ courses: ["1001", "1005"], excludeCourses: ["1005"] }))),
			["1001"]
		);
	});

	it("drops date-restricted and non-available courses and bad entries", () => {
		const list = [
			{ id: "1", workflow_state: "available" },
			{ id: "2", workflow_state: "completed" },
			{ id: "3", workflow_state: "available", access_restricted_by_date: true },
			{ id: "4", workflow_state: "unpublished" },
			null,
			{ workflow_state: "available" }
		];
		assert.deepEqual(ids(g.selectCourses(list, makeCfg())), ["1"]);
	});
});

describe("courseGrade", () => {
	const enrollment = (extra = {}) => ({
		type: "student",
		user_id: "2001",
		computed_current_score: 91.4,
		computed_final_score: 84.2,
		computed_current_grade: "A-",
		computed_final_grade: "B",
		...extra
	});
	const course = (e = {}, c = {}) => ({ id: "1001", enrollments: [enrollment(e)], ...c });
	const grade = (c, cfg = {}) => g.courseGrade(c, "2001", makeCfg(cfg));

	it("chooses current or final", () => {
		assert.equal(grade(course()).gradeText, "A-");
		assert.equal(grade(course(), { scoreType: "final" }).gradeText, "B");
		assert.equal(grade(course(), { scoreType: "final", gradeDisplay: "percent" }).gradeText, "84.2%");
	});

	it("uses current period fields, falls back to totals when no period is current, ignores periods for 'all'", () => {
		const periods = {
			has_grading_periods: true,
			current_grading_period_id: "9001",
			current_period_computed_current_score: 93,
			current_period_computed_current_grade: "A"
		};
		assert.equal(grade(course(periods)).gradeText, "A");
		assert.equal(grade(course(periods), { gradingPeriod: "all" }).gradeText, "A-");
		const none = grade(course({ has_grading_periods: true, current_grading_period_id: null }));
		assert.equal(none.gradeText, "A-");
		assert.equal(none.periodFallback, true);
		assert.equal(grade(course(periods)).periodFallback, false);
	});

	it("shows '--' for hidden finals and null totals", () => {
		const hidden = grade(course({}, { hide_final_grades: true }));
		assert.deepEqual([hidden.gradeText, hidden.gradeKind, hidden.hidden], ["--", "none", true]);
		const nulls = grade(course({ computed_current_score: null, computed_current_grade: null }));
		assert.deepEqual([nulls.gradeText, nulls.gradeKind, nulls.hidden], ["--", "none", true]);
		assert.equal(grade({ id: "1", enrollments: [] }).hidden, true);
		assert.equal(g.courseGrade(null, "2001", makeCfg()).hidden, true);
	});

	it("handles a missing student enrollment and mismatched user_id", () => {
		assert.equal(grade({ id: "1", enrollments: [{ type: "observer", computed_current_score: 99 }] }).hidden, true);
		assert.equal(g.courseGrade(course(), "7777", makeCfg()).hidden, true);
		assert.equal(grade(course({ user_id: undefined })).gradeText, "A-");
	});

	it("forces letter only for restricted quantitative data in every gradeDisplay", () => {
		for (const gradeDisplay of ["auto", "letter", "percent", "both"]) {
			const flagged = grade(course({}, { restrict_quantitative_data: true }), { gradeDisplay });
			assert.deepEqual(
				[flagged.gradeText, flagged.gradeKind, flagged.restricted],
				["A-", "letter", true],
				gradeDisplay
			);
			const nullScore = grade(course({ computed_current_score: null }), { gradeDisplay });
			assert.deepEqual([nullScore.gradeText, nullScore.gradeKind], ["A-", "letter"], gradeDisplay);
		}
		assert.equal(
			grade(course({ computed_current_grade: null }, { restrict_quantitative_data: true })).hidden,
			true
		);
	});

	it("honours each gradeDisplay including auto with a null letter", () => {
		assert.equal(grade(course(), { gradeDisplay: "auto" }).gradeKind, "letter");
		assert.equal(grade(course(), { gradeDisplay: "letter" }).gradeText, "A-");
		assert.equal(grade(course(), { gradeDisplay: "percent" }).gradeText, "91.4%");
		const both = grade(course(), { gradeDisplay: "both" });
		assert.deepEqual([both.gradeText, both.gradeKind], ["A- 91.4%", "both"]);
		const noLetter = course({ computed_current_grade: null });
		assert.deepEqual([grade(noLetter).gradeText, grade(noLetter).gradeKind], ["91.4%", "percent"]);
		assert.equal(grade(noLetter, { gradeDisplay: "letter" }).gradeText, "91.4%");
		assert.equal(grade(noLetter, { gradeDisplay: "both" }).gradeKind, "percent");
	});

	it("rounds to one decimal with trailing zeros trimmed", () => {
		assert.equal(grade(course({ computed_current_score: 91.45 }), { gradeDisplay: "percent" }).gradeText, "91.5%");
		assert.equal(grade(course({ computed_current_score: 90 }), { gradeDisplay: "percent" }).gradeText, "90%");
		assert.equal(grade(course({ computed_current_score: 89.04 }), { gradeDisplay: "percent" }).gradeText, "89%");
	});
});

describe("classifySubmission", () => {
	it("excused wins, including over missing: true", () => {
		assert.equal(kindOf(submission({ excused: true, missing: true })).kind, "excused");
	});

	it("extended is never missing, flagged or inferred", () => {
		assert.equal(kindOf(submission({ late_policy_status: "extended", missing: true })).kind, "open");
		assert.equal(kindOf(submission({ late_policy_status: "extended" })).kind, "open");
	});

	it("missing: true and late_policy_status missing are missing, not inferred", () => {
		assert.deepEqual(kindOf(submission({ missing: true })), { kind: "missing", inferred: false });
		assert.deepEqual(kindOf(submission({ late_policy_status: "missing" })), { kind: "missing", inferred: false });
	});

	it("policy-zero missing (entered_score null) stays missing", () => {
		const sub = submission({
			workflow_state: "graded",
			late_policy_status: "missing",
			missing: true,
			score: 0,
			entered_score: null,
			posted_at: iso(-1)
		});
		assert.equal(kindOf(sub).kind, "missing");
	});

	it("graded after missing is graded and shows up in recent with a late marker", () => {
		const sub = submission({
			workflow_state: "graded",
			missing: true,
			late: true,
			score: 8,
			entered_score: 9,
			grade: "8",
			graded_at: iso(-1),
			posted_at: iso(-1)
		});
		assert.equal(kindOf(sub).kind, "graded");
		const view = g.buildStudentView({
			student: { id: "2001", name: "Student A", short_name: "Student A" },
			courses: [{ id: "1001", name: "Algebra I", workflow_state: "available", enrollments: [] }],
			submissionsByCourse: new Map([["1001", [sub]]]),
			failedCourseIds: new Set(),
			missingAssignments: null,
			cfg: makeCfg({ showRecentGrades: 3 }),
			now: NOW
		});
		assert.equal(view.missingTotal, 0);
		assert.equal(view.recent.length, 1);
		assert.equal(view.recent[0].late, true);
		assert.equal(view.recent[0].scoreText, "8 / 10");
	});

	it("infers missing for unsubmitted past-due online work", () => {
		assert.deepEqual(kindOf(submission()), { kind: "missing", inferred: true });
	});

	it("does not infer when inferMissing is false", () => {
		assert.equal(kindOf(submission(), { inferMissing: false }).kind, "open");
	});

	it("does not infer for none, on_paper, not_graded or a lone external_tool", () => {
		for (const types of [["none"], ["on_paper"], ["not_graded"], ["online_upload", "none"], ["external_tool"]]) {
			assert.equal(kindOf(submission({}, { submission_types: types })).kind, "open", types.join());
		}
		assert.equal(
			kindOf(submission({}, { submission_types: ["external_tool", "online_text_entry"] })).kind,
			"missing"
		);
	});

	it("does not infer without a due date, with a future due date, or after submission", () => {
		assert.equal(kindOf(submission({ cached_due_date: null }, { due_at: null })).kind, "open");
		assert.equal(kindOf(submission({}, { due_at: iso(2) })).kind, "open");
		assert.equal(kindOf(submission({ submitted_at: iso(-4), workflow_state: "submitted" })).kind, "open");
	});

	it("still reports a Canvas-flagged missing item with no due date", () => {
		assert.equal(kindOf(submission({ missing: true, cached_due_date: null }, { due_at: null })).kind, "missing");
	});

	it("ignores unpublished, locked, not_graded and deleted items and non-objects", () => {
		assert.equal(kindOf(submission({}, { published: false })).kind, "ignore");
		assert.equal(kindOf(submission({}, { locked_for_user: true })).kind, "ignore");
		assert.equal(kindOf(submission({ missing: true }, { grading_type: "not_graded" })).kind, "ignore");
		assert.equal(kindOf(submission({ workflow_state: "deleted" })).kind, "ignore");
		assert.equal(kindOf({ id: "1" }).kind, "ignore");
		assert.equal(kindOf(null).kind, "ignore");
	});

	it("cached_due_date overrides due_at in both directions", () => {
		assert.equal(kindOf(submission({ cached_due_date: iso(3) }, { due_at: iso(-3) })).kind, "open");
		assert.equal(kindOf(submission({ cached_due_date: iso(-3) }, { due_at: iso(3) })).kind, "missing");
	});

	it("applies the lookback window, 0 meaning unlimited", () => {
		const day31 = submission({ cached_due_date: iso(-31) });
		const day29 = submission({ cached_due_date: iso(-29) });
		assert.equal(kindOf(day31, { missingLookbackDays: 30 }).kind, "ignore");
		assert.equal(kindOf(day29, { missingLookbackDays: 30 }).kind, "missing");
		assert.equal(kindOf(day31, { missingLookbackDays: 0 }).kind, "missing");
		assert.equal(
			kindOf(submission({ missing: true, cached_due_date: iso(-31) }), { missingLookbackDays: 30 }).kind,
			"ignore"
		);
	});

	it("compares due dates in absolute UTC time at a local-midnight boundary", () => {
		const dueOneMinuteAfterNow = new Date(NOW + 60000).toISOString().replace("Z", "+00:00");
		assert.equal(kindOf(submission({ cached_due_date: dueOneMinuteAfterNow })).kind, "open");
		const sameInstantOtherOffset = "2026-10-06T09:59:00-06:00";
		assert.equal(Date.parse(sameInstantOtherOffset), NOW - 60000);
		assert.equal(kindOf(submission({ cached_due_date: sameInstantOtherOffset })).kind, "missing");
	});

	it("classifies hidden grades and graded items", () => {
		const hidden = submission({ workflow_state: "graded", score: null, posted_at: null, graded_at: iso(-1) });
		assert.equal(kindOf(hidden).kind, "hidden");
		assert.equal(kindOf(submission({ workflow_state: "pending_review" })).kind, "hidden");
		assert.equal(kindOf(submission({ ...hidden, missing: true })).kind, "missing", "hidden but Canvas-missing");
		assert.equal(
			kindOf(submission({ workflow_state: "graded", score: 7, entered_score: 7, posted_at: iso(-1) })).kind,
			"graded"
		);
		assert.equal(
			kindOf(submission({ workflow_state: "graded", grade: "complete", score: null, posted_at: iso(-1) })).kind,
			"graded"
		);
	});
});

describe("formatScore", () => {
	const fmt = (subExtra, asgExtra, cfgExtra = {}, restricted = false, kind = "graded") =>
		g.formatScore(submission(subExtra, asgExtra), assignment(asgExtra), makeCfg(cfgExtra), restricted, kind);

	it("renders markers and null scores", () => {
		assert.equal(fmt({}, {}, {}, false, "hidden"), "Hidden");
		assert.equal(fmt({}, {}, {}, false, "excused"), "EX");
		assert.equal(fmt({ score: null, grade: null }), "--");
		assert.notEqual(fmt({ score: null, grade: null }), "0");
	});

	it("follows grading_type under auto", () => {
		assert.equal(fmt({ score: 18, grade: "18" }, { points_possible: 20 }), "18 / 20");
		assert.equal(fmt({ score: 18, grade: "90%" }, { points_possible: 20, grading_type: "percent" }), "90%");
		assert.equal(fmt({ score: 45, grade: "A-" }, { points_possible: 50, grading_type: "letter_grade" }), "A-");
		assert.equal(fmt({ score: 3.5, grade: "B" }, { points_possible: 4, grading_type: "gpa_scale" }), "B");
		assert.equal(
			fmt({ score: 10, grade: "complete" }, { points_possible: 10, grading_type: "pass_fail" }),
			"Complete"
		);
		assert.equal(
			fmt({ score: 0, grade: "incomplete" }, { points_possible: 10, grading_type: "pass_fail" }),
			"Incomplete"
		);
		assert.equal(fmt({ score: 5, grade: "weird" }, { grading_type: "pass_fail" }), "--");
	});

	it("honours assignmentScoreDisplay overrides", () => {
		const sub = { score: 18, grade: "A-" };
		assert.equal(
			fmt(sub, { points_possible: 20, grading_type: "letter_grade" }, { assignmentScoreDisplay: "points" }),
			"18 / 20"
		);
		assert.equal(
			fmt(sub, { points_possible: 20, grading_type: "points" }, { assignmentScoreDisplay: "percent" }),
			"90%"
		);
		assert.equal(
			fmt(sub, { points_possible: 20, grading_type: "points" }, { assignmentScoreDisplay: "letter" }),
			"A-"
		);
		assert.equal(
			fmt({ score: 18, grade: "18" }, { points_possible: 20 }, { assignmentScoreDisplay: "letter" }),
			"18 / 20"
		);
	});

	it("never divides by zero or emits NaN/Infinity/undefined", () => {
		const outputs = [
			fmt({ score: 5, grade: "5" }, { points_possible: 0 }),
			fmt({ score: 5, grade: "5" }, { points_possible: null }),
			fmt({ score: 5, grade: null }, { points_possible: 0 }),
			fmt({ score: 5, grade: "5" }, { points_possible: 0, grading_type: "percent" }),
			fmt({ score: 5, grade: null }, { points_possible: null, grading_type: "percent" }),
			fmt({ score: null, grade: "B" }, { points_possible: 10 }),
			fmt({ score: Infinity, grade: null }, { points_possible: 10 }),
			fmt({ score: "x", grade: undefined }, {})
		];
		assert.equal(outputs[0], "5");
		assert.equal(outputs[1], "5");
		assert.equal(outputs[2], "5");
		assert.equal(outputs[3], "5");
		assert.equal(outputs[4], "--");
		assert.equal(outputs[5], "B");
		for (const text of outputs) assert.ok(!/NaN|Infinity|undefined/.test(text), text);
	});

	it("forces the letter grade in restricted courses", () => {
		assert.equal(fmt({ score: 18, grade: "A-" }, { points_possible: 20 }, {}, true), "A-");
		assert.equal(fmt({ score: 18, grade: null }, { points_possible: 20 }, {}, true), "--");
	});
});

describe("mergeMissing", () => {
	const item = (id, course, extra = {}) => ({
		assignmentId: id,
		courseId: course,
		name: `n${id}`,
		dueMs: NOW - DAY,
		points: 1,
		inferred: false,
		...extra
	});

	it("unions submissions and endpoint results, dedups by assignment id", () => {
		const merged = g.mergeMissing(
			[item("1", "a"), item("2", "a", { inferred: true })],
			[item("2", "a"), item("3", "b")],
			new Set()
		);
		assert.deepEqual(merged.map((m) => m.assignmentId).sort(), ["1", "2", "3"]);
		assert.equal(
			merged.find((m) => m.assignmentId === "2").inferred,
			false,
			"endpoint confirmation clears inferred"
		);
	});

	it("drops endpoint items that the submissions say are graded or excused", () => {
		const merged = g.mergeMissing(
			[item("1", "a")],
			[item("1", "a"), item("2", "a"), item("3", "a")],
			new Set(["2", "3"])
		);
		assert.deepEqual(
			merged.map((m) => m.assignmentId),
			["1"]
		);
	});

	it("handles a null endpoint and empty inputs", () => {
		assert.equal(g.mergeMissing([item("1", "a")], null, new Set()).length, 1);
		assert.deepEqual(g.mergeMissing(null, null, null), []);
	});
});

describe("buildStudentView on the fixtures", () => {
	const student = (n) => loadFixture("observees")[n];
	const courses = (name) => g.selectCourses(loadFixture(`courses-${name}`), makeCfg({ excludeCourses: ["1005"] }));
	const subsA = new Map([
		["1001", [...loadFixture("submissions-1001-student-a-p1"), ...loadFixture("submissions-1001-student-a-p2")]],
		["1002", loadFixture("submissions-1002-student-a")],
		["1003", loadFixture("submissions-1003-student-a")],
		["1004", loadFixture("submissions-1004-student-a")]
	]);
	const subsB = new Map(
		["1001", "1002", "1003", "1004"].map((id) => [id, loadFixture(`submissions-${id}-student-b`)])
	);
	const build = (who, extra = {}, endpoint = null) =>
		g.buildStudentView({
			student: student(who === "a" ? 0 : 1),
			courses: courses(`student-${who}`),
			submissionsByCourse: who === "a" ? subsA : subsB,
			failedCourseIds: new Set(),
			missingAssignments: endpoint,
			cfg: makeCfg(extra),
			now: NOW
		});

	it("builds Student A with Canvas-flagged and inferred missing work, sorted by due date", () => {
		const view = build("a");
		assert.equal(view.label, "Student A");
		assert.equal(view.notice, null);
		assert.deepEqual(
			view.courses.map((c) => [c.name, c.gradeText, c.gradeKind, c.hidden, c.missingCount]),
			[
				["Algebra I", "A", "letter", false, 2],
				["Biology", "B", "letter", false, 0],
				["World History", "--", "none", true, 0],
				["English 9", "78.5%", "percent", false, 0]
			]
		);
		assert.deepEqual(view.missing, [
			{
				name: "Chapter 4 Worksheet",
				course: "Algebra I",
				icon: null,
				color: null,
				dueAt: "2026-10-02T04:59:00.000Z",
				pointsText: "20 pts",
				inferred: false
			},
			{
				name: "Homework 12",
				course: "Algebra I",
				icon: null,
				color: null,
				dueAt: "2026-10-03T06:59:00.000Z",
				pointsText: "10 pts",
				inferred: true
			}
		]);
		assert.equal(view.missingTotal, 2);
		assert.deepEqual(view.recent, []);
	});

	it("unions the missing_submissions endpoint and drops entries graded in submissions", () => {
		const view = build("a", {}, loadFixture("missing-submissions-student-a"));
		assert.deepEqual(
			view.missing.map((m) => m.name),
			["Map Quiz", "Chapter 4 Worksheet", "Homework 12"]
		);
		assert.equal(view.courses.find((c) => c.name === "World History").missingCount, 1);
		assert.equal(view.missing[1].inferred, false);
	});

	it("builds Student B with nothing missing", () => {
		const view = build("b");
		assert.equal(view.missingTotal, 0);
		assert.deepEqual(view.missing, []);
		assert.deepEqual(
			view.courses.map((c) => [c.name, c.gradeText]),
			[
				["Algebra I", "B+"],
				["Biology", "A"],
				["World History", "C-"],
				["English 9", "A-"]
			]
		);
	});

	it("lists recent grades newest first within the window, with markers and capped", () => {
		const view = build("a", { showRecentGrades: 5, recentGradesDays: 7 });
		assert.deepEqual(
			view.recent.map((r) => [r.name, r.scoreText, r.late, r.hidden, r.excused]),
			[
				["Quiz 3", "18 / 20", false, false, false],
				["Essay Draft", "Hidden", false, true, false],
				["Vocabulary Quiz", "8 / 10", true, false, false],
				["Unit Check", "Complete", false, false, false]
			]
		);
		assert.equal(view.recent[0].gradedAt, "2026-10-05T14:00:00.000Z");
		assert.equal(build("a", { showRecentGrades: 2 }).recent.length, 2);
		assert.equal(
			build("a", { showRecentGrades: 5, recentGradesDays: 30 }).recent.some((r) => r.name === "Unit Test"),
			true
		);
	});

	it("caps missing at maxMissing while keeping missingTotal", () => {
		const view = build("a", { maxMissing: 1 }, loadFixture("missing-submissions-student-a"));
		assert.equal(view.missing.length, 1);
		assert.equal(view.missingTotal, 3);
	});

	it("honours showMissing and showCourseGrades off", () => {
		const view = build("a", { showMissing: false, showCourseGrades: false });
		assert.deepEqual(view.missing, []);
		assert.deepEqual(view.courses, []);
	});

	it("applies courseLabels and maxCourseNameLength", () => {
		const view = build("a", { courseLabels: { 1001: "Alg" }, maxCourseNameLength: 8 });
		assert.equal(view.courses[0].name, "Alg");
		assert.equal(view.missing[0].course, "Alg");
		assert.equal(view.courses[2].name, "World...");
		assert.equal(view.missing.length, 2);
	});

	it("marks failed courses and flags students with no courses", () => {
		const failed = g.buildStudentView({
			student: student(0),
			courses: courses("student-a"),
			submissionsByCourse: new Map(),
			failedCourseIds: ["1002"],
			missingAssignments: null,
			cfg: makeCfg(),
			now: NOW
		});
		assert.equal(failed.courses.find((c) => c.name === "Biology").failed, true);
		assert.equal(failed.courses.find((c) => c.name === "Algebra I").failed, false);
		const empty = g.buildStudentView({
			student: student(0),
			courses: [],
			submissionsByCourse: new Map(),
			failedCourseIds: new Set(),
			missingAssignments: null,
			cfg: makeCfg(),
			now: NOW
		});
		assert.equal(empty.notice, "no_courses");
		assert.deepEqual(empty.courses, []);
	});

	it("survives malformed submissions", () => {
		const view = g.buildStudentView({
			student: student(0),
			courses: courses("student-a"),
			submissionsByCourse: new Map([
				[
					"1001",
					[null, 5, "x", { assignment: null }, { assignment: { name: 7, due_at: "garbage" }, missing: true }]
				]
			]),
			failedCourseIds: new Set(),
			missingAssignments: [null, 3, { id: "1" }],
			cfg: makeCfg(),
			now: NOW
		});
		assert.equal(view.missing.length, 1);
		assert.equal(view.missing[0].dueAt, null);
		assert.equal(view.missing[0].name, "7");
	});

	it("sorts undated missing items last", () => {
		const subs = new Map([
			[
				"1001",
				[
					submission({ missing: true, cached_due_date: null }, { id: "7001", name: "Undated", due_at: null }),
					submission({ missing: true }, { id: "7002", name: "Dated", due_at: iso(-2) })
				]
			]
		]);
		const view = g.buildStudentView({
			student: student(0),
			courses: courses("student-a"),
			submissionsByCourse: subs,
			failedCourseIds: new Set(),
			missingAssignments: null,
			cfg: makeCfg(),
			now: NOW
		});
		assert.deepEqual(
			view.missing.map((m) => m.name),
			["Dated", "Undated"]
		);
		assert.equal(view.missing[1].dueAt, null);
	});

	it("exposes no ids, hosts or URLs in the serialised view and never prints NaN/undefined", () => {
		const view = build("a", { showRecentGrades: 5 }, loadFixture("missing-submissions-student-a"));
		const text = JSON.stringify([view, build("b", { showRecentGrades: 5 })]);
		for (const forbidden of [
			"canvas.example.edu",
			"html_url",
			"2001",
			"2002",
			"3001",
			"1001",
			"1002",
			"1003",
			"1004",
			"1005",
			"5001",
			"5012",
			"9001"
		]) {
			assert.ok(!text.includes(forbidden), forbidden);
		}
		assert.ok(!/NaN|Infinity|undefined/.test(text));
	});
});
