import { toApiDateExclusiveEnd, toApiDateStart } from "../shared/date.js";
import { logger } from "../shared/logger.js";
import {
  type InvoiceBuyerNameMap,
  type InvoiceCrawlMetadata,
  type InvoiceCrawlMetadataMap,
  type InvoiceHeader,
  type InvoiceNameCollectionProgress,
  type InvoiceNameMap,
  type InvoiceType,
} from "../shared/types.js";
import { type ApiClient, withRetry } from "./client.js";

interface ListResponseShape {
  datas?: unknown[];
  content?: unknown[];
  items?: unknown[];
  result?: unknown[];
  data?: { content?: unknown[]; items?: unknown[]; result?: unknown[] };
}

function normalize(input: unknown): string {
  if (input == null) {
    return "";
  }
  return String(input).trim();
}

function detailCellText(value: unknown): string {
  if (value == null) {
    return "";
  }

  if (typeof value === "object") {
    const obj = value as { text?: unknown; richText?: Array<{ text?: unknown }> };
    if (typeof obj.text === "string") {
      return obj.text.trim();
    }

    if (Array.isArray(obj.richText)) {
      return obj.richText.map((part) => String(part.text ?? "")).join("").trim();
    }
  }

  return String(value).trim();
}

function extractBuyerFullName(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "";
  }

  const raw = payload as Record<string, unknown>;
  const nested = raw.data && typeof raw.data === "object" ? (raw.data as Record<string, unknown>) : null;
  const sources = nested ? [raw, nested] : [raw];

  for (const source of sources) {
    const direct = detailCellText(source.nmtnmua);
    if (direct) {
      return direct;
    }

    for (const [key, value] of Object.entries(source)) {
      const normalizedKey = normalize(key).toLowerCase();
      if (normalizedKey.includes("ho ten nguoi mua hang")) {
        const text = detailCellText(value);
        if (text) {
          return text;
        }
      }
    }
  }

  return "";
}

function extractInvoiceDetail(payload: unknown): { itemNames: string[]; buyerFullName: string } {
  if (!payload || typeof payload !== "object") {
    return { itemNames: [], buyerFullName: "" };
  }

  const raw = payload as Record<string, unknown>;
  const nested = raw.data && typeof raw.data === "object" ? (raw.data as Record<string, unknown>) : null;
  const source = nested ?? raw;
  const rows = Array.isArray(source.hdhhdvu)
    ? source.hdhhdvu
    : nested && Array.isArray(nested.hdhhdvu)
      ? nested.hdhhdvu
      : [];

  const itemNames = rows
    .map((row) => {
      if (!row || typeof row !== "object") {
        return "";
      }

      const obj = row as Record<string, unknown>;
      return normalize(obj.ten);
    })
    .filter(Boolean);

  return {
    itemNames,
    buyerFullName: extractBuyerFullName(payload),
  };
}

function parseInvoiceHeader(raw: unknown): InvoiceHeader | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const item = raw as Record<string, unknown>;
  const header: InvoiceHeader = {
    nbmst: normalize(item.nbmst ?? item.mst ?? item.msothue),
    khhdon: normalize(item.khhdon ?? item.kyhieu ?? item.kyhieuhoadon),
    khmshdon: normalize(item.khmshdon ?? item.kihieu ?? item.kyhieumauso ?? item.khsms),
    shdon: normalize(item.shdon ?? item.sohoadon ?? item.sohdon),
  };

  if (!header.shdon) {
    return null;
  }

  return header;
}

function extractList(data: ListResponseShape | unknown[]): unknown[] {
  if (Array.isArray(data)) {
    return data;
  }

  if (data && typeof data === "object") {
    const payload = data as ListResponseShape;
    return (
      payload.content ??
      payload.datas ??
      payload.items ??
      payload.result ??
      payload.data?.content ??
      payload.data?.items ??
      payload.data?.result ??
      []
    );
  }

  return [];
}

function toPercentText(raw: string): string {
  const v = raw.trim();
  if (!v) {
    return "";
  }

  if (v.endsWith("%")) {
    return v;
  }

  const n = Number(v);
  if (Number.isFinite(n)) {
    if (n > 0 && n < 1) {
      return `${(n * 100).toFixed(0)}%`;
    }
    return `${n.toFixed(0)}%`;
  }

  return v;
}

function formatLineItem(line: Record<string, unknown>): string {
  const ten = normalize(line.ten);
  const sluong = normalize(line.sluong);
  const dvtinh = normalize(line.dvtinh);
  const dgia = normalize(line.dgia);
  const thtien = normalize(line.thtien);
  const ltsuat = normalize(line.ltsuat) || toPercentText(normalize(line.tsuat));

  const fields = [ten, sluong, dvtinh, dgia, thtien, ltsuat];
  if (fields.every((field) => field === "")) {
    return "";
  }

  return fields.join(",");
}

