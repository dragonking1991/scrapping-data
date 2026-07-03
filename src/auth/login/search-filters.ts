import type { Page } from "playwright-core";
import { clickFirstAvailable } from "./ui-manual.js";
import { normalizeInvoiceDate } from "./shared.js";

async function fillInvoiceNumberFilter(page: Page, invoiceNumber: string): Promise<boolean> {
  const marked = await page
    .evaluate(() => {
      const normalize = (value: string): string =>
        value
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/[đĐ]/g, "d")
          .toLowerCase()
          .replace(/\s+/g, " ")
          .trim();

      const isActuallyVisible = (el: HTMLElement): boolean => {
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
          return false;
        }
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
          return false;
        }

        const cx = Math.min(window.innerWidth - 1, Math.max(0, rect.left + rect.width / 2));
        const cy = Math.min(window.innerHeight - 1, Math.max(0, rect.top + rect.height / 2));
        const top = document.elementFromPoint(cx, cy);
        return Boolean(top && (top === el || el.contains(top) || (top as HTMLElement).contains(el)));
      };

      const isTypable = (input: HTMLInputElement): boolean => {
        const type = (input.getAttribute("type") || "text").toLowerCase();
        if (["hidden", "checkbox", "radio", "button", "submit"].includes(type)) {
          return false;
        }
        return isActuallyVisible(input);
      };

      // The GDT form lays label and input in separate columns, so pick the input
      // that sits on the SAME visual row as the "Số hóa đơn" label and to its right.
      // Match the label exactly to avoid "Ký hiệu mẫu số hóa đơn".
      const target = normalize("so hoa don");
      const labelNodes = Array.from(document.querySelectorAll("label, span, div, td, p")) as HTMLElement[];
      let labelEl: HTMLElement | null = null;
      for (const el of labelNodes) {
        const text = normalize(el.textContent || "");
        if (!text) {
          continue;
        }
        if (!isActuallyVisible(el)) {
          continue;
        }
        // Leaf-most exact label only (ignore wrappers that merely contain the text).
        const exact = text === target || text === `${target} (*)` || text === `${target} *`;
        if (!exact) {
          continue;
        }
        if (el.querySelector("input, select, textarea")) {
          continue;
        }
        labelEl = el;
        break;
      }

      if (!labelEl) {
        return false;
      }

      const lr = labelEl.getBoundingClientRect();
      const labelCenterY = lr.top + lr.height / 2;

      let best: HTMLInputElement | null = null;
      let bestScore = Number.POSITIVE_INFINITY;
      for (const input of Array.from(document.querySelectorAll("input")) as HTMLInputElement[]) {
        if (!isTypable(input)) {
          continue;
        }
        const r = input.getBoundingClientRect();
        const inputCenterY = r.top + r.height / 2;
        const dy = Math.abs(inputCenterY - labelCenterY);
        // Must be roughly on the same row as the label.
        if (dy > r.height / 2 + 14) {
          continue;
        }
        // Must be to the right of the label (same column-pair).
        const dx = r.left - lr.right;
        if (dx < -8) {
          continue;
        }
        const score = dy * 4 + Math.abs(dx);
        if (score < bestScore) {
          bestScore = score;
          best = input;
        }
      }

      if (!best) {
        return false;
      }

      best.setAttribute("data-gdt-invoice-number", "1");
      return true;
    })
    .catch(() => false);

  if (!marked) {
    return false;
  }

  const field = page.locator("[data-gdt-invoice-number='1']").first();
  if (!(await field.count().catch(() => 0))) {
    return false;
  }

  await field.click().catch(() => undefined);
  await field.fill("").catch(() => undefined);
  await field.fill(invoiceNumber).catch(() => undefined);
  await page.waitForTimeout(120);
  // Clear the marker so the next candidate re-resolves the field fresh.
  await field.evaluate((node) => node.removeAttribute("data-gdt-invoice-number")).catch(() => undefined);
  return true;
}

