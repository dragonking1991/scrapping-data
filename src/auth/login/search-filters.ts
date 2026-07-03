import type { Page } from "playwright-core";
import { clickFirstAvailable } from "./ui-manual.js";

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

      const isTypable = (input: HTMLInputElement): boolean => {
        const type = (input.getAttribute("type") || "text").toLowerCase();
        if (["hidden", "checkbox", "radio", "button", "submit"].includes(type)) {
          return false;
        }
        const rect = input.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
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

      const isTypable = (input: HTMLInputElement): boolean => {
        const type = (input.getAttribute("type") || "text").toLowerCase();
        if (["hidden", "checkbox", "radio", "button", "submit"].includes(type)) {
          return false;
        }
        const rect = input.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
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
      const toInput = inputForLabel(["den ngay"]);

      let fromMarked = false;
      let toMarked = false;
      if (fromInput) {
        fromInput.setAttribute("data-gdt-from-date", "1");
        fromMarked = true;
      }
      if (toInput && toInput !== fromInput) {
        toInput.setAttribute("data-gdt-to-date", "1");
        toMarked = true;
      }

      return { fromMarked, toMarked };
    })
    .catch(() => ({ fromMarked: false, toMarked: false }));

  if (!marked.fromMarked && !marked.toMarked) {
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
    await field.evaluate((node) => node.removeAttribute("data-gdt-to-date")).catch(() => undefined);
  };

  // Fill both ends of the range with the invoice date so the search targets that exact day.
  if (marked.fromMarked) {
    await typeDate("[data-gdt-from-date='1']");
  }
  if (marked.toMarked) {
    await typeDate("[data-gdt-to-date='1']");
  }

  // Close any lingering datepicker popup so it does not block the search button.
  await page.keyboard.press("Escape").catch(() => undefined);
  await page.waitForTimeout(120);
  return true;
}

async function clickSearchByInvoice(page: Page): Promise<boolean> {
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
  return page
    .evaluate(({ rawValue, rawDate }: { rawValue: string; rawDate: string }) => {
      const expected = rawValue.trim().replace(/\s+/g, "");
      const expectedDate = (rawDate || "").trim();
      const rows = Array.from(document.querySelectorAll(".ant-table-tbody tr"));
      for (let i = 0; i < rows.length; i += 1) {
        const row = rows[i];
        if (!row) {
          continue;
        }
        const cells = Array.from(row.querySelectorAll("td"));
        const invoiceHit = cells.some((cell) => (cell.textContent || "").trim().replace(/\s+/g, "") === expected);
        if (!invoiceHit) {
          continue;
        }

        if (!expectedDate) {
          return i;
        }

        const dateHit = cells.some((cell) => {
          const text = (cell.textContent || "").replace(/\s+/g, " ").trim();
          return text.includes(expectedDate);
        });

        if (dateHit) {
          return i;
        }
      }
      return -1;
    }, { rawValue: invoiceNumber, rawDate: invoiceDate ?? "" })
    .catch(() => -1);
}

  export { fillInvoiceNumberFilter, fillInvoiceDateFilter, clickSearchByInvoice, findRowIndexByInvoiceNumber };

