import { promises as fs } from "node:fs";
import path from "node:path";
import { type TokenCacheData } from "../shared/types.js";

export async function readTokenCache(filePath: string): Promise<TokenCacheData | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const data = JSON.parse(raw) as Partial<TokenCacheData>;
    if (!data.token || !data.expiresAt) {
      return null;
    }

    if (Date.now() >= data.expiresAt) {
      return null;
    }

    return {
      token: data.token,
      expiresAt: data.expiresAt,
    };
  } catch {
    return null;
  }
}

export async function writeTokenCache(filePath: string, token: string, expiresAt: number): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const body = JSON.stringify({ token, expiresAt }, null, 2);
  await fs.writeFile(filePath, body, { mode: 0o600 });
}

export async function clearTokenCache(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch {
    // nothing to do
  }
}
