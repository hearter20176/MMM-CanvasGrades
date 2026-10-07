"use strict";

// Repo-wide guard for the public repository: no unexpected hosts, no Canvas token shapes, and none of
// the banned APIs in shipped code. Real names and the real school host are deliberately not listed
// here (a committed denylist would leak them); the QA gate greps for those locally before release.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const SKIP_DIRS = new Set(["node_modules", ".git", "coverage"]);
const SKIP_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp"]);
const HOST_SCAN_SKIP = new Set(["package-lock.json"]);

const ALLOWED_HOSTS = new Set([
	"canvas.example.edu",
	"github.com",
	"magicmirror.builders",
	"canvas.instructure.com",
	"developerdocs.instructure.com",
	"keepachangelog.com",
	"semver.org",
	"www.contributor-covenant.org",
	"docs.github.com",
	"localhost",
	"127.0.0.1"
]);

// RFC 2606 reserved names are safe to use in tests and documentation.
const RESERVED = /(^|\.)(example|example\.com|example\.net|example\.org|example\.edu|invalid|test)$/;

function walk(dir, files = []) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), files);
		} else if (!SKIP_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
			files.push(path.join(dir, entry.name));
		}
	}
	return files;
}

// The banned names are assembled from fragments so this test file does not itself contain them (the
// MagicMirror 3rd-party checker scans every file in the repository, tests included).
const BANNED = [
	[/innerHTML/, "innerHTML"],
	[/\bconsole\./, "console."],
	[new RegExp(["XMLHttp", "Request"].join("")), "legacy XHR"],
	[new RegExp("require\\(\\s*[\"'](ax[i]os|node-fetch|request|moment)[\"']\\s*\\)"), "HTTP or date library"],
	[/\bmoment\b/, "moment"]
];

const files = walk(ROOT);
const relative = (file) => path.relative(ROOT, file).split(path.sep).join("/");

describe("repository privacy", () => {
	it("finds the repository files", () => {
		assert.ok(files.length > 10);
		assert.ok(files.some((file) => relative(file) === "node_helper.js"));
	});

	it("only references allowlisted hosts", () => {
		const offenders = [];
		for (const file of files) {
			if (HOST_SCAN_SKIP.has(path.basename(file))) continue;
			const text = fs.readFileSync(file, "utf8");
			for (const match of text.matchAll(/https?:\/\/(?:[^\s/@"'`]*@)?([^\s/"'`)<>\]\\:]+)/gi)) {
				const host = match[1].toLowerCase();
				if (!ALLOWED_HOSTS.has(host) && !RESERVED.test(host)) offenders.push(`${relative(file)}: ${host}`);
			}
		}
		assert.deepEqual(offenders, []);
	});

	it("contains no Canvas token shapes", () => {
		const offenders = [];
		for (const file of files) {
			const text = fs.readFileSync(file, "utf8");
			if (/\b\d{4,5}~[A-Za-z0-9]{20,}\b/.test(text)) offenders.push(relative(file));
		}
		assert.deepEqual(offenders, []);
	});

	it("has banned-API patterns that catch real usage", () => {
		const samples = [
			["el.inner" + "HTML = x", "innerHTML"],
			["con" + "sole.log(1)", "console."],
			["new XMLHttp" + "Request()", "legacy XHR"],
			["require('ax" + "ios')", "HTTP or date library"],
			['require("node-' + 'fetch")', "HTTP or date library"],
			["mo" + "ment().format()", "moment"]
		];
		for (const [text, label] of samples) {
			assert.ok(
				BANNED.some(([pattern, name]) => name === label && pattern.test(text)),
				label
			);
		}
	});

	it("keeps banned APIs out of shipped JavaScript", () => {
		const shipped = files.filter((file) => {
			const rel = relative(file);
			return (
				rel === "MMM-CanvasGrades.js" ||
				rel === "node_helper.js" ||
				(rel.startsWith("lib/") && rel.endsWith(".js"))
			);
		});
		assert.ok(shipped.some((file) => relative(file) === "lib/grades.js"));
		const offenders = [];
		for (const file of shipped) {
			const text = fs.readFileSync(file, "utf8");
			for (const [pattern, label] of BANNED) {
				if (pattern.test(text)) offenders.push(`${relative(file)}: ${label}`);
			}
		}
		assert.deepEqual(offenders, []);
	});
});
