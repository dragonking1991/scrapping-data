import path from "node:path";
import { type InvoiceType } from "./types.js";

export interface AppConfig {
  baseUrl: string;
  username: string;
  password: string;
  manualFirst: boolean;
  endpointProfile: "standard" | "third-party";
  soldEndpoint: string;
  detailEndpoint: string;
  purchasedEndpoint: string;
  purchasedDetailEndpoint: string;
  captchaMode: "auto" | "manual";
  captchaMaxAttempts: number;
  tokenCachePath: string;
  requestDelayMs: number;
  requestConcurrency: number;
  checkpointPath: string;
  resumeOnRelogin: boolean;
  relogin: boolean;
  useTokenCache: boolean;
  invoiceType: InvoiceType;
  exportEndpoints: string[];
  purchasedExportEndpoints: string[];
}

function readBoolean(input: string | undefined, fallback: boolean): boolean {
  if (input == null) {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(input.toLowerCase());
}

function readNumber(input: string | undefined, fallback: number): number {
  if (input == null || input.trim() === "") {
    return fallback;
  }

  const parsed = Number(input);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

export function getConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const baseUrl = (process.env.GDT_BASE_URL ?? "https://hoadondientu.gdt.gov.vn").replace(/\/$/, "");
  const endpointProfile = (process.env.GDT_ENDPOINT_PROFILE ?? "third-party") as "standard" | "third-party";
  const exportEndpoints = (
    process.env.GDT_EXPORT_ENDPOINTS ??
    (endpointProfile === "third-party"
      ? "/api/query/invoices/user-third-party/export-excel-sold,/api/query/invoices/user-third-party/export-xml-sold"
      : "/api/query/invoices/export-excel,/api/query/invoices/export-xml")
  )
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

  const purchasedExportEndpoints = (
    process.env.GDT_PURCHASED_EXPORT_ENDPOINTS ??
    "/api/query/invoices/purchased/export-excel,/api/query/invoices/purchased/export-xml"
  )
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

  return {
    baseUrl,
    username: process.env.GDT_USERNAME ?? "",
    password: process.env.GDT_PASSWORD ?? "",
    manualFirst: readBoolean(process.env.GDT_MANUAL_FIRST, false),
    endpointProfile,
    soldEndpoint:
      process.env.GDT_SOLD_ENDPOINT ??
      (endpointProfile === "third-party" ? "/api/query/invoices/user-third-party/sold" : "/api/query/invoices/sold"),
    detailEndpoint:
      process.env.GDT_DETAIL_ENDPOINT ??
      (endpointProfile === "third-party"
        ? "/api/query/invoices/user-third-party/detail-sold"
        : "/api/query/invoices/detail"),
    purchasedEndpoint: process.env.GDT_PURCHASED_ENDPOINT ?? "/api/query/invoices/purchased",
    purchasedDetailEndpoint: process.env.GDT_PURCHASED_DETAIL_ENDPOINT ?? "/api/query/invoices/detail-purchased",
    captchaMode: (process.env.GDT_CAPTCHA_MODE ?? "auto").toLowerCase() === "manual" ? "manual" : "auto",
    captchaMaxAttempts: readNumber(process.env.GDT_CAPTCHA_MAX_ATTEMPTS, 8),
    tokenCachePath: process.env.GDT_TOKEN_CACHE_PATH ?? path.resolve(process.cwd(), ".token.json"),
    requestDelayMs: readNumber(process.env.GDT_REQUEST_DELAY_MS, 200),
    requestConcurrency: readNumber(process.env.GDT_REQUEST_CONCURRENCY, 4),
    checkpointPath: process.env.GDT_CHECKPOINT_PATH ?? path.resolve(process.cwd(), ".checkpoint.json"),
    resumeOnRelogin: readBoolean(process.env.GDT_RESUME_ON_RELOGIN, true),
    relogin: readBoolean(process.env.GDT_RELOGIN, false),
    useTokenCache: readBoolean(process.env.GDT_USE_TOKEN_CACHE, true),
    invoiceType: (process.env.GDT_INVOICE_TYPE as InvoiceType | undefined) ?? "invoice",
    exportEndpoints,
    purchasedExportEndpoints,
    ...overrides,
  };
}

export function sanitizeBaseUrl(baseUrl: string, endpoint: string): string {
  if (endpoint.startsWith("http://") || endpoint.startsWith("https://")) {
    return endpoint;
  }

  return `${baseUrl}${endpoint.startsWith("/") ? endpoint : `/${endpoint}`}`;
}
