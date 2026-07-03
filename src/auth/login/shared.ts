import type { ManualFilterContext } from "../../shared/types.js";

const LOGIN_URL = "/";

const USERNAME_SELECTORS = [
  ".ant-modal input[placeholder*='Tên đăng nhập']",
  ".ant-modal input[placeholder*='Ten dang nhap']",
  ".ant-modal input[name='username']",
  ".ant-modal input[id*='username']",
  "input[placeholder*='Tên đăng nhập']",
  "input[placeholder*='Ten dang nhap']",
  "input[name='username']",
  "input[id*='username']",
  "input[autocomplete='username']",
  "input[type='text']",
];

const PASSWORD_SELECTORS = [
  ".ant-modal input[placeholder*='Mật khẩu']",
  ".ant-modal input[placeholder*='Mat khau']",
  ".ant-modal input[name='password']",
  ".ant-modal input[id*='password']",
  "input[placeholder*='Mật khẩu']",
  "input[placeholder*='Mat khau']",
  "input[name='password']",
  "input[id*='password']",
  "input[autocomplete='current-password']",
  "input[type='password']",
];

const CAPTCHA_SELECTORS = [
  ".ant-modal .ant-form-item:has-text('Nhập mã captcha') input",
  ".ant-modal .ant-form-item:has-text('Nhap ma captcha') input",
  ".ant-modal .ant-form-item:has-text('captcha') input",
  ".ant-modal input[aria-label*='captcha']",
];

const CAPTCHA_IMAGE_SELECTORS = [
  ".ant-modal img[src*='captcha']",
  ".ant-modal img[id*='captcha']",
  ".ant-modal img[class*='captcha']",
  "img[src*='captcha']",
  "img[id*='captcha']",
  "img[class*='captcha']",
];

const CAPTCHA_REFRESH_SELECTORS = [
  ".ant-modal .fa-refresh",
  ".ant-modal button[aria-label*='captcha']",
  ".ant-modal i[title*='captcha']",
  ".ant-modal [class*='refresh']",
  ".fa-refresh",
  "button[aria-label*='captcha']",
  "i[title*='captcha']",
  "[class*='refresh']",
];

const LOGIN_SUBMIT_SELECTORS = [
  ".ant-modal button:has-text('Đăng nhập')",
  ".ant-modal button:has-text('Dang nhap')",
  ".ant-modal button[type='submit']",
  "button:has-text('Đăng nhập')",
  "button:has-text('Dang nhap')",
  "button[type='submit']",
];

const MANUAL_READY_SELECTORS = [
  ".ant-table-tbody tr",
  "table tbody tr",
  "[class*='invoice'] table tbody tr",
  "[class*='result'] table tbody tr",
];

type ContinueAction = "continue" | "rescan-empty-line-items";

type RescanDataset = "sold" | "purchased";

interface RescanDatasetCounters {
  queued: number;
  processing: number;
  success: number;
  failed: number;
  skipped: number;
  currentKey?: string;
  message?: string;
}

interface RescanStatusPayload {
  dataset: RescanDataset;
  status: "running" | "success" | "failed";
  queued: number;
  processing: number;
  success: number;
  failed: number;
  skipped: number;
  currentKey?: string;
  message?: string;
}

interface RescanCandidate {
  dataset: RescanDataset;
  index: number;
  shdon: string;
  ngay: string;
  khhdon: string;
  khmshdon: string;
  key: string;
}

function normalizeInvoiceDate(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return "";
  }

  const compact = raw.split(/[\sT]/)[0]?.trim() ?? "";
  const ddmmyyyy = toDdMmYyyy(compact);
  if (ddmmyyyy) {
    return ddmmyyyy;
  }

  const parsed = parseDdMmYyyy(raw);
  if (parsed) {
    return `${String(parsed.day).padStart(2, "0")}/${String(parsed.month).padStart(2, "0")}/${parsed.year}`;
  }

  return raw;
}

