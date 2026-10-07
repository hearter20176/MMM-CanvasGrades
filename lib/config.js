"use strict";

// Config normalisation, token resolution, quiet-hours arithmetic and the instance signature.
// Warnings never contain the value of canvasUrl, accessToken or accessTokenFile.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { cleanText } = require("./grades");
const { buildSubjectRules } = require("./subjects");

const ENUMS = {
	nameDisplay: ["full", "short", "initials", "none"],
	gradeDisplay: ["auto", "letter", "percent", "both"],
	scoreType: ["current", "final"],
	gradingPeriod: ["current", "all"],
	assignmentScoreDisplay: ["auto", "points", "percent", "letter"]
};

const DEFAULTS = {
	canvasUrl: "",
	accessToken: "",
	accessTokenFile: "",
	students: [],
	studentLabels: {},
	nameDisplay: "short",
	courses: [],
	excludeCourses: [],
	courseLabels: {},
	maxCourseNameLength: 24,
	gradeDisplay: "auto",
	scoreType: "current",
	gradingPeriod: "current",
	showCourseGrades: true,
	showMissing: true,
	maxMissing: 8,
	missingLookbackDays: 30,
	inferMissing: true,
	showRecentGrades: 0,
	recentGradesDays: 7,
	assignmentScoreDisplay: "auto",
	updateInterval: 1800000,
	requestTimeout: 20000,
	staleAfter: 0,
	pauseBetween: null,
	cache: false,
	hideUngraded: false,
	subjectIcons: {},
	subjectColors: {},
	locale: ""
};

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const TOKEN_PATTERN = /^[\x21-\x7e]+$/;
const MAX_LABELS = 200;

function sha256(text) {
	return crypto.createHash("sha256").update(String(text)).digest("hex");
}

function normalizeUrl(value) {
	if (typeof value !== "string" || value.trim() === "") return "";
	let url;
	try {
		url = new URL(value.trim());
	} catch {
		return "";
	}
	if (url.protocol !== "https:" || url.username || url.password) return "";
	let pathname = url.pathname.replace(/\/+$/, "");
	pathname = pathname.replace(/\/api\/v1$/, "").replace(/\/+$/, "");
	return url.origin + pathname;
}

