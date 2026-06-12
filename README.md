# OptionGraph 📈

期权杠杆可视化:**股价每变动 1%,期权价格变动百分之几**。

输入股票代码(Ticker)→ 选择到期日 → 自动绘制折线图:

- **横轴**:Call 期权行权价(Strike)
- **纵轴**:杠杆倍数 = 现价 ÷ 期权中间价 × Delta
- 金色 ★ 标出回报最高的合约,并列出前三名供对比;
  价差超过中间价 60% 的垃圾报价不参与绘图

## 数据来源

[Cboe 免费延迟行情 API](https://www.cboe.com/delayed_quotes/)(真实市场数据,约延迟 15 分钟),
包含 bid/ask 与希腊字母(Delta、IV 等),无需 API key。
由于 Cboe 接口不带 CORS 头,前端经公共 CORS 代理中转:直连与
corsproxy.io(Range 分块绕过其 1MB 上限)竞速,失败再退到备用代理。

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
