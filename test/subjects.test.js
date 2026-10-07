"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { buildSubjectRules, matchSubject, validIcon, validColor } = require("../lib/subjects");
const { normalizeConfig, instanceSignature } = require("../lib/config");
const { buildStudentView } = require("../lib/grades");
const { loadFixture } = require("./support/fake-fetch");

const NOW = Date.parse("2026-10-06T16:00:00Z");
const makeCfg = (extra = {}) =>
	normalizeConfig({ canvasUrl: "https://canvas.example.edu", accessToken: "tok", ...extra }).cfg;

// fictional example in the shape MMM-MyAgenda uses
const ICONS = {
	Science: "fas fa-dna",
	Math: "bx bx-calculator",
	English: "fa-solid fa-book",
	History: "iconoir-globe",
	Music: "fa-solid fa-music"
};
const COLORS = {
	Science: "#1569a0",
	Math: "#c2410c",
	English: "#7c3aed",
	History: "#15803d",
	Music: "rgb(190, 24, 93)"
};

describe("validation", () => {
	it("accepts only plain class lists as icons", () => {
		assert.equal(validIcon("fas fa-dna"), "fas fa-dna");
		assert.equal(validIcon("  bx   bx-calculator "), "bx bx-calculator");
		assert.equal(validIcon("iconoir-globe"), "iconoir-globe");
		for (const bad of [
			"",
			"a".repeat(65),
			'fa" onclick="x',
			"fa<b>",
			"fa;color:red",
			"fa.dna",
			"fa/dna",
			5,
			null,
			{},
			["fa"]
		]) {
			assert.equal(validIcon(bad), null, String(bad));
		}
	});

	it("accepts hex, simple rgb/hsl and plain names as colours", () => {
		for (const good of [
			"#fff",
			"#ffff",
			"#1569a0",
			"#1569a0cc",
			"rgb(1, 2, 3)",
			"rgba(1,2,3,0.5)",
			"rgb(1 2 3 / 50%)",
			"hsl(200, 50%, 40%)",
			"hsla(200,50%,40%,0.4)",
			"tomato",
			"Red"
		]) {
			assert.ok(validColor(good), good);
		}
		for (const bad of [
			"",
			"#12",
			"#12345",
			"#gggggg",
			"url(x)",
			"red;background:url(x)",
			"rgb(1,2,3);",
			"var(--x)",
			"expression(1)",
			"rgb(a,b,c)",
			"ab",
			"x".repeat(21),
			"red blue",
			"rgb(1,2)",
			5,
			null,
			{}
		]) {
			assert.equal(validColor(bad), null, String(bad));
		}
		assert.equal(validColor("Red"), "red");
	});
});

