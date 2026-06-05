# 我的持仓看板

一个独立于 `tool-box` 根目录的子项目，用来替代每天打开行情软件手动查看持仓表现。你可以在浏览器中录入自己的持仓数量和成本价，页面会通过本地 Node 服务读取实时行情，计算总成本、最新市值、今日已盈亏、总盈亏和收益率。

## 功能

- 录入 / 编辑 / 删除持仓，字段包含股票代码、股票名称、持仓数量、成本价。
- 支持自动补全常见 A 股代码后缀：`600519` → `600519.SH`、`000001` → `000001.SZ`。
- 汇总展示最新市值、今日已盈亏（基于昨日收盘价）、总盈亏（基于成本价）和总收益率。
- 支持手动“立即刷新”和默认每 60 秒自动刷新，并显示上次刷新时间。
- 使用浏览器 `localStorage` 保存持仓，不需要数据库。
- 默认直接实现 Tushare `realtime_quote` 对应的爬虫实时行情源，不再把 `realtime_quote` 当作 Pro HTTP `api_name` 发送到 `api.tushare.pro`。
- 如需使用 Tushare Pro HTTP，可切换到 `TUSHARE_QUOTE_SOURCE=pro` 并配置一个真实可用的 Pro HTTP API。

## 本地运行

```bash
cd stock-portfolio
cp .env.prod.example .env.prod
# 默认配置不需要 Token；如需自定义行情源，编辑 .env.prod
npm start
```

打开 <http://localhost:4173> 即可使用。服务启动时会自动读取 `.env`、按 `NODE_ENV` 匹配的 `.env.<NODE_ENV>` 以及 `.env.prod`；真实 Token 如果用于 Pro HTTP 模式，建议只写在本机的 `.env.prod`，该文件不会提交到 Git。

## 环境变量

| 变量 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `TUSHARE_QUOTE_SOURCE` | 否 | `sina` | 行情源。`sina` 为默认爬虫实时源；`pro` 为 Tushare Pro HTTP 模式 |
| `TUSHARE_REALTIME_ENDPOINT` | 否 | `https://hq.sinajs.cn/list=` | `sina` 模式的实时行情 endpoint，可用 `{symbols}` 占位符自定义 URL |
| `TUSHARE_TOKEN` | 仅 `pro` 模式必填 | 无 | Tushare Pro Token |
| `TUSHARE_API_NAME` | 仅 `pro` 模式必填 | 无 | Tushare Pro HTTP API 名称；不要填 `realtime_quote` |
| `TUSHARE_ENDPOINT` | 否 | `http://api.tushare.pro` | Tushare Pro HTTP Endpoint，仅 `pro` 模式使用 |
| `PORT` | 否 | `4173` | 本地服务端口 |

## Token 文件建议

- 默认 `sina` 实时行情模式不需要 Token；如果你要调用 Tushare Pro HTTP，再把 Token 写入 `stock-portfolio/.env.prod`。
- 仓库只保留 `.env.prod.example` 模板；`.env.prod` 已加入 `.gitignore`，避免把真实 Token 泄露到 Git 历史。
- 如果系统环境变量里已经设置了同名变量，会优先使用系统环境变量，不会被 `.env.prod` 覆盖。

## 注意事项

- Tushare 文档里的 `realtime_quote` 是实时行情爬虫接口，数据来自网络且不进入 Tushare 服务器；本项目默认直接实现这个思路来避免 Pro HTTP API 错误。
- 实时行情源的可用性、频率、字段和交易时段返回结果取决于上游网络行情源。
- 持仓数据只保存在当前浏览器，清理浏览器数据后需要重新录入。
- 这个目录是独立子项目，后续 `tool-box` 可以继续新增其他工具目录。
