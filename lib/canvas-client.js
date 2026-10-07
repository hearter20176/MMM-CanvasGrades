"use strict";

// Thin Canvas REST client: Bearer auth, per-request timeout, Link-header pagination restricted to the
// configured origin, error classification and leaky-bucket pacing. Error messages and log lines never
// contain the token, the Authorization header, or a URL with its query string.

const ACCEPT = "application/json+canvas-string-ids";
const PER_PAGE = 100;
const DEFAULT_MAX_PAGES = 50;

class CanvasError extends Error {
	constructor(kind, message, details = {}) {
		super(message);
		this.name = "CanvasError";
		this.kind = kind;
		this.status = details.status || 0;
		this.retryAfterMs = details.retryAfterMs || 0;
	}
}

const noop = () => {};
const noLog = { debug: noop, info: noop, warn: noop, error: noop };

function defaultSleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function pathTemplate(pathname) {
	return pathname.replace(/^\/api\/v1/, "").replace(/\/\d+(?=\/|$)/g, "/:id");
}

function buildQuery(query) {
	const parts = [];
	for (const [key, value] of Object.entries(query || {})) {
		if (value === undefined || value === null) continue;
		if (Array.isArray(value)) {
			for (const entry of value) parts.push(`${key}[]=${encodeURIComponent(String(entry))}`);
		} else {
			parts.push(`${key}=${encodeURIComponent(String(value))}`);
		}
	}
	return parts.join("&");
}

function parseNextLink(header) {
	if (typeof header !== "string") return null;
	for (const part of header.split(/,\s*(?=<)/)) {
		const match = /^\s*<([^>]*)>\s*;(.*)$/.exec(part);
		if (!match) continue;
		const rel = /;?\s*rel\s*=\s*"?([^";]+)"?/i.exec(`;${match[2]}`);
		if (rel && rel[1].toLowerCase().split(/\s+/).includes("next")) return match[1];
	}
	return null;
}

function parseRetryAfter(value) {
	if (typeof value !== "string") return 0;
	const seconds = Number(value.trim());
	return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : 0;
}

function createClient({
	baseUrl,
	token,
	timeoutMs = 20000,
	signal,
	fetchImpl = globalThis.fetch,
	sleep = defaultSleep,
	log = noLog,
	schedule = (fn) => fn()
}) {
	const base = String(baseUrl).replace(/\/+$/, "");
	const origin = new URL(base).origin;

	// One HTTP exchange: fetch, read the body, classify, pace. Runs inside `schedule` so a serial queue can
	// hold the slot until the body has been read and the pacing delay (if any) has elapsed.
	async function exchange(url, label) {
		if (signal && signal.aborted) throw new CanvasError("aborted", "Request aborted");
		const timeoutSignal = AbortSignal.timeout(timeoutMs);
		const combined =
			signal && typeof AbortSignal.any === "function" ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal;
		let status;
		let headers;
		let text = "";
		try {
			const response = await fetchImpl(url, {
				method: "GET",
				headers: { Authorization: `Bearer ${token}`, Accept: ACCEPT },
				redirect: "manual",
				signal: combined
			});
			status = response.status;
			headers = response.headers;
			try {
				text = await response.text();
			} catch (err) {
				if (status >= 200 && status < 300) throw err;
			}
		} catch (err) {
			if (signal && signal.aborted) throw new CanvasError("aborted", "Request aborted");
			if (timeoutSignal.aborted) throw new CanvasError("timeout", `Canvas request timed out (${label})`);
			throw new CanvasError(
				"network",
				`Canvas request failed (${label}, ${err && err.name ? err.name : "error"})`
			);
		}
		log.debug(`${label} -> ${status}`);

		const header = (name) => (headers && typeof headers.get === "function" ? headers.get(name) : null);
		const detail = { status };
		if (status >= 300 && status < 400) {
			log.warn("Canvas answered with a redirect; check that canvasUrl is the final https address");
			throw new CanvasError("bad_response", `Unexpected redirect (${label})`, detail);
		}
		if (status === 401) {
			if (header("www-authenticate"))
				throw new CanvasError("auth", `Canvas rejected the access token (${label})`, detail);
			throw new CanvasError("forbidden", `Canvas denied access (${label})`, detail);
		}
		if (status === 429 || (status === 403 && /rate limit exceeded/i.test(text))) {
			throw new CanvasError("throttled", `Canvas rate limit hit (${label})`, {
				status,
				retryAfterMs: parseRetryAfter(header("retry-after"))
			});
		}
		if (status === 403) throw new CanvasError("forbidden", `Canvas denied access (${label})`, detail);
		if (status === 404) throw new CanvasError("not_found", `Canvas resource not found (${label})`, detail);
		if (status >= 500) throw new CanvasError("server", `Canvas server error ${status} (${label})`, detail);
		if (status < 200 || status >= 300)
			throw new CanvasError("bad_response", `Unexpected status ${status} (${label})`, detail);

		let data;
		try {
			data = JSON.parse(text.replace(/^\s*while\(1\);\s*/, ""));
		} catch {
			throw new CanvasError("bad_response", `Canvas returned malformed JSON (${label})`, detail);
		}

		const cost = header("x-request-cost");
		const remainingHeader = header("x-rate-limit-remaining");
		if (cost !== null || remainingHeader !== null) log.debug(`cost ${cost} remaining ${remainingHeader}`);
		const remaining = remainingHeader === null || remainingHeader === undefined ? NaN : parseFloat(remainingHeader);
		if (Number.isFinite(remaining)) {
			if (remaining < 50) await sleep(5000);
			else if (remaining < 100) await sleep(2000);
		}
		return { data, next: parseNextLink(header("link")) };
	}

	function request(url, label) {
		return schedule(() => exchange(url, label));
	}

	async function get(path, query) {
		const qs = buildQuery(query);
		const url = `${base}/api/v1${path}${qs ? `?${qs}` : ""}`;
		const page = await request(url, `GET ${pathTemplate(`/api/v1${path}`)}`);
		return page.data;
	}

	async function getAll(path, query, { maxPages = DEFAULT_MAX_PAGES } = {}) {
		const qs = buildQuery({ ...(query || {}), per_page: PER_PAGE });
		let url = `${base}/api/v1${path}?${qs}`;
		const items = [];
		let pages = 0;
		while (url) {
			const label = `GET ${pathTemplate(new URL(url).pathname)}`;
			const page = await request(url, label);
			if (!Array.isArray(page.data)) throw new CanvasError("bad_response", `Expected a list (${label})`);
			items.push(...page.data);
			pages += 1;
			if (!page.next) break;
			let nextUrl;
			try {
				nextUrl = new URL(page.next, base);
			} catch {
				log.warn("pagination link could not be parsed and was ignored");
				break;
			}
			if (nextUrl.origin !== origin) {
				log.warn("pagination link to another origin ignored");
				break;
			}
			if (pages >= maxPages) {
				log.warn(`pagination stopped at ${maxPages} pages`);
				break;
			}
			url = nextUrl.href;
		}
		return items;
	}

	return { get, getAll };
}

module.exports = { createClient, CanvasError, parseNextLink, buildQuery, ACCEPT };
