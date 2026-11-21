/* OptionGraph — 期权杠杆可视化
 * 数据来源: Market Data (marketdata.app) 免费缓存行情,使用用户自己的免费 token
 * 杠杆倍数 = 现价 / 期权中间价 × Delta
 */

const MD_BASE = "https://api.marketdata.app/v1";

function fail(code, msg) {
  const e = new Error(msg || code);
  e.code = code;
  return e;
}

// 记住用户的选择(隐私模式下 localStorage 可能不可用,静默降级)
const store = {
  get(k) {
    try { return localStorage.getItem(k); } catch { return null; }
  },
  set(k, v) {
    try { localStorage.setItem(k, v); } catch {}
  },
  remove(k) {
    try { localStorage.removeItem(k); } catch {}
  },
};

const getToken = () => (store.get("og.token") || "").trim();

// ── 数据源:Market Data API ──────────────────────────────────────
// 返回 JSON;失败抛带 code 的错误:
// NEED_TOKEN(未设置 token 且该代码需要 token)、BAD_TOKEN、NOT_FOUND、
// QUOTA(限流/额度用完)、NETWORK(网络/超时/5xx,已自动重试)、API(其他服务端提示)
async function mdGet(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = `${MD_BASE}${path}${qs ? "?" + qs : ""}`;
  const token = getToken();
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetch(url, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: ctrl.signal,
      });
      let body = null;
      try { body = await res.json(); } catch {}
      // 200 = 实时,203 = 缓存数据(免费档),都是成功
      if (res.status === 200 || res.status === 203) {
        if (body && body.s === "ok") return body;
        if (body && body.s === "no_data") throw fail("NOT_FOUND");
        throw fail("API", "数据格式异常");
      }
      if (res.status === 401 || res.status === 403) throw fail(token ? "BAD_TOKEN" : "NEED_TOKEN");
      if (res.status === 404) throw fail("NOT_FOUND");
      if (res.status === 429) throw fail("QUOTA");
      if (res.status >= 500) {
        lastErr = fail("NETWORK", `数据源暂时不可用(HTTP ${res.status})`);
      } else {
        const msg = (body && body.errmsg) || `HTTP ${res.status}`;
        throw fail(/symbol|underlying|no data|not found/i.test(msg) ? "NOT_FOUND" : "API", msg);
      }
    } catch (e) {
      if (e.code && e.code !== "NETWORK") throw e; // 明确的业务错误,不重试
      lastErr = e.code
        ? e
        : fail("NETWORK", e.name === "AbortError" ? "请求超时" : "网络连接失败");
    } finally {
      clearTimeout(timer);
    }
    await new Promise((r) => setTimeout(r, 600 * (attempt + 1))); // 退避后重试
  }
  throw lastErr || fail("NETWORK", "网络连接失败");
}

// 响应缓存:免费档本身就是缓存行情,同一数据短时间内重复请求只会白白消耗每日额度
const CACHE_KEY = "og.cache";
const CACHE_TTL = 60 * 60 * 1000;
const CACHE_MAX = 24;

function cacheRead() {
  try { return JSON.parse(store.get(CACHE_KEY) || "{}") || {}; } catch { return {}; }
}
function cacheGet(k) {
  const c = cacheRead()[k];
  return c && Date.now() - c.t < CACHE_TTL ? c.v : null;
}
function cacheSet(k, v) {
  const c = cacheRead();
  c[k] = { t: Date.now(), v };
  const keys = Object.keys(c).sort((a, b) => c[b].t - c[a].t);
  for (const old of keys.slice(CACHE_MAX)) delete c[old];
  store.set(CACHE_KEY, JSON.stringify(c));
}

