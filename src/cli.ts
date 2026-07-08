import "dotenv/config";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { getConfig, type AppConfig } from "./shared/config.js";
import { isValidDateInput } from "./shared/date.js";
import { logger } from "./shared/logger.js";
import {
  type ContinueRunMode,
  type InvoiceCrawlMetadata,
  type InvoiceDirection,
  type InvoiceType,
  type LoginResult,
  type ManualFilterContext,
} from "./shared/types.js";
import { clearTokenCache, readTokenCache, writeTokenCache } from "./auth/tokenCache.js";
import { loginAndGetToken, openManualLoginAssist } from "./auth/login.js";
import { ApiClient } from "./api/client.js";
import { collectInvoiceNameMap, listSoldInvoices } from "./api/invoices.js";
import { parseXmlInvoices, findXmlDownloadDir } from "./api/xml-parser.js";
import { downloadInvoiceWorkbook } from "./export/download.js";
import { mergeNamesIntoWorkbookWithMetadata } from "./export/merge.js";
import { runVerify } from "./verify.js";
import {
  clearCheckpoint,
  matchesScope,
  readCheckpoint,
  toRuntimeState,
  writeCheckpoint,
  type CrawlCheckpoint,
} from "./shared/checkpoint.js";

interface CliOptions {
  from?: string;
  to?: string;
  out: string;
  relogin?: boolean;
  noCache?: boolean;
  type?: InvoiceType;
  direction?: InvoiceDirection;
  verifyOnly?: boolean;
  manualFirst?: boolean;
  prepareLoginOnly?: boolean;
  continueSignalFile?: string;
  xmlDir?: string;
  autoExportXml?: boolean;
}

type ContinueFileAction = "continue" | `continue:${ContinueRunMode}` | "rescan-empty-line-items" | "stop-current-flow";

function normalizeContinueRunMode(value: string): ContinueRunMode | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "sold") return "sold";
  if (normalized === "purchased-hascode") return "purchased-hasCode";
  if (normalized === "purchased-nocode") return "purchased-noCode";
  if (normalized === "purchased-initcode") return "purchased-initCode";
  return null;
}

const CONTINUE_READY_MARKER =
  "Da san sang. Vui long bam Lay thong tin trong UI de tiep tuc crawl tu cung browser session.";

function parseContinueFileAction(input: string): ContinueFileAction {
  const raw = input.trim();
  const normalized = raw.toLowerCase();
  if (normalized.startsWith("continue:")) {
    const runMode = normalizeContinueRunMode(raw.slice("continue:".length));
    return runMode ? `continue:${runMode}` : "continue";
  }
  if (normalized === "rescan-empty-line-items") {
    return "rescan-empty-line-items";
  }
  if (normalized === "stop-current-flow") {
    return "stop-current-flow";
  }
  return "continue";
}

function getRunModeFromContinueFileAction(action: ContinueFileAction): ContinueRunMode {
  if (action === "continue") {
    return "sold";
  }

  if (!String(action).startsWith("continue:")) {
    return "sold";
  }

  return normalizeContinueRunMode(String(action).slice("continue:".length)) ?? "sold";
}

async function consumeContinueSignal(path: string): Promise<ContinueFileAction | null> {
  try {
    await fs.access(path);
  } catch {
    return null;
  }

  const action = parseContinueFileAction(await fs.readFile(path, "utf8").catch(() => "continue"));
  await fs.unlink(path).catch(() => undefined);
  return action;
}

function sanitizeFilePart(input: string): string {
  return input.replace(/[^0-9a-zA-Z_-]/g, "-");
}

async function waitForContinueSignalFile(path: string, timeoutMs: number): Promise<ContinueFileAction | null> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const action = await consumeContinueSignal(path);
    if (action) {
      return action;
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  return null;
}

