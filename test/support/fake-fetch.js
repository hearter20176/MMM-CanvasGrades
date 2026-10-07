"use strict";

// Scripted fetch mock. Routes match on the path below /api/v1 (string equality or RegExp), optionally
// narrowed by a query predicate. A route responds with a spec object, a function returning a spec, or
// an array of specs consumed in order (the last one repeats). A spec is
//   { status = 200, headers = {}, body, hang = false, error }
// where body may be an object (serialised as JSON) or a string. `error` rejects the fetch.

const fs = require("node:fs");
const path = require("node:path");

const FIXTURE_DIR = path.join(__dirname, "..", "fixtures", "canvas");

function loadFixture(name) {
	return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, `${name}.json`), "utf8"));
}

function linkHeader(entries) {
	return Object.entries(entries)
		.map(([rel, url]) => `<${url}>; rel="${rel}"`)
		.join(",");
}

function createFakeFetch() {
	const routes = [];
	const calls = [];
	const unmatched = [];
	let inflight = 0;
	let maxConcurrent = 0;
	const state = { inflight: 0, maxConcurrent: 0 };

	function route(match, response, options = {}) {
		routes.push({ match, response, query: options.query || null, used: 0 });
		return routes[routes.length - 1];
	}

	function matches(entry, pathname, params) {
		const ok = entry.match instanceof RegExp ? entry.match.test(pathname) : entry.match === pathname;
		if (!ok) return false;
		return entry.query ? entry.query(params) : true;
	}

	async function fetchImpl(url, options = {}) {
		const parsed = new URL(url);
		const pathname = parsed.pathname.replace(/^\/api\/v1/, "");
		const params = parsed.searchParams;
		const headers = {};
		for (const [key, value] of Object.entries(options.headers || {})) headers[key.toLowerCase()] = value;
		const call = { url, origin: parsed.origin, path: pathname, params, headers, signal: options.signal, options };
		calls.push(call);

		inflight += 1;
		state.inflight = inflight;
		maxConcurrent = Math.max(maxConcurrent, inflight);
		state.maxConcurrent = maxConcurrent;
		const release = () => {
			inflight -= 1;
			state.inflight = inflight;
		};
		let released = false;
		const releaseOnce = () => {
			if (!released) {
				released = true;
				release();
			}
		};

		try {
			await new Promise((resolve) => setImmediate(resolve));
			if (options.signal && options.signal.aborted)
				throw options.signal.reason || new DOMException("aborted", "AbortError");

			const entry = routes.find((candidate) => matches(candidate, pathname, params));
			let spec;
			if (!entry) {
				unmatched.push(pathname);
				spec = { status: 404, body: { errors: [{ message: "not found" }] } };
			} else {
				let response = entry.response;
				if (Array.isArray(response)) response = response[Math.min(entry.used, response.length - 1)];
				entry.used += 1;
				spec = typeof response === "function" ? response(call) : response;
			}
			call.spec = spec;
			if (spec.error) throw spec.error;
			if (spec.hang) {
				// a ref'd timer keeps the event loop alive while the request hangs (AbortSignal timers are unref'd)
				const keepAlive = setInterval(() => {}, 1000);
				try {
					await new Promise((resolve, reject) => {
						if (!options.signal) return;
						options.signal.addEventListener(
							"abort",
							() => reject(options.signal.reason || new DOMException("aborted", "AbortError")),
							{ once: true }
						);
					});
				} finally {
					clearInterval(keepAlive);
				}
			}
			const status = spec.status === undefined ? 200 : spec.status;
			const text =
				typeof spec.body === "string" ? spec.body : JSON.stringify(spec.body === undefined ? [] : spec.body);
			const map = new Map(
				Object.entries(spec.headers || {}).map(([key, value]) => [key.toLowerCase(), String(value)])
			);
			return {
				status,
				ok: status >= 200 && status < 300,
				headers: { get: (name) => (map.has(name.toLowerCase()) ? map.get(name.toLowerCase()) : null) },
				async text() {
					try {
						await new Promise((resolve) => setImmediate(resolve));
						return text;
					} finally {
						releaseOnce();
					}
				}
			};
		} catch (err) {
			releaseOnce();
			throw err;
		}
	}

	return {
		fetch: fetchImpl,
		route,
		calls,
		unmatched,
		state,
		get maxConcurrent() {
			return maxConcurrent;
		},
		paths: () => calls.map((call) => call.path),
		reset() {
			routes.length = 0;
			calls.length = 0;
			unmatched.length = 0;
			maxConcurrent = 0;
			state.maxConcurrent = 0;
		}
	};
}

// Registers the full happy-path route table for the two fictional students.
function installCanvasFixtures(fake) {
	fake.route("/users/self/observees", { body: loadFixture("observees") });
	fake.route("/users/2001/courses", { body: loadFixture("courses-student-a") });
	fake.route("/users/2002/courses", { body: loadFixture("courses-student-b") });
	fake.route("/users/self/missing_submissions", (call) => ({
		body: call.params.get("observed_user_id") === "2001" ? loadFixture("missing-submissions-student-a") : []
	}));
	fake.route("/courses/1001/students/submissions", (call) => {
		if (call.params.get("student_ids[]") === "2002") return { body: loadFixture("submissions-1001-student-b") };
		const next = new URL(call.url);
		if (call.params.get("page") === "2") return { body: loadFixture("submissions-1001-student-a-p2") };
		next.searchParams.set("page", "2");
		return {
			headers: { Link: linkHeader({ next: next.href }) },
			body: loadFixture("submissions-1001-student-a-p1")
		};
	});
	for (const course of ["1002", "1003", "1004"]) {
		fake.route(`/courses/${course}/students/submissions`, (call) => ({
			body: loadFixture(
				`submissions-${course}-student-${call.params.get("student_ids[]") === "2002" ? "b" : "a"}`
			)
		}));
	}
	return fake;
}

module.exports = { createFakeFetch, installCanvasFixtures, loadFixture, linkHeader };
