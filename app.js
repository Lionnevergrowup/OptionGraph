/* OptionGraph — 期权杠杆可视化
 * 数据来源: Cboe 免费延迟行情 (约延迟 15 分钟)
 * 杠杆倍数 = 现价 / 期权中间价 × Delta
 */

const CBOE_BASE = "https://cdn.cboe.com/api/global/delayed_quotes/options/";

// Cboe 的 CDN 不返回 CORS 头,需经公共 CORS 代理中转。
// 注意:期权链 JSON 普遍 1.5~2MB,corsproxy.io 免费版有 1MB 响应上限,
// 但它会透传 Range 头,所以用 Range 分块(每块 <1MB)拼出完整内容。
const CHUNK = 900000;

async function fetchText(url, init) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchChunked(url) {
  let text = "";
  for (let i = 0; i < 8; i++) {
    const start = i * CHUNK;
    const part = await fetchText(url, {
      headers: { Range: `bytes=${start}-${start + CHUNK - 1}` },
    });
    text += part;
    if (part.length < CHUNK) break;
  }
  return text;
}

const STRATEGIES = [
  (u) => fetchText(u),
  (u) => fetchText(`https://proxy.corsfix.com/?${u}`),
  (u) => fetchChunked(`https://corsproxy.io/?url=${encodeURIComponent(u)}`),
  (u) => fetchText(`https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`),
  (u) => fetchText(`https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`),
];

const $ = (id) => document.getElementById(id);
const el = {
  ticker: $("ticker"),
  loadBtn: $("load-btn"),
  chips: $("chips"),
  expiry: $("expiry"),
  range: $("range"),
  status: $("status"),
  quote: $("quote"),
  qSymbol: $("q-symbol"),
  qPrice: $("q-price"),
  qChange: $("q-change"),
  qMeta: $("q-meta"),
  chartCard: $("chart-card"),
  chartTitle: $("chart-title"),
  canvas: $("chart"),
};

let state = null; // { symbol, spot, timestamp, byExpiry: Map<iso, option[]> }
let chart = null;

function setStatus(msg, isError = false) {
  el.status.hidden = !msg;
  el.status.textContent = msg || "";
  el.status.classList.toggle("error", isError);
}

async function fetchJSON(url) {
  let lastErr;
  for (const strategy of STRATEGIES) {
    try {
      // Cboe 数据每几秒更新一次,分块拼接偶尔会跨版本导致 JSON 损坏,重试一次
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const json = JSON.parse(await strategy(url));
          if (json && json.data && Array.isArray(json.data.options)) return json;
          throw new Error("数据格式异常");
        } catch (e) {
          if (attempt === 1 || !(e instanceof SyntaxError)) throw e;
        }
      }
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("网络请求失败");
}

// 期权代码如 AAPL260612C00240000 → 到期日 / Call|Put / 行权价
const OPT_RE = /(\d{6})([CP])(\d{8})$/;

function parseOptions(raw) {
  const byExpiry = new Map();
  for (const o of raw) {
    const m = OPT_RE.exec(o.option);
    if (!m) continue;
    const [, ymd, cp, strikeRaw] = m;
    const iso = `20${ymd.slice(0, 2)}-${ymd.slice(2, 4)}-${ymd.slice(4, 6)}`;
    const strike = parseInt(strikeRaw, 10) / 1000;
    const mid = (o.bid + o.ask) / 2;
    if (!(mid > 0) || !isFinite(o.delta)) continue;
    if (!byExpiry.has(iso)) byExpiry.set(iso, []);
    byExpiry.get(iso).push({
      type: cp,
      strike,
      mid,
      delta: o.delta,
      iv: o.iv,
      oi: o.open_interest,
    });
  }
  return byExpiry;
}

function daysToExpiry(iso) {
  const now = new Date();
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((Date.parse(iso) - today) / 86400000);
}

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

function expiryLabel(iso) {
  const d = new Date(iso + "T12:00:00Z");
  const dte = daysToExpiry(iso);
  return `${iso}(周${WEEKDAYS[d.getUTCDay()]} · ${dte} 天)`;
}

