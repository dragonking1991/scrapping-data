import type { Page } from "playwright-core";
import { clickFirstAvailable } from "./ui-manual.js";

interface PaginationState {
  current: number;
  total: number;
  pageSize: number | null;
  isFallback?: boolean;
}

const DEFAULT_PAGINATION_CURRENT = 1;
const DEFAULT_PAGINATION_TOTAL = 200;

function buildFallbackPagination(pageSize: number | null = null): PaginationState {
  return {
    current: DEFAULT_PAGINATION_CURRENT,
    total: DEFAULT_PAGINATION_TOTAL,
    pageSize,
    isFallback: true,
  };
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
      const readVisiblePageIndex = (): { current: number; total: number } | null => {
        const preferred = Array.from(
          document.querySelectorAll("[class*='PageIndex'], [class*='pageIndex'], [class*='page-index']"),
        );
        const generic = Array.from(document.querySelectorAll("div, span"));
        const candidates = preferred.length ? preferred.concat(generic) : generic;

        for (const node of candidates) {
          if (!isVisible(node)) {
            continue;
          }
          const txt = norm(node.textContent || "");
          if (!txt || txt.length > 20) {
            continue;
          }
          const m = txt.match(/^(\d+)\s*\/\s*(\d+)$/);
          if (!m) {
            continue;
          }
          const currentNum = Number(m[1]);
          const totalNum = Number(m[2]);
          if (!Number.isFinite(currentNum) || !Number.isFinite(totalNum) || currentNum <= 0 || totalNum <= 0) {
            continue;
          }
          return { current: currentNum, total: totalNum };
        }

        return null;
      };

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

        const pageIndex = readVisiblePageIndex();
        if (pageIndex) {
          return { ...pageIndex, pagerIndex: -1 };
        }

        return null;
      };

      const snapshot = readPagerSnapshotFromDom();
      if (!snapshot) {
        const pageSizeFallbackEl = document.querySelector(
          ".ant-select-selection-item, .ant-select-selection-selected-value, .ant-select-selector, select",
        );
        const pageSizeFallbackRaw = norm(
          (pageSizeFallbackEl as HTMLElement | HTMLSelectElement | null)?.textContent ||
            (pageSizeFallbackEl as HTMLSelectElement | null)?.value ||
            "",
        );
        const pageSizeFallbackNum = Number(pageSizeFallbackRaw);
        return buildFallbackPagination(
          Number.isFinite(pageSizeFallbackNum) && pageSizeFallbackNum > 0 ? pageSizeFallbackNum : null,
        );
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
        isFallback: false,
      };
    })
    .catch(() => buildFallbackPagination(null));
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
      const parsePageIndexText = (text: string): { current: number; total: number } | null => {
        const m = norm(text).match(/^(\d+)\s*\/\s*(\d+)$/);
        if (!m) {
          return null;
        }
        const currentNum = Number(m[1]);
        const totalNum = Number(m[2]);
        if (!Number.isFinite(currentNum) || !Number.isFinite(totalNum) || currentNum <= 0 || totalNum <= 0) {
          return null;
        }
        return { current: currentNum, total: totalNum };
      };
      const findVisiblePageIndexElement = (): HTMLElement | null => {
        const preferred = Array.from(
          document.querySelectorAll("[class*='PageIndex'], [class*='pageIndex'], [class*='page-index']"),
        );
        const generic = Array.from(document.querySelectorAll("div, span"));
        const candidates = preferred.length ? preferred.concat(generic) : generic;

        for (const node of candidates) {
          if (!isVisible(node)) {
            continue;
          }
          const txt = norm(node.textContent || "");
          if (!txt || txt.length > 20) {
            continue;
          }
          if (parsePageIndexText(txt)) {
            return node as HTMLElement;
          }
        }

        return null;
      };
      const readVisiblePageIndex = (): { current: number; total: number } | null => {
        const el = findVisiblePageIndexElement();
        if (!el) {
          return null;
        }
        return parsePageIndexText(el.textContent || "");
      };

      const clickNextNearVisiblePageIndex = (): boolean => {
        const pageIndexEl = findVisiblePageIndexElement();
        if (!pageIndexEl) {
          return false;
        }
        const indexState = parsePageIndexText(pageIndexEl.textContent || "");
        if (!indexState || indexState.current >= indexState.total) {
          return false;
        }

        const anchor = pageIndexEl.getBoundingClientRect();
        const anchorCenterY = anchor.top + anchor.height / 2;
        const candidates = Array.from(document.querySelectorAll("button, [role='button']"));
        let best: HTMLElement | null = null;
        let bestScore = Number.POSITIVE_INFINITY;

        for (const node of candidates) {
          const el = node as HTMLElement;
          if (!isVisible(el)) {
            continue;
          }
          if (el === pageIndexEl || pageIndexEl.contains(el)) {
            continue;
          }
          const rect = el.getBoundingClientRect();
          const dx = rect.left - anchor.right;
          if (dx < 4 || dx > 140) {
            continue;
          }
          const centerY = rect.top + rect.height / 2;
          if (Math.abs(centerY - anchorCenterY) > 44) {
            continue;
          }

          const disabled =
            (el as HTMLButtonElement).disabled ||
            el.getAttribute("aria-disabled") === "true" ||
            el.classList.contains("ant-pagination-disabled") ||
            /disabled/.test(el.className);
          if (disabled) {
            continue;
          }

          const txt = norm(el.textContent || "").toLowerCase();
          const cls = (el.className || "").toLowerCase();
          const aria = (el.getAttribute("aria-label") || "").toLowerCase();
          const title = (el.getAttribute("title") || "").toLowerCase();
          if (txt === "<" || /previous|prev|trang truoc/.test(aria) || /previous|prev|trang truoc/.test(title)) {
            continue;
          }

          let score = dx;
          if (/next|trang sau/.test(aria) || /next|trang sau/.test(title)) {
            score -= 30;
          }
          if (/icon-only/.test(cls)) {
            score -= 10;
          }
          if (/anticon-right|arrow-right|chevron-right/.test(cls)) {
            score -= 20;
          }

          if (score < bestScore) {
            bestScore = score;
            best = el;
          }
        }

        if (!best) {
          return false;
        }

        best.click();
        return true;
      };

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

        const pageIndex = readVisiblePageIndex();
        if (pageIndex) {
          return { ...pageIndex, pagerIndex: -1 };
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
        return clickNextNearVisiblePageIndex();
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
    "button.ant-btn.ant-btn-primary.ant-btn-icon-only:has(.anticon-right)",
    "button.ant-btn.ant-btn-primary.ant-btn-icon-only:has(i.anticon-right)",
    "button.ant-btn-primary.ant-btn-icon-only:has(svg[data-icon='right'])",
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
    if (before.isFallback || after.isFallback) {
      return attempted;
    }
    return after.current > before.current;
  }

  return attempted;
}

export { readPaginationState, clickNextPageByIndicator, goToNextPage };
export type { PaginationState };