function normalizeConfig(raw) {
	const input = raw !== null && typeof raw === "object" ? raw : {};
	const warnings = [];
	const warn = (option, fallback) => {
		warnings.push(`Option "${option}" is invalid; using ${JSON.stringify(fallback)}.`);
	};

	const enumOption = (name) => {
		const value = input[name];
		if (value === undefined) return DEFAULTS[name];
		if (ENUMS[name].includes(value)) return value;
		warn(name, DEFAULTS[name]);
		return DEFAULTS[name];
	};
	const intOption = (name, min, max) => {
		const value = input[name];
		if (value === undefined) return DEFAULTS[name];
		let number = NaN;
		if (typeof value === "number") number = value;
		else if (typeof value === "string" && value.trim() !== "") number = Number(value);
		if (!Number.isFinite(number)) {
			warn(name, DEFAULTS[name]);
			return DEFAULTS[name];
		}
		return Math.min(max, Math.max(min, Math.round(number)));
	};
	const boolOption = (name) => {
		const value = input[name];
		if (value === undefined) return DEFAULTS[name];
		if (value === true || value === "true" || value === 1) return true;
		if (value === false || value === "false" || value === 0) return false;
		warn(name, DEFAULTS[name]);
		return DEFAULTS[name];
	};
	const stringOption = (name) => (typeof input[name] === "string" ? input[name].trim() : "");
	const idListOption = (name) => {
		let value = input[name];
		if (value === undefined || value === null) return [];
		if (typeof value === "string" || typeof value === "number") value = [value];
		if (!Array.isArray(value)) {
			warn(name, []);
			return [];
		}
		const ids = [];
		for (const entry of value) {
			if (typeof entry !== "string" && typeof entry !== "number") continue;
			const id = String(entry).trim();
			if (id && !ids.includes(id)) ids.push(id);
		}
		return ids;
	};
	const labelOption = (name) => {
		const value = input[name];
		if (value === undefined || value === null) return {};
		if (typeof value !== "object" || Array.isArray(value)) {
			warn(name, {});
			return {};
		}
		const labels = {};
		for (const [key, label] of Object.entries(value).slice(0, MAX_LABELS)) {
			const text = cleanText(label, 40);
			if (key.trim() && text) labels[key.trim()] = text;
		}
		return labels;
	};

	const cfg = {
		canvasUrl: normalizeUrl(input.canvasUrl),
		accessToken: stringOption("accessToken"),
		accessTokenFile: stringOption("accessTokenFile"),
		students: idListOption("students"),
		studentLabels: labelOption("studentLabels"),
		nameDisplay: enumOption("nameDisplay"),
		courses: idListOption("courses"),
		excludeCourses: idListOption("excludeCourses"),
		courseLabels: labelOption("courseLabels"),
		maxCourseNameLength: intOption("maxCourseNameLength", 8, 80),
		gradeDisplay: enumOption("gradeDisplay"),
		scoreType: enumOption("scoreType"),
		gradingPeriod: enumOption("gradingPeriod"),
		showCourseGrades: boolOption("showCourseGrades"),
		showMissing: boolOption("showMissing"),
		maxMissing: intOption("maxMissing", 1, 30),
		missingLookbackDays: intOption("missingLookbackDays", 0, 365),
		inferMissing: boolOption("inferMissing"),
		showRecentGrades: intOption("showRecentGrades", 0, 10),
		recentGradesDays: intOption("recentGradesDays", 1, 60),
		assignmentScoreDisplay: enumOption("assignmentScoreDisplay"),
		updateInterval: intOption("updateInterval", 300000, 86400000),
		requestTimeout: intOption("requestTimeout", 5000, 30000),
		pauseBetween: null,
		cache: boolOption("cache"),
		hideUngraded: boolOption("hideUngraded"),
		subjectRules: { icons: [], colors: [] },
		locale: ""
	};

	const subjects = buildSubjectRules(input.subjectIcons, input.subjectColors);
	cfg.subjectRules = subjects.rules;
	warnings.push(...subjects.warnings);

	// a client-chosen file path is never used for writing; the helper derives the cache path itself
	if (typeof input.cacheFile === "string" && input.cacheFile.trim() !== "") {
		warnings.push('Option "cacheFile" is no longer supported and was ignored; use "cache": true instead.');
	}

	const staleRaw = input.staleAfter;
	let staleAfter = 0;
	if (staleRaw !== undefined) {
		const number =
			typeof staleRaw === "number"
				? staleRaw
				: typeof staleRaw === "string" && staleRaw.trim() !== ""
					? Number(staleRaw)
					: NaN;
		if (Number.isFinite(number)) staleAfter = Math.max(0, Math.round(number));
		else warn("staleAfter", 0);
	}
	cfg.staleAfter = staleAfter === 0 ? 2 * cfg.updateInterval + 300000 : Math.max(staleAfter, cfg.updateInterval);

	const pause = input.pauseBetween;
	if (pause !== undefined && pause !== null && !(Array.isArray(pause) && pause.length === 0)) {
		if (
			Array.isArray(pause) &&
			pause.length === 2 &&
			pause.every((entry) => typeof entry === "string" && TIME_PATTERN.test(entry)) &&
			pause[0] !== pause[1]
		) {
			cfg.pauseBetween = [pause[0], pause[1]];
		} else {
			warn("pauseBetween", null);
		}
	}

	if (typeof input.locale === "string" && input.locale.trim() !== "") {
		try {
			new Intl.NumberFormat(input.locale.trim());
			cfg.locale = input.locale.trim();
		} catch {
			warn("locale", "");
		}
	}
	return { cfg, warnings };
}

function resolvePath(file, rootPath) {
	if (path.isAbsolute(file)) return file;
	return path.resolve(rootPath || global.root_path || process.cwd(), file);
}

// The folder token and cache files must live in: <MagicMirror root>/config. The socket accepts registrations
// from any client, so a path outside it is refused rather than read or written.
function configDir(deps = {}) {
	return deps.configDir || path.join(deps.rootPath || global.root_path || process.cwd(), "config");
}

function realOrSelf(target) {
	try {
		return fs.realpathSync(target);
	} catch {
		return path.resolve(target);
	}
}

// Stable spelling of a path for use as a registry key (symlinks resolved, case folded on Windows).
function canonicalPath(target) {
	const real = realOrSelf(target);
	return process.platform === "win32" ? real.toLowerCase() : real;
}

