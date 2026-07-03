import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { promises as fs } from "node:fs";
import { basename, extname, join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { URL } from "node:url";
import { buildDetailMapFromExtractedInvoices, mergeNamesIntoWorkbookWithMetadata } from "../export/merge.js";
interface UiDefaults {
  out: string;
  direction: "sold" | "purchase";
}

interface RunPayload {
  out?: string;
  direction: "sold" | "purchase";
  verifyOnly?: boolean;
  relogin?: boolean;
  manualFirst?: boolean;
  autoExportXml?: boolean;
}

interface StartPayload {
  direction: "sold" | "purchase";
  out?: string;
  verifyOnly?: boolean;
  manualFirst?: boolean;
  autoExportXml?: boolean;
}

interface ContinuePayload {
  jobId?: string;
}

type JobStatus = "running" | "paused" | "success" | "failed";

interface Job {
  id: string;
  status: JobStatus;
  output: string;
  startedAt: number;
  finishedAt?: number;
  child?: ChildProcess;
  stopped?: boolean;
}

type AggregateFileStatus = "pending" | "running" | "success" | "failed" | "skipped";
type AggregateJobStatus = "running" | "success" | "failed";
type RescanFileStatus = "pending" | "running" | "success" | "failed";
type RescanJobStatus = "running" | "success" | "failed";

interface AggregateFileProgress {
  status: AggregateFileStatus;
  message: string;
  matchedRows: number;
  unmatchedRows: number;
  matchedInvoiceKeys: string[];
  unmatchedInvoiceKeys: string[];
  outputPath?: string;
}

interface AggregateJob {
  id: string;
  status: AggregateJobStatus;
  startedAt: number;
  finishedAt?: number;
  files: {
    sold: AggregateFileProgress;
    purchased: AggregateFileProgress;
  };
}

interface RescanFileProgress {
  status: RescanFileStatus;
  queued: number;
  processing: number;
  success: number;
  failed: number;
  skipped: number;
  currentKey?: string;
  message: string;
}

interface RescanJob {
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

const jobs = new Map<string, Job>();
const activeSessions = new Map<string, { jobId: string; continueSignalFile: string }>();
const aggregateJobs = new Map<string, AggregateJob>();
const rescanJobs = new Map<string, RescanJob>();
const CONTINUE_READY_MARKER =
  "Da san sang. Vui long bam Lay thong tin trong UI de tiep tuc crawl tu cung browser session.";

async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

function createAggregateJob(): AggregateJob {
  const id = randomId();
  const blank: AggregateFileProgress = {
    status: "pending",
    message: "Dang cho",
    matchedRows: 0,
    unmatchedRows: 0,
    matchedInvoiceKeys: [],
    unmatchedInvoiceKeys: [],
  };
  const job: AggregateJob = {
    id,
    status: "running",
    startedAt: Date.now(),
    files: {
      sold: { ...blank },
      purchased: { ...blank },
    },
  };
  aggregateJobs.set(id, job);
  return job;
}

function trimAggregateJobs(limit = 20): void {
  const all = Array.from(aggregateJobs.values()).sort((a, b) => b.startedAt - a.startedAt);
  for (let i = limit; i < all.length; i += 1) {
    const stale = all[i];
    if (stale) {
      aggregateJobs.delete(stale.id);
    }
  }
}

function createRescanJob(sourceJobId: string): RescanJob {
  const id = randomId();
  const blank: RescanFileProgress = {
    status: "pending",
    queued: 0,
    processing: 0,
    success: 0,
    failed: 0,
    skipped: 0,
    message: "Dang cho",
  };
  const job: RescanJob = {
    id,
    sourceJobId,
    status: "running",
    startedAt: Date.now(),
    files: {
      sold: { ...blank },
      purchased: { ...blank },
    },
  };
  rescanJobs.set(id, job);
  return job;
}

function trimRescanJobs(limit = 20): void {
  const all = Array.from(rescanJobs.values()).sort((a, b) => b.startedAt - a.startedAt);
  for (let i = limit; i < all.length; i += 1) {
    const stale = all[i];
    if (stale) {
      rescanJobs.delete(stale.id);
    }
  }
}

function parseRescanStatusLines(chunk: string): Array<{
  dataset: "sold" | "purchased";
  status: RescanFileStatus;
  queued: number;
  processing: number;
  success: number;
  failed: number;
  skipped: number;
  currentKey?: string;
  message?: string;
}> {
  const entries: Array<{
    dataset: "sold" | "purchased";
    status: RescanFileStatus;
    queued: number;
    processing: number;
    success: number;
    failed: number;
    skipped: number;
    currentKey?: string;
    message?: string;
  }> = [];

  for (const line of chunk.split(/\r?\n/)) {
    const marker = line.indexOf("[RESCAN-STATUS]");
    if (marker < 0) {
      continue;
    }
    const raw = line.slice(marker + "[RESCAN-STATUS]".length).trim();
    if (!raw) {
      continue;
    }

    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const dataset = parsed.dataset === "purchased" ? "purchased" : parsed.dataset === "sold" ? "sold" : null;
      const status =
        parsed.status === "running" || parsed.status === "success" || parsed.status === "failed"
          ? parsed.status
          : null;
      if (!dataset || !status) {
        continue;
      }

      entries.push({
        dataset,
        status,
        queued: Number(parsed.queued ?? 0) || 0,
        processing: Number(parsed.processing ?? 0) || 0,
        success: Number(parsed.success ?? 0) || 0,
        failed: Number(parsed.failed ?? 0) || 0,
        skipped: Number(parsed.skipped ?? 0) || 0,
        currentKey: typeof parsed.currentKey === "string" ? parsed.currentKey : undefined,
        message: typeof parsed.message === "string" ? parsed.message : undefined,
      });
    } catch {
      // ignore malformed status lines
    }
  }

  return entries;
}

function applyRescanProgress(
  job: RescanJob,
  entry: {
    dataset: "sold" | "purchased";
    status: RescanFileStatus;
    queued: number;
    processing: number;
    success: number;
    failed: number;
    skipped: number;
    currentKey?: string;
    message?: string;
  },
): void {
  const slot = job.files[entry.dataset];
  slot.status = entry.status;
  slot.queued = entry.queued;
  slot.processing = entry.processing;
  slot.success = entry.success;
  slot.failed = entry.failed;
  slot.skipped = entry.skipped;
  slot.currentKey = entry.currentKey;
  slot.message = entry.message ?? slot.message;
}

async function runRescanJob(job: RescanJob, session: { jobId: string; continueSignalFile: string }): Promise<void> {
  const sourceJob = jobs.get(session.jobId);
  if (!sourceJob || sourceJob.status !== "running") {
    job.status = "failed";
    job.finishedAt = Date.now();
    job.files.sold.status = "failed";
    job.files.purchased.status = "failed";
    job.files.sold.message = "Session browser khong con hoat dong";
    job.files.purchased.message = "Session browser khong con hoat dong";
    trimRescanJobs();
    return;
  }

  let cursor = sourceJob.output.length;
  await fs.writeFile(session.continueSignalFile, "rescan-empty-line-items", "utf8");

  const timeoutMs = Number(process.env.GDT_RESCAN_TIMEOUT_MS ?? 7200000);
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const current = jobs.get(session.jobId);
    if (!current) {
      break;
    }

    if (current.output.length > cursor) {
      const chunk = current.output.slice(cursor);
      cursor = current.output.length;
      const entries = parseRescanStatusLines(chunk);
      for (const entry of entries) {
        applyRescanProgress(job, entry);
      }
    }

    if (current.status !== "running") {
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, 350));
  }

  const sold = job.files.sold;
  const purchased = job.files.purchased;
  const receivedAnyStatus =
    sold.status !== "pending" ||
    purchased.status !== "pending" ||
    sold.message !== "Dang cho" ||
    purchased.message !== "Dang cho";

  if (!receivedAnyStatus) {
    sold.status = "failed";
    purchased.status = "failed";
    sold.message = sold.message || "Khong nhan duoc tien do ra lai tu session";
    purchased.message = purchased.message || "Khong nhan duoc tien do ra lai tu session";
    job.status = "failed";
  } else {
    const anyFailed = sold.failed > 0 || purchased.failed > 0 || sold.status === "failed" || purchased.status === "failed";
    job.status = anyFailed ? "failed" : "success";
  }

  job.finishedAt = Date.now();
  trimRescanJobs();
}

