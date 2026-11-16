# Đối chiếu dữ liệu thực tế — 14/11/2026

Các file nguồn không được chép vào repo hoặc ZIP bàn giao.

## Những gì đã xác nhận

- Có bốn kho: Hóa mẫu LAF và xưởng LAF theo Chặt; Hóa mẫu LVF theo May/Gò; xưởng LVF theo Gò. Việc phân bổ May và Gò cho Hóa mẫu LVF cần định mức từng công đoạn và quy tắc nghiệp vụ; không tự cộng hai công đoạn, vì cùng một đôi có thể xuất hiện ở cả hai.
- `VIDU-CHITIET KK.xlsx`, Sheet1, dòng 22–30 minh họa ĐH09 có 600 đôi đã lĩnh NPL, 300 đã chặt, còn 300; ĐH10 có 600 đã lĩnh, 100 đã chặt, còn 500. Bước 1 nhân số chưa qua công đoạn với định mức; bước sau kiểm đếm và so sánh từng loại vật tư. Dữ liệu mẫu mang tính minh họa, không phải chứng từ thực tế.
- `TIEN-DO-SX-DONHANG.xlsx`, New: S = SL đơn hàng, T = SL lệnh sản xuất, U/V/W = số **đã sản xuất** Chặt/May/Gò. X/Y/Z được ghi là dở dang nhưng công thức trong file là U−S/V−S/W−S, có thể âm: dòng 19, S=386, W=279, Z=-107. Không dùng các ô này như số dở dang dương mà không xác nhận quy tắc; không mặc định SL đơn hoặc SL phát lệnh bằng SL NPL đã lĩnh.
- `DM-MATHANG-HOAMAU LAF-CANLUYEN.xlsx`, sheet DM-NPL-DH, gồm định mức hóa chất Hóa mẫu LAF, theo PO, chỉ lệnh, mã hàng, màu, nhóm/công thức và vật tư. Có dòng SL đơn nguồn bằng 0 nên không chia được; không tự thay mẫu số bằng 1 hoặc tạo số 0 giả. File này không phải định mức Hóa mẫu LVF.

## Thay đổi sau thử bằng file thật

- Sửa lỗi nhận diện cột công đoạn: chuỗi `Gò` trước đây có thể bị tìm nhầm trong `Đóng gói`, còn `May` có thể nhầm trong `Nhà máy`; các cột Chặt/May/Gò bị lặp ở hai nhóm. Bộ nhập giờ nhận dạng đúng nhãn đầu dòng và nhóm **Số lượng đã sản xuất**; nếu trùng mà không có nhóm rõ ràng, dừng báo lỗi.
- Hai file tiến độ và Hóa mẫu LAF đã được thử nhập trực tiếp thành công; test bao gồm trường hợp tiêu đề trùng và tên cột dài. Giao diện có cảnh báo riêng: kết quả hiện tại **chưa** tính số NPL dở dang theo ví dụ và không dùng đối chiếu kiểm kê chính thức.

## Chưa thể tính số lượng kiểm kê 4 kho một cách đáng tin cậy

1. Cần nguồn số NPL đã lĩnh/cấp theo từng chỉ lệnh, vật tư/kho và thời điểm kiểm kê; tiến độ không phải chứng từ lĩnh kho. Cần xác nhận dùng số lượng đã lĩnh quy đổi ra đôi hay một cơ sở khác. Đơn chưa lĩnh, lĩnh một phần hoặc trả vật tư không được coi là đã lĩnh cả đơn.
2. Cần BOM trực tiếp kèm kho nhận/công đoạn cho xưởng LAF/LVF và định mức riêng Hóa mẫu LVF. Cần nguồn tồn đầu kỳ, nhập/xuất/chuyển/trả/điều chỉnh nếu mục tiêu là tồn sổ, cùng số đếm thực tế nếu cần chênh lệch.
3. Xác nhận SL dở dang = SL đã lĩnh (quy đổi đôi) − SL đã qua công đoạn, hay SL đơn hàng − SL đã qua công đoạn; đối chiếu trường hợp SL đơn ≠ SL phát lệnh ≠ SL đã lĩnh. Cho biết cách xử lý vượt, thiếu dữ liệu và trả vật tư.
4. Cho biết mỗi dòng định mức Hóa mẫu LVF thuộc May hay Gò; công thức cụ thể để không tính trùng. Xác nhận Hóa mẫu LAF dùng cùng cơ sở Chặt dù vật tư đã được cán luyện hay chưa.
5. Bộ tính sẵn có vẫn là mô hình thử nghiệm: hóa chất = SL hóa chất nguồn / SL đơn nguồn × SL phát lệnh; BOM = định mức × (SL phát lệnh − SL qua công đoạn), nếu khai báo công đoạn. Nó khác ví dụ vì không có số đã lĩnh; không dùng các số đó như tồn. Số xuất ra không được xác thực với số kiểm kê thực tế.

Sau khi làm rõ và nhận nguồn còn thiếu, cần xây dựng đường dữ liệu chứng từ, kỳ kiểm kê và công thức theo từng kho; test đối chiếu ví dụ và vài đơn thật, các trường hợp nhập từng phần/hoàn tất/chưa lĩnh/thiếu định mức và đồng bộ nhiều người trước khi vận hành online.
