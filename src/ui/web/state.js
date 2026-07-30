export const ACTIVE_JOB_STORAGE_KEY = "gdt-active-job-id";
export const DEFAULT_OUT = window.__DEFAULT_OUT__ || "./DANH-SACH-HOA-DON.xlsx";
export const DEFAULT_PURCHASED_TYPE = "hasCode";

export const state = {
  isBusy: false,
  hasSession: false,
  isRunningFlow: false,
  continueInFlight: false,
  closingSession: false,
  currentJobId: null,
  eventSource: null,
  aggregateJobId: null,
  aggregatePollTimer: null,
  isAggregating: false,
};

export const EVENT_LABELS = {
  "rows-found": ["🧾", "text-emerald-300"],
  "no-rows": ["⚠️", "text-amber-300"],
  stopped: ["⏸️", "text-amber-300"],
  resumed: ["▶️", "text-emerald-300"],
  "select-checkbox": ["☑️", "text-sky-300"],
  "click-row": ["👆", "text-sky-300"],
  "find-icon": ["🔍", "text-slate-300"],
  hover: ["🖱️", "text-slate-400"],
  "found-view-icon": ["👁️", "text-emerald-300"],
  "icon-not-found": ["❌", "text-rose-300"],
  "click-view": ["👁️", "text-blue-300"],
  "detail-modal": ["🪟", "text-amber-300"],
  "items-extracted": ["📦", "text-emerald-300"],
  "items-empty": ["⚠️", "text-amber-300"],
  "modal-closed": ["✖️", "text-slate-400"],
  "next-page": ["⏭️", "text-sky-300"],
  "pagination-state": ["📄", "text-cyan-300"],
  "pagination-end": ["🏁", "text-emerald-300"],
  "row-error": ["🛑", "text-rose-300"],
  saved: ["💾", "text-emerald-300"],
};