async function mdExpirations(symbol) {
  const key = `exp|${symbol}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  const body = await mdGet(`/options/expirations/${encodeURIComponent(symbol)}/`);
  const list = Array.isArray(body.expirations) ? body.expirations : [];
  cacheSet(key, list);
  return list;
}

// 一个到期日的 call 期权链 → { spot, updated(ms), options:[{strike,mid,bid,ask,delta,iv,oi}] }
async function mdChain(symbol, iso) {
  const key = `chain|${symbol}|${iso}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  const j = await mdGet(`/options/chain/${encodeURIComponent(symbol)}/`, {
    expiration: iso,
    side: "call",
  });
  const n = (j.strike || []).length;
  const spot = (j.underlyingPrice || []).find((x) => Number.isFinite(x) && x > 0);
  if (!spot) throw fail("API", "该标的暂无现价数据");
  const options = [];
  let updated = 0;
  for (let i = 0; i < n; i++) {
    const bid = j.bid[i], ask = j.ask[i], delta = j.delta[i], strike = j.strike[i];
    const u = (j.updated || [])[i];
    if (Number.isFinite(u) && u > updated) updated = u;
    // bid=0(无买盘)、买卖价倒挂或缺 Delta 的报价不可靠,剔除
    if (!(bid > 0) || !(ask >= bid) || !Number.isFinite(delta) || !Number.isFinite(strike)) continue;
    options.push({
      strike,
      mid: (bid + ask) / 2,
      bid,
      ask,
      delta,
      iv: Number.isFinite((j.iv || [])[i]) ? j.iv[i] : 0,
      oi: (j.openInterest || [])[i] || 0,
    });
  }
  const chain = { spot, updated: updated * 1000, options };
  cacheSet(key, chain);
  return chain;
}

const $ = (id) => document.getElementById(id);
const el = {
  ticker: $("ticker"),
  loadBtn: $("load-btn"),
  refreshBtn: $("refresh-btn"),
  settingsBtn: $("settings-btn"),
  settingsCard: $("settings-card"),
  tokenInput: $("token-input"),
  tokenSave: $("token-save"),
  tokenClear: $("token-clear"),
  tokenState: $("token-state"),
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
  watchlistCard: $("watchlist-card"),
  watchlistBody: $("watchlist-body"),
};

// state = { symbol, expiries: [iso], chains: Map<iso, chain>, shown: iso }
let state = null;
let chart = null;

function setStatus(msg, isError = false) {
  el.status.hidden = !msg;
  el.status.textContent = msg || "";
  el.status.classList.toggle("error", isError);
}

// 把错误翻译成用户能看懂的话(需要设置 token 时顺手打开设置面板)
function describeError(e, symbol) {
  switch (e.code) {
    case "NEED_TOKEN":
      openSettings();
      return `${symbol} 需要先设置数据源 token:请在上方设置里粘贴 marketdata.app 的免费 token(不设置只能查询 AAPL)`;
    case "BAD_TOKEN":
      openSettings();
      return "token 无效或已过期,请在上方设置里重新粘贴";
    case "NOT_FOUND":
      return `未找到 ${symbol} 的期权数据,请确认是有美股期权的标的`;
    case "QUOTA":
      return "免费额度已用完(每天 100 次,美东 9:30 重置)或请求过快,请稍后再试";
    default:
      return `${e.message || e},稍后再试`;
  }
}

// ── 设置(数据源 token)───────────────────────────────────────────
function renderTokenState(msg) {
  const t = getToken();
  el.tokenState.textContent =
    msg || (t ? `当前:已设置(••••${t.slice(-4)})` : "当前:未设置(不设置只能查询 AAPL)");
  el.tokenClear.hidden = !t;
}

function openSettings() {
  el.settingsCard.hidden = false;
  renderTokenState();
}

el.settingsBtn.addEventListener("click", () => {
  if (el.settingsCard.hidden) {
    openSettings();
    if (!getToken()) el.tokenInput.focus();
  } else {
    el.settingsCard.hidden = true;
  }
});

async function saveToken() {
  const v = el.tokenInput.value.trim();
  if (!v) return renderTokenState("请先粘贴 token");
  if (/\s/.test(v)) return renderTokenState("token 里不应包含空格或换行,请重新复制");
  store.set("og.token", v);
  store.remove(CACHE_KEY); // 旧 token 下的缓存不再可信
  el.tokenInput.value = "";
  el.tokenSave.disabled = true;
  renderTokenState("正在验证 token…");
  try {
    // 用 AAPL 验证:带了错误 token 时服务器会明确返回 401(无 token 才会放行 AAPL)
    await mdGet("/options/expirations/AAPL/");
    renderTokenState(`✓ token 有效,已保存(••••${v.slice(-4)})`);
    setTimeout(() => {
      el.settingsCard.hidden = true;
      if (el.ticker.value.trim()) loadTicker(el.ticker.value);
    }, 900);
  } catch (e) {
    if (e.code === "BAD_TOKEN") {
      store.remove("og.token");
      renderTokenState("✗ token 无效,请检查后重新粘贴");
    } else {
      renderTokenState(`已保存,但暂时无法验证:${e.message}`);
    }
  } finally {
    el.tokenSave.disabled = false;
  }
}
el.tokenSave.addEventListener("click", saveToken);
el.tokenInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.isComposing) saveToken();
});
el.tokenClear.addEventListener("click", () => {
  store.remove("og.token");
  store.remove(CACHE_KEY);
  renderTokenState();
});

