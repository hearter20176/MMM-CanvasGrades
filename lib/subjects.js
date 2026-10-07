"use strict";

// Subject icons and colours with the same semantics as MMM-MyAgenda (getIconAndColor plus the keyword
// colour loop in MMM-MyAgenda.js):
//
//   icon   = the value of the FIRST key of subjectIcons whose lower-cased text is a substring of the
//            lower-cased course name; none if no key matches.
//   colour = the value of the FIRST key of subjectColors (in its own order) whose lower-cased text is a
//            substring of the course name; none if no key matches. (MyAgenda starts from the colour stored
//            under the matching icon key and then lets this loop override it; that starting value is always
//            found by the loop itself, so the loop alone gives the same result.) The colour match does not
//            depend on the icon key.
//
// "First" means JavaScript property order: keys that look like whole numbers (such as "101") come before
// all other keys, ascending, and the remaining keys follow in the order they were written. Keys are not
// trimmed or otherwise altered except for lower-casing, exactly as MyAgenda does.
//
// Values reach the browser's DOM (a class list and a CSS custom property), so they are validated hard and
// anything invalid is dropped. The keys themselves are never sent to the browser.

const ICON_PATTERN = /^[A-Za-z0-9 _-]{1,64}$/;
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
// same shape the front end accepts, including an optional "deg" on the first (hue) number
const FUNCTION_COLOR = /^(?:rgb|hsl)a?\(\s*[\d.]+(?:deg)?%?(?:\s*[,\s/]\s*[\d.]+%?){2,3}\s*\)$/i;
const NAMED_COLOR = /^[a-z]{3,20}$/i;
const NOT_COLORS = ["inherit", "initial", "unset", "revert", "transparent", "currentcolor"];
// Font Awesome animation classes: a subject icon must never animate (and never cost CPU on the mirror)
const ANIMATION_CLASSES = new Set([
	"fa-spin",
	"fa-spin-pulse",
	"fa-spin-reverse",
	"fa-beat",
	"fa-beat-fade",
	"fa-bounce",
	"fa-fade",
	"fa-flip",
	"fa-shake",
	"fa-pulse"
]);
const MAX_RULES = 100;
const MAX_KEY_LENGTH = 80;

// Returns { icon, stripped } where icon is a clean class list or null.
function cleanIcon(value) {
	if (typeof value !== "string") return { icon: null, stripped: 0 };
	const collapsed = value.replace(/\s+/g, " ").trim();
	if (!ICON_PATTERN.test(collapsed)) return { icon: null, stripped: 0 };
	const kept = [];
	let stripped = 0;
	for (const token of collapsed.split(" ")) {
		if (ANIMATION_CLASSES.has(token.toLowerCase())) stripped += 1;
		else kept.push(token);
	}
	return { icon: kept.length > 0 ? kept.join(" ") : null, stripped };
}

function validIcon(value) {
	return cleanIcon(value).icon;
}

function validColor(value) {
	if (typeof value !== "string") return null;
	const color = value.trim();
	if (HEX_COLOR.test(color) || FUNCTION_COLOR.test(color)) return color;
	if (NAMED_COLOR.test(color) && !NOT_COLORS.includes(color.toLowerCase())) return color.toLowerCase();
	return null;
}

function plainEntries(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	return Object.entries(value).slice(0, MAX_RULES);
}

// Returns { rules, warnings }; rules is { icons: [{ key, icon }], colors: [{ key, color }] } with lower-cased
// keys in match order. A key whose value is invalid still takes its place in the order (it matches, with a
// null value), as the same key would in MyAgenda; the front end then uses its default.
function buildSubjectRules(rawIcons, rawColors) {
	const warnings = [];
	const rules = { icons: [], colors: [] };
	const icons = rawIcons === undefined || rawIcons === null ? [] : plainEntries(rawIcons);
	const colors = rawColors === undefined || rawColors === null ? [] : plainEntries(rawColors);
	if (icons === null)
		warnings.push('Option "subjectIcons" must be an object of subject to icon classes; it was ignored.');
	if (colors === null)
		warnings.push('Option "subjectColors" must be an object of subject to colours; it was ignored.');

	let droppedIcons = 0;
	let strippedIcons = 0;
	let droppedColors = 0;
	for (const [key, value] of icons || []) {
		if (key === "" || key.length > MAX_KEY_LENGTH) continue;
		const { icon, stripped } = cleanIcon(value);
		if (icon === null) droppedIcons += 1;
		strippedIcons += stripped;
		rules.icons.push({ key: key.toLowerCase(), icon });
	}
	for (const [key, value] of colors || []) {
		if (key === "" || key.length > MAX_KEY_LENGTH) continue;
		const color = validColor(value);
		if (color === null) droppedColors += 1;
		rules.colors.push({ key: key.toLowerCase(), color });
	}

	const plural = (n, one, many) => (n === 1 ? one : many);
	const iconParts = [];
	if (droppedIcons > 0)
		iconParts.push(`${droppedIcons} invalid ${plural(droppedIcons, "entry was", "entries were")} dropped`);
	if (strippedIcons > 0)
		iconParts.push(`${strippedIcons} animation ${plural(strippedIcons, "class was", "classes were")} removed`);
	if (iconParts.length > 0) warnings.push(`Option "subjectIcons": ${iconParts.join(", ")}.`);
	if (droppedColors > 0) {
		warnings.push(
			`Option "subjectColors": ${droppedColors} invalid ${plural(droppedColors, "entry was", "entries were")} dropped.`
		);
	}
	return { rules, warnings };
}

// No match gives null for that part; the front end supplies the fallback icon and colour.
function matchSubject(rules, courseName) {
	const none = { icon: null, color: null };
	if (!rules || typeof rules !== "object" || typeof courseName !== "string") return none;
	const lower = courseName.toLowerCase();
	let icon = null;
	for (const rule of rules.icons || []) {
		if (lower.includes(rule.key)) {
			icon = rule.icon;
			break;
		}
	}
	let color = null;
	for (const rule of rules.colors || []) {
		if (lower.includes(rule.key)) {
			color = rule.color;
			break;
		}
	}
	return { icon, color };
}

module.exports = { buildSubjectRules, matchSubject, validIcon, validColor };
