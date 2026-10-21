# T10 — Dashboard

## Goal
A single page that makes the API demoable in a minute.

## Layout
1. Header: repo selector (registered repos + "add repo"), period presets (30 / 90 / 180
   days) and custom date inputs, sync status pill.
2. KPI row: commits, active authors, churn, truck factor, effective contributors, merged
   PRs — each with the delta vs previous period when available.
3. Weekly activity chart (inline SVG bars, commits per week; previous-period total shown).
4. Narrative panel: headline, summary, findings with evidence chips (hover/focus shows the
   fact's statement, value and source link), hypothesis with a confidence meter showing
   both the model's and the calibrated value, provider badge, degraded notice.
5. Knowledge risk: areas table (directory, churn, authors, owner share) and hotspots
   (silos highlighted).
6. Contributors table, sortable by commits / churn / files / PRs.

## Technical
React + Vite + TypeScript, no UI or chart library (keeps the bundle small and the code
readable). Served by the API from `/` in production, so there is no CORS and one port.
`VITE_SNAPSHOT=1` builds a single self-contained HTML file with pre-fetched API responses
inlined, used for the hosted demo; it shows a "snapshot" badge with the capture time.

## Acceptance criteria
Loads with no console errors; works at 375 px width; respects dark mode; keyboard focus
reveals evidence details.
