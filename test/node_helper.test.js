"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Log } = require("./support/mm-stubs");
const { createFakeFetch, installCanvasFixtures, loadFixture } = require("./support/fake-fetch");
const Helper = require("../node_helper");

const TOKEN = "test-token-DO-NOT-USE-0000";
const URL_BASE = "https://canvas.example.edu";
const NOW = Date.parse("2026-10-06T16:00:00Z");
const INTERVAL = 1800000;
const ID_PATTERN = /\b(2001|2002|3001|1001|1002|1003|1004|1005|500\d|501\d|510\d|9001)\b/;

const active = [];

function setup({ prepare, install = true, now = NOW } = {}) {
	const fake = createFakeFetch();
	if (prepare) prepare(fake);
	if (install) installCanvasFixtures(fake);
	const helper = new Helper();
	helper.setName("MMM-CanvasGrades");
	helper.start();
	const clock = { now };
	const timers = [];
	const sent = [];
	helper._now = () => clock.now;
	helper._random = () => 0.5;
	helper._setTimer = (fn, ms) => {
		const timer = { fn, ms, cleared: false, fired: false };
		timers.push(timer);
		return timer;
	};
	helper._clearTimer = (timer) => {
		if (timer) timer.cleared = true;
	};
	helper.sleepImpl = async () => {};
	helper.tokenDeps = { configDir: os.tmpdir() };
	helper.fetchImpl = fake.fetch;
	helper.sendSocketNotification = (name, payload) =>
		sent.push({ name, payload: JSON.parse(JSON.stringify(payload)) });
	const ctx = {
		helper,
		fake,
		clock,
		timers,
		sent,
		pending: () => timers.filter((timer) => !timer.cleared && !timer.fired),
		last: (id) => [...sent].reverse().find((entry) => !id || entry.payload.instanceId === id).payload,
		register(id, config = {}) {
			helper.socketNotificationReceived("CANVASGRADES_REGISTER", {
				instanceId: id,
				config: { canvasUrl: URL_BASE, accessToken: TOKEN, excludeCourses: ["1005"], ...config }
			});
			return ctx.settle(id);
		},
		async settle(id) {
			const inst = helper.instances.get(id);
			if (inst && inst.runPromise) await inst.runPromise;
			return inst;
		},
		async fire(id) {
			const timer = ctx.pending().pop();
			assert.ok(timer, "a timer is pending");
			timer.fired = true;
			timer.fn();
			return ctx.settle(id);
		},
		delay: (id) => helper.instances.get(id).nextRunAt - clock.now
	};
	active.push(ctx);
	return ctx;
}

async function waitFor(predicate, label) {
	for (let i = 0; i < 200; i += 1) {
		if (predicate()) return;
		await new Promise((resolve) => setImmediate(resolve));
	}
	assert.fail(`timed out waiting for ${label}`);
}

afterEach(() => {
	const contexts = active.splice(0);
	const lines = Log.lines.splice(0);
	for (const ctx of contexts) {
		for (const entry of ctx.sent) {
			const text = JSON.stringify(entry.payload);
			for (const forbidden of [
				TOKEN,
				"Bearer",
				"Authorization",
				"access_token",
				"canvas.example.edu",
				"html_url"
			]) {
				assert.ok(!text.includes(forbidden), `payload leaks ${forbidden}`);
			}
			assert.ok(!ID_PATTERN.test(text), "payload leaks a Canvas id");
		}
		for (const call of ctx.fake.calls) assert.equal(call.origin, URL_BASE);
		ctx.helper.stop();
	}
	for (const line of lines) {
		for (const forbidden of [TOKEN, "Bearer", "Authorization", "access_token", "canvas.example.edu"]) {
			assert.ok(!line.message.includes(forbidden), `log leaks ${forbidden}: ${line.message}`);
		}
		if (line.level !== "debug") assert.ok(!ID_PATTERN.test(line.message), `log leaks a Canvas id: ${line.message}`);
	}
});

const missingNames = (view) => view.missing.map((item) => item.name);

