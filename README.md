# Kiểm kê kho xưởng

> **Bản thử nghiệm, chưa sẵn sàng vận hành chính thức.** Xem [hướng dẫn tính tồn theo đơn dở dang](docs/KIEM-KE-THEO-DON-DO-DANG.md). Xem [audit, các rủi ro P0 và kế hoạch kiểm kê 4 kho](docs/AUDIT-KAIZEN.md) và [đối chiếu các file thực tế](docs/DOI-CHIEU-DU-LIEU-THUC.md). Nhu cầu không phải tồn kho; màn kiểm kê hiện chưa tách hai kho Hóa mẫu và chưa có sổ giao dịch.

Ứng dụng web tiếng Việt chuyển luồng theo dõi từ workbook sang các màn hình Tổng quan, Đơn hàng, Kiểm kê, Danh mục/BOM và Định mức BTP theo size cho nhà máy LAF.

## Dữ liệu

- Menu **Tác vụ nhập liệu** tách riêng các luồng đơn hàng, tiến độ sản xuất, mapping mã hàng-màu, WIP, danh mục vật tư, BOM trực tiếp, định mức Hóa mẫu LAF/LVF, kiểm kê và định mức BTP theo size LAF. Từng nguồn đầu vào có Import, Export dữ liệu và Tải mẫu trống.
- Có thể nạp từng phần từ workbook hiện tại: danh mục/BOM từ `1_Danh_Muc_Va_Ma_Tran_BOM`; tồn kho từ từng sheet `2_Kho_Hoa_Mau`, `3_Kho_Xuong_LAF`, `4_Kho_Xuong_LVF`; định mức từ `DM_BTP_Size_LAF`.
- File `DON HANG.xlsx`: chỉ đọc sheet `ADIDAS` và `LƯU HÓA`; sheet `BTP` được bỏ qua. Đơn ADIDAS được gán LAF, đơn LƯU HÓA được gán Hóa mẫu.
- Nguồn `TIEN-DO-SX-DONHANG.xlsx` được đọc riêng từ sheet `New`, giữ PO, chỉ lệnh, mã hàng-màu, SL đơn, SL phát lệnh và tiến độ Chặt/May/Gò/Nhập kho/Đóng thùng/Giao hàng.
- Nguồn `DM-MATHANG-HOAMAU LAF-CANLUYEN.xlsx` được đọc từ `DM-NPL-DH`. Định mức/đôi = `Số lượng hóa chất ÷ SL đơn hàng`; nhu cầu theo lệnh = định mức/đôi × `Số lượng lệnh sản xuất`.
- Màn hình **Nhu cầu lý thuyết** tách bốn kho: Hóa mẫu LAF, Hóa mẫu LVF, xưởng LAF, xưởng LVF. Hóa mẫu LVF không tự dùng định mức LAF làm thay thế. BOM trực tiếp cần xác định kho nhận; vật tư nhiều nhà máy nhưng chưa có kho nhận được đưa vào danh sách cần mapping thay vì nhân đôi số lượng.
- Mã màu đơn hàng được ghép với mã màu BOM từ khóa màu của nguồn định mức Hóa mẫu. Dòng không ghép đủ chỉ lệnh + mã hàng + màu hoặc không có kho nhận sẽ được xuất riêng để rà soát.
- Có thể bổ sung thủ công bảng **Mapping mã hàng - màu BOM** cho đơn hàng chưa có mã màu ở file định mức. Bảng hỗ trợ ghép theo cặp mã hàng/tên màu nguồn hoặc Mã sản phẩm nguồn.
- File Export là `.xlsx` theo từng tác vụ. BOM được xuất dạng danh sách dọc, nên số mã hàng-màu không bị giới hạn bởi số cột mẫu. File chỉ chứa dữ liệu đầu vào; không ghi công thức Excel. Nhu cầu, WIP, tồn lý thuyết và chênh lệch được tính trong ứng dụng.
- Repo không chứa workbook hoặc dữ liệu mẫu. Hãy dùng **Tác vụ nhập liệu** sau khi mở ứng dụng.
- Chưa kết nối Supabase: dữ liệu lưu trong IndexedDB của trình duyệt hiện tại, chưa dùng chung giữa máy tính/người dùng. IndexedDB được dùng để lưu các nguồn định mức nhiều dòng.

## Chạy trên máy

```bash
npm install
npm run dev
```

Chạy kiểm tra và build production:

```bash
npm test
npm run build
```

## Bật dữ liệu dùng chung

1. Tạo project Supabase và chạy toàn bộ `supabase/schema.sql` trong SQL Editor.
2. Tạo tài khoản đầu tiên trong Supabase Auth. Đăng nhập ứng dụng lần đầu sẽ tạo workspace mặc định.
3. Tạo thêm tài khoản cho nhân viên trong Supabase Auth. Với từng nhân viên, thêm quyền vào workspace bằng SQL, thay hai giá trị UUID:

   ```sql
   insert into public.workspace_members (workspace_id, user_id, role)
   select id, 'USER_UUID', 'editor'
   from public.workspaces
   where name = 'Kho xưởng 3 nhà máy'
   limit 1;
   ```