// ── 最近查询 ────────────────────────────────────────────────────
const RECENTS_MAX = 20; // 上限约 5 行,超出时淘汰最久没查的

function getRecents() {
  try {
    const r = JSON.parse(store.get("og.recents") || "[]");
    return Array.isArray(r) ? r : [];
  } catch {
    return [];
  }
}

function renderRecents() {
  // 存储按查询时间排序(便于淘汰最旧),展示按字母排序
  const recents = [...getRecents()].sort();
  el.recentChips.innerHTML = recents
    .map((s) => `<button class="chip" data-t="${s}">${s}</button>`)
    .join("");
  el.recentChips.hidden = recents.length === 0;
}

function pushRecent(sym) {
  const r = getRecents().filter((x) => x !== sym);
  r.unshift(sym); // 最新的放最前,裁剪时保留最近 RECENTS_MAX 个
  store.set("og.recents", JSON.stringify(r.slice(0, RECENTS_MAX)));
  renderRecents();
}

// ── 收藏(watchlist)─────────────────────────────────────────────
function getWatch() {
  try {
    const w = JSON.parse(store.get("og.watch") || "[]");
    return Array.isArray(w) ? w : [];
  } catch {
    return [];
  }
}
function setWatch(w) {
  store.set("og.watch", JSON.stringify(w));
}
function watchKey(o) {
  return `${o.symbol}|${o.expiry}|${o.strike}`;
}
function isSaved(o) {
  const k = watchKey(o);
  return getWatch().some((x) => watchKey(x) === k);
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
        : "请先输入股票代码,例如 AAPL。",
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
    const all = await mdExpirations(symbol);
    if (seq !== loadSeq) return;
    const expiries = [...all].filter((e) => daysToExpiry(e) >= 0).sort();
    if (expiries.length === 0) throw fail("NOT_FOUND");

    // 优先用上次手选的到期日,其次 2027-01-15,再次最近一个 ≥7 天的
    const savedExpiry = store.get("og.expiry");
    const DEFAULT_EXPIRY = "2027-01-15";
    const iso =
      (expiries.includes(savedExpiry) && savedExpiry) ||
      (expiries.includes(DEFAULT_EXPIRY) && DEFAULT_EXPIRY) ||
      expiries.find((e) => daysToExpiry(e) >= 7) ||
      expiries[0];

    const chain = await mdChain(symbol, iso);
    if (seq !== loadSeq) return;

    // 全部成功后才更新界面状态,失败时不会出现「报价卡是新代码、图表是旧代码」
    state = { symbol, expiries, chains: new Map([[iso, chain]]), shown: iso };
    el.expiry.innerHTML = "";
    for (const e of expiries) {
      const opt = document.createElement("option");
      opt.value = e;
      opt.textContent = expiryLabel(e);
      el.expiry.appendChild(opt);
    }
    el.expiry.value = iso;
    el.expiry.disabled = false;

    pushRecent(symbol);
    history.replaceState(null, "", `#${symbol}`);
    setStatus("");
    render();
  } catch (e) {
    if (seq !== loadSeq) return;
    console.error(e);
    setStatus(`加载 ${symbol} 失败:${describeError(e, symbol)}`, true);
  } finally {
    if (seq === loadSeq) el.loadBtn.disabled = false;
  }
}

// 切换到期日:没加载过的到期日按需拉取(一次请求);失败则回退到原来显示的到期日
let expirySeq = 0;
async function onExpiryChange() {
  const iso = el.expiry.value;
  store.set("og.expiry", iso);
  if (!state) return;
  if (!state.chains.has(iso)) {
    const sym = state.symbol;
    const my = ++expirySeq;
    setStatus(`正在加载 ${iso} 的报价…`);
    try {
      const chain = await mdChain(sym, iso);
      if (!state || state.symbol !== sym || my !== expirySeq) return;
      state.chains.set(iso, chain);
      setStatus("");
    } catch (e) {
      if (my !== expirySeq || !state) return;
      el.expiry.value = state.shown;
      setStatus(`加载 ${iso} 失败:${describeError(e, sym)}`, true);
      return;
    }
  }
  render();
}

