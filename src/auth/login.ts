import { promises as fs } from "node:fs";
import { launch } from "cloakbrowser";
import type { Browser, Page, Response } from "playwright-core";
import { logger } from "../shared/logger.js";
import { solveCaptcha } from "./captcha.js";
import { type AppConfig, sanitizeBaseUrl } from "../shared/config.js";
import { type InvoiceDirection, type LoginResult, type ManualFilterContext } from "../shared/types.js";

const LOGIN_URL = "/";

const USERNAME_SELECTORS = [
  ".ant-modal input[placeholder*='Tên đăng nhập']",
  ".ant-modal input[placeholder*='Ten dang nhap']",
  ".ant-modal input[name='username']",
  ".ant-modal input[id*='username']",
  "input[placeholder*='Tên đăng nhập']",
  "input[placeholder*='Ten dang nhap']",
  "input[name='username']",
  "input[id*='username']",
  "input[autocomplete='username']",
  "input[type='text']",
];

const PASSWORD_SELECTORS = [
  ".ant-modal input[placeholder*='Mật khẩu']",
  ".ant-modal input[placeholder*='Mat khau']",
  ".ant-modal input[name='password']",
  ".ant-modal input[id*='password']",
  "input[placeholder*='Mật khẩu']",
  "input[placeholder*='Mat khau']",
  "input[name='password']",
  "input[id*='password']",
  "input[autocomplete='current-password']",
  "input[type='password']",
];

const CAPTCHA_SELECTORS = [
  ".ant-modal .ant-form-item:has-text('Nhập mã captcha') input",
  ".ant-modal .ant-form-item:has-text('Nhap ma captcha') input",
  ".ant-modal .ant-form-item:has-text('captcha') input",
  ".ant-modal input[aria-label*='captcha']",
];

const CAPTCHA_IMAGE_SELECTORS = [
  ".ant-modal img[src*='captcha']",
  ".ant-modal img[id*='captcha']",
  ".ant-modal img[class*='captcha']",
  "img[src*='captcha']",
  "img[id*='captcha']",
  "img[class*='captcha']",
];

const CAPTCHA_REFRESH_SELECTORS = [
  ".ant-modal .fa-refresh",
  ".ant-modal button[aria-label*='captcha']",
  ".ant-modal i[title*='captcha']",
  ".ant-modal [class*='refresh']",
  ".fa-refresh",
  "button[aria-label*='captcha']",
  "i[title*='captcha']",
  "[class*='refresh']",
];

const LOGIN_SUBMIT_SELECTORS = [
  ".ant-modal button:has-text('Đăng nhập')",
  ".ant-modal button:has-text('Dang nhap')",
  ".ant-modal button[type='submit']",
  "button:has-text('Đăng nhập')",
  "button:has-text('Dang nhap')",
  "button[type='submit']",
];

const MANUAL_READY_SELECTORS = [
  ".ant-table-tbody tr",
  "table tbody tr",
  "[class*='invoice'] table tbody tr",
  "[class*='result'] table tbody tr",
];

function parseDdMmYyyy(value: string): { day: number; month: number; year: number } | null {
  const m = value.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) {
    return null;
  }

  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = Number(m[3]);
  const dt = new Date(year, month - 1, day);
  if (dt.getFullYear() !== year || dt.getMonth() !== month - 1 || dt.getDate() !== day) {
    return null;
  }

  return { day, month, year };
}

function toDdMmYyyy(value: string): string | undefined {
  const token = value.split("T")[0]?.trim() ?? "";
  if (!token) {
    return undefined;
  }

  const m = token.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) {
    return undefined;
  }

  const a = Number(m[1]);
  const b = Number(m[2]);
  const y = Number(m[3]);

  // Ambiguous dates default to DD/MM (consistent with GDT UI input).
  if (a > 12 && b <= 12) {
    return `${String(a).padStart(2, "0")}/${String(b).padStart(2, "0")}/${y}`;
  }

  // Clearly MM/DD format from API-style search strings.
  if (a <= 12 && b > 12) {
    return `${String(b).padStart(2, "0")}/${String(a).padStart(2, "0")}/${y}`;
  }

  return `${String(a).padStart(2, "0")}/${String(b).padStart(2, "0")}/${y}`;
}

function subtractOneDay(ddmmyyyy: string): string {
  const parts = parseDdMmYyyy(ddmmyyyy);
  if (!parts) {
    return ddmmyyyy;
  }

  const dt = new Date(parts.year, parts.month - 1, parts.day - 1);
  const dd = String(dt.getDate()).padStart(2, "0");
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const yyyy = String(dt.getFullYear());
  return `${dd}/${mm}/${yyyy}`;
}

