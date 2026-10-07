"use strict";

// Stand-ins for MagicMirror core's "node_helper" and "logger" modules, which MagicMirror registers as
// aliases at runtime. This repo is tested standalone, so they are stubbed here. Log captures every
// line so tests can assert that nothing sensitive was logged.

const Module = require("node:module");

const Log = {
	lines: [],
	reset() {
		this.lines.length = 0;
	},
	log(message) {
		this.lines.push({ level: "log", message: String(message) });
	},
	info(message) {
		this.lines.push({ level: "info", message: String(message) });
	},
	warn(message) {
		this.lines.push({ level: "warn", message: String(message) });
	},
	error(message) {
		this.lines.push({ level: "error", message: String(message) });
	},
	debug(message) {
		this.lines.push({ level: "debug", message: String(message) });
	}
};

const NodeHelper = {
	create(definition) {
		class Helper {
			setName(name) {
				this.name = name;
			}

			sendSocketNotification() {}
		}
		Object.assign(Helper.prototype, definition);
		return Helper;
	}
};

const originalLoad = Module._load;
Module._load = function load(request, ...rest) {
	if (request === "node_helper") return NodeHelper;
	if (request === "logger") return Log;
	return originalLoad.call(this, request, ...rest);
};

module.exports = { Log, NodeHelper };
