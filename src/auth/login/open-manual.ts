import { launch } from "cloakbrowser";
import type { Browser } from "playwright-core";
import { logger } from "../../shared/logger.js";
import { sanitizeBaseUrl, type AppConfig } from "../../shared/config.js";
import { installEvalShim } from "./detail.js";
import { LOGIN_URL, USERNAME_SELECTORS, PASSWORD_SELECTORS } from "./shared.js";
import { ensureLoginFormVisible, fillFirst } from "./ui-core.js";

export async function openManualLoginAssist(config: AppConfig): Promise<void> {
  const prepareTimeoutMs = Number(process.env.GDT_PREPARE_TIMEOUT_MS ?? 900000);
  const browser: Browser = await launch({ headless: false, humanize: true, args: ["--start-maximized"] });
  try {
    const page = await browser.newPage({ viewport: null });
    await installEvalShim(page);
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