function buildSeries(options, lo, hi, spot) {
  // 同一行权价可能有多条报价,保留未平仓量更大的那条
  const best = new Map();
  for (const o of options) {
    if (o.strike < lo || o.strike > hi) continue;
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
      y: (spot / o.mid) * Math.abs(o.delta),
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

// 报价卡:现价取自当前到期日这份数据(与期权价同一时刻,杠杆才算得准)
function showQuote(symbol, chain) {
  el.qSymbol.textContent = symbol;
  el.qPrice.textContent = fmt$(chain.spot);
  el.qChange.textContent = "";
  el.qChange.className = "quote-change";
  const ts = new Date(chain.updated);
  el.qMeta.textContent =
    !chain.updated || isNaN(ts)
      ? "免费缓存行情,通常是最近一个收盘价,非实时"
      : `数据截至 ${ts.toLocaleString("zh-CN", { hour12: false })}(本地时间)· 免费缓存行情,通常是最近一个收盘价,非实时`;
  el.quote.hidden = false;
}

let tappedOption = null; // 当前点中的期权,供「保存」按钮使用

// 点击曲线上的点时,在图表下方显示该行权价的明细,并提供保存按钮
function showTappedPoint(p) {
  tappedOption = {
    symbol: state.symbol,
    expiry: state.shown,
    strike: p.x,
    buyLev: p.y,
    buyPrice: p.mid,
  };
  const saved = isSaved(tappedOption);
  el.bestInfo.innerHTML =
    `<span>行权 <b>${fmt$(p.x)}</b> · 期权价 ${fmt$(p.mid)} · ` +
    `杠杆 <b class="rank-top">${p.y.toFixed(1)}×</b></span>` +
    `<button class="save-btn${saved ? " saved" : ""}" id="save-opt">${saved ? "✓ 已收藏" : "＋ 保存"}</button>`;
  el.bestInfo.hidden = false;
}

// 收藏「现在」列:同一(代码,到期日)只请求一次,优先复用已加载/已缓存的数据
async function fetchChainFor(symbol, iso) {
  if (state && state.symbol === symbol && state.chains.has(iso)) {
    return state.chains.get(iso);
  }
  return mdChain(symbol, iso);
}

// 在链中找匹配的 call,返回当前 {lev, price}
function currentFor(chain, item) {
  const o = chain.options.find((x) => x.strike === item.strike);
  if (!o) return null;
  return { lev: (chain.spot / o.mid) * Math.abs(o.delta), price: o.mid };
}

let wlCurrent = {}; // watchKey -> {lev, price} | {err:true};仅内存,不持久化
let wlRefreshing = false;

function renderWatchlist() {
  const w = getWatch();
  el.watchlistCard.hidden = w.length === 0;
  el.watchlistBody.innerHTML = w
    .map((o, i) => {
      const c = wlCurrent[watchKey(o)];
      let cur;
      if (!c) cur = "…";
      else if (c.err) cur = "—";
      else {
        const cls = c.price > o.buyPrice ? "up" : c.price < o.buyPrice ? "down" : "";
        cur = `<span class="num-lev">${c.lev.toFixed(1)}×</span><br><span class="num-price ${cls}">${fmt$(c.price)}</span>`;
      }
      return `<tr>
        <td class="opt"><span class="opt-sym">${o.symbol}</span> $${o.strike}C<br><span class="opt-sub">${o.expiry}</span></td>
        <td>${o.date}</td>
        <td><span class="num-lev">${o.buyLev.toFixed(1)}×</span><br><span class="num-price">${fmt$(o.buyPrice)}</span></td>
        <td>${cur}</td>
        <td><button class="wl-del" data-i="${i}" aria-label="删除">×</button></td>
      </tr>`;
    })
    .join("");
}

async function refreshWatchlistCurrent() {
  const w = getWatch();
  if (!w.length || wlRefreshing) return;
  wlRefreshing = true;
  try {
    const groups = new Map();
    for (const o of w) {
      const k = `${o.symbol}|${o.expiry}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(o);
    }
    let stop = false; // token 缺失/失效或额度用完时,别再白发请求
    for (const [k, items] of groups) {
      const [sym, iso] = k.split("|");
      let chain = null;
      if (!stop && daysToExpiry(iso) >= 0) {
        try {
          chain = await fetchChainFor(sym, iso);
        } catch (e) {
          if (["NEED_TOKEN", "BAD_TOKEN", "QUOTA"].includes(e.code)) stop = true;
        }
      }
      for (const o of items) {
        wlCurrent[watchKey(o)] = (chain && currentFor(chain, o)) || { err: true };
      }
      renderWatchlist();
    }
  } finally {
    wlRefreshing = false;
  }
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
  const chainData = state.chains.get(iso);
  if (!chainData) return;
  state.shown = iso;
  const spot = chainData.spot;
  showQuote(state.symbol, chainData);

  const pct = parseFloat(el.range.value);
  const lo = spot * (1 - pct);
  const hi = spot * (1 + pct);

  const calls = buildSeries(chainData.options, lo, hi, spot);

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
        label: "杠杆倍数(左轴)",
        data: calls,
        yAxisID: "y",
        borderColor: "#2563eb",
        backgroundColor: "#2563eb",
        cubicInterpolationMode: "monotone",
        pointRadius: 2.5,
        pointHoverRadius: 6,
        borderWidth: 2,
      },
      {
        label: "期权中间价(右轴)",
        data: calls, // 同一组数据,y 取 mid 字段
        parsing: { xAxisKey: "x", yAxisKey: "mid" },
        yAxisID: "y1",
        borderColor: "#f59e0b",
        backgroundColor: "#f59e0b",
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
      spotPrice: spot,
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
          position: "left",
          title: { display: true, text: "杠杆倍数(股价每涨1%,期权涨 x%)", color: "#2563eb" },
          ticks: { color: "#2563eb", callback: (v) => `${v}×` },
          grid: { color: border },
          beginAtZero: true,
        },
        y1: {
          position: "right",
          title: { display: true, text: "期权中间价 ($)", color: "#f59e0b" },
          ticks: { color: "#f59e0b", callback: (v) => `$${v}` },
          grid: { drawOnChartArea: false }, // 不画第二套网格线,避免与左轴重叠杂乱
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
el.recentChips.addEventListener("click", (e) => {
  const t = e.target.dataset?.t;
  if (t) loadTicker(t);
});

// 保存当前点中的期权到收藏
el.bestInfo.addEventListener("click", (e) => {
  if (e.target.id !== "save-opt" || !tappedOption) return;
  const w = getWatch();
  if (w.some((x) => watchKey(x) === watchKey(tappedOption))) return; // 已收藏
  w.push({
    symbol: tappedOption.symbol,
    expiry: tappedOption.expiry,
    strike: tappedOption.strike,
    date: new Date().toLocaleDateString("en-CA"), // 本地日期
    buyLev: tappedOption.buyLev,
    buyPrice: tappedOption.buyPrice,
  });
  setWatch(w);
  wlCurrent[watchKey(tappedOption)] = { lev: tappedOption.buyLev, price: tappedOption.buyPrice };
  e.target.textContent = "✓ 已收藏";
  e.target.classList.add("saved");
  renderWatchlist();
});

// 删除收藏
el.watchlistBody.addEventListener("click", (e) => {
  const i = e.target.dataset?.i;
  if (i === undefined) return;
  const w = getWatch();
  w.splice(+i, 1);
  setWatch(w);
  renderWatchlist();
});

// 刷新:iOS 主屏 App 没有浏览器刷新栏。必须整页重载才能拿到新版本代码,
// 仅重新跑内存里的旧 JS 看不到任何新功能。带时间戳绕过缓存,清掉数据缓存拿最新行情,
// 用 hash 保留当前代码,重载后自动重新查询。
el.refreshBtn.addEventListener("click", () => {
  el.refreshBtn.classList.add("spin");
  store.remove(CACHE_KEY);
  const hash = state ? `#${state.symbol}` : location.hash;
  location.replace(`${location.pathname}?t=${Date.now()}${hash}`);
});
el.expiry.addEventListener("change", onExpiryChange);
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
renderWatchlist();
refreshWatchlistCurrent();

// 深色/浅色模式切换时重绘
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", render);

// 网址直达:打开 …/#TSLA 自动查询;查询成功后把代码写回地址栏方便收藏
function applyHash() {
  let h = "";
  try {
    h = decodeURIComponent(location.hash.slice(1)).trim().toUpperCase();
  } catch {
    return; // 畸形 hash(如 #%)忽略
  }
  if (h && (!state || h !== state.symbol)) loadTicker(h);
}
window.addEventListener("hashchange", applyHash);
applyHash();
