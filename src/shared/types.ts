export type InvoiceType = "invoice" | "ticket";
export type InvoiceDirection = "sold" | "purchase";
export type ContinueRunMode = "sold" | "purchased-hasCode" | "purchased-noCode" | "purchased-initCode";

export interface ManualFilterContext {
  from?: string;
  to?: string;
  direction?: InvoiceDirection;
}

export interface InvoiceHeader {
  nbmst: string;
  khhdon: string;
  khmshdon: string;
  shdon: string;
}

export interface InvoiceNameResult {
  key: string;
  shdon: string;
  names: string;
}

export interface InvoiceNameMap {
  byComposite: Map<string, string>;
  byNumberOnly: Map<string, string>;
}

export interface InvoiceBuyerNameMap {
  byComposite: Map<string, string>;
  byNumberOnly: Map<string, string>;
}

export interface InvoiceCrawlMetadata {
  source: "api" | "dom" | "fallback";
  crawledAt: string;
  page: string;
  itemCount: number;
  status: "success" | "partial" | "failed";
}

export interface InvoiceCrawlMetadataMap {
  byComposite: Map<string, InvoiceCrawlMetadata>;
  byNumberOnly: Map<string, InvoiceCrawlMetadata>;
}

export interface InvoiceNameCollectionProgress {
  nextIndex: number;
  map: InvoiceNameMap;
  buyerNames: InvoiceBuyerNameMap;
  metadata: InvoiceCrawlMetadataMap;
  failed: Array<{ key: string; shdon: string }>;
}

export interface TokenCacheData {
  token: string;
  expiresAt: number;
}

export interface LoginResult {
  token: string;
  expiresAt: number;
  captchaMethod: "svg-text" | "ocr" | "unknown";
  manualFilter?: ManualFilterContext;
  xmlDir?: string;
  continueAction?:
    | "continue"
    | `continue:${ContinueRunMode}`
    | "rescan-empty-line-items"
    | "stop-current-flow"
    | "debug-read-pagination"
    | "debug-next-page"
    | "debug-open-invoice"
    | `debug-select-row:${number}`;
}

export interface PipelineSummary {
  invoiceCount: number;
  namedInvoiceCount: number;
  unmatchedRows: number;
  outputPath: string;
}
