/* OptionGraph — 期权杠杆可视化
 * 数据来源: Cboe 免费延迟行情 (约延迟 15 分钟)
 * 杠杆倍数 = 现价 / 期权中间价 × Delta
 */

const CBOE_BASE = "https://cdn.cboe.com/api/global/delayed_quotes/options/";

// Cboe 的 CDN 不返回 CORS 头,需经公共 CORS 代理中转。
// 注意:期权链 JSON 普遍 1.5~2MB,corsproxy.io 免费版有 1MB 响应上限,
// 但它会透传 Range 头,所以用 Range 分块(每块 <1MB)拼出完整内容。
const CHUNK = 900000;
const PROXY = (cboeUrl) => `https://corsproxy.io/?url=${encodeURIComponent(cboeUrl)}`;

function fail(code, msg) {
  const e = new Error(msg || code);
  e.code = code;
  return e;
}

// 取一段字节,返回 {status, text};不抛 HTTP 错误,由调用方按状态码判断
async function fetchChunk(proxiedUrl, idx) {
  const start = idx * CHUNK;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(proxiedUrl, {
      headers: { Range: `bytes=${start}-${start + CHUNK - 1}` },
      signal: ctrl.signal,
    });
    return { status: res.status, text: await res.text() };
  } finally {
    clearTimeout(timer);
  }
}

// Cboe 对没有期权的代码返回 403 + XML <Error><Code>AccessDenied</Code>;
// 代理自身的限流/故障是 403(非该 XML)、429、5xx 等,两者必须区分
function classify(status, text) {
  if (status === 200 || status === 206) return "OK";
  if (status === 403 && /AccessDenied|<Error>/i.test(text)) return "NOT_FOUND";
  return "TRANSIENT";
}

const $ = (id) => document.getElementById(id);
const el = {
  ticker: $("ticker"),
  loadBtn: $("load-btn"),
  refreshBtn: $("refresh-btn"),
  chips: $("chips"),
  recentChips: $("recent-chips"),
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
  bestInfo: $("best-info"),
  canvas: $("chart"),
};

let state = null; // { symbol, spot, timestamp, byExpiry: Map<iso, option[]> }
let chart = null;

// 记住用户上次的选择(隐私模式下 localStorage 可能不可用,静默降级)
const store = {
  get(k) {
    try { return localStorage.getItem(k); } catch { return null; }
  },
  set(k, v) {
    try { localStorage.setItem(k, v); } catch {}
  },
};

function setStatus(msg, isError = false) {
  el.status.hidden = !msg;
  el.status.textContent = msg || "";
  el.status.classList.toggle("error", isError);
}

const RECENTS_MAX = 12; // 上限约 4 行,避免无限增长

function getRecents() {
  try {
    const r = JSON.parse(store.get("og.recents") || "[]");
    return Array.isArray(r) ? r : [];
  } catch {
    return [];
  }
}

function renderRecents() {
  const presets = new Set(
    [...el.chips.querySelectorAll("[data-t]")].map((b) => b.dataset.t)
  );
  // 已是预选的代码无需重复展示
  const recents = getRecents().filter((s) => !presets.has(s));
  el.recentChips.innerHTML = recents
    .map((s) => `<button class="chip recent" data-t="${s}">${s}</button>`)
    .join("");
  el.recentChips.hidden = recents.length === 0;
}

function pushRecent(sym) {
  const r = getRecents().filter((x) => x !== sym);
  r.unshift(sym);
  store.set("og.recents", JSON.stringify(r.slice(0, RECENTS_MAX)));
  renderRecents();
}

function validate(text) {
  const json = JSON.parse(text);
  if (json && json.data && Array.isArray(json.data.options)) return json;
  throw new Error("数据格式异常");
}

// 经代理分块拉取整条期权链;成功返回 JSON,失败抛带 code 的错误
async function fetchCboe(cboeUrl) {
  const proxied = PROXY(cboeUrl);
  const first = await fetchChunk(proxied, 0);
  const kind = classify(first.status, first.text);
  if (kind === "NOT_FOUND") throw fail("NOT_FOUND");
  if (kind !== "OK") throw fail("TRANSIENT", `HTTP ${first.status}`);

  let text = first.text;
  if (text.length >= CHUNK) {
    // 大链(如 SPX ≈14MB)续传,每批 3 块并行,上限 ~22MB
    let idx = 1;
    outer: for (let batch = 0; batch < 8; batch++) {
      const parts = await Promise.all(
        [0, 1, 2].map((i) =>
          fetchChunk(proxied, idx + i).catch(() => ({ status: 0, text: "" }))
        )
      );
      idx += 3;
      for (const p of parts) {
        const t = p.status === 200 || p.status === 206 ? p.text : "";
        text += t;
        if (t.length < CHUNK) break outer; // 末块(或 416/出错)即结束
      }
    }
  }
  return validate(text); // JSON 损坏抛 SyntaxError
}

