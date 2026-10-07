/* Static preview harness for MMM-CanvasGrades. Serve the module folder over HTTP (for example
 * `npx http-server` in the module root) and open:
 *   test/preview/index.html
 * Default: two compact cards side by side (top_left with realistic-student-a: 9 courses, nothing
 * missing; top_right with realistic-student-b: 11 courses of which 3 ungraded, 3 missing items),
 * each its own module instance and 350 px wide (compactWidth), in a 1080 px frame with the
 * MagicMirror gutter of 18 px and html font-size 20px.
 * After both cards render, #metrics receives JSON such as
 *   {"ready":true,"rootFontPx":20,"left":{"width":350,"height":300,"top":18,"bottom":318},"right":{...}}
 * for headless dump-dom (the body also gets data-ready="1"). Acceptance for the right card:
 * bottom <= 500, that is a card height including the 18 px gutter of at most 480.
 * Query: layout=compact|full (full shows only the right module, wide),
 *        left=<fixture name>, right=<fixture name> (files in test/fixtures/payloads),
 *        payload=<name> (alias for right), variant=more (right card becomes
 *        realistic-student-b-more: 4 missing items shown plus "+2 more"), columns=1|2 (1 hides the left card),
 *        width=<card width px, default 350; also passed as compactWidth>,
 *        theme=night|day, now=<ISO time, default 2026-10-06T16:00:00Z>,
 *        anim=lottie|css|none (default lottie), loop=loop|once,
 *        lottie=<URL of lottie.min.js, default ../../node_modules/lottie-web/build/player/lottie.min.js>.
 * The Lottie graphic needs lottie-web (not installed in this folder): pass lottie= pointing at a
 * local copy of lottie.min.js (version 5.10.2) served by the same http server. When the script
 * cannot be loaded the module falls back to the CSS pulse icon, which is what the page shows.
 * Fixture data only. No network access beyond the local fixture files.
 */
(function () {
	var definition = null;

	// Minimal stand-ins for the MagicMirror globals the module expects.
	window.Module = {
		register: function (name, def) {
			definition = def;
		}
	};
	window.Log = { info: function () {}, warn: function () {}, error: function () {} };

	function param(name, fallback) {
		var v = new URLSearchParams(window.location.search).get(name);
		return v === null || v === "" ? fallback : v;
	}

	function clean(name) {
		return name.replace(/[^a-z0-9-]/gi, "");
	}

	function mountModule(side, fixture, layout, now) {
		var moduleEl = document.getElementById("module_" + side + "_MMM-CanvasGrades");
		if (layout === "full") moduleEl.className += " cg-wide";
		else moduleEl.style.width = param("width", "350") + "px";
		var content = moduleEl.querySelector(".module-content");

		var m = Object.create(definition);
		m.identifier = "module_" + side + "_MMM-CanvasGrades";
		m.hidden = false;
		m.config = Object.assign({}, definition.defaults, {
			layout: layout,
			compactWidth: Number(param("width", "350")),
			showStudentName: true,
			showRecentGrades: 3,
			locale: "en-US",
			warningAnimation: param("anim", "lottie"),
			warningLoop: param("loop", "loop")
		});
		var lottieUrl = param("lottie", "../../node_modules/lottie-web/build/player/lottie.min.js");
		m.name = "MMM-CanvasGrades";
		// MagicMirror resolves module files under modules/<name>/; here they sit two levels up.
		m.file = function (path) {
			return path.indexOf("node_modules/lottie-web/") === 0 ? lottieUrl : "../../" + path;
		};
		m._now = function () {
			return now;
		};
		m.sendSocketNotification = function () {};
		m.updateDom = function () {
			content.replaceChildren(m.getDom());
			// MagicMirror sends this after each swap; it binds the Lottie containers.
			m.notificationReceived("MODULE_DOM_UPDATED", null, undefined);
		};
		m.start();
		// Static page: the minute tick is not needed, the Lottie lifecycle stays active.
		m._stopTick();

		return fetch("../fixtures/payloads/" + fixture + ".json")
			.then(function (res) {
				return res.json();
			})
			.then(function (payload) {
				// Fixture timestamps are relative to 2026-10-06T16:00:00Z.
				if (typeof payload.fetchedAt === "number") {
					payload.fetchedAt = now - (Date.parse("2026-10-06T16:00:00Z") - payload.fetchedAt);
				}
				payload.instanceId = m.identifier;
				m.socketNotificationReceived("CANVASGRADES_STATE", payload);
			})
			.catch(function () {
				content.textContent = "Could not load fixture: " + fixture;
			})
			.then(function () {
				return { side: side, el: moduleEl };
			});
	}

	function measure(moduleEl) {
		var card = moduleEl.querySelector(".cg-root") || moduleEl;
		var r = card.getBoundingClientRect();
		return {
			width: Math.round(r.width * 10) / 10,
			height: Math.round(r.height * 10) / 10,
			top: Math.round(r.top * 10) / 10,
			bottom: Math.round(r.bottom * 10) / 10
		};
	}

	// Waits for the stylesheets and fonts, then writes the numbers a headless browser can read.
	function publishMetrics(modules) {
		var done = function () {
			var out = { ready: true, rootFontPx: parseFloat(getComputedStyle(document.documentElement).fontSize) };
			// What the warning graphic ended up as: Lottie svg, CSS pulse icon, or nothing.
			out.warnings = {
				lottie: document.querySelectorAll(".cg-warning-lottie svg").length,
				lottieEmpty: document.querySelectorAll(".cg-warning-lottie:not(:has(svg))").length,
				css: document.querySelectorAll(".cg-warning-css").length
			};
			modules.forEach(function (entry) {
				if (entry.el.offsetParent !== null) out[entry.side] = measure(entry.el);
			});
			document.getElementById("metrics").textContent = JSON.stringify(out);
			document.body.setAttribute("data-ready", "1");
		};
		var afterLoad = function () {
			var fonts = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
			fonts.then(function () {
				// Wait (at most 4 s) until every Lottie container holds its svg or has fallen back
				// to the CSS icon, then let layout settle.
				var started = Date.now();
				var poll = function () {
					var pending = document.querySelectorAll(".cg-warning-lottie:not(:has(svg))").length;
					if (pending === 0 || Date.now() - started > 4000) setTimeout(done, 300);
					else setTimeout(poll, 100);
				};
				poll();
			});
		};
		if (document.readyState === "complete") afterLoad();
		else window.addEventListener("load", afterLoad);
	}

	window.CGPreview = {
		run: function () {
			var layout = param("layout", "compact") === "full" ? "full" : "compact";
			var now = Date.parse(param("now", "2026-10-06T16:00:00Z"));
			document.body.className = param("theme", "night") === "day" ? "mm-day" : "mm-night";

			var variant = param("variant", "") === "more" ? "realistic-student-b-more" : "realistic-student-b";
			var right = clean(param("right", param("payload", variant)));
			var left = clean(param("left", "realistic-student-a"));
			var twoColumns = layout === "compact" && param("columns", "2") !== "1";

			if (!twoColumns) document.getElementById("region_left").className += " hidden";
			var jobs = [];
			if (twoColumns) jobs.push(mountModule("left", left, layout, now));
			jobs.push(mountModule("right", right, layout, now));
			Promise.all(jobs).then(publishMetrics);
		}
	};
})();
