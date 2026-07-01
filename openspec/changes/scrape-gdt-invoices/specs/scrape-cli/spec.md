## ADDED Requirements

### Requirement: Giao diện dòng lệnh điều phối pipeline
Hệ thống SHALL cung cấp một lệnh CLI chạy một lần, nhận khoảng ngày và đường dẫn xuất, rồi điều phối toàn bộ pipeline: đăng nhập → tra cứu → lấy tên hàng hóa → tải xlsx → hợp nhất → ghi file.

#### Scenario: Chạy với tham số đầy đủ
- **WHEN** người dùng chạy CLI với `--from`, `--to` và `--out` hợp lệ
- **THEN** hệ thống thực hiện toàn bộ pipeline và xuất ra file kết quả tại đường dẫn chỉ định

#### Scenario: Thiếu hoặc sai tham số
- **WHEN** thiếu tham số bắt buộc hoặc định dạng ngày không hợp lệ
- **THEN** hệ thống dừng ngay với thông báo lỗi và hướng dẫn cách dùng, không thực hiện pipeline

### Requirement: Cung cấp thông tin đăng nhập an toàn
Hệ thống SHALL nhận thông tin đăng nhập qua biến môi trường hoặc cấu hình, và SHALL KHÔNG ghi mật khẩu hay token ra log.

#### Scenario: Đọc thông tin đăng nhập từ môi trường
- **WHEN** username và password được cung cấp qua biến môi trường/cấu hình
- **THEN** hệ thống dùng chúng để đăng nhập mà không in mật khẩu ra log hay console

### Requirement: Báo cáo tiến trình và lỗi
Hệ thống SHALL hiển thị tiến trình các bước và tổng kết kết quả, gồm số hóa đơn xử lý được và số dòng không khớp được tên.

#### Scenario: Tổng kết sau khi chạy
- **WHEN** pipeline kết thúc
- **THEN** hệ thống in tổng số hóa đơn lấy được, số dòng đã điền tên, số dòng cảnh báo, và đường dẫn file kết quả