async function fillInvoiceDateFilter(page: Page, invoiceDate: string): Promise<boolean> {
  if (!invoiceDate.trim()) {
    return false;
  }

  const marked = await page
    .evaluate(() => {
      const normalize = (value: string): string =>
        value
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/[đĐ]/g, "d")
          .toLowerCase()
          .replace(/\s+/g, " ")
          .trim();

      const isActuallyVisible = (el: HTMLElement): boolean => {
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
          return false;
        }
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
          return false;
        }

        const cx = Math.min(window.innerWidth - 1, Math.max(0, rect.left + rect.width / 2));
        const cy = Math.min(window.innerHeight - 1, Math.max(0, rect.top + rect.height / 2));
        const top = document.elementFromPoint(cx, cy);
        return Boolean(top && (top === el || el.contains(top) || (top as HTMLElement).contains(el)));
      };

      const isTypable = (input: HTMLInputElement): boolean => {
        const type = (input.getAttribute("type") || "text").toLowerCase();
        if (["hidden", "checkbox", "radio", "button", "submit"].includes(type)) {
          return false;
        }
        return isActuallyVisible(input);
      };

      // Find the input on the same visual row as a label, positioned to its right.
      const inputForLabel = (exactLabels: string[]): HTMLInputElement | null => {
        const labelNodes = Array.from(document.querySelectorAll("label, span, div, td, p")) as HTMLElement[];
        let labelEl: HTMLElement | null = null;
        for (const el of labelNodes) {
          const text = normalize(el.textContent || "");
          if (!text) {
            continue;
          }
          if (!isActuallyVisible(el)) {
            continue;
          }
          if (!exactLabels.includes(text)) {
            continue;
          }
          if (el.querySelector("input, select, textarea")) {
            continue;
          }
          labelEl = el;
          break;
        }

        if (!labelEl) {
          return null;
        }

        const lr = labelEl.getBoundingClientRect();
        const labelCenterY = lr.top + lr.height / 2;

        let best: HTMLInputElement | null = null;
        let bestScore = Number.POSITIVE_INFINITY;
        for (const input of Array.from(document.querySelectorAll("input")) as HTMLInputElement[]) {
          if (!isTypable(input)) {
            continue;
          }
          const r = input.getBoundingClientRect();
          const dy = Math.abs(r.top + r.height / 2 - labelCenterY);
          if (dy > r.height / 2 + 14) {
            continue;
          }
          const dx = r.left - lr.right;
          if (dx < -8) {
            continue;
          }
          const score = dy * 4 + Math.abs(dx);
          if (score < bestScore) {
            bestScore = score;
            best = input;
          }
        }
        return best;
      };

      const fromInput = inputForLabel(["tu ngay"]);

      let fromMarked = false;
      if (fromInput) {
        fromInput.setAttribute("data-gdt-from-date", "1");
        fromMarked = true;
      }

      return { fromMarked };
    })
    .catch(() => ({ fromMarked: false }));

  if (!marked.fromMarked) {
    return false;
  }

  const typeDate = async (selector: string): Promise<void> => {
    const field = page.locator(selector).first();
    if (!(await field.count().catch(() => 0))) {
      return;
    }
    await field.click().catch(() => undefined);
    await field.fill("").catch(() => undefined);
    await field.pressSequentially(invoiceDate, { delay: 20 }).catch(() => undefined);
    await field.press("Enter").catch(() => undefined);
    await page.waitForTimeout(150);
    await field.evaluate((node) => node.removeAttribute("data-gdt-from-date")).catch(() => undefined);
  };

  // Only fill "Tu ngay" with the invoice date; leave "Den ngay" untouched.
  await typeDate("[data-gdt-from-date='1']");

  // Close the antd DatePicker dropdown so it does not cover the search button,
  // then wait until it is actually gone before continuing the flow.
  await page.keyboard.press("Escape").catch(() => undefined);
  await page.mouse.click(5, 5).catch(() => undefined);
  await page
    .waitForFunction(
      () => !document.querySelector(".ant-picker-dropdown:not(.ant-picker-dropdown-hidden)"),
      { timeout: 3000 },
    )
    .catch(() => undefined);
  await page.waitForTimeout(120);
  return true;
}

async function clickSearchByInvoice(page: Page): Promise<boolean> {
  // Make sure no antd DatePicker dropdown is still covering the search button.
  await page.keyboard.press("Escape").catch(() => undefined);
  await page
    .waitForFunction(
      () => !document.querySelector(".ant-picker-dropdown:not(.ant-picker-dropdown-hidden)"),
      { timeout: 2000 },
    )
    .catch(() => undefined);

  const clicked = await clickFirstAvailable(page, [
    "button:has-text('Tìm kiếm')",
    "button:has-text('Tim kiem')",
    ".ant-btn-primary:has-text('Tìm kiếm')",
    ".ant-btn-primary:has-text('Tim kiem')",
  ]);

  if (!clicked) {
    return false;
  }

  await page.waitForTimeout(550);
  await page
    .waitForFunction(() => !document.querySelector(".ant-spin-spinning"), { timeout: 12000 })
    .catch(() => undefined);
  return true;
}

