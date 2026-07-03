import type { Page } from "playwright-core";
import { clickFirstAvailable } from "./ui-manual.js";

interface PaginationState {
  current: number;
  total: number;
  pageSize: number | null;
}

async function readPaginationState(page: Page): Promise<PaginationState | null> {
  return page
    .evaluate(() => {
      const isVisible = (el: Element): boolean => {
        const rect = (el as HTMLElement).getBoundingClientRect();
        const style = window.getComputedStyle(el as HTMLElement);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };

      const norm = (s: string): string => s.replace(/\s+/g, " ").trim();
      const candidates = Array.from(document.querySelectorAll("div, span"));
      for (const el of candidates) {
        if (!isVisible(el)) {
          continue;
        }
        const txt = norm(el.textContent || "");
        const m = txt.match(/^(\d+)\s*\/\s*(\d+)$/);
        if (!m) {
          continue;
        }
        const current = Number(m[1]);
        const total = Number(m[2]);
        if (!Number.isFinite(current) || !Number.isFinite(total) || current <= 0 || total <= 0) {
          continue;
        }

        const region = (el.closest(".ant-row, .ant-col") || el.parentElement || document.body) as HTMLElement;
        const pageSizeEl = region.querySelector(".ant-select-selection-selected-value");
        const pageSizeRaw = norm(pageSizeEl?.textContent || "");
        const pageSizeNum = Number(pageSizeRaw);

        return {
          current,
          total,
          pageSize: Number.isFinite(pageSizeNum) && pageSizeNum > 0 ? pageSizeNum : null,
        };
      }
      return null;
    })
    .catch(() => null);
}

async function clickNextPageByIndicator(page: Page): Promise<boolean> {
  return page
    .evaluate(() => {
      const isVisible = (el: Element): boolean => {
        const rect = (el as HTMLElement).getBoundingClientRect();
        const style = window.getComputedStyle(el as HTMLElement);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      const norm = (s: string): string => s.replace(/\s+/g, " ").trim();

      const indicators = Array.from(document.querySelectorAll("div, span")).filter((el) => {
        if (!isVisible(el)) {
          return false;
        }
        return /^(\d+)\s*\/\s*(\d+)$/.test(norm(el.textContent || ""));
      });

      for (const indicator of indicators) {
        const txt = norm(indicator.textContent || "");
        const m = txt.match(/^(\d+)\s*\/\s*(\d+)$/);
        if (!m) {
          continue;
        }
        const current = Number(m[1]);
        const total = Number(m[2]);
        if (!(Number.isFinite(current) && Number.isFinite(total)) || current >= total) {
          continue;
        }

        const region =
          (indicator.closest(".ant-row") as HTMLElement | null) ||
          (indicator.closest(".ant-col") as HTMLElement | null) ||
          (indicator.parentElement as HTMLElement | null) ||
          document.body;
        const buttons = Array.from(region.querySelectorAll("button"));
        for (const btn of buttons) {
          if (!isVisible(btn)) {
            continue;
          }
          const b = btn as HTMLButtonElement;
          if (b.disabled || b.getAttribute("aria-disabled") === "true") {
            continue;
          }
          if (btn.querySelector(".anticon-right")) {
            b.click();
            return true;
          }
        }
      }

      return false;
    })
    .catch(() => false);
}

/** Navigate to the next results page. Returns true if it moved. */
async function goToNextPage(page: Page): Promise<boolean> {
  const before = await readPaginationState(page);

  const moved = await clickFirstAvailable(page, [
    ".ant-pagination-next:not(.ant-pagination-disabled) button",
    ".ant-pagination-next:not(.ant-pagination-disabled)",
    "button[aria-label='Trang sau']",
    "button[aria-label='Next page']",
  ]);

  const movedByIndicator = moved ? false : await clickNextPageByIndicator(page);
  const attempted = moved || movedByIndicator;

  if (attempted) {
    await page.waitForTimeout(800);
    await page
      .waitForFunction(() => !document.querySelector(".ant-spin-spinning"), { timeout: 10000 })
      .catch(() => undefined);

    // If page indicator exists, wait for current page number to change.
    if (before) {
      await page
        .waitForFunction(
          (oldCurrent) => {
            const norm = (s: string): string => s.replace(/\s+/g, " ").trim();
            const candidates = Array.from(document.querySelectorAll("div, span"));
            for (const el of candidates) {
              const txt = norm(el.textContent || "");
              const m = txt.match(/^(\d+)\s*\/\s*(\d+)$/);
              if (!m) {
                continue;
              }
              const current = Number(m[1]);
              if (Number.isFinite(current) && current !== oldCurrent) {
                return true;
              }
            }
            return false;
          },
          before.current,
          { timeout: 10000 },
        )
        .catch(() => undefined);
    }
  }

  const after = await readPaginationState(page);
  if (before && after) {
    return after.current > before.current;
  }

  return attempted;
}

export { readPaginationState, clickNextPageByIndicator, goToNextPage };
export type { PaginationState };