function buildProgram(): Command {
  return new Command()
    .name("scrape-gdt")
    .description("Tra cuu hoa don GDT va bo sung cot ten hang hoa dich vu vao xlsx")
    .option("--from <dd/mm/yyyy>", "Ngay bat dau")
    .option("--to <dd/mm/yyyy>", "Ngay ket thuc")
    .option("--out <path>", "Duong dan file xlsx ket qua (bat buoc neu khong dung --verify-only)", "./DANH-SACH-HOA-DON.xlsx")
    .option("--relogin", "Bo qua token cache va dang nhap lai")
    .option("--no-cache", "Khong su dung token cache")
    .option("--type <invoice|ticket>", "Loai hoa don", "invoice")
    .option("--direction <sold|purchase>", "Huong tra cuu hoa don", "sold")
    .option("--manual-first", "Mo browser, cho nguoi dung login thu cong roi moi crawl")
    .option("--prepare-login-only", "Chi mo browser va dien username/password den buoc captcha")
    .option("--continue-signal-file <path>", "File signal de UI cho phep tiep tuc crawl tu browser hien tai")
    .option("--verify-only", "Chi verify cac endpoint (captcha/sold/detail/export), khong chay pipeline")
    .option("--xml-dir <path>", "Duong dan folder chua file XML da xuat tu GDT (neu set, dung XML thay API)")
    .option("--auto-export-xml", "Tu dong bam 'Xuat xml' qua tat ca cac trang trong manual-first roi parse XML")
    .showHelpAfterError();
}

function validateOptions(options: CliOptions): void {
  if ((options.from && !isValidDateInput(options.from)) || (options.to && !isValidDateInput(options.to))) {
    throw new Error("Dinh dang ngay phai la dd/mm/yyyy");
  }

  if (!options.prepareLoginOnly && !options.manualFirst && (!options.from || !options.to)) {
    throw new Error("Can --from va --to khi khong dung --manual-first");
  }

  if (!options.verifyOnly && !options.out) {
    throw new Error("--out la bat buoc khi khong dung --verify-only");
  }

  if (options.continueSignalFile && options.continueSignalFile.trim() === "") {
    throw new Error("--continue-signal-file khong duoc de trong");
  }

  if (!["invoice", "ticket"].includes(options.type ?? "invoice")) {
    throw new Error("--type phai la 'invoice' hoac 'ticket'");
  }

  if (!["sold", "purchase"].includes(options.direction ?? "sold")) {
    throw new Error("--direction phai la 'sold' hoac 'purchase'");
  }
}

async function buildTokenProvider(
  config: AppConfig,
  direction: InvoiceDirection,
  continueSignalFile?: string,
  autoExportXml?: { enabled: boolean; xmlDir: string },
): Promise<{
  getToken: () => Promise<string>;
  relogin: () => Promise<string>;
  getLastLoginMeta: () => LoginResult["captchaMethod"] | "cache" | null;
  getLastManualFilter: () => ManualFilterContext | null;
  readManualFilter: () => Promise<ManualFilterContext | null>;
  waitForManualSearchReady: () => Promise<ManualFilterContext | null>;
  runManualViewScrape: (runMode: ContinueRunMode) => Promise<number>;
  getLastXmlDir: () => string | null;
  getLastContinueAction: () => LoginResult["continueAction"] | null;
}> {
  let inMemoryToken: string | null = null;
  let inMemoryExpiry = 0;
  let lastMethod: LoginResult["captchaMethod"] | "cache" | null = null;
  let lastManualFilter: ManualFilterContext | null = null;
  let readManualFilterHook: (() => Promise<ManualFilterContext>) | null = null;
  let waitForManualSearchReadyHook: (() => Promise<ManualFilterContext>) | null = null;
  let runManualViewScrapeHook: ((runMode: ContinueRunMode) => Promise<number>) | null = null;
  let lastXmlDir: string | null = null;
  let lastContinueAction: LoginResult["continueAction"] | null = null;

  const doLogin = async (manualFirst = false): Promise<string> => {
    const login = await loginAndGetToken(config, undefined, {
      manualFirst,
      desiredDirection: direction,
      prefillCredentials: true,
      continueSignalFile,
      autoExportXml: autoExportXml?.enabled,
      xmlDir: autoExportXml?.xmlDir,
    });
    inMemoryToken = login.token;
    inMemoryExpiry = login.expiresAt;
    lastMethod = login.captchaMethod;
    lastManualFilter = login.manualFilter ?? null;
    readManualFilterHook = login.readManualFilter ?? null;
    waitForManualSearchReadyHook = login.waitForManualSearchReady ?? null;
    runManualViewScrapeHook = login.runManualViewScrape ?? null;
    lastXmlDir = login.xmlDir ?? null;
    lastContinueAction = login.continueAction ?? "continue";

    if (config.useTokenCache) {
      await writeTokenCache(config.tokenCachePath, login.token, login.expiresAt);
    }

    return login.token;
  };

  const getToken = async (): Promise<string> => {
    if (inMemoryToken && Date.now() < inMemoryExpiry) {
      return inMemoryToken;
    }

    if (config.manualFirst) {
      return doLogin(true);
    }

    if (!config.relogin && config.useTokenCache) {
      const cached = await readTokenCache(config.tokenCachePath);
      if (cached) {
        inMemoryToken = cached.token;
        inMemoryExpiry = cached.expiresAt;
        lastMethod = "cache";
        return cached.token;
      }
    }

    return doLogin(config.manualFirst);
  };

  return {
    getToken,
    relogin: () => doLogin(config.resumeOnRelogin ? config.manualFirst : false),
    getLastLoginMeta: () => lastMethod,
    getLastManualFilter: () => lastManualFilter,
    readManualFilter: async () => {
      if (!readManualFilterHook) {
        return lastManualFilter;
      }
      lastManualFilter = await readManualFilterHook();
      return lastManualFilter;
    },
    waitForManualSearchReady: async () => {
      if (!waitForManualSearchReadyHook) {
        return lastManualFilter;
      }
      lastManualFilter = await waitForManualSearchReadyHook();
      return lastManualFilter;
    },
    runManualViewScrape: async (runMode: ContinueRunMode) => {
      if (!runManualViewScrapeHook) {
        return 0;
      }
      return runManualViewScrapeHook(runMode);
    },
    getLastXmlDir: () => lastXmlDir,
    getLastContinueAction: () => lastContinueAction,
  };
}

