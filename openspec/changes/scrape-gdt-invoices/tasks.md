## 1. Khởi tạo dự án

- [x] 1.1 Khởi tạo Node + TypeScript (package.json, tsconfig, build/run scripts)
- [x] 1.2 Thêm dependencies: `cloakbrowser`, `playwright-core`, HTTP client, `exceljs`, thư viện CLI args, và lib OCR/render SVG cho captcha fallback
- [x] 1.3 Tạo khung thư mục `src/` theo design (auth, api, export, cli)
- [x] 1.4 Thiết lập đọc cấu hình/biến môi trường cho username/password, không log secret

## 2. Verify API (spike trước khi code chính)

- [x] 2.1 Xác minh response endpoint captcha (SVG có text hay raster) → chốt nhánh giải captcha
- [x] 2.2 Xác minh tham số và response của `/sold` (filter ngày, phân trang, có line items không)
- [x] 2.3 Xác minh response `/detail` và field `hdhhdvu[].ten`
- [x] 2.4 Xác minh endpoint export xlsx và các cột trong file gốc (đặc biệt ký hiệu + số hóa đơn)

## 3. Capability: gdt-authentication

- [x] 3.1 Mở trang đăng nhập bằng cloakbrowser + playwright-core, điền user/pass
- [x] 3.2 Lấy captcha và giải tự động (đọc SVG trực tiếp; fallback OCR cục bộ)
- [x] 3.3 Vòng lặp auto-retry: captcha sai → tải captcha mới → thử lại tối đa N lần
- [x] 3.4 Submit đăng nhập, trích xuất Bearer token từ response/network
- [x] 3.5 Cache token + thời hạn ra file (quyền hạn chế); cờ ép đăng nhập lại
- [x] 3.6 Xử lý sai thông tin đăng nhập: dừng có thông báo, không thử vô hạn

## 4. Capability: invoice-retrieval

- [x] 4.1 HTTP client gắn header Authorization + retry/backoff; tự relogin khi gặp 401
- [x] 4.2 `listSold(from, to)`: build filter ngày và gọi API danh sách hóa đơn bán ra
- [x] 4.3 Phân trang đầy đủ, gộp tất cả trang thành một danh sách
- [x] 4.4 `getDetail(invoice)`: gọi API chi tiết, trích `hdhhdvu[].ten`, gộp nhiều dòng thành chuỗi
- [x] 4.5 Giới hạn concurrency + delay khi gọi `/detail` hàng loạt
- [x] 4.6 Xử lý lỗi tạm thời từng hóa đơn: retry, nếu vẫn lỗi đánh dấu thiếu tên, không dừng pipeline
- [x] 4.7 Tạo map { khóa hóa đơn → "Tên hàng hóa, dịch vụ" }

## 5. Capability: invoice-export-merge

- [x] 5.1 `downloadXlsx(from, to)`: tải file xlsx gốc qua API export
- [x] 5.2 Đọc workbook bằng exceljs, xác định cột khóa (ký hiệu + số hóa đơn)
- [x] 5.3 Thêm cột "Tên hàng hóa, dịch vụ", điền theo khóa tổ hợp; fallback chỉ số hóa đơn
- [x] 5.4 Dòng không khớp: để trống + ghi cảnh báo, giữ nguyên cột gốc
- [x] 5.5 Ghi workbook ra đường dẫn `--out`

## 6. Capability: scrape-cli

- [x] 6.1 Parse args `--from`, `--to`, `--out` (+ cờ tùy chọn: relogin/no-cache, type)
- [x] 6.2 Validate tham số và định dạng ngày; in usage khi sai
- [x] 6.3 Điều phối pipeline: login → list → detail → download → merge → write
- [x] 6.4 Báo cáo tiến trình + tổng kết (số HĐ, số dòng điền tên, số cảnh báo, đường dẫn file)
- [x] 6.5 Thêm UI web dùng Tailwind để người dùng chọn/nhập from, to, out (fallback về CLI args nếu đã truyền)

## 7. Kiểm thử & hoàn thiện

- [ ] 7.1 Chạy thử end-to-end với một khoảng ngày thật, đối chiếu file kết quả
- [ ] 7.2 Kiểm tra trường hợp nhiều trang và hóa đơn nhiều dòng hàng hóa
- [ ] 7.3 Kiểm tra trường hợp không có hóa đơn và dòng không khớp được tên
- [x] 7.4 Viết README ngắn: cách cài, cấu hình secret, cách chạy CLI

## 8. Manual-first + Resume + Metadata (đã chốt trong explore)

Tham chiếu checklist adapter theo từng file:
- [appendix/compatibility-checklist.md](appendix/compatibility-checklist.md)

- [x] 8.1 Đổi UI sang luồng manual-first: mở Chromium và chờ người dùng tự login + tự filter + tự bấm tìm kiếm
- [x] 8.2 Thêm nút `Lấy thông tin` để bắt đầu crawl sau khi người dùng xác nhận đã có list kết quả
- [x] 8.3 Triển khai API-first collector dựa trên session đang mở (không tạo lại session độc lập)
- [x] 8.4 Thêm checkpoint crawl để có thể resume giữa chừng
- [x] 8.5 Khi session hết hạn, hiển thị trạng thái yêu cầu login lại và hỗ trợ resume từ checkpoint
- [x] 8.6 Bổ sung cột metadata trong output: nguồn dữ liệu, thời điểm crawl, trang, số lượng dòng hàng hóa, tình trạng crawl
- [ ] 8.7 Kiểm thử luồng resume: hết hạn session giữa chừng -> login lại -> tiếp tục thành công
