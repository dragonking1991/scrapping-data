## ADDED Requirements

### Requirement: Rescan missing line items from active session
The system SHALL provide a `Ra lai` operation that rescans invoice records whose `lineItems` are empty in both `hd_sold.json` and `hd_purchased.json` using the currently active browser session.

#### Scenario: Build candidate list for both datasets
- **WHEN** the operator starts `Ra lai`
- **THEN** the system identifies all invoices with empty `lineItems` in sold and purchased datasets and creates separate processing queues.

#### Scenario: Prevent run without active session
- **WHEN** `Ra lai` is requested and no active authenticated browser session is available
- **THEN** the system SHALL reject the run with a clear status message indicating relogin is required.

### Requirement: Use correct lookup tab and invoice-number search
The system SHALL execute targeted lookup by `So hoa don` in the correct portal tab for each dataset type.

#### Scenario: Sold invoice lookup flow
- **WHEN** processing a missing invoice from `hd_sold.json`
- **THEN** the system selects tab `Tra cuu hoa don dien tu ban ra`, enters `So hoa don`, and triggers search.

#### Scenario: Purchased invoice lookup flow
- **WHEN** processing a missing invoice from `hd_purchased.json`
- **THEN** the system selects tab `Tra cuu hoa don dien tu mua vao`, enters `So hoa don`, and triggers search.

### Requirement: Select result and open invoice detail view
The system SHALL open invoice detail only after selecting the matching search result row.

#### Scenario: Exact result selection before open
- **WHEN** search results are displayed for a target invoice number
- **THEN** the system clicks the row that matches the target invoice, confirms it becomes active/bold, and then clicks the invoice-view icon.

#### Scenario: Missing result handling
- **WHEN** no row matches the target invoice number
- **THEN** the system marks the invoice as failed with reason `not_found` and continues with the next queued invoice.

### Requirement: Persist extracted line items and report progress
The system SHALL write extracted details back into the corresponding JSON record and expose run progress in the UI.

#### Scenario: Successful extraction updates record
- **WHEN** invoice details are extracted successfully
- **THEN** the system updates that invoice record with non-empty `lineItems` and saves the dataset file.

#### Scenario: Progress visibility during run
- **WHEN** the rescan job is running
- **THEN** status responses include per-dataset counters for queued, processing, success, failed, and skipped invoices.
