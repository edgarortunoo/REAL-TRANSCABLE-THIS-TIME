// Cloudflare Pages Function: live COMEX copper price proxy for the ticker.
export async function onRequest() {
  try {
    const res = await fetch(
      "https://query1.finance.yahoo.com/v8/finance/chart/HG=F?interval=1d&range=1d",
      { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" } },
    );
    if (!res.ok) return json({ error: "upstream" }, 502);
    const data = await res.json();
    const meta = data?.chart?.result?.[0]?.meta;
    const price = meta?.regularMarketPrice;
    if (typeof price !== "number") return json({ error: "upstream" }, 502);
    return json({
      price,
      change: meta?.regularMarketChange ?? meta?.fulldayChange ?? 0,
      changePercent: meta?.regularMarketChangePercent ?? 0,
      currency: "USD",
      asOf: new Date().toISOString(),
    });
  } catch {
    return json({ error: "upstream" }, 502);
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}