function detailRows(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }

  const source = payload as Record<string, unknown>;
  const candidates = source.hdhhdvu ??
    (source.data && typeof source.data === "object" ? (source.data as Record<string, unknown>).hdhhdvu : undefined) ??
    source.items;

  if (!Array.isArray(candidates)) {
    return [];
  }

  return candidates
    .map((line) => {
      if (!line || typeof line !== "object") {
        return "";
      }
      return formatLineItem(line as Record<string, unknown>);
    })
    .filter(Boolean);
}

export function invoiceKey(invoice: InvoiceHeader): string {
  return `${invoice.khhdon.toUpperCase()}|${invoice.shdon}`;
}

export async function listSoldInvoices(
  client: ApiClient,
  from: string,
  to: string,
  invoiceType: InvoiceType,
  soldEndpoint: string,
  endpointProfile: "standard" | "third-party",
  mst: string,
): Promise<InvoiceHeader[]> {
  const size = 50;
  const fetchByParams = async (
    buildParams: (page: number) => Record<string, string | number>,
  ): Promise<InvoiceHeader[]> => {
    let page = 0;
    const all: InvoiceHeader[] = [];

    while (true) {
      const data = await withRetry(
        () =>
          client.get<ListResponseShape>(soldEndpoint, {
            params: buildParams(page),
          }),
        3,
        400,
      );

      const rows = extractList(data).map(parseInvoiceHeader).filter((item): item is InvoiceHeader => Boolean(item));
      all.push(...rows);

      if (rows.length < size) {
        break;
      }

      page += 1;
    }

    return all;
  };

  if (endpointProfile === "third-party") {
    return fetchByParams((page) => ({
      mst,
      tngay: from,
      dngay: to,
      sort: "tdlap:desc",
      size,
      page,
    }));
  }

  const standardSearch = `tdlap=ge=${toApiDateStart(from)};tdlap=le=${toApiDateExclusiveEnd(to)}`;  // GDT uses le= (inclusive)
  const strategies: Array<(page: number) => Record<string, string | number>> = [
    // Common for standard profile
    (page) => ({ sort: "tdlap:desc", size, page, search: standardSearch, type: invoiceType }),
    (page) => ({ sort: "tdlap:desc", size, page, search: standardSearch }),
    // Some accounts accept date params directly
    (page) => ({ sort: "tdlap:desc", size, page, tngay: from, dngay: to }),
    (page) => ({ sort: "tdlap:desc", size, page, mst, tngay: from, dngay: to }),
    // UI-style filter variants observed on some tenants
    (page) => ({ sort: "tdlap:desc", size, page, from, to, type: invoiceType }),
    (page) => ({ sort: "tdlap:desc", size, page, from, to }),
  ];

  const errors: string[] = [];
  for (let si = 0; si < strategies.length; si += 1) {
    if (si > 0) {
      // Exponential backoff: 1s, 2s, 4s, 8s to avoid 429 Too Many Requests
      const delayMs = 1000 * Math.pow(2, Math.min(si - 1, 3));
      logger.info(`[DEBUG] Backoff ${delayMs}ms before strategy ${si + 1}/${strategies.length} (avoid 429)`);
      await new Promise((r) => setTimeout(r, delayMs));
    }

    const strategy = strategies[si]!;
    logger.info(`[DEBUG] sold-strategy ${si + 1}/${strategies.length}: params=${JSON.stringify(strategy(0))}`);
    try {
      const rows = await fetchByParams(strategy);
      if (rows.length > 0) {
        logger.info(`[DEBUG] sold-strategy ${si + 1} returned ${rows.length} rows`);
        return rows;
      }
      logger.info(`[DEBUG] sold-strategy ${si + 1} returned 0 rows, trying next`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`[DEBUG] sold-strategy ${si + 1} error: ${message.slice(0, 200)}`);
      errors.push(message);
    }
  }

  if (errors.length > 0) {
    throw new Error(`Sold query failed across strategies: ${errors.slice(0, 4).join(" | ")}`);
  }

  return [];
}

export async function getInvoiceItemNames(
  client: ApiClient,
  invoice: InvoiceHeader,
  detailEndpoint: string,
  endpointProfile: "standard" | "third-party",
  mst: string,
  from: string,
  to: string,
): Promise<{ itemNames: string[]; buyerFullName: string }> {
  const data = await withRetry(
    () =>
      client.get<unknown>(detailEndpoint, {
        params:
          endpointProfile === "third-party"
            ? {
                mst,
                tngay: from,
                dngay: to,
                nbmst: invoice.nbmst,
                khhdon: invoice.khhdon,
                shdon: invoice.shdon,
                khmshdon: invoice.khmshdon,
              }
            : {
                nbmst: invoice.nbmst,
                khhdon: invoice.khhdon,
                shdon: invoice.shdon,
                khmshdon: invoice.khmshdon,
              },
      }),
    3,
    500,
  );

  return extractInvoiceDetail(data);
}

