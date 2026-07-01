import type { ApiClient } from "./api/client.js";
import { toApiDateExclusiveEnd, toApiDateStart } from "./shared/date.js";
import { logger } from "./shared/logger.js";
import type { AppConfig } from "./shared/config.js";

// ─── captcha probe ────────────────────────────────────────────────────────────

interface CaptchaProbeResult {
  ok: boolean;
  url: string;
  contentType: string;
  byteSize: number;
  hasTextElement: boolean;
  hasTspanElement: boolean;
  hasPathOnly: boolean;
  extractedText: string | null;
  raw: string | null;
}

async function probeCaptcha(config: AppConfig): Promise<CaptchaProbeResult> {
  const { launch } = await import("cloakbrowser");
  const headless = (process.env.GDT_HEADLESS ?? "false").toLowerCase() === "true";
  const browser = await launch({ headless });

  try {
    const page = await browser.newPage();
    try {
      await page.goto(config.baseUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
    } catch {
      await page.goto(config.baseUrl, { waitUntil: "load", timeout: 30000 });
    }

    // Close blocking announcement and open login modal first.
    await page.locator("button[aria-label='Close'], .ant-modal-close").first().click().catch(() => undefined);
    await page.keyboard.press("Escape").catch(() => undefined);
    await page.waitForTimeout(300);
    await page.locator("div.header-item", { hasText: "Đăng nhập" }).first().click({ force: true }).catch(() => undefined);
    await page.locator("div.home-header-menu-item", { hasText: "Đăng nhập" }).first().click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(600);

    // Try to find captcha in login modal first.
    const candidates = [
      ".ant-modal img[src*='captcha']",
      ".ant-modal img[id*='captcha']",
      ".ant-modal img[class*='captcha']",
      "img[src*='captcha']",
      "img[id*='captcha']",
      "img[class*='captcha']",
    ];

    let captchaUrl = "";
    for (const selector of candidates) {
      const el = page.locator(selector).first();
      if (await el.count()) {
        captchaUrl = (await el.getAttribute("src")) ?? "";
        break;
      }
    }

    // Also scan all img srcs
    if (!captchaUrl) {
      const allSrcs: string[] = await page.evaluate(() =>
        Array.from(document.querySelectorAll("img")).map((el) => el.src ?? ""),
      );
      captchaUrl = allSrcs.find((s) => s.toLowerCase().includes("captcha")) ?? "";
    }

    if (!captchaUrl) {
      return {
        ok: false,
        url: "",
        contentType: "",
        byteSize: 0,
        hasTextElement: false,
        hasTspanElement: false,
        hasPathOnly: false,
        extractedText: null,
        raw: null,
      };
    }

    let raw = "";
    let contentType = "";
    let byteSize = 0;

    if (captchaUrl.startsWith("data:")) {
      const comma = captchaUrl.indexOf(",");
      const meta = captchaUrl.substring(5, comma);
      contentType = meta.split(";")[0] ?? "";
      const encoded = captchaUrl.substring(comma + 1);
      raw = meta.includes("base64")
        ? Buffer.from(encoded, "base64").toString("utf8")
        : decodeURIComponent(encoded);
      byteSize = raw.length;
    } else {
      const resp = await page.context().request.get(captchaUrl);
      contentType = resp.headers()["content-type"] ?? "";
      const body = await resp.body();
      byteSize = body.length;
      raw = body.toString("utf8");
    }

    const isSvg = contentType.includes("svg") || raw.trim().startsWith("<svg") || raw.trim().startsWith("<?xml");
    if (!isSvg) {
      return {
        ok: true,
        url: captchaUrl.substring(0, 120),
        contentType,
        byteSize,
        hasTextElement: false,
        hasTspanElement: false,
        hasPathOnly: false,
        extractedText: null,
        raw: null,
      };
    }

    const textMatches = Array.from(raw.matchAll(/<text[^>]*>([^<]*)<\/text>/gi));
    const tspanMatches = Array.from(raw.matchAll(/<tspan[^>]*>([^<]*)<\/tspan>/gi));
    const pathMatches = (raw.match(/<path/gi) ?? []).length;

    const textContent = [...textMatches, ...tspanMatches]
      .map((m) => (m[1] ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase())
      .join("");

    return {
      ok: true,
      url: captchaUrl.substring(0, 120),
      contentType,
      byteSize,
      hasTextElement: textMatches.length > 0,
      hasTspanElement: tspanMatches.length > 0,
      hasPathOnly: pathMatches > 0 && textMatches.length === 0 && tspanMatches.length === 0,
      extractedText: textContent || null,
      raw: isSvg ? raw.substring(0, 600) : null,
    };
  } finally {
    await browser.close();
  }
}

// ─── sold probe ──────────────────────────────────────────────────────────────

interface SoldProbeResult {
  ok: boolean;
  endpoint: string;
  error?: string;
  totalItems: number;
  firstPageSize: number;
  paginationField: string | null;
  topLevelKeys: string[];
  sampleItem: Record<string, unknown> | null;
  hasLineItems: boolean;
  lineItemsKey: string | null;
  sampleLineItem: Record<string, unknown> | null;
}

async function probeSold(
  client: ApiClient,
  from: string,
  to: string,
  endpoint: string,
  invoiceType: string,
  endpointProfile: "standard" | "third-party",
  mst: string,
): Promise<SoldProbeResult> {
  try {
    const data = await client.get<unknown>(endpoint, {
      params:
        endpointProfile === "third-party"
          ? {
              mst,
              tngay: from,
              dngay: to,
              sort: "tdlap:desc",
              size: 5,
              page: 0,
            }
          : {
              sort: "tdlap:desc",
              size: 5,
              page: 0,
              search: `tdlap=ge=${toApiDateStart(from)};tdlap=le=${toApiDateExclusiveEnd(to)}`,
              type: invoiceType,
            },
    });

    const topLevelKeys = data && typeof data === "object" ? Object.keys(data as object) : [];
    const raw = data as Record<string, unknown>;

    const candidates = [raw.content, raw.datas, raw.items, raw.result, raw.data];
    let list: unknown[] = [];
    let paginationField: string | null = null;
    for (const c of candidates) {
      if (Array.isArray(c)) {
        list = c;
        paginationField = topLevelKeys.find((k) => ["content", "items", "result"].includes(k)) ?? null;
        break;
      }
    }

    if (list.length === 0 && Array.isArray(data)) {
      list = data as unknown[];
    }

    const sampleItem = list[0] && typeof list[0] === "object" ? (list[0] as Record<string, unknown>) : null;

    let hasLineItems = false;
    let lineItemsKey: string | null = null;
    let sampleLineItem: Record<string, unknown> | null = null;

    if (sampleItem) {
      for (const key of ["hdhhdvu", "items", "lines", "chitiet", "hdvt"]) {
        const v = sampleItem[key];
        if (Array.isArray(v) && v.length > 0) {
          hasLineItems = true;
          lineItemsKey = key;
          sampleLineItem = typeof v[0] === "object" && v[0] !== null ? (v[0] as Record<string, unknown>) : null;
          break;
        }
      }
    }

    const totalRaw = raw.totalElements ?? raw.total ?? raw.count ?? (raw.data && typeof raw.data === "object" ? (raw.data as Record<string, unknown>).totalElements : undefined);

    return {
      ok: true,
      endpoint,
      totalItems: typeof totalRaw === "number" ? totalRaw : list.length,
      firstPageSize: list.length,
      paginationField,
      topLevelKeys,
      sampleItem: sampleItem ? { ...sampleItem } : null,
      hasLineItems,
      lineItemsKey,
      sampleLineItem,
    };
  } catch (error) {
    return {
      ok: false,
      endpoint,
      error: (error as Error).message,
      totalItems: 0,
      firstPageSize: 0,
      paginationField: null,
      topLevelKeys: [],
      sampleItem: null,
      hasLineItems: false,
      lineItemsKey: null,
      sampleLineItem: null,
    };
  }
}

// ─── detail probe ─────────────────────────────────────────────────────────────

interface DetailProbeResult {
  ok: boolean;
  endpoint: string;
  error?: string;
  topLevelKeys: string[];
  hdhhdvuPresent: boolean;
  hdhhdvuLength: number;
  sampleTen: string | null;
  allLineKeys: string[];
}

async function probeDetail(
  client: ApiClient,
  endpoint: string,
  nbmst: string,
  khhdon: string,
  shdon: string,
  khmshdon: string,
): Promise<DetailProbeResult> {
  try {
    const data = await client.get<unknown>(endpoint, {
      params: { nbmst, khhdon, shdon, khmshdon },
    });

    const topLevelKeys = data && typeof data === "object" ? Object.keys(data as object) : [];
    const raw = data as Record<string, unknown>;

    const nestedData = raw.data && typeof raw.data === "object" ? (raw.data as Record<string, unknown>) : null;
    const hdhhdvu = Array.isArray(raw.hdhhdvu)
      ? raw.hdhhdvu
      : nestedData && Array.isArray(nestedData.hdhhdvu)
        ? nestedData.hdhhdvu
        : null;

    const firstLine = hdhhdvu?.[0];
    const allLineKeys = firstLine && typeof firstLine === "object" ? Object.keys(firstLine as object) : [];
    const sampleTen = firstLine && typeof firstLine === "object" ? ((firstLine as Record<string, unknown>).ten as string | undefined) ?? null : null;

    return {
      ok: true,
      endpoint,
      topLevelKeys,
      hdhhdvuPresent: hdhhdvu !== null,
      hdhhdvuLength: hdhhdvu?.length ?? 0,
      sampleTen,
      allLineKeys,
    };
  } catch (error) {
    return {
      ok: false,
      endpoint,
      error: (error as Error).message,
      topLevelKeys: [],
      hdhhdvuPresent: false,
      hdhhdvuLength: 0,
      sampleTen: null,
      allLineKeys: [],
    };
  }
}

// ─── export probe ─────────────────────────────────────────────────────────────

interface ExportProbeResult {
  endpoint: string;
  ok: boolean;
  isXlsx: boolean;
  byteSize: number;
  error: string | null;
}

async function probeExportEndpoints(
  client: ApiClient,
  from: string,
  to: string,
  invoiceType: string,
  endpointProfile: "standard" | "third-party",
  mst: string,
  endpoints: string[],
): Promise<ExportProbeResult[]> {
  const results: ExportProbeResult[] = [];

  for (const endpoint of endpoints) {
    try {
      const buf = await client.getBuffer(endpoint, {
        params:
          endpointProfile === "third-party"
            ? {
                mst,
                tngay: from,
                dngay: to,
              }
            : {
                search: `tdlap=ge=${toApiDateStart(from)};tdlap=le=${toApiDateExclusiveEnd(to)}`,
                type: invoiceType,
              },
      });

      const isXlsx = buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b;
      results.push({ endpoint, ok: true, isXlsx, byteSize: buf.length, error: null });
    } catch (error) {
      results.push({
        endpoint,
        ok: false,
        isXlsx: false,
        byteSize: 0,
        error: (error as Error).message.substring(0, 120),
      });
    }
  }

  return results;
}

// ─── main verify runner ───────────────────────────────────────────────────────

export interface VerifyOptions {
  from: string;
  to: string;
  config: AppConfig;
  client: ApiClient;
}

export async function runVerify(opts: VerifyOptions): Promise<void> {
  const { from, to, config, client } = opts;
  const SEP = "─".repeat(56);

  logger.info(`Bat dau verify API endpoints (${from} → ${to})`);
  console.log();

  // ── 2.1 Captcha ──────────────────────────────────────────────────────────
  console.log(`${SEP}\n[2.1] Captcha endpoint\n${SEP}`);
  try {
    const cap = await probeCaptcha(config);
    if (!cap.ok) {
      console.log("  ✗ Khong tim thay captcha tren trang dang nhap");
    } else {
      console.log(`  URL (truncated): ${cap.url}`);
      console.log(`  Content-Type:   ${cap.contentType}`);
      console.log(`  Size:           ${cap.byteSize} bytes`);
      console.log(`  <text> present: ${cap.hasTextElement}`);
      console.log(`  <tspan> present:${cap.hasTspanElement}`);
      console.log(`  path-only SVG:  ${cap.hasPathOnly}`);
      if (cap.extractedText) {
        console.log(`  Extracted text: "${cap.extractedText}"  ← SVG-text strategy will WORK`);
      } else {
        console.log(`  Extracted text: (none) ← SVG-text strategy unavailable, will use OCR fallback`);
      }
      if (cap.raw) {
        console.log(`\n  SVG preview (first 600 chars):\n  ${cap.raw.replace(/\n/g, "\n  ")}`);
      }
    }
  } catch (error) {
    console.log(`  ✗ Loi: ${(error as Error).message}`);
  }
  console.log();

  // ── 2.2 Sold list ─────────────────────────────────────────────────────────
  console.log(`${SEP}\n[2.2] /sold endpoint\n${SEP}`);
  const soldResult = await probeSold(
    client,
    from,
    to,
    config.soldEndpoint,
    config.invoiceType,
    config.endpointProfile,
    config.username,
  );
  if (!soldResult.ok) {
    console.log(`  ✗ Goi /sold that bai (${soldResult.endpoint}): ${soldResult.error ?? "unknown"}`);
  } else {
    console.log(`  Top-level keys:   ${soldResult.topLevelKeys.join(", ")}`);
    console.log(`  Pagination field: ${soldResult.paginationField ?? "(array truc tiep)"}`);
    console.log(`  Total items:      ${soldResult.totalItems}`);
    console.log(`  First page count: ${soldResult.firstPageSize}`);
    console.log(`  Has line items:   ${soldResult.hasLineItems} ${soldResult.lineItemsKey ? `(key: ${soldResult.lineItemsKey})` : ""}`);
    if (soldResult.sampleItem) {
      const keys = Object.keys(soldResult.sampleItem).slice(0, 20);
      console.log(`  Sample item keys: ${keys.join(", ")}`);
    }
    if (soldResult.hasLineItems && soldResult.sampleLineItem) {
      console.log(`  Line item keys:   ${Object.keys(soldResult.sampleLineItem).join(", ")}`);
      console.log(`  → /detail call NOT needed (line items already in /sold response!)`);
    }
  }
  console.log();

  // ── 2.3 Detail ───────────────────────────────────────────────────────────
  console.log(`${SEP}\n[2.3] /detail endpoint\n${SEP}`);
  if (soldResult.ok && soldResult.sampleItem) {
    const sample = soldResult.sampleItem;
    const nbmst = String(sample.nbmst ?? "");
    const khhdon = String(sample.khhdon ?? "");
    const shdon = String(sample.shdon ?? "");
    const khmshdon = String(sample.khmshdon ?? "");
    console.log(`  Using invoice: nbmst=${nbmst} khhdon=${khhdon} shdon=${shdon} khmshdon=${khmshdon}`);
    const det = await probeDetail(client, config.detailEndpoint, nbmst, khhdon, shdon, khmshdon);
    if (!det.ok) {
      console.log(`  ✗ Goi /detail that bai (${det.endpoint}): ${det.error ?? "unknown"}`);
    } else {
      console.log(`  Top-level keys:   ${det.topLevelKeys.join(", ")}`);
      console.log(`  hdhhdvu present:  ${det.hdhhdvuPresent}`);
      console.log(`  hdhhdvu length:   ${det.hdhhdvuLength}`);
      console.log(`  Line item keys:   ${det.allLineKeys.join(", ")}`);
      if (det.sampleTen !== null) {
        console.log(`  sample "ten":     "${det.sampleTen}"  ← field TEN confirmed`);
      } else {
        console.log(`  sample "ten":     (null/absent) ← check actual key name above`);
      }
    }
  } else {
    console.log("  Skip: khong co hoa don trong khoang ngay de thu");
  }
  console.log();

  // ── 2.4 Export ───────────────────────────────────────────────────────────
  console.log(`${SEP}\n[2.4] Export endpoints\n${SEP}`);
  const exportResults = await probeExportEndpoints(
    client,
    from,
    to,
    config.invoiceType,
    config.endpointProfile,
    config.username,
    config.exportEndpoints,
  );
  for (const r of exportResults) {
    if (r.ok) {
      const verdict = r.isXlsx ? "✓ xlsx (PK magic bytes)" : "✗ not xlsx";
      console.log(`  ${r.endpoint}: ${verdict}, ${r.byteSize} bytes`);
    } else {
      console.log(`  ${r.endpoint}: ✗ ${r.error}`);
    }
  }
  console.log();

  logger.info("Verify hoan tat. Kiem tra ket qua tren de chinh config neu can.");
}
