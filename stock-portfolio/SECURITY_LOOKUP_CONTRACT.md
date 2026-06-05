# 证券代码和名称互查接口

这个接口不需要 Tushare Token，也不需要登录。它只负责证券代码和证券名称互相转换，不返回用户持仓数据。

## Endpoint

```http
GET /api/lookup?query={代码或名称}
```

兼容旧参数：

```http
GET /api/lookup?code=600519
```

## Code -> Name

请求：

```http
GET /api/lookup?query=600519
```

返回：

```json
{
  "query": "600519",
  "type": "code",
  "matches": [
    {
      "code": "600519.SH",
      "name": "贵州茅台",
      "symbol": "sh600519",
      "market": "SH",
      "quote": {
        "ts_code": "600519.SH",
        "name": "贵州茅台",
        "price": 1272.86,
        "pre_close": 1268,
        "date": "2026-06-05",
        "time": "15:00:02"
      }
    }
  ],
  "code": "600519.SH",
  "name": "贵州茅台",
  "quote": {
    "ts_code": "600519.SH",
    "name": "贵州茅台",
    "price": 1272.86,
    "pre_close": 1268,
    "date": "2026-06-05",
    "time": "15:00:02"
  },
  "fetchedAt": "2026-06-05T13:20:31.354Z"
}
```

## Name -> Code

请求：

```http
GET /api/lookup?query=贵州茅台
```

返回：

```json
{
  "query": "贵州茅台",
  "type": "name",
  "matches": [
    {
      "code": "600519.SH",
      "name": "贵州茅台",
      "symbol": "sh600519",
      "rawCode": "600519",
      "market": "SH"
    }
  ],
  "code": "600519.SH",
  "name": "贵州茅台",
  "quote": null,
  "fetchedAt": "2026-06-05T13:20:31.447Z"
}
```

模糊名称可能返回多个候选，例如：

```http
GET /api/lookup?query=平安
```

```json
{
  "query": "平安",
  "type": "name",
  "matches": [
    {
      "code": "601318.SH",
      "name": "中国平安",
      "symbol": "sh601318",
      "rawCode": "601318",
      "market": "SH"
    },
    {
      "code": "000001.SZ",
      "name": "平安银行",
      "symbol": "sz000001",
      "rawCode": "000001",
      "market": "SZ"
    }
  ],
  "code": "601318.SH",
  "name": "中国平安",
  "quote": null,
  "fetchedAt": "2026-06-05T13:20:31.435Z"
}
```

## TypeScript 类型

```ts
interface SecurityLookupResponse {
  query: string;
  type: 'code' | 'name';
  matches: SecurityLookupMatch[];
  code: string;
  name: string;
  quote: SecurityQuote | null;
  fetchedAt: string;
}

interface SecurityLookupMatch {
  code: string;
  name: string;
  symbol: string;
  rawCode?: string;
  market: 'SH' | 'SZ' | 'BJ' | 'HK' | string;
  quote?: SecurityQuote;
}

interface SecurityQuote {
  ts_code: string;
  name: string;
  open: number | null;
  pre_close: number | null;
  price: number | null;
  high: number | null;
  low: number | null;
  bid: number | null;
  ask: number | null;
  volume: number | null;
  amount: number | null;
  date: string;
  time: string;
}
```

## 使用建议

- 如果 `type === 'code'`，通常直接使用顶层 `code` 和 `name`。
- 如果 `type === 'name'` 且 `matches.length > 1`，前端应让用户选择候选项。
- 顶层 `code` 和 `name` 永远取第一个候选，方便简单场景直接使用。
- `quote` 只在代码查询时返回；名称查询只做候选匹配，默认不拉每个候选的实时行情。
