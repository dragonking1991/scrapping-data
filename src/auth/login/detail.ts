import type { Page } from "playwright-core";
import { clickFirstAvailable } from "./ui-manual.js";

interface InvoiceDetail {
  info: Record<string, string>;
  lineItems: Array<Record<string, string>>;
  itemNames: string[];
}

function buildDetailFromApiPayload(payload: unknown): InvoiceDetail {
  const raw = (payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {}) ?? {};
  const nested =
    raw.data && typeof raw.data === "object"
      ? (raw.data as Record<string, unknown>)
      : null;

  const rows = Array.isArray(raw.hdhhdvu)
    ? raw.hdhhdvu
    : nested && Array.isArray(nested.hdhhdvu)
      ? nested.hdhhdvu
      : [];

  const lineItems: Array<Record<string, string>> = [];
  const itemNames: string[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") {
      continue;
    }
    const obj = row as Record<string, unknown>;
    const rec: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj)) {
      rec[k] = v == null ? "" : String(v);
    }
    lineItems.push(rec);
    const ten = obj.ten == null ? "" : String(obj.ten).trim();
    if (ten) {
      itemNames.push(ten);
    }
  }

  const info: Record<string, string> = {};
  const source = nested ?? raw;
  for (const key of [
    "tnmua",
    "tnban",
    "nmst",
    "nbmst",
    "dcmua",
    "dcban",
    "dvtte",
    "htttoan",
    "shdon",
    "khhdon",
    "khmshdon",
  ]) {
    const val = source[key];
    if (val != null && String(val).trim()) {
      info[key] = String(val).trim();
    }
  }

  return { info, lineItems, itemNames };
}

async function tryExtractDetailFromNetwork(
  page: Page,
  record: { shdon: string; khhdon: string; khmshdon: string; mst: string },
  timeoutMs: number,
): Promise<InvoiceDetail | null> {
  try {
    const response = await page.waitForResponse(
      async (resp) => {
        const url = resp.url();
        if (!/\/detail/i.test(url)) {
          return false;
        }
        const reqUrl = new URL(url);
        const shdon = reqUrl.searchParams.get("shdon") ?? "";
        const khhdon = reqUrl.searchParams.get("khhdon") ?? "";
        const khmshdon = reqUrl.searchParams.get("khmshdon") ?? "";
        const maybeMatch =
          (!record.shdon || shdon === record.shdon) &&
          (!record.khhdon || khhdon === record.khhdon) &&
          (!record.khmshdon || khmshdon === record.khmshdon);
        if (!maybeMatch) {
          return false;
        }
        return resp.ok();
      },
      { timeout: timeoutMs },
    );

    const payload = (await response.json().catch(() => null)) as unknown;
    if (!payload) {
      return null;
    }

    const detail = buildDetailFromApiPayload(payload);
    return detail.itemNames.length ? detail : null;
  } catch {
    return null;
  }
}

/**
 * tsx/esbuild compiles with `keepNames`, which wraps inner named functions
 * (e.g. `const norm = ...`) inside `page.evaluate` bodies with a `__name(...)`
 * helper. That helper is undefined in the browser context, so every such
 * evaluate throws `ReferenceError: __name is not defined` and returns nothing.
 * Installing a no-op shim on every document makes evaluated code run correctly.
 */
export async function installEvalShim(page: Page): Promise<void> {
  await page.addInitScript(() => {
    // @ts-expect-error runtime shim for esbuild keepNames helper
    window.__name = window.__name || ((fn) => fn);
  });
}

async function waitForInvoiceDetailReady(page: Page, timeoutMs: number): Promise<boolean> {
  return page
    .waitForFunction(() => {
      const norm = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();
      const modal =
        (document.querySelector(".ant-modal-body") as HTMLElement | null) ||
        (document.querySelector(".ant-modal") as HTMLElement | null);
      if (!modal) {
        return false;
      }

      const ths = Array.from(modal.querySelectorAll("th, td"));
      const hasItemHeader = ths.some((el) => {
        const t = norm(el.textContent || "");
        return t.includes("tên hàng") || t.includes("ten hang");
      });
      if (!hasItemHeader) {
        return false;
      }

      // At least one data row rendered in the invoice table.
      const rows = modal.querySelectorAll("table.res-tb tbody tr, table tbody tr");
      if (!rows.length) {
        return false;
      }

      // At least one non-empty row text indicates actual content is ready.
      return Array.from(rows).some((row) => ((row.textContent || "").replace(/\s+/g, " ").trim().length > 0));
    }, { timeout: timeoutMs })
    .then(() => true)
    .catch(() => false);
}

