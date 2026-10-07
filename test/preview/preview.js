/* Static preview harness for MMM-CanvasGrades. Serve the module folder over HTTP (for example
 * `npx http-server` in the module root) and open:
 *   test/preview/index.html?layout=compact&payload=ok-two-students
 * Query: layout=compact|full, payload=<name of a file in test/fixtures/payloads>,
 *        theme=night|day, now=<ISO time, default 2026-10-06T16:00:00Z>.
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

	window.CGPreview = {
		run: function () {
			var layout = param("layout", "compact") === "full" ? "full" : "compact";
			var payloadName = param("payload", "ok-two-students").replace(/[^a-z0-9-]/gi, "");
			var now = Date.parse(param("now", "2026-10-06T16:00:00Z"));
			document.body.className = param("theme", "night") === "day" ? "mm-day" : "mm-night";

			var moduleEl = document.getElementById("module_preview_MMM-CanvasGrades");
			if (layout === "full") moduleEl.className += " cg-wide";
			var content = moduleEl.querySelector(".module-content");

			var m = Object.create(definition);
			m.identifier = "module_preview_MMM-CanvasGrades";
			m.hidden = false;
			m.config = Object.assign({}, definition.defaults, { layout: layout, showRecentGrades: 3, locale: "en-US" });
			m._now = function () {
				return now;
			};
			m.sendSocketNotification = function () {};
			m.updateDom = function () {
				content.replaceChildren(m.getDom());
			};
			m.start();
			// Single render pass: no minute tick needed for a static page.
			m.suspend();
			m.hidden = true;

			fetch("../fixtures/payloads/" + payloadName + ".json")
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
					content.textContent = "Could not load fixture: " + payloadName;
				});
		}
	};
})();