async function fetchCboeRetryJson(cboeUrl) {
  // 分块拼接偶遇数据跨版本更新会坏,重试一次
  try {
    return await fetchCboe(cboeUrl);
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
    return await fetchCboe(cboeUrl);
  }
}

// 查一个代码;个股直接查,纯字母代码失败时再试指数形式(_SPX)。
// 瞬时失败(代理限流/网络)退避重试,只有所有形式都确认 NOT_FOUND 才判定不存在
async function fetchSymbol(symbol) {
  const url = (s) => `${CBOE_BASE}${encodeURIComponent(s)}.json`;
  const forms = /^[A-Z]+$/.test(symbol) ? [symbol, `_${symbol}`] : [symbol];
  for (let attempt = 0; attempt < 3; attempt++) {
    let everyFormNotFound = true;
    for (const form of forms) {
      try {
        return await fetchCboeRetryJson(url(form));
      } catch (e) {
        if (e.code === "NOT_FOUND") continue; // 该形式没有,试下一形式
        everyFormNotFound = false; // 瞬时/网络问题,值得重试
      }
    }
    if (everyFormNotFound) throw fail("NOT_FOUND");
    await new Promise((r) => setTimeout(r, 500 * (attempt + 1))); // 退避
  }
  throw fail("BUSY");
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
    // bid=0(无买盘)或买卖价倒挂的报价不可靠,剔除
    if (!(o.bid > 0) || !(o.ask >= o.bid) || !isFinite(o.delta)) continue;
    if (!byExpiry.has(iso)) byExpiry.set(iso, []);
    byExpiry.get(iso).push({
      type: cp,
      strike,
      mid,
      bid: o.bid,
      ask: o.ask,
      delta: o.delta,
      iv: o.iv,
      oi: o.open_interest,
    });
  }
  return byExpiry;
}

// 期权按美东日历日到期;亚洲用户在美股盘中本地日期可能已是“翌日”,
// 若按本地日期算,当日到期的合约会被误判为已过期,故一律取美东日期。
// 用 formatToParts 取数,不依赖任何 locale 的日期字符串格式
const ET_DATE = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" });

function etTodayMs() {
  const p = {};
  for (const part of ET_DATE.formatToParts(new Date())) p[part.type] = part.value;
  return Date.UTC(+p.year, +p.month - 1, +p.day);
}

function daysToExpiry(iso) {
  return Math.round((Date.parse(iso) - etTodayMs()) / 86400000);
}

function expiryLabel(iso) {
  return `${iso}(剩 ${daysToExpiry(iso)} 天)`;
}

let loadSeq = 0;

