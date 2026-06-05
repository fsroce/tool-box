# 持仓展示页数据结构

这个文档只描述纯展示 UI 需要的数据。展示页不需要登录，不包含新增、编辑、删除、清空等管理能力。价格更新和盈亏计算全部在服务端完成，前端只负责渲染返回数据。

## 部署方式

当前 Node service 的默认入口 `/` 是管理台；只读展示页保留在 `/display` 备用。展示页同源调用下面的展示 API 时，浏览器不会触发跨域问题。

如果展示页和 API 分开部署，服务端只对公开展示 API 支持 CORS，默认允许 `https://bytedarice.com` 和 `https://www.bytedarice.com`，可通过 `PORTFOLIO_CORS_ORIGINS` 调整。

## 展示数据接口

```http
GET /api/display/portfolio
```

返回一个完整的展示数据包。服务端会读取 SQLite 持仓、拉取最新行情，并计算汇总和单只持仓指标。

## 更新价格接口

```http
POST /api/display/portfolio/refresh
```

展示页点击刷新时调用这个接口。接口不需要登录，前端不传行情 token、不传行情源配置；服务端会读取持仓、用服务端环境变量中的行情配置更新价格，然后返回和 `GET /api/display/portfolio` 完全相同的数据结构。行情源可由服务端配置为 `sina` 或 `tushare`；`tushare` 默认使用 Pro `rt_k` 实时日线接口。

## Response

两个接口的成功响应都是下面这个结构：

```json
{
  "meta": {
    "source": "sina",
    "fetchedAt": "2026-06-05T13:00:43.947Z",
    "quoteDate": "2026-06-05",
    "quoteTime": "15:00:02",
    "currency": "CNY",
    "isComplete": true,
    "missingCodes": []
  },
  "summary": {
    "totalCost": 168850,
    "totalMarketValue": 127286,
    "todayProfit": 486,
    "totalProfit": -41564,
    "totalReturn": -0.24617,
    "positionCount": 1
  },
  "positions": [
    {
      "code": "600519.SH",
      "name": "贵州茅台",
      "shares": 100,
      "cost": 1688.5,
      "costValue": 168850,
      "price": 1272.86,
      "preClose": 1268,
      "marketValue": 127286,
      "todayProfit": 486,
      "totalProfit": -41564,
      "returnRate": -0.24617,
      "quoteDate": "2026-06-05",
      "quoteTime": "15:00:02",
      "quoteStatus": "ok"
    }
  ]
}
```

## TypeScript 类型

```ts
type QuoteStatus = 'ok' | 'missing' | 'stale';

interface PortfolioDisplayResponse {
  meta: {
    source: string;
    fetchedAt: string;
    quoteDate: string;
    quoteTime: string;
    currency: 'CNY';
    isComplete: boolean;
    missingCodes: string[];
  };
  summary: {
    totalCost: number;
    totalMarketValue: number | null;
    todayProfit: number | null;
    totalProfit: number | null;
    totalReturn: number | null;
    positionCount: number;
  };
  positions: PositionDisplayItem[];
}

interface PositionDisplayItem {
  code: string;
  name: string;
  shares: number;
  cost: number;
  costValue: number;
  price: number | null;
  preClose: number | null;
  marketValue: number | null;
  todayProfit: number | null;
  totalProfit: number | null;
  returnRate: number | null;
  quoteDate: string;
  quoteTime: string;
  quoteStatus: QuoteStatus;
}
```

## 字段说明

| 字段 | 含义 |
| --- | --- |
| `meta.source` | 服务端价格更新源，例如 `sina` 或 `tushare` |
| `meta.fetchedAt` | 服务端拉取行情的 ISO 时间 |
| `meta.isComplete` | 是否所有持仓都有行情 |
| `meta.missingCodes` | 未取到行情的证券代码列表 |
| `summary.totalCost` | 总成本，等于所有 `shares * cost` 之和 |
| `summary.totalMarketValue` | 总市值；如果行情不完整，建议返回 `null` |
| `summary.todayProfit` | 今日盈亏；如果行情不完整，建议返回 `null` |
| `summary.totalProfit` | 总盈亏；如果行情不完整，建议返回 `null` |
| `summary.totalReturn` | 总收益率，小数形式，例如 `0.1234` 表示 `12.34%` |
| `positions[].price` | 最新价 |
| `positions[].preClose` | 昨收价 |
| `positions[].cost` | 成本价 |
| `positions[].costValue` | 单只持仓成本 |
| `positions[].marketValue` | 单只持仓市值 |
| `positions[].todayProfit` | 单只今日盈亏 |
| `positions[].totalProfit` | 单只总盈亏 |
| `positions[].returnRate` | 单只收益率，小数形式 |
| `positions[].quoteStatus` | `ok` 表示行情正常，`missing` 表示无行情，`stale` 表示行情过期 |

## 计算公式

```ts
costValue = shares * cost
marketValue = shares * price
todayProfit = shares * (price - preClose)
totalProfit = marketValue - costValue
returnRate = totalProfit / costValue
```

## 空值规则

- 金额和收益率无法计算时返回 `null`，前端展示为 `--`。
- 行情缺失时，单只持仓的 `price`、`marketValue`、`todayProfit`、`totalProfit`、`returnRate` 返回 `null`。
- 只要有任意持仓缺行情，`meta.isComplete` 返回 `false`，`summary.totalMarketValue`、`summary.todayProfit`、`summary.totalProfit`、`summary.totalReturn` 建议返回 `null`，避免用部分行情冒充总数。

## 展示建议

- 红色：盈利或上涨，`value > 0`。
- 绿色：亏损或下跌，`value < 0`。
- 灰色：`0` 或 `null`。
- 金额统一按人民币展示，两位小数。
- 收益率展示为百分比，两位小数，例如 `-0.24617` 展示为 `-24.62%`。
