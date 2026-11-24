# Cài đặt Signals Trader568VN

## 1. Máy chủ nhận tín hiệu (Cloudflare Workers, miễn phí)

Mã nguồn trong thư mục `worker/`.

1. Tạo cơ sở dữ liệu D1 tên `signals-trader568vn`, chạy nội dung `worker/schema.sql` trong tab Console của D1.
2. Tạo Worker tên `signals-trader568vn`, dán nội dung `worker/src/index.js`, Deploy.
3. Trong Worker → Settings → Bindings: thêm D1 database, tên biến `DB`, chọn `signals-trader568vn`.
4. Trong Worker → Settings → Variables and Secrets:
   - `ALLOWED_ORIGINS` (Text): `https://lehoanglong2452004-eng.github.io,null`
   - `WEBHOOK_KEY` (Secret): chuỗi bí mật bất kỳ, dài, dùng trong URL webhook.
   - `VIEW_PASSWORD` (Secret): mật khẩu vào terminal.
   - `SESSION_SECRET` (Secret): chuỗi ngẫu nhiên dài (ký phiên đăng nhập).
5. Kiểm tra: mở `https://<worker>.workers.dev/api/health` phải thấy `{"ok":true,...}`.

Dùng dòng lệnh thay cho dashboard: `cd worker && npx wrangler d1 create signals-trader568vn`, điền `database_id` vào `wrangler.toml`,
`npx wrangler d1 execute signals-trader568vn --remote --file=schema.sql`, đặt 3 secret bằng `npx wrangler secret put ...`, rồi `npx wrangler deploy`.

## 2. Nối giao diện

Sửa `config.js`: `api: "https://<worker>.workers.dev"`. Đẩy lên GitHub, trang GitHub Pages tự cập nhật.
Mở `index.html` trên máy (ổ E) cũng dùng được: trình duyệt gửi origin `null`, đã cho phép sẵn trong `ALLOWED_ORIGINS`.

## 3. Alert trên TradingView

Dùng mẫu `pine/alert-mau.pine`. Mỗi alert gửi JSON:

```json
{"strategy":"ema","symbol":"COMEX:GC1!","event":"entry","side":"buy","price":2643.0,"sl":2627.1,"tp":2674.8,"id":"ema-1732420800000","time":1732420800000}
```

| event | Ý nghĩa |
|---|---|
| `entry` | Vào lệnh ngay (trạng thái Đang mở) |
| `pending` | Đặt lệnh chờ (Chờ khớp) |
| `fill` | Lệnh chờ đã khớp |
| `cancel` | Hủy lệnh chờ |
| `update` | Dời SL / TP |
| `tp` / `sl` / `exit` | Đóng lệnh do chạm TP, chạm SL hoặc lý do khác |

`strategy` phải là `ema`, `don` hoặc `rsi`. Webhook URL: `https://<worker>.workers.dev/webhook?key=<WEBHOOK_KEY>`.
