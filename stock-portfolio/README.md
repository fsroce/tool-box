# 我的持仓看板

一个独立于 `tool-box` 根目录的子项目，用来替代每天打开行情软件手动查看持仓表现。你可以在浏览器中录入自己的持仓数量和成本价，页面会通过本地 Node 服务读取实时行情，并把持仓数量和成本价写入服务端 SQLite 数据库，计算总成本、最新市值、今日已盈亏、总盈亏和收益率。

## 功能

- 录入 / 编辑 / 删除持仓，字段包含股票代码、股票名称、持仓数量、成本价；股票名称为空时会自动从行情源识别并保存。
- 支持自动补全常见 A 股代码后缀：`600519` → `600519.SH`、`000001` → `000001.SZ`。
- 支持证券代码和名称互查：输入代码可取股票名，输入股票名可返回候选代码。
- 提供纯展示接口 `/api/display/portfolio` 和价格刷新接口 `/api/display/portfolio/refresh`，服务端读取持仓、更新价格并计算盈亏。
- 作为独立 Node service 提供管理页面：`/` 和 `/admin` 返回管理台，登录后可以编辑和删除持仓。
- 汇总展示最新市值、今日已盈亏（基于昨日收盘价）、总盈亏（基于成本价）和总收益率。
- 管理台需要用户名和密码登录；持仓管理和原始行情 API 受服务端会话鉴权保护。`/api/lookup`、`/api/display/portfolio` 和 `/api/display/portfolio/refresh` 不需要登录。
- 支持手动“立即刷新”和默认每 60 秒自动刷新，并显示上次刷新时间。
- 使用服务端 SQLite 保存持仓和成本价，默认数据库路径为 `stock-portfolio/data/portfolio.sqlite`。
- 首次升级时会自动把旧版浏览器 `localStorage` 持仓迁移到服务端 SQLite。
- 默认可用新浪公开接口更新价格；如果配置了 Tushare Token，则用 Tushare Pro `rt_k` 实时日线接口更新价格，Token 只配置在服务端 `.env.prod`，前端不可见。

## 本地运行

```bash
cd stock-portfolio
cp .env.prod.example .env.prod
# 编辑 .env.prod，把 PORTFOLIO_AUTH_PASSWORD 改成强密码
npm start
```

打开 <http://127.0.0.1:4173> 就是管理台，<http://127.0.0.1:4173/admin> 也会返回同一个管理台。默认用户名是 `admin`，密码来自 `PORTFOLIO_AUTH_PASSWORD`。服务端会自动创建 SQLite 数据库和 `holdings` 表。服务启动时会自动读取 `.env`、按 `NODE_ENV` 匹配的 `.env.<NODE_ENV>` 以及 `.env.prod`；管理密码建议只写在本机的 `.env.prod`，该文件不会提交到 Git。

## 服务路径

| 路径 | 说明 |
| --- | --- |
| `/` | 管理台，需要登录 |
| `/admin` | 同 `/`，管理台，需要登录 |
| `/display` | 只读展示页备用路径，不作为默认入口 |
| `/api/display/portfolio` | 获取展示数据，不需要登录 |
| `/api/display/portfolio/refresh` | 服务端更新价格并返回展示数据，不需要登录 |
| `/api/holdings` | 持仓管理接口，需要登录 |
| `/api/quotes` | 原始行情接口，需要登录 |

## 环境变量

