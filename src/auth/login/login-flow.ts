import { join } from "node:path";
import { launch } from "cloakbrowser";
import type { Browser, Response } from "playwright-core";
import { logger } from "../../shared/logger.js";
import { solveCaptcha } from "../captcha.js";
import type { InvoiceDirection, LoginResult, ManualFilterContext } from "../../shared/types.js";
import type { AppConfig } from "../../shared/config.js";
import { sanitizeBaseUrl } from "../../shared/config.js";
import {
  LOGIN_URL,
  USERNAME_SELECTORS,
  PASSWORD_SELECTORS,
  CAPTCHA_SELECTORS,
  CAPTCHA_REFRESH_SELECTORS,
  LOGIN_SUBMIT_SELECTORS,
  parseManualFilterFromRequestUrl,
} from "./shared.js";
import { extractTokenPayload, readJwtExp } from "./shared-auth.js";
import { installEvalShim } from "./detail.js";
import { rescanEmptyLineItemsFromJson } from "./rescan-runner.js";
import { scrapeInvoiceItemsAllPages } from "./scrape.js";
import {
  extractCaptchaPayload,
  inferTokenFromStorage,
  classifyErrorMessage,
  readVisibleError,
  extractManualFilterContext,
} from "./ui-manual.js";
import { ensureLoginFormVisible, fillFirst, clickFirst } from "./ui-core.js";
import { waitForManualLoginToken, waitForManualSearchReady, waitForContinueSignal } from "./manual-waits.js";

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
    await installEvalShim(page);

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
        "Manual-first: Chromium se mo voi GDT_BASE_URL. Vui long tu dang nhap va vao man hinh tra cuu. Neu bam Lay thong tin thi can bang ket qua co san; neu bam Ra lai thi he thong tu tim theo So hoa don + Ngay.",
      );
      const manualToken = await waitForManualLoginToken(
        page,
        manualLoginTimeoutMs,
        async () => tokenFromResponse ?? (await inferTokenFromStorage(page)),
      );
      if (!manualToken) {
        throw new Error("Khong phat hien token dang nhap thu cong trong thoi gian cho");
      }
      const continueAction = await waitForContinueSignal(page, options?.continueSignalFile);

      let manualFilter: ManualFilterContext = {};
      const domFilter = await extractManualFilterContext(page, options?.desiredDirection);
      manualFilter = {
        from: latestManualFilterFromRequest.from ?? domFilter.from,
        to: latestManualFilterFromRequest.to ?? domFilter.to,
        direction: latestManualFilterFromRequest.direction ?? domFilter.direction ?? options?.desiredDirection,
      };

      if (continueAction !== "rescan-empty-line-items") {
        await waitForManualSearchReady(page, manualReadyTimeoutMs);
      }

      logger.info(
        `[DEBUG] manual-filter from-browser: from=${manualFilter.from ?? ""}; to=${manualFilter.to ?? ""}; direction=${manualFilter.direction ?? ""}`,
      );

      if (continueAction === "rescan-empty-line-items") {
        try {
          const jsonDir = options?.xmlDir ?? join(process.cwd(), ".gdt-xml-export");
          logger.info(`[RESCAN] Bat dau ra lai hoa don thieu lineItems tai ${jsonDir}`);
          await rescanEmptyLineItemsFromJson(page, jsonDir);
          logger.info("[RESCAN] Hoan tat ra lai hd_sold + hd_purchased");
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          logger.error(`[RESCAN] That bai: ${msg.slice(0, 180)}`);
        }

        return {
          token: manualToken,
          expiresAt: readJwtExp(manualToken),
          captchaMethod: "unknown",
          manualFilter,
          continueAction,
        };
      }

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
        continueAction,
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

        const manualToken = await waitForManualLoginToken(
          page,
          manualLoginTimeoutMs,
          async () => tokenFromResponse ?? (await inferTokenFromStorage(page)),
        );
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