async function findRowIndexByInvoiceNumber(page: Page, invoiceNumber: string, invoiceDate?: string): Promise<number> {
  const expectedDate = normalizeInvoiceDate(invoiceDate ?? "");
  return page
    .evaluate(({ rawValue, rawDate }: { rawValue: string; rawDate: string }) => {
      const expectedCompact = rawValue.trim().replace(/\s+/g, "");
      const expectedAlnum = expectedCompact.replace(/[^0-9a-zA-Z]/g, "").toUpperCase();
      const expectedDigits = expectedCompact.replace(/\D+/g, "").replace(/^0+/, "") || "0";

      const toDateKey = (value: string): string => {
        const parts = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
        if (!parts) {
          return "";
        }
        const day = Number(parts[1]);
        const month = Number(parts[2]);
        const year = Number(parts[3]);
        if (!Number.isFinite(day) || !Number.isFinite(month) || !Number.isFinite(year)) {
          return "";
        }
        if (day < 1 || day > 31 || month < 1 || month > 12) {
          return "";
        }
        return `${String(day).padStart(2, "0")}/${String(month).padStart(2, "0")}/${year}`;
      };

      const expectedDateKey = toDateKey(rawDate || "");
      const collectDateKeys = (text: string): Set<string> => {
        const keys = new Set<string>();
        const normalized = text.replace(/\s+/g, " ").trim();
        const matches = normalized.match(/\b(\d{1,4})[\/\-](\d{1,2})[\/\-](\d{1,4})\b/g) || [];
        for (const token of matches) {
          const parts = token.split(/[\/\-]/).map((p) => Number(p));
          const a = parts[0] ?? Number.NaN;
          const b = parts[1] ?? Number.NaN;
          const c = parts[2] ?? Number.NaN;
          if (parts.length !== 3 || !Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c)) {
            continue;
          }

          let day = 0;
          let month = 0;
          let year = 0;

          if (a > 999) {
            year = a;
            month = b;
            day = c;
          } else if (c > 999) {
            year = c;
            // Default DD/MM for ambiguous forms to align with GDT input style.
            if (a <= 12 && b > 12) {
              month = a;
              day = b;
            } else {
              day = a;
              month = b;
            }
          } else {
            continue;
          }

          if (year < 1900 || year > 2200 || day < 1 || day > 31 || month < 1 || month > 12) {
            continue;
          }

          keys.add(`${String(day).padStart(2, "0")}/${String(month).padStart(2, "0")}/${year}`);
        }

        return keys;
      };

      const rows = Array.from(document.querySelectorAll(".ant-table-tbody tr"));
      for (let i = 0; i < rows.length; i += 1) {
        const row = rows[i];
        if (!row) {
          continue;
        }
        const cells = Array.from(row.querySelectorAll("td"));
        const invoiceHit = cells.some((cell) => {
          const text = (cell.textContent || "").trim();
          if (!text) {
            return false;
          }
          const compact = text.replace(/\s+/g, "");
          if (compact === expectedCompact) {
            return true;
          }

          const alnum = compact.replace(/[^0-9a-zA-Z]/g, "").toUpperCase();
          if (alnum && alnum === expectedAlnum) {
            return true;
          }

          const digits = compact.replace(/\D+/g, "").replace(/^0+/, "") || "0";
          return digits === expectedDigits;
        });
        if (!invoiceHit) {
          continue;
        }

        if (!expectedDateKey) {
          return i;
        }

        const dateHit = cells.some((cell) => {
          const text = (cell.textContent || "").replace(/\s+/g, " ").trim();
          if (!text) {
            return false;
          }
          if (text.includes(expectedDateKey)) {
            return true;
          }

          const dateKeys = collectDateKeys(text);
          return dateKeys.has(expectedDateKey);
        });

        if (dateHit) {
          return i;
        }
      }
      return -1;
    }, { rawValue: invoiceNumber, rawDate: expectedDate })
    .catch(() => -1);
}

export { fillInvoiceNumberFilter, fillInvoiceDateFilter, clickSearchByInvoice, findRowIndexByInvoiceNumber };

