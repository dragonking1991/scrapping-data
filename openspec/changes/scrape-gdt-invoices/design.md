## Context

Cổng `hoadondientu.gdt.gov.vn` là SPA gọi API JSON nội bộ. Quan sát tab Network (screenshot) cho thấy:

- Đăng nhập cần username + password + **captcha ảnh SVG** (ví dụ "QXKHRZ", 6 ký tự A-Z/0-9), trả về Bearer token (JWT).
- Tra cứu danh sách hóa đơn bán ra: `GET .../query/invoices/sold?sort=tdlap:desc&size=50&search=tdlap=ge=<from>;tdlap=le=<to>` → JSON danh sách header hóa đơn (số HĐ, ký hiệu, tổng tiền...).
- Chi tiết hóa đơn: `GET .../query/invoices/detail?nbmst=<mst>&khhdon=<khhdon>&shdon=<shdon>&khmshdon=<n>` → JSON có mảng `hdhhdvu` với mỗi dòng có field `ten` = tên hàng hóa/dịch vụ.
- Xuất xlsx: `GET .../query/invoices/export-xml` (và nút "Xuất hóa đơn" xuất xlsx) → file gốc **không có** cột tên hàng hóa/dịch vụ.

Dữ liệu đầy đủ nằm trong API JSON; trình duyệt chỉ cần cho bước login/captcha. Workspace hiện trống (mới `openspec init`).

## Goals / Non-Goals

**Goals:**
- CLI một lần: `scrape --from <dd/mm/yyyy> --to <dd/mm/yyyy> --out <path.xlsx>`.
- Đăng nhập + giải captcha **tự động hoàn toàn**, lấy & cache token.
- Lấy danh sách hóa đơn theo ngày (phân trang đầy đủ) và tên hàng hóa/dịch vụ mỗi HĐ qua API JSON.
- Tự tải xlsx gốc và thêm cột "Tên hàng hóa, dịch vụ" khớp theo khóa hóa đơn.

**Non-Goals:**
- Không làm UI, không scheduler/cron, không service chạy nền.
- Không hỗ trợ tra cứu hóa đơn mua vào trong phạm vi đầu (chỉ "bán ra").
- Không dùng dịch vụ giải captcha trả phí của bên thứ ba (giữ tự chủ, miễn phí).
- Không lưu trữ/đồng bộ dữ liệu vào DB.

## Decisions

### D1: TypeScript/Node thay vì Python
`cloakbrowser` và `playwright-core` là package Node và người dùng đã chỉ định. Thống nhất một runtime, tránh chạy 2 môi trường. Excel xử lý bằng `exceljs` đủ mạnh cho việc thêm 1 cột. *Alternative:* Python + Playwright-Python (mất khả năng dùng cloakbrowser) → loại.

### D2: Lấy tên hàng hóa qua API `/detail` (Option 2), không qua "Xuất XML" (Option 1)
`/detail` trả thẳng `hdhhdvu[].ten` dạng JSON, nhanh và ổn định; không sinh file rác, không phụ thuộc DOM/dialog/thư mục tải. Option 1 (click → tải .xml → parse namespace) chậm và dễ vỡ với hàng trăm HĐ. *Giữ Option 1 làm fallback tài liệu nếu `/detail` bị chặn.*

### D3: Browser chỉ dùng cho login/captcha; phần còn lại là HTTP thuần
Sau khi có Bearer token, mọi truy vấn (`/sold`, `/detail`, export) chạy bằng HTTP client kèm header `Authorization`. Giảm phụ thuộc UI, tăng tốc và độ ổn định.

### D4: Chiến lược captcha — đọc SVG trực tiếp, fallback OCR + auto-retry
- **Ưu tiên (Hướng A):** nếu endpoint captcha trả SVG có chứa text (`<text>`/thứ tự path), đọc thẳng — không cần OCR.
- **Fallback (Hướng B+D):** render SVG → ảnh → tiền xử lý → OCR cục bộ (`tesseract.js`/mô hình nhẹ); nếu login báo sai captcha thì tải captcha mới và thử lại, tối đa N lần (captcha tải lại miễn phí nên retry rất hiệu quả).
Quyết định nhánh cụ thể sẽ chốt sau khi verify response thật của endpoint captcha trong lúc implement.

### D5: Cache token
Lưu token + thời hạn ra file tạm (vd `.token.json`, có quyền hạn chế). Lần chạy sau trong thời hạn JWT thì bỏ qua bước captcha. Có cờ `--no-cache`/`--relogin` để ép đăng nhập lại.

