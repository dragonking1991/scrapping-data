/**
 * Playwright debug test: reproduce the invoice-modal DOM and run the real
 * `extractInvoiceDetail` logic to find out why item names may come back empty.
 *
 * Run with:  npx tsx src/debug/test-modal-extract.ts
 *
 * It launches a headless browser, injects a fixture that mirrors the GDT
 * "Xem hóa đơn" modal structure (table.res-tb with a "Tên hàng hóa, dịch vụ"
 * header), then prints the structured result.
 */
import { launch } from "cloakbrowser";
import type { Browser } from "playwright-core";

import { extractInvoiceDetail, installEvalShim } from "../auth/login.js";

// Fixture mirrors the real modal DOM captured from the GDT site (see screenshot):
// .ant-modal-body > ... > .content-info > ul.list-fill-out + table.res-tb
const MODAL_FIXTURE = `
<div class="ant-modal-root">
  <div class="ant-modal-wrap">
    <div class="ant-modal">
      <div class="ant-modal-content">
        <button type="button" aria-label="Close" class="ant-modal-close"></button>
        <div class="ant-modal-body">
          <div class="ant-row-flex ant-row-flex-center">
            <div class="ant-col ant-col-24">
              <div class="styles__ViewInvoiceWrap-sc-v1ei30-0 gLzYdG">
                <div class="wrapper-content-vi printSection">
                  <div class="heading-content">
                    <div>Mẫu số 1</div>
                    <div>Ký hiệu: C26TBV</div>
                    <div>Số: 1495</div>
                    <h3>HOÁ ĐƠN GIÁ TRỊ GIA TĂNG</h3>
                    <div>Ngày 01 tháng 07 năm 2026</div>
                  </div>
                  <div class="vip-divide"></div>
                  <div class="content-info">
                    <ul class="list-fill-out">
                      <li>Tên người bán: CÔNG TY TNHH ABC</li>
                      <li>Mã số thuế: 0310518384</li>
                      <li>Địa chỉ: 63/4B Ấp Trung Lân 2, Xã Bà Điểm, TP Hồ Chí Minh</li>
                      <li>Số tài khoản:</li>
                      <li>Hình thức thanh toán: TM/CK</li>
                      <li>Đơn vị tiền tệ: VND</li>
                      <li>Tên người mua: CÔNG TY TNHH XÂY DỰNG VÀ NỘI THẤT KHANG HY</li>
                      <li>Mã số thuế: 0316241097</li>
                    </ul>
                    <table class="res-tb">
                      <thead style="text-align: center;">
                        <tr>
                          <th class="tb-stt">STT</th>
                          <th class="tb-stt">Tính chất</th>
                          <th class="tb-stt">Loại hàng hoá đặc trưng</th>
                          <th class="tb-thh">Tên hàng hóa, dịch vụ</th>
                          <th class="tb-dvt">Đơn vị tính</th>
                          <th class="tb-sl">Số lượng</th>
                          <th class="tb-dg">Đơn giá</th>
                          <th class="tb-dg">Chiết khấu</th>
                          <th class="tb-ts">Thuế suất</th>
                          <th class="tb-ttct">Thành tiền chưa có thuế GTGT</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr>
                          <td class="tx-center">1</td>
                          <td>Hàng hóa, dịch vụ</td>
                          <td style="max-width: 200px;"></td>
                          <td>Học phí đào tạo lái xe</td>
                          <td>HV</td>
                          <td class="tx-center">1</td>
                          <td class="tx-center">16.000.000</td>
                          <td class="tx-center">0</td>
                          <td class="tx-center">KCT</td>
                          <td class="tx-center">16.000.000</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>
`;

async function main(): Promise<void> {
  const browser: Browser = await launch({ headless: true });
  try {
    const page = await browser.newPage();
    await installEvalShim(page);
    await page.goto("about:blank", { waitUntil: "domcontentloaded" });
    await page.evaluate((html: string) => {
      document.body.innerHTML = html;
    }, MODAL_FIXTURE);

    // Diagnostics: is the DOM actually present and findable?
    const probe = await page.evaluate(() => {
      const modal = document.querySelector(".ant-modal-body");
      const cells = modal ? Array.from(modal.querySelectorAll("th, td")) : [];
      const norm = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();
      const header = cells.find((c) => {
        const t = norm(c.textContent || "");
        return t.includes("tên hàng") || t.includes("ten hang");
      });
      return {
        hasModal: !!modal,
        cellCount: cells.length,
        headerText: header ? (header.textContent || "").trim() : null,
      };
    });
    console.log("PROBE:", JSON.stringify(probe, null, 2));

    const detail = await extractInvoiceDetail(page);

    console.log("─".repeat(60));
    console.log("itemNames:", JSON.stringify(detail.itemNames, null, 2));
    console.log("lineItems:", JSON.stringify(detail.lineItems, null, 2));
    console.log("info:", JSON.stringify(detail.info, null, 2));
    console.log("─".repeat(60));

    if (detail.itemNames.length === 0) {
      console.error("❌ FAIL: khong doc duoc 'Ten hang hoa, dich vu' tu fixture chuan.");
      process.exitCode = 1;
    } else {
      console.log(`✅ OK: doc duoc ${detail.itemNames.length} muc.`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