async function processAggregateFile(
  job: AggregateJob,
  key: "sold" | "purchased",
  jsonPath: string,
  sourceXlsxPath: string,
  outputDir: string,
): Promise<void> {
  const slot = job.files[key];
  slot.status = "running";
  slot.message = "Dang tong hop...";
  slot.matchedRows = 0;
  slot.unmatchedRows = 0;
  slot.matchedInvoiceKeys = [];
  slot.unmatchedInvoiceKeys = [];
  slot.outputPath = undefined;

  const hasJson = await pathExists(jsonPath);
  const hasXlsx = await pathExists(sourceXlsxPath);
  if (!hasJson || !hasXlsx) {
    slot.status = "skipped";
    slot.message = !hasJson && !hasXlsx ? "Khong tim thay JSON va XLSX" : !hasJson ? "Khong tim thay file JSON" : "Khong tim thay file XLSX";
    return;
  }

  try {
    const rawJson = await fs.readFile(jsonPath, "utf8");
    const parsed = JSON.parse(rawJson);
    if (!Array.isArray(parsed)) {
      throw new Error("File JSON khong phai array");
    }

    const detailMap = buildDetailMapFromExtractedInvoices(parsed as Array<Record<string, unknown>>, {
      mode: key === "purchased" ? "purchased" : "sold",
    });
    const xlsxBuffer = await fs.readFile(sourceXlsxPath);
    const merged = await mergeNamesIntoWorkbookWithMetadata(xlsxBuffer, detailMap);
    await fs.mkdir(outputDir, { recursive: true });
    const outputFileName = `${basename(sourceXlsxPath, extname(sourceXlsxPath))}_merged${extname(sourceXlsxPath)}`;
    const outputPath = join(outputDir, outputFileName);
    await fs.writeFile(outputPath, merged.output);

    slot.status = "success";
    slot.message = `Da xuat file moi: ${outputPath} (${merged.matchedRows} khop, ${merged.unmatchedRows} khong khop)`;
    slot.matchedRows = merged.matchedRows;
    slot.unmatchedRows = merged.unmatchedRows;
    slot.matchedInvoiceKeys = merged.matchedInvoiceKeys;
    slot.unmatchedInvoiceKeys = merged.unmatchedInvoiceKeys;
    slot.outputPath = outputPath;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    slot.status = "failed";
    slot.message = message.slice(0, 200);
  }
}

async function runAggregateJob(job: AggregateJob): Promise<void> {
  const soldJson = join(process.cwd(), ".gdt-xml-export", "hd_sold.json");
  const purchasedJson = join(process.cwd(), ".gdt-xml-export", "hd_purchased.json");
  const soldXlsx = join(process.cwd(), "src", "xlsx", "hd_sold.xlsx");
  const purchasedXlsx = join(process.cwd(), "src", "xlsx", "hd_purchased.xlsx");
  const outputDir = join(process.cwd(), "gdt-aggregated-xlsx");

  await processAggregateFile(job, "sold", soldJson, soldXlsx, outputDir);
  await processAggregateFile(job, "purchased", purchasedJson, purchasedXlsx, outputDir);

  const statuses = [job.files.sold.status, job.files.purchased.status];
  const hasFailed = statuses.includes("failed");
  const hasSuccess = statuses.includes("success");
  job.status = hasFailed ? "failed" : hasSuccess ? "success" : "failed";
  job.finishedAt = Date.now();
  trimAggregateJobs();
}

function parseArgValue(flag: string): string | undefined {
  const args = process.argv.slice(2);
  const idx = args.indexOf(flag);
  if (idx >= 0 && idx + 1 < args.length) {
    return args[idx + 1];
  }

  const inline = args.find((v) => v.startsWith(`${flag}=`));
  if (inline) {
    return inline.substring(flag.length + 1);
  }

  return undefined;
}

function getDefaultOutPath(): string {
  return parseArgValue("--out") ?? "./DANH-SACH-HOA-DON.xlsx";
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => resolve(raw));
    req.on("error", (err) => reject(err));
  });
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function sseWrite(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function randomId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function trimJobs(limit = 20): void {
  const all = Array.from(jobs.values()).sort((a, b) => b.startedAt - a.startedAt);
  for (let i = limit; i < all.length; i += 1) {
    const stale = all[i];
    if (stale) {
      jobs.delete(stale.id);
    }
  }
}

function buildCliEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GDT_")) {
      delete env[key];
    }
  }

  return env;
}

function validatePayload(payload: RunPayload): string | null {
  if (!["sold", "purchase"].includes(payload.direction)) {
    return "Loai hoa don khong hop le.";
  }

  return null;
}

function validateStartPayload(payload: StartPayload): string | null {
  if (!["sold", "purchase"].includes(payload.direction)) {
    return "Loai hoa don khong hop le.";
  }

  return null;
}