function parseManualFilterFromRequestUrl(url: string): ManualFilterContext {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return {};
  }

  const pathname = parsed.pathname.toLowerCase();
  const context: ManualFilterContext = {};
  if (pathname.includes("/purchased")) {
    context.direction = "purchase";
  } else if (pathname.includes("/sold")) {
    context.direction = "sold";
  }

  const fromDirect =
    parsed.searchParams.get("from") ??
    parsed.searchParams.get("tngay") ??
    parsed.searchParams.get("tuNgay") ??
    parsed.searchParams.get("fromDate");
  const toDirect =
    parsed.searchParams.get("to") ??
    parsed.searchParams.get("dngay") ??
    parsed.searchParams.get("denNgay") ??
    parsed.searchParams.get("toDate");

  const fromValue = fromDirect ? toDdMmYyyy(fromDirect) : undefined;
  const toValue = toDirect ? toDdMmYyyy(toDirect) : undefined;
  if (fromValue) {
    context.from = fromValue;
  }
  if (toValue) {
    context.to = toValue;
  }

  const search = parsed.searchParams.get("search") ?? "";
  if (search) {
    const ge = search.match(/tdlap=ge=([^;]+)/i)?.[1];
    const le = search.match(/tdlap=le=([^;]+)/i)?.[1];
    const lt = search.match(/tdlap=lt=([^;]+)/i)?.[1];

    const fromSearch = ge ? toDdMmYyyy(ge) : undefined;
    if (fromSearch) {
      context.from = fromSearch;
    }

    const toSearchLe = le ? toDdMmYyyy(le) : undefined;
    if (toSearchLe) {
      context.to = toSearchLe;
    } else {
      const toSearchLt = lt ? toDdMmYyyy(lt) : undefined;
      if (toSearchLt) {
        context.to = subtractOneDay(toSearchLt);
      }
    }
  }

  return context;
}

function extractTokenPayload(payload: unknown): string | null {
  if (payload == null || typeof payload !== "object") {
    return null;
  }

  const maybe = payload as Record<string, unknown>;
  const direct = maybe.token ?? maybe.access_token ?? maybe.accessToken ?? maybe.id_token;
  if (typeof direct === "string" && direct.length > 10) {
    return direct;
  }

  for (const nestedKey of ["data", "result", "payload"]) {
    const nested = maybe[nestedKey];
    if (nested && typeof nested === "object") {
      const token = extractTokenPayload(nested);
      if (token) {
        return token;
      }
    }
  }

  return null;
}

function readJwtExp(token: string): number {
  try {
    const payloadPart = token.split(".")[1] ?? "";
    const json = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")) as { exp?: number };
    if (json.exp && Number.isFinite(json.exp)) {
      return json.exp * 1000;
    }
  } catch {
    // fallback below
  }

  return Date.now() + 2 * 60 * 60 * 1000;
}

async function fillFirst(page: Page, selectors: string[], value: string): Promise<boolean> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.count()) {
      const visible = await locator.isVisible().catch(() => false);
      if (!visible) {
        continue;
      }

      await locator.fill("");
      await locator.fill(value);
      return true;
    }
  }

  return false;
}

async function clickFirst(page: Page, selectors: string[]): Promise<boolean> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.count()) {
      await locator.click();
      return true;
    }
  }

  return false;
}

async function hasVisibleInput(page: Page, selectors: string[]): Promise<boolean> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.count()) {
      const visible = await locator.isVisible().catch(() => false);
      if (visible) {
        return true;
      }
    }
  }

  return false;
}

async function closeBlockingDialogs(page: Page): Promise<void> {
  await clickFirst(page, [
    "button[aria-label='Close']",
    "button:has-text('Close')",
    "button:has-text('Đóng')",
    ".ant-modal-close",
    ".swal2-close",
  ]);

  await page.keyboard.press("Escape").catch(() => undefined);
  await page.waitForTimeout(300);
}

