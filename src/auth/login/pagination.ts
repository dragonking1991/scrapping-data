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
      const readPagerSnapshotFromDom = (): { current: number; total: number; pagerIndex: number } | null => {
        const pagers = Array.from(document.querySelectorAll(".ant-pagination, .pagination, [class*='pagination']"));
        for (let i = 0; i < pagers.length; i += 1) {
          const pager = pagers[i] as HTMLElement;
          if (!isVisible(pager)) {
            continue;
          }

          let current: number | null = null;
          let total: number | null = null;

          const simplePager = pager.querySelector(".ant-pagination-simple-pager");
          if (simplePager && isVisible(simplePager)) {
            const input = simplePager.querySelector("input") as HTMLInputElement | null;
            const currentNum = Number(norm(input?.value || ""));
            const totalMatch = norm(simplePager.textContent || "").match(/\/\s*(\d+)/);
            const totalNum = Number(totalMatch?.[1] ?? "");
            if (Number.isFinite(currentNum) && Number.isFinite(totalNum) && currentNum > 0 && totalNum > 0) {
              current = currentNum;
              total = totalNum;
            }
          }

          if (current == null || total == null) {
            const indicators = Array.from(pager.querySelectorAll("div, span"));
            for (const indicator of indicators) {
              if (!isVisible(indicator)) {
                continue;
              }
              const txt = norm(indicator.textContent || "");
              const m = txt.match(/^(\d+)\s*\/\s*(\d+)$/);
              if (!m) {
                continue;
              }
              const currentNum = Number(m[1]);
              const totalNum = Number(m[2]);
              if (!Number.isFinite(currentNum) || !Number.isFinite(totalNum) || currentNum <= 0 || totalNum <= 0) {
                continue;
              }
              current = currentNum;
              total = totalNum;
              break;
            }
          }

          if (current != null && total != null) {
            return { current, total, pagerIndex: i };
          }
        }

        return null;
      };

      const snapshot = readPagerSnapshotFromDom();
      if (!snapshot) {
        return null;
      }

      const pagers = Array.from(document.querySelectorAll(".ant-pagination, .pagination, [class*='pagination']"));
      const pager = pagers[snapshot.pagerIndex] as HTMLElement | undefined;
      const pageSizeEl =
        pager?.querySelector(".ant-select-selection-selected-value") ||
        pager?.querySelector(".ant-select-selector") ||
        (pager?.parentElement?.querySelector(".ant-select-selection-selected-value") ?? null) ||
        (pager?.parentElement?.querySelector(".ant-select-selector") ?? null);
      const pageSizeRaw = norm(pageSizeEl?.textContent || "");
      const pageSizeNum = Number(pageSizeRaw);

      return {
        current: snapshot.current,
        total: snapshot.total,
        pageSize: Number.isFinite(pageSizeNum) && pageSizeNum > 0 ? pageSizeNum : null,
      };
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
      const readPagerSnapshotFromDom = (): { current: number; total: number; pagerIndex: number } | null => {
        const pagers = Array.from(document.querySelectorAll(".ant-pagination, .pagination, [class*='pagination']"));
        for (let i = 0; i < pagers.length; i += 1) {
          const pager = pagers[i] as HTMLElement;
          if (!isVisible(pager)) {
            continue;
          }

          let current: number | null = null;
          let total: number | null = null;
          const simplePager = pager.querySelector(".ant-pagination-simple-pager");
          if (simplePager && isVisible(simplePager)) {
            const input = simplePager.querySelector("input") as HTMLInputElement | null;
            const currentNum = Number(norm(input?.value || ""));
            const totalMatch = norm(simplePager.textContent || "").match(/\/\s*(\d+)/);
            const totalNum = Number(totalMatch?.[1] ?? "");
            if (Number.isFinite(currentNum) && Number.isFinite(totalNum) && currentNum > 0 && totalNum > 0) {
              current = currentNum;
              total = totalNum;
            }
          }

          if (current == null || total == null) {
            const indicators = Array.from(pager.querySelectorAll("div, span"));
            for (const indicator of indicators) {
              if (!isVisible(indicator)) {
                continue;
              }
              const txt = norm(indicator.textContent || "");
              const m = txt.match(/^(\d+)\s*\/\s*(\d+)$/);
              if (!m) {
                continue;
              }
              const currentNum = Number(m[1]);
              const totalNum = Number(m[2]);
              if (Number.isFinite(currentNum) && Number.isFinite(totalNum) && currentNum > 0 && totalNum > 0) {
                current = currentNum;
                total = totalNum;
                break;
              }
            }
          }

          if (current != null && total != null) {
            return { current, total, pagerIndex: i };
          }
        }

        return null;
      };

      const snapshot = readPagerSnapshotFromDom();
      if (!snapshot || snapshot.current >= snapshot.total) {
        return false;
      }

      const pagers = Array.from(document.querySelectorAll(".ant-pagination, .pagination, [class*='pagination']"));
      const pager = pagers[snapshot.pagerIndex] as HTMLElement | undefined;
      if (!pager) {
        return false;
      }

      const buttons = Array.from(pager.querySelectorAll("button"));
      for (const btn of buttons) {
        if (!isVisible(btn)) {
          continue;
        }
        const b = btn as HTMLButtonElement;
        if (b.disabled || b.getAttribute("aria-disabled") === "true") {
          continue;
        }

        const aria = (b.getAttribute("aria-label") || "").toLowerCase();
        const title = (b.getAttribute("title") || "").toLowerCase();
        if (
          btn.querySelector(".anticon-right") ||
          /next|trang sau/.test(aria) ||
          /next|trang sau/.test(title)
        ) {
          b.click();
          return true;
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

    if (before) {
      const timeoutAt = Date.now() + 10000;
      while (Date.now() < timeoutAt) {
        const mid = await readPaginationState(page);
        if (mid && mid.current !== before.current) {
          break;
        }
        await page.waitForTimeout(250);
      }
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