function html(defaults: UiDefaults): string {
  return `<!doctype html>
<html lang="vi">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>GDT Invoice Runner</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
      @import url('https://fonts.googleapis.com/css2?family=Be+Vietnam+Pro:wght@400;500;700;800&display=swap');
      body { font-family: 'Be Vietnam Pro', sans-serif; }
    </style>
  </head>
  <body class="min-h-screen bg-[radial-gradient(circle_at_top_left,_#fef9c3,_#fef2f2_45%,_#eff6ff)] text-slate-900">
    <div class="mx-auto flex min-h-screen w-full max-w-[1600px] flex-col px-5 py-8 md:px-10">
      <header class="mb-8 rounded-3xl border border-amber-200/70 bg-white/80 p-6 shadow-xl backdrop-blur">
        <p class="text-xs font-bold uppercase tracking-[0.25em] text-amber-700">Scrape GDT Invoices</p>
        <h1 class="mt-2 text-3xl font-extrabold leading-tight md:text-4xl">Manual-first collector cho hóa đơn GDT</h1>
        <p class="mt-3 max-w-3xl text-sm text-slate-600">Bam Bat dau de mo Cloakbrowser va dien san user/pass. Ban nhap captcha, dang nhap va bam Tim kiem tren GDT. Sau do bam Lay thong tin de xem tung hoa don va ghi lai ten hang hoa/dich vu.</p>
      </header>

      <main class="grid gap-6 lg:grid-cols-[360px,minmax(0,1fr)] items-start">
        <section class="w-full min-w-0 rounded-3xl border border-slate-200 bg-white p-6 shadow-lg lg:sticky lg:top-8">
          <h2 class="text-lg font-bold">Thiết lập chạy</h2>
          <p class="mt-1 text-sm text-slate-500">Khoang ngay duoc doc tu man hinh tra cuu GDT sau khi ban bam Tim kiem.</p>

          <form id="runForm" class="mt-6 space-y-4">
            <div>
              <label for="sessionSelect" class="mb-1 block text-sm font-semibold text-slate-700">Session browser đang chạy</label>
              <select id="sessionSelect" name="sessionSelect" class="w-full rounded-xl border border-slate-300 bg-slate-50 px-4 py-3 text-base outline-none transition focus:border-amber-500 focus:ring-2 focus:ring-amber-200">
                <option value="">(chưa có session — bấm Bắt đầu để mở)</option>
              </select>
              <p class="mt-1 text-xs text-slate-500">Chọn một session để switch qua và bấm "Lấy thông tin" tiếp tục.</p>
            </div>

            <div>
              <p class="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">Dùng cấu hình mặc định của UI. File xuất sẽ ghi ra <span class="font-semibold text-slate-800">${defaults.out}</span> và chạy ở chế độ manual-first.</p>
            </div>

            <div class="grid gap-3 sm:grid-cols-2">
              <button type="button" id="startBtn" class="min-h-12 rounded-xl border border-amber-600 bg-amber-50 px-4 py-3 text-sm font-bold text-amber-800 transition hover:bg-amber-100">Bắt đầu</button>
              <button type="submit" id="runBtn" class="min-h-12 rounded-xl bg-amber-700 px-4 py-3 text-sm font-bold text-white transition hover:bg-amber-800">Lấy thông tin</button>
            </div>

            <div class="grid gap-3">
              <button type="button" id="rescanBtn" class="min-h-12 rounded-xl border border-teal-500 bg-teal-50 px-4 py-3 text-sm font-bold text-teal-800 transition hover:bg-teal-100">Rà lại lineItems rỗng (hd_sold + hd_purchased)</button>
              <div class="rounded-xl border border-teal-200 bg-teal-50/60 p-3 text-xs text-slate-700">
                <div class="flex items-center justify-between">
                  <span class="font-semibold">Rescan hd_sold.json</span>
                  <span id="rescanSoldStatus" class="rounded-full bg-slate-200 px-2 py-0.5 font-bold text-slate-700">Chưa chạy</span>
                </div>
                <p id="rescanSoldMsg" class="mt-1 text-slate-600">Chưa có trạng thái.</p>
                <div class="mt-2 flex items-center justify-between">
                  <span class="font-semibold">Rescan hd_purchased.json</span>
                  <span id="rescanPurchasedStatus" class="rounded-full bg-slate-200 px-2 py-0.5 font-bold text-slate-700">Chưa chạy</span>
                </div>
                <p id="rescanPurchasedMsg" class="mt-1 text-slate-600">Chưa có trạng thái.</p>
              </div>
            </div>

            <div class="grid gap-3">
              <button type="button" id="stopBtn" class="min-h-12 rounded-xl border border-rose-500 bg-rose-50 px-4 py-3 text-sm font-bold text-rose-700 transition hover:bg-rose-100">⏹ Dừng</button>
            </div>

            <div class="grid gap-3">
              <button type="button" id="aggregateBtn" class="min-h-12 rounded-xl border border-indigo-500 bg-indigo-50 px-4 py-3 text-sm font-bold text-indigo-800 transition hover:bg-indigo-100">Tổng hợp hoá đơn (hd_sold + hd_purchased)</button>
              <div class="rounded-xl border border-indigo-200 bg-indigo-50/60 p-3 text-xs text-slate-700">
                <div class="flex items-center justify-between">
                  <span class="font-semibold">hd_sold.xlsx</span>
                  <span id="aggSoldStatus" class="rounded-full bg-slate-200 px-2 py-0.5 font-bold text-slate-700">Chưa chạy</span>
                </div>
                <p id="aggSoldMsg" class="mt-1 text-slate-600">Chưa có trạng thái.</p>
                <div class="mt-2 flex items-center justify-between">
                  <span class="font-semibold">hd_purchased.xlsx</span>
                  <span id="aggPurchasedStatus" class="rounded-full bg-slate-200 px-2 py-0.5 font-bold text-slate-700">Chưa chạy</span>
                </div>
                <p id="aggPurchasedMsg" class="mt-1 text-slate-600">Chưa có trạng thái.</p>
              </div>
            </div>

            <div class="grid gap-3 sm:grid-cols-2">
              <button type="button" id="clearLog" class="min-h-12 rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm font-bold text-slate-700 transition hover:bg-slate-50">Xóa log</button>
              <button type="button" id="runRelogin" class="min-h-12 rounded-xl border border-amber-600 bg-amber-50 px-4 py-3 text-sm font-bold text-amber-800 transition hover:bg-amber-100">Re-login ngay rồi chạy</button>
            </div>

            <div class="grid gap-3 sm:grid-cols-2">
              <button type="button" id="exportLogs" class="min-h-12 rounded-xl border border-blue-500 bg-blue-50 px-4 py-3 text-sm font-bold text-blue-800 transition hover:bg-blue-100">⬇️ Xuất log hiện tại</button>
              <button type="button" id="viewLogFiles" class="min-h-12 rounded-xl border border-blue-500 bg-blue-50 px-4 py-3 text-sm font-bold text-blue-800 transition hover:bg-blue-100">📋 Xem tất cả log</button>
            </div>
          </form>
        </section>

        <section class="w-full min-w-0 rounded-3xl border border-slate-200 bg-slate-950 p-6 shadow-lg">
          <div class="mb-3 flex items-center justify-between">
            <h2 class="text-lg font-bold text-white">Kết quả chạy</h2>
            <span id="statusBadge" class="rounded-full bg-slate-800 px-3 py-1 text-xs font-bold text-slate-200">Sẵn sàng</span>
          </div>
          <pre id="log" class="h-[32rem] min-w-0 overflow-auto whitespace-pre-wrap break-words rounded-2xl border border-slate-800 bg-black/60 p-4 text-xs leading-relaxed text-emerald-300"></pre>

          <div class="mt-4 flex items-center justify-between">
            <h3 class="text-sm font-bold text-white">🐞 Debug DOM &amp; Sự kiện (theo thời gian)</h3>
            <button type="button" id="clearEvents" class="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1 text-xs font-semibold text-slate-200 transition hover:bg-slate-700">Xóa</button>
          </div>
          <div id="eventTimeline" class="mt-2 max-h-[24rem] min-w-0 space-y-2 overflow-auto rounded-2xl border border-slate-800 bg-black/40 p-3 text-xs text-slate-200">
            <p class="text-slate-500">Chưa có sự kiện nào. Chạy "Lấy thông tin" để bắt đầu ghi.</p>
          </div>
        </section>
      </main>
    </div>

    <script>
      const form = document.getElementById('runForm');
      const log = document.getElementById('log');
      const statusBadge = document.getElementById('statusBadge');
      const clearBtn = document.getElementById('clearLog');
      const reloginBtn = document.getElementById('runRelogin');
      const startBtn = document.getElementById('startBtn');
      const runBtn = document.getElementById('runBtn');
      const stopBtn = document.getElementById('stopBtn');
      const aggregateBtn = document.getElementById('aggregateBtn');
      const rescanBtn = document.getElementById('rescanBtn');
      const sessionSelect = document.getElementById('sessionSelect');
      const aggSoldStatus = document.getElementById('aggSoldStatus');
      const aggSoldMsg = document.getElementById('aggSoldMsg');
      const aggPurchasedStatus = document.getElementById('aggPurchasedStatus');
      const aggPurchasedMsg = document.getElementById('aggPurchasedMsg');
      const rescanSoldStatus = document.getElementById('rescanSoldStatus');
      const rescanSoldMsg = document.getElementById('rescanSoldMsg');
      const rescanPurchasedStatus = document.getElementById('rescanPurchasedStatus');
      const rescanPurchasedMsg = document.getElementById('rescanPurchasedMsg');

      const eventTimeline = document.getElementById('eventTimeline');
      const clearEventsBtn = document.getElementById('clearEvents');
      let eventLineBuffer = '';
      let eventCount = 0;

      function escapeHtml(s) {
        return String(s)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;');
      }

      const EVENT_LABELS = {
        'rows-found': ['🧾', 'text-emerald-300'],
        'no-rows': ['⚠️', 'text-amber-300'],
        'select-checkbox': ['☑️', 'text-sky-300'],
        'click-row': ['👆', 'text-sky-300'],
        'find-icon': ['🔍', 'text-slate-300'],
        'hover': ['🖱️', 'text-slate-400'],
        'found-view-icon': ['👁️', 'text-emerald-300'],
        'icon-not-found': ['❌', 'text-rose-300'],
        'click-view': ['👁️', 'text-blue-300'],
        'detail-modal': ['🪟', 'text-amber-300'],
        'items-extracted': ['📦', 'text-emerald-300'],
        'items-empty': ['⚠️', 'text-amber-300'],
        'modal-closed': ['✖️', 'text-slate-400'],
        'next-page': ['⏭️', 'text-sky-300'],
        'pagination-end': ['🏁', 'text-emerald-300'],
        'row-error': ['🛑', 'text-rose-300'],
        'saved': ['💾', 'text-emerald-300'],
      };

      function renderEvent(evt) {
        if (eventCount === 0) {
          eventTimeline.innerHTML = '';
        }
        eventCount += 1;
        const meta = EVENT_LABELS[evt.action] || ['•', 'text-slate-300'];
        const time = new Date(evt.ts || Date.now());
        const hh = String(time.getHours()).padStart(2, '0');
        const mm = String(time.getMinutes()).padStart(2, '0');
        const ss = String(time.getSeconds()).padStart(2, '0');
        const ms = String(time.getMilliseconds()).padStart(3, '0');
        const wrap = document.createElement('div');
        wrap.className = 'rounded-lg border border-slate-800 bg-slate-900/60 p-2';
        let inner =
          '<div class="flex items-start gap-2">' +
          '<span class="shrink-0">' + meta[0] + '</span>' +
          '<span class="shrink-0 font-mono text-[10px] text-slate-500">' + hh + ':' + mm + ':' + ss + '.' + ms + '</span>' +
          '<span class="font-mono text-[11px] font-bold ' + meta[1] + '">' + escapeHtml(evt.action) + '</span>' +
          '<span class="min-w-0 break-words text-slate-300">' + escapeHtml(evt.detail || '') + '</span>' +
          '</div>';
        if (evt.html) {
          inner +=
            '<details class="mt-1"><summary class="cursor-pointer text-[10px] text-blue-400">Xem DOM HTML</summary>' +
            '<pre class="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-black/60 p-2 text-[10px] text-slate-400">' +
            escapeHtml(evt.html) + '</pre></details>';
        }
        wrap.innerHTML = inner;
        eventTimeline.appendChild(wrap);
        eventTimeline.scrollTop = eventTimeline.scrollHeight;
      }

      function ingestEventChunk(chunk) {
        eventLineBuffer += chunk;
        let idx;
        while ((idx = eventLineBuffer.indexOf('\\n')) >= 0) {
          const line = eventLineBuffer.slice(0, idx);
          eventLineBuffer = eventLineBuffer.slice(idx + 1);
          const marker = line.indexOf('[GDT-EVENT]');
          if (marker >= 0) {
            const jsonPart = line.slice(marker + '[GDT-EVENT]'.length).trim();
            try {
              renderEvent(JSON.parse(jsonPart));
            } catch (e) {
              // ignore malformed event line
            }
          }
        }
      }

      function resetEventTimeline() {
        eventCount = 0;
        eventLineBuffer = '';
        eventTimeline.innerHTML = '<p class="text-slate-500">Chưa có sự kiện nào. Chạy "Lấy thông tin" để bắt đầu ghi.</p>';
      }

      if (clearEventsBtn) {
        clearEventsBtn.addEventListener('click', resetEventTimeline);
      }

      const startBtnDefaultText = startBtn.textContent;
      const runBtnDefaultText = runBtn.textContent;
      const aggregateBtnDefaultText = aggregateBtn ? aggregateBtn.textContent : 'Tổng hợp hoá đơn';
      const rescanBtnDefaultText = rescanBtn ? rescanBtn.textContent : 'Rà lại';
      const ACTIVE_JOB_STORAGE_KEY = 'gdt-active-job-id';
      const DEFAULT_OUT = ${JSON.stringify(defaults.out)};
      let isBusy = false;
      let hasSession = false;
      let aggregateRunning = false;
      let rescanRunning = false;

      function applyControlState() {
        startBtn.disabled = isBusy;
        runBtn.disabled = isBusy || !hasSession;
        reloginBtn.disabled = isBusy || !hasSession;
        if (aggregateBtn) aggregateBtn.disabled = isBusy || aggregateRunning;
        if (rescanBtn) rescanBtn.disabled = isBusy || !hasSession || rescanRunning;
        if (stopBtn) stopBtn.disabled = !isBusy;
        if (sessionSelect) sessionSelect.disabled = isBusy;

        const toggle = (el, off) => {
          if (off) {
            el.classList.add('opacity-70', 'cursor-not-allowed');
          } else {
            el.classList.remove('opacity-70', 'cursor-not-allowed');
          }
        };

        toggle(startBtn, startBtn.disabled);
        toggle(runBtn, runBtn.disabled);
        toggle(reloginBtn, reloginBtn.disabled);
        if (aggregateBtn) toggle(aggregateBtn, aggregateBtn.disabled);
        if (rescanBtn) toggle(rescanBtn, rescanBtn.disabled);
        if (stopBtn) toggle(stopBtn, stopBtn.disabled);
      }

      function setSessionJobId(jobId) {
        currentJobId = jobId || null;
        hasSession = Boolean(currentJobId);
        if (currentJobId) {
          localStorage.setItem(ACTIVE_JOB_STORAGE_KEY, currentJobId);
        } else {
          localStorage.removeItem(ACTIVE_JOB_STORAGE_KEY);
        }
        if (sessionSelect && sessionSelect.value !== (currentJobId || '')) {
          sessionSelect.value = currentJobId || '';
        }
        applyControlState();
      }

      async function refreshSessions() {
        if (!sessionSelect) {
          return;
        }
        try {
          const res = await fetch('/sessions');
          const data = await res.json();
          const sessions = (data && data.sessions) || [];
          const prev = currentJobId || sessionSelect.value || '';
          if (sessions.length === 0) {
            sessionSelect.innerHTML = '<option value="">(chưa có session — bấm Bắt đầu để mở)</option>';
          } else {
            let html = '<option value="">(chọn session)</option>';
            sessions.forEach((s, idx) => {
              const t = new Date(s.startedAt);
              const hh = String(t.getHours()).padStart(2, '0');
              const mm = String(t.getMinutes()).padStart(2, '0');
              const ss = String(t.getSeconds()).padStart(2, '0');
              const label = 'Session ' + (idx + 1) + ' • ' + hh + ':' + mm + ':' + ss + ' • ' + s.jobId;
              html += '<option value="' + s.jobId + '">' + label + '</option>';
            });
            sessionSelect.innerHTML = html;
          }
          // Restore selection if it still exists
          if (prev && sessions.some((s) => s.jobId === prev)) {
            sessionSelect.value = prev;
          }
        } catch (e) {
          // ignore transient fetch errors
        }
      }

      function setBusy(mode, busy) {
        isBusy = busy;
        applyControlState();

        if (mode === 'start') {
          startBtn.textContent = busy ? 'Đang mở...' : startBtnDefaultText;
        } else {
          startBtn.textContent = startBtnDefaultText;
        }

        if (mode === 'run') {
          runBtn.textContent = busy ? 'Đang chạy...' : runBtnDefaultText;
          reloginBtn.textContent = busy ? 'Đang chạy...' : 'Re-login ngay rồi chạy';
        } else {
          runBtn.textContent = runBtnDefaultText;
          reloginBtn.textContent = 'Re-login ngay rồi chạy';
        }
      }

      function setStatus(text, cls) {
        statusBadge.textContent = text;
        statusBadge.className = cls;
      }

      function setLog(text) {
        log.textContent = text;
        log.scrollTop = log.scrollHeight;
      }

      function statusBadgeClass(kind) {
        if (kind === 'running') return 'rounded-full bg-amber-500/20 px-2 py-0.5 font-bold text-amber-700';
        if (kind === 'success') return 'rounded-full bg-emerald-500/20 px-2 py-0.5 font-bold text-emerald-700';
        if (kind === 'failed') return 'rounded-full bg-rose-500/20 px-2 py-0.5 font-bold text-rose-700';
        if (kind === 'skipped') return 'rounded-full bg-slate-400/20 px-2 py-0.5 font-bold text-slate-700';
        return 'rounded-full bg-slate-200 px-2 py-0.5 font-bold text-slate-700';
      }

      function setAggregateFileStatus(target, status, message) {
        const badge = target === 'sold' ? aggSoldStatus : aggPurchasedStatus;
        const msg = target === 'sold' ? aggSoldMsg : aggPurchasedMsg;
        if (!badge || !msg) return;
        const labelMap = {
          pending: 'Chưa chạy',
          running: 'Đang chạy',
          success: 'Thành công',
          failed: 'Thất bại',
          skipped: 'Bỏ qua',
        };
        badge.textContent = labelMap[status] || 'Chưa chạy';
        badge.className = statusBadgeClass(status);
        msg.textContent = message || 'Không có thông tin.';
      }

      function setAggregateRunning(running) {
        aggregateRunning = running;
        if (aggregateBtn) {
          aggregateBtn.textContent = running ? 'Đang tổng hợp...' : aggregateBtnDefaultText;
        }
        applyControlState();
      }

      function setRescanFileStatus(target, status, message, counters) {
        const badge = target === 'sold' ? rescanSoldStatus : rescanPurchasedStatus;
        const msg = target === 'sold' ? rescanSoldMsg : rescanPurchasedMsg;
        if (!badge || !msg) return;
        const labelMap = {
          pending: 'Chưa chạy',
          running: 'Đang chạy',
          success: 'Thành công',
          failed: 'Thất bại',
        };
        badge.textContent = labelMap[status] || 'Chưa chạy';
        badge.className = statusBadgeClass(status);

        const detail = counters
          ? ' | queued=' + (counters.queued || 0) +
            ', processing=' + (counters.processing || 0) +
            ', success=' + (counters.success || 0) +
            ', failed=' + (counters.failed || 0) +
            ', skipped=' + (counters.skipped || 0)
          : '';
        msg.textContent = (message || 'Không có thông tin.') + detail;
      }

      function setRescanRunning(running) {
        rescanRunning = running;
        if (rescanBtn) {
          rescanBtn.textContent = running ? 'Đang rà lại...' : rescanBtnDefaultText;
        }
        applyControlState();
      }

      async function pollRescanStatus(jobId) {
        try {
          const res = await fetch('/rescan-status?jobId=' + encodeURIComponent(jobId));
          const data = await res.json();
          if (!data.ok || !data.job) {
            setRescanRunning(false);
            return;
          }

          const files = data.job.files || {};
          setRescanFileStatus('sold', files.sold?.status || 'pending', files.sold?.message || 'Chưa có trạng thái.', files.sold);
          setRescanFileStatus(
            'purchased',
            files.purchased?.status || 'pending',
            files.purchased?.message || 'Chưa có trạng thái.',
            files.purchased,
          );

          if (data.job.status === 'running') {
            setTimeout(() => pollRescanStatus(jobId), 700);
            return;
          }

          setRescanRunning(false);
          const summary = data.job.status === 'success' ? 'Ra lai lineItems hoan tat thanh cong.\\n' : 'Ra lai lineItems hoan tat, co loi.\\n';
          log.textContent += '[RESCAN] ' + summary;
          log.scrollTop = log.scrollHeight;
        } catch (error) {
          setRescanRunning(false);
          log.textContent += '[RESCAN] Loi khi lay trang thai ra lai: ' + String(error) + '\\n';
          log.scrollTop = log.scrollHeight;
        }
      }

      async function pollAggregateStatus(jobId) {
        try {
          const res = await fetch('/aggregate-status?jobId=' + encodeURIComponent(jobId));
          const data = await res.json();
          if (!data.ok || !data.job) {
            setAggregateRunning(false);
            return;
          }

          const files = data.job.files || {};
          setAggregateFileStatus('sold', files.sold?.status || 'pending', files.sold?.message || 'Chưa có trạng thái.');
          setAggregateFileStatus(
            'purchased',
            files.purchased?.status || 'pending',
            files.purchased?.message || 'Chưa có trạng thái.',
          );

          if (data.job.status === 'running') {
            setTimeout(() => pollAggregateStatus(jobId), 700);
            return;
          }

          setAggregateRunning(false);
          const summary = data.job.status === 'success' ? 'Tong hop hoa don thanh cong.\\n' : 'Tong hop hoa don hoan tat, co file loi.\\n';
          log.textContent += '[AGG] ' + summary;
          const fileNames = ['sold', 'purchased'];
          fileNames.forEach((name) => {
            const fileData = files[name] || {};
            const matched = Array.isArray(fileData.matchedInvoiceKeys) ? fileData.matchedInvoiceKeys : [];
            const unmatched = Array.isArray(fileData.unmatchedInvoiceKeys) ? fileData.unmatchedInvoiceKeys : [];
            const lineHeader = '[AGG][' + name + '] matched=' + matched.length + ', unmatched=' + unmatched.length + '\\n';
            log.textContent += lineHeader;
            if (fileData.outputPath) {
              log.textContent += '[AGG][' + name + '] file moi: ' + fileData.outputPath + '\\n';
            }
            if (matched.length) {
              log.textContent += '[AGG][' + name + '] khop: ' + matched.join(', ') + '\\n';
            }
            if (unmatched.length) {
              log.textContent += '[AGG][' + name + '] khong khop: ' + unmatched.join(', ') + '\\n';
            }
          });
          log.scrollTop = log.scrollHeight;
        } catch (error) {
          setAggregateRunning(false);
          log.textContent += '[AGG] Loi khi lay trang thai tong hop: ' + String(error) + '\\n';
          log.scrollTop = log.scrollHeight;
        }
      }

      let eventSource = null;
      let currentJobId = null;
      const restoredJobId = localStorage.getItem(ACTIVE_JOB_STORAGE_KEY);
      setSessionJobId(restoredJobId);

      // Populate the running-session dropdown and keep it fresh.
      refreshSessions();
      setInterval(refreshSessions, 4000);

      if (sessionSelect) {
        sessionSelect.addEventListener('change', () => {
          const chosen = sessionSelect.value;
          if (!chosen) {
            setSessionJobId(null);
            return;
          }
          attachJobEvents(chosen);
          setLog('[UI] Da switch sang session ' + chosen + '. Bam "Lay thong tin" de tiep tuc.\\n');
        });
      }

      function attachJobEvents(jobId) {
        if (currentJobId === jobId && eventSource) {
          return;
        }

        if (eventSource) {
          eventSource.close();
          eventSource = null;
        }

        setSessionJobId(jobId);
        eventSource = new EventSource('/events?jobId=' + encodeURIComponent(jobId));

        eventSource.addEventListener('log', (ev) => {
          const payload = JSON.parse(ev.data);
          const chunk = payload.chunk || '';
          log.textContent += chunk;
          log.scrollTop = log.scrollHeight;
          ingestEventChunk(chunk);
        });

        eventSource.addEventListener('status', (ev) => {
          const payload = JSON.parse(ev.data);
          if (payload.status === 'running') {
            setStatus('Đang chạy', 'rounded-full bg-amber-500/20 px-3 py-1 text-xs font-bold text-amber-300');
            return;
          }

          if (payload.status === 'paused') {
            setStatus('Đã dừng flow', 'rounded-full bg-sky-500/20 px-3 py-1 text-xs font-bold text-sky-300');
            setBusy(null, false);
            return;
          }

          if (payload.status === 'success') {
            setStatus('Thành công', 'rounded-full bg-emerald-500/20 px-3 py-1 text-xs font-bold text-emerald-300');
          } else {
            setStatus('Thất bại', 'rounded-full bg-rose-500/20 px-3 py-1 text-xs font-bold text-rose-300');
          }

          if (payload.status === 'success' || payload.status === 'failed') {
            setSessionJobId(null);
            setBusy(null, false);

            if (eventSource) {
              eventSource.close();
              eventSource = null;
            }
          }
        });

        eventSource.onerror = () => {
          if (eventSource) {
            eventSource.close();
            eventSource = null;
          }
        };
      }

      clearBtn.addEventListener('click', () => setLog(''));

      document.getElementById('exportLogs')?.addEventListener('click', () => {
        const link = document.createElement('a');
        link.href = '/export-logs';
        link.download = 'invoice-items-' + Date.now() + '.json';
        link.click();
        setLog('Da xuat du lieu hien tai theo dinh dang invoice-items.json.\\n');
      });

      document.getElementById('viewLogFiles')?.addEventListener('click', async () => {
        try {
          const res = await fetch('/log-files');
          const data = await res.json();
          if (data.files && data.files.length > 0) {
            let msg = 'Cac file log co san:\\n';
            data.files.forEach((f) => {
              msg += '- ' + f + '\\n';
            });
            msg += '\\nClick tren link de tai xuong:\\n';
            data.files.forEach((f) => {
              msg += '- <a href="/download-log?file=' + encodeURIComponent(f) + '" class="text-blue-400 underline">' + f + '</a>\\n';
            });
            setLog(msg);
          } else {
            setLog('Khong co file log nao.\\n');
          }
        } catch (e) {
          setLog('Loi khi lay danh sach log: ' + e + '\\n');
        }
      });

      async function startBrowser() {
        if (isBusy) {
          return;
        }

        setBusy('start', true);
        const direction = 'sold';
        setStatus('Đang mở browser', 'rounded-full bg-amber-500/20 px-3 py-1 text-xs font-bold text-amber-300');
        setLog('Dang mo Cloakbrowser va chuan bi browser session...\\n');
        try {
          const res = await fetch('/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              direction,
              out: DEFAULT_OUT,
              verifyOnly: false,
              manualFirst: true,
              autoExportXml: true,
            }),
          });
          const data = await res.json();
          if (!data.ok) {
            setStatus('Thất bại', 'rounded-full bg-rose-500/20 px-3 py-1 text-xs font-bold text-rose-300');
            setLog((data.output || 'Khong mo duoc browser') + '\\n');
            setBusy(null, false);
            return;
          }

          if (data.jobId) {
            attachJobEvents(data.jobId);
          }
          refreshSessions();

          setStatus('Đã mở browser', 'rounded-full bg-emerald-500/20 px-3 py-1 text-xs font-bold text-emerald-300');
          log.textContent += '[UI] Da mo browser va dien user/pass. Ban nhap captcha + dang nhap + bam Tim kiem tren GDT. Sau do bam Lay thong tin de tiep tuc cung browser session.\\n';
          setBusy(null, false);
        } catch (err) {
          setStatus('Lỗi', 'rounded-full bg-rose-500/20 px-3 py-1 text-xs font-bold text-rose-300');
          setLog(String(err));
          setBusy(null, false);
        }
      }

      async function continueJob() {
        if (isBusy) {
          return;
        }

        resetEventTimeline();
        setBusy('run', true);
        try {
          const res = await fetch('/run', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jobId: currentJobId }),
          });
          const data = await res.json();
          if (!data.ok || !data.jobId) {
            if ((data.output || '').includes('Khong tim thay browser session')) {
              setSessionJobId(null);
            }
            setStatus('Thất bại', 'rounded-full bg-rose-500/20 px-3 py-1 text-xs font-bold text-rose-300');
            setLog((data.output || 'Khong tao duoc job') + '\\n');
            setBusy(null, false);
            return;
          }

          attachJobEvents(data.jobId);
          setStatus('Đang chạy', 'rounded-full bg-amber-500/20 px-3 py-1 text-xs font-bold text-amber-300');
          log.textContent += '[UI] Da gui tin hieu tiep tuc cho browser session hien tai.\\n';
          // Keep busy=true — SSE status handler will unlock when job finishes
        } catch (err) {
          setStatus('Lỗi', 'rounded-full bg-rose-500/20 px-3 py-1 text-xs font-bold text-rose-300');
          setLog(String(err));
          setBusy(null, false);
        }
      }

      startBtn.addEventListener('click', async () => {
        await startBrowser();
      });

      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        await continueJob();
      });

      reloginBtn.addEventListener('click', async () => {
        await continueJob();
      });

      if (aggregateBtn) {
        aggregateBtn.addEventListener('click', async () => {
          if (isBusy || aggregateRunning) {
            return;
          }

          setAggregateRunning(true);
          setAggregateFileStatus('sold', 'running', 'Dang cho xu ly...');
          setAggregateFileStatus('purchased', 'running', 'Dang cho xu ly...');
          try {
            const res = await fetch('/aggregate', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
            });
            const data = await res.json();
            if (!data.ok || !data.jobId) {
              setAggregateRunning(false);
              setAggregateFileStatus('sold', 'failed', data.output || 'Khong tao duoc job tong hop');
              setAggregateFileStatus('purchased', 'failed', data.output || 'Khong tao duoc job tong hop');
              return;
            }
            pollAggregateStatus(data.jobId);
          } catch (error) {
            setAggregateRunning(false);
            setAggregateFileStatus('sold', 'failed', String(error));
            setAggregateFileStatus('purchased', 'failed', String(error));
          }
        });
      }

      if (rescanBtn) {
        rescanBtn.addEventListener('click', async () => {
          if (isBusy || rescanRunning || !hasSession) {
            return;
          }

          resetEventTimeline();
          setRescanRunning(true);
          setBusy('run', true);
          setStatus('Đang rà lại', 'rounded-full bg-amber-500/20 px-3 py-1 text-xs font-bold text-amber-300');
          setRescanFileStatus('sold', 'running', 'Dang cho xu ly...', null);
          setRescanFileStatus('purchased', 'running', 'Dang cho xu ly...', null);

          try {
            const activeJobId = currentJobId || (sessionSelect ? sessionSelect.value : '');
            if (!activeJobId) {
              setRescanRunning(false);
              setBusy(null, false);
              setRescanFileStatus('sold', 'failed', 'Khong co session browser dang mo.', null);
              setRescanFileStatus('purchased', 'failed', 'Khong co session browser dang mo.', null);
              return;
            }

            attachJobEvents(activeJobId);
            const res = await fetch('/rescan', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ jobId: activeJobId }),
            });
            const data = await res.json();
            if (!data.ok || !data.jobId) {
              setRescanRunning(false);
              setBusy(null, false);
              setStatus('Thất bại', 'rounded-full bg-rose-500/20 px-3 py-1 text-xs font-bold text-rose-300');
              setRescanFileStatus('sold', 'failed', data.output || 'Khong tao duoc job ra lai', null);
              setRescanFileStatus('purchased', 'failed', data.output || 'Khong tao duoc job ra lai', null);
              return;
            }

            pollRescanStatus(data.jobId);
          } catch (error) {
            setRescanRunning(false);
            setBusy(null, false);
            setStatus('Lỗi', 'rounded-full bg-rose-500/20 px-3 py-1 text-xs font-bold text-rose-300');
            setRescanFileStatus('sold', 'failed', String(error), null);
            setRescanFileStatus('purchased', 'failed', String(error), null);
          }
        });
      }

      if (stopBtn) {
        stopBtn.addEventListener('click', async () => {
          if (!isBusy) {
            return;
          }
          stopBtn.disabled = true;
          stopBtn.textContent = 'Đang dừng...';
          try {
            const res = await fetch('/stop', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ jobId: currentJobId || undefined }),
            });
            const data = await res.json();
            if (!data.ok) {
              log.textContent += '[UI] Khong dung duoc: ' + (data.output || '') + '\\n';
            } else {
              log.textContent += '[UI] Da gui yeu cau dung job.\\n';
            }
          } catch (err) {
            log.textContent += '[UI] Loi khi dung job: ' + String(err) + '\\n';
          } finally {
            stopBtn.textContent = '⏹ Dừng';
            // SSE status handler will unlock controls when the job actually ends
          }
        });
      }
    </script>
  </body>
</html>`;
}

