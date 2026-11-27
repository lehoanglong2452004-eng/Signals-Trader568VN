# LongHedge VN

Terminal tín hiệu cho **hợp đồng tương lai vĩnh cửu** (perpetual), chạy hoàn toàn trên trình duyệt, không cần máy chủ và không cần đăng nhập.

- **Nguồn dữ liệu:** Binance (mặc định), Bybit, OKX, Hyperliquid lấy thẳng từ API công khai của sàn. Coinbase và Kraken chặn gọi từ trình duyệt nên cần proxy nhỏ (`proxy/worker.js`, gói Cloudflare miễn phí là đủ).
- **Tự chuyển sàn:** sàn đang dùng lỗi 2 lần liên tiếp thì tự chuyển sang sàn kế tiếp có mã đó (tắt được trong Cài đặt).
- **Danh mục mặc định:** BTC, ETH, dầu WTI, dầu Brent, vàng, bạc, đồng, bạch kim. Mã không có trên sàn đang chọn thì lấy từ sàn khác và ghi rõ nguồn. Gõ ở ô Tìm mã để thêm mã khác.
- **Chart:** nến, volume, 1 đường VWAP reset mỗi phiên lúc 07:00 giờ Việt Nam (00:00 UTC), điểm MUA/BÁN, đường Vào / TP / SL. Có toàn màn hình cho cả trang và cho riêng chart.
- **14 chiến lược chạy song song** trong Web Worker trên nến đã đóng. Bấm 1 chiến lược để xem Tín hiệu, Logic · Thông số, Lịch sử lệnh (R, MAE, MFE, phí), Đánh giá.
- **Tab Đánh giá chiến lược:** theo quy tắc đánh giá của quỹ giao dịch chuyên nghiệp (mục tiêu +10% / +5%, lỗ ngày 5%, lỗ tổng 10%, tối thiểu 4 ngày giao dịch), chỉnh được hết.
- **Giao diện:** Cổ điển (nền trắng, mặc định) và Hiện đại (nền đen), tự chọn màu, phông IBM Plex (gần với phông Bloomberg).

## Thông số chiến lược

`js/engine.js` là bản đóng gói chỉ chứa **thông số mặc định phổ thông**. Thông số thật bro nhập trên trang chỉ lưu trong trình duyệt (localStorage), không gửi đi đâu. Dùng Cài đặt → Xuất / Nhập file thông số để mang sang máy khác. Mã nguồn chiến lược nằm ngoài repo; `js/engine.js` được dựng lại bằng `build.sh` từ thư mục riêng.

## Cách lãi lỗ được tính

- Vào lệnh ở giá đóng cửa của nến tín hiệu. SL / TP / dời hòa vốn kiểm tra trên các nến sau đó; cùng 1 nến chạm cả SL và TP thì tính SL trước.
- Mỗi lệnh rủi ro cố định `% rủi ro × vốn ban đầu`, khối lượng = tiền rủi ro / khoảng cách SL. Phí = `% phí × (giá vào + giá ra) × khối lượng`.
- Lỗ trong ngày tính cả mức lỗ sâu nhất khi lệnh đang mở (MAE). Ngày giao dịch bắt đầu 07:00 giờ Việt Nam.
