import sharp from "sharp";
import { createWorker } from "tesseract.js";

function normalizeCaptcha(raw: string): string {
  return raw.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

function maybeExtractFromSvgText(svg: string): string | null {
  const matches = Array.from(svg.matchAll(/<text[^>]*>([^<]+)<\/text>/gi));
  if (matches.length === 0) {
    return null;
  }

  const merged = normalizeCaptcha(matches.map((m) => m[1] ?? "").join(""));
  if (merged.length >= 4) {
    return merged;
  }

  return null;
}

async function buildVariants(rawBuffer: Buffer): Promise<Buffer[]> {
  const thresholds = [115, 135, 155, 175, 195];
  const variants: Buffer[] = [];

  for (const t of thresholds) {
    const normal = await sharp(rawBuffer)
      .resize({ width: 360 })
      .grayscale()
      .normalize()
      .threshold(t)
      .png()
      .toBuffer();
    variants.push(normal);

    const inverted = await sharp(normal)
      .negate()
      .png()
      .toBuffer();
    variants.push(inverted);
  }

  return variants;
}

async function ocrFromBuffer(rawBuffer: Buffer): Promise<string | null> {
  const worker = await createWorker("eng");

  try {
    await worker.setParameters({
      tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
      preserve_interword_spaces: "0",
    });

    const variants = await buildVariants(rawBuffer);
    const candidates: string[] = [];

    for (const image of variants) {
      const { data } = await worker.recognize(image);
      const candidate = normalizeCaptcha(data.text ?? "");
      if (candidate.length >= 4) {
        candidates.push(candidate);
      }
    }

    const exact6 = candidates.find((c) => c.length === 6);
    if (exact6) {
      return exact6;
    }

    if (candidates.length > 0) {
      return candidates.sort((a, b) => b.length - a.length)[0] ?? null;
    }

    return null;
  } finally {
    await worker.terminate();
  }
}

async function ocrSvg(svg: string): Promise<string | null> {
  const raster = await sharp(Buffer.from(svg), { density: 240 })
    .resize({ width: 320 })
    .grayscale()
    .normalize()
    .threshold(155)
    .png()
    .toBuffer();
  return ocrFromBuffer(raster);
}

function decodeDataUri(input: string): Buffer | null {
  const matched = input.match(/^data:image\/[^;]+;base64,(.+)$/i);
  if (!matched || !matched[1]) {
    return null;
  }

  try {
    return Buffer.from(matched[1], "base64");
  } catch {
    return null;
  }
}

export async function solveCaptcha(captchaPayload: string): Promise<{ text: string; method: "svg-text" | "ocr" | "unknown" }> {
  const trimmed = captchaPayload.trim();

  if (trimmed.startsWith("<svg") || trimmed.startsWith("<?xml") || trimmed.includes("<svg")) {
    const fromSvg = maybeExtractFromSvgText(trimmed);
    if (fromSvg) {
      return { text: fromSvg, method: "svg-text" };
    }

    const fromSvgOcr = await ocrSvg(trimmed);
    if (fromSvgOcr) {
      return { text: fromSvgOcr, method: "ocr" };
    }
  }

  const fromDataUri = decodeDataUri(trimmed);
  if (fromDataUri) {
    const fromRasterOcr = await ocrFromBuffer(fromDataUri);
    if (fromRasterOcr) {
      return { text: fromRasterOcr, method: "ocr" };
    }
  }

  return { text: "", method: "unknown" };
}