async function loadTicker(input) {
  // 中文输入法常打出全角字母(ＡＡＰＬ),先归一化为半角
  const symbol = input
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9._]/g, "");
  if (!symbol) {
    setStatus(
      input.trim()
        ? "请输入有效的美股代码(英文字母,如 AAPL)。"
        : "请先输入股票代码,或点击下方的快捷标签。",
      true
    );
    return;
  }
  const seq = ++loadSeq; // 防止连续查询时慢的旧响应覆盖新结果
  el.ticker.value = symbol;
  el.ticker.blur(); // 收起手机键盘,把屏幕留给图表
  el.loadBtn.disabled = true;
  setStatus(`正在加载 ${symbol} 的期权数据…`);

  try {
    const json = await fetchSymbol(symbol);

    if (seq !== loadSeq) return;

    const d = json.data;
    if (!(d.current_price > 0)) throw new Error("该标的暂无现价数据(可能已停牌)");
    const byExpiry = parseOptions(d.options);
    const expiries = [...byExpiry.keys()].sort().filter((e) => daysToExpiry(e) >= 0);
    if (expiries.length === 0) throw new Error("该代码没有可用的期权报价");

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
    // Cboe 的 timestamp 是 UTC,转成用户本地时间显示
    const ts = new Date(state.timestamp.replace(" ", "T") + "Z");
    el.qMeta.textContent = isNaN(ts)
      ? `数据时间 ${state.timestamp}(延迟约 15 分钟)`
      : `数据时间 ${ts.toLocaleString("zh-CN", { hour12: false })}(本地时间,延迟约 15 分钟)`;
    el.quote.hidden = false;

    // 到期日下拉框;优先用上次手选的到期日,否则选最近一个 ≥7 天的
    el.expiry.innerHTML = "";
    for (const iso of expiries) {
      const opt = document.createElement("option");
      opt.value = iso;
      opt.textContent = expiryLabel(iso);
      el.expiry.appendChild(opt);
    }
    const savedExpiry = store.get("og.expiry");
    const DEFAULT_EXPIRY = "2027-01-15"; // 默认偏好的 LEAPS 到期日
    el.expiry.value =
      (expiries.includes(savedExpiry) && savedExpiry) ||
      (expiries.includes(DEFAULT_EXPIRY) && DEFAULT_EXPIRY) ||
      expiries.find((e) => daysToExpiry(e) >= 7) ||
      expiries[0];
    el.expiry.disabled = false;

    pushRecent(state.symbol);
    history.replaceState(null, "", `#${state.symbol}`);
    setStatus("");
    render();
  } catch (e) {
    if (seq !== loadSeq) return;
    console.error(e);
    const reason =
      e.code === "NOT_FOUND"
        ? "未找到该代码的期权数据,请确认是有美股期权的标的"
        : e.code === "BUSY"
          ? "数据通道繁忙,请过几秒再试一次"
          : e instanceof TypeError || e.name === "AbortError"
            ? "网络连接失败,请检查网络后重试"
            : `${e.message || e},稍后再试`;
    setStatus(`加载 ${symbol} 失败:${reason}。`, true);
  } finally {
    if (seq === loadSeq) el.loadBtn.disabled = false;
  }
}

