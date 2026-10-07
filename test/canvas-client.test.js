"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { createFakeFetch, linkHeader } = require("./support/fake-fetch");
const { createClient, CanvasError, parseNextLink } = require("../lib/canvas-client");

const TOKEN = "test-token-DO-NOT-USE-0000";
const BASE = "https://canvas.example.edu";

function setup(options = {}) {
	const fake = createFakeFetch();
	const logs = [];
	const sleeps = [];
	const log = {};
	for (const level of ["debug", "info", "warn", "error"]) log[level] = (message) => logs.push({ level, message });
	const client = createClient({
		baseUrl: BASE,
		token: TOKEN,
		timeoutMs: 2000,
		fetchImpl: fake.fetch,
		sleep: async (ms) => {
			sleeps.push(ms);
		},
		log,
		...options
	});
	return { fake, client, logs, sleeps };
}

async function failure(promise) {
	try {
		await promise;
	} catch (err) {
		return err;
	}
	assert.fail("expected a rejection");
	return null;
}

describe("requests", () => {
	it("sends Bearer auth and the string-ids Accept header on every call, never access_token", async () => {
		const { fake, client } = setup();
		fake.route(/.*/, { body: [] });
		await client.get("/users/self/observees");
		await client.getAll("/courses", { include: ["a", "b"] });
		assert.equal(fake.calls.length, 2);
		for (const call of fake.calls) {
			assert.equal(call.headers.authorization, `Bearer ${TOKEN}`);
			assert.equal(call.headers.accept, "application/json+canvas-string-ids");
			assert.ok(!call.url.includes("access_token"));
			assert.ok(!call.url.includes(TOKEN));
			assert.equal(call.origin, BASE);
		}
	});

	it("serialises arrays as repeated key[] params and adds per_page=100 to getAll", async () => {
		const { fake, client } = setup();
		fake.route(/.*/, { body: [] });
		await client.getAll("/users/2001/courses", { include: ["total_scores", "term"], enrollment_state: "active" });
		const { params } = fake.calls[0];
		assert.deepEqual(params.getAll("include[]"), ["total_scores", "term"]);
		assert.equal(params.get("enrollment_state"), "active");
		assert.equal(params.get("per_page"), "100");
	});

	it("keeps a path prefix in the base URL", async () => {
		const fake = createFakeFetch();
		fake.route(/.*/, { body: [] });
		const client = createClient({ baseUrl: `${BASE}/lms`, token: TOKEN, fetchImpl: fake.fetch });
		await client.get("/users/self/observees");
		assert.equal(new URL(fake.calls[0].url).pathname, "/lms/api/v1/users/self/observees");
	});
});

