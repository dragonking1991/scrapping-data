## ADDED Requirements

### Requirement: Tải file xlsx gốc từ cổng
Hệ thống SHALL tự tải file xlsx danh sách hóa đơn từ API export của cổng, sử dụng cùng filter khoảng ngày với bước tra cứu.

#### Scenario: Tải xlsx thành công
- **WHEN** đã có token và khoảng ngày hợp lệ
- **THEN** hệ thống tải về workbook xlsx gốc chứa các cột thông tin hóa đơn do cổng cung cấp

### Requirement: Thêm cột "Tên hàng hóa, dịch vụ" theo khóa hóa đơn
Hệ thống SHALL hợp nhất dữ liệu tên hàng hóa/dịch vụ vào workbook gốc bằng cách thêm một cột "Tên hàng hóa, dịch vụ", khớp mỗi dòng theo khóa hóa đơn.

#### Scenario: Khớp theo khóa hóa đơn
- **WHEN** một dòng trong xlsx gốc có khóa hóa đơn trùng với một hóa đơn đã lấy được tên hàng hóa
- **THEN** hệ thống điền tên hàng hóa/dịch vụ tương ứng vào cột mới của dòng đó

#### Scenario: Ưu tiên khóa tổ hợp
- **WHEN** xlsx gốc có cả ký hiệu hóa đơn và số hóa đơn
- **THEN** hệ thống ghép theo khóa tổ hợp (ký hiệu + số hóa đơn) để tránh trùng số giữa các ký hiệu

#### Scenario: Dòng không khớp được tên
- **WHEN** một dòng trong xlsx không tìm được hóa đơn tương ứng để lấy tên
- **THEN** hệ thống để trống cột mới cho dòng đó và ghi cảnh báo, không làm hỏng file

### Requirement: Ghi file đích
Hệ thống SHALL ghi workbook đã bổ sung cột ra đường dẫn đích do người dùng chỉ định, giữ nguyên các cột gốc.

#### Scenario: Xuất file kết quả
- **WHEN** quá trình hợp nhất hoàn tất
- **THEN** hệ thống ghi ra file xlsx tại đường dẫn `--out` với đầy đủ cột gốc cộng cột "Tên hàng hóa, dịch vụ"
