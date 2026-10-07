# Preview harness

Static page that renders `MMM-CanvasGrades.js` from fixture payloads, for the README screenshot. Fixture data only.

Serve the module folder over HTTP (browsers block `fetch` on `file://`), for example `npx http-server` in the module root, then open
`/test/preview/index.html?layout=compact&payload=ok-two-students`.

Query parameters: `layout` (`compact` or `full`), `payload` (any name in `test/fixtures/payloads`), `theme` (`night` or `day`), `now` (ISO time, default `2026-10-06T16:00:00Z`).
Font Awesome is loaded from the host MagicMirror install (`../../../../css/font-awesome.css`), so this works when the module sits in `MagicMirror/modules/`.

## CSS class contract (emitted by `MMM-CanvasGrades.js`)

Classes in brackets are conditional. Elements marked "omitted when empty" are not rendered at all when they would have no text.

```text
div.cg-root.cg-layout-full | cg-layout-compact   .cg-state-loading | cg-state-error | cg-state-ok   [.cg-stale]
div.cg-root.cg-empty                              render failure only; style display: none
  div.cg-status [.cg-status-error]                loading and error states, only child of the root
  div.cg-student                                  one per student (ok state)
    div.cg-student-name                           per showStudentName; never rendered empty
    div.cg-notice                                 "No active courses"
    div.cg-missing                                full layout (or compact with no course rows); above courses
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
