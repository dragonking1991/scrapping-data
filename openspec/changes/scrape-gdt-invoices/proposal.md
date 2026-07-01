## Why

Tổng hợp danh sách hóa đơn điện tử bán ra từ cổng `hoadondientu.gdt.gov.vn` hiện phải làm thủ công: đăng nhập, nhập captcha, tra cứu theo ngày, rồi mở từng hóa đơn để đọc "Tên hàng hóa, dịch vụ". File xlsx xuất từ cổng lại **không có** cột tên hàng hóa/dịch vụ, nên không dùng trực tiếp được. Với hàng trăm hóa đơn mỗi kỳ, việc này tốn nhiều công và dễ sai sót.

## What Changes

- Thêm một **CLI tool (TypeScript/Node)** chạy một lần theo nhu cầu, nhận khoảng ngày (`--from`, `--to`) và đường dẫn xuất (`--out`).
- Điều chỉnh thành **manual-first workflow**: mở Chromium tới `GDT_BASE_URL`, người dùng tự đăng nhập + nhập captcha + chọn filter ngày + bấm tìm kiếm; sau đó người dùng bấm **Lấy thông tin** để bắt đầu crawl tự động.
- **Đăng nhập tự động** vào cổng bằng `cloakbrowser` + `playwright-core`, **giải captcha tự động** (ưu tiên đọc SVG trực tiếp, fallback OCR cục bộ + auto-retry), lấy Bearer token và cache lại để tái dùng.
- **Tra cứu danh sách hóa đơn bán ra** qua API JSON của cổng theo khoảng ngày, gồm phân trang.
- Với mỗi hóa đơn, **gọi API chi tiết** để lấy danh sách dòng hàng hóa/dịch vụ (`hdhhdvu[].ten`) và gộp thành chuỗi "Tên hàng hóa, dịch vụ" theo số hóa đơn.
- **Tự tải file xlsx gốc** qua API export của cổng (cùng filter ngày).
- **Hợp nhất** dữ liệu tên hàng hóa vào file xlsx gốc bằng cách thêm cột "Tên hàng hóa, dịch vụ", khớp theo khóa hóa đơn, rồi ghi ra file đích.
- Khi session hết hạn giữa chừng, hệ thống yêu cầu người dùng đăng nhập lại rồi **resume** tiến trình đang dở.
- Output bổ sung cột metadata crawl: trang/nguồn, thời điểm crawl, số lượng và tình trạng crawl.

## Capabilities

### New Capabilities
- `gdt-authentication`: Đăng nhập tự động vào cổng hoadondientu, giải captcha tự động, lấy và cache Bearer token.
- `invoice-retrieval`: Tra cứu danh sách hóa đơn bán ra theo khoảng ngày (có phân trang) và lấy chi tiết tên hàng hóa/dịch vụ cho từng hóa đơn qua API.
- `invoice-export-merge`: Tải file xlsx gốc từ cổng và hợp nhất thêm cột "Tên hàng hóa, dịch vụ" theo khóa hóa đơn, xuất ra file đích.
- `scrape-cli`: Giao diện dòng lệnh điều phối toàn bộ pipeline với tham số khoảng ngày và đường dẫn xuất.

### Modified Capabilities
<!-- Không có capability hiện hữu nào thay đổi (dự án mới). -->

## Impact

- **Dự án mới** (workspace hiện trống, chỉ có OpenSpec). Tạo cấu trúc Node/TypeScript mới.
- **Dependencies mới**: `cloakbrowser`, `playwright-core`, một HTTP client, thư viện Excel (`exceljs`), thư viện CLI args, và (có thể) thư viện OCR/render SVG cho captcha fallback.
- **Hệ thống ngoài**: phụ thuộc API nội bộ của `hoadondientu.gdt.gov.vn` (endpoint login/captcha, `/sold`, `/detail`, export xlsx). Đây là API không công khai nên có rủi ro thay đổi.
- **Lưu ý vận hành**: chỉ truy cập dữ liệu của chính người dùng (MST của mình), giữ tần suất thấp, có delay/giới hạn concurrency để tôn trọng hệ thống.
