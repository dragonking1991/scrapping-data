## 1. UI and Job Wiring

- [x] 1.1 Add `Ra lai` button and client-side action handlers in `src/ui/server.ts`.
- [x] 1.2 Add backend routes for starting and polling rescan jobs with per-dataset status payloads.
- [x] 1.3 Validate preconditions (active browser session available, source JSON files exist) before starting rescan.

## 2. Missing-Invoice Candidate Discovery

- [x] 2.1 Load `hd_sold.json` and `hd_purchased.json` and collect invoices where `lineItems` is empty.
- [x] 2.2 Build normalized processing keys and deduplicate candidates while preserving dataset origin.
- [x] 2.3 Emit initial counters (queued sold, queued purchased, total) for UI progress tracking.

## 3. Browser Rescan Flow

- [x] 3.1 Implement sold flow: select tab `Tra cuu hoa don dien tu ban ra`, fill `So hoa don`, click search.
- [x] 3.2 Implement purchased flow: select tab `Tra cuu hoa don dien tu mua vao`, fill `So hoa don`, click search.
- [x] 3.3 For each candidate, click matching result row to activate/bold, click invoice-view icon, and extract detail line items.
- [x] 3.4 Handle not-found/selector/session-expired failures by recording reason and continuing remaining invoices.

## 4. Persistence and Recovery

- [x] 4.1 Update only successfully rescanned records in their original JSON dataset.
- [x] 4.2 Persist dataset changes safely (temp file + atomic rename) after successful updates.
- [x] 4.3 Track per-invoice outcomes (success, failed, skipped) and expose them through status API.

## 5. Verification

- [x] 5.1 Run type checks and existing smoke scripts to ensure no regression in current crawl/export paths.
- [ ] 5.2 Validate rescan end-to-end for a sold sample and a purchased sample with empty `lineItems`.
- [ ] 5.3 Verify UI progress and final summary counters match actual JSON updates.
