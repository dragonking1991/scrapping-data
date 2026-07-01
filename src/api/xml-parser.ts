import { promises as fs } from "node:fs";
import path from "node:path";
import { parseStringPromise } from "xml2js";
import { logger } from "../shared/logger.js";
import type { InvoiceHeader } from "../shared/types.js";

export interface XmlInvoice {
  MCCGOP?: string[];
  KHHDON?: string[];
  KHMSHDON?: string[];
  SHDON?: string[];
  MSTCQT?: string[];
  MSTCQTDH?: string[];
  TCTBAO?: string[];
}

function normalize(input: unknown): string {
  if (input == null) {
    return "";
  }
  if (Array.isArray(input)) {
    return String(input[0] ?? "").trim();
  }
  return String(input).trim();
}

export async function parseXmlInvoices(xmlDir: string): Promise<InvoiceHeader[]> {
  const invoices: InvoiceHeader[] = [];
  const errors: string[] = [];

  try {
    const files = await fs.readdir(xmlDir);
    const xmlFiles = files.filter((f) => f.endsWith(".xml"));

    logger.info(`[XML] Found ${xmlFiles.length} XML files in ${xmlDir}`);

    for (const file of xmlFiles) {
      const filepath = path.join(xmlDir, file);
      try {
        const content = await fs.readFile(filepath, "utf8");
        const parsed = await parseStringPromise(content, {
          explicitArray: true,
          mergeAttrs: true,
        });

        // GDT XML structure: root → invoices
        const root = parsed.Invoices || parsed.invoices || parsed.root;
        if (!root) {
          logger.warn(`[XML] ${file}: No root element found`);
          continue;
        }

        const items = root.Invoice || root.invoice || [];
        logger.info(`[XML] ${file}: Extracted ${items.length} invoices`);

        for (const item of items) {
          const xml = item as XmlInvoice;
          const header: InvoiceHeader = {
            nbmst: normalize(xml.MCCGOP || xml.MSTCQT),
            khhdon: normalize(xml.KHHDON),
            khmshdon: normalize(xml.KHMSHDON),
            shdon: normalize(xml.SHDON),
          };

          if (header.shdon) {
            invoices.push(header);
          }
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        errors.push(`${file}: ${msg.slice(0, 100)}`);
        logger.warn(`[XML] ${file}: parse error: ${msg.slice(0, 150)}`);
      }
    }

    if (errors.length > 0) {
      logger.warn(`[XML] Parse errors: ${errors.join(" | ")}`);
    }

    logger.info(`[XML] Total invoices parsed: ${invoices.length} from ${xmlFiles.length} files`);
    return invoices;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error(`[XML] Failed to read XML directory: ${msg}`);
    throw new Error(`Khong the doc folder XML: ${msg}`);
  }
}

export async function findXmlDownloadDir(): Promise<string> {
  const home = process.env.HOME || "";
  const candidates = [
    path.join(home, "Downloads"),
    path.join(home, "Desktop"),
    path.join(process.cwd(), "downloads"),
    path.join(process.cwd(), ".downloads"),
  ];

  for (const dir of candidates) {
    try {
      const stat = await fs.stat(dir);
      if (stat.isDirectory()) {
        return dir;
      }
    } catch {
      // Directory doesn't exist, skip
    }
  }

  throw new Error("Khong tim thay Downloads folder");
}
