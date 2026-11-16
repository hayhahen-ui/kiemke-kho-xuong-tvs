# Audit và kế hoạch vận hành kiểm kê

Ngày rà soát: 14/11/2026. Phạm vi: mã, cấu hình, schema, hướng dẫn và kiểm thử trong ZIP. ZIP không có workbook thực tế, không có tài khoản/hạ tầng Supabase hoặc Vercel; chưa đối chiếu dữ liệu thực tế, chưa kiểm tra RLS, đồng bộ đồng thời, tải lớn hay triển khai thật. Các test chỉ dùng dữ liệu giả lập. Không coi phiên bản này là đủ điều kiện vận hành chính thức.

## Kết luận nghiệp vụ

- Màn **Nhu cầu vật tư lý thuyết** có 4 kho: Hóa mẫu LAF, Hóa mẫu LVF, xưởng LAF, xưởng LVF. Đây là nhu cầu theo lệnh/BOM, **không phải tồn kho** hay lượng cần mua/cấp thêm.
- Hóa mẫu: lượng hóa chất nguồn / số đôi nguồn × số lượng phát lệnh. Công thức cần được nghiệp vụ xác nhận, nhất là khi công thức thay đổi hoặc có hao hụt.
- BOM trực tiếp: định mức × số lượng phát lệnh; nếu có Chặt/May/Gò, dùng định mức × (phát lệnh − số đã qua công đoạn). Cần xác nhận công đoạn có thực sự đại diện cho tiêu hao vật tư và số tiến độ có lũy kế cùng kỳ không. Dòng thiếu hoặc vượt tiến độ, công đoạn không nhận diện, hay kho nhận mơ hồ được đưa vào danh sách chưa ghép.
- Màn **Kiểm kê** hiện chỉ có 3 khu vực, trong đó Hóa mẫu là một khu vực chung. Số tồn cũ = lĩnh về − WIP quy đổi từ đơn hàng cũ, bỏ qua tồn đầu kỳ, chuyển kho, trả lại, điều chỉnh và nhiều trường hợp tiêu hao. Nó không nối với nguồn tiến độ mới và bốn kho nhu cầu. Không dùng con số này làm tồn chính thức.
- Muốn tính tồn tại thời điểm T cho từng mã/đơn vị/kho cần: tồn đầu kỳ + nhập + chuyển đến + trả lại − xuất/tiêu hao − chuyển đi ± điều chỉnh đã duyệt; so với kiểm đếm cùng mốc T. Tồn khả dụng và nhu cầu bổ sung còn phụ thuộc quy tắc đặt giữ và thời điểm giao. Không suy ra các số này nếu chưa có chứng từ và quy tắc chốt kỳ.

## Đã sửa trong bản này

1. Không nhầm tiêu đề gộp ô của file xuất với hàng tiêu đề dữ liệu khi nhập lại. Tách hóa chất theo đúng kho cả khi kho kia chưa có batch; tránh đưa dữ liệu LAF vào file mẫu/xuất LVF.
2. Ghép hóa chất qua chỉ lệnh đã phân giải **và** mã hàng/màu; ưu tiên mapping thủ công, không ghép nhầm hàng khác cùng chỉ lệnh. Chặn nhiều đích BOM cùng khớp và không suy kho của vật tư đa nhà máy từ nhà máy của đơn.
3. Không tính khi công đoạn không biết, thiếu tiến độ, tiến độ âm hoặc vượt số lệnh; để dòng vào danh sách cần rà soát. Giữ ô tiến độ thiếu là trống khi xuất. Kiểm tra bắt buộc SL phát lệnh và số lượng hóa chất/SL nguồn thay vì biến ô lỗi thành 0; phát hiện mapping sản phẩm trùng và xung đột trong file.
4. Tránh thông báo lưu thành công khi lưu lỗi; trạng thái trong bộ nhớ chỉ đổi sau khi lệnh lưu thành công. Phân trang cloud có thứ tự ổn định; khóa lệnh mới có thêm dòng nguồn; phát hiện các khóa cloud trùng trong cùng lượt thay vì ghi đè âm thầm. Các thay đổi này **không** làm đồng bộ trở nên nguyên tử hay giải quyết xung đột nhiều người.
5. Bỏ cộng tổng vật tư khác đơn vị trong dashboard/kiểm kê; làm rõ nhu cầu khác tồn kho, giữ chi tiết và danh sách chưa ghép khi xuất. Bảo vệ CSV khỏi chuỗi có thể được Excel diễn giải thành công thức.

## Vấn đề còn lại — chặn triển khai chính thức

