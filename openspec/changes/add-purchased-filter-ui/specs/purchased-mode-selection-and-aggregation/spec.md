## ADDED Requirements

### Requirement: UI mode selection for purchased flow
The system SHALL provide a "Mua vao" checkbox in the run configuration panel and SHALL reveal a dropdown with three options `hasCode`, `noCode`, and `initCode` when the checkbox is checked. The dropdown default value MUST be `hasCode` whenever purchased mode is enabled.

#### Scenario: User enables purchased mode
- **WHEN** the user checks the "Mua vao" checkbox
- **THEN** the system shows the dropdown with options `hasCode`, `noCode`, and `initCode`

#### Scenario: Default purchased type is hasCode
- **WHEN** the user checks the "Mua vao" checkbox for the first time in a run setup
- **THEN** the selected dropdown value is `hasCode`

### Requirement: Output JSON routing by selected run mode
The system SHALL route exported invoice data to the JSON output file that matches the selected run mode.

#### Scenario: Sold mode without purchased checkbox
- **WHEN** the user clicks "Lay thong tin" while "Mua vao" is unchecked
- **THEN** exported data is appended to `hd_sold.json`

#### Scenario: Purchased hasCode output
- **WHEN** the user clicks "Lay thong tin" with "Mua vao" checked and dropdown value `hasCode`
- **THEN** exported data is appended to `hd_purchased_hasCode.json`

#### Scenario: Purchased noCode output
- **WHEN** the user clicks "Lay thong tin" with "Mua vao" checked and dropdown value `noCode`
- **THEN** exported data is appended to `hd_purchased_noCode.json`

#### Scenario: Purchased initCode output
- **WHEN** the user clicks "Lay thong tin" with "Mua vao" checked and dropdown value `initCode`
- **THEN** exported data is appended to `hd_purchased_initCode.json`

### Requirement: Purchased aggregate workbook is split by purchased type
The system SHALL generate `hd_purchased_merged.xlsx` with separate sheets `hasCode`, `noCode`, and `initCode`, and each sheet MUST contain merged rows derived only from its corresponding purchased JSON source.

#### Scenario: Aggregate builds all purchased sheets
- **WHEN** the user clicks "Tong hop hoa don" and purchased source files are available
- **THEN** the system writes `hd_purchased_merged.xlsx` with sheets `hasCode`, `noCode`, and `initCode`

#### Scenario: Per-sheet data isolation
- **WHEN** aggregation completes for purchased files
- **THEN** records from one purchased type are not mixed into another sheet

### Requirement: Aggregate logs identify matched and unmatched invoice IDs per purchased type
The system SHALL log matched and unmatched invoice IDs per purchased type after aggregation so users can audit which invoices were merged or missed.

#### Scenario: Log contains per-type match details
- **WHEN** aggregation finishes for purchased types
- **THEN** the log includes matched and unmatched invoice ID lists for each of `hasCode`, `noCode`, and `initCode`
