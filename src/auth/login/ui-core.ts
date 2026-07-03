import type { Page } from "playwright-core";
import { PASSWORD_SELECTORS, USERNAME_SELECTORS } from "./shared.js";

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

export { fillFirst, clickFirst, hasVisibleInput, closeBlockingDialogs, ensureLoginFormVisible };