describe("pagination", () => {
	const pages = (fake, count, extra = {}) => {
		fake.route("/courses", (call) => {
			const page = Number(call.params.get("page") || 1);
			const headers = {};
			if (page < count) {
				const next = new URL(call.url);
				next.searchParams.set("page", String(page + 1));
				headers.Link = linkHeader({ current: call.url, next: next.href, last: call.url });
			}
			return { headers: { ...headers, ...(extra.headers || {}) }, body: [{ id: String(page) }] };
		});
	};

	it("follows next links in order across three pages", async () => {
		const { fake, client } = setup();
		pages(fake, 3);
		const items = await client.getAll("/courses");
		assert.deepEqual(
			items.map((item) => item.id),
			["1", "2", "3"]
		);
		assert.equal(fake.calls.length, 3);
	});

	it("stops when there is no rel=next", async () => {
		const { fake, client } = setup();
		fake.route("/courses", {
			headers: { Link: linkHeader({ first: `${BASE}/x`, last: `${BASE}/x` }) },
			body: [{ id: "1" }]
		});
		assert.equal((await client.getAll("/courses")).length, 1);
		assert.equal(fake.calls.length, 1);
	});

	it("does not follow a next link to another origin and logs a warning without the URL", async () => {
		const { fake, client, logs } = setup();
		fake.route("/courses", {
			headers: { Link: linkHeader({ next: "https://evil.example.net/api/v1/courses?page=2" }) },
			body: [{ id: "1" }]
		});
		const items = await client.getAll("/courses");
		assert.equal(items.length, 1);
		assert.equal(fake.calls.length, 1);
		assert.ok(fake.calls.every((call) => call.origin === BASE));
		const warn = logs.find((entry) => entry.level === "warn");
		assert.match(warn.message, /another origin/);
		assert.ok(!warn.message.includes("evil"));
	});

	it("caps at maxPages with a warning", async () => {
		const { fake, client, logs } = setup();
		pages(fake, 500);
		const items = await client.getAll("/courses", {}, { maxPages: 50 });
		assert.equal(items.length, 50);
		assert.equal(fake.calls.length, 50);
		assert.ok(logs.some((entry) => entry.level === "warn" && /50 pages/.test(entry.message)));
	});

	it("parses Link header case and spacing variants", () => {
		assert.equal(parseNextLink('<https://a.example/x?page=2>; rel="next"'), "https://a.example/x?page=2");
		assert.equal(
			parseNextLink('<https://a.example/x?page=2>;REL=next, <https://a.example/x?page=9>; rel="last"'),
			"https://a.example/x?page=2"
		);
		assert.equal(
			parseNextLink('<https://a.example/x?page=1>; rel="current",<https://a.example/x?page=2>; rel="next"'),
			"https://a.example/x?page=2"
		);
		assert.equal(parseNextLink('<https://a.example/x>; rel="prev"'), null);
		assert.equal(parseNextLink(null), null);
	});

	it("reads the Link header regardless of header-name case", async () => {
		const { fake, client } = setup();
		let served = 0;
		fake.route("/courses", () => {
			served += 1;
			return served === 1
				? { headers: { LINK: linkHeader({ next: `${BASE}/api/v1/courses?page=2` }) }, body: [{ id: "1" }] }
				: { body: [{ id: "2" }] };
		});
		assert.equal((await client.getAll("/courses")).length, 2);
	});
});

describe("response parsing", () => {
	it("strips a while(1); prefix", async () => {
		const { fake, client } = setup();
		fake.route("/x", { body: 'while(1);{"ok":true}' });
		assert.deepEqual(await client.get("/x"), { ok: true });
	});

	it("maps malformed JSON and non-array pages to bad_response", async () => {
		const { fake, client } = setup();
		fake.route("/broken", { body: "<html>nope" });
		fake.route("/object", { body: { not: "a list" } });
		assert.equal((await failure(client.get("/broken"))).kind, "bad_response");
		assert.equal((await failure(client.getAll("/object"))).kind, "bad_response");
	});

	it("treats a redirect as bad_response", async () => {
		const { fake, client } = setup();
		fake.route("/x", { status: 302, headers: { Location: "https://elsewhere.example.net/" }, body: "" });
		assert.equal((await failure(client.get("/x"))).kind, "bad_response");
		assert.equal(fake.calls.length, 1);
	});
});