describe("matching (MMM-MyAgenda semantics)", () => {
	const { rules, warnings } = buildSubjectRules(ICONS, COLORS);

	it("builds rules without warnings from a valid config", () => {
		assert.deepEqual(warnings, []);
		assert.equal(rules.icons.length, 5);
		assert.equal(rules.colors.length, 5);
	});
	it("matches the lower-cased name by substring", () => {
		assert.deepEqual(matchSubject(rules, "AP Science 8"), { icon: "fas fa-dna", color: "#1569a0" });
		assert.deepEqual(matchSubject(rules, "mathematics"), { icon: "bx bx-calculator", color: "#c2410c" });
		assert.deepEqual(matchSubject(rules, "MUSIC THEORY"), { icon: "fa-solid fa-music", color: "rgb(190, 24, 93)" });
		assert.deepEqual(matchSubject(rules, "World HISTORY"), { icon: "iconoir-globe", color: "#15803d" });
	});

	it("returns nulls when nothing matches, and for bad input", () => {
		const none = { icon: null, color: null };
		assert.deepEqual(matchSubject(rules, "Woodworking"), none);
		assert.deepEqual(matchSubject(rules, ""), none);
		assert.deepEqual(matchSubject(rules, undefined), none);
		assert.deepEqual(matchSubject([], "Science"), none);
		assert.deepEqual(matchSubject(null, "Science"), none);
	});

	it("is first match in key order, not longest match", () => {
		const ordered = buildSubjectRules({ Art: "fa-solid fa-palette", "Art History": "iconoir-globe" }, {});
		assert.equal(matchSubject(ordered.rules, "Art History").icon, "fa-solid fa-palette");
		const reversed = buildSubjectRules({ "Art History": "iconoir-globe", Art: "fa-solid fa-palette" }, {});
		assert.equal(matchSubject(reversed.rules, "Art History").icon, "iconoir-globe");
		assert.equal(matchSubject(reversed.rules, "Art Studio").icon, "fa-solid fa-palette");
	});

	it("matches keys case-insensitively in either direction", () => {
		const lower = buildSubjectRules({ science: "fas fa-dna" }, {});
		assert.equal(matchSubject(lower.rules, "SCIENCE 7").icon, "fas fa-dna");
		const upper = buildSubjectRules({ SCIENCE: "fas fa-dna" }, {});
		assert.equal(matchSubject(upper.rules, "science 7").icon, "fas fa-dna");
	});

	it("takes the colour from the first matching colour key, whatever the icon key was", () => {
		const iconOnly = buildSubjectRules({ Science: "fas fa-dna" }, {});
		assert.deepEqual(matchSubject(iconOnly.rules, "Science"), { icon: "fas fa-dna", color: null });
		// MyAgenda's loop over keywordColors overrides the colour found under the icon key
		const override = buildSubjectRules(
			{ Science: "fas fa-flask", "Physical Science": "fas fa-atom" },
			{ "Physical Science": "#ef4444", Science: "#1569a0" }
		);
		assert.deepEqual(matchSubject(override.rules, "Physical Science"), { icon: "fas fa-flask", color: "#ef4444" });
		assert.deepEqual(matchSubject(override.rules, "Science 7"), { icon: "fas fa-flask", color: "#1569a0" });
		const first = buildSubjectRules({ Sci: "fas fa-dna", Science: "fas fa-flask" }, { Science: "#1569a0" });
		assert.deepEqual(matchSubject(first.rules, "Science"), { icon: "fas fa-dna", color: "#1569a0" });
	});
	it("supports colour-only keys, tried after all icon keys", () => {
		const mixed = buildSubjectRules(
			{ Math: "fa-solid fa-calculator" },
			{ Gym: "#0e7490", Math: "#c2410c", PE: "teal" }
		);
		assert.deepEqual(matchSubject(mixed.rules, "Gym 6"), { icon: null, color: "#0e7490" });
		assert.deepEqual(
			matchSubject(mixed.rules, "PE and Math"),
			{ icon: "fa-solid fa-calculator", color: "#c2410c" },
			"icon keys come first"
		);
		assert.deepEqual(matchSubject(mixed.rules, "pe"), { icon: null, color: "teal" });
	});

	it("drops invalid entries with one warning per option and keeps the rest", () => {
		const result = buildSubjectRules(
			{ Science: "fas fa-dna", Math: 'fa" onclick="x', Art: "<script>", English: 7 },
			{ Science: "#1569a0", Math: "url(http://x.example)", Art: "red;x:y" }
		);
		assert.equal(result.warnings.length, 2);
		assert.ok(result.warnings.some((w) => /subjectIcons.*3 invalid entries were dropped/.test(w)));
		assert.ok(result.warnings.some((w) => /subjectColors.*2 invalid entries were dropped/.test(w)));
		assert.deepEqual(matchSubject(result.rules, "Science"), { icon: "fas fa-dna", color: "#1569a0" });
		for (const name of ["Math", "Art", "English"])
			assert.deepEqual(matchSubject(result.rules, name), { icon: null, color: null }, name);
		for (const warning of result.warnings)
			assert.ok(!/onclick|script|url\(/.test(warning), "warnings never echo values");
	});

	it("ignores options that are not objects, with a warning", () => {
		for (const bad of ["Science", ["Science"], 5, true]) {
			const result = buildSubjectRules(bad, bad);
			assert.deepEqual(result.rules, { icons: [], colors: [] });
			assert.equal(result.warnings.length, 2);
		}
		assert.deepEqual(buildSubjectRules(undefined, null), { rules: { icons: [], colors: [] }, warnings: [] });
	});
	it("skips empty and oversized keys and caps the number of rules", () => {
		const many = {};
		for (let i = 0; i < 150; i += 1) many[`subject${i}`] = "fa-solid fa-book";
		many[""] = "fa-solid fa-book";
		many["x".repeat(81)] = "fa-solid fa-book";
		assert.equal(buildSubjectRules(many, {}).rules.icons.length, 100);
		assert.equal(buildSubjectRules({ "": "fa-solid fa-book" }, { "": "red" }).rules.icons.length, 0);
		assert.equal(buildSubjectRules({ "": "fa-solid fa-book" }, { "": "red" }).rules.colors.length, 0);
	});

	it("does not trim keys: a padded key matches only where the padding is present", () => {
		const padded = buildSubjectRules({ " Art ": "fa-solid fa-palette" }, { " Art ": "#db2777" });
		assert.deepEqual(matchSubject(padded.rules, "Pop Art Studio"), {
			icon: "fa-solid fa-palette",
			color: "#db2777"
		});
		assert.deepEqual(matchSubject(padded.rules, "Art"), { icon: null, color: null });
		assert.deepEqual(matchSubject(padded.rules, "Smart Phones"), { icon: null, color: null });
	});

	it("keeps JavaScript key order, so integer-like keys come first", () => {
		const numeric = buildSubjectRules(
			{ Science: "fas fa-dna", 101: "fa-solid fa-1", 7: "fa-solid fa-7" },
			{ Science: "#1569a0", 101: "#111111", 7: "#777777" }
		);
		// order is 7, 101, Science
		assert.equal(matchSubject(numeric.rules, "Course 101: Intro").icon, "fa-solid fa-1");
		assert.equal(matchSubject(numeric.rules, "Period 7 Science").icon, "fa-solid fa-7");
		assert.equal(matchSubject(numeric.rules, "Period 7 Science").color, "#777777");
		assert.equal(matchSubject(numeric.rules, "Science").color, "#1569a0");
	});

	it("matches colour keys independently of icon keys", () => {
		const both = buildSubjectRules({ Biology: "fas fa-dna" }, { Lab: "#16a34a" });
		assert.deepEqual(matchSubject(both.rules, "Biology Lab"), { icon: "fas fa-dna", color: "#16a34a" });
		assert.deepEqual(matchSubject(both.rules, "Biology"), { icon: "fas fa-dna", color: null });
		assert.deepEqual(matchSubject(both.rules, "Chem Lab"), { icon: null, color: "#16a34a" });
	});

	it("strips Font Awesome animation classes, keeps the rest, and counts them in one warning", () => {
		const result = buildSubjectRules(
			{
				Science: "fa-solid fa-dna fa-spin",
				Math: "fas fa-calculator fa-beat-fade fa-Shake",
				Art: "fa-spin fa-pulse",
				Music: "fa-solid fa-music"
			},
			{}
		);
		assert.deepEqual(matchSubject(result.rules, "Science").icon, "fa-solid fa-dna");
		assert.deepEqual(matchSubject(result.rules, "Math").icon, "fas fa-calculator");
		assert.deepEqual(matchSubject(result.rules, "Art").icon, null, "nothing left after stripping");
		assert.deepEqual(matchSubject(result.rules, "Music").icon, "fa-solid fa-music");
		assert.equal(result.warnings.length, 1);
		assert.match(result.warnings[0], /subjectIcons/);
		assert.match(result.warnings[0], /5 animation classes were removed/);
		for (const cls of [
			"fa-spin",
			"fa-spin-pulse",
			"fa-spin-reverse",
			"fa-beat",
			"fa-beat-fade",
			"fa-bounce",
			"fa-fade",
			"fa-flip",
			"fa-shake",
			"fa-pulse"
		]) {
			assert.equal(validIcon(`fa-solid fa-dna ${cls}`), "fa-solid fa-dna", cls);
		}
		assert.equal(validIcon("fa-solid fa-spinner"), "fa-solid fa-spinner", "similar names are kept");
	});

	it("accepts hue units and rejects CSS-wide keywords, the same as the front end", () => {
		assert.equal(validColor("hsl(120deg 50% 40%)"), "hsl(120deg 50% 40%)");
		assert.equal(validColor("hsla(120deg, 50%, 40%, 0.5)"), "hsla(120deg, 50%, 40%, 0.5)");
		for (const word of ["inherit", "initial", "unset", "revert", "transparent", "currentColor"])
			assert.equal(validColor(word), null, word);
	});
});

describe("config integration", () => {
	it("exposes hideUngraded and subjectRules on the normalised config", () => {
		const { cfg, warnings } = normalizeConfig({
			canvasUrl: "https://canvas.example.edu",
			accessToken: "t",
			subjectIcons: ICONS,
			subjectColors: COLORS,
			hideUngraded: true
		});
		assert.deepEqual(warnings, []);
		assert.equal(cfg.hideUngraded, true);
		assert.equal(cfg.subjectRules.icons.length, 5);
		assert.equal(cfg.subjectRules.colors.length, 5);
		assert.equal(makeCfg().hideUngraded, false);
		assert.deepEqual(makeCfg().subjectRules, { icons: [], colors: [] });
	});
	it("warns on invalid subject entries through normalizeConfig", () => {
		const { warnings } = normalizeConfig({
			canvasUrl: "https://canvas.example.edu",
			accessToken: "t",
			subjectIcons: { Math: "bad;icon" }
		});
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /subjectIcons/);
	});

	it("changes the instance signature with the subject options and hideUngraded", () => {
		const sig = (extra) => instanceSignature(makeCfg(extra), "env");
		const base = sig({});
		assert.notEqual(sig({ subjectIcons: { Math: "fa-solid fa-calculator" } }), base);
		assert.notEqual(sig({ subjectColors: { Math: "#c2410c" } }), base);
		assert.notEqual(sig({ hideUngraded: true }), base);
		assert.equal(
			sig({ subjectIcons: { Math: "fa-solid fa-calculator" } }),
			sig({ subjectIcons: { Math: "fa-solid fa-calculator" } })
		);
	});
});

