## 1. UI Mode Controls

- [x] 1.1 Add "Mua vao" checkbox and conditional purchased-type dropdown (`hasCode`, `noCode`, `initCode`) in the run settings panel.
- [x] 1.2 Add frontend state logic to default purchased type to `hasCode` when checkbox is enabled and hide dropdown when checkbox is disabled.
- [x] 1.3 Update submit payload for "Lay thong tin" to send a normalized run mode (`sold`, `purchased-hasCode`, `purchased-noCode`, `purchased-initCode`).

## 2. Run Routing and JSON Output

- [x] 2.1 Add backend validation for the new run mode values and return clear errors for invalid mode input.
- [x] 2.2 Implement centralized mode-to-output-file mapping for JSON exports.
- [x] 2.3 Route output writes to `hd_sold.json` when purchased mode is off, and to `hd_purchased_hasCode.json` / `hd_purchased_noCode.json` / `hd_purchased_initCode.json` when purchased mode is on.

## 3. Purchased Aggregate Split by Type

- [x] 3.1 Update aggregate job inputs to read purchased JSON files from all three type-specific sources.
- [x] 3.2 Extend purchased merge output to generate `hd_purchased_merged.xlsx` with sheets `hasCode`, `noCode`, and `initCode`.
- [x] 3.3 Ensure per-sheet isolation so each sheet only contains records from its matching purchased source file.

## 4. Logging and Verification

- [x] 4.1 Add aggregate log output for matched/unmatched invoice IDs per purchased type.
- [x] 4.2 Add or update checks/tests for UI mode selection, output routing, and three-sheet aggregate behavior.
- [x] 4.3 Run project checks and verify sample runs for all four paths: sold, purchased-hasCode, purchased-noCode, purchased-initCode.
