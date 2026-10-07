"use strict";

// Minimal DOM for testing MMM-CanvasGrades.js without a browser. Supports createElement,
// appendChild, classList, setAttribute and class/tag selectors (compound and descendant).
// innerHTML is deliberately a trap: the module must never use it.

class FakeClassList {
	constructor(el) {
		this.el = el;
	}

	_list() {
		return this.el.className.split(/\s+/).filter(Boolean);
	}

	contains(c) {
		return this._list().includes(c);
	}

	add(c) {
		if (!this.contains(c)) this.el.className = [...this._list(), c].join(" ");
	}

	remove(c) {
		this.el.className = this._list()
			.filter((x) => x !== c)
			.join(" ");
	}
}

function matchesCompound(el, compound) {
	const m = /^([a-zA-Z][a-zA-Z0-9]*)?((?:\.[A-Za-z0-9_-]+)*)$/.exec(compound);
	if (!m) throw new Error("unsupported selector: " + compound);
	if (m[1] && el.tagName.toLowerCase() !== m[1].toLowerCase()) return false;
	const classes = m[2].split(".").filter(Boolean);
	return classes.every((c) => el.classList.contains(c));
}

class FakeElement {
	constructor(tagName) {
		this.tagName = String(tagName).toUpperCase();
		this.className = "";
		this.textContent = "";
		this.children = [];
		this.parent = null;
		this.isConnected = false;
		this.style = {};
		this.attributes = {};
		this.classList = new FakeClassList(this);
	}

	get innerHTML() {
		throw new Error("innerHTML must not be used");
	}

	set innerHTML(_value) {
		throw new Error("innerHTML must not be used");
	}

	appendChild(child) {
		child.parent = this;
		this.children.push(child);
		return child;
	}

	setAttribute(name, value) {
		this.attributes[name] = String(value);
	}

	getAttribute(name) {
		return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
	}

	_descendants() {
		const out = [];
		for (const child of this.children) out.push(child, ...child._descendants());
		return out;
	}

	_matchesChain(parts) {
		if (!matchesCompound(this, parts[parts.length - 1])) return false;
		if (parts.length === 1) return true;
		let el = this.parent;
		while (el) {
			if (el._matchesChain(parts.slice(0, -1))) return true;
			el = el.parent;
		}
		return false;
	}

	querySelectorAll(selector) {
		const parts = selector.trim().split(/\s+/);
		return this._descendants().filter((el) => el._matchesChain(parts));
	}

	querySelector(selector) {
		return this.querySelectorAll(selector)[0] || null;
	}
}

// All text under an element, depth first, single-space separated.
function textOf(el) {
	return [el.textContent, ...el.children.map(textOf)].filter(Boolean).join(" ");
}

// Text of every match, in document order.
function textsOf(root, selector) {
	return root.querySelectorAll(selector).map(textOf);
}

// Marks an element tree as attached to (or detached from) the document, like MagicMirror does
// when it swaps the module DOM.
function setConnected(el, value) {
	el.isConnected = value;
	for (const child of el.children) setConnected(child, value);
}

function mount(el) {
	setConnected(el, true);
	return el;
}

function unmount(el) {
	setConnected(el, false);
	return el;
}

function hasClass(el, c) {
	return el.classList.contains(c);
}

function install(target) {
	const body = new FakeElement("body");
	body.isConnected = true;
	target.document = {
		body,
		createElement: (tag) => new FakeElement(tag)
	};
}

module.exports = { FakeElement, FakeClassList, textOf, textsOf, hasClass, mount, unmount, install };