function isInsideDir(file, dir) {
	const relative = path.relative(realOrSelf(dir), realOrSelf(file));
	return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

// Precedence: accessToken, then accessTokenFile, then CANVAS_ACCESS_TOKEN. A configured token file that
// cannot be read never falls through to the environment variable.
function resolveToken(cfg, deps = {}) {
	const env = deps.env || process.env;
	const fsApi = deps.fs || fs;
	const platform = deps.platform || process.platform;

	if (cfg.accessToken) {
		if (!TOKEN_PATTERN.test(cfg.accessToken))
			return { ok: false, source: "inline", descriptor: "none", error: { kind: "no_token" } };
		return { ok: true, token: cfg.accessToken, source: "inline", descriptor: `inline:${sha256(cfg.accessToken)}` };
	}
	if (cfg.accessTokenFile) {
		const absolute = resolvePath(cfg.accessTokenFile, deps.rootPath);
		const descriptor = `file:${absolute}`;
		const fileError = (code) => ({
			ok: false,
			source: "file",
			descriptor,
			path: absolute,
			error: { kind: "token_file", code, file: path.basename(absolute) }
		});
		if (!isInsideDir(absolute, configDir(deps))) return fileError("OUTSIDE_CONFIG");
		// The config folder also holds other secrets (other modules' API tokens). Only a file named
		// canvas-token or canvas-token-<anything> is ever treated as a Canvas token.
		if (!/^canvas-token/i.test(path.basename(absolute))) return fileError("BAD_NAME");
		let content;
		try {
			content = fsApi.readFileSync(absolute, "utf8");
		} catch (err) {
			return fileError(err && err.code ? String(err.code) : "UNKNOWN");
		}
		const token = String(content).trim();
		if (!token) return fileError("EMPTY");
		if (!TOKEN_PATTERN.test(token)) return fileError("INVALID");
		let loose = false;
		if (platform !== "win32") {
			try {
				loose = (fsApi.statSync(absolute).mode & 0o077) !== 0;
			} catch {
				loose = false;
			}
		}
		return { ok: true, token, source: "file", descriptor, path: absolute, loose };
	}
	const envToken = String(env.CANVAS_ACCESS_TOKEN || "").trim();
	if (envToken && TOKEN_PATTERN.test(envToken))
		return { ok: true, token: envToken, source: "env", descriptor: "env" };
	return { ok: false, source: "none", descriptor: "none", error: { kind: "no_token" } };
}

function toMinutes(time) {
	const [hours, minutes] = time.split(":").map(Number);
	return hours * 60 + minutes;
}

function inQuietHours(pause, date) {
	if (!pause) return false;
	const start = toMinutes(pause[0]);
	const end = toMinutes(pause[1]);
	const minute = date.getHours() * 60 + date.getMinutes();
	return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

function msUntilQuietEnd(pause, date) {
	if (!pause) return 0;
	const end = toMinutes(pause[1]);
	const target = new Date(date.getTime());
	target.setHours(Math.floor(end / 60), end % 60, 0, 0);
	if (target.getTime() <= date.getTime()) target.setDate(target.getDate() + 1);
	return target.getTime() - date.getTime();
}

function instanceSignature(cfg, tokenDescriptor) {
	return sha256(
		JSON.stringify([
			cfg.canvasUrl,
			tokenDescriptor,
			cfg.students,
			cfg.courses,
			cfg.excludeCourses,
			cfg.studentLabels,
			cfg.courseLabels,
			cfg.nameDisplay,
			cfg.maxCourseNameLength,
			cfg.gradeDisplay,
			cfg.scoreType,
			cfg.gradingPeriod,
			cfg.showCourseGrades,
			cfg.showMissing,
			cfg.maxMissing,
			cfg.missingLookbackDays,
			cfg.inferMissing,
			cfg.showRecentGrades,
			cfg.recentGradesDays,
			cfg.assignmentScoreDisplay,
			cfg.updateInterval,
			cfg.requestTimeout,
			cfg.staleAfter,
			cfg.pauseBetween,
			cfg.cache,
			cfg.hideUngraded,
			cfg.subjectRules,
			cfg.locale
		])
	);
}

module.exports = {
	DEFAULTS,
	sha256,
	normalizeConfig,
	resolvePath,
	resolveToken,
	isInsideDir,
	canonicalPath,
	configDir,
	inQuietHours,
	msUntilQuietEnd,
	instanceSignature
};