describe("error classification", () => {
	const kindOf = async (spec) => {
		const { fake, client } = setup();
		fake.route("/x", spec);
		const err = await failure(client.get("/x"));
		assert.ok(err instanceof CanvasError);
		return err;
	};

	it("401 with WWW-Authenticate is auth, without is forbidden", async () => {
		assert.equal(
			(await kindOf({ status: 401, headers: { "WWW-Authenticate": 'Bearer realm="canvas-lms"' }, body: {} }))
				.kind,
			"auth"
		);
		assert.equal((await kindOf({ status: 401, body: {} })).kind, "forbidden");
	});

	it("403 is forbidden unless the body says Rate Limit Exceeded", async () => {
		assert.equal(
			(await kindOf({ status: 403, body: { errors: [{ message: "user not authorized" }] } })).kind,
			"forbidden"
		);
		assert.equal((await kindOf({ status: 403, body: "403 Forbidden (Rate Limit Exceeded)" })).kind, "throttled");
	});

	it("429 is throttled and parses Retry-After", async () => {
		const err = await kindOf({ status: 429, headers: { "Retry-After": "45" }, body: {} });
		assert.equal(err.kind, "throttled");
		assert.equal(err.retryAfterMs, 45000);
		assert.equal((await kindOf({ status: 429, body: {} })).retryAfterMs, 0);
	});

	it("maps 404 and 5xx", async () => {
		assert.equal((await kindOf({ status: 404, body: {} })).kind, "not_found");
		assert.equal((await kindOf({ status: 500, body: {} })).kind, "server");
		assert.equal((await kindOf({ status: 503, body: {} })).kind, "server");
	});

	it("maps a fetch TypeError to network", async () => {
		const { fake, client } = setup();
		fake.route("/x", { error: new TypeError("fetch failed") });
		assert.equal((await failure(client.get("/x"))).kind, "network");
	});

	it("maps a timeout to timeout", async () => {
		const { fake, client } = setup({ timeoutMs: 30 });
		fake.route("/x", { hang: true });
		assert.equal((await failure(client.get("/x"))).kind, "timeout");
	});

	it("maps an external abort to aborted, and never fetches after abort", async () => {
		const controller = new AbortController();
		const { fake, client } = setup({ signal: controller.signal, timeoutMs: 5000 });
		fake.route("/x", { hang: true });
		const pending = failure(client.get("/x"));
		await new Promise((resolve) => setTimeout(resolve, 20));
		controller.abort();
		assert.equal((await pending).kind, "aborted");
		const before = fake.calls.length;
		assert.equal((await failure(client.get("/x"))).kind, "aborted");
		assert.equal(fake.calls.length, before);
	});
});

describe("pacing", () => {
	it("sleeps 2 s under 100 remaining and 5 s under 50, nothing without the header", async () => {
		const { fake, client, sleeps } = setup();
		fake.route("/low", { headers: { "X-Rate-Limit-Remaining": "80" }, body: [] });
		fake.route("/lower", { headers: { "X-Rate-Limit-Remaining": "30.5" }, body: [] });
		fake.route("/plenty", { headers: { "X-Rate-Limit-Remaining": "600" }, body: [] });
		fake.route("/none", { body: [] });
		await client.get("/low");
		assert.deepEqual(sleeps, [2000]);
		await client.get("/lower");
		assert.deepEqual(sleeps, [2000, 5000]);
		await client.get("/plenty");
		await client.get("/none");
		assert.deepEqual(sleeps, [2000, 5000]);
	});
});

describe("secrecy", () => {
	it("keeps the token and query strings out of error messages and log lines", async () => {
		const { fake, client, logs } = setup();
		fake.route("/users/2001/courses", { status: 500, body: {} });
		fake.route("/courses", { headers: { "X-Rate-Limit-Remaining": "70", "X-Request-Cost": "0.2" }, body: [] });
		const err = await failure(client.getAll("/users/2001/courses", { include: ["total_scores"] }));
		await client.getAll("/courses", { enrollment_state: "active" });
		const text = [err.message, ...logs.map((entry) => entry.message)].join("\n");
		assert.ok(!text.includes(TOKEN));
		assert.ok(!/Bearer/i.test(text));
		assert.ok(!text.includes("?"));
		assert.ok(!text.includes("total_scores"));
		assert.ok(!text.includes("2001"), "ids are templated in paths");
		assert.match(text, /GET \/users\/:id\/courses/);
	});
});

describe("schedule hook", () => {
	it("runs every exchange through the supplied scheduler", async () => {
		let scheduled = 0;
		const { fake, client } = setup({
			schedule: (fn) => {
				scheduled += 1;
				return fn();
			}
		});
		fake.route("/courses", { body: [] });
		await client.getAll("/courses");
		await client.get("/courses");
		assert.equal(scheduled, 2);
	});
});
