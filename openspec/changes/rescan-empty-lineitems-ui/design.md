## Context

The current scraping flow can collect invoice detail lines while crawling broad date ranges, but many records in `.gdt-xml-export/hd_sold.json` and `.gdt-xml-export/hd_purchased.json` still contain empty `lineItems`. Operators currently have to inspect and re-run broad jobs manually, even when only a subset of invoices is missing details. The requested change adds a targeted `Ra lai` action in the local UI server that reuses the already-open browser session and only rescans missing invoices by `So hoa don`.

## Goals / Non-Goals

**Goals:**
- Add a UI-triggered rescan job that processes missing `lineItems` for both sold and purchased datasets.
- Reuse the active authenticated browser context and avoid full-login/full-crawl restart.
- For each mode, switch to the correct lookup tab, search by invoice number, open invoice details, and persist extracted line items.
- Expose per-mode progress and outcome counts in the UI so operators can monitor long rescans.

**Non-Goals:**
- Replacing the existing full crawl/export workflow.
- Backfilling invoices that are absent from JSON files.
- Changing aggregation/merge formatting logic for XLSX exports.

## Decisions

1. Reuse existing extraction primitives from the current modal extraction path.
- Rationale: Existing selectors and parsing logic already handle detail modal structure and line item normalization.
- Alternative considered: New scraper dedicated to rescan flow. Rejected due to duplicated selector maintenance.

2. Add a dedicated rescan job pipeline in the UI server instead of overloading the existing `start` route.
- Rationale: Rescan has different inputs, status phases, and data mutation behavior than full crawl.
- Alternative considered: Add flags into existing start flow. Rejected because it increases branching complexity and coupling.

3. Build candidate list from local JSON by filtering invoices where `lineItems` is empty.
- Rationale: Deterministic, fast, and matches user expectation of only missing-detail invoices.
- Alternative considered: Query remote first to decide missing details. Rejected due to unnecessary network/load.

4. Process sold and purchased sequentially within one rescan job, with separate counters.
- Rationale: Simplifies browser-state transitions and status reporting while preserving one-click operator experience.
- Alternative considered: Parallel browser tabs. Rejected for higher flakiness and selector race risks.

5. Persist updates in-place per dataset after each successful invoice extraction.
- Rationale: Reduces data loss risk if job stops mid-run and keeps output files always up to date.
- Alternative considered: Write once at end. Rejected due to larger rollback surface on failure.

## Risks / Trade-offs

- [UI selector drift in government portal] -> Mitigation: keep selectors centralized and reuse existing stable selector helpers.
- [Active session expired mid-run] -> Mitigation: detect session invalid state, stop with explicit status, allow rerun after relogin.
- [Incorrect row selected when search returns multiple entries] -> Mitigation: enforce click on row whose invoice number exactly matches target `So hoa don` before opening view icon.
- [Partial file write corruption] -> Mitigation: write through temp file then atomic rename for each dataset update.
- [Long job opacity] -> Mitigation: include counters for queued, done, failed, skipped and current invoice key in status payload.

## Migration Plan

1. Add server route and UI button for `Ra lai` without removing current controls.
2. Implement dataset scan/filter, per-invoice rescan loop, and persistence.
3. Validate against sample invoices in both sold and purchased tabs.
4. Rollback strategy: hide/disable new button and route if instability appears; existing crawl/export paths remain untouched.

## Open Questions

- Should failed invoice rescans auto-retry once in the same run, or only be reported for manual rerun?
- Should progress endpoint include a downloadable failure list for audit purposes?
