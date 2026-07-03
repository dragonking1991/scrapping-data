## Why

A large number of invoices in `hd_sold.json` and `hd_purchased.json` still have empty `lineItems`, which causes incomplete downstream exports and manual corrections. A targeted in-session rescan flow is needed to refill missing invoice details without rerunning full crawl jobs.

## What Changes

- Add a new UI action button `Ra lai` to rescan only invoices with empty `lineItems` from both sold and purchased datasets.
- Reuse the currently open authenticated browser session to avoid relogin and reduce captcha friction.
- For sold invoices, switch to tab `Tra cuu hoa don dien tu ban ra`; for purchased invoices, switch to `Tra cuu hoa don dien tu mua vao`.
- For each missing invoice, input `So hoa don`, execute search, click matching result row to set active/bold state, then click the invoice-view icon and extract line-item details.
- Persist refreshed invoice detail payloads back into `.gdt-xml-export/hd_sold.json` and `.gdt-xml-export/hd_purchased.json`, updating only records that were rescanned.
- Provide progress and result status in the UI (queued, processing, success, failed, skipped) for transparency on each dataset.

## Capabilities

### New Capabilities
- `invoice-rescan-empty-lineitems`: Rescan only invoices with empty line items using the active browser session and update local JSON datasets.

### Modified Capabilities
- None.

## Impact

- Affected code: `src/ui/server.ts`, `src/auth/login.ts`, `src/cli.ts`, and extraction helpers reused by modal-detail capture.
- Data artifacts: `.gdt-xml-export/hd_sold.json` and `.gdt-xml-export/hd_purchased.json` receive in-place updates only for matched missing invoices.
- Runtime behavior: introduces a new job type running on existing browser state, with additional progress reporting and failure diagnostics.
- Testing needs: regression checks for existing full crawl/export flow plus targeted tests for sold vs purchased tab switching and per-invoice extraction retry behavior.
