# OptionGraph 📈

期权杠杆可视化:**股价每变动 1%,期权价格变动百分之几**。

输入股票代码(Ticker)→ 选择行权价范围和到期日 → 自动绘制折线图:

- **横轴**:Call 期权行权价(Strike)
- **左轴(蓝线)**:杠杆倍数 = 现价 ÷ 期权中间价 × Delta
- **右轴(橙线)**:期权中间价
- 点击曲线上的点查看明细,可一键保存到页面底部的「我的收藏」,表格对比买入时与现在的倍数/价格
- 价差超过中间价 60% 的垃圾报价不参与绘图

## 数据来源

[Market Data](https://www.marketdata.app/) 免费档的**缓存行情**(真实数据,带 bid/ask 和 Delta,
但通常是最近一个收盘价,**不是实时**,也不是 15 分钟延迟)。

- 需要一个免费 token:在 marketdata.app 注册后复制,粘贴到页面左上角 ⚙ 设置里。
  token 只保存在你自己设备的浏览器 `localStorage`,不会进入代码库或上传到任何地方。
- 不设置 token 时只能查询 AAPL(服务端限制)。
- 免费额度每天 100 次请求(美东 9:30 重置)。页面会缓存响应 1 小时以节省额度;
  右上角 ↻ 会清缓存并整页重载,拿到最新行情和最新版本页面。

> 历史说明:早期版本使用 Cboe 的延迟行情经公共 CORS 代理读取。Cboe 之后为接口加了人机验证,
> 免费 CORS 代理也开始要求 API key,GitHub Actions 的服务器同样被拦,因此改用 Market Data。

## 部署

纯静态页面(`index.html` + `style.css` + `app.js`),推送到 `main` 分支后由
GitHub Actions 自动部署到 GitHub Pages(见 `.github/workflows/deploy.yml`)。

> 仓库 Settings → Pages 的 Source 需设置为 **GitHub Actions**。

## 本地运行

```bash
python3 -m http.server 8000
# 打开 http://localhost:8000
```

## 免责声明

数据与计算仅供参考,不构成投资建议。
