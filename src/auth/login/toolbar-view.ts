import type { Page } from "playwright-core";
import { logger } from "../../shared/logger.js";
import { emitEvent } from "./rescan-common.js";

/**
 * Remove any stale `data-gdt-view` marks. Needed when the results table/toolbar
 * is re-rendered (e.g. the rescan flow runs a fresh search per invoice), because
 * a mark left on a now-detached node would make the next click hit nothing.
 */
async function clearViewInvoiceMark(page: Page): Promise<void> {
  await page
    .evaluate(() => {
      document.querySelectorAll('[data-gdt-view="1"]').forEach((el) => el.removeAttribute("data-gdt-view"));
    })
    .catch(() => undefined);
}

async function findAndMarkViewInvoiceButton(page: Page): Promise<boolean> {
  // Already marked from a previous row/page? Only trust it if the marked node is
  // still attached and visible; otherwise clear it and re-detect below.
  const existing = page.locator('[data-gdt-view="1"]').first();
  if (await existing.count()) {
    const existingReady = await existing
      .evaluate((node) => {
        const el = node as HTMLElement;
        const style = window.getComputedStyle(el);
        return !el.hasAttribute("disabled") && style.pointerEvents !== "none";
      })
      .catch(() => false);
    if (existingReady && (await existing.isVisible().catch(() => false))) {
      return true;
    }
    await clearViewInvoiceMark(page);
  }

  // Prefer icon in the selected row first; skip disabled icon buttons.
  const selectedRowBtn = page
    .locator("tr.ant-selected-row button.ant-btn.ant-btn-icon-only:not([disabled]):has([id*='xemchitiet'])")
    .first();
  if ((await selectedRowBtn.count()) && (await selectedRowBtn.isVisible().catch(() => false))) {
    const html = await selectedRowBtn.evaluate((node) => (node as HTMLElement).outerHTML).catch(() => "");
    await selectedRowBtn
      .evaluate((node) => (node as HTMLElement).setAttribute("data-gdt-view", "1"))
      .catch(() => undefined);
    logger.info("[VIEW] Found 'Xem hoa don' in selected row");
    emitEvent("found-view-icon", "selected-row xemchitiet", html);
    return true;
  }

  // Strong selector from real GDT DOM: view-detail icon uses id/class token "xemchitiet".
  const directBtn = page
    .locator("button.ant-btn.ant-btn-icon-only:not([disabled]):has([id*='xemchitiet'])")
    .first();
  if ((await directBtn.count()) && (await directBtn.isVisible().catch(() => false))) {
    const html = await directBtn.evaluate((node) => (node as HTMLElement).outerHTML).catch(() => "");
    await directBtn.evaluate((node) => (node as HTMLElement).setAttribute("data-gdt-view", "1")).catch(() => undefined);
    logger.info("[VIEW] Found 'Xem hoa don' via xemchitiet icon selector");
    emitEvent("found-view-icon", "xemchitiet icon selector", html);
    return true;
  }

  // Fallback kept short: scan icon-only buttons and prefer those containing "xemchitiet" token.
  const markedByToken = await page
    .evaluate(() => {
      const isVisible = (el: Element): boolean => {
        const rect = (el as HTMLElement).getBoundingClientRect();
        const style = window.getComputedStyle(el as HTMLElement);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };

      const buttons = Array.from(document.querySelectorAll("button.ant-btn.ant-btn-icon-only"));
      for (const btn of buttons) {
        if (!isVisible(btn)) {
          continue;
        }
        const html = ((btn as HTMLElement).outerHTML || "").toLowerCase();
        const style = window.getComputedStyle(btn as HTMLElement);
        if (
          (btn as HTMLButtonElement).disabled ||
          btn.getAttribute("aria-disabled") === "true" ||
          style.pointerEvents === "none"
        ) {
          continue;
        }
        if (html.includes("xemchitiet") || html.includes("chi tiet")) {
          (btn as HTMLElement).setAttribute("data-gdt-view", "1");
          return true;
        }
      }
      return false;
    })
    .catch(() => false);
  if (markedByToken) {
    logger.info("[VIEW] Found 'Xem hoa don' via token fallback selector");
    emitEvent("found-view-icon", "token fallback selector");
    return true;
  }

  return false;
}

/** Extract the "Tên hàng hóa, dịch vụ" column values from the detail modal. */
/**
 * Extract the full invoice detail from the open modal, keyed by columns.
 *
 * The detail modal renders a real invoice HTML table (`table.res-tb`) whose
 * header row contains "Tên hàng hóa, dịch vụ". We map every header cell to its
 * column, then read all body rows into structured line items. We also capture
 * the buyer/seller info list rendered above the table.
 */

export { findAndMarkViewInvoiceButton, clearViewInvoiceMark };