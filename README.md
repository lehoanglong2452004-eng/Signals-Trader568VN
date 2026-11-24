# Signals Trader568VN

Terminal theo dõi tín hiệu giao dịch phái sinh hàng hóa (vàng, bạc, dầu, đậu tương, ngô, cà phê...).

> Trạng thái: **bản phác họa giao diện**. Toàn bộ số liệu trong trang là dữ liệu mẫu.

## Xem thử

- Trên máy: mở file `index.html` bằng trình duyệt.
- Online: bật GitHub Pages cho repo (Settings → Pages → Deploy from branch `main`, thư mục `/`).

## Bố cục

- **Bên trái:** chart giá + volume (panel riêng, màu xanh dương cố định). Nến mặc định tăng trắng / giảm đỏ, người dùng tự đổi màu.
  Thanh chart chỉ có khung thời gian (1m → M) và menu 10 chỉ báo phổ biến: Volume, EMA 20/50, SMA 200, Bollinger Bands, VWAP, Ichimoku, RSI, MACD, Stochastic, ATR.
- **Bên phải:** 3 chiến lược giới thiệu (EMA Cross 9/21, Breakout Donchian 20, RSI Divergence), mỗi chiến lược một cột, mở bao nhiêu cột tùy ý. Mỗi cột chỉ hiện số của riêng chỉ báo đó:
  tín hiệu đang mở / chờ khớp, logic và điều kiện vào lệnh, lịch sử lệnh, lãi lỗ và đánh giá theo bộ quy tắc kiểu FTMO
  (mục tiêu lợi nhuận 10% / 5%, lỗ tối đa ngày 5%, lỗ tối đa tổng 10%, tối thiểu 4 ngày giao dịch).
- Mã theo ký hiệu TradingView (GC1!, GCZ2026, OANDA:XAUUSD...), chọn được từng kỳ hạn hợp đồng.
- Đồng hồ chạy realtime theo GMT+7.
- Kéo thả để chỉnh bố cục: độ rộng chart, độ rộng từng cột, chiều cao panel chỉ báo dưới chart và chiều cao cả khung. Bố cục được nhớ trên trình duyệt; nút "Đặt lại bố cục" đưa về mặc định.

## Kiến trúc dự kiến

1. Chỉ báo Pine Script trên TradingView bắn alert (webhook) kèm mã, hướng, entry, SL, TP; bắn thêm alert khi chạm TP/SL.
2. Cloudflare Workers (gói miễn phí) nhận alert, lưu tín hiệu, kiểm tra mật khẩu người xem.
3. Trang này (GitHub Pages) đọc dữ liệu từ Worker.

Lãi lỗ tính bằng USD: `(giá ra − giá vào) × số lot × quy mô hợp đồng`.

Khóa bí mật webhook và mật khẩu **không** được đưa vào repo; chúng lưu dạng secret trên Cloudflare.
