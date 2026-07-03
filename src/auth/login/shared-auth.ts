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

export { extractTokenPayload, readJwtExp };