4. Khai báo `VITE_SUPABASE_URL` và `VITE_SUPABASE_ANON_KEY` trong `.env.local` để chạy local và trong Vercel Project Settings để deploy. Sau đó chạy lại build/deploy.
5. `workspace_records` bật Row Level Security. Chỉ dùng publishable/anon key ở trình duyệt; không đưa `service_role` key vào `VITE_*` hoặc repo.

## Deploy Vercel

Repo này dùng Vite; Vercel tự phát hiện cấu hình build (`npm run build`) và thư mục output `dist`. Có thể kết nối GitHub repo để tự deploy mỗi lần push `main`, hoặc deploy bằng Vercel CLI.

## Ghi chú nghiệp vụ

- Vật tư được gắn với một hoặc nhiều nhà máy; cùng STT có thể dùng ở LAF, LVF và Hóa mẫu.
- BOM được lưu dạng từng dòng mã hàng-màu-vật tư; bộ nhập đọc động các cột màu hiện có trong workbook và file xuất dùng danh sách dọc.
- Màn hình kiểm kê cũ dùng `Lĩnh về − Sản xuất quy đổi WIP`; không dùng thay cho màn hình **Tồn theo đơn dở dang** theo yêu cầu hiện tại.
- Dòng đơn hàng gắn với nhà máy chính; WIP được nhập riêng theo từng nhà máy.
- Import Excel xử lý trong trình duyệt. Khi có Supabase, các bản ghi được lưu theo workspace; khi chưa cấu hình Supabase, dữ liệu chỉ ở trình duyệt đó.

## Kết nối ba tệp kiểm kê thực tế (phiên bản thử nghiệm)

1. Mở **Tác vụ nhập liệu**, nạp `TIEN-DO-SX-DONHANG.xlsx` tại **Tiến độ & lệnh sản xuất**, sau đó nạp `DM-MATHANG-HOAMAU LAF-CANLUYEN.xlsx` tại **Định mức Hóa mẫu · LAF**. Định mức LAF không tự dùng cho Hóa mẫu LVF.
2. Ở **Nạp workbook thống kê kho**, nạp `Mau_01_Thong_Ke_Xuong_Doi_Chieu_Kiem_Ke...xlsx` một lần để thay danh mục, ma trận BOM và BTP. Nút này chỉ cho chế độ thiết bị; sao lưu trước khi thay nguồn. Nếu cần định mức LVF, nhập nguồn riêng đúng kho.
3. Mở **Tồn theo đơn dở dang**, nạp kiểm đếm từ workbook thống kê bằng nút riêng. Hệ thống đọc bảng B cột M; Hóa mẫu phân kho theo cột T. Ô trống không phải số 0; dòng không phân kho bị bỏ qua. Vật tư cùng mã và đơn vị được cộng, số đếm vẫn chỉ thuộc mốc ghi trong sheet gốc.
4. Chọn kho và mốc. Theo yêu cầu, cơ sở là **SL đơn hàng** trong cột S của tệp tiến độ: dở dang Chặt = S − U, May = S − V, Gò = S − W. Đây là quy đổi theo đơn hàng, không phải xác nhận số vật tư đã lĩnh thực tế. X/Y/Z trong tệp nguồn đang có công thức ngược dấu U/V/W − S; ứng dụng tính lại chiều dương, không sửa Excel gốc. Xuất Excel và kiểm tra `ChuaGhep`; chọn mốc không tái tạo được dữ liệu cũ. Chỉ đối chiếu chính thức khi dữ liệu được chốt cùng mốc.
5. Công đoạn: xưởng LAF và Hóa mẫu LAF dùng Chặt; cả xưởng LVF và Hóa mẫu LVF dùng May/Gò. Chế độ tổng hợp chỉ tính dòng định mức có khai báo May hoặc Gò. Dòng chưa có công đoạn được đưa vào cần rà soát; có thể xem May riêng và Gò riêng nhưng không được cộng hai phương án đó khi chưa phân loại vật tư để tránh tính trùng.
6. Workbook ưu tiên chi tiết BTP theo STT vật tư. Ở màn hình mới, vật tư có BTP LAF được đưa vào danh sách cần rà soát, không tự thay bằng BOM ma trận hoặc cộng chồng. Hiện chưa tính BTP theo size/công đoạn và chưa phân bổ BTP theo chỉ lệnh — cần bổ sung WIP theo size và quy tắc phân bổ đã xác nhận. Các màn hình cũ dùng logic khác, không dùng thay cho màn hình mới.

**Chưa sẵn sàng vận hành online chính thức:** chưa hoàn thiện khóa/snapshot dùng chung, phân quyền cập nhật và xử lý ghi đồng thời; đồng bộ cloud cũ chưa bảo đảm thay thế nguồn sạch. Không triển khai dữ liệu thật công khai trước khi khắc phục, kiểm thử bảo mật và được người phụ trách phê duyệt. Bản thử không bao gồm các tệp dữ liệu riêng tư.
