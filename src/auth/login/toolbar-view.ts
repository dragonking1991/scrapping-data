import type { Page } from "playwright-core";
import { logger } from "../../shared/logger.js";
import { emitEvent, normalizeText, readVisibleTooltip } from "./rescan-common.js";

let cachedInvoiceButtonIndex: number | null = null;

// Tooltip text (accent-insensitive) that identifies the invoice view/export action.
const VIEW_TOOLTIP_RE = /(xem\s*hoa\s*don|xuat\s*hoa\s*don|xuat\s*xml|export)/;

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

  // Fast path from cache: reuse last successful candidate index if DOM is similar.
  if (cachedInvoiceButtonIndex != null && cachedInvoiceButtonIndex >= 0 && cachedInvoiceButtonIndex < limit) {
    const cached = candidates.nth(cachedInvoiceButtonIndex);
    if (await cached.isVisible().catch(() => false)) {
      await cached.hover().catch(() => undefined);
      await page.waitForTimeout(100);
      const tip = await readVisibleTooltip(page);
      if (tip && VIEW_TOOLTIP_RE.test(normalizeText(tip))) {
        const html = await cached.evaluate((node) => (node as HTMLElement).outerHTML).catch(() => "");
        await cached.evaluate((node) => (node as HTMLElement).setAttribute("data-gdt-view", "1")).catch(() => undefined);
        logger.info(`[VIEW] Reused cached toolbar button idx=${cachedInvoiceButtonIndex} tooltip="${tip.slice(0, 30)}"`);
        emitEvent("found-view-icon", `cached idx=${cachedInvoiceButtonIndex} tooltip="${tip.slice(0, 40)}"`, html);
        return true;
      }
    }
  }

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
    // Accept both "Xem hóa đơn" and export actions used by some GDT screens.
    if (tip && VIEW_TOOLTIP_RE.test(normalizeText(tip))) {
      const html = await el.evaluate((node) => (node as HTMLElement).outerHTML).catch(() => "");
      await el.evaluate((node) => (node as HTMLElement).setAttribute("data-gdt-view", "1")).catch(() => undefined);
      cachedInvoiceButtonIndex = i;
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

export { findAndMarkViewInvoiceButton, clearViewInvoiceMark };