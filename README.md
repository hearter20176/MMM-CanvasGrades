# MMM-CanvasGrades

A [MagicMirror²](https://magicmirror.builders) module for parents. It signs in to Canvas LMS as the parent (observer) account and shows each linked student's course grades and, above all, the work that is missing.

![MMM-CanvasGrades showing two students in the compact layout](docs/screenshot.png)

_Sample data. Student names, courses and grades are fictional._

## What it shows

For every student linked to the observer account:

- One row per course with the current grade (letter, percent or both) and a badge when work is missing.
- A "Missing" list (full layout): assignment, course, due date relative to today ("due Tue", "3 days ago") and points.
- Optionally the most recent graded assignments, with late, excused and hidden markers.

The module always tells you which of these states it is in:

| State           | What you see                                                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Loading         | A dim "Loading grades..." line, until the first fetch finishes.                                                                            |
| OK              | Course rows, the missing list and (if enabled) recent grades.                                                                              |
| Nothing missing | Course rows and a calm "Nothing missing" line.                                                                                             |
| Stale           | The last data, dimmed, with a footer such as "Updated 2 h ago - Canvas unreachable". Data is never discarded because of a temporary error. |
| Partial         | Whatever loaded, with the footer "Some courses could not be loaded".                                                                       |
| Error           | One specific line (token rejected, Canvas unreachable, and so on). See [Troubleshooting](#troubleshooting).                                |

## Requirements

- MagicMirror² (2.33 itself needs Node 22.18 or newer). The module runs on any Node version from 20 up, and has no runtime dependencies.
- A Canvas parent (observer) account that can create an access token. Some schools disable user-generated tokens; if the "New Access Token" button is missing in step 2 below, ask the school.

## Installation

```sh
cd ~/MagicMirror/modules
git clone https://github.com/hearter20176/MMM-CanvasGrades
```

No `npm install` is needed to run the module; it has no runtime dependencies.

Before you add a token, make sure the mirror is not reachable from networks you do not trust: in `config.js` keep `address: "localhost"` (or the mirror's own address) and set `ipWhitelist`. See [Who can talk to the module](#who-can-talk-to-the-module).

## Update

```sh
cd ~/MagicMirror/modules/MMM-CanvasGrades
git pull
```

No `npm install` is needed after an update either.

## Access token

1. Log in to Canvas as the parent (observer) account in a browser.
2. Open Account > Settings > Approved Integrations > New Access Token. Give it a purpose such as "MagicMirror" and, if the school allows, no expiry.
3. Copy the token. Canvas shows it only once.
4. Save it on the mirror in a file that only contains the token, and make the file private:

```sh
nano ~/MagicMirror/config/canvas-token
chmod 600 ~/MagicMirror/config/canvas-token
```

The module looks for the token in this order and uses the first one that is set:

1. `accessToken` in the module config.
2. `accessTokenFile` (a file inside the MagicMirror² `config` folder, named `canvas-token` or `canvas-token-<anything>`, absolute or relative to the MagicMirror² folder; any other file name or location is refused).
3. The `CANVAS_ACCESS_TOKEN` environment variable.

`config.js` is served to every browser that opens the mirror page, so a token written inline as `accessToken` is visible there. Prefer `accessTokenFile`. The file is read again on every update, so replacing the token takes effect without a restart. If you set `accessTokenFile` and the file cannot be read, the module reports an error rather than silently trying the environment variable.

## Configuration

Add the module to `config.js`. A compact column in a side region:

```js
{
  module: "MMM-CanvasGrades",
  position: "top_right",
  header: "Grades",
  config: {
    canvasUrl: "https://canvas.example.edu",
    accessTokenFile: "config/canvas-token",
    layout: "compact",
    excludeCourses: ["1005"],
  },
},
```

One instance per student, in different regions, each with its own cache if you use one:

```js
{
  module: "MMM-CanvasGrades",
  position: "top_left",
  header: "Student A",
  config: {
    canvasUrl: "https://canvas.example.edu",
    accessTokenFile: "config/canvas-token",
    students: ["2001"],
    layout: "compact",
    cache: true,
  },
},
```

The "observee" IDs used by `students` are Canvas user IDs. While you are logged in to Canvas as the parent, open `https://canvas.example.edu/api/v1/users/self/observees` (with your school's address) in the same browser. The page lists each linked student with an `id`. Course IDs for `courses`, `excludeCourses` and `courseLabels` are the numbers in the course URL (`/courses/1001`).

### Options

| Option                   | Default     | Description                                                                                                                                                                                                                  |
| ------------------------ | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `canvasUrl`              | `""`        | Required. Your school's Canvas address, `https://` only. A trailing slash or `/api/v1` is removed for you.                                                                                                                   |
| `accessToken`            | `""`        | Canvas token. Visible to browsers; prefer `accessTokenFile`.                                                                                                                                                                 |
| `accessTokenFile`        | `""`        | Path to a file that contains only the token. It must be inside the MagicMirror² `config` folder and named `canvas-token` or `canvas-token-<anything>`; other files there (for example other modules' tokens) are never read. |
| `students`               | `[]`        | Canvas user IDs to show, in display order. Empty shows every linked student.                                                                                                                                                 |
| `studentLabels`          | `{}`        | Map of Canvas user ID to a display label, for example `{ "2001": "A." }`.                                                                                                                                                    |
| `nameDisplay`            | `"short"`   | `"full"`, `"short"` (Canvas short name), `"initials"` or `"none"`.                                                                                                                                                           |
| `showStudentName`        | `"auto"`    | `"auto"` (only with more than one student), `true` or `false`.                                                                                                                                                               |
| `courses`                | `[]`        | Course IDs to include, in this order. Empty shows all active courses.                                                                                                                                                        |
| `excludeCourses`         | `[]`        | Course IDs to hide, such as a homeroom.                                                                                                                                                                                      |
| `courseLabels`           | `{}`        | Map of course ID to a short display name.                                                                                                                                                                                    |
| `maxCourseNameLength`    | `24`        | Course names longer than this (8 to 80) are cut with "...".                                                                                                                                                                  |
| `gradeDisplay`           | `"auto"`    | `"auto"` (letter if the course has one, else percent), `"letter"`, `"percent"` or `"both"`.                                                                                                                                  |
| `scoreType`              | `"current"` | `"current"` (ungraded work ignored) or `"final"` (ungraded counts as zero).                                                                                                                                                  |
| `gradingPeriod`          | `"current"` | `"current"` grading period or `"all"` (course total).                                                                                                                                                                        |
| `showCourseGrades`       | `true`      | Show the per-course grade rows.                                                                                                                                                                                              |
| `showMissing`            | `true`      | Fetch and show missing work.                                                                                                                                                                                                 |
| `maxMissing`             | `8`         | Most missing rows per student (1 to 30); the rest show as "+N more".                                                                                                                                                         |
| `missingLookbackDays`    | `30`        | Ignore missing work due more than this many days ago. `0` means no limit.                                                                                                                                                    |
| `inferMissing`           | `true`      | Also treat unsubmitted, past-due, online-submission work as missing when Canvas has not flagged it.                                                                                                                          |
| `showRecentGrades`       | `0`         | Show the N most recently graded assignments per student (0 to 10). `0` is off.                                                                                                                                               |
| `recentGradesDays`       | `7`         | Only grades posted within this many days.                                                                                                                                                                                    |
| `assignmentScoreDisplay` | `"auto"`    | `"auto"` (follow each assignment's grading type), `"points"`, `"percent"` or `"letter"`.                                                                                                                                     |
| `layout`                 | `"full"`    | `"full"` for wide regions, `"compact"` for side columns (course, grade and missing count only).                                                                                                                              |
| `updateInterval`         | `1800000`   | Milliseconds between updates (30 minutes). Minimum 5 minutes.                                                                                                                                                                |
| `requestTimeout`         | `20000`     | Milliseconds allowed per request (5000 to 30000; MagicMirror² itself cuts requests off after 30 seconds).                                                                                                                    |
| `staleAfter`             | `0`         | Milliseconds after the last good update before data is marked stale. `0` means twice `updateInterval` plus 5 minutes.                                                                                                        |
| `errorGraceSeconds`      | `120`       | A temporary error with no data yet keeps showing "Loading" for this long before an error is shown.                                                                                                                           |
| `pauseBetween`           | `null`      | Quiet hours such as `["22:00", "06:00"]` (mirror local time). No updates inside the window; one runs when it ends.                                                                                                           |
| `cache`                  | `false`     | Keep the last good data on disk so a restart during an outage shows stale data. The module chooses the file itself (`config/canvas-grades-cache-<id>.json`); it cannot be set.                                               |
| `locale`                 | `""`        | Language for dates and numbers, such as `"en-US"`. Empty uses the browser locale.                                                                                                                                            |
| `timeFormat`             | `12`        | `12` or `24`, for due times.                                                                                                                                                                                                 |
| `animationSpeed`         | `1000`      | Fade time in milliseconds when the display updates.                                                                                                                                                                          |

Unknown values of the options the helper reads fall back to the default and a warning is written to the MagicMirror² log. The display-only options (`layout`, `showStudentName`, `timeFormat`, `errorGraceSeconds`, `animationSpeed`) fall back to their defaults silently.

## Placement

The module is designed for the portrait corner and third regions: `top_left`, `top_right`, `bottom_left` and `bottom_right` with `layout: "compact"` (a column of roughly 500 px), or `upper_third`, `middle_center` and `lower_third` with `layout: "full"` (up to about 1000 px wide). It is not intended for `top_bar`, `bottom_bar` or the fullscreen regions. Height is bounded by `maxMissing`, `showRecentGrades` and the number of courses.

## How missing work is decided

Canvas's own "missing" flag is trusted first. The module then applies these rules to each assignment, in order:

1. Excused work is never missing.
2. Work with an extension (late policy status "extended") is not shown as missing, because Canvas does not tell an observer when the extension ends.
3. Work Canvas flags as missing is missing, including work a teacher marked missing and work given zero by a missing-work policy.
4. Work that was later graded with a real score is shown as graded (a "late" marker appears in recent grades), not as missing, even if Canvas still carries the old flag.
5. Work whose grade has not been posted yet shows as "Hidden" and is not counted as missing.
6. With `inferMissing` on, an unsubmitted assignment that is past due, published, graded, and accepts online submissions is also treated as missing. This can show work a teacher collects in class but sets up as an online assignment; set `inferMissing` to `false` if that happens.
7. Assignments with no due date, "not graded" assignments, unpublished assignments and locked assignments are never inferred as missing.

Due dates are the student's own due date where Canvas provides one. Past-due comparisons use absolute time, and dates are shown in the mirror's local time. If Canvas's `missing_submissions` endpoint is available to your account it is combined with the above and duplicates are removed; if it is refused, the module quietly works from each course's submissions instead.

## Privacy

- The token is used only by the module's helper process on the mirror. It is never sent to the browser by the module, never written to the log and never written to the cache file.
- The browser receives a display-ready summary: names, grades and dates. It does not receive Canvas IDs, Canvas URLs or raw API responses.
- The log (info level) contains counts and state changes only. Student and course names appear only at debug level.
- Requests are sent only to the host in `canvasUrl`. Canvas pagination links that point to any other host are ignored, and redirects are refused.
- The optional cache file contains the same display-ready summary and is created with mode 600.

### Who can talk to the module

MagicMirror² lets any browser that can reach the mirror's port send the module messages, and the module cannot tell a genuine page from a hostile one. The module therefore limits what such a message can do:

- All stored tokens (`accessTokenFile` and `CANVAS_ACCESS_TOKEN` together) are bound to one Canvas host for the life of the process: the first registration with a usable token wins, and a later registration for any other host is refused, makes no request, and shows the configuration error. A token written inline as `accessToken` belongs to whoever supplied it and is not bound. To use a second school, run a second MagicMirror² instance.
- Set the `CANVAS_URL` environment variable to your school's address (strongly recommended). It is a hard pin: stored tokens are then only ever sent to that host, and there is no first-registration race.
- `accessTokenFile` must be inside the MagicMirror² `config` folder (symlinks are resolved, so a link pointing outside is refused) and must be named `canvas-token` or `canvas-token-<anything>`. The `config` folder often holds other secrets, such as a Home Assistant token; the name rule keeps a hostile message from pointing the module at them. The refusal is logged without reading or printing the file.
- No message can choose a file to write. The cache file name is derived by the module, only an existing valid cache file is ever replaced, and symlinks are not followed. After each write the module deletes its own older cache files that are no longer in use (valid cache files only; it keeps the newest 8 and removes any older than 30 days). The old `cacheFile` option is ignored (with a log warning); use `cache: true`.
- After an instance has registered, later messages cannot change its `canvasUrl` or token source. Restart MagicMirror² after editing those options.

Keep the mirror's port off untrusted networks: in `config.js` leave `address` at `"localhost"` (or set it to the mirror's own address) and set `ipWhitelist` to the machines that should reach it. These checks are a second line of defence.

## Troubleshooting

| What the mirror shows                                                   | Cause and fix                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Canvas URL or token not set"                                           | `canvasUrl` is empty or not an `https://` address, or no token is configured. The log names the option that is missing.                                                                                                                                                                                                                                                |
| "Canvas token file could not be read"                                   | `accessTokenFile` is missing, empty, unreadable, outside the `config` folder, or not named `canvas-token` / `canvas-token-<anything>`. The log gives the file name and reason (never its content). The module re-checks every update interval.                                                                                                                         |
| "Canvas URL or token not set" with a log line "canvasUrl refused"       | A stored token is already bound to a different Canvas host in this process, or `canvasUrl` does not match `CANVAS_URL`. Use the same host everywhere and restart MagicMirror² after changing it.                                                                                                                                                                       |
| "Canvas token rejected - generate a new one"                            | Canvas answered 401: the token was revoked, expired or mistyped. Create a new token and replace the file contents. The module notices the change without a restart and retries once every 6 hours otherwise.                                                                                                                                                           |
| "1 configured student not found" (or "2 configured students not found") | One or more IDs in `students` match no student linked to the account, so that child is not shown. Fix the ID (see [Configuration](#configuration)). The log names the IDs once, at warning level.                                                                                                                                                                      |
| "No linked students found for this account"                             | The observer account has no linked students, or none of the IDs in `students` match. When only some IDs in `students` match, the others are skipped and named in a log warning. Check the IDs as described under [Configuration](#configuration).                                                                                                                      |
| "Canvas denied access for this account"                                 | Canvas refused a required request (HTTP 403). The module retries every 6 hours. Check with the school that the observer link is active.                                                                                                                                                                                                                                |
| "Cannot reach Canvas"                                                   | Network, DNS, timeout or server error. It also appears when `canvasUrl` redirects (a vanity domain, `http` to `https`, a different path): the module refuses redirects so the token never leaves the configured host, and the log says so. Use the final `https` address shown in the browser's address bar. The module retries with growing delays (1 to 15 minutes). |
| "Canvas rate limit - retrying"                                          | Canvas throttled the token. The module backs off and retries; try a longer `updateInterval`.                                                                                                                                                                                                                                                                           |
| "Updated 3 h ago - Canvas unreachable"                                  | The data shown is the last good update, and the latest attempt failed.                                                                                                                                                                                                                                                                                                 |
| "Some courses could not be loaded"                                      | One or more courses refused or failed to return submissions. The rest are shown.                                                                                                                                                                                                                                                                                       |
| A grade shows "--"                                                      | The course hides final grades from observers, or Canvas returned no score yet.                                                                                                                                                                                                                                                                                         |
| A grade shows "total" next to it                                        | Between grading periods, so the course total is shown instead of a period grade.                                                                                                                                                                                                                                                                                       |

To get more detail, run MagicMirror² with debug logging enabled and look for lines starting with `[MMM-CanvasGrades]`.

## Tests

The tests use only Node's built-in test runner and need no packages:

```sh
cd ~/MagicMirror/modules/MMM-CanvasGrades
node --test test/*.test.js
```

To run the linters and formatters as well, install the development dependencies (Node 22 or newer for `node --run`):

```sh
npm install
node --run test
node --run check
```

## License

MIT. See [LICENSE](LICENSE).
