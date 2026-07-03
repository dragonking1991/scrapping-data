import type { Page } from "playwright-core";
import { logger } from "../../shared/logger.js";
import { emitEvent, readVisibleTooltip } from "./rescan-common.js";

async function findAndMarkViewInvoiceButton(page: Page): Promise<boolean> {
  // Already marked from a previous row/page?
  if (await page.locator('[data-gdt-view="1"]').count()) {
    return true;
  }

  // Fast path: a visible eye icon is almost always "Xem hóa đơn".
  const eye = page.locator(".anticon-eye, [class*='eye'], span.anticon:has(svg[data-icon='eye'])").first();
  if ((await eye.count()) && (await eye.isVisible().catch(() => false))) {
    const html = await eye.evaluate((node) => (node as HTMLElement).outerHTML).catch(() => "");
    await eye.evaluate((node) => (node as HTMLElement).setAttribute("data-gdt-view", "1")).catch(() => undefined);
    logger.info("[VIEW] Found 'Xem hoa don' via eye icon selector");
    emitEvent("found-view-icon", "eye icon selector", html);
    return true;
  }

  const candidates = page.locator("button, a[role='button'], [role='button'], img, span.anticon");
  const total = await candidates.count();
  const limit = Math.min(total, 100);

  for (let i = 0; i < limit; i += 1) {
    const el = candidates.nth(i);
    if (!(await el.isVisible().catch(() => false))) {
      continue;
    }

    await el.hover().catch(() => undefined);
    await page.waitForTimeout(120);
    const tip = await readVisibleTooltip(page);
    if (tip) {
      emitEvent("hover", `icon #${i} → tooltip: "${tip.slice(0, 40)}"`);
    }
    // Tooltip "Xem hóa đơn" — match "xem" (avoid "Xóa"/"Xuất").
    if (tip && /xem/i.test(tip)) {
      const html = await el.evaluate((node) => (node as HTMLElement).outerHTML).catch(() => "");
      await el.evaluate((node) => (node as HTMLElement).setAttribute("data-gdt-view", "1")).catch(() => undefined);
      logger.info(`[VIEW] Found 'Xem hoa don' icon via tooltip: "${tip.slice(0, 30)}"`);
      emitEvent("found-view-icon", `tooltip="${tip.slice(0, 40)}"`, html);
      return true;
    }
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

export { findAndMarkViewInvoiceButton };