describe("configuration errors", () => {
	const cases = [
		["no URL", { canvasUrl: "" }, "url"],
		["no token", { accessToken: "" }, "token"],
		["neither", { canvasUrl: "", accessToken: "" }, "url_and_token"],
		["http URL", { canvasUrl: "http://canvas.example.edu" }, "url"]
	];
	for (const [label, config, detail] of cases) {
		it(`publishes a terminal config error for ${label} and makes no requests`, async () => {
			const ctx = setup();
			const env = process.env.CANVAS_ACCESS_TOKEN;
			delete process.env.CANVAS_ACCESS_TOKEN;
			try {
				await ctx.register("module_1", config);
			} finally {
				if (env !== undefined) process.env.CANVAS_ACCESS_TOKEN = env;
			}
			const payload = ctx.last();
			assert.equal(payload.status, "error");
			assert.deepEqual(payload.error, { kind: "config", terminal: true, detail });
			assert.deepEqual(payload.students, []);
			assert.equal(ctx.fake.calls.length, 0);
			assert.equal(ctx.pending().length, 0);
			assert.ok(Log.lines.some((line) => line.level === "error"));
		});
	}

	it("reports an unreadable token file as token_file with basename and code only, then recovers when it appears", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-helper-"));
		const file = path.join(dir, "canvas-token");
		try {
			const ctx = setup();
			await ctx.register("module_1", { accessToken: "", accessTokenFile: file });
			assert.deepEqual(ctx.last().error, { kind: "token_file", terminal: true, detail: null });
			assert.equal(ctx.last().status, "error");
			assert.equal(ctx.fake.calls.length, 0);
			const line = Log.lines.find((entry) => /token/.test(entry.message) && entry.level === "error");
			assert.match(line.message, /canvas-token/);
			assert.match(line.message, /ENOENT/);
			assert.ok(!line.message.includes(dir));
			assert.equal(ctx.delay("module_1"), INTERVAL);

			fs.writeFileSync(file, `${TOKEN}\n`);
			await ctx.fire("module_1");
			assert.equal(ctx.last().status, "ok");
			assert.equal(ctx.fake.calls[0].headers.authorization, `Bearer ${TOKEN}`);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("ignores other notifications and malformed registrations", async () => {
		const ctx = setup();
		ctx.helper.socketNotificationReceived("SOMETHING_ELSE", {});
		ctx.helper.socketNotificationReceived("CANVASGRADES_REGISTER", null);
		ctx.helper.socketNotificationReceived("CANVASGRADES_REGISTER", { instanceId: 5 });
		ctx.helper.socketNotificationReceived("CANVASGRADES_REGISTER", { instanceId: "module_9", config: "junk" });
		assert.equal(ctx.fake.calls.length, 0);
		assert.equal(ctx.last("module_9").error.kind, "config");
	});
});

describe("happy cycle", () => {
	it("fetches strictly sequentially in the expected order and publishes the view model", async () => {
		const ctx = setup();
		await ctx.register("module_1");
		assert.equal(ctx.fake.maxConcurrent, 1);
		assert.deepEqual(ctx.fake.paths(), [
			"/users/self/observees",
			"/users/2001/courses",
			"/users/self/missing_submissions",
			"/courses/1001/students/submissions",
			"/courses/1001/students/submissions",
			"/courses/1002/students/submissions",
			"/courses/1003/students/submissions",
			"/courses/1004/students/submissions",
			"/users/2002/courses",
			"/users/self/missing_submissions",
			"/courses/1001/students/submissions",
			"/courses/1002/students/submissions",
			"/courses/1003/students/submissions",
			"/courses/1004/students/submissions"
		]);
		assert.deepEqual(ctx.fake.unmatched, []);
		assert.equal(ctx.sent[0].payload.status, "loading");
		const payload = ctx.last();
		assert.equal(payload.instanceId, "module_1");
		assert.equal(payload.status, "ok");
		assert.equal(payload.error, null);
		assert.equal(payload.fetchedAt, NOW);
		assert.equal(payload.staleAfterMs, 2 * INTERVAL + 300000);
		assert.equal(payload.partial, false);
		assert.equal(payload.paused, false);
		assert.equal(payload.multiStudent, true);
		assert.equal(payload.students.length, 2);
		const [a, b] = payload.students;
		assert.equal(a.label, "Student A");
		assert.deepEqual(missingNames(a), ["Map Quiz", "Chapter 4 Worksheet", "Homework 12"]);
		assert.deepEqual(
			a.courses.map((course) => [course.name, course.gradeText, course.missingCount]),
			[
				["Algebra I", "A", 2],
				["Biology", "B", 0],
				["World History", "--", 1],
				["English 9", "78.5%", 0]
			]
		);
		assert.equal(b.label, "Student B");
		assert.equal(b.missingTotal, 0);
		assert.deepEqual(
			b.courses.map((course) => course.gradeText),
			["B+", "A", "C-", "A-"]
		);
		assert.deepEqual(Object.keys(payload).sort(), [
			"error",
			"fetchedAt",
			"instanceId",
			"multiStudent",
			"partial",
			"paused",
			"staleAfterMs",
			"status",
			"students",
			"studentsNotFound"
		]);
		assert.equal(ctx.pending().length, 1);
		assert.equal(ctx.delay("module_1"), INTERVAL);
	});

	it("uses the fallback observee discovery when the observee list is empty", async () => {
		const ctx = setup({
			prepare: (fake) => {
				fake.route("/users/self/observees", { body: [] });
				fake.route("/courses", { body: loadFixture("observer-courses-observed-users") });
			}
		});
		await ctx.register("module_1", { students: ["2001"] });
		assert.equal(ctx.last().status, "ok");
		assert.equal(ctx.last().students.length, 1);
		assert.equal(ctx.fake.paths()[1], "/courses");
	});

	it("takes the grades-only fast path when nothing needs submissions", async () => {
		const ctx = setup();
		await ctx.register("module_1", { showMissing: false, showRecentGrades: 0 });
		assert.ok(ctx.fake.paths().every((p) => !p.includes("submissions")));
		assert.equal(ctx.last().students[0].courses.length, 4);
		assert.deepEqual(ctx.last().students[0].missing, []);
	});

	it("still fetches submissions and merges them with the endpoint when inference is off", async () => {
		const ctx = setup();
		await ctx.register("module_1", { inferMissing: false });
		assert.ok(ctx.fake.paths().some((p) => p.includes("/students/submissions")));
		// Vocabulary Quiz is graded in the submissions, so the lagging endpoint entry is dropped
		assert.deepEqual(missingNames(ctx.last().students[0]), ["Map Quiz", "Chapter 4 Worksheet"]);
	});

	it("does not rely on an endpoint that answers 200 with an empty list", async () => {
		const ctx = setup({ prepare: (fake) => fake.route("/users/self/missing_submissions", { body: [] }) });
		await ctx.register("module_1", { students: ["2001"], inferMissing: false });
		assert.deepEqual(missingNames(ctx.last().students[0]), ["Chapter 4 Worksheet"]);
	});
});

describe("subject styling", () => {
	it("sends icon and colour per entry, never the keys, and applies hideUngraded", async () => {
		const ctx = setup();
		await ctx.register("module_1", {
			students: ["2001"],
			subjectIcons: { ALGEBRA: "fa-solid fa-calculator", BAD: "x;y" },
			subjectColors: { ALGEBRA: "#c2410c", BIOLOGY: "teal" },
			hideUngraded: true
		});
		const payload = ctx.last();
		const text = JSON.stringify(payload);
		for (const secret of ["ALGEBRA", "BIOLOGY", "subjectIcons", "subjectColors", "BAD"])
			assert.ok(!text.includes(secret), secret);
		const student = payload.students[0];
		const byName = Object.fromEntries(student.courses.map((course) => [course.name, course]));
		assert.deepEqual([byName["Algebra I"].icon, byName["Algebra I"].color], ["fa-solid fa-calculator", "#c2410c"]);
		assert.deepEqual([byName.Biology.icon, byName.Biology.color], [null, "teal"]);
		assert.ok(
			student.missing.every(
				(item) =>
					(item.icon === "fa-solid fa-calculator" && item.color === "#c2410c") || item.course !== "Algebra I"
			)
		);
		assert.ok(
			!("World History" in byName) || byName["World History"].missingCount > 0,
			"ungraded course without missing work is omitted"
		);
		assert.ok(Log.lines.some((line) => line.level === "warn" && /subjectIcons/.test(line.message)));
	});
});

describe("registration", () => {
	it("re-registering the same config republishes immediately without fetching", async () => {
		const ctx = setup();
		await ctx.register("module_1");
		const calls = ctx.fake.calls.length;
		const sentBefore = ctx.sent.length;
		await ctx.register("module_1");
		assert.equal(ctx.fake.calls.length, calls);
		assert.equal(ctx.sent.length, sentBefore + 1);
		assert.equal(ctx.last().status, "ok");
		assert.equal(ctx.pending().length, 1);
	});

	it("a changed config stops the old instance, clears its timer and starts a new cycle", async () => {
		const ctx = setup();
		await ctx.register("module_1");
		const oldTimer = ctx.pending()[0];
		const calls = ctx.fake.calls.length;
		await ctx.register("module_1", { students: ["2001"] });
		assert.equal(oldTimer.cleared, true);
		assert.ok(ctx.fake.calls.length > calls);
		assert.equal(ctx.last().students.length, 1);
		assert.equal(ctx.helper.instances.size, 1);
		assert.equal(ctx.pending().length, 1);
	});

	it("keeps two instances apart: own instanceId, no overlapping requests, independent failures", async () => {
		const ctx = setup({
			prepare: (fake) => {
				fake.route("/users/2002/courses", { status: 401, headers: { "WWW-Authenticate": "Bearer" }, body: {} });
			}
		});
		ctx.helper.socketNotificationReceived("CANVASGRADES_REGISTER", {
			instanceId: "module_1",
			config: { canvasUrl: URL_BASE, accessToken: TOKEN, students: ["2001"], excludeCourses: ["1005"] }
		});
		ctx.helper.socketNotificationReceived("CANVASGRADES_REGISTER", {
			instanceId: "module_2",
			config: { canvasUrl: URL_BASE, accessToken: TOKEN, students: ["2002"], excludeCourses: ["1005"] }
		});
		await ctx.settle("module_1");
		await ctx.settle("module_2");
		assert.equal(ctx.fake.maxConcurrent, 1);
		assert.equal(ctx.last("module_1").status, "ok");
		assert.equal(ctx.last("module_1").students.length, 1);
		assert.equal(ctx.last("module_2").status, "error");
		assert.equal(ctx.last("module_2").error.kind, "auth");
		assert.ok(ctx.sent.every((entry) => ["module_1", "module_2"].includes(entry.payload.instanceId)));
	});

	it("drops a run requested while one is in flight", async () => {
		const ctx = setup();
		ctx.helper.socketNotificationReceived("CANVASGRADES_REGISTER", {
			instanceId: "module_1",
			config: { canvasUrl: URL_BASE, accessToken: TOKEN, excludeCourses: ["1005"] }
		});
		const inst = ctx.helper.instances.get("module_1");
		assert.equal(inst.inFlight, true);
		const again = ctx.helper._run(inst);
		assert.equal(again, inst.runPromise);
		await inst.runPromise;
		assert.equal(ctx.fake.calls.length, 14);
	});
});

describe("failure handling", () => {
	it("backs off 60 s, 120 s, 240 s ... capped at 15 minutes for network errors", async () => {
		const ctx = setup({
			prepare: (fake) => fake.route("/users/self/observees", { error: new TypeError("fetch failed") })
		});
		await ctx.register("module_1");
		const delays = [ctx.delay("module_1")];
		for (let i = 0; i < 5; i += 1) {
			await ctx.fire("module_1");
			delays.push(ctx.delay("module_1"));
		}
		assert.deepEqual(delays, [60000, 120000, 240000, 480000, 900000, 900000]);
		assert.equal(ctx.last().status, "error");
		assert.equal(ctx.last().error.kind, "network");
		assert.equal(ctx.last().error.terminal, false);
	});

	it("caps the backoff at updateInterval, keeps jitter within 20 percent and never goes below 60 s", () => {
		const ctx = setup();
		const cfg = { updateInterval: 300000 };
		const big = { updateInterval: 1800000 };
		ctx.helper._random = () => 0;
		assert.equal(ctx.helper._backoffDelay("network", 1, big), 60000);
		assert.equal(ctx.helper._backoffDelay("network", 3, big), 192000);
		ctx.helper._random = () => 1;
		assert.equal(ctx.helper._backoffDelay("network", 1, big), 72000);
		assert.equal(ctx.helper._backoffDelay("network", 3, big), 288000);
		assert.equal(ctx.helper._backoffDelay("server", 10, cfg), 300000);
		for (let i = 0; i <= 10; i += 1) {
			ctx.helper._random = () => i / 10;
			for (const failures of [1, 2, 4]) {
				const d = ctx.helper._backoffDelay("timeout", failures, big);
				const base = Math.min(900000, 60000 * 2 ** (failures - 1));
				assert.ok(d >= 60000 && d >= base * 0.8 - 1 && d <= base * 1.2 + 1);
			}
		}
	});

	it("starts throttle backoff at about 30 s and honours Retry-After", async () => {
		const ctx = setup();
		ctx.helper._random = () => 0.5;
		assert.equal(ctx.helper._backoffDelay("throttled", 1, { updateInterval: INTERVAL }), 30000);
		assert.equal(ctx.helper._backoffDelay("throttled", 2, { updateInterval: INTERVAL }), 60000);
		assert.equal(ctx.helper._backoffDelay("throttled", 1, { updateInterval: INTERVAL }, 600000), 600000);
		const throttled = setup({
			prepare: (fake) =>
				fake.route("/users/self/observees", { status: 429, headers: { "Retry-After": "90" }, body: {} })
		});
		await throttled.register("module_1");
		assert.equal(throttled.last().error.kind, "throttled");
		assert.equal(throttled.delay("module_1"), 90000);
	});

	it("keeps the last data when a later cycle fails with a network error", async () => {
		const ctx = setup();
		await ctx.register("module_1");
		const before = ctx.last();
		ctx.fake.reset();
		ctx.fake.route(/.*/, { error: new TypeError("fetch failed") });
		ctx.clock.now += INTERVAL;
		await ctx.fire("module_1");
		const after = ctx.last();
		assert.equal(after.status, "ok");
		assert.deepEqual(after.students, before.students);
		assert.equal(after.fetchedAt, before.fetchedAt);
		assert.deepEqual(after.error, { kind: "network", terminal: false, detail: null });
	});

	it("does not overwrite the snapshot when throttled mid-cycle", async () => {
		const ctx = setup();
		await ctx.register("module_1");
		const inst = ctx.helper.instances.get("module_1");
		const snapshot = inst.snapshot;
		const students = JSON.stringify(snapshot.students);
		const throttledFake = createFakeFetch();
		throttledFake.route("/users/2002/courses", { status: 429, headers: { "Retry-After": "600" }, body: {} });
		installCanvasFixtures(throttledFake);
		ctx.helper.fetchImpl = throttledFake.fetch;
		ctx.clock.now += INTERVAL;
		await ctx.fire("module_1");
		assert.equal(inst.snapshot, snapshot);
		assert.equal(JSON.stringify(inst.snapshot.students), students);
		assert.equal(ctx.last().error.kind, "throttled");
		assert.equal(ctx.last().fetchedAt, NOW);
		assert.equal(ctx.delay("module_1"), 600000);
	});

	it("marks a course failed and the snapshot partial when its submissions are forbidden", async () => {
		const ctx = setup({
			prepare: (fake) =>
				fake.route("/courses/1002/students/submissions", {
					status: 403,
					body: { errors: [{ message: "unauthorized" }] }
				})
		});
		await ctx.register("module_1", { students: ["2001"] });
		const payload = ctx.last();
		assert.equal(payload.status, "ok");
		assert.equal(payload.partial, true);
		assert.equal(payload.error, null);
		const failed = payload.students[0].courses.map((course) => [course.name, course.failed]);
		assert.deepEqual(failed, [
			["Algebra I", false],
			["Biology", true],
			["World History", false],
			["English 9", false]
		]);
		assert.ok(missingNames(payload.students[0]).includes("Chapter 4 Worksheet"));
	});

	it("tries the other missing_submissions variant, then marks the endpoint unusable for good", async () => {
		const ctx = setup({
			prepare: (fake) => {
				fake.route("/users/self/missing_submissions", { status: 403, body: {} });
				fake.route(/^\/users\/\d+\/missing_submissions$/, { status: 404, body: {} });
			}
		});
		await ctx.register("module_1");
		const missingCalls = () => ctx.fake.calls.filter((call) => call.path.endsWith("/missing_submissions")).length;
		assert.equal(missingCalls(), 2);
		assert.equal(ctx.helper.instances.get("module_1").missingMode, "unusable");
		assert.equal(ctx.last().status, "ok");
		assert.deepEqual(missingNames(ctx.last().students[0]), ["Chapter 4 Worksheet", "Homework 12"]);
		ctx.clock.now += INTERVAL;
		await ctx.fire("module_1");
		assert.equal(missingCalls(), 2);
	});

	it("falls back to the per-student missing_submissions path and remembers it", async () => {
		const ctx = setup({
			prepare: (fake) => {
				fake.route("/users/self/missing_submissions", { status: 403, body: {} });
				fake.route("/users/2001/missing_submissions", { body: loadFixture("missing-submissions-student-a") });
				fake.route("/users/2002/missing_submissions", { body: [] });
			}
		});
		await ctx.register("module_1");
		assert.equal(ctx.helper.instances.get("module_1").missingMode, "child");
		assert.deepEqual(missingNames(ctx.last().students[0]), ["Map Quiz", "Chapter 4 Worksheet", "Homework 12"]);
		const selfCalls = ctx.fake.calls.filter((call) => call.path === "/users/self/missing_submissions").length;
		assert.equal(selfCalls, 1, "self variant is not retried for the second student");
	});

	it("reports forbidden and no_students without terminal state", async () => {
		const forbidden = setup({ prepare: (fake) => fake.route("/users/self/observees", { status: 403, body: {} }) });
		await forbidden.register("module_1");
		assert.deepEqual(forbidden.last().error, { kind: "forbidden", terminal: false, detail: null });
		assert.equal(forbidden.delay("module_1"), 6 * 3600 * 1000);

		const none = setup({
			prepare: (fake) => {
				fake.route("/users/self/observees", { body: [] });
				fake.route("/courses", { body: [] });
			}
		});
		await none.register("module_1");
		assert.deepEqual(none.last().error, { kind: "no_students", terminal: false, detail: null });
		assert.equal(none.delay("module_1"), INTERVAL);

		const unknown = setup();
		await unknown.register("module_1", { students: ["9999"] });
		assert.equal(unknown.last().error.kind, "no_students");
	});

	it("treats malformed JSON as a transient server error", async () => {
		const ctx = setup({ prepare: (fake) => fake.route("/users/self/observees", { body: "<html>" }) });
		await ctx.register("module_1");
		assert.equal(ctx.last().error.kind, "server");
	});
});

describe("auth failure", () => {
	const authFail = (fake) =>
		fake.route("/users/self/observees", { status: 401, headers: { "WWW-Authenticate": "Bearer" }, body: {} });

	it("stops calling Canvas, checks the token source on the interval and retries once after 6 hours", async () => {
		const ctx = setup({ prepare: authFail });
		await ctx.register("module_1");
		const payload = ctx.last();
		assert.equal(payload.status, "error");
		assert.deepEqual(payload.error, { kind: "auth", terminal: true, detail: null });
		assert.equal(ctx.helper.instances.get("module_1").phase, "auth_failed");
		assert.equal(ctx.fake.calls.length, 1);

		ctx.clock.now += INTERVAL;
		await ctx.fire("module_1");
		assert.equal(ctx.fake.calls.length, 1, "no network on an unchanged token");

		ctx.clock.now += 6 * 3600 * 1000;
		await ctx.fire("module_1");
		assert.equal(ctx.fake.calls.length, 2, "one retry after 6 h");
		assert.equal(ctx.helper.instances.get("module_1").phase, "auth_failed");
		ctx.clock.now += INTERVAL;
		await ctx.fire("module_1");
		assert.equal(ctx.fake.calls.length, 2);
	});

	it("recovers immediately when the token file is replaced", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-auth-"));
		const file = path.join(dir, "canvas-token");
		try {
			fs.writeFileSync(file, "old-token-0000");
			const ctx = setup({ prepare: authFail });
			await ctx.register("module_1", { accessToken: "", accessTokenFile: file });
			assert.equal(ctx.last().error.kind, "auth");
			assert.equal(ctx.fake.calls[0].headers.authorization, "Bearer old-token-0000");

			ctx.fake.reset();
			installCanvasFixtures(ctx.fake);
			fs.writeFileSync(file, "new-token-0000");
			ctx.clock.now += INTERVAL;
			await ctx.fire("module_1");
			assert.equal(ctx.last().status, "ok");
			assert.equal(ctx.fake.calls[0].headers.authorization, "Bearer new-token-0000");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("picks up a rotated token file on the next healthy cycle", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-rotate-"));
		const file = path.join(dir, "canvas-token");
		try {
			fs.writeFileSync(file, "first-token-0000");
			const ctx = setup();
			await ctx.register("module_1", { accessToken: "", accessTokenFile: file, students: ["2001"] });
			assert.ok(ctx.fake.calls.every((call) => call.headers.authorization === "Bearer first-token-0000"));
			ctx.fake.calls.length = 0;
			fs.writeFileSync(file, "second-token-0000");
			ctx.clock.now += INTERVAL;
			await ctx.fire("module_1");
			assert.ok(ctx.fake.calls.length > 0);
			assert.ok(ctx.fake.calls.every((call) => call.headers.authorization === "Bearer second-token-0000"));
			assert.equal(ctx.helper.instances.size, 1);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("security and diagnostics", () => {
	it("ignores a re-registration that changes canvasUrl or the token source", async () => {
		const ctx = setup();
		await ctx.register("module_1");
		const calls = ctx.fake.calls.length;
		const before = ctx.helper.instances.get("module_1");
		await ctx.register("module_1", { canvasUrl: "https://attacker.example.net", accessToken: "other-token-0000" });
		assert.equal(ctx.helper.instances.get("module_1"), before, "same instance, nothing restarted");
		assert.equal(ctx.fake.calls.length, calls);
		assert.ok(Log.lines.some((line) => line.level === "warn" && /ignored/.test(line.message)));
		await ctx.register("module_1", {
			canvasUrl: "https://attacker.example.net",
			accessToken: "other-token-0000",
			maxMissing: 2
		});
		const inst = ctx.helper.instances.get("module_1");
		assert.notEqual(inst, before, "other options still apply");
		assert.equal(inst.cfg.canvasUrl, URL_BASE);
		assert.equal(inst.cfg.accessToken, TOKEN);
		assert.equal(inst.cfg.maxMissing, 2);
		for (const call of ctx.fake.calls) {
			assert.equal(call.origin, URL_BASE);
			assert.equal(call.headers.authorization, `Bearer ${TOKEN}`);
		}
	});

	it("refuses a token file outside the config folder and reports token_file", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-sec-"));
		try {
			fs.mkdirSync(path.join(dir, "config"));
			fs.writeFileSync(path.join(dir, "secret-token"), TOKEN);
			const ctx = setup();
			ctx.helper.tokenDeps = { configDir: path.join(dir, "config") };
			await ctx.register("module_1", { accessToken: "", accessTokenFile: path.join(dir, "secret-token") });
			assert.equal(ctx.last().error.kind, "token_file");
			assert.equal(ctx.fake.calls.length, 0);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("warns and reports studentsNotFound when a configured student id matches nobody", async () => {
		const ctx = setup();
		await ctx.register("module_1", { students: ["2001", "9999"] });
		assert.equal(ctx.last().status, "ok");
		assert.equal(ctx.last().students.length, 1);
		assert.equal(ctx.last().studentsNotFound, 1);
		assert.ok(
			Log.lines.some(
				(line) => line.level === "warn" && /not linked/.test(line.message) && line.message.includes("9999")
			)
		);
		const clean = setup();
		await clean.register("module_1");
		assert.equal(clean.last().studentsNotFound, 0);
	});

	it("warns about unmatched students once per distinct set of ids, not every cycle", async () => {
		const ctx = setup();
		await ctx.register("module_1", { students: ["2001", "9999"] });
		const count = () => Log.lines.filter((line) => line.level === "warn" && /not linked/.test(line.message)).length;
		assert.equal(count(), 1);
		for (let i = 0; i < 3; i += 1) {
			ctx.clock.now += INTERVAL;
			await ctx.fire("module_1");
		}
		assert.equal(count(), 1);
	});

	it("does not cache an empty observee list, so a newly linked student appears next cycle", async () => {
		const ctx = setup({
			install: false,
			prepare: (fake) => {
				fake.route("/users/self/observees", { body: [] });
				fake.route("/courses", { body: [] });
			}
		});
		await ctx.register("module_1");
		assert.equal(ctx.last().error.kind, "no_students");
		assert.equal(ctx.helper.instances.get("module_1").observees, null);
		ctx.fake.reset();
		installCanvasFixtures(ctx.fake);
		ctx.clock.now += INTERVAL;
		await ctx.fire("module_1");
		assert.equal(ctx.last().status, "ok");
		assert.equal(ctx.last().error, null);
	});

	it("pins a token file to the first Canvas host: a second instance for another host makes no requests", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-pin-"));
		try {
			const file = path.join(dir, "canvas-token");
			fs.writeFileSync(file, TOKEN);
			const ctx = setup();
			await ctx.register("module_1", { accessToken: "", accessTokenFile: file });
			assert.equal(ctx.last("module_1").status, "ok");
			const calls = ctx.fake.calls.length;
			// other host, same file (also spelled differently)
			await ctx.register("evil_1", {
				canvasUrl: "https://attacker.example.net",
				accessToken: "",
				accessTokenFile: path.join(dir, "sub", "..", "canvas-token")
			});
			assert.equal(ctx.fake.calls.length, calls, "no request of any kind");
			assert.ok(ctx.fake.calls.every((call) => call.origin === URL_BASE));
			assert.deepEqual(ctx.last("evil_1").error, { kind: "config", terminal: true, detail: "origin_pinned" });
			assert.equal(ctx.last("evil_1").status, "error");
			// the same host is still fine for another module instance
			await ctx.register("module_2", { accessToken: "", accessTokenFile: file, students: ["2001"] });
			assert.equal(ctx.last("module_2").status, "ok");
			assert.ok(Log.lines.some((line) => line.level === "error" && /refused/.test(line.message)));
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("refuses any other file in the config folder, such as another module's token, with zero requests", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-ha-"));
		try {
			fs.writeFileSync(path.join(dir, "homeassistant-token"), "HA-LONG-LIVED-SECRET-xyz789");
			fs.writeFileSync(path.join(dir, "birdfy-ha-token"), "eyJhbGciOiJIUzI1NiJ9.payload.signature");
			fs.writeFileSync(path.join(dir, "config.js"), "// sentinel");
			const ctx = setup();
			ctx.helper.tokenDeps = { configDir: dir };
			for (const name of ["homeassistant-token", "birdfy-ha-token", "config.js"]) {
				await ctx.register(`evil_${name}`, {
					canvasUrl: "https://attacker.example.net",
					accessToken: "",
					accessTokenFile: path.join(dir, name)
				});
				assert.deepEqual(ctx.last(`evil_${name}`).error, {
					kind: "token_file",
					terminal: true,
					detail: "bad_name"
				});
			}
			assert.equal(ctx.fake.calls.length, 0);
			const logged = Log.lines.map((line) => line.message).join("\n");
			assert.ok(!logged.includes("xyz789") && !logged.includes("eyJhbGci"));
			assert.ok(/must be named canvas-token/.test(logged));
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("uses one process-wide origin pin for all stored-token sources", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-pin2-"));
		try {
			fs.writeFileSync(path.join(dir, "canvas-token"), TOKEN);
			fs.writeFileSync(path.join(dir, "canvas-token-other"), TOKEN);
			const ctx = setup();
			ctx.helper.tokenDeps = { configDir: dir, env: { CANVAS_ACCESS_TOKEN: TOKEN } };
			await ctx.register("module_1", { accessToken: "", accessTokenFile: path.join(dir, "canvas-token") });
			assert.equal(ctx.last("module_1").status, "ok");
			const calls = ctx.fake.calls.length;
			// a second FILE and the ENV source may not use another origin
			await ctx.register("evil_file", {
				canvasUrl: "https://attacker.example.net",
				accessToken: "",
				accessTokenFile: path.join(dir, "canvas-token-other")
			});
			await ctx.register("evil_env", { canvasUrl: "https://attacker.example.net", accessToken: "" });
			assert.equal(ctx.fake.calls.length, calls, "no request of any kind");
			assert.equal(ctx.last("evil_file").error.detail, "origin_pinned");
			assert.equal(ctx.last("evil_env").error.detail, "origin_pinned");
			// but the same origin works for every source
			await ctx.register("ok_env", { accessToken: "", students: ["2001"] });
			assert.equal(ctx.last("ok_env").status, "ok");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("a registration with no usable token cannot claim the pin", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-pin3-"));
		try {
			const ctx = setup();
			ctx.helper.tokenDeps = { configDir: dir, env: {} };
			await ctx.register("bogus", {
				canvasUrl: "https://attacker.example.net",
				accessToken: "",
				accessTokenFile: path.join(dir, "canvas-token-missing")
			});
			assert.equal(ctx.last("bogus").error.kind, "token_file");
			assert.equal(ctx.helper.pinnedOrigin, "");
			fs.writeFileSync(path.join(dir, "canvas-token"), TOKEN);
			await ctx.register("legit", { accessToken: "", accessTokenFile: path.join(dir, "canvas-token") });
			assert.equal(ctx.last("legit").status, "ok");
			// the bogus instance later finds its file but the pin now refuses the foreign host
			fs.writeFileSync(path.join(dir, "canvas-token-missing"), TOKEN);
			const calls = ctx.fake.calls.length;
			await ctx.helper._run(ctx.helper.instances.get("bogus"));
			assert.equal(ctx.fake.calls.length, calls);
			assert.equal(ctx.last("bogus").error.detail, "origin_pinned");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("pins the environment token source the same way", async () => {
		const ctx = setup();
		ctx.helper.tokenDeps = { configDir: os.tmpdir(), env: { CANVAS_ACCESS_TOKEN: TOKEN } };
		await ctx.register("module_1", { accessToken: "" });
		assert.equal(ctx.last("module_1").status, "ok");
		const calls = ctx.fake.calls.length;
		await ctx.register("evil_1", { canvasUrl: "https://attacker.example.net", accessToken: "" });
		assert.equal(ctx.fake.calls.length, calls);
		assert.equal(ctx.last("evil_1").error.kind, "config");
	});

	it("treats CANVAS_URL as a hard pin, even for the first registration", async () => {
		const env = { CANVAS_ACCESS_TOKEN: TOKEN, CANVAS_URL: "https://canvas.example.edu/" };
		const ctx = setup();
		ctx.helper.tokenDeps = { configDir: os.tmpdir(), env };
		await ctx.register("evil_1", { canvasUrl: "https://attacker.example.net", accessToken: "" });
		assert.equal(ctx.fake.calls.length, 0);
		assert.equal(ctx.last("evil_1").error.kind, "config");
		await ctx.register("module_1", { accessToken: "" });
		assert.equal(ctx.last("module_1").status, "ok");

		const broken = setup();
		broken.helper.tokenDeps = {
			configDir: os.tmpdir(),
			env: { CANVAS_ACCESS_TOKEN: TOKEN, CANVAS_URL: "not a url" }
		};
		await broken.register("module_1", { accessToken: "" });
		assert.equal(broken.fake.calls.length, 0);
		assert.equal(broken.last("module_1").error.kind, "config");
	});

	it("names the missing options in the config error log", async () => {
		const ctx = setup();
		const env = process.env.CANVAS_ACCESS_TOKEN;
		delete process.env.CANVAS_ACCESS_TOKEN;
		try {
			await ctx.register("module_1", { canvasUrl: "", accessToken: "" });
		} finally {
			if (env !== undefined) process.env.CANVAS_ACCESS_TOKEN = env;
		}
		const line = Log.lines.find((entry) => entry.level === "error");
		assert.match(line.message, /canvasUrl/);
		assert.match(line.message, /accessTokenFile/);
		assert.ok(!line.message.includes("and_token"));
	});
});

describe("quiet hours", () => {
	it("makes no requests inside the window, publishes paused, and runs at the window end", async () => {
		const ctx = setup({ now: new Date(2026, 9, 6, 23, 0, 0).getTime() });
		await ctx.register("module_1", { pauseBetween: ["22:00", "06:00"] });
		// no data yet: one fetch is made even inside the window
		assert.ok(ctx.fake.calls.length > 0);
		assert.equal(ctx.last().status, "ok");
		assert.equal(ctx.last().paused, false);
		const calls = ctx.fake.calls.length;
		await ctx.helper._run(ctx.helper.instances.get("module_1"));
		assert.equal(ctx.fake.calls.length, calls, "no further requests inside the window");
		assert.equal(ctx.last().paused, true);
		assert.equal(ctx.delay("module_1"), 7 * 3600 * 1000 + 500);

		ctx.clock.now = new Date(2026, 9, 7, 6, 0, 1).getTime();
		await ctx.fire("module_1");
		assert.ok(ctx.fake.calls.length > calls);
		assert.equal(ctx.last().paused, false);
		assert.equal(ctx.last().status, "ok");
	});

	it("regression E-2: booting inside the window with no data fetches exactly one full cycle", async () => {
		const ctx = setup({ now: new Date(2026, 9, 6, 23, 0, 0).getTime() });
		await ctx.register("module_1", { pauseBetween: ["22:00", "06:00"] });
		assert.equal(ctx.fake.calls.length, 14);
		assert.equal(ctx.last().status, "ok");
		assert.equal(ctx.pending().length, 1);
	});

	it("regression E-4: booting inside the window with a stale cache fetches; with a fresh cache it does not", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-quiet-"));
		try {
			const config = { cache: true, pauseBetween: ["22:00", "06:00"] };
			const evening = new Date(2026, 9, 6, 22, 30, 0).getTime();
			const first = setup({ now: evening });
			first.helper.tokenDeps = { configDir: dir };
			await first.register("module_1", config);
			assert.equal(first.last().fetchedAt, evening);
			first.helper.stop();

			const fresh = setup({ now: evening + 30 * 60000, install: false });
			fresh.helper.tokenDeps = { configDir: dir };
			fresh.fake.route(/.*/, { error: new TypeError("offline") });
			await fresh.register("module_1", config);
			assert.equal(fresh.fake.calls.length, 0, "fresh cache inside the window: no request");
			assert.equal(fresh.last().paused, true);
			assert.equal(fresh.last().status, "ok");
			fresh.helper.stop();

			const stale = setup({ now: new Date(2026, 9, 9, 23, 0, 0).getTime() });
			stale.helper.tokenDeps = { configDir: dir };
			await stale.register("module_1", config);
			assert.equal(stale.sent[0].payload.status, "ok", "the cache is shown first");
			assert.equal(stale.sent[0].payload.fetchedAt, evening);
			assert.ok(stale.fake.calls.length > 0, "stale cache inside the window: one fetch");
			assert.ok(stale.last().fetchedAt > evening);
			assert.equal(stale.last().paused, false);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("moves a schedule that lands inside the window to the window end", async () => {
		const ctx = setup({ now: new Date(2026, 9, 6, 21, 50, 0).getTime() });
		await ctx.register("module_1", { pauseBetween: ["22:00", "06:00"], updateInterval: 1800000 });
		assert.ok(ctx.fake.calls.length > 0);
		const nextRun = new Date(ctx.helper.instances.get("module_1").nextRunAt);
		assert.equal(nextRun.getHours(), 6);
		assert.equal(nextRun.getMinutes(), 0);
	});
});

describe("cache file", () => {
	const withDir = async (fn) => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-cache-"));
		try {
			await fn(dir);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	};
	const setupIn = (dir, options) => {
		const ctx = setup(options);
		ctx.helper.tokenDeps = { configDir: dir };
		return ctx;
	};
	const cacheFiles = (dir) => fs.readdirSync(dir).filter((name) => name.startsWith("canvas-grades-cache-"));
	const pathOf = (ctx, id = "module_1") => ctx.helper.instances.get(id).cachePath;

	it("derives its own file name, writes atomically and keeps secrets, ids and URLs out", async () => {
		await withDir(async (dir) => {
			const ctx = setupIn(dir);
			await ctx.register("module_1", { cache: true });
			const names = cacheFiles(dir);
			assert.equal(names.length, 1);
			assert.match(names[0], /^canvas-grades-cache-[0-9a-f]{16}\.json$/);
			assert.ok(!fs.existsSync(`${pathOf(ctx)}.tmp`));
			const text = fs.readFileSync(pathOf(ctx), "utf8");
			const data = JSON.parse(text);
			assert.equal(data.magic, "MMM-CanvasGrades-cache");
			assert.equal(data.version, 1);
			assert.equal(data.fetchedAt, NOW);
			assert.equal(data.students.length, 2);
			for (const forbidden of [TOKEN, "canvas.example.edu", "html_url", "Bearer"])
				assert.ok(!text.includes(forbidden));
			assert.ok(!ID_PATTERN.test(text));
			if (process.platform !== "win32") assert.equal(fs.statSync(pathOf(ctx)).mode & 0o777, 0o600);
		});
	});

	it("writes no cache unless cache is true", async () => {
		await withDir(async (dir) => {
			const ctx = setupIn(dir);
			await ctx.register("module_1");
			assert.deepEqual(cacheFiles(dir), []);
		});
	});

	it("ignores a client-supplied cacheFile and leaves config.js byte-identical", async () => {
		await withDir(async (dir) => {
			const original = Buffer.from("// SENTINEL config\r\nmodule.exports = {};\n");
			const target = path.join(dir, "config.js");
			fs.writeFileSync(target, original);
			for (const extra of [
				{ cacheFile: target },
				{ cacheFile: target, cache: true },
				{ cacheFile: "config.js", cache: true }
			]) {
				const ctx = setupIn(dir);
				await ctx.register("module_1", extra);
				assert.ok(fs.readFileSync(target).equals(original), JSON.stringify(extra));
				assert.ok(Log.lines.some((line) => line.level === "warn" && /cacheFile/.test(line.message)));
				if (extra.cache) assert.ok(pathOf(ctx).includes("canvas-grades-cache-"));
				ctx.helper.stop();
			}
			assert.ok(fs.readFileSync(target).equals(original));
		});
	});

	it("loads the cache before the first fetch and shows it as ok with its original fetchedAt", async () => {
		await withDir(async (dir) => {
			const first = setupIn(dir);
			await first.register("module_1", { cache: true });
			first.helper.stop();

			const second = setupIn(dir, { install: false, now: NOW + 5 * 3600 * 1000 });
			second.fake.route(/.*/, { error: new TypeError("offline") });
			await second.register("module_1", { cache: true });
			const initial = second.sent[0].payload;
			assert.equal(initial.status, "ok");
			assert.equal(initial.fetchedAt, NOW);
			assert.equal(initial.students.length, 2);
			assert.equal(second.last().error.kind, "network");
			assert.equal(second.last().fetchedAt, NOW);
		});
	});

	it("ignores a cache with a different signature, corrupt content or no magic marker", async () => {
		await withDir(async (dir) => {
			const first = setupIn(dir);
			await first.register("module_1", { cache: true });
			const file = pathOf(first);
			const valid = fs.readFileSync(file, "utf8");
			first.helper.stop();
			const boot = async () => {
				const ctx = setupIn(dir, { install: false });
				ctx.fake.route(/.*/, { error: new TypeError("offline") });
				await ctx.register("module_1", { cache: true, maxMissing: 3 });
				return ctx;
			};
			assert.equal((await boot()).sent[0].payload.status, "loading", "different signature");
			for (const content of ["{not json", JSON.stringify({ ...JSON.parse(valid), magic: undefined })]) {
				fs.writeFileSync(file, content);
				const ctx = setupIn(dir, { install: false });
				ctx.fake.route(/.*/, { error: new TypeError("offline") });
				await ctx.register("module_1", { cache: true });
				assert.equal(ctx.sent[0].payload.status, "loading");
			}
		});
	});

	it("refuses to overwrite a file that is not a cache file", async () => {
		await withDir(async (dir) => {
			const first = setupIn(dir);
			await first.register("module_1", { cache: true });
			const file = pathOf(first);
			first.helper.stop();
			fs.writeFileSync(file, "// SENTINEL not a cache\n");
			const ctx = setupIn(dir);
			await ctx.register("module_1", { cache: true });
			assert.equal(ctx.last().status, "ok");
			assert.equal(fs.readFileSync(file, "utf8"), "// SENTINEL not a cache\n");
			assert.equal(ctx.helper.instances.get("module_1").cacheEnabled, false);
			assert.ok(Log.lines.some((line) => line.level === "warn" && /not a cache file/.test(line.message)));
		});
	});

	it("never follows a symlink at the cache path", async (t) => {
		await withDir(async (dir) => {
			const first = setupIn(dir);
			await first.register("module_1", { cache: true });
			const file = pathOf(first);
			first.helper.stop();
			fs.rmSync(file);
			const outside = path.join(dir, "outside-sentinel.txt");
			fs.writeFileSync(outside, "SENTINEL");
			try {
				fs.symlinkSync(outside, file, "file");
			} catch {
				t.skip("symlinks are not available here");
				return;
			}
			const ctx = setupIn(dir);
			await ctx.register("module_1", { cache: true });
			assert.equal(fs.readFileSync(outside, "utf8"), "SENTINEL");
			assert.equal(ctx.helper.instances.get("module_1").cacheEnabled, false);
		});
	});

	it("warns and disables the cache for a second instance that derives the same file", async () => {
		await withDir(async (dir) => {
			const ctx = setupIn(dir);
			await ctx.register("module_1", { cache: true, students: ["2001"] });
			await ctx.register("module_2", { cache: true, students: ["2001"] });
			assert.equal(ctx.helper.instances.get("module_1").cacheEnabled, true);
			assert.equal(ctx.helper.instances.get("module_2").cacheEnabled, false);
			assert.ok(Log.lines.some((line) => line.level === "warn" && /already uses/.test(line.message)));
			assert.equal(cacheFiles(dir).length, 1);
		});
	});

	it("gives different student selections different files", async () => {
		await withDir(async (dir) => {
			const ctx = setupIn(dir);
			await ctx.register("module_1", { cache: true, students: ["2001"] });
			await ctx.register("module_2", { cache: true, students: ["2002"] });
			assert.equal(cacheFiles(dir).length, 2);
		});
	});

	it("disables the cache with one warning when it cannot be written", async () => {
		await withDir(async (dir) => {
			const ctx = setupIn(path.join(dir, "missing-config-dir"));
			await ctx.register("module_1", { cache: true });
			assert.equal(ctx.last().status, "ok");
			assert.equal(ctx.helper.instances.get("module_1").cacheEnabled, false);
			assert.equal(
				Log.lines.filter((line) => line.level === "warn" && /cache file not written/.test(line.message)).length,
				1
			);
		});
	});
});

describe("cache housekeeping", () => {
	const NAME = /^canvas-grades-cache-[0-9a-f]{16}\.json$/;

	it("keeps at most the newest 8 cache files across 25 re-registrations and never touches other files", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-prune-"));
		try {
			const sentinel = path.join(dir, "config.js");
			fs.writeFileSync(sentinel, "// sentinel");
			const lookalike = path.join(dir, "canvas-grades-cache-0000000000000000.json");
			fs.writeFileSync(lookalike, "NOT A CACHE");
			const ctx = setup();
			ctx.helper.tokenDeps = { configDir: dir };
			for (let i = 0; i < 25; i += 1)
				await ctx.register("module_1", { cache: true, courses: [String(1001 + (i % 4)), `9${i}`] });
			const names = fs.readdirSync(dir).filter((name) => NAME.test(name) && name !== path.basename(lookalike));
			assert.ok(names.length <= 8, `${names.length} cache files left`);
			assert.ok(names.length >= 2);
			const live = ctx.helper.instances.get("module_1").cachePath;
			assert.ok(fs.existsSync(live), "the live instance file stays");
			assert.equal(fs.readFileSync(sentinel, "utf8"), "// sentinel");
			assert.equal(fs.readFileSync(lookalike, "utf8"), "NOT A CACHE", "invalid files are never deleted");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("deletes valid caches older than 30 days, but not a live instance's or other files", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-prune-"));
		try {
			const ctx = setup();
			ctx.helper.tokenDeps = { configDir: dir };
			await ctx.register("module_1", { cache: true, students: ["2001"] });
			const live = ctx.helper.instances.get("module_1").cachePath;
			const old = path.join(dir, "canvas-grades-cache-aaaaaaaaaaaaaaaa.json");
			fs.copyFileSync(live, old);
			const plain = path.join(dir, "notes.txt");
			fs.writeFileSync(plain, "keep");
			const longAgo = new Date(Date.now() - 40 * 86400000);
			for (const file of [old, plain, live]) fs.utimesSync(file, longAgo, longAgo);
			ctx.clock.now += INTERVAL;
			await ctx.fire("module_1");
			assert.ok(!fs.existsSync(old), "old valid cache removed");
			assert.ok(fs.existsSync(live), "live instance cache kept");
			assert.equal(fs.readFileSync(plain, "utf8"), "keep");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("stop and resource flatness", () => {
	it("stop() clears timers, aborts an in-flight request and publishes nothing afterwards", async () => {
		const ctx = setup({ prepare: (fake) => fake.route("/users/self/observees", { hang: true }) });
		ctx.helper.socketNotificationReceived("CANVASGRADES_REGISTER", {
			instanceId: "module_1",
			config: { canvasUrl: URL_BASE, accessToken: TOKEN }
		});
		await waitFor(() => ctx.fake.calls.length === 1, "the first request");
		const inst = ctx.helper.instances.get("module_1");
		const sentBefore = ctx.sent.length;
		ctx.helper.stop();
		await inst.runPromise;
		assert.equal(ctx.fake.calls[0].signal.aborted, true);
		assert.equal(ctx.pending().length, 0);
		assert.equal(ctx.sent.length, sentBefore);
		assert.equal(ctx.helper.instances.size, 0);
		assert.equal(inst.phase, "stopped");
	});

	it("a replaced instance never publishes late results", async () => {
		const ctx = setup({ prepare: (fake) => fake.route("/users/self/observees", { hang: true }) });
		ctx.helper.socketNotificationReceived("CANVASGRADES_REGISTER", {
			instanceId: "module_1",
			config: { canvasUrl: URL_BASE, accessToken: TOKEN }
		});
		await waitFor(() => ctx.fake.calls.length === 1, "the first request");
		const old = ctx.helper.instances.get("module_1");
		ctx.helper.socketNotificationReceived("CANVASGRADES_REGISTER", {
			instanceId: "module_1",
			config: { canvasUrl: URL_BASE, accessToken: TOKEN, students: ["2001"] }
		});
		await waitFor(() => ctx.fake.calls.length === 2, "the second request");
		assert.equal(ctx.fake.calls[0].signal.aborted, true);
		assert.equal(old.phase, "stopped");
		assert.notEqual(ctx.helper.instances.get("module_1"), old);
		await old.runPromise;
		assert.equal(ctx.sent.filter((entry) => entry.payload.status === "ok").length, 0);
	});

	it("stays flat over 500 accelerated cycles", async () => {
		const ctx = setup();
		await ctx.register("module_1", { students: ["2001"] });
		const inst = ctx.helper.instances.get("module_1");
		const keys = Object.keys(inst).length;
		const students = inst.snapshot.students.length;
		const courses = inst.snapshot.students[0].courses.length;
		for (let i = 0; i < 500; i += 1) {
			ctx.fake.calls.length = 0;
			ctx.timers.splice(0, ctx.timers.length - 1);
			ctx.clock.now += INTERVAL;
			await ctx.fire("module_1");
			assert.equal(ctx.pending().length, 1, `one pending timer after cycle ${i}`);
		}
		assert.equal(ctx.helper.instances.size, 1);
		assert.equal(Object.keys(inst).length, keys);
		assert.equal(inst.snapshot.students.length, students);
		assert.equal(inst.snapshot.students[0].courses.length, courses);
		assert.equal(ctx.helper.cachePaths.size, 0);
		assert.equal(inst.phase, "running");
	});
});
