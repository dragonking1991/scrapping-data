import { promises as fs } from "node:fs";
import type { Page } from "playwright-core";
import { logger } from "../../shared/logger.js";
import {
  isContinueRunMode,
  normalizeInvoiceDate,
  type ContinueAction,
  type RescanCandidate,
  type RescanDataset,
  type RescanStatusPayload,
} from "./shared.js";

function emitEvent(action: string, detail: string, html?: string): void {
  const payload = {
    ts: Date.now(),
    action,
    detail: detail.slice(0, 200),
    html: html ? html.slice(0, 1500) : undefined,
  };
  logger.info(`[GDT-EVENT] ${JSON.stringify(payload)}`);
}

function emitRescanStatus(payload: RescanStatusPayload): void {
  logger.info(`[RESCAN-STATUS] ${JSON.stringify(payload)}`);
}

function normalizeText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeKeyPart(value: string): string {
  return value.trim().toUpperCase();
}

function normalizeInvoiceNumber(value: string): string {
  return value.trim().replace(/\s+/g, "");
}

function buildCandidateKey(khhdon: string, khmshdon: string, shdon: string): string {
  return `${normalizeKeyPart(khhdon)}|${normalizeKeyPart(khmshdon)}|${normalizeInvoiceNumber(shdon)}`;
}

function isEmptyLineItems(raw: unknown): boolean {
  if (!Array.isArray(raw)) {
    return true;
  }
  return raw.length === 0;
}

function buildRescanCandidates(records: Array<Record<string, unknown>>, dataset: RescanDataset): {
  candidates: RescanCandidate[];
  skippedDuplicates: number;
} {
  const seen = new Set<string>();
  const candidates: RescanCandidate[] = [];
  let skippedDuplicates = 0;

  for (let index = 0; index < records.length; index += 1) {
    const row = records[index] ?? {};
    if (!isEmptyLineItems(row.lineItems)) {
      continue;
    }

    const shdon = String(row.shdon ?? "").trim();
    if (!shdon) {
      continue;
    }
    const ngay = normalizeInvoiceDate(row.ngay);

    const khhdon = String(row.khhdon ?? "").trim();
    const khmshdon = String(row.khmshdon ?? "").trim();
    const key = buildCandidateKey(khhdon, khmshdon, shdon);
    if (seen.has(key)) {
      skippedDuplicates += 1;
      continue;
    }

    seen.add(key);
    candidates.push({
      dataset,
      index,
      shdon,
      ngay,
      khhdon,
      khmshdon,
      key,
    });
  }

  return { candidates, skippedDuplicates };
}

async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  const tmpPath = `${filePath}.tmp-${Date.now()}`;
  await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(tmpPath, filePath);
}

async function readContinueAction(filePath: string): Promise<ContinueAction> {
  const content = (await fs.readFile(filePath, "utf8").catch(() => "continue")).trim().toLowerCase();
  if (content.startsWith("continue:")) {
    const runMode = content.slice("continue:".length);
    if (isContinueRunMode(runMode)) {
      return `continue:${runMode}` as ContinueAction;
    }
    return "continue:sold";
  }
  if (content === "rescan-empty-line-items") {
    return "rescan-empty-line-items";
  }
  if (content === "stop-current-flow") {
    return "stop-current-flow";
  }
  if (content === "debug-read-pagination") {
    return "debug-read-pagination";
  }
  if (content === "debug-next-page") {
    return "debug-next-page";
  }
  if (content === "debug-open-invoice") {
    return "debug-open-invoice";
  }
  const rowMatch = content.match(/^debug-select-row:(\d+)$/);
  if (rowMatch) {
    return `debug-select-row:${Number(rowMatch[1])}` as ContinueAction;
  }
  return "continue";
}

/** Capture the outerHTML of the first element matching a selector (best effort). */
async function captureHtml(page: Page, selector: string): Promise<string> {
  return page
    .evaluate((sel) => {
      const el = document.querySelector(sel);
      return el ? (el as HTMLElement).outerHTML : "";
    }, selector)
    .catch(() => "");
}

/**
 * Dump candidate toolbar buttons/icons to the log so we can identify the real
 * "Xuất xml" control when the default selectors do not match.
 */
async function dumpToolbarButtons(page: Page): Promise<void> {
  try {
    const info = await page.evaluate(() => {
      const nodes = Array.from(
        document.querySelectorAll("button, a, [role='button'], .anticon, img, svg"),
      );
      return nodes
        .map((el, i) => ({
          i,
          tag: el.tagName.toLowerCase(),
          text: (el.textContent || "").trim().slice(0, 25),
          title: el.getAttribute("title") || "",
          aria: el.getAttribute("aria-label") || "",
          src: (el.getAttribute("src") || "").slice(-30),
          cls: String((el as HTMLElement).className?.toString?.() || "").slice(0, 70),
          disabled: (el as HTMLButtonElement).disabled === true,
        }))
        .filter(
          (x) =>
            x.title ||
            x.aria ||
            /xml|excel|export|xuat|in\b|print/i.test(x.text) ||
            /xml|excel|export|print/i.test(x.cls) ||
            /xml|excel|export/i.test(x.src),
        )
        .slice(0, 40);
    });
    logger.info(`[XML-EXPORT][DEBUG] Toolbar candidates: ${JSON.stringify(info).slice(0, 1800)}`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn(`[XML-EXPORT][DEBUG] Could not dump toolbar: ${msg.slice(0, 120)}`);
  }
}

/** Read the text of the currently-visible antd tooltip, if any. */
async function readVisibleTooltip(page: Page): Promise<string> {
  return page
    .evaluate(() => {
      const tips = Array.from(document.querySelectorAll(".ant-tooltip, [role='tooltip']"));
      for (const t of tips) {
        const el = t as HTMLElement;
        const style = getComputedStyle(el);
        const hidden =
          style.display === "none" ||
          style.visibility === "hidden" ||
          el.classList.contains("ant-tooltip-hidden") ||
          el.offsetParent === null;
        if (!hidden) {
          return (el.textContent || "").trim();
        }
      }
      return "";
    })
    .catch(() => "");
}

/**
 * Locate the "Xem hóa đơn" toolbar icon by hovering over each visible icon and
 * reading the antd tooltip (which only appears on hover). Also try direct eye-icon
 * selectors first. Once found, mark it with a stable data attribute for fast reuse.
 * The toolbar persists across pages, so marking once is enough.
 * Returns true if the button is marked/available.
 */

export {
  emitEvent,
  emitRescanStatus,
  normalizeText,
  buildRescanCandidates,
  writeJsonAtomic,
  readContinueAction,
  captureHtml,
  dumpToolbarButtons,
  readVisibleTooltip,
};