function buildSeries(options, type, lo, hi) {
  // 同一行权价可能有标准/周度两条报价,保留未平仓量更大的那条
  const best = new Map();
  for (const o of options) {
    if (o.type !== type || o.strike < lo || o.strike > hi) continue;
    if (Math.abs(o.delta) <= 0.0005) continue;
    // 价差过宽(>中间价 60%)的报价没有参考价值,画出来只会让曲线锯齿交叠
    if ((o.ask - o.bid) / o.mid > 0.6) continue;
    const cur = best.get(o.strike);
    if (!cur || o.oi > cur.oi) best.set(o.strike, o);
  }
  return [...best.values()]
    .sort((a, b) => a.strike - b.strike)
    .map((o) => ({
      x: o.strike,
      y: (state.spot / o.mid) * Math.abs(o.delta),
      mid: o.mid,
      bid: o.bid,
      ask: o.ask,
      delta: o.delta,
      iv: o.iv,
      oi: o.oi,
    }));
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

const fmt$ = (n) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

// 点击曲线上的点时,在标题下显示该行权价的明细
function showTappedPoint(p) {
  el.bestInfo.innerHTML =
    `行权 <b>${fmt$(p.x)}</b> · 期权价 ${fmt$(p.mid)}` +
    `(买 ${fmt$(p.bid)} / 卖 ${fmt$(p.ask)})· ` +
    `杠杆 <b class="rank-top">${p.y.toFixed(1)}×</b>` +
    (p.iv > 0 ? ` · IV ${(p.iv * 100).toFixed(1)}%` : "");
  el.bestInfo.hidden = false;
}

// 在图上画一条「现价」竖虚线,方便定位平值位置
const spotLinePlugin = {
  id: "spotLine",
  afterDatasetsDraw(c) {
    const spot = c.config.options.spotPrice;
    const { ctx, chartArea, scales } = c;
    if (!spot || spot < scales.x.min || spot > scales.x.max) return;
    const x = scales.x.getPixelForValue(spot);
    ctx.save();
    ctx.strokeStyle = cssVar("--muted");
    ctx.setLineDash([5, 5]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, chartArea.top);
    ctx.lineTo(x, chartArea.bottom);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = cssVar("--muted");
    ctx.font = "11px -apple-system, sans-serif";
    ctx.textAlign = x > (chartArea.left + chartArea.right) / 2 ? "right" : "left";
    const pad = ctx.textAlign === "right" ? -6 : 6;
    ctx.fillText(`现价 $${spot.toLocaleString("en-US", { maximumFractionDigits: 2 })}`, x + pad, chartArea.top + 12);
    ctx.restore();
  },
};

function render() {
  if (!state) return;
  if (typeof Chart === "undefined") {
    setStatus("图表库加载失败,请检查网络后刷新页面。", true);
    return;
  }
  const iso = el.expiry.value;
  const options = state.byExpiry.get(iso);
  if (!options) return;

  const pct = parseFloat(el.range.value);
  const lo = state.spot * (1 - pct);
  const hi = state.spot * (1 + pct);

  const calls = buildSeries(options, "C", lo, hi);

  if (!calls.length) {
    setStatus("该到期日在所选行权价范围内没有有效报价,试试扩大行权价范围。");
  } else if (!el.status.classList.contains("error")) {
    setStatus("");
  }

  el.chartTitle.textContent = `${state.symbol} · ${iso} 到期(剩 ${daysToExpiry(iso)} 天)· Call 杠杆倍数 vs 行权价`;
  el.chartCard.hidden = false;
  // 明细区只在用户点击某个点后显示
  el.bestInfo.hidden = true;
  el.bestInfo.innerHTML = "";

  const text = cssVar("--text");
  const muted = cssVar("--muted");
  const border = cssVar("--border");

  const data = {
    datasets: [
      {
        label: "Call(股价 +1% → 期权约 +杠杆%)",
        data: calls,
        borderColor: "#2563eb",
        backgroundColor: "#2563eb",
        cubicInterpolationMode: "monotone",
        pointRadius: 2.5,
        pointHoverRadius: 6,
        borderWidth: 2,
      },
    ],
  };

  const config = {
    type: "line",
    data,
    plugins: [spotLinePlugin],
    options: {
      spotPrice: state.spot,
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "nearest", intersect: false },
      onClick: (evt, els, ch) => {
        const hit = ch.getElementsAtEventForMode(evt, "nearest", { intersect: false }, true);
        if (hit.length) showTappedPoint(ch.data.datasets[hit[0].datasetIndex].data[hit[0].index]);
      },
      plugins: {
        legend: {
          labels: { color: text, usePointStyle: true, pointStyle: "circle", boxHeight: 7 },
        },
        tooltip: {
          callbacks: {
            title: (items) => `行权价 $${items[0].parsed.x.toLocaleString("en-US")}`,
            label: (item) => {
              const p = item.raw;
              return [
                `杠杆 ≈ ${p.y.toFixed(1)}×(股价 +1% → 期权约 +${p.y.toFixed(1)}%)`,
                `中间价 $${p.mid.toFixed(2)}(买 $${p.bid.toFixed(2)} / 卖 $${p.ask.toFixed(2)})`,
                `Δ ${p.delta.toFixed(3)}` + (p.iv > 0 ? ` · IV ${(p.iv * 100).toFixed(1)}%` : ""),
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
  // isComposing:输入法选字时的回车不算提交
  if (e.key === "Enter" && !e.isComposing) loadTicker(el.ticker.value);
});
const onChipClick = (e) => {
  const t = e.target.dataset?.t;
  if (t) loadTicker(t);
};
el.chips.addEventListener("click", onChipClick);
el.recentChips.addEventListener("click", onChipClick);

// 刷新:iOS 主屏 App 没有浏览器刷新栏,重新拉取当前代码的最新数据;
// 还没查过任何代码时,直接重载页面(也能顺带取到新版本)
el.refreshBtn.addEventListener("click", async () => {
  if (!state) {
    location.reload();
    return;
  }
  el.refreshBtn.classList.add("spin");
  try {
    await loadTicker(state.symbol);
  } finally {
    el.refreshBtn.classList.remove("spin");
  }
});
el.expiry.addEventListener("change", () => {
  store.set("og.expiry", el.expiry.value);
  render();
});
el.range.addEventListener("change", () => {
  store.set("og.range", el.range.value);
  render();
});

// 启动时恢复上次的行权价范围与最近查询
const savedRange = store.get("og.range");
if (savedRange && [...el.range.options].some((o) => o.value === savedRange)) {
  el.range.value = savedRange;
}
renderRecents();

// 深色/浅色模式切换时重绘
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", render);

// 网址直达:打开 …/#TSLA 自动查询;查询成功后把代码写回地址栏方便收藏
function applyHash() {
  const h = decodeURIComponent(location.hash.slice(1)).trim().toUpperCase();
  if (h && (!state || h !== state.symbol)) loadTicker(h);
}
window.addEventListener("hashchange", applyHash);
applyHash();
