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
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function rangeChunk(url, idx) {
  const start = idx * CHUNK;
  return fetchText(url, {
    headers: { Range: `bytes=${start}-${start + CHUNK - 1}` },
  });
}

async function fetchChunked(url) {
  // 先单独取第一块(普通个股 2~3 块即全;也避免一上来高并发触发代理限流),
  // 大链(如 SPX ≈14MB)再以每批 3 块续传,上限 25 块 ≈22.5MB
  let text = await rangeChunk(url, 0);
  if (text.length < CHUNK) return text;
  for (let batch = 0; batch < 8; batch++) {
    const parts = await Promise.all(
      [0, 1, 2].map((i) =>
        // 超出文件末尾的块返回 416,视为结束
        rangeChunk(url, 1 + batch * 3 + i).catch(() => "")
      )
    );
    for (const part of parts) {
      text += part;
      if (part.length < CHUNK) return text;
    }
  }
  return text;
}

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

function validate(text) {
  const json = JSON.parse(text);
  if (json && json.data && Array.isArray(json.data.options)) return json;
  throw new Error("数据格式异常");
}

async function chunkedWithRetry(url) {
  // Cboe 数据每几秒更新一次,分块拼接偶尔会跨版本导致 JSON 损坏,重试一次
  try {
    return validate(await fetchChunked(url));
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
    return validate(await fetchChunked(url));
  }
}

async function fetchJSON(url) {
  // 第一梯队:直连与主代理(corsproxy 透传上游状态码)竞速
  let proxyErr;
  try {
    return await Promise.any([
      fetchText(url).then(validate),
      chunkedWithRetry(`https://corsproxy.io/?url=${encodeURIComponent(url)}`).catch(
        (e) => {
          proxyErr = e;
          throw e;
        }
      ),
    ]);
  } catch (e) {
    // 主代理透传的 403/404 说明标的不存在,无需再试备用代理
    if (proxyErr && /HTTP (403|404)/.test(proxyErr.message)) {
      throw new Error("HTTP 404");
    }
    // 第二梯队:备用代理依次尝试
    let lastErr = proxyErr || e;
    for (const proxied of [
      `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
      `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
    ]) {
      try {
        return validate(await fetchText(proxied));
      } catch (e2) {
        lastErr = e2;
      }
    }
    // 限流信息比备用代理的杂项错误更有指导意义,优先抛出
    if (proxyErr && /HTTP 429/.test(proxyErr.message)) throw proxyErr;
    throw lastErr || new Error("网络请求失败");
  }
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

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

function expiryLabel(iso) {
  const d = new Date(iso + "T12:00:00Z");
  const dte = daysToExpiry(iso);
  return `${iso}(周${WEEKDAYS[d.getUTCDay()]} · ${dte} 天)`;
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
    // 指数(如 SPX、VIX)在 Cboe 接口里以下划线开头;先按原样查,
    // 失败且为纯字母代码时再试指数形式,个股查询不浪费代理配额
    const tryForm = (s) => fetchJSON(`${CBOE_BASE}${encodeURIComponent(s)}.json`);
    const json = await tryForm(symbol).catch((e) => {
      // 429 说明代理被限流而非代码形式不对,重试指数形式只会白等
      if (/^[A-Z]+$/.test(symbol) && !/HTTP 429/.test(e.message)) {
        return tryForm(`_${symbol}`);
      }
      throw e;
    });

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
    el.expiry.value =
      (expiries.includes(savedExpiry) && savedExpiry) ||
      expiries.find((e) => daysToExpiry(e) >= 7) ||
      expiries[0];
    el.expiry.disabled = false;

    setStatus("");
    render();
  } catch (e) {
    if (seq !== loadSeq) return;
    console.error(e);
    const reason = /HTTP (403|404)/.test(e.message)
      ? "未找到该代码的期权数据,请确认是有美股期权的标的"
      : /HTTP 429/.test(e.message)
        ? "数据通道暂时繁忙,请等几秒再试"
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

// 在最优回报点上方画一颗金色 ★
const bestStarPlugin = {
  id: "bestStar",
  afterDatasetsDraw(c) {
    const { ctx, chartArea } = c;
    for (const m of c.config.options.bestMarks || []) {
      const meta = c.getDatasetMeta(m.dsIdx);
      if (meta.hidden) continue;
      const pt = meta.data[m.idx];
      if (!pt) continue;
      ctx.save();
      ctx.fillStyle = "#f59e0b";
      ctx.font = "bold 13px -apple-system, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("★", pt.x, Math.max(pt.y - 10, chartArea.top + 12));
      ctx.restore();
    }
  },
};

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

  // 回报最高 = 杠杆最高(公式已把“价格低”计入:期权价在分母)。
  // 列出前三名方便对比“价格高一点但倍数高不少”的取舍;零持仓的不参选
  const top3 = calls
    .filter((p) => p.oi >= 1)
    .sort((a, b) => b.y - a.y)
    .slice(0, 3);
  for (const p of calls) p.best = false;
  if (top3[0]) top3[0].best = true;
  const bestMarks = top3[0] ? [{ dsIdx: 0, idx: calls.indexOf(top3[0]) }] : [];

  const fmt$ = (n) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  const RANK = ["★ 最优", "次优", "第三"];
  el.bestInfo.innerHTML = top3
    .map(
      (p, i) =>
        `<span class="${i === 0 ? "rank-top" : "rank"}">${RANK[i]}</span> 行权 ${fmt$(p.x)}:期权价 ${fmt$(p.mid)},杠杆 ${p.y.toFixed(1)}×`
    )
    .join("<br>");
  el.bestInfo.hidden = !el.bestInfo.innerHTML;

  const text = cssVar("--text");
  const muted = cssVar("--muted");
  const border = cssVar("--border");
  const GOLD = "#f59e0b";

  const data = {
    datasets: [
      {
        label: "Call(股价 +1% → 期权约 +杠杆%)",
        data: calls,
        borderColor: "#2563eb",
        backgroundColor: "#2563eb",
        cubicInterpolationMode: "monotone",
        pointHoverRadius: 6,
        borderWidth: 2,
        pointRadius: (c) => (c.raw && c.raw.best ? 6 : 2.5),
        pointBackgroundColor: (c) => (c.raw && c.raw.best ? GOLD : "#2563eb"),
        pointBorderColor: (c) => (c.raw && c.raw.best ? GOLD : "#2563eb"),
      },
    ],
  };

  const config = {
    type: "line",
    data,
    plugins: [spotLinePlugin, bestStarPlugin],
    options: {
      spotPrice: state.spot,
      bestMarks,
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "nearest", intersect: false },
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
                p.best ? "★ 本范围内回报最高" : null,
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
el.chips.addEventListener("click", (e) => {
  const t = e.target.dataset?.t;
  if (t) loadTicker(t);
});
el.expiry.addEventListener("change", () => {
  store.set("og.expiry", el.expiry.value);
  render();
});
el.range.addEventListener("change", () => {
  store.set("og.range", el.range.value);
  render();
});

// 启动时恢复上次的行权价范围
const savedRange = store.get("og.range");
if (savedRange && [...el.range.options].some((o) => o.value === savedRange)) {
  el.range.value = savedRange;
}

// 深色/浅色模式切换时重绘
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", render);
