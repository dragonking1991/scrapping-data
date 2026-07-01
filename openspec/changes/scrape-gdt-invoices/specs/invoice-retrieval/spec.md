## ADDED Requirements

### Requirement: Tra cứu danh sách hóa đơn bán ra theo ngày
Hệ thống SHALL tra cứu danh sách hóa đơn điện tử bán ra theo khoảng ngày (từ ngày, đến ngày) qua API JSON của cổng, sử dụng Bearer token đã có.

#### Scenario: Lấy danh sách theo khoảng ngày
- **WHEN** người dùng cung cấp khoảng ngày hợp lệ
- **THEN** hệ thống gọi API danh sách hóa đơn bán ra với filter ngày tương ứng và nhận về các bản ghi header hóa đơn

#### Scenario: Không có hóa đơn trong khoảng ngày
- **WHEN** khoảng ngày không có hóa đơn nào
- **THEN** hệ thống kết thúc với danh sách rỗng và thông báo không có dữ liệu, không lỗi

### Requirement: Phân trang đầy đủ
Hệ thống SHALL lần qua tất cả các trang kết quả để lấy đủ toàn bộ hóa đơn, không bỏ sót khi số kết quả vượt một trang.

#### Scenario: Nhiều trang kết quả
- **WHEN** số hóa đơn trong khoảng ngày lớn hơn kích thước một trang
- **THEN** hệ thống lặp qua tất cả các trang và gộp lại thành một danh sách đầy đủ

### Requirement: Lấy tên hàng hóa, dịch vụ theo từng hóa đơn
Hệ thống SHALL gọi API chi tiết cho từng hóa đơn để lấy danh sách dòng hàng hóa/dịch vụ và gộp tên các dòng thành một chuỗi "Tên hàng hóa, dịch vụ" gắn với hóa đơn đó.

#### Scenario: Hóa đơn một dòng hàng hóa
- **WHEN** hóa đơn chỉ có một dòng hàng hóa/dịch vụ
- **THEN** chuỗi tên hàng hóa của hóa đơn đó bằng đúng tên của dòng duy nhất

#### Scenario: Hóa đơn nhiều dòng hàng hóa
- **WHEN** hóa đơn có nhiều dòng hàng hóa/dịch vụ
- **THEN** hệ thống gộp tên tất cả các dòng thành một chuỗi theo dấu phân tách nhất quán

#### Scenario: Kiểm soát tải khi gọi nhiều hóa đơn
- **WHEN** cần lấy chi tiết cho hàng trăm hóa đơn
- **THEN** hệ thống giới hạn số request đồng thời và có delay/backoff để tránh bị rate-limit hoặc chặn

#### Scenario: Lỗi tạm thời ở một hóa đơn
- **WHEN** một request chi tiết thất bại do lỗi tạm thời
- **THEN** hệ thống thử lại với backoff và nếu vẫn lỗi thì ghi nhận hóa đơn đó là thiếu tên thay vì dừng toàn bộ pipeline
