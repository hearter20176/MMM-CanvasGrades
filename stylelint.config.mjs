/** @type {import("stylelint").Config} */
export default {
	extends: ["stylelint-config-standard"],
	ignoreFiles: ["node_modules/**", "coverage/**", "docs/**"],
	rules: {
		// Allow kebab-case cg-* classes plus the MagicMirror/Font Awesome/theme classes this module
		// references. MMM-CanvasGrades is the module wrapper class MagicMirror adds.
		"selector-class-pattern": [
			"^(cg-[a-z0-9]+(-[a-z0-9]+)*|MMM-CanvasGrades|module|module-content|fa-[a-z0-9-]+|mm-day|mm-night)$",
			{ message: "Use cg-* class names (or the allowed MagicMirror/theme classes)" }
		]
	}
};
