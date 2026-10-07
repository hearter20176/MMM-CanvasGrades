# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/hearter20176/MMM-CanvasGrades/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/hearter20176/MMM-CanvasGrades/releases/tag/v1.0.0