async function loadTicker(input) {
  const symbol = input.trim().toUpperCase().replace(/[^A-Z0-9._^]/g, "");
  if (!symbol) return;
  el.ticker.value = symbol;
  el.loadBtn.disabled = true;
  setStatus(`正在加载 ${symbol} 的期权数据…`);

  try {
    // 指数(如 SPX、VIX)在 Cboe 接口里以下划线开头,失败时自动重试
    let json;
    try {
      json = await fetchJSON(`${CBOE_BASE}${encodeURIComponent(symbol)}.json`);
    } catch (e) {
      if (/^[A-Z]+$/.test(symbol)) {
        json = await fetchJSON(`${CBOE_BASE}_${symbol}.json`);
      } else {
        throw e;
      }
    }

    const d = json.data;
    const byExpiry = parseOptions(d.options);
    if (byExpiry.size === 0) throw new Error("该代码没有可用的期权报价");

    state = {
      symbol: d.symbol.replace(/^_/, ""),
      spot: d.current_price,
      changePct: d.price_change_percent,
      timestamp: json.timestamp,
      byExpiry,
    };

    // 报价卡片
    el.qSymbol.textContent = state.symbol;
    el.qPrice.textContent = `$${state.spot.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
    const pct = state.changePct || 0;
    el.qChange.textContent = `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
    el.qChange.className = `quote-change ${pct >= 0 ? "up" : "down"}`;
    el.qMeta.textContent = `数据时间 ${state.timestamp}(美东,延迟约 15 分钟)`;
    el.quote.hidden = false;

    // 到期日下拉框,默认选最近一个 ≥7 天的到期日
    const expiries = [...byExpiry.keys()].sort().filter((e) => daysToExpiry(e) >= 0);
    el.expiry.innerHTML = "";
    for (const iso of expiries) {
      const opt = document.createElement("option");
      opt.value = iso;
      opt.textContent = expiryLabel(iso);
      el.expiry.appendChild(opt);
    }
    el.expiry.value = expiries.find((e) => daysToExpiry(e) >= 7) || expiries[0];
    el.expiry.disabled = false;

    setStatus("");
    render();
  } catch (e) {
    console.error(e);
    setStatus(
      `加载 ${symbol} 失败:${e.message || e}。请确认代码正确(仅支持有美股期权的标的),稍后再试。`,
      true
    );
  } finally {
    el.loadBtn.disabled = false;
  }
}

function buildSeries(options, type, lo, hi) {
  // 同一行权价可能有标准/周度两条报价,保留未平仓量更大的那条
  const best = new Map();
  for (const o of options) {
    if (o.type !== type || o.strike < lo || o.strike > hi) continue;
    if (Math.abs(o.delta) <= 0.0005) continue;
    const cur = best.get(o.strike);
    if (!cur || o.oi > cur.oi) best.set(o.strike, o);
  }
  return [...best.values()]
    .sort((a, b) => a.strike - b.strike)
    .map((o) => ({
      x: o.strike,
      y: (state.spot / o.mid) * Math.abs(o.delta),
      mid: o.mid,
      delta: o.delta,
      iv: o.iv,
    }));
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function render() {
  if (!state) return;
  const iso = el.expiry.value;
  const options = state.byExpiry.get(iso);
  if (!options) return;

  const pct = parseFloat(el.range.value);
  const lo = state.spot * (1 - pct);
  const hi = state.spot * (1 + pct);

  const calls = buildSeries(options, "C", lo, hi);
  const puts = buildSeries(options, "P", lo, hi);

  el.chartTitle.textContent = `${state.symbol} · ${iso} 到期 · 杠杆倍数 vs 行权价`;
  el.chartCard.hidden = false;

  const text = cssVar("--text");
  const muted = cssVar("--muted");
  const border = cssVar("--border");

  const data = {
    datasets: [
      {
        label: "Call(股价 +1% → 期权 +x%)",
        data: calls,
        borderColor: "#2563eb",
        backgroundColor: "#2563eb",
        tension: 0.25,
        pointRadius: 2.5,
        pointHoverRadius: 6,
        borderWidth: 2,
      },
      {
        label: "Put(股价 −1% → 期权 +x%)",
        data: puts,
        borderColor: "#e02424",
        backgroundColor: "#e02424",
        tension: 0.25,
        pointRadius: 2.5,
        pointHoverRadius: 6,
        borderWidth: 2,
      },
    ],
  };

  const config = {
    type: "line",
    data,
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "nearest", intersect: false },
      plugins: {
        legend: {
          labels: { color: text, usePointStyle: true, pointStyle: "circle", boxHeight: 7 },
        },
        tooltip: {
          callbacks: {
            title: (items) => `行权价 $${items[0].parsed.x}`,
            label: (item) => {
              const p = item.raw;
              return [
                `${item.dataset.label.slice(0, 4).trim()} 杠杆 ≈ ${p.y.toFixed(1)}×`,
                `中间价 $${p.mid.toFixed(2)} · Δ ${p.delta.toFixed(3)}`,
                p.iv > 0 ? `IV ${(p.iv * 100).toFixed(1)}%` : null,
              ].filter(Boolean);
            },
          },
        },
      },
      scales: {
        x: {
          type: "linear",
          title: { display: true, text: "行权价 Strike ($)", color: muted },
          ticks: { color: muted, maxTicksLimit: 10 },
          grid: { color: border },
        },
        y: {
          title: { display: true, text: "杠杆倍数(股价每变动1%,期权变动 x%)", color: muted },
          ticks: { color: muted, callback: (v) => `${v}×` },
          grid: { color: border },
          beginAtZero: true,
        },
      },
    },
  };

  if (chart) chart.destroy();
  chart = new Chart(el.canvas, config);
}

// 事件绑定
el.loadBtn.addEventListener("click", () => loadTicker(el.ticker.value));
el.ticker.addEventListener("keydown", (e) => {
  if (e.key === "Enter") loadTicker(el.ticker.value);
});
el.chips.addEventListener("click", (e) => {
  const t = e.target.dataset?.t;
  if (t) loadTicker(t);
});
el.expiry.addEventListener("change", render);
el.range.addEventListener("change", render);

// 深色/浅色模式切换时重绘
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", render);