### D6: Khóa ghép Excel ↔ tên hàng hóa
Dùng khóa tổ hợp `(khhdon, shdon)` (ký hiệu + số hóa đơn) thay vì chỉ `shdon`, để tránh trùng số giữa các ký hiệu. Nếu file xlsx gốc thiếu cột ký hiệu thì fallback về `shdon`. Xác nhận cột thật khi implement.

### D7: Gọi `/detail` có kiểm soát tải
Giới hạn concurrency (vd 3-5) + delay nhẹ giữa các request để tránh bị rate-limit/chặn IP. Có retry/backoff cho lỗi tạm thời.

### D8: Cấu trúc module
```
src/
  cli.ts            # parse args, điều phối pipeline
  auth/login.ts     # cloakbrowser + playwright-core, lấy token
  auth/captcha.ts   # giải captcha (SVG/OCR + retry)
  auth/tokenCache.ts# đọc/ghi cache token
  api/client.ts     # HTTP client + Authorization + retry
  api/invoices.ts   # listSold (phân trang) + getDetail
  export/download.ts# tải xlsx gốc
  export/merge.ts   # thêm cột "Tên hàng hóa, dịch vụ"
```

### D9: Manual-first flow, user-triggered collect
- App khởi động chỉ mở Chromium tới `GDT_BASE_URL` và chờ người dùng thao tác thủ công (đăng nhập, captcha, chọn ngày, bấm tìm kiếm).
- Hệ thống chỉ bắt đầu crawl khi người dùng bấm nút **Lấy thông tin**.
- Tránh tự động điều hướng/login để giảm rủi ro sai selector/captcha/role.

### D10: Session expiry handling = explicit re-login + resume
- Nếu phát hiện session hết hạn trong lúc crawl (401/403 đặc trưng), dừng an toàn ở trạng thái có checkpoint.
- UI yêu cầu người dùng đăng nhập lại trên cùng browser session.
- Sau khi xác nhận session mới hợp lệ, tiến trình resume từ checkpoint gần nhất, không chạy lại toàn bộ từ đầu.

### D11: Ưu tiên API-first
- Khi user đã thao tác xong filter trên UI, collector ưu tiên lấy dữ liệu bằng API trong cùng session (cookie/token thực tế) để đạt tốc độ cao.
- DOM scraping chỉ là fallback nếu endpoint đổi hoặc API không khả dụng.

### D12: Bổ sung metadata trong output
- File kết quả thêm nhóm cột metadata crawl, tối thiểu gồm:
  - `Nguon du lieu` (api/dom/fallback)
  - `Thoi diem crawl` (ISO timestamp)
  - `Trang` (page index hoặc marker)
  - `So luong dong hang hoa` (count)
  - `Tinh trang crawl` (success/partial/failed)

## Risks / Trade-offs

- **API không công khai có thể đổi** → Tách lớp `api/` riêng, log rõ response để dễ sửa; giữ Option 1 (XML) làm phương án dự phòng.
- **Captcha tự động không chắc 100%** → Auto-retry nhiều lần; nếu nhánh SVG-đọc-thẳng khả dụng thì độ tin cậy gần như tuyệt đối.
- **Bị rate-limit khi gọi `/detail` hàng trăm lần** → Giới hạn concurrency + delay + backoff.
- **Khóa ghép sai làm lệch cột** → Ưu tiên khóa tổ hợp `(khhdon, shdon)`; cảnh báo nếu có HĐ trong xlsx không khớp được tên.
- **Hai loại hóa đơn (HĐ điện tử vs HĐ máy tính tiền `C26TBV`)** có thể khác endpoint → Cờ `--type` hoặc xử lý cả hai; verify khi implement.
- **Token hết hạn giữa chừng** → Bắt lỗi 401, tự đăng nhập lại một lần rồi tiếp tục.

## Open Questions

- Response thật của endpoint captcha là SVG có text hay path/raster? (quyết định nhánh D4)
- File xlsx gốc có sẵn cột "Ký hiệu hóa đơn" và "Số hóa đơn" để làm khóa ghép không?
- `/sold` có trả luôn line items không (nếu có thì khỏi gọi `/detail`)?
- Endpoint chính xác cho tab "Hóa đơn có mã khởi tạo từ máy tính tiền".

## Appendix

- Interface spec cho runtime manual-first: [appendix/interface-spec.md](appendix/interface-spec.md)
- Compatibility checklist file-by-file: [appendix/compatibility-checklist.md](appendix/compatibility-checklist.md)