describe("view model", () => {
	const student = loadFixture("observees")[0];
	const courses = loadFixture("courses-student-a").filter((course) => course.id !== "1005");
	const subs = new Map([
		["1001", [...loadFixture("submissions-1001-student-a-p1"), ...loadFixture("submissions-1001-student-a-p2")]],
		["1002", loadFixture("submissions-1002-student-a")],
		["1003", loadFixture("submissions-1003-student-a")],
		["1004", loadFixture("submissions-1004-student-a")]
	]);
	const build = (extra = {}, input = courses) =>
		buildStudentView({
			student,
			courses: input,
			submissionsByCourse: subs,
			failedCourseIds: new Set(),
			missingAssignments: null,
			cfg: makeCfg(extra),
			now: NOW
		});
	// uppercase keys that do not appear verbatim in any output
	const styled = {
		subjectIcons: { ALGEBRA: "fa-solid fa-calculator", BIOLOGY: "fas fa-dna" },
		subjectColors: { ALGEBRA: "#c2410c", BIOLOGY: "#1569a0", ENGLISH: "teal" }
	};

	it("adds icon and colour to courses, missing items and recent grades", () => {
		const view = build({ ...styled, showRecentGrades: 5 });
		const byName = Object.fromEntries(view.courses.map((c) => [c.name, c]));
		assert.deepEqual([byName["Algebra I"].icon, byName["Algebra I"].color], ["fa-solid fa-calculator", "#c2410c"]);
		assert.deepEqual([byName.Biology.icon, byName.Biology.color], ["fas fa-dna", "#1569a0"]);
		assert.deepEqual([byName["English 9"].icon, byName["English 9"].color], [null, "teal"], "colour-only match");
		assert.deepEqual(
			[byName["World History"].icon, byName["World History"].color],
			[null, null],
			"no match gives nulls"
		);
		assert.ok(
			view.missing.every(
				(m) => m.course === "Algebra I" && m.icon === "fa-solid fa-calculator" && m.color === "#c2410c"
			)
		);
		const quiz = view.recent.find((r) => r.name === "Quiz 3");
		assert.deepEqual([quiz.icon, quiz.color], ["fa-solid fa-calculator", "#c2410c"]);
		const vocab = view.recent.find((r) => r.name === "Vocabulary Quiz");
		assert.deepEqual([vocab.icon, vocab.color], [null, "teal"]);
	});

	it("matches the original Canvas name, not the label or the shortened name", () => {
		const view = build({ ...styled, courseLabels: { 1001: "Maths", 1002: "Bio" }, maxCourseNameLength: 8 });
		const first = view.courses[0];
		assert.equal(first.name, "Maths");
		assert.equal(first.icon, "fa-solid fa-calculator");
		assert.equal(view.courses[1].icon, "fas fa-dna");
		assert.equal(view.missing[0].course, "Maths");
		assert.equal(view.missing[0].icon, "fa-solid fa-calculator");
	});

	it("gives every entry null icon and colour when nothing is configured", () => {
		const view = build({ showRecentGrades: 5 });
		for (const entry of [...view.courses, ...view.missing, ...view.recent]) {
			assert.equal(entry.icon, null);
			assert.equal(entry.color, null);
		}
	});

	it("never puts the keys or option names in the payload", () => {
		const view = build({ ...styled, courseLabels: {}, showRecentGrades: 5 });
		const text = JSON.stringify(view);
		for (const secret of [
			"ALGEBRA",
			"BIOLOGY",
			"ENGLISH",
			"subjectIcons",
			"subjectColors",
			"keywordColors",
			"iconMapping",
			"subjectRules"
		]) {
			assert.ok(!text.includes(secret), secret);
		}
	});

	it("hideUngraded omits courses with no grade and no missing work, but keeps ones with missing work", () => {
		// World History (1003) has a hidden grade and no missing work in the fixtures
		const off = build({});
		assert.equal(off.courses.length, 4);
		const on = build({ hideUngraded: true });
		assert.deepEqual(
			on.courses.map((c) => c.name),
			["Algebra I", "Biology", "English 9"]
		);
		assert.equal(on.notice, null);

		// a hidden-grade course that has missing work is always kept
		const withMissing = buildStudentView({
			student,
			courses,
			submissionsByCourse: new Map([
				[
					"1003",
					[
						{
							...loadFixture("submissions-1001-student-a-p1")[0],
							assignment: {
								...loadFixture("submissions-1001-student-a-p1")[0].assignment,
								course_id: "1003"
							}
						}
					]
				]
			]),
			failedCourseIds: new Set(),
			missingAssignments: null,
			cfg: makeCfg({ hideUngraded: true }),
			now: NOW
		});
		const history = withMissing.courses.find((c) => c.name === "World History");
		assert.ok(history, "kept because it has missing work");
		assert.equal(history.hidden, true);
		assert.equal(history.missingCount, 1);
	});

	it("hideUngraded does not turn a student with courses into 'no active courses'", () => {
		const onlyHidden = courses.filter((course) => course.id === "1003");
		const view = build({ hideUngraded: true }, onlyHidden);
		assert.deepEqual(view.courses, []);
		assert.equal(view.notice, null);
	});
});