export async function collectInvoiceNameMap(
  client: ApiClient,
  invoices: InvoiceHeader[],
  options: {
    concurrency: number;
    delayMs: number;
    detailEndpoint: string;
    endpointProfile: "standard" | "third-party";
    mst: string;
    from: string;
    to: string;
    resumeFromIndex?: number;
    seedMap?: InvoiceNameMap;
    seedBuyerNames?: InvoiceBuyerNameMap;
    seedMetadata?: InvoiceCrawlMetadataMap;
    seedFailed?: Array<{ key: string; shdon: string }>;
    onProgress?: (progress: InvoiceNameCollectionProgress) => Promise<void> | void;
    shouldStop?: () => Promise<boolean> | boolean;
  },
): Promise<{
  map: InvoiceNameMap;
  buyerNames: InvoiceBuyerNameMap;
  metadata: InvoiceCrawlMetadataMap;
  failed: InvoiceHeader[];
  stopped: boolean;
  nextIndex: number;
}> {
  const byComposite = new Map(options.seedMap?.byComposite ?? []);
  const byNumberOnly = new Map(options.seedMap?.byNumberOnly ?? []);
  const buyerByComposite = new Map(options.seedBuyerNames?.byComposite ?? []);
  const buyerByNumberOnly = new Map(options.seedBuyerNames?.byNumberOnly ?? []);
  const metadataByComposite = new Map(options.seedMetadata?.byComposite ?? []);
  const metadataByNumber = new Map(options.seedMetadata?.byNumberOnly ?? []);
  const failedKeys = new Map<string, { key: string; shdon: string }>();

  for (const entry of options.seedFailed ?? []) {
    failedKeys.set(entry.key, { key: entry.key, shdon: entry.shdon });
  }

  const startIndex = Math.max(0, options.resumeFromIndex ?? 0);

  for (let index = startIndex; index < invoices.length; index += 1) {
    if (await options.shouldStop?.()) {
      const failedInvoices: InvoiceHeader[] = Array.from(failedKeys.values())
        .map((entry) => invoices.find((invoice) => invoice && invoiceKey(invoice) === entry.key))
        .filter((invoice): invoice is InvoiceHeader => Boolean(invoice));

      return {
        map: { byComposite, byNumberOnly },
        buyerNames: { byComposite: buyerByComposite, byNumberOnly: buyerByNumberOnly },
        metadata: { byComposite: metadataByComposite, byNumberOnly: metadataByNumber },
        failed: failedInvoices,
        stopped: true,
        nextIndex: index,
      };
    }

    const invoice = invoices[index];
    if (!invoice) {
      continue;
    }

    if (index > startIndex && options.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    }

    const key = invoiceKey(invoice);
    const pageIndex = Math.floor(index / 50) + 1;
    const baseMetadata: InvoiceCrawlMetadata = {
      source: "api",
      crawledAt: new Date().toISOString(),
      page: String(pageIndex),
      itemCount: 0,
      status: "failed",
    };

    try {
      const detail = await getInvoiceItemNames(
        client,
        invoice,
        options.detailEndpoint,
        options.endpointProfile,
        options.mst,
        options.from,
        options.to,
      );

      const detailLines = detail.itemNames;

      if (detailLines.length === 0) {
        metadataByComposite.set(key, baseMetadata);
        metadataByNumber.set(invoice.shdon, baseMetadata);
        failedKeys.set(key, { key, shdon: invoice.shdon });
      } else {
        const joined = detailLines.join("\n");
        byComposite.set(key, joined);
        byNumberOnly.set(invoice.shdon, joined);
        if (detail.buyerFullName) {
          buyerByComposite.set(key, detail.buyerFullName);
          buyerByNumberOnly.set(invoice.shdon, detail.buyerFullName);
        }

        const metadata: InvoiceCrawlMetadata = {
          ...baseMetadata,
          itemCount: detailLines.length,
          status: "success",
        };
        metadataByComposite.set(key, metadata);
        metadataByNumber.set(invoice.shdon, metadata);
        failedKeys.delete(key);
      }
    } catch {
      metadataByComposite.set(key, baseMetadata);
      metadataByNumber.set(invoice.shdon, baseMetadata);
      failedKeys.set(key, { key, shdon: invoice.shdon });
    }

    await options.onProgress?.({
      nextIndex: index + 1,
      map: {
        byComposite,
        byNumberOnly,
      },
      buyerNames: {
        byComposite: buyerByComposite,
        byNumberOnly: buyerByNumberOnly,
      },
      metadata: {
        byComposite: metadataByComposite,
        byNumberOnly: metadataByNumber,
      },
      failed: Array.from(failedKeys.values()),
    });
  }

  const failedInvoices: InvoiceHeader[] = Array.from(failedKeys.values())
    .map((entry) => invoices.find((invoice) => invoice && invoiceKey(invoice) === entry.key))
    .filter((invoice): invoice is InvoiceHeader => Boolean(invoice));

  return {
    map: { byComposite, byNumberOnly },
    buyerNames: { byComposite: buyerByComposite, byNumberOnly: buyerByNumberOnly },
    metadata: { byComposite: metadataByComposite, byNumberOnly: metadataByNumber },
    failed: failedInvoices,
    stopped: false,
    nextIndex: invoices.length,
  };
}