async function ensureLoginFormVisible(page: Page): Promise<void> {
  await closeBlockingDialogs(page);

  const alreadyVisible =
    (await hasVisibleInput(page, USERNAME_SELECTORS)) &&
    (await hasVisibleInput(page, PASSWORD_SELECTORS));
  if (alreadyVisible) {
    return;
  }

  // Try click-by-text first for dynamic menus/buttons.
  const textTargets = ["Đăng nhập", "Dang nhap", "Đăng Nhập", "Login"];
  for (const target of textTargets) {
    const byText = page.getByText(target, { exact: false }).first();
    if (await byText.count()) {
      await byText.click().catch(() => undefined);
      await page.waitForTimeout(500);
      if ((await hasVisibleInput(page, USERNAME_SELECTORS)) && (await hasVisibleInput(page, PASSWORD_SELECTORS))) {
        return;
      }
    }
  }

  await clickFirst(page, [
    "div.header-item:has-text('Đăng nhập')",
    "div.home-header-menu-item:has-text('Đăng nhập')",
    "a:has-text('Đăng nhập')",
    "a:has-text('Dang nhap')",
    "button:has-text('Đăng nhập')",
    "button:has-text('Dang nhap')",
    "[title*='Đăng nhập']",
    "[title*='Dang nhap']",
    "[aria-label*='Đăng nhập']",
    "[aria-label*='Dang nhap']",
    "a[href*='dang-nhap']",
    "a[href*='dangnhap']",
    "[class*='login']",
  ]);

  await page.waitForTimeout(800);

  const visibleAfterClick =
    (await hasVisibleInput(page, USERNAME_SELECTORS)) &&
    (await hasVisibleInput(page, PASSWORD_SELECTORS));
  if (visibleAfterClick) {
    return;
  }

  // Fallback: discover login link and navigate directly.
  const discoveredLoginHref = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll("a"));
    for (const link of links) {
      const text = (link.textContent ?? "").toLowerCase();
      const href = (link.getAttribute("href") ?? "").toLowerCase();
      if (text.includes("đăng nhập") || text.includes("dang nhap") || href.includes("dang-nhap") || href.includes("dangnhap")) {
        return link.getAttribute("href") ?? "";
      }
    }
    return "";
  });

  if (discoveredLoginHref) {
    const target = new URL(discoveredLoginHref, page.url()).toString();
    await page.goto(target, { waitUntil: "networkidle" });
    const visibleAfterNavigate =
      (await hasVisibleInput(page, USERNAME_SELECTORS)) &&
      (await hasVisibleInput(page, PASSWORD_SELECTORS));
    if (visibleAfterNavigate) {
      return;
    }
  }

  const currentUrl = page.url();
  const bodyText = await page.locator("body").first().textContent().catch(() => "");
  const snippet = (bodyText ?? "").replace(/\s+/g, " ").trim().slice(0, 180);
  throw new Error(`Khong mo duoc form dang nhap hoac khong tim thay o username/password. url=${currentUrl}; body='${snippet}'`);
}

async function extractCaptchaPayload(page: Page): Promise<string> {
  for (const selector of CAPTCHA_IMAGE_SELECTORS) {
    const img = page.locator(selector).first();
    if (await img.count()) {
      const src = await img.getAttribute("src");
      if (src) {
        if (src.startsWith("data:image/svg+xml;base64,")) {
          return Buffer.from(src.replace("data:image/svg+xml;base64,", ""), "base64").toString("utf8");
        }

        if (src.startsWith("data:image/svg+xml,")) {
          return decodeURIComponent(src.replace("data:image/svg+xml,", ""));
        }

        if (src.startsWith("data:image/")) {
          return src;
        }

        const response = await page.context().request.get(new URL(src, page.url()).toString());
        const contentType = response.headers()["content-type"] ?? "";
        if (contentType.includes("svg")) {
          return await response.text();
        }

        const body = await response.body();
        return `data:${contentType || "image/png"};base64,${Buffer.from(body).toString("base64")}`;
      }
    }
  }

  const inlineSvg = page.locator("svg").first();
  if (await inlineSvg.count()) {
    return await inlineSvg.evaluate((el) => el.outerHTML);
  }

  throw new Error("Khong tim thay captcha tren trang dang nhap");
}

async function inferTokenFromStorage(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const keys = ["token", "access_token", "accessToken", "jwt", "id_token"];

    for (const store of [localStorage, sessionStorage]) {
      for (let i = 0; i < store.length; i += 1) {
        const key = store.key(i);
        if (!key) {
          continue;
        }

        const value = store.getItem(key);
        if (!value) {
          continue;
        }

        if (!keys.some((needle) => key.toLowerCase().includes(needle))) {
          continue;
        }

        try {
          const parsed = JSON.parse(value) as Record<string, unknown>;
          if (parsed && typeof parsed === "object") {
            for (const k of keys) {
              const nested = parsed[k];
              if (typeof nested === "string" && nested.length > 10) {
                return nested;
              }
            }
          }
        } catch {
          if (value.length > 10) {
            return value;
          }
        }
      }
    }

    return null;
  });
}

function classifyErrorMessage(message: string): "captcha" | "credential" | "other" {
  const normalized = message.toLowerCase();
  if (normalized.includes("captcha")) {
    return "captcha";
  }
  if (normalized.includes("mật khẩu") || normalized.includes("mat khau") || normalized.includes("tên đăng nhập") || normalized.includes("dang nhap")) {
    return "credential";
  }
  return "other";
}

async function readVisibleError(page: Page): Promise<string> {
  const candidates = [
    ".ant-message-error",
    ".ant-notification-notice-description",
    ".toast-message",
    ".swal2-popup",
    ".error",
  ];

  for (const selector of candidates) {
    const locator = page.locator(selector).first();
    if (await locator.count()) {
      const text = (await locator.textContent())?.trim();
      if (text) {
        return text;
      }
    }
  }

  return "";
}

async function hasManualSearchResults(page: Page): Promise<boolean> {
  for (const selector of MANUAL_READY_SELECTORS) {
    const locator = page.locator(selector).first();
    if (await locator.count()) {
      const visible = await locator.isVisible().catch(() => false);
      if (visible) {
        return true;
      }
    }
  }

  return false;
}