export async function extractInvoiceDetail(page: Page): Promise<InvoiceDetail> {
  // Give the invoice table a moment to finish rendering inside the modal.
  await page.waitForTimeout(300);

  // Scroll the header cell into view first so the item rows are rendered.
  await page
    .evaluate(() => {
      const norm = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();
      const modal =
        (document.querySelector(".ant-modal-body") as HTMLElement | null) ||
        (document.querySelector(".ant-modal") as HTMLElement | null) ||
        document.body;
      const cells = Array.from(modal.querySelectorAll("th, td")) as HTMLElement[];
      const header = cells.find((c) => {
        const t = norm(c.textContent || "");
        return t.includes("tên hàng") || t.includes("ten hang");
      });
      header?.scrollIntoView({ block: "center", inline: "nearest" });
    })
    .catch(() => undefined);

  await page.waitForTimeout(200);

  return page
    .evaluate(() => {
      const norm = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();
      const clean = (s: string): string => (s || "").replace(/\s+/g, " ").trim();
      const modal =
        (document.querySelector(".ant-modal-body") as HTMLElement | null) ||
        (document.querySelector(".ant-modal") as HTMLElement | null) ||
        document.body;

      const empty = { info: {} as Record<string, string>, lineItems: [] as Array<Record<string, string>>, itemNames: [] as string[] };

      const isItemHeader = (t: string): boolean => t.includes("tên hàng") || t.includes("ten hang");

      // ── Buyer/seller info (list rendered above the table) ──────────────────
      const info: Record<string, string> = {};
      const infoNodes = Array.from(modal.querySelectorAll("li, p, .list-fill-out li, .list-fill-out > *")) as HTMLElement[];
      for (const node of infoNodes) {
        const txt = clean(node.textContent || "");
        if (!txt || txt.length > 200) {
          continue;
        }
        const colon = txt.indexOf(":");
        if (colon > 0 && colon < txt.length - 1) {
          const label = clean(txt.slice(0, colon));
          const value = clean(txt.slice(colon + 1));
          if (label && value && !(label in info)) {
            info[label] = value;
          }
        }
      }

      // ── Locate the line-item table via its header cell ─────────────────────
      const headerCells = Array.from(modal.querySelectorAll("th, td")) as HTMLElement[];
      const headerCell = headerCells.find((c) => isItemHeader(norm(c.textContent || "")));
      if (!headerCell) {
        return { ...empty, info };
      }

      const headerRow = headerCell.closest("tr") as HTMLTableRowElement | null;
      const table = headerCell.closest("table") as HTMLTableElement | null;
      if (!headerRow || !table) {
        return { ...empty, info };
      }

      // Map each header column index → header label.
      const headerLabels = Array.from(headerRow.children).map((c) => clean((c as HTMLElement).textContent || ""));
      const itemNameIdx = Array.from(headerRow.children).indexOf(headerCell);

      // ── Read all body rows below the header ───────────────────────────────
      const allRows = Array.from(table.querySelectorAll("tr")) as HTMLTableRowElement[];
      const headerIndex = allRows.indexOf(headerRow);
      const lineItems: Array<Record<string, string>> = [];
      const itemNames: string[] = [];

      for (let i = headerIndex + 1; i < allRows.length; i++) {
        const row = allRows[i];
        if (!row) {
          continue;
        }
        const cells = Array.from(row.children) as HTMLElement[];
        // Skip repeated header rows.
        if (cells.some((c) => isItemHeader(norm(c.textContent || "")))) {
          continue;
        }
        // Build a column-keyed record for this row.
        const rec: Record<string, string> = {};
        let hasAny = false;
        cells.forEach((cell, idx) => {
          const label = headerLabels[idx] || `col${idx}`;
          const val = clean(cell.textContent || "");
          rec[label] = val;
          if (val) {
            hasAny = true;
          }
        });
        const name = clean((cells[itemNameIdx]?.textContent) || "");
        // Require a non-empty item name to treat the row as a real line item.
        if (hasAny && name) {
          lineItems.push(rec);
          itemNames.push(name);
        }
      }

      return { info, lineItems, itemNames };
    })
    .catch(() => ({ info: {}, lineItems: [], itemNames: [] }));
}

/** Close the currently-open detail modal (best effort). */
async function closeInvoiceModal(page: Page): Promise<void> {
  await clickFirstAvailable(page, [
    ".ant-modal-close",
    ".ant-modal button[aria-label='Close']",
    ".ant-modal-wrap .ant-modal-close-x",
  ]);
  await page.keyboard.press("Escape").catch(() => undefined);
  await page
    .waitForFunction(() => !document.querySelector(".ant-modal-wrap:not([style*='display: none'])"), { timeout: 5000 })
    .catch(() => undefined);
}

export type { InvoiceDetail };
export { buildDetailFromApiPayload, tryExtractDetailFromNetwork, waitForInvoiceDetailReady, closeInvoiceModal };

