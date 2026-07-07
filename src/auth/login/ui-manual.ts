import type { Page } from "playwright-core";
import type { InvoiceDirection, ManualFilterContext } from "../../shared/types.js";
import { CAPTCHA_IMAGE_SELECTORS, MANUAL_READY_SELECTORS } from "./shared.js";

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
    const candidates = page.locator(selector);
    const count = await candidates.count();
    for (let i = 0; i < count; i += 1) {
      const locator = candidates.nth(i);
      if (!(await locator.isVisible().catch(() => false))) {
        continue;
      }

      const disabled = await locator
        .evaluate((el) => {
          const node = el as HTMLElement;
          const asBtn = node as HTMLButtonElement;
          if (asBtn.disabled) {
            return true;
          }
          if (node.getAttribute("aria-disabled") === "true") {
            return true;
          }
          const cls = (node.className || "").toString().toLowerCase();
          return cls.includes("disabled");
        })
        .catch(() => true);
      if (disabled) {
        continue;
      }

      try {
        await locator.click({ timeout: 1500 });
        return true;
      } catch {
        continue;
      }
    }
  }
  return false;
}

export {
  extractCaptchaPayload,
  inferTokenFromStorage,
  classifyErrorMessage,
  readVisibleError,
  hasManualSearchResults,
  extractManualFilterContext,
  clickFirstAvailable,
};

/**
 * Emit a structured interaction event that the UI can parse and render on a
 * chronological debug timeline. Serialized as a single JSON line prefixed with
 * a stable tag so the UI can pick it out of the log stream.
 */