| 变量 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `PORTFOLIO_QUOTE_SOURCE` | 否 | 有 `TUSHARE_TOKEN` 时为 `tushare`，否则为 `sina` | 服务端价格更新源。可选 `sina`、`tushare` |
| `SINA_REALTIME_ENDPOINT` | 否 | `https://hq.sinajs.cn/list=` | 新浪实时行情 endpoint，可用 `{symbols}` 占位符自定义 URL |
| `SINA_SUGGEST_ENDPOINT` | 否 | `https://suggest3.sinajs.cn/suggest/type=11,12&key=` | 新浪证券名称搜索 endpoint，可用 `{keyword}` 占位符自定义 URL |
| `TUSHARE_TOKEN` | `PORTFOLIO_QUOTE_SOURCE=tushare` 时必填 | 无 | Tushare Token，只在服务端使用 |
| `TUSHARE_API_NAME` | 否 | `rt_k` | Tushare API 名称；实时价格默认使用 Pro `rt_k` |
| `TUSHARE_FIELDS` | 否 | `rt_k` 所需字段 | Tushare HTTP 请求字段；一般不需要改 |
| `TUSHARE_REALTIME_SRC` | 否 | `sina` | 仅 `TUSHARE_API_NAME=realtime_quote` 且 `TUSHARE_REALTIME_MODE=crawler` 时使用 |
| `TUSHARE_REALTIME_MODE` | 否 | `http` | 默认走 Tushare HTTP Pro；只有设为 `crawler` 才按 `realtime_quote` 爬虫语义取数 |
| `TUSHARE_ENDPOINT` | 否 | `http://api.tushare.pro` | Tushare HTTP endpoint |
| `PORT` | 否 | `4173` | 本地服务端口 |
| `HOST` | 否 | `127.0.0.1` | 服务监听地址；默认只允许本机访问 |
| `PORTFOLIO_CORS_ORIGINS` | 否 | `https://bytedarice.com,https://www.bytedarice.com` | 允许跨域访问公开展示 API 的 Origin 白名单 |
| `PORTFOLIO_DB_PATH` | 否 | `stock-portfolio/data/portfolio.sqlite` | 持仓 SQLite 数据库文件路径 |
| `PORTFOLIO_AUTH_USERNAME` | 否 | `admin` | 管理台登录用户名 |
| `PORTFOLIO_AUTH_PASSWORD` | 是 | 无 | 管理台登录密码；鉴权启用时未配置会拒绝登录 |
| `PORTFOLIO_AUTH_SESSION_TTL_HOURS` | 否 | `12` | 登录会话有效小时数 |
| `PORTFOLIO_AUTH_DISABLED` | 否 | `false` | 设为 `true` 可显式关闭鉴权，仅建议本机临时调试使用 |

## 配置文件建议

- 前端不需要 Tushare Token，也不会接触任何行情源凭据。
- 推荐把这个 Node service 反代到 `bytedarice.com`，展示页和 API 同源时不会触发跨域。
- 如果展示页和 API 分开部署，只有 `/api/display/portfolio` 和 `/api/display/portfolio/refresh` 会按 `PORTFOLIO_CORS_ORIGINS` 放行跨域；管理接口不会放开。
- 如果价格更新要走 Tushare Pro，把 `PORTFOLIO_QUOTE_SOURCE=tushare` 和 `TUSHARE_TOKEN` 写入 `stock-portfolio/.env.prod`；默认接口是 `rt_k`。
- `realtime_quote` 是 Tushare 的爬虫版实时接口，不是默认路径；只有你显式配置 `TUSHARE_API_NAME=realtime_quote` 和 `TUSHARE_REALTIME_MODE=crawler` 时才会使用。
- 管理台密码也写入 `stock-portfolio/.env.prod`，不要提交到 Git。
- 仓库只保留 `.env.prod.example` 模板；`.env.prod` 已加入 `.gitignore`，避免把真实密码或 Token 泄露到 Git 历史。
- 如果系统环境变量里已经设置了同名变量，会优先使用系统环境变量，不会被 `.env.prod` 覆盖。

## 注意事项

- 实时行情源的可用性、频率、字段和交易时段返回结果取决于上游网络行情源。
- 持仓数据保存在服务端 SQLite 中；备份或迁移时请一并处理 `PORTFOLIO_DB_PATH` 指向的数据库文件。
- 这个目录是独立子项目，后续 `tool-box` 可以继续新增其他工具目录。
