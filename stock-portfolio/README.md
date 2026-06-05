# 我的持仓看板

一个独立于 `tool-box` 根目录的子项目，用来替代每天打开行情软件手动查看持仓表现。你可以在浏览器中录入自己的持仓数量和成本价，页面会通过本地 Node 服务代理请求 Tushare，计算总成本、最新市值、浮动盈亏和收益率。

## 功能

- 录入 / 编辑 / 删除持仓，字段包含股票代码、股票名称、持仓数量、成本价。
- 支持自动补全常见 A 股代码后缀：`600519` → `600519.SH`、`000001` → `000001.SZ`。
- 汇总展示最新市值、今日已盈亏（基于昨日收盘价）、总盈亏（基于成本价）和总收益率。
- 支持手动“立即刷新”和默认每 60 秒自动刷新，并显示上次刷新时间。
- 使用浏览器 `localStorage` 保存持仓，不需要数据库。
- 使用服务端环境变量保存 Tushare Token，避免直接暴露在前端代码里。
- 批量调用 Tushare `realtime_quote` 接口刷新实时行情。

## 本地运行

```bash
cd stock-portfolio
cp .env.example .env
# 编辑 .env，填入 TUSHARE_TOKEN
set -a && source .env && set +a
npm start
```

打开 <http://localhost:4173> 即可使用。

## 环境变量

| 变量 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `TUSHARE_TOKEN` | 是 | 无 | Tushare Pro Token |
| `TUSHARE_API_NAME` | 否 | `realtime_quote` | Tushare API 名称，默认使用实时行情 |
| `TUSHARE_ENDPOINT` | 否 | `http://api.tushare.pro` | Tushare Pro HTTP Endpoint |
| `PORT` | 否 | `4173` | 本地服务端口 |

## 注意事项

- Tushare 实时行情接口的权限、频率和交易时段返回结果由你的 Tushare 账号决定。
- 持仓数据只保存在当前浏览器，清理浏览器数据后需要重新录入。
- 这个目录是独立子项目，后续 `tool-box` 可以继续新增其他工具目录。
