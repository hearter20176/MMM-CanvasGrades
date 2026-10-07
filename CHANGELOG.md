# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.2.0] - 2026-10-07

### Added

- Subject icons and colours that match MMM-MyAgenda: new options `subjectIcons` and `subjectColors` (same shape as MyAgenda's `iconMapping` and `keywordColors`), matched against the Canvas course name with MyAgenda's first-key-in-order substring rule. Colour-only keys are supported. Values are validated and invalid entries dropped with a warning. Course, missing and recent entries carry `icon` and `color` (or null); the keys are never sent to the browser.
- `hideUngraded` option: omit a course with no grade to show and no missing work (a course with missing work is always kept).
- `compactWidth` option (px, 260 to 700, default 465) for the compact card width; about 350 fits a top row beside a centred clock.
- README section on matching MMM-MyAgenda subject icons and colours.
- Front-end option `subjectNameColor` (default `false`) to also colour the course name, and the `--cg-subject-strength` CSS variable.
- README guidance for sizing a top row beside a clock, with measured heights.

### Changed

- Subject colour matching now follows MMM-MyAgenda exactly: the colour is the first matching key of `subjectColors` in its own order, independent of the icon key. Keys are no longer trimmed, and JavaScript key order (whole-number keys first) is documented.
- Font Awesome animation classes are removed from subject icons, and `hsl()` colours may use a `deg` hue unit, matching the front end.

## [1.1.0] - 2026-10-06

### Added

- Animated warning graphic next to a student's missing list, using the Meteocons "code-orange" Lottie animation (bundled in `animations/`, MIT, credit in the README). New options `warningAnimation` (`"lottie"`, `"css"` or `"none"`) and `warningLoop` (`"loop"`, or `"once"`: 3 plays in total, then rest; the CSS pulse runs 3 iterations then rests, and a suspended module pauses it), and `reduceMotion`. The CSS pulse is also the automatic fallback when Lottie cannot load or the system asks for reduced motion.
- Runtime dependency `lottie-web`, pinned to exactly 5.10.2 on purpose (shared with the Glass modules; Dependabot is told to ignore it). Run `npm ci --omit=dev` after installing or updating.
- Lottie lifecycle that matches the other Glass modules: players are registered per render, bound when attached, paused on suspend, resumed on resume and destroyed when detached, with at most one player per student and two per module instance.

### Changed

- The compact layout now lists the missing assignments by name (course, due date and points), above the course rows, with the usual `maxMissing` cap and "+N more". The compact card is 465 px wide by default (CSS variable `--cg-compact-width`), so two fit side by side inside MagicMirror²'s stock page margins.
- Styling follows the MMM-MyAgenda design tokens so the cards sit naturally beside it in the corner regions.

## [1.0.0] - 2026-10-06

### Added

- Initial release: course grades and missing assignments for the students linked to a Canvas LMS observer account.
- Canvas access through the node helper only, using `accessToken`, `accessTokenFile` or the `CANVAS_ACCESS_TOKEN` environment variable. The token is never sent to the browser or logged.
- Missing-work detection from Canvas flags, the `missing_submissions` endpoint (when the account may use it) and optional inference from past-due unsubmitted online work.
- Optional recent graded assignments, hidden and excused handling, and per-course grade display options (`gradeDisplay`, `scoreType`, `gradingPeriod`).
- Multiple students in one instance, or one instance per student.
- Single serial request queue shared by all instances, Link-header pagination restricted to the configured Canvas host, rate-limit pacing and exponential backoff with jitter.
- Last good data is kept through outages and shown as stale; optional `cache` survives restarts (the module chooses the file); optional `pauseBetween` quiet hours.
- `full` and `compact` layouts for the portrait mirror.
- Unit tests on Node's built-in test runner with a mocked `fetch`, fictional fixtures only, and a repository privacy scan.
- ESLint (flat config), Prettier, markdownlint and stylelint, a GitHub Actions workflow and a Dependabot configuration.

[Unreleased]: https://github.com/hearter20176/MMM-CanvasGrades/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/hearter20176/MMM-CanvasGrades/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/hearter20176/MMM-CanvasGrades/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/hearter20176/MMM-CanvasGrades/releases/tag/v1.0.0
