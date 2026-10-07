# Preview harness

Static page that renders `MMM-CanvasGrades.js` from fixture payloads, for the README screenshot. Fixture data only.

Serve the module folder over HTTP (browsers block `fetch` on `file://`), for example `npx http-server` in the module root, then open `/test/preview/index.html`.

By default the page shows two compact cards side by side in a 1080 px black frame with the 18 px MagicMirror gutter, like `top_left` and `top_right` on the portrait mirror: two separate module instances at 350 px wide (`compactWidth: 350`) with `showStudentName: true`. The left card is `realistic-student-a` (9 courses, nothing missing), the right card is `realistic-student-b` (11 courses, 3 of them ungraded, 3 missing items with long wrapping names). The page sets `html { font-size: 20px }`, which is what MagicMirror `main.css` does, so rem sizes render at their real size. Screenshot the `#frame` element at device scale 1.

Metrics for headless runs: once both cards have rendered (stylesheets and fonts loaded, plus 300 ms), `#metrics` holds JSON like `{"ready":true,"rootFontPx":20,"left":{"width":350,"height":310,"top":18,"bottom":328},"right":{...}}` and the body gets `data-ready="1"`. For example `chrome --headless --virtual-time-budget=5000 --dump-dom http://localhost:8080/test/preview/index.html` and read the `#metrics` text. Acceptance for the right card: `bottom <= 500` (card height at most 480 px including the gutter). The fonts of a headless machine may differ from the Pi, so treat the numbers as close, not exact.

Query parameters: `width` (card width px, default 350), `layout` (`compact` or `full`; `full` shows only the right card, 1000 px wide), `left` and `right` (any name in `test/fixtures/payloads`; `payload` is an alias for `right`), `columns` (`1` hides the left card), `theme` (`night` or `day`), `now` (ISO time, default `2026-10-06T16:00:00Z`), `anim` (`lottie`, `css` or `none`), `loop` (`loop` or `once`), `lottie` (URL of a local `lottie.min.js` 5.10.2; lottie-web is not installed in this folder, so without it the page shows the CSS pulse fallback).
Font Awesome is loaded from the host MagicMirror install (`../../../../css/font-awesome.css`), so this works when the module sits in `MagicMirror/modules/`.

## CSS class contract (emitted by `MMM-CanvasGrades.js`)

Classes in brackets are conditional. Elements marked "omitted when empty" are not rendered at all when they would have no text.

```text
div.cg-root.cg-layout-full | cg-layout-compact   .cg-state-loading | cg-state-error | cg-state-ok   [.cg-stale] [.cg-reduce-motion] [.cg-warn-once] [.cg-suspended]  (root also carries inline --cg-compact-width)
div.cg-root.cg-empty                              render failure only; style display: none
  div.cg-status [.cg-status-error]                loading and error states, only child of the root
  div.cg-student                                  one per student (ok state)
    div.cg-student-name                           per showStudentName; never rendered empty
    div.cg-notice                                 "No active courses"
    div.cg-missing                                both layouts; above courses
      div.cg-missing-head                         header row of the list
        div.cg-warning.cg-warning-lottie          empty container for the Lottie player; aria-hidden; at most 2 per card
        span.cg-warning.cg-warning-css            CSS fallback or warningAnimation "css"; aria-hidden
          i.cg-warning-icon.fa-solid.fa-triangle-exclamation   aria-hidden; the pulse animation target
        span.cg-missing-title                     text "Missing"
      div.cg-missing-item [.cg-missing-inferred]
        i.cg-missing-icon.fa-solid.fa-circle-exclamation   aria-hidden
        span.cg-missing-name
        span.cg-missing-course
        span.cg-missing-due                       omitted when empty; text like "due Tue", "3 days ago"
        span.cg-missing-points                    omitted when empty; text like "20 pts"
      div.cg-more                                 "+N more"
    div.cg-clear                                  "Nothing missing", both layouts
      i.cg-clear-icon.fa-solid.fa-circle-check    aria-hidden
      span.cg-clear-text
    div.cg-courses
      div.cg-course [.cg-course-hidden] [.cg-course-failed] [.cg-course-has-missing]
        span.cg-course-name
        span.cg-course-grade.cg-grade-letter | cg-grade-percent | cg-grade-both | cg-grade-none
        span.cg-period-note                       text "total"; only when the course total replaced a missing grading period
        span.cg-badge                             only when missingCount > 0; aria-label "N missing"
          i.cg-badge-icon.fa-solid.fa-circle-exclamation   aria-hidden
          span.cg-badge-count
    div.cg-recent                                 full layout only, when there are recent grades
      div.cg-recent-item
        span.cg-recent-name
        span.cg-recent-course
        span.cg-recent-score
        span.cg-marker.cg-marker-late             contains i.fa-solid.fa-clock (aria-hidden) and span "late"
        span.cg-marker.cg-marker-excused          text "EX"
        span.cg-marker.cg-marker-hidden           contains i.fa-solid.fa-eye-slash (aria-hidden); aria-label "grade hidden"
  div.cg-footer [.cg-footer-stale] [.cg-footer-partial]   ok state only, when stale or partial
```

The root always has exactly one of the three `cg-state-*` classes and one `cg-layout-*` class. `cg-stale` is on the root, so `.cg-stale .cg-student` dims the content while `.cg-footer` can stay at full opacity.

`cg-reduce-motion` is on the root when `reduceMotion` is set or `prefers-reduced-motion` matches: the pulse on `.cg-warning-css` should be disabled there (the graphic stays visible, static). Each `cg-warning` appears once per student block that has missing items, never per item. Only one of `cg-warning-lottie` and `cg-warning-css` is used per block.

`cg-warn-once` is on the root when `warningLoop` is `once` (the CSS pulse should then run 3 iterations). `cg-suspended` is on the root while the module is suspended or hidden (set in `suspend()`, removed in `resume()`, and applied to every newly built root); use `.cg-root.cg-suspended .cg-warning-icon { animation-play-state: paused; }`.

Subject styling (v1.2): `.cg-course`, `.cg-missing-item` and `.cg-recent-item` each carry an inline `--cg-subject` custom property (payload colour, else `#9ca3af`). `i.cg-course-icon` (classes from the payload icon, else `fa-regular fa-calendar`; aria-hidden) is the first child of `.cg-course` and the first child of `.cg-missing-course` and `.cg-recent-course`; those two spans now contain `i.cg-course-icon` plus `span.cg-subject-name` (the text). The warning accent on `.cg-missing-icon` is separate and unchanged. The icon fonts for `bx ...` (Boxicons) and `iconoir-...` classes are only present when another module on the page loads them.

Additions (v1.2.x): `variant=more` swaps the right card for `realistic-student-b-more` (4 missing items shown plus "+2 more", 6 missing in total). `#metrics` also reports `warnings` with the number of Lottie containers holding an svg (`lottie`), empty ones (`lottieEmpty`) and CSS fallback icons (`css`); the page waits up to 4 s for the svg before publishing, so with `lottie=<url of lottie.min.js>` the metrics are ready only once the graphic is drawn. For a still screenshot of the Lottie graphic use `loop=once` and capture after `data-ready="1"` (the animation keeps playing between frames, so exact frames vary). The root may also carry `cg-subject-name-color` (option `subjectNameColor: true`): colour the course label text too; by default only the icon and a left border take the subject colour. Icon classes from the payload never contain Font Awesome animation tokens (`fa-spin`, `fa-beat`, `fa-fade`, `fa-pulse` and so on are dropped).
