"use strict";

// Pure grade and missing-work logic. Nothing here reads the clock, the network or globals: every
// time-dependent function takes `now` (epoch ms). Inputs are raw Canvas objects and every field
// access is defensive, so one malformed item is skipped and never fatal.

const DAY_MS = 86400000;
const MAX_INPUT_CHARS = 4000;

const segmenter =
	typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;

function graphemes(text) {
	if (segmenter) return Array.from(segmenter.segment(text), (part) => part.segment);
	return Array.from(text);
}

const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(text) {
	return text.replace(
		/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|(amp|lt|gt|quot|apos|nbsp));/g,
		(match, dec, hex, name) => {
			if (name) return NAMED_ENTITIES[name];
			const codePoint = dec !== undefined ? parseInt(dec, 10) : parseInt(hex, 16);
			if (!Number.isInteger(codePoint) || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff))
				return "";
			return String.fromCodePoint(codePoint);
		}
	);
}

function truncate(text, maxLen) {
	const value = typeof text === "string" ? text : "";
	const parts = graphemes(value);
	if (parts.length <= maxLen) return value;
	if (maxLen <= 3) return parts.slice(0, Math.max(0, maxLen)).join("");
	return `${parts.slice(0, maxLen - 3).join("")}...`;
}

function cleanText(value, maxLen = 120) {
	let text;
	if (typeof value === "string") text = value;
	else if (typeof value === "number" && Number.isFinite(value)) text = String(value);
	else return "";
	text = decodeEntities(text.slice(0, MAX_INPUT_CHARS));
	// eslint-disable-next-line no-control-regex
	text = text.replace(/[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/g, "");
	text = text.replace(/\s+/g, " ").trim();
	return truncate(text, maxLen);
}

const formatterCache = new Map();

function getFormatter(locale, maxFractionDigits) {
	const key = `${locale || ""}|${maxFractionDigits}`;
	let formatter = formatterCache.get(key);
	if (!formatter) {
		const options = { maximumFractionDigits: maxFractionDigits, minimumFractionDigits: 0, useGrouping: false };
		try {
			formatter = new Intl.NumberFormat(locale || undefined, options);
		} catch {
			formatter = new Intl.NumberFormat(undefined, options);
		}
		if (formatterCache.size < 50) formatterCache.set(key, formatter);
	}
	return formatter;
}

function formatPercent(n, locale) {
	if (typeof n !== "number" || !Number.isFinite(n)) return "--";
	return `${getFormatter(locale, 1).format(n)}%`;
}

function formatNumber(n, locale) {
	if (typeof n !== "number" || !Number.isFinite(n)) return "--";
	return getFormatter(locale, 2).format(n);
}

function idOf(value) {
	if (value === null || value === undefined) return "";
	if (typeof value === "string" || typeof value === "number") return String(value);
	return "";
}

function isObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteOrNull(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseMs(value) {
	return typeof value === "string" ? Date.parse(value) : NaN;
}

function toIso(ms) {
	return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function lookupMap(map, key) {
	if (!map) return undefined;
	if (map instanceof Map) return map.get(key);
	return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

function toIdSet(value) {
	if (value instanceof Set) return new Set(Array.from(value, idOf));
	if (Array.isArray(value)) return new Set(value.map(idOf));
	return new Set();
}

// ---------------------------------------------------------------------------------------------
// Students

function selectStudents(observees, cfg) {
	const byId = new Map();
	for (const entry of Array.isArray(observees) ? observees : []) {
		if (!isObject(entry)) continue;
		const id = idOf(entry.id);
		if (!id || byId.has(id)) continue;
		byId.set(id, { ...entry, id });
	}
	const wanted = Array.isArray(cfg && cfg.students) ? cfg.students : [];
	if (wanted.length === 0) return { selected: Array.from(byId.values()), notFound: [] };
	const selected = [];
	const notFound = [];
	for (const id of wanted) {
		const user = byId.get(String(id));
		if (user) selected.push(user);
		else notFound.push(String(id));
	}
	return { selected, notFound };
}

// Fallback observee discovery from the observer's own course list (include[]=observed_users).
function observeesFromCourses(courses) {
	const found = new Map();
	const add = (user) => {
		if (!isObject(user)) return;
		const id = idOf(user.id);
		if (id && !found.has(id)) found.set(id, { ...user, id });
	};
	for (const course of Array.isArray(courses) ? courses : []) {
		if (!isObject(course)) continue;
		if (Array.isArray(course.observed_users)) course.observed_users.forEach(add);
		for (const enrollment of Array.isArray(course.enrollments) ? course.enrollments : []) {
			if (!isObject(enrollment)) continue;
			add(enrollment.observed_user);
			const associated = idOf(enrollment.associated_user_id);
			if (associated && !found.has(associated)) found.set(associated, { id: associated });
		}
	}
	return Array.from(found.values());
}

function studentLabel(user, cfg) {
	const id = idOf(user && user.id);
	const labels = (cfg && cfg.studentLabels) || {};
	const custom = cleanText(lookupMap(labels, id), 40);
	if (custom) return custom;
	const name = cleanText(user && user.name, 80);
	const shortName = cleanText(user && user.short_name, 40);
	const words = name.split(" ").filter(Boolean);
	switch (cfg && cfg.nameDisplay) {
		case "none":
			return "";
		case "full":
			return truncate(name || shortName, 40);
		case "initials":
			return words
				.map((word) => `${graphemes(word)[0].toUpperCase()}.`)
				.join("")
				.slice(0, 40);
		case "short":
		default:
			return truncate(shortName || words[0] || "", 40);
	}
}

// ---------------------------------------------------------------------------------------------
// Courses

function selectCourses(courses, cfg) {
	const usable = new Map();
	for (const course of Array.isArray(courses) ? courses : []) {
		if (!isObject(course)) continue;
		const id = idOf(course.id);
		if (!id || usable.has(id)) continue;
		if (course.workflow_state !== "available") continue;
		if (course.access_restricted_by_date === true) continue;
		usable.set(id, course);
	}
	const include = Array.isArray(cfg && cfg.courses) ? cfg.courses.map(String) : [];
	const exclude = new Set(Array.isArray(cfg && cfg.excludeCourses) ? cfg.excludeCourses.map(String) : []);
	let list;
	if (include.length > 0) {
		list = [];
		for (const id of include) {
			if (usable.has(id)) list.push(usable.get(id));
		}
	} else {
		list = Array.from(usable.values());
	}
	return list.filter((course) => !exclude.has(idOf(course.id)));
}

function courseGrade(course, studentId, cfg) {
	const hiddenResult = { gradeText: "--", gradeKind: "none", hidden: true, periodFallback: false, restricted: false };
	if (!isObject(course)) return hiddenResult;
	const sid = idOf(studentId);
	const enrollment = (Array.isArray(course.enrollments) ? course.enrollments : []).find(
		(entry) =>
			isObject(entry) &&
			entry.type === "student" &&
			(entry.user_id === undefined || entry.user_id === null || idOf(entry.user_id) === sid)
	);
	if (!enrollment || course.hide_final_grades === true) return hiddenResult;

	const which = cfg.scoreType === "final" ? "final" : "current";
	const hasPeriods =
		enrollment.has_grading_periods !== undefined ? enrollment.has_grading_periods : course.has_grading_periods;
	let periodFallback = false;
	let scoreKey = `computed_${which}_score`;
	let gradeKey = `computed_${which}_grade`;
	if (cfg.gradingPeriod === "current" && hasPeriods === true) {
		const periodId = enrollment.current_grading_period_id;
		if (periodId !== null && periodId !== undefined) {
			scoreKey = `current_period_computed_${which}_score`;
			gradeKey = `current_period_computed_${which}_grade`;
		} else {
			periodFallback = true;
		}
	}
	const score = finiteOrNull(enrollment[scoreKey]);
	const grade = cleanText(enrollment[gradeKey], 12) || null;
	if (score === null && grade === null) return hiddenResult;

	const restricted = course.restrict_quantitative_data === true || (score === null && grade !== null);
	const base = { hidden: false, periodFallback, restricted };
	const percent = score === null ? null : formatPercent(score, cfg.locale);
	const letter = (text) => ({ gradeText: text, gradeKind: "letter", ...base });
	const pct = (text) => ({ gradeText: text, gradeKind: "percent", ...base });

	if (restricted) return grade === null ? hiddenResult : letter(grade);
	switch (cfg.gradeDisplay) {
		case "letter":
			return grade !== null ? letter(grade) : pct(percent);
		case "percent":
			return percent !== null ? pct(percent) : letter(grade);
		case "both":
			if (grade !== null && percent !== null)
				return { gradeText: `${grade} ${percent}`, gradeKind: "both", ...base };
			return grade !== null ? letter(grade) : pct(percent);
		case "auto":
		default:
			return grade !== null ? letter(grade) : pct(percent);
	}
}

// ---------------------------------------------------------------------------------------------
// Submissions

const NO_INFERENCE_TYPES = ["none", "on_paper", "not_graded"];

function classifySubmission(sub, cfg, now) {
	const ignore = { kind: "ignore", inferred: false };
	if (!isObject(sub)) return ignore;
	const assignment = sub.assignment;
	if (!isObject(assignment)) return ignore;
	if (assignment.published === false) return ignore;
	if (assignment.grading_type === "not_graded") return ignore;
	if (assignment.locked_for_user === true) return ignore;
	if (sub.workflow_state === "deleted") return ignore;
	if (sub.excused === true) return { kind: "excused", inferred: false };

	const dueMs = parseMs(sub.cached_due_date || assignment.due_at);
	const lookbackMs = cfg.missingLookbackDays > 0 ? cfg.missingLookbackDays * DAY_MS : 0;
	const missing = (inferred) => {
		if (lookbackMs > 0 && Number.isFinite(dueMs) && dueMs < now - lookbackMs) return ignore;
		return { kind: "missing", inferred };
	};

	if (
		sub.score !== null &&
		sub.score !== undefined &&
		sub.entered_score !== null &&
		sub.entered_score !== undefined
	) {
		if (sub.workflow_state === "graded") return { kind: "graded", inferred: false };
	}
	if ((sub.missing === true || sub.late_policy_status === "missing") && sub.late_policy_status !== "extended") {
		return missing(false);
	}
	const unscored = sub.score === null || sub.score === undefined;
	if (
		unscored &&
		(sub.posted_at === null || sub.posted_at === undefined) &&
		(sub.workflow_state === "graded" ||
			sub.workflow_state === "pending_review" ||
			(sub.graded_at !== null && sub.graded_at !== undefined))
	) {
		return { kind: "hidden", inferred: false };
	}
	if (!unscored || (sub.grade !== null && sub.grade !== undefined && sub.workflow_state === "graded")) {
		return { kind: "graded", inferred: false };
	}
	if (cfg.inferMissing && sub.late_policy_status !== "extended") {
		const types = Array.isArray(assignment.submission_types) ? assignment.submission_types : [];
		const blocked =
			types.some((type) => NO_INFERENCE_TYPES.includes(type)) ||
			(types.length === 1 && types[0] === "external_tool");
		if (
			sub.workflow_state === "unsubmitted" &&
			(sub.submitted_at === null || sub.submitted_at === undefined) &&
			Number.isFinite(dueMs) &&
			dueMs < now &&
			!blocked
		) {
			return missing(true);
		}
	}
	return { kind: "open", inferred: false };
}

function autoModeFor(gradingType) {
	switch (gradingType) {
		case "percent":
			return "percent";
		case "letter_grade":
		case "gpa_scale":
			return "letter";
		case "pass_fail":
			return "passfail";
		case "points":
		default:
			return "points";
	}
}

function formatScore(sub, assignment, cfg, restricted, kind) {
	if (kind === "hidden") return "Hidden";
	if (kind === "excused") return "EX";
	const s = isObject(sub) ? sub : {};
	const a = isObject(assignment) ? assignment : {};
	const locale = cfg && cfg.locale;
	const score = finiteOrNull(s.score);
	const grade = cleanText(s.grade, 20) || null;
	if (score === null && grade === null) return "--";
	if (restricted) return grade === null ? "--" : grade;

	const pointsPossible = finiteOrNull(a.points_possible);
	const hasPoints = pointsPossible !== null && pointsPossible > 0;
	const autoMode = autoModeFor(a.grading_type);
	const render = (mode) => {
		switch (mode) {
			case "percent":
				if (hasPoints && score !== null) return formatPercent((score / pointsPossible) * 100, locale);
				return grade === null ? "--" : grade;
			case "letter":
				return grade === null ? "--" : grade;
			case "passfail": {
				const lower = grade === null ? "" : grade.toLowerCase();
				if (lower === "complete" || lower === "pass") return "Complete";
				if (lower === "incomplete" || lower === "fail") return "Incomplete";
				return "--";
			}
			case "points":
			default:
				if (score === null) return grade === null ? "--" : grade;
				if (hasPoints) return `${formatNumber(score, locale)} / ${formatNumber(pointsPossible, locale)}`;
				return grade === null ? formatNumber(score, locale) : grade;
		}
	};
	const mode =
		cfg && cfg.assignmentScoreDisplay && cfg.assignmentScoreDisplay !== "auto"
			? cfg.assignmentScoreDisplay
			: autoMode;
	if (mode === "letter" && grade !== null && Number.isNaN(Number(grade))) return grade;
	if (mode === "letter") return render(autoMode === "letter" ? "letter" : autoMode);
	return render(mode);
}

function pointsText(points) {
	if (typeof points !== "number" || !Number.isFinite(points)) return "";
	if (points === 1) return "1 pt";
	if (points > 1) return `${getFormatter(undefined, 2).format(points)} pts`;
	return "";
}

function missingItemFromSubmission(sub, courseId, inferred) {
	const assignment = sub.assignment;
	const dueMs = parseMs(sub.cached_due_date || assignment.due_at);
	return {
		assignmentId: idOf(assignment.id !== undefined ? assignment.id : sub.assignment_id),
		courseId,
		name: cleanText(assignment.name, 120) || "Untitled",
		dueMs,
		points: finiteOrNull(assignment.points_possible),
		inferred
	};
}

// A Canvas missing_submissions entry is an Assignment object (not a Submission).
function missingItemFromAssignment(assignment, cfg, now) {
	if (!isObject(assignment)) return null;
	if (assignment.published === false || assignment.grading_type === "not_graded") return null;
	if (assignment.locked_for_user === true) return null;
	const dueMs = parseMs(assignment.due_at);
	const lookbackMs = cfg.missingLookbackDays > 0 ? cfg.missingLookbackDays * DAY_MS : 0;
	if (lookbackMs > 0 && Number.isFinite(dueMs) && dueMs < now - lookbackMs) return null;
	return {
		assignmentId: idOf(assignment.id),
		courseId: idOf(
			assignment.course_id !== undefined
				? assignment.course_id
				: isObject(assignment.course) && assignment.course.id
		),
		name: cleanText(assignment.name, 120) || "Untitled",
		dueMs,
		points: finiteOrNull(assignment.points_possible),
		inferred: false
	};
}

function mergeMissing(fromSubmissions, fromEndpoint, resolvedAssignmentIds) {
	const merged = new Map();
	for (const item of Array.isArray(fromSubmissions) ? fromSubmissions : []) {
		if (item && !merged.has(item.assignmentId)) merged.set(item.assignmentId, { ...item });
	}
	const resolved = toIdSet(resolvedAssignmentIds);
	for (const item of Array.isArray(fromEndpoint) ? fromEndpoint : []) {
		if (!item || resolved.has(item.assignmentId)) continue;
		const existing = merged.get(item.assignmentId);
		if (existing) {
			// the endpoint confirms Canvas considers it missing, so it is no longer only inferred
			existing.inferred = existing.inferred && item.inferred;
		} else {
			merged.set(item.assignmentId, { ...item });
		}
	}
	return Array.from(merged.values());
}

function compareMissing(a, b) {
	const aKnown = Number.isFinite(a.dueMs);
	const bKnown = Number.isFinite(b.dueMs);
	if (aKnown && bKnown && a.dueMs !== b.dueMs) return a.dueMs - b.dueMs;
	if (aKnown !== bKnown) return aKnown ? -1 : 1;
	return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

// ---------------------------------------------------------------------------------------------
// View model

function buildStudentView({ student, courses, submissionsByCourse, failedCourseIds, missingAssignments, cfg, now }) {
	const courseList = Array.isArray(courses) ? courses.filter(isObject) : [];
	const failed = toIdSet(failedCourseIds);
	const studentId = idOf(student && student.id);
	const courseLabels = cfg.courseLabels || {};

	const fullName = new Map();
	const shortName = new Map();
	const restrictedByCourse = new Map();
	const grades = new Map();
	for (const course of courseList) {
		const id = idOf(course.id);
		const custom = cleanText(lookupMap(courseLabels, id), 40);
		const canvasName = cleanText(course.name, 200) || cleanText(course.course_code, 200) || "Course";
		fullName.set(id, truncate(custom || canvasName, cfg.maxCourseNameLength));
		shortName.set(id, custom ? truncate(custom, 16) : truncate(canvasName, 16));
		const grade = courseGrade(course, studentId, cfg);
		grades.set(id, grade);
		restrictedByCourse.set(id, grade.restricted);
	}

	const fromSubmissions = [];
	const recentCandidates = [];
	const resolved = new Set();
	for (const course of courseList) {
		const courseId = idOf(course.id);
		const subs = lookupMap(submissionsByCourse, courseId);
		if (!Array.isArray(subs)) continue;
		for (const sub of subs) {
			try {
				const result = classifySubmission(sub, cfg, now);
				const assignmentId = idOf(sub.assignment && sub.assignment.id);
				if (result.kind === "missing") {
					fromSubmissions.push(missingItemFromSubmission(sub, courseId, result.inferred));
				} else if (result.kind === "graded" || result.kind === "excused") {
					resolved.add(assignmentId);
				}
				if (
					cfg.showRecentGrades > 0 &&
					(result.kind === "graded" ||
						((result.kind === "hidden" || result.kind === "excused") &&
							sub.graded_at !== null &&
							sub.graded_at !== undefined))
				) {
					const gradedMs = parseMs(sub.posted_at || sub.graded_at);
					if (Number.isFinite(gradedMs) && gradedMs >= now - cfg.recentGradesDays * DAY_MS) {
						recentCandidates.push({
							gradedMs,
							item: {
								name: cleanText(sub.assignment.name, 120) || "Untitled",
								course: shortName.get(courseId) || "",
								scoreText: formatScore(
									sub,
									sub.assignment,
									cfg,
									restrictedByCourse.get(courseId) === true,
									result.kind
								),
								late: sub.late === true,
								excused: result.kind === "excused",
								hidden: result.kind === "hidden",
								gradedAt: toIso(gradedMs)
							}
						});
					}
				}
			} catch {
				// a malformed submission is skipped
			}
		}
	}

	let fromEndpoint = null;
	if (Array.isArray(missingAssignments)) {
		const known = new Set(courseList.map((course) => idOf(course.id)));
		fromEndpoint = missingAssignments
			.map((assignment) => missingItemFromAssignment(assignment, cfg, now))
			.filter((item) => item !== null && known.has(item.courseId));
	}
	const merged = mergeMissing(fromSubmissions, fromEndpoint, resolved).sort(compareMissing);

	const countByCourse = new Map();
	for (const item of merged) countByCourse.set(item.courseId, (countByCourse.get(item.courseId) || 0) + 1);

	const courseViews = cfg.showCourseGrades
		? courseList.map((course) => {
				const id = idOf(course.id);
				const grade = grades.get(id);
				return {
					name: fullName.get(id),
					gradeText: grade.gradeText,
					gradeKind: grade.gradeKind,
					hidden: grade.hidden,
					periodFallback: grade.periodFallback,
					missingCount: countByCourse.get(id) || 0,
					failed: failed.has(id)
				};
			})
		: [];

	const missingViews = cfg.showMissing
		? merged.slice(0, cfg.maxMissing).map((item) => ({
				name: item.name,
				course: shortName.get(item.courseId) || "",
				dueAt: toIso(item.dueMs),
				pointsText: pointsText(item.points),
				inferred: item.inferred
			}))
		: [];

	const recentViews =
		cfg.showRecentGrades > 0
			? recentCandidates
					.sort((a, b) => b.gradedMs - a.gradedMs)
					.slice(0, cfg.showRecentGrades)
					.map((entry) => entry.item)
			: [];

	return {
		label: studentLabel(student, cfg),
		notice: courseList.length === 0 ? "no_courses" : null,
		courses: courseViews,
		missing: missingViews,
		missingTotal: cfg.showMissing ? merged.length : 0,
		recent: recentViews
	};
}

module.exports = {
	cleanText,
	truncate,
	formatPercent,
	formatNumber,
	selectStudents,
	observeesFromCourses,
	studentLabel,
	selectCourses,
	courseGrade,
	classifySubmission,
	formatScore,
	mergeMissing,
	missingItemFromSubmission,
	missingItemFromAssignment,
	buildStudentView
};