**P0 — Sai lệch dữ liệu nhiều người:** `saveWorkspaceRecords` upsert toàn bộ các bản ghi của từng loại, nhiều lô độc lập, không giao dịch tổng thể, không kiểm tra phiên bản. Hai người có thể ghi đè dữ liệu mới của nhau; lỗi giữa chừng có thể để dữ liệu cloud một phần. Nhập mới kiểu merge không xóa dòng cũ cho các tập BOM, danh mục, mapping, WIP; có thể lưu dữ liệu cũ sau khi file bị xóa dòng. Khóa BOM cloud thiếu kho/công đoạn/luồng; bản này chỉ phát hiện va chạm cùng lượt, chưa di trú hoặc sửa các dòng đã bị mất. Phải thiết kế import theo batch bất biến, kích hoạt batch bằng một transaction, thêm version/optimistic locking, phân biệt cập nhật từng bản ghi và test đồng thời trước go-live. Sao lưu trước di trú và đối chiếu các dòng BOM cũ.

**P0 — Chưa có kiểm kê 4 kho và sổ chứng từ:** cần mô hình kho, vật tư + đơn vị, tồn đầu kỳ, phiếu nhập/xuất/chuyển/trả/điều chỉnh, thời điểm hiệu lực, kỳ kiểm kê, số đếm và phê duyệt. Phải có đối chiếu giao dịch, khóa kỳ, lịch sử ai sửa gì và khả năng phục hồi; không ghép nhầm nhu cầu với tồn.

**P0 — Bảo mật/quản trị:** RLS có trong SQL nhưng chưa test với user thật; việc khởi tạo workspace mặc định phụ thuộc tài khoản đầu tiên và dễ rủi ro nếu đăng ký công khai. Chỉ cho quản trị viên được tạo tài khoản ban đầu, tắt đăng ký công khai, kiểm thử viewer/editor/owner, giới hạn truy cập, thiết lập backup/restore, xác nhận RLS và quản trị sự cố trước khi mở online. Không dùng service_role trong frontend.

**P1 — Chất lượng nguồn:** một số bộ nhập cũ còn bỏ qua dòng thiếu/trùng hoặc chuyển số không hợp lệ thành 0; Excel có thể dùng giá trị cache công thức cũ, mã số có số 0 đầu, định dạng số theo locale, đơn vị khác nhau. Cần báo cáo đầy đủ các dòng bị loại, kiểm tra trùng/đơn vị, khớp tổng nguồn–đích, xác nhận file được Excel tính lại và khóa mapping; không tự suy đoán. Các dòng chưa ghép phải được xử lý trước khi dùng kết quả.

**P1 — Nguồn và nghiệp vụ:** chưa có dữ liệu thực, đặc biệt định mức Hóa mẫu LVF, BOM nhận kho LVF và thông tin tồn/biến động. Định mức BTP theo size nằm ở màn riêng, chưa được cộng vào nhu cầu bốn kho. Xác nhận có cần tính BTP vào kho nào và tránh tính trùng BOM trước khi tích hợp.

**P1 — Hiệu năng và trải nghiệm:** toàn bộ tập dữ liệu được tải/lưu lại ở client; phép tính theo 4 kho trong bộ nhớ, ExcelJS bundle ~937 kB chưa nén. Cần đo với bộ dữ liệu thực tế, giới hạn file, phân trang/worker và chuyển tính toán đáng tin cậy sang server khi cần. Tệp cục bộ chỉ nằm trên một trình duyệt và có thể mất khi xóa dữ liệu.

## Quy trình thử nghiệm an toàn

1. Xác nhận kho thứ tư; yêu cầu gốc ghi “kho xưởng LAF” hai lần. Hệ thống hiện giả định kho thứ tư là **xưởng LVF**.
2. Dùng bản sao dữ liệu đã ẩn thông tin nhạy cảm; nạp tiến độ, danh mục, BOM, mapping và định mức Hóa mẫu theo README. Không dùng môi trường sản xuất.
3. Với mỗi kho xuất nhu cầu chi tiết, đối chiếu từng mã, đơn vị, chỉ lệnh và công thức; xử lý mọi dòng `ChuaGhepDuoc`. Nhập số 0 tường minh nếu công đoạn thực sự bằng 0.
4. Thiết kế sổ tồn và quy tắc chốt kỳ cùng người phụ trách; test phiếu mẫu, hai người sửa đồng thời, lỗi mạng, nhập lại, RLS và restore backup. Chỉ triển khai chính thức sau khi các kiểm thử và số đối chiếu được chấp thuận.

## Xác minh kỹ thuật của bản sửa

`npm ci`, `npm test`, `npm run build`, `npm audit --omit=dev` đã chạy thành công trong môi trường sandbox; 27 test. Audit npm không thay thế kiểm tra bảo mật hệ thống. Cảnh báo bundle ExcelJS lớn vẫn còn. Chưa kiểm thử Supabase/Vercel thực tế.