async function extractManualFilterContext(page: Page, desiredDirection?: InvoiceDirection): Promise<ManualFilterContext> {
  const context = await page.evaluate(() => {
    const dateRegex = /^\d{2}\/\d{2}\/\d{4}$/;
    const inputValues = Array.from(document.querySelectorAll("input"))
      .map((el) => (el as HTMLInputElement).value?.trim() ?? "")
      .filter((value) => dateRegex.test(value));

    const activeText = Array.from(document.querySelectorAll(".ant-tabs-tab-active, .ui-tabs-active, .tab-active"))
      .map((el) => (el.textContent ?? "").trim().toLowerCase())
      .join(" ");

    let direction: "sold" | "purchase" | undefined;
    if (activeText.includes("mua vào") || activeText.includes("mua vao")) {
      direction = "purchase";
    } else if (activeText.includes("bán ra") || activeText.includes("ban ra")) {
      direction = "sold";
    }

    return {
      from: inputValues[0],
      to: inputValues[1],
      direction,
    };
  });

  return {
    from: context.from,
    to: context.to,
    direction: context.direction ?? desiredDirection,
  };
}

async function clickFirstAvailable(page: Page, selectors: string[]): Promise<boolean> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if ((await locator.count()) && (await locator.isVisible().catch(() => false))) {
      await locator.click().catch(() => undefined);
      return true;
    }
  }
  return false;
}

/**
 * Emit a structured interaction event that the UI can parse and render on a
 * chronological debug timeline. Serialized as a single JSON line prefixed with
 * a stable tag so the UI can pick it out of the log stream.
 */
