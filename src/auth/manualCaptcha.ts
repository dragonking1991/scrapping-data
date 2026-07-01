import { createInterface } from "node:readline";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "node:child_process";

function rl(prompt: string): Promise<string> {
  const iface = createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: true,
  });

  return new Promise((resolve) => {
    iface.question(prompt, (answer) => {
      iface.close();
      resolve(answer.trim().toUpperCase().replace(/[^A-Z0-9]/g, ""));
    });
  });
}

function openFile(filePath: string): void {
  const cmd =
    process.platform === "darwin"
      ? `open "${filePath}"`
      : process.platform === "win32"
        ? `start "" "${filePath}"`
        : `xdg-open "${filePath}"`;
  exec(cmd, () => undefined);
}

export async function promptCaptchaManually(captchaPayload: string, attempt: number): Promise<string> {
  let imgPath: string | null = null;

  try {
    if (captchaPayload.startsWith("<svg") || captchaPayload.includes("<svg")) {
      const { default: sharp } = await import("sharp");
      const png = await sharp(Buffer.from(captchaPayload), { density: 200 })
        .resize({ width: 360 })
        .png()
        .toBuffer();
      imgPath = join(tmpdir(), `gdt-captcha-${Date.now()}.png`);
      await fs.writeFile(imgPath, png);
    } else if (captchaPayload.startsWith("data:image/")) {
      const match = captchaPayload.match(/^data:image\/([^;]+);base64,(.+)$/);
      if (match) {
        const ext = match[1] === "svg+xml" ? "png" : (match[1] ?? "png");
        const buf = Buffer.from(match[2] ?? "", "base64");
        if (match[1] === "svg+xml") {
          const { default: sharp } = await import("sharp");
          const png = await sharp(buf, { density: 200 }).resize({ width: 360 }).png().toBuffer();
          imgPath = join(tmpdir(), `gdt-captcha-${Date.now()}.png`);
          await fs.writeFile(imgPath, png);
        } else {
          imgPath = join(tmpdir(), `gdt-captcha-${Date.now()}.${ext}`);
          await fs.writeFile(imgPath, buf);
        }
      }
    }

    if (imgPath) {
      openFile(imgPath);
      process.stderr.write(`\n[CAPTCHA] Auto-solve that bai (lan ${attempt}). Da mo anh captcha: ${imgPath}\n`);
    } else {
      process.stderr.write(`\n[CAPTCHA] Auto-solve that bai (lan ${attempt}). Khong the hien thi anh.\n`);
    }
  } catch {
    process.stderr.write(`\n[CAPTCHA] Auto-solve that bai (lan ${attempt}). Khong the hien thi anh.\n`);
  }

  const answer = await rl("[CAPTCHA] Nhap ma captcha (Enter de bo qua): ");

  if (imgPath) {
    fs.unlink(imgPath).catch(() => undefined);
  }

  return answer;
}