function pickEndpoints(config: AppConfig, direction: InvoiceDirection): {
  soldEndpoint: string;
  detailEndpoint: string;
  exportEndpoints: string[];
} {
  if (direction === "purchase") {
    return {
      soldEndpoint: config.purchasedEndpoint,
      detailEndpoint: config.purchasedDetailEndpoint,
      exportEndpoints: [...config.purchasedExportEndpoints],
    };
  }

  return {
    soldEndpoint: config.soldEndpoint,
    detailEndpoint: config.detailEndpoint,
    exportEndpoints: [...config.exportEndpoints],
  };
}

async function main(): Promise<void> {
  const program = buildProgram();
  const options = program.parse().opts<CliOptions>();
  validateOptions(options);

  const direction = (options.direction as InvoiceDirection | undefined) ?? "sold";

  const config = getConfig({
    relogin: Boolean(options.relogin),
    useTokenCache: !Boolean(options.noCache),
    manualFirst: Boolean(options.manualFirst),
    invoiceType: (options.type as InvoiceType) ?? "invoice",
  });

  if (options.prepareLoginOnly) {
    await openManualLoginAssist(config);
    return;
  }

  if (!config.useTokenCache && config.relogin) {
    await clearTokenCache(config.tokenCachePath);
  }

  logger.info(`Bat dau ${options.verifyOnly ? "verify" : "pipeline"}; direction=${direction}`);

  // Auto-export XML: enabled when flag set and no pre-existing xmlDir provided
  const autoXmlDir = path.resolve(process.cwd(), process.env.GDT_XML_EXPORT_DIR ?? "gdt-xml-export");
  const autoExportEnabled = Boolean(options.autoExportXml) && !options.xmlDir;
  if (autoExportEnabled) {
    logger.info(`[XML-EXPORT] Auto-export XML enabled, target dir: ${autoXmlDir}`);
  }

  const tokenProvider = await buildTokenProvider(
    config,
    direction,
    options.continueSignalFile,
    autoExportEnabled ? { enabled: true, xmlDir: autoXmlDir } : undefined,
  );
  const client = new ApiClient({
    baseURL: config.baseUrl,
    getToken: tokenProvider.getToken,
    relogin: tokenProvider.relogin,
    onAuthExpired: ({ message }) => {
      logger.warn(`SESSION_EXPIRED: ${message}`);
      logger.warn("Vui long dang nhap lai tren browser neu can. He thong se tiep tuc tu checkpoint gan nhat.");
    },
  });

  let activeProfile: "standard" | "third-party" = config.endpointProfile;
  let { soldEndpoint: activeSoldEndpoint, detailEndpoint: activeDetailEndpoint, exportEndpoints: activeExportEndpoints } =
    pickEndpoints(config, direction);

  const switchToStandardProfile = (): void => {
    activeProfile = "standard";
    if (direction === "purchase") {
      activeSoldEndpoint = "/api/query/invoices/purchased";
      activeDetailEndpoint = "/api/query/invoices/detail-purchased";
      activeExportEndpoints = ["/api/query/invoices/purchased/export-excel", "/api/query/invoices/purchased/export-xml"];
    } else {
      activeSoldEndpoint = "/api/query/invoices/sold";
      activeDetailEndpoint = "/api/query/invoices/detail";
      activeExportEndpoints = ["/api/query/invoices/export-excel", "/api/query/invoices/export-xml"];
    }
  };

  let effectiveFrom = options.from;
  let effectiveTo = options.to;

  if (config.manualFirst && (!effectiveFrom || !effectiveTo)) {
    await tokenProvider.getToken();
    if (tokenProvider.getLastContinueAction() === "rescan-empty-line-items") {
      logger.info("Manual-first rescan da hoan tat. Ket thuc tien trinh theo yeu cau.");
      return;
    }
    const filter = tokenProvider.getLastManualFilter();
    effectiveFrom = effectiveFrom ?? filter?.from;
    effectiveTo = effectiveTo ?? filter?.to;
  }

  if (!effectiveFrom || !effectiveTo) {
    throw new Error("Khong doc duoc khoang ngay. Vui long chon ngay va bam Tim kiem tren GDT truoc khi Lay thong tin.");
  }

  logger.info(
    `[DEBUG] scope: profile=${activeProfile}; direction=${direction}; soldEndpoint=${activeSoldEndpoint}; detailEndpoint=${activeDetailEndpoint}; from=${effectiveFrom}; to=${effectiveTo}; invoiceType=${config.invoiceType}`,
  );

  const tryDownloadFallback = async (reason: string): Promise<boolean> => {
    const fallbackDir = path.resolve(process.cwd(), process.env.GDT_FALLBACK_DIR ?? "gdt-fallback-downloads");
    try {
      if (!effectiveFrom || !effectiveTo) {
        throw new Error("Khong co khoang ngay hien tai de tai file fallback");
      }
      const fallbackFrom = effectiveFrom;
      const fallbackTo = effectiveTo;
      logger.warn(`[FALLBACK] List API that bai: ${reason}`);
      logger.warn("[FALLBACK] Thu tai xlsx tu endpoint export de van co du lieu tong hop.");

      const workbookBuffer = await downloadInvoiceWorkbook(
        client,
        config.baseUrl,
        fallbackFrom,
        fallbackTo,
        config.invoiceType,
        activeExportEndpoints,
        activeProfile,
        config.username,
      );

      await fs.mkdir(fallbackDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const rawName = `raw-${sanitizeFilePart(direction)}-${sanitizeFilePart(fallbackFrom)}-${sanitizeFilePart(fallbackTo)}-${stamp}.xlsx`;
      const rawPath = path.join(fallbackDir, rawName);
      await fs.writeFile(rawPath, workbookBuffer);

      const emptyMap = {
        byComposite: new Map<string, string>(),
        byNumberOnly: new Map<string, string>(),
      };
      const emptyMetadata = {
        byComposite: new Map<string, InvoiceCrawlMetadata>(),
        byNumberOnly: new Map<string, InvoiceCrawlMetadata>(),
      };
      const emptyBuyerNames = {
        byComposite: new Map<string, string>(),
        byNumberOnly: new Map<string, string>(),
      };
      const merged = await mergeNamesIntoWorkbookWithMetadata(workbookBuffer, emptyMap, {
        metadata: emptyMetadata,
        buyerNames: emptyBuyerNames,
      });
      await fs.writeFile(options.out, merged.output);

      logger.warn(`[FALLBACK] Da luu file raw tai: ${rawPath}`);
      logger.warn(`[FALLBACK] Da xuat file tong hop tam thoi tai: ${options.out}`);
      logger.warn("[FALLBACK] Cot ten hang hoa de trong do khong lay duoc detail API.");
      return true;
    } catch (fallbackError) {
      const msg = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      logger.error(`[FALLBACK] Khong tai duoc xlsx fallback: ${msg}`);
      return false;
    }
  };

  if (options.verifyOnly) {
    await runVerify({ from: effectiveFrom!, to: effectiveTo!, config, client });
    return;
  }

  const retrySignalTimeoutMs = Number(process.env.GDT_RETRY_SIGNAL_TIMEOUT_MS ?? 7200000);
  const isManualViewMode = config.manualFirst && autoExportEnabled;
  const shouldStopFlow = async (): Promise<boolean> => {
    if (!options.continueSignalFile) {
      return false;
    }

    const action = await consumeContinueSignal(options.continueSignalFile);
    if (!action) {
      return false;
    }

    if (action === "stop-current-flow") {
      return true;
    }

    await fs.writeFile(options.continueSignalFile, action, "utf8").catch(() => undefined);
    return false;
  };

  const waitForNextManualRun = async (): Promise<void> => {
    if (!config.manualFirst || !options.continueSignalFile) {
      return;
    }

    for (;;) {
      logger.info(CONTINUE_READY_MARKER);
      const action = await waitForContinueSignalFile(options.continueSignalFile, retrySignalTimeoutMs);
      if (!action) {
        throw new Error("Het thoi gian cho tin hieu tiep tuc tu UI");
      }

      if (action === "stop-current-flow") {
        logger.warn("Da nhan yeu cau dung flow hien tai. Browser/session van duoc giu nguyen.");
        continue;
      }

      const filter = await tokenProvider.waitForManualSearchReady();
      effectiveFrom = options.from ?? filter?.from;
      effectiveTo = options.to ?? filter?.to;
      logger.info(
        `[DEBUG] manual-filter refreshed: from=${effectiveFrom ?? ""}; to=${effectiveTo ?? ""}; direction=${filter?.direction ?? direction}`,
      );

      if (!effectiveFrom || !effectiveTo) {
        throw new Error("Khong doc duoc khoang ngay moi tu man hinh GDT sau khi bam Tim kiem.");
      }

      return;
    }
  };

  const runManualViewLoop = async (): Promise<void> => {
    if (!options.continueSignalFile) {
      return;
    }

    for (;;) {
      logger.info(CONTINUE_READY_MARKER);
      const action = await waitForContinueSignalFile(options.continueSignalFile, retrySignalTimeoutMs);
      if (!action) {
        throw new Error("Het thoi gian cho tin hieu tiep tuc tu UI");
      }

      if (action === "stop-current-flow") {
        logger.warn("Da nhan yeu cau dung flow hien tai. Browser/session van duoc giu nguyen.");
        continue;
      }

      const filter = await tokenProvider.waitForManualSearchReady();
      effectiveFrom = options.from ?? filter?.from;
      effectiveTo = options.to ?? filter?.to;
      logger.info(
        `[DEBUG] manual-filter refreshed: from=${effectiveFrom ?? ""}; to=${effectiveTo ?? ""}; direction=${filter?.direction ?? direction}`,
      );

      const runMode = getRunModeFromContinueFileAction(action);
      await tokenProvider.runManualViewScrape(runMode);
    }
  };

  if (isManualViewMode) {
    await runManualViewLoop();
    return;
  }

  while (true) {
    if (!effectiveFrom || !effectiveTo) {
      throw new Error("Khong doc duoc khoang ngay hien tai de chay pipeline.");
    }

    const cycleFrom = effectiveFrom;
    const cycleTo = effectiveTo;
    let invoices;
    let attempt = 0;

    const autoExportedXmlDir = tokenProvider.getLastXmlDir();
    const xmlSourceDir = options.xmlDir ?? autoExportedXmlDir ?? undefined;

    if (xmlSourceDir) {
      logger.info(`[DEBUG] Using XML files from: ${xmlSourceDir}`);
      try {
        const xmlPath = path.resolve(xmlSourceDir);
        invoices = await parseXmlInvoices(xmlPath);
        logger.info(`[DEBUG] Parsed ${invoices.length} invoices from XML files`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`[DEBUG] Failed to parse XML: ${message}`);
        throw error;
      }
    } else {
      while (true) {
        attempt += 1;
        logger.info(`[DEBUG] list-sold attempt=${attempt}; endpoint=${activeSoldEndpoint}; profile=${activeProfile}`);
        try {
          invoices = await listSoldInvoices(
            client,
            cycleFrom,
            cycleTo,
            config.invoiceType,
            activeSoldEndpoint,
            activeProfile,
            config.username,
          );
          break;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (activeProfile === "third-party" && message.includes("-> 403")) {
            logger.warn("Khong co quyen endpoint user-third-party, tu dong fallback sang endpoint chuan");
            switchToStandardProfile();
            logger.info(`[DEBUG] fallback endpoint: soldEndpoint=${activeSoldEndpoint}; detailEndpoint=${activeDetailEndpoint}`);
            continue;
          }

          logger.error(
            `[DEBUG] list-sold failed: attempt=${attempt}; endpoint=${activeSoldEndpoint}; profile=${activeProfile}; from=${cycleFrom}; to=${cycleTo}; error=${message.slice(0, 150)}`,
          );

          logger.info(`[DEBUG] Attempting fallback download from export endpoints: ${activeExportEndpoints.join(", ")}`);
          const downloaded = await tryDownloadFallback(message);
          if (downloaded) {
            logger.info("[DEBUG] Fallback download succeeded, pipeline complete");
            if (!config.manualFirst || !options.continueSignalFile) {
              return;
            }
            await waitForNextManualRun();
            break;
          }
          logger.error("[DEBUG] Fallback download also failed, waiting for retry signal or timeout...");

          if (config.manualFirst && options.continueSignalFile) {
            logger.warn(
              "Lay danh sach that bai. Browser van dang mo. Vui long kiem tra tab/bo loc tren GDT, bam Tim kiem lai, sau do bam Lay thong tin de thu lai.",
            );
            const action = await waitForContinueSignalFile(options.continueSignalFile, retrySignalTimeoutMs);
            if (!action) {
              throw new Error("Het thoi gian cho tin hieu thu lai tu UI");
            }

            if (action === "stop-current-flow") {
              logger.warn("Da nhan yeu cau dung flow hien tai. Session browser van duoc giu nguyen.");
              logger.info(CONTINUE_READY_MARKER);
              continue;
            }

            const filter = await tokenProvider.waitForManualSearchReady();
            effectiveFrom = options.from ?? filter?.from;
            effectiveTo = options.to ?? filter?.to;
            logger.info("Da nhan tin hieu thu lai tu UI, tiep tuc truy van danh sach hoa don...");
            continue;
          }

          throw error;
        }
      }
    }

    if (!invoices) {
      continue;
    }

    logger.info(`Lay duoc ${invoices.length} hoa don`);

    if (invoices.length === 0) {
      logger.warn("Khong co hoa don trong khoang ngay. Se dung pipeline.");
      if (!config.manualFirst || !options.continueSignalFile) {
        return;
      }
      await waitForNextManualRun();
      continue;
    }

    while (true) {
      let resumeIndex = 0;
      let seedMap;
      let seedMetadata;
      let seedFailed;

      const loadedCheckpoint = await readCheckpoint(config.checkpointPath);
      if (
        loadedCheckpoint &&
        matchesScope(loadedCheckpoint, {
          from: cycleFrom,
          to: cycleTo,
          out: options.out,
          invoiceType: config.invoiceType,
          endpointProfile: activeProfile,
          invoicesTotal: invoices.length,
        })
      ) {
        const state = toRuntimeState(loadedCheckpoint);
        resumeIndex = state.nextIndex;
        seedMap = state.map;
        seedMetadata = state.metadata;
        seedFailed = state.failed;
        logger.info(`RESUME: tiep tuc tu invoice index ${resumeIndex}/${invoices.length}`);
      }

      const { map, buyerNames, metadata, failed, stopped, nextIndex } = await collectInvoiceNameMap(client, invoices, {
        concurrency: config.requestConcurrency,
        delayMs: config.requestDelayMs,
        detailEndpoint: activeDetailEndpoint,
        endpointProfile: activeProfile,
        mst: config.username,
        from: cycleFrom,
        to: cycleTo,
        resumeFromIndex: resumeIndex,
        seedMap,
        seedMetadata,
        seedFailed,
        shouldStop: shouldStopFlow,
        onProgress: async (progress) => {
          const checkpoint: CrawlCheckpoint = {
            version: 1,
            from: cycleFrom,
            to: cycleTo,
            out: options.out,
            invoiceType: config.invoiceType,
            endpointProfile: activeProfile,
            nextIndex: progress.nextIndex,
            invoicesTotal: invoices.length,
            byCompositeEntries: Array.from(progress.map.byComposite.entries()),
            byNumberEntries: Array.from(progress.map.byNumberOnly.entries()),
            metadataByCompositeEntries: Array.from(progress.metadata.byComposite.entries()),
            metadataByNumberEntries: Array.from(progress.metadata.byNumberOnly.entries()),
            failedEntries: progress.failed.map((entry) => [entry.key, entry.shdon]),
            updatedAt: Date.now(),
            reason: "phase_progress",
          };
          await writeCheckpoint(config.checkpointPath, checkpoint);
        },
      });

      if (stopped) {
        await writeCheckpoint(config.checkpointPath, {
          version: 1,
          from: cycleFrom,
          to: cycleTo,
          out: options.out,
          invoiceType: config.invoiceType,
          endpointProfile: activeProfile,
          nextIndex,
          invoicesTotal: invoices.length,
          byCompositeEntries: Array.from(map.byComposite.entries()),
          byNumberEntries: Array.from(map.byNumberOnly.entries()),
          metadataByCompositeEntries: Array.from(metadata.byComposite.entries()),
          metadataByNumberEntries: Array.from(metadata.byNumberOnly.entries()),
          failedEntries: failed.map((invoice) => [`${invoice.khhdon.toUpperCase()}|${invoice.shdon}`, invoice.shdon]),
          updatedAt: Date.now(),
          reason: "manual_pause",
        });

        if (config.manualFirst && options.continueSignalFile) {
          logger.warn("Da tam dung flow hien tai theo yeu cau. Browser/session van duoc giu nguyen.");
          logger.info(CONTINUE_READY_MARKER);
          const action = await waitForContinueSignalFile(options.continueSignalFile, retrySignalTimeoutMs);
          if (!action) {
            throw new Error("Het thoi gian cho tin hieu tiep tuc tu UI");
          }
          if (action === "stop-current-flow") {
            continue;
          }

          logger.info("Da nhan tin hieu tiep tuc. Tiep tuc flow tu checkpoint gan nhat...");
          continue;
        }

        throw new Error("Flow da duoc dung theo yeu cau nguoi dung");
      }

      await writeCheckpoint(config.checkpointPath, {
        version: 1,
        from: cycleFrom,
        to: cycleTo,
        out: options.out,
        invoiceType: config.invoiceType,
        endpointProfile: activeProfile,
        nextIndex: invoices.length,
        invoicesTotal: invoices.length,
        byCompositeEntries: Array.from(map.byComposite.entries()),
        byNumberEntries: Array.from(map.byNumberOnly.entries()),
        metadataByCompositeEntries: Array.from(metadata.byComposite.entries()),
        metadataByNumberEntries: Array.from(metadata.byNumberOnly.entries()),
        failedEntries: failed.map((invoice) => [`${invoice.khhdon.toUpperCase()}|${invoice.shdon}`, invoice.shdon]),
        updatedAt: Date.now(),
        reason: "before_persist",
      });

      const workbookBuffer = await downloadInvoiceWorkbook(
        client,
        config.baseUrl,
        cycleFrom,
        cycleTo,
        config.invoiceType,
        activeExportEndpoints,
        activeProfile,
        config.username,
      );

      const merged = await mergeNamesIntoWorkbookWithMetadata(workbookBuffer, map, { metadata, buyerNames });
      await fs.writeFile(options.out, merged.output);

      await clearCheckpoint(config.checkpointPath);

      logger.info(`Dang nhap bang: ${tokenProvider.getLastLoginMeta() ?? "unknown"}`);
      logger.info(`Hoa don co ten hang hoa: ${map.byNumberOnly.size}/${invoices.length}`);
      logger.info(`Dong xlsx da khop ten: ${merged.matchedRows}`);
      logger.info(`Dong xlsx khong khop ten: ${merged.unmatchedRows}`);
      logger.warn(`Hoa don loi khi lay detail: ${failed.length}`);
      logger.info(`Xuat file thanh cong: ${options.out}`);

      if (!config.manualFirst || !options.continueSignalFile) {
        return;
      }

      await waitForNextManualRun();
      break;
    }
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  logger.error(message);
  process.exit(1);
});