function emitEvent(action: string, detail: string, html?: string): void {
  const payload = {
    ts: Date.now(),
    action,
    detail: detail.slice(0, 200),
    html: html ? html.slice(0, 1500) : undefined,
  };
  logger.info(`[GDT-EVENT] ${JSON.stringify(payload)}`);
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
 * Extract the "Tên hàng hóa, dịch vụ" column from the detail modal.
 *
 * The detail modal renders a real invoice HTML table. We anchor on the header
 * cell whose text is "Tên hàng hóa, dịch vụ", scroll it into view, work out its
 * column index within the header row, then read the cells directly below it in
 * the following body rows of the same table.
 */
async function extractInvoiceItemNames(page: Page): Promise<string[]> {
  // Give the invoice table a moment to finish rendering inside the modal.
  await page.waitForTimeout(300);

  // Scroll the header cell into view first (per request: scroll to the
  // "Tên hàng hóa, dịch vụ" row, then read the text right below it).
  await page
    .evaluate(() => {
      const norm = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();
      const modal =
        (document.querySelector(".ant-modal-body") as HTMLElement | null) ||
        (document.querySelector(".ant-modal") as HTMLElement | null) ||
        document.body;
      const cells = Array.from(modal.querySelectorAll("th, td")) as HTMLElement[];
      const header = cells.find((c) => {
        const t = norm(c.textContent || "");
        return t.includes("tên hàng") || t.includes("ten hang");
      });
      header?.scrollIntoView({ block: "center", inline: "nearest" });
    })
    .catch(() => undefined);

  await page.waitForTimeout(200);

  return page
    .evaluate(() => {
      const norm = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();
      const clean = (s: string): string => (s || "").replace(/\s+/g, " ").trim();
      const modal =
        (document.querySelector(".ant-modal-body") as HTMLElement | null) ||
        (document.querySelector(".ant-modal") as HTMLElement | null) ||
        document.body;

      const isHeader = (t: string): boolean => t.includes("tên hàng") || t.includes("ten hang");

      // Find the header cell "Tên hàng hóa, dịch vụ" inside a table.
      const headerCells = Array.from(modal.querySelectorAll("th, td")) as HTMLElement[];
      const headerCell = headerCells.find((c) => isHeader(norm(c.textContent || "")));
      if (!headerCell) {
        return [] as string[];
      }

      const headerRow = headerCell.closest("tr") as HTMLTableRowElement | null;
      const table = headerCell.closest("table") as HTMLTableElement | null;
      if (!headerRow || !table) {
        return [] as string[];
      }

      // Column index of the header cell within its row.
      const rowCells = Array.from(headerRow.children) as HTMLElement[];
      const colIdx = rowCells.indexOf(headerCell);
      if (colIdx === -1) {
        return [] as string[];
      }

      // Collect the cells directly below the header, in each following row of
      // the same table. Stop at obvious summary/footer rows.
      const allRows = Array.from(table.querySelectorAll("tr")) as HTMLTableRowElement[];
      const headerIndex = allRows.indexOf(headerRow);
      const names: string[] = [];

      for (let i = headerIndex + 1; i < allRows.length; i++) {
        const row = allRows[i];
        if (!row) {
          continue;
        }
        const cells = Array.from(row.children) as HTMLElement[];
        // Skip rows that are themselves header repeats.
        if (cells.some((c) => isHeader(norm(c.textContent || "")))) {
          continue;
        }
        const cell = cells[colIdx];
        if (!cell) {
          continue;
        }
        const txt = clean(cell.textContent || "");
        if (txt) {
          names.push(txt);
        }
      }

      return names;
    })
    .catch(() => [] as string[]);
}

/** Close the currently-open detail modal (best effort). */
async function closeInvoiceModal(page: Page): Promise<void> {
  await clickFirstAvailable(page, [
    ".ant-modal-close",
    ".ant-modal button[aria-label='Close']",
    ".ant-modal-wrap .ant-modal-close-x",
  ]);
  await page.keyboard.press("Escape").catch(() => undefined);
  await page
    .waitForFunction(() => !document.querySelector(".ant-modal-wrap:not([style*='display: none'])"), { timeout: 5000 })
    .catch(() => undefined);
}

/** Navigate to the next results page. Returns true if it moved. */
async function goToNextPage(page: Page): Promise<boolean> {
  const moved = await clickFirstAvailable(page, [
    ".ant-pagination-next:not(.ant-pagination-disabled) button",
    ".ant-pagination-next:not(.ant-pagination-disabled)",
    "button[aria-label='Trang sau']",
    "button[aria-label='Next page']",
  ]);
  if (moved) {
    await page.waitForTimeout(800);
    await page
      .waitForFunction(() => !document.querySelector(".ant-spin-spinning"), { timeout: 10000 })
      .catch(() => undefined);
  }
  return moved;
}

interface ScrapedInvoice {
  stt: string;
  mst: string;
  khmshdon: string;
  khhdon: string;
  shdon: string;
  ngay: string;
  items: string[];
}

/**
 * New flow requested by the user: for each invoice row, click it to enable the
 * toolbar icons, click "Xem hóa đơn" to open the detail modal, read the
 * "Tên hàng hóa, dịch vụ" column, associate it with the row's invoice number,
 * then close the modal and continue. Paginates across all result pages.
 * Results are written to `${outDir}/invoice-items.json`. Returns the count scraped.
 */
async function scrapeInvoiceItemsAllPages(page: Page, outDir: string): Promise<number> {
  await fs.mkdir(outDir, { recursive: true });

  const perRowDelayMs = Number(process.env.GDT_XML_ROW_DELAY_MS ?? 500);
  const modalTimeoutMs = Number(process.env.GDT_MODAL_TIMEOUT_MS ?? 15000);
  const results: ScrapedInvoice[] = [];
  let dumpedOnce = false;
  let pageIndex = 0;

  // Safety cap on pages to avoid infinite loops.
  const maxPages = Number(process.env.GDT_MAX_PAGES ?? 200);

  for (;;) {
    pageIndex += 1;

    let rows = page.locator(".ant-table-tbody tr.ant-table-row");
    let rowCount = await rows.count();
    if (rowCount === 0) {
      rows = page.locator(".ant-table-tbody tr");
      rowCount = await rows.count();
    }

    if (rowCount === 0) {
      logger.warn("[VIEW] Khong tim thay hoa don nao tren bang ket qua.");
      emitEvent("no-rows", "Khong tim thay hoa don nao tren bang ket qua");
      break;
    }

    logger.info(`[VIEW] Trang ${pageIndex}: ${rowCount} hoa don`);
    const tableHtml = await captureHtml(page, ".ant-table-tbody");
    emitEvent("rows-found", `Trang ${pageIndex}: ${rowCount} hoa don`, tableHtml);

    for (let r = 0; r < rowCount; r += 1) {
      const row = rows.nth(r);

      try {
        // Read the row cells first so we know which invoice we are viewing.
        const cells: string[] = await row
          .evaluate((tr) =>
            Array.from(tr.querySelectorAll("td")).map((td) => (td.textContent || "").replace(/\s+/g, " ").trim()),
          )
          .catch(() => [] as string[]);

        // Columns: [STT, MST, KyHieuMauSo, KyHieuHoaDon, SoHoaDon, NgayLap]
        const record: ScrapedInvoice = {
          stt: cells[0] ?? "",
          mst: cells[1] ?? "",
          khmshdon: cells[2] ?? "",
          khhdon: cells[3] ?? "",
          shdon: cells[4] ?? "",
          ngay: cells[5] ?? "",
          items: [],
        };

        // Step 1: click the row to enable the toolbar icons.
        const rowHtml = await row.evaluate((node) => (node as HTMLElement).outerHTML).catch(() => "");
        await row.click().catch(() => undefined);
        await page.waitForTimeout(perRowDelayMs);
        emitEvent("click-row", `Trang ${pageIndex} #${r + 1}: click hoa don so ${record.shdon}`, rowHtml);

        // Step 2: locate the "Xem hóa đơn" icon (enabled after row click).
        const found = await findAndMarkViewInvoiceButton(page);
        if (!found) {
          if (!dumpedOnce) {
            await dumpToolbarButtons(page);
            dumpedOnce = true;
          }
          const toolbarHtml = await captureHtml(page, ".ant-table-wrapper, .ant-table, header, [class*='toolbar']");
          emitEvent("icon-not-found", "Khong tim thay icon 'Xem hoa don'", toolbarHtml);
          logger.warn("[VIEW] Khong tim thay icon 'Xem hoa don'. Bo qua trang nay.");
          break;
        }

        // Step 3: click "Xem hóa đơn" to open the detail modal.
        await page.locator('[data-gdt-view="1"]').first().click().catch(() => undefined);
        emitEvent("click-view", `Click 'Xem hoa don' cho so ${record.shdon}`);

        // Step 4: wait for the modal to render.
        await page
          .waitForSelector(".ant-modal-body, .ant-modal", { timeout: modalTimeoutMs, state: "visible" })
          .catch(() => undefined);
        await page.waitForTimeout(400);
        const modalHtml = await captureHtml(page, ".ant-modal-body");
        emitEvent("detail-modal", `Modal chi tiet hoa don so ${record.shdon}`, modalHtml);

        // Step 5: extract "Tên hàng hóa, dịch vụ".
        record.items = await extractInvoiceItemNames(page);
        if (record.items.length) {
          logger.info(`[VIEW] So ${record.shdon}: ${record.items.length} muc → ${record.items.join(" | ").slice(0, 120)}`);
          emitEvent("items-extracted", `So ${record.shdon}: ${record.items.join(" | ").slice(0, 150)}`);
        } else {
          logger.warn(`[VIEW] So ${record.shdon}: khong doc duoc 'Ten hang hoa, dich vu'.`);
          emitEvent("items-empty", `So ${record.shdon}: khong doc duoc ten hang hoa`);
        }

        // Step 6: close the modal before the next row.
        await closeInvoiceModal(page);
        await page.waitForTimeout(250);
        emitEvent("modal-closed", `Dong modal so ${record.shdon}`);

        results.push(record);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.warn(`[VIEW] Trang ${pageIndex} #${r + 1}: loi: ${msg.slice(0, 150)}`);
        emitEvent("row-error", `Trang ${pageIndex} #${r + 1}: ${msg.slice(0, 120)}`);
        await closeInvoiceModal(page).catch(() => undefined);
      }
    }

    if (pageIndex >= maxPages) {
      logger.warn(`[VIEW] Da dat gioi han ${maxPages} trang, dung.`);
      break;
    }

    const moved = await goToNextPage(page);
    if (!moved) {
      logger.info("[VIEW] Khong con trang tiep theo. Hoan tat.");
      emitEvent("pagination-end", "Khong con trang tiep theo");
      break;
    }
    emitEvent("next-page", `Chuyen sang trang ${pageIndex + 1}`);
  }

  // Persist results.
  const outFile = `${outDir}/invoice-items.json`;
  await fs.writeFile(outFile, JSON.stringify(results, null, 2), "utf8");
  logger.info(`[VIEW] Da ghi ${results.length} hoa don vao ${outFile}`);
  emitEvent("saved", `Da ghi ${results.length} hoa don vao invoice-items.json`);

  return results.length;
}

export async function openManualLoginAssist(config: AppConfig): Promise<void> {
  const prepareTimeoutMs = Number(process.env.GDT_PREPARE_TIMEOUT_MS ?? 900000);
  const browser: Browser = await launch({ headless: false, humanize: true, args: ["--start-maximized"] });
  try {
    const page = await browser.newPage({ viewport: null });
    await page.goto(sanitizeBaseUrl(config.baseUrl, LOGIN_URL), { waitUntil: "domcontentloaded" }).catch(() =>
      page.goto(sanitizeBaseUrl(config.baseUrl, LOGIN_URL), { waitUntil: "load" }),
    );

    // Try to open login modal — best effort, user can click manually if this fails.
    try {
      await ensureLoginFormVisible(page);
    } catch {
      logger.warn("Khong tu mo duoc form dang nhap, vui long tu bam Dang nhap tren trang.");
    }

    // Pre-fill credentials if we have them — best effort.
    if (config.username && config.password) {
      try {
        await fillFirst(page, USERNAME_SELECTORS, config.username);
        await fillFirst(page, PASSWORD_SELECTORS, config.password);
        logger.info("Da dien san username/password. Vui long nhap captcha thu cong va bam Dang nhap.");
      } catch {
        logger.warn("Khong tu dien duoc user/pass. Vui long tu nhap thu cong tren browser.");
      }
    }

    logger.info("Browser dang mo. Sau khi dang nhap xong, vao trang tra cuu, chon ngay, bam Tim kiem. Sau do quay lai UI va bam Lay thong tin.");
    await page.waitForTimeout(prepareTimeoutMs);
  } finally {
    await browser.close();
  }
}

export async function loginAndGetToken(
  config: AppConfig,
  captchaFallback?: (payload: string, attempt: number) => Promise<string>,
  options?: { manualFirst?: boolean; desiredDirection?: InvoiceDirection; prefillCredentials?: boolean; continueSignalFile?: string; autoExportXml?: boolean; xmlDir?: string },
): Promise<LoginResult> {
  const manualFirst = Boolean(options?.manualFirst ?? config.manualFirst);
  const keepBrowserOpenOnManualFirst =
    manualFirst && (process.env.GDT_KEEP_BROWSER_OPEN_MANUAL_FIRST ?? "true").toLowerCase() !== "false";

  if (!manualFirst && (!config.username || !config.password)) {
    throw new Error("Thieu GDT_USERNAME hoac GDT_PASSWORD");
  }

  const headless = (process.env.GDT_HEADLESS ?? "false").toLowerCase() === "true";
  const manualLoginTimeoutMs = Number(process.env.GDT_MANUAL_LOGIN_TIMEOUT_MS ?? 180000);
  const manualReadyTimeoutMs = Number(process.env.GDT_MANUAL_READY_TIMEOUT_MS ?? 600000);
  const browser: Browser = await launch({ headless, humanize: true, args: ["--start-maximized"] });
  let tokenFromResponse: string | null = null;
  let latestManualFilterFromRequest: ManualFilterContext = {};

  try {
    const page = await browser.newPage({ viewport: null });

    page.on("response", async (response: Response) => {
      try {
        if (!/login|auth|token|dang-nhap|signin/i.test(response.url())) {
          return;
        }

        const contentType = response.headers()["content-type"] ?? "";
        if (!contentType.includes("application/json")) {
          return;
        }

        const body = await response.json();
        const token = extractTokenPayload(body);
        if (token) {
          tokenFromResponse = token;
        }
      } catch {
        // ignore observer errors
      }
    });

    page.on("request", (request) => {
      try {
        if (!/\/api\/query\/invoices\//i.test(request.url())) {
          return;
        }

        const parsed = parseManualFilterFromRequestUrl(request.url());
        latestManualFilterFromRequest = {
          from: parsed.from ?? latestManualFilterFromRequest.from,
          to: parsed.to ?? latestManualFilterFromRequest.to,
          direction: parsed.direction ?? latestManualFilterFromRequest.direction,
        };
      } catch {
        // ignore observer errors
      }
    });

    await page.goto(sanitizeBaseUrl(config.baseUrl, LOGIN_URL), { waitUntil: "networkidle" });

    const waitForManualLogin = async (): Promise<string | null> => {
      const startedAt = Date.now();
      while (Date.now() - startedAt < manualLoginTimeoutMs) {
        const token = tokenFromResponse ?? (await inferTokenFromStorage(page));
        if (token) {
          return token;
        }

        await page.waitForTimeout(1000);
      }

      return null;
    };

    const waitForManualSearchReady = async (): Promise<void> => {
      const startedAt = Date.now();
      while (Date.now() - startedAt < manualReadyTimeoutMs) {
        if (await hasManualSearchResults(page)) {
          return;
        }

        await page.waitForTimeout(1000);
      }

      throw new Error(
        "Da dang nhap thanh cong nhung chua thay bang ket qua tra cuu. Vui long mo dung trang tra cuu, chon ngay va bam tim kiem truoc khi he thong tiep tuc.",
      );
    };

    const waitForContinueSignal = async (): Promise<void> => {
      if (!options?.continueSignalFile) {
        return;
      }

      const startedAt = Date.now();
      const continueTimeoutMs = Number(process.env.GDT_CONTINUE_TIMEOUT_MS ?? 7200000);
      logger.info("Da san sang. Vui long bam Lay thong tin trong UI de tiep tuc crawl tu cung browser session.");

      while (Date.now() - startedAt < continueTimeoutMs) {
        try {
          await fs.access(options.continueSignalFile);
          await fs.unlink(options.continueSignalFile).catch(() => undefined);
          return;
        } catch {
          await page.waitForTimeout(1000);
        }
      }

      throw new Error("Het thoi gian cho tin hieu tiep tuc tu UI");
    };

    if (manualFirst) {
      if (options?.prefillCredentials !== false && config.username && config.password) {
        try {
          await ensureLoginFormVisible(page);
          await fillFirst(page, USERNAME_SELECTORS, config.username);
          await fillFirst(page, PASSWORD_SELECTORS, config.password);
          logger.info("Manual-first: da dien san username/password, vui long nhap captcha va bam Dang nhap");
        } catch {
          logger.warn("Manual-first: khong tu dien duoc username/password, vui long tu nhap thu cong");
        }
      }

      logger.info(
        "Manual-first: Chromium se mo voi GDT_BASE_URL. Vui long tu dang nhap, nhap captcha, vao trang tra cuu, chon ngay va bam tim kiem. He thong chi tiep tuc khi thay bang ket qua.",
      );
      const manualToken = await waitForManualLogin();
      if (!manualToken) {
        throw new Error("Khong phat hien token dang nhap thu cong trong thoi gian cho");
      }

      await waitForManualSearchReady();
      const domFilter = await extractManualFilterContext(page, options?.desiredDirection);
      const manualFilter: ManualFilterContext = {
        from: latestManualFilterFromRequest.from ?? domFilter.from,
        to: latestManualFilterFromRequest.to ?? domFilter.to,
        direction: latestManualFilterFromRequest.direction ?? domFilter.direction ?? options?.desiredDirection,
      };
      logger.info(
        `[DEBUG] manual-filter from-browser: from=${manualFilter.from ?? ""}; to=${manualFilter.to ?? ""}; direction=${manualFilter.direction ?? ""}`,
      );
      await waitForContinueSignal();

      let exportedXmlDir: string | undefined;
      if (options?.autoExportXml && options?.xmlDir) {
        try {
          logger.info("[VIEW] Bat dau xem tung hoa don va ghi lai ten hang hoa/dich vu...");
          const count = await scrapeInvoiceItemsAllPages(page, options.xmlDir);
          if (count > 0) {
            exportedXmlDir = options.xmlDir;
            logger.info(`[VIEW] Da xu ly ${count} hoa don, ket qua tai ${options.xmlDir}/invoice-items.json`);
          } else {
            logger.warn("[VIEW] Khong ghi duoc hoa don nao.");
          }
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          logger.warn(`[VIEW] Xem hoa don that bai: ${msg.slice(0, 150)}.`);
        }
      }

      return {
        token: manualToken,
        expiresAt: readJwtExp(manualToken),
        captchaMethod: "unknown",
        manualFilter,
        xmlDir: exportedXmlDir,
      };
    }

    await ensureLoginFormVisible(page);

    const usernameFilled = await fillFirst(page, USERNAME_SELECTORS, config.username);

    const passwordFilled = await fillFirst(page, PASSWORD_SELECTORS, config.password);

    if (!usernameFilled || !passwordFilled) {
      throw new Error("Khong tim thay o nhap username/password tren trang dang nhap");
    }

    let captchaMethod: LoginResult["captchaMethod"] = "unknown";
    const autoFailThreshold = Math.max(3, Math.floor(config.captchaMaxAttempts / 2));
    let consecutiveAutoFail = 0;
    let manualModeStarted = false;

    for (let attempt = 1; attempt <= config.captchaMaxAttempts; attempt += 1) {
      const captchaPayload = await extractCaptchaPayload(page);
      let captchaText = "";

      if (!headless && consecutiveAutoFail >= autoFailThreshold) {
        if (!manualModeStarted) {
          manualModeStarted = true;
          logger.warn(
            "Auto captcha that bai nhieu lan. Vui long nhap captcha truc tiep trong cua so browser va bam Dang nhap, he thong se tu tiep tuc.",
          );
        }

        const manualToken = await waitForManualLogin();
        if (manualToken) {
          logger.info("Da phat hien dang nhap thu cong thanh cong tren browser");
          return {
            token: manualToken,
            expiresAt: readJwtExp(manualToken),
            captchaMethod: "unknown",
          };
        }

        logger.warn("Khong thay token dang nhap thu cong trong thoi gian cho, tiep tuc tu dong");
        consecutiveAutoFail = 0;
      }

      if (captchaFallback && consecutiveAutoFail >= autoFailThreshold) {
        captchaText = await captchaFallback(captchaPayload, attempt);
        if (captchaText) {
          captchaMethod = "ocr";
          consecutiveAutoFail = 0;
        }
      }

      if (!captchaText) {
        const solved = await solveCaptcha(captchaPayload);
        captchaText = solved.text;
        captchaMethod = solved.method;
      }

      if (!captchaText) {
        consecutiveAutoFail += 1;
        await clickFirst(page, CAPTCHA_REFRESH_SELECTORS);
        await page.waitForTimeout(450);
        continue;
      }

      consecutiveAutoFail = 0;
      const captchaFilled = await fillFirst(page, CAPTCHA_SELECTORS, captchaText);

      if (!captchaFilled) {
        throw new Error("Khong tim thay o nhap captcha");
      }

      await clickFirst(page, LOGIN_SUBMIT_SELECTORS);

      await page.waitForTimeout(1200);

      const stored = await inferTokenFromStorage(page);
      const finalToken = tokenFromResponse ?? stored;
      if (finalToken) {
        logger.info(`Dang nhap thanh cong sau ${attempt} lan thu captcha`);
        return {
          token: finalToken,
          expiresAt: readJwtExp(finalToken),
          captchaMethod,
        };
      }

      const errorText = await readVisibleError(page);
      const kind = classifyErrorMessage(errorText);
      if (kind === "credential") {
        throw new Error(errorText || "Thong tin dang nhap khong hop le");
      }

      // Always refresh captcha after a failed attempt to avoid reusing stale captcha.
      await clickFirst(page, CAPTCHA_REFRESH_SELECTORS);
      await page.waitForTimeout(450);

      if (kind === "captcha") {
        consecutiveAutoFail += 1;
        logger.warn(`Sai captcha o lan thu ${attempt}, dang thu lai`);
      }
    }

    throw new Error(`Dang nhap that bai sau ${config.captchaMaxAttempts} lan thu`);
  } finally {
    if (keepBrowserOpenOnManualFirst) {
      logger.info("Manual-first: giu browser mo de ban co the kiem tra va thu lai neu can.");

      const closeOnExit = (): void => {
        void browser.close().catch(() => undefined);
      };
      process.once("exit", closeOnExit);
      process.once("SIGINT", closeOnExit);
      process.once("SIGTERM", closeOnExit);
    } else {
      await browser.close();
    }
  }
}
