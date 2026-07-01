## ADDED Requirements

### Requirement: Đăng nhập tự động vào cổng
Hệ thống SHALL đăng nhập vào `hoadondientu.gdt.gov.vn` bằng username và password do người dùng cung cấp, sử dụng `cloakbrowser` + `playwright-core`, và lấy về Bearer token để dùng cho các API tiếp theo.

#### Scenario: Đăng nhập thành công
- **WHEN** người dùng cung cấp username, password hợp lệ và captcha được giải đúng
- **THEN** hệ thống nhận được Bearer token và lưu lại để gọi các API tra cứu

#### Scenario: Sai thông tin đăng nhập
- **WHEN** username hoặc password không hợp lệ
- **THEN** hệ thống dừng pipeline và báo lỗi đăng nhập rõ ràng, không thử lại vô hạn

### Requirement: Giải captcha tự động
Hệ thống SHALL giải captcha tự động hoàn toàn mà không cần người dùng nhập tay, ưu tiên đọc trực tiếp nội dung captcha SVG, và fallback sang OCR cục bộ khi cần.

#### Scenario: Đọc captcha từ SVG
- **WHEN** endpoint captcha trả về SVG chứa được nội dung văn bản đọc được
- **THEN** hệ thống trích xuất chuỗi captcha trực tiếp từ SVG mà không cần OCR

#### Scenario: Fallback OCR và tự thử lại
- **WHEN** không đọc được trực tiếp từ SVG hoặc kết quả giải captcha bị server từ chối
- **THEN** hệ thống tải captcha mới, giải lại bằng OCR và thử đăng nhập lại tối đa N lần trước khi báo lỗi

### Requirement: Cache và tái sử dụng token
Hệ thống SHALL cache Bearer token kèm thời hạn để các lần chạy sau trong thời hạn token không phải giải captcha lại, và SHALL cung cấp tùy chọn ép đăng nhập lại.

#### Scenario: Tái sử dụng token còn hạn
- **WHEN** tồn tại token đã cache và chưa hết hạn
- **THEN** hệ thống dùng lại token đó và bỏ qua bước đăng nhập/captcha

#### Scenario: Ép đăng nhập lại
- **WHEN** người dùng truyền cờ ép đăng nhập lại hoặc token đã hết hạn
- **THEN** hệ thống thực hiện đăng nhập mới và cập nhật lại cache token

#### Scenario: Token hết hạn giữa chừng
- **WHEN** một API trả về lỗi 401 trong lúc pipeline đang chạy
- **THEN** hệ thống tự đăng nhập lại một lần rồi tiếp tục thực hiện request đang dở