function parseDdMmYyyy(value: string): { day: number; month: number; year: number } | null {
  const m = value.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) {
    return null;
  }

  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = Number(m[3]);
  const dt = new Date(year, month - 1, day);
  if (dt.getFullYear() !== year || dt.getMonth() !== month - 1 || dt.getDate() !== day) {
    return null;
  }

  return { day, month, year };
}

function toDdMmYyyy(value: string): string | undefined {
  const token = value.split("T")[0]?.trim() ?? "";
  if (!token) {
    return undefined;
  }

  const m = token.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) {
    return undefined;
  }

  const a = Number(m[1]);
  const b = Number(m[2]);
  const y = Number(m[3]);

  // Ambiguous dates default to DD/MM (consistent with GDT UI input).
  if (a > 12 && b <= 12) {
    return `${String(a).padStart(2, "0")}/${String(b).padStart(2, "0")}/${y}`;
  }

  // Clearly MM/DD format from API-style search strings.
  if (a <= 12 && b > 12) {
    return `${String(b).padStart(2, "0")}/${String(a).padStart(2, "0")}/${y}`;
  }

  return `${String(a).padStart(2, "0")}/${String(b).padStart(2, "0")}/${y}`;
}

function subtractOneDay(ddmmyyyy: string): string {
  const parts = parseDdMmYyyy(ddmmyyyy);
  if (!parts) {
    return ddmmyyyy;
  }

  const dt = new Date(parts.year, parts.month - 1, parts.day - 1);
  const dd = String(dt.getDate()).padStart(2, "0");
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const yyyy = String(dt.getFullYear());
  return `${dd}/${mm}/${yyyy}`;
}

function parseManualFilterFromRequestUrl(url: string): ManualFilterContext {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return {};
  }

  const pathname = parsed.pathname.toLowerCase();
  const context: ManualFilterContext = {};
  if (pathname.includes("/purchased")) {
    context.direction = "purchase";
  } else if (pathname.includes("/sold")) {
    context.direction = "sold";
  }

  const fromDirect =
    parsed.searchParams.get("from") ??
    parsed.searchParams.get("tngay") ??
    parsed.searchParams.get("tuNgay") ??
    parsed.searchParams.get("fromDate");
  const toDirect =
    parsed.searchParams.get("to") ??
    parsed.searchParams.get("dngay") ??
    parsed.searchParams.get("denNgay") ??
    parsed.searchParams.get("toDate");

  const fromValue = fromDirect ? toDdMmYyyy(fromDirect) : undefined;
  const toValue = toDirect ? toDdMmYyyy(toDirect) : undefined;
  if (fromValue) {
    context.from = fromValue;
  }
  if (toValue) {
    context.to = toValue;
  }

  const search = parsed.searchParams.get("search") ?? "";
  if (search) {
    const ge = search.match(/tdlap=ge=([^;]+)/i)?.[1];
    const le = search.match(/tdlap=le=([^;]+)/i)?.[1];
    const lt = search.match(/tdlap=lt=([^;]+)/i)?.[1];

    const fromSearch = ge ? toDdMmYyyy(ge) : undefined;
    if (fromSearch) {
      context.from = fromSearch;
    }

    const toSearchLe = le ? toDdMmYyyy(le) : undefined;
    if (toSearchLe) {
      context.to = toSearchLe;
    } else {
      const toSearchLt = lt ? toDdMmYyyy(lt) : undefined;
      if (toSearchLt) {
        context.to = subtractOneDay(toSearchLt);
      }
    }
  }

  return context;
}

export {
  LOGIN_URL,
  USERNAME_SELECTORS,
  PASSWORD_SELECTORS,
  CAPTCHA_SELECTORS,
  CAPTCHA_IMAGE_SELECTORS,
  CAPTCHA_REFRESH_SELECTORS,
  LOGIN_SUBMIT_SELECTORS,
  MANUAL_READY_SELECTORS,
  normalizeInvoiceDate,
  parseManualFilterFromRequestUrl,
};

export type {
  ContinueAction,
  RescanDataset,
  RescanDatasetCounters,
  RescanStatusPayload,
  RescanCandidate,
};