function startJob(payload: RunPayload): Job {
  const id = randomId();
  const job: Job = {
    id,
    status: "running",
    output: "",
    startedAt: Date.now(),
  };

  jobs.set(id, job);
  trimJobs();

  const continueSignalFile = join(process.cwd(), `.gdt-continue-${id}.signal`);
  const args = ["run", "dev:cli", "--", "--direction", payload.direction, "--manual-first", "--continue-signal-file", continueSignalFile];
  const outPath = payload.out?.trim() || getDefaultOutPath();

  if (payload.verifyOnly) {
    args.push("--verify-only");
  } else {
    args.push("--out", outPath);
  }

  if (payload.autoExportXml) {
    args.push("--auto-export-xml");
  }

  const child = spawn("npm", args, {
    cwd: process.cwd(),
    // Let CLI reload latest .env on each run instead of reusing stale GDT_* values.
    env: buildCliEnv(),
    // Own process group so we can kill the whole tree (npm -> tsx -> cli -> browser).
    detached: true,
  });

  job.child = child;
  activeSessions.set(id, { jobId: id, continueSignalFile });

  const append = (chunk: Buffer | string): void => {
    job.output += chunk.toString();
  };

  child.stdout.on("data", append);
  child.stderr.on("data", append);

  child.on("close", (code) => {
    job.status = job.stopped ? "failed" : code === 0 ? "success" : "failed";
    if (job.stopped) {
      job.output += "\n[UI] Da dung job theo yeu cau nguoi dung (giu browser mo de thu lai).\n";
    }
    job.finishedAt = Date.now();
    job.child = undefined;
    const session = activeSessions.get(id);
    if (session) {
      activeSessions.delete(id);
      fs.unlink(session.continueSignalFile).catch(() => undefined);
    }
  });

  return job;
}

