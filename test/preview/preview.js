/* Static preview harness for MMM-CanvasGrades. Serve the module folder over HTTP (for example
 * `npx http-server` in the module root) and open:
 *   test/preview/index.html
 * Default: two compact cards side by side (top_left with single-student, top_right with
 * single-student-b), each its own module instance, in a 1080 px frame with html font-size 20px.
 * Query: layout=compact|full (full shows only the right module, wide),
 *        left=<fixture name>, right=<fixture name> (files in test/fixtures/payloads),
 *        payload=<name> (alias for right), columns=1|2 (1 hides the left card),
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
		var content = moduleEl.querySelector(".module-content");

		var m = Object.create(definition);
		m.identifier = "module_" + side + "_MMM-CanvasGrades";
		m.hidden = false;
		m.config = Object.assign({}, definition.defaults, {
			layout: layout,
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

		fetch("../fixtures/payloads/" + fixture + ".json")
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
			});
	}

	window.CGPreview = {
		run: function () {
			var layout = param("layout", "compact") === "full" ? "full" : "compact";
			var now = Date.parse(param("now", "2026-10-06T16:00:00Z"));
			document.body.className = param("theme", "night") === "day" ? "mm-day" : "mm-night";

			var right = clean(param("right", param("payload", "single-student-b")));
			var left = clean(param("left", "single-student"));
			var twoColumns = layout === "compact" && param("columns", "2") !== "1";

			if (!twoColumns) document.getElementById("region_left").className += " hidden";
			if (twoColumns) mountModule("left", left, layout, now);
			mountModule("right", right, layout, now);
		}
	};
})();
