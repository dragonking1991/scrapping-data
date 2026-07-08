import type { ChildProcess } from "node:child_process";

export type ContinueRunMode = "sold" | "purchased-hasCode" | "purchased-noCode" | "purchased-initCode";
export type PurchasedAggregateType = "hasCode" | "noCode" | "initCode";

export interface UiDefaults {
  out: string;
  direction: "sold" | "purchase";
}

export interface RunPayload {
  out?: string;
  direction: "sold" | "purchase";
  verifyOnly?: boolean;
  relogin?: boolean;
  manualFirst?: boolean;
  autoExportXml?: boolean;
}

export interface StartPayload {
  direction: "sold" | "purchase";
  out?: string;
  verifyOnly?: boolean;
  manualFirst?: boolean;
  autoExportXml?: boolean;
}

export interface ContinuePayload {
  jobId?: string;
  runMode?: ContinueRunMode;
}

export interface DebugActionPayload {
  jobId?: string;
  action?: string;
}

export type JobStatus = "running" | "paused" | "success" | "failed";

export interface Job {
  id: string;
  status: JobStatus;
  output: string;
  startedAt: number;
  finishedAt?: number;
  child?: ChildProcess;
  stopped?: boolean;
}

export type AggregateFileStatus = "pending" | "running" | "success" | "failed" | "skipped";
export type AggregateJobStatus = "running" | "success" | "failed";
export type RescanFileStatus = "pending" | "running" | "success" | "failed";
export type RescanJobStatus = "running" | "success" | "failed";

export interface AggregateFileProgress {
  status: AggregateFileStatus;
  message: string;
  matchedRows: number;
  unmatchedRows: number;
  matchedInvoiceKeys: string[];
  unmatchedInvoiceKeys: string[];
  outputPath?: string;
}

export interface AggregateJob {
  id: string;
  status: AggregateJobStatus;
  startedAt: number;
  finishedAt?: number;
  files: {
    sold: AggregateFileProgress;
    purchased: AggregateFileProgress;
    purchasedTypes?: Record<PurchasedAggregateType, AggregateFileProgress>;
  };
}

export interface RescanFileProgress {
  status: RescanFileStatus;
  queued: number;
  processing: number;
  success: number;
  failed: number;
  skipped: number;
  currentKey?: string;
  message: string;
}

export interface RescanJob {
  id: string;
  sourceJobId: string;
  status: RescanJobStatus;
  startedAt: number;
  finishedAt?: number;
  files: {
    sold: RescanFileProgress;
    purchased: RescanFileProgress;
  };
}

export interface ActiveSession {
  jobId: string;
  continueSignalFile: string;
}
