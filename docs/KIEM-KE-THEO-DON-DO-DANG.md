# Tồn lý thuyết theo đơn dở dang

## Mục tiêu và cách tính

Theo `VIDU-CHITIET KK.xlsx`: tại mốc kiểm kê, xác định các đơn còn dở dang; mỗi dòng vật tư còn theo định mức = `(số đôi cơ sở − số đôi đã qua công đoạn) × định mức/đôi`. Cộng theo kho, mã vật tư và đơn vị; nhấn **Theo đơn** để xem chỉ lệnh, cơ sở, số đã qua, số còn lại và định mức.

- Hóa mẫu LAF và xưởng LAF: Chặt.
- Xưởng LVF: Gò.
- Hóa mẫu LVF: chọn May hoặc Gò cho toàn bộ định mức, hoặc chọn **May + Gò** khi từng dòng định mức có cột `Công đoạn sử dụng` ghi `May` hoặc `Gò`. Dòng không có công đoạn không được tự gán. Không cộng kết quả của hai lần tính toàn bộ cùng một định mức: sẽ có nguy cơ trùng.
- Định mức hóa chất/đôi = Số lượng hóa chất / SL đơn hàng nguồn; mẫu số bằng 0 được đưa vào `ChuaGhep`, không tự chia. BOM trực tiếp dùng định mức/đôi của vật tư theo mã hàng/màu và kho nhận.

Ví dụ của file: ĐH09 đã lĩnh 600, chặt 300, nên tính 300 đôi; ĐH10 đã lĩnh 600, chặt 100, nên tính 500 đôi. Ví dụ này không cung cấp định mức cụ thể cho hai mã, do đó test dùng định mức giả lập để kiểm tra phép nhân và cộng.

Đây là **tồn lý thuyết theo định mức của đơn dở dang**, không phải tồn sổ hay lượng thực tế. Phép tính phụ thuộc cơ sở số đôi, sự đầy đủ/đúng thời điểm của nguồn và quy tắc cấp phát. Số thực đếm có thể dư vì vật tư của các đơn trước còn ở xưởng, hoặc có thể thiếu.

## Quy trình sử dụng

1. Nạp file tiến độ, Hóa mẫu LAF, danh mục và BOM trực tiếp, mapping mã hàng/màu/chỉ lệnh nếu cần, và định mức Hóa mẫu LVF khi có, trong **Tác vụ nhập liệu**. Tách đúng các kho và đơn vị; định mức LVF không tự lấy từ LAF.
2. Mở **Tồn theo đơn dở dang**, chọn kho và mốc kiểm kê. Thông tin được tính từ dữ liệu đang nạp: thời gian là nhãn mốc do người dùng chọn, **không tự tái dựng nguồn quá khứ**. Mọi nguồn cần phản ánh cùng mốc đó.
3. Chọn một trong ba cách lấy số đôi cơ sở, tùy dữ liệu và nghiệp vụ:
   - **Nhập số đôi đã lĩnh**: tải mẫu, ghi `Kho`, `Chỉ lệnh`, `Mã hàng`, `Màu`, `Số đôi đã lĩnh` cho mỗi tổ hợp rồi nạp. Đây là lượng quy đổi ra đôi theo file ví dụ; nạp được từ báo cáo, bảng đối chiếu hoặc nhập tay, không bắt buộc triển khai sổ chứng từ trong ứng dụng. Với đơn chưa lĩnh, nhập rõ 0; thiếu dòng không bị coi là 0. Không nhập mã trùng trong cùng kho.
   - **SL phát lệnh** hoặc **SL đơn hàng**: chọn khi người dùng chấp nhận giả định số đó là cơ sở tương ứng với vật tư đã lĩnh tại kho. Hai cách này là ước tính, không khẳng định NPL đã được cấp. Số liệu nguồn T/S được lấy trực tiếp, không dùng các cột X/Y/Z trong file tiến độ vì công thức nguồn đang mang dấu ngược.
4. Với Hóa mẫu LVF, chọn May/Gò hoặc May + Gò theo cột công đoạn trong định mức. Xem từng dòng vật tư, bấm **Theo đơn**, xuất Excel gồm `ThongTin`, `TongHop`, `TheoDon`, `ChuaGhep`. Dòng chưa ghép/thiếu/vượt số cơ sở được báo riêng; kết quả được xem là chưa đầy đủ khi còn lỗi. Không cộng vật tư khác đơn vị.
5. Có thể tải mẫu **kiểm đếm**, điền mỗi kho/mã/đơn vị cùng số đếm thực tế và nhập vào màn này. Chênh lệch = thực đếm − lý thuyết đã tính. Mã chỉ có trong file kiểm đếm được hiển thị riêng; khi còn nguồn thiếu/chưa ghép thì không khẳng định mã này dư hay chênh lệch bằng số đếm. Ô không có số đếm là chưa đếm, khác với số 0.
6. Xuất Excel làm ảnh chụp và lưu cùng các nguồn đầu vào, vì các lựa chọn và file cơ sở/kiểm đếm chỉ lưu trong phiên màn hình, chưa được lưu thành kỳ kiểm kê dùng chung. Mỗi lần nạp lại dữ liệu có thể làm kết quả thay đổi.

## Những giới hạn cần kiểm soát

- File mẫu là một quy tắc tính theo định mức, không chứng minh việc đã cấp vật tư. Người dùng tự chọn cơ sở phù hợp và đối chiếu các cảnh báo.
- Chỉ có file định mức Hóa mẫu LAF và tiến độ được cung cấp để thử; chưa có file BOM trực tiếp của hai xưởng, định mức Hóa mẫu LVF, số đôi đã lĩnh hay số đếm thật. Vì vậy chưa có kết quả đủ bốn kho.
- Kết quả có `ChuaGhep` có thể thấp hơn thực tế; nhập đủ mapping, định mức, đơn vị và tiến độ trước khi đối chiếu chính thức. Vật tư ngoài kết quả đã ghép không mặc định là dư nếu còn thiếu nguồn.
- Không tự xử lý đổi trả, hao hụt, thay thế vật tư, nhiều lần cấp một phần hay chuyển kho bằng công thức này; cần chọn cơ sở và định mức đã phản ánh nghiệp vụ đó hoặc theo dõi riêng.
- Đồng bộ nhiều người của dự án cũ vẫn có rủi ro ghi đè/ghi một phần. Xem `AUDIT-KAIZEN.md`; không triển khai chính thức trước khi kiểm thử đồng bộ, phân quyền, sao lưu và khôi phục. Màn mới chưa lưu ảnh chụp bất biến trên cloud.
