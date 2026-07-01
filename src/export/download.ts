import { sanitizeBaseUrl } from "../shared/config.js";
import { toApiDateExclusiveEnd, toApiDateStart } from "../shared/date.js";
import { type InvoiceType } from "../shared/types.js";
import { type ApiClient } from "../api/client.js";

function looksLikeXlsx(buffer: Buffer): boolean {
  return buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b;
}

export async function downloadInvoiceWorkbook(
  client: ApiClient,
  baseUrl: string,
  from: string,
  to: string,
  invoiceType: InvoiceType,
  endpoints: string[],
  endpointProfile: "standard" | "third-party",
  mst: string,
): Promise<Buffer> {
  const errors: string[] = [];

  for (const endpoint of endpoints) {
    const url = sanitizeBaseUrl(baseUrl, endpoint).replace(baseUrl, "");

    try {
      const paramStrategies: Array<Record<string, string>> =
        endpointProfile === "third-party"
          ? [
              { mst, tngay: from, dngay: to },
              { tngay: from, dngay: to },
            ]
          : [
              { search: `tdlap=ge=${toApiDateStart(from)};tdlap=le=${toApiDateExclusiveEnd(to)}`, type: invoiceType },
              { search: `tdlap=ge=${toApiDateStart(from)};tdlap=le=${toApiDateExclusiveEnd(to)}` },
              { tngay: from, dngay: to, type: invoiceType },
              { tngay: from, dngay: to },
              { from, to, type: invoiceType },
              { from, to },
            ];

      let found = false;
      for (let pi = 0; pi < paramStrategies.length; pi += 1) {
        if (pi > 0) {
          await new Promise((r) => setTimeout(r, 500));
        }

        const params = paramStrategies[pi]!;
        try {
          const buffer = await client.getBuffer(url, { params });
          if (looksLikeXlsx(buffer)) {
            return buffer;
          }

          const summary = JSON.stringify(params).slice(0, 100);
          errors.push(`${endpoint} param${pi + 1}: not xlsx (${buffer.length} bytes) ${summary}`);
        } catch (error) {
          errors.push(`${endpoint} param${pi + 1}: ${(error as Error).message.slice(0, 120)}`);
          continue;
        }

        found = true;
      }

      if (!found) {
        errors.push(`${endpoint}: all ${paramStrategies.length} param strategies failed`);
      }
    } catch (error) {
      errors.push(`${endpoint}: ${(error as Error).message}`);
    }
  }

  throw new Error(`Khong the tai file xlsx tu cac endpoint da cau hinh. Chi tiet: ${errors.join(" | ")}`);
}
