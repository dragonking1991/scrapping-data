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
    if (await existing.isVisible().catch(() => false)) {
      return true;
    }
    await clearViewInvoiceMark(page);
  }

  // Direct selector for the icon-only action button shown in the toolbar.
  const directBtn = page
    .locator("button.ant-btn.ant-btn-icon-only[class*='ButtonAnt__IconButton']")
    .first();
  if ((await directBtn.count()) && (await directBtn.isVisible().catch(() => false))) {
    const html = await directBtn.evaluate((node) => (node as HTMLElement).outerHTML).catch(() => "");
    await directBtn.evaluate((node) => (node as HTMLElement).setAttribute("data-gdt-view", "1")).catch(() => undefined);
    logger.info("[VIEW] Found 'Xem hoa don' via direct icon button selector");
    emitEvent("found-view-icon", "direct icon button selector", html);
    return true;
  }

  // Fallback kept short: look for a direct eye icon only, no long scan loop.
  const eye = page.locator("button.ant-btn.ant-btn-icon-only .anticon-eye, button.ant-btn.ant-btn-icon-only [data-icon='eye']").first();
  if ((await eye.count()) && (await eye.isVisible().catch(() => false))) {
    await eye.evaluate((node) => {
      const btn = (node as HTMLElement).closest("button");
      if (btn) {
        btn.setAttribute("data-gdt-view", "1");
      }
    }).catch(() => undefined);
    logger.info("[VIEW] Found 'Xem hoa don' via eye icon fallback selector");
    emitEvent("found-view-icon", "eye icon fallback selector");
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