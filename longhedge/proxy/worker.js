// Proxy nhỏ cho LongHedge VN: chỉ chuyển tiếp yêu cầu ĐỌC dữ liệu công khai của Coinbase và Kraken,
// thêm header CORS để trình duyệt đọc được. Không chứa khóa bí mật nào.
// Cài: Cloudflare → Workers → Create → dán file này → Deploy, rồi dán địa chỉ worker vào Cài đặt → Proxy.
const ALLOW = ["api.coinbase.com", "futures.kraken.com"];
export default {
  async fetch(req) {
    const cors = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, OPTIONS" };
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    const u = new URL(req.url).searchParams.get("u");
    let target;
    try { target = new URL(u); } catch (e) { return new Response("Thiếu tham số u", { status: 400, headers: cors }); }
    if (target.protocol !== "https:" || !ALLOW.includes(target.hostname)) return new Response("Không cho phép", { status: 403, headers: cors });
    const r = await fetch(target.toString(), { headers: { accept: "application/json" }, cf: { cacheTtl: 5 } });
    return new Response(r.body, { status: r.status, headers: { ...cors, "content-type": r.headers.get("content-type") || "application/json" } });
  },
};