const defaults: UiDefaults = {
  out: getDefaultOutPath(),
  direction: (parseArgValue("--direction") as "sold" | "purchase" | undefined) ?? "sold",
};

const preferredPort = Number(process.env.UI_PORT ?? 4173);
const maxPortAttempts = Number(process.env.UI_PORT_FALLBACK_MAX ?? 25);
let activePort = preferredPort;

// Session logging
const sessionLogs: string[] = [];
const logsDir = join(process.cwd(), ".gdt-logs");
const sessionId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const currentSessionLogFile = join(logsDir, `session-${sessionId}.jsonl`);

// Create logs directory
fs.mkdir(logsDir, { recursive: true }).catch(() => {
  // Silently fail
});

function addLog(source: string, message: string, data?: unknown): void {
  const timestamp = new Date().toISOString();
  const entry = { timestamp, source, message, data };
  sessionLogs.push(JSON.stringify(entry));
  
  // Append to session log file
  fs.appendFile(currentSessionLogFile, JSON.stringify(entry) + "\n").catch(() => {
    // Silently fail - don't break on log write errors
  });
}

addLog("ui-server", "Server started", { port: preferredPort, sessionId, logFile: currentSessionLogFile });

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${activePort}`);

  if (req.method === "GET" && url.pathname === "/") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(html(defaults));
    return;
  }

  if (req.method === "GET" && url.pathname === "/sessions") {
    const list = Array.from(activeSessions.values())
      .map((s) => {
        const job = jobs.get(s.jobId);
        return {
          jobId: s.jobId,
          status: job?.status ?? "unknown",
          startedAt: job?.startedAt ?? 0,
        };
      })
      .sort((a, b) => b.startedAt - a.startedAt);
    writeJson(res, 200, { ok: true, sessions: list });
    return;
  }

  if (req.method === "POST" && url.pathname === "/start") {
    const raw = await readBody(req);
    let payload: StartPayload;

    try {
      payload = JSON.parse(raw) as StartPayload;
    } catch {
      addLog("ui-api", "/start parse error", { raw });
      writeJson(res, 400, { ok: false, output: "JSON khong hop le" });
      return;
    }

    const validationError = validateStartPayload(payload);
    if (validationError) {
      addLog("ui-api", "/start validation error", { error: validationError, payload });
      writeJson(res, 400, { ok: false, output: validationError });
      return;
    }

    const job = startJob(payload as RunPayload);
    addLog("ui-api", "/start job created", { jobId: job.id, payload });
    writeJson(res, 200, { ok: true, jobId: job.id });
    return;
  }

  if (req.method === "POST" && url.pathname === "/run") {
    const raw = await readBody(req);
    let payload: ContinuePayload = {};

    if (raw.trim()) {
      try {
        payload = JSON.parse(raw) as ContinuePayload;
      } catch {
        writeJson(res, 400, { ok: false, output: "JSON khong hop le" });
        return;
      }
    }

    const active =
      (payload.jobId ? activeSessions.get(payload.jobId) : undefined) ??
      Array.from(activeSessions.values()).at(-1);

    if (!active) {
      addLog("ui-api", "/run session not found", { jobId: payload.jobId });
      writeJson(res, 400, {
        ok: false,
        output: "Khong tim thay browser session dang cho tiep tuc. Vui long bam Bat dau lai.",
      });
      return;
    }

    const activeJob = jobs.get(active.jobId);
    if (activeJob && activeJob.status === "paused") {
      activeJob.status = "running";
      activeJob.output += "\n[UI] Tiep tuc flow dang tam dung tu session hien tai.\n";
    }

    addLog("ui-api", "/run signal sent", { jobId: active.jobId, signalFile: active.continueSignalFile });
    await fs.writeFile(active.continueSignalFile, "continue", "utf8");
    writeJson(res, 200, { ok: true, jobId: active.jobId });
    return;
  }

  if (req.method === "POST" && url.pathname === "/stop") {
    const raw = await readBody(req);
    let payload: ContinuePayload = {};

    if (raw.trim()) {
      try {
        payload = JSON.parse(raw) as ContinuePayload;
      } catch {
        writeJson(res, 400, { ok: false, output: "JSON khong hop le" });
        return;
      }
    }

    // Find the active job: by jobId or the latest running/paused one
    const job =
      (payload.jobId ? jobs.get(payload.jobId) : undefined) ??
      Array.from(jobs.values())
        .filter((j) => j.status === "running" || j.status === "paused")
        .sort((a, b) => b.startedAt - a.startedAt)[0];

    if (!job || (job.status !== "running" && job.status !== "paused")) {
      addLog("ui-api", "/stop no running job", { jobId: payload.jobId });
      writeJson(res, 400, { ok: false, output: "Khong co job dang chay de dung." });
      return;
    }

    addLog("ui-api", "/stop pausing job flow", { jobId: job.id });
    job.stopped = true;

    if (job.status === "running") {
      job.status = "paused";
      job.output += "\n[UI] Da tam dung flow hien tai theo yeu cau. Browser va session duoc giu nguyen.\n";
    }

    const session = activeSessions.get(job.id);
    if (session) {
      await fs.writeFile(session.continueSignalFile, "stop-current-flow", "utf8");
    }

    writeJson(res, 200, { ok: true, jobId: job.id });
    return;
  }

  if (req.method === "POST" && url.pathname === "/aggregate") {
    const running = Array.from(aggregateJobs.values()).find((job) => job.status === "running");
    if (running) {
      writeJson(res, 200, { ok: true, jobId: running.id });
      return;
    }

    const job = createAggregateJob();
    void runAggregateJob(job);
    writeJson(res, 200, { ok: true, jobId: job.id });
    return;
  }

  if (req.method === "POST" && url.pathname === "/rescan") {
    const raw = await readBody(req);
    let payload: ContinuePayload = {};

    if (raw.trim()) {
      try {
        payload = JSON.parse(raw) as ContinuePayload;
      } catch {
        writeJson(res, 400, { ok: false, output: "JSON khong hop le" });
        return;
      }
    }

    const session =
      (payload.jobId ? activeSessions.get(payload.jobId) : undefined) ??
      Array.from(activeSessions.values()).at(-1);

    if (!session) {
      writeJson(res, 400, {
        ok: false,
        output: "Khong tim thay session browser dang mo. Vui long bam Bat dau truoc.",
      });
      return;
    }

    const soldJson = join(process.cwd(), ".gdt-xml-export", "hd_sold.json");
    const purchasedJson = join(process.cwd(), ".gdt-xml-export", "hd_purchased.json");
    const hasSold = await pathExists(soldJson);
    const hasPurchased = await pathExists(purchasedJson);
    if (!hasSold || !hasPurchased) {
      writeJson(res, 400, {
        ok: false,
        output: "Thieu file nguon .gdt-xml-export/hd_sold.json hoac hd_purchased.json",
      });
      return;
    }

    const running = Array.from(rescanJobs.values()).find((job) => job.status === "running" && job.sourceJobId === session.jobId);
    if (running) {
      writeJson(res, 200, { ok: true, jobId: running.id, sourceJobId: running.sourceJobId });
      return;
    }

    const sourceJob = jobs.get(session.jobId);
    if (!sourceJob || sourceJob.status !== "running") {
      writeJson(res, 400, {
        ok: false,
        output: "Session browser khong con hoat dong. Vui long bam Bat dau de mo session moi.",
      });
      return;
    }

    if (!sourceJob.output.includes(CONTINUE_READY_MARKER)) {
      writeJson(res, 409, {
        ok: false,
        output:
          "Session chua san sang de ra lai. Vui long dang nhap GDT, chon ngay, bam Tim kiem den khi co bang ket qua roi thu lai.",
      });
      return;
    }

    const rescanJob = createRescanJob(session.jobId);
    void runRescanJob(rescanJob, session);
    writeJson(res, 200, { ok: true, jobId: rescanJob.id, sourceJobId: rescanJob.sourceJobId });
    return;
  }

  if (req.method === "GET" && url.pathname === "/aggregate-status") {
    const jobId = url.searchParams.get("jobId") ?? "";
    const job = aggregateJobs.get(jobId);
    if (!job) {
      writeJson(res, 404, { ok: false, output: "Khong tim thay job tong hop" });
      return;
    }

    writeJson(res, 200, {
      ok: true,
      job: {
        id: job.id,
        status: job.status,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        files: job.files,
      },
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/rescan-status") {
    const jobId = url.searchParams.get("jobId") ?? "";
    const job = rescanJobs.get(jobId);
    if (!job) {
      writeJson(res, 404, { ok: false, output: "Khong tim thay job ra lai" });
      return;
    }

    writeJson(res, 200, {
      ok: true,
      job: {
        id: job.id,
        sourceJobId: job.sourceJobId,
        status: job.status,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        files: job.files,
      },
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/events") {
    const jobId = url.searchParams.get("jobId") ?? "";
    const job = jobs.get(jobId);
    if (!job) {
      writeJson(res, 404, { ok: false, output: "Khong tim thay job" });
      return;
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    sseWrite(res, "status", { status: job.status });

    let cursor = 0;
    const interval = setInterval(() => {
      const current = jobs.get(jobId);
      if (!current) {
        clearInterval(interval);
        res.end();
        return;
      }

      if (current.output.length > cursor) {
        const chunk = current.output.slice(cursor);
        cursor = current.output.length;
        sseWrite(res, "log", { chunk });
      }

      sseWrite(res, "status", { status: current.status });
      if (current.status === "success" || current.status === "failed") {
        clearInterval(interval);
        setTimeout(() => res.end(), 50);
      }
    }, 250);

    req.on("close", () => {
      clearInterval(interval);
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/logs") {
    // Return logs as JSON
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    const logsData = sessionLogs.map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { message: line, timestamp: new Date().toISOString() };
      }
    });
    res.end(JSON.stringify(logsData, null, 2));
    return;
  }

  if (req.method === "GET" && url.pathname === "/export-logs") {
    // Download current extracted invoices in the same schema as invoice-items.json.
    const invoiceItemsPath = join(process.cwd(), ".gdt-xml-export", "invoice-items.json");
    try {
      const content = await fs.readFile(invoiceItemsPath, "utf8");
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Content-Disposition", "attachment; filename=\"invoice-items.json\"");
      res.end(content);
    } catch {
      // Keep response schema stable even when file is not generated yet.
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Content-Disposition", "attachment; filename=\"invoice-items.json\"");
      res.end("[]");
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/log-files") {
    // List all available log files
    try {
      const files = await fs.readdir(logsDir);
      const jsonlFiles = files
        .filter((f) => f.endsWith(".jsonl"))
        .sort()
        .reverse();
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ files: jsonlFiles, current: `session-${sessionId}.jsonl` }));
    } catch {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ files: [], current: `session-${sessionId}.jsonl` }));
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/download-log") {
    // Download a specific log file
    const filename = url.searchParams.get("file");
    if (!filename || !filename.endsWith(".jsonl")) {
      res.statusCode = 400;
      res.end("Invalid filename");
      return;
    }

    const filepath = join(logsDir, filename);
    // Security: ensure file is within logsDir
    if (!filepath.startsWith(logsDir)) {
      res.statusCode = 403;
      res.end("Forbidden");
      return;
    }

    try {
      const content = await fs.readFile(filepath, "utf8");
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.end(content);
    } catch {
      res.statusCode = 404;
      res.end("File not found");
    }
    return;
  }

  res.statusCode = 404;
  res.end("Not Found");
});

server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    const maxPort = preferredPort + maxPortAttempts;
    if (activePort < maxPort) {
      const nextPort = activePort + 1;
      console.warn(`Port ${activePort} dang duoc su dung, thu port ${nextPort}...`);
      activePort = nextPort;
      server.listen(activePort);
      return;
    }
  }

  console.error(`Khong the khoi dong UI server: ${error.message}`);
  process.exit(1);
});

server.listen(activePort, () => {
  console.log(`UI server running at http://localhost:${activePort}`);
});
