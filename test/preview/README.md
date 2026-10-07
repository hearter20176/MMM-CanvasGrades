# Preview harness

Static page that renders `MMM-CanvasGrades.js` from fixture payloads, for the README screenshot. Fixture data only.

Serve the module folder over HTTP (browsers block `fetch` on `file://`), for example `npx http-server` in the module root, then open `/test/preview/index.html`.

By default the page shows two compact cards side by side in a 1080 px black frame, like `top_left` and `top_right` on the portrait mirror: two separate module instances, `single-student` on the left and `single-student-b` on the right, each 465 px wide (the module default), inside the stock 60 px page margins of MagicMirror² (960 px usable) with `showStudentName: true`. The page sets `html { font-size: 20px }`, which is what MagicMirror `main.css` does, so the em and rem sizes in the module CSS render at their real size. Screenshot the `#frame` element at device scale 1.

Query parameters: `layout` (`compact` or `full`; `full` shows only the right card, 1000 px wide), `left` and `right` (any name in `test/fixtures/payloads`; `payload` is an alias for `right`), `columns` (`1` hides the left card), `theme` (`night` or `day`), `now` (ISO time, default `2026-10-06T16:00:00Z`), `anim` (`lottie`, `css` or `none`), `loop` (`loop` or `once`), `lottie` (URL of a local `lottie.min.js` 5.10.2; lottie-web is not installed in this folder, so without it the page shows the CSS pulse fallback).
Font Awesome is loaded from the host MagicMirror install (`../../../../css/font-awesome.css`), so this works when the module sits in `MagicMirror/modules/`.

## CSS class contract (emitted by `MMM-CanvasGrades.js`)

Classes in brackets are conditional. Elements marked "omitted when empty" are not rendered at all when they would have no text.

```text
div.cg-root.cg-layout-full | cg-layout-compact   .cg-state-loading | cg-state-error | cg-state-ok   [.cg-stale] [.cg-reduce-motion] [.cg-warn-once] [.cg-suspended]
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
