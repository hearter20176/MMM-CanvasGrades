export default {
	useTabs: true,
	tabWidth: 4,
	printWidth: 120,
	trailingComma: "none",
	semi: true,
	singleQuote: false,
	arrowParens: "always",
	endOfLine: "lf",
	overrides: [
		{
			files: ["*.md", "*.yaml", "*.yml", "*.json"],
			options: { useTabs: false, tabWidth: 2, embeddedLanguageFormatting: "off" }
		}
	]
};
