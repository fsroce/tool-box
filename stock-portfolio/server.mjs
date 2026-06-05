import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

function parseEnvValue(value = '') {
  return value.trim().replace(/^['"]|['"]$/g, '');
}

function loadDotEnvFile(fileName, protectedKeys) {
  const envPath = join(root, fileName);
  if (!existsSync(envPath)) {
    return;
  }

  const lines = readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)?\s*$/);
    if (!match || protectedKeys.has(match[1])) {
      continue;
    }

    process.env[match[1]] = parseEnvValue(match[2]);
  }
}

function loadDotEnv() {
  const protectedKeys = new Set(Object.keys(process.env));
  const envFiles = ['.env'];

  if (process.env.NODE_ENV) {
    envFiles.push(`.env.${process.env.NODE_ENV}`);
  }

  envFiles.push('.env.prod');

  for (const fileName of [...new Set(envFiles)]) {
    loadDotEnvFile(fileName, protectedKeys);
  }
}

loadDotEnv();

const publicDir = join(root, 'public');
const port = Number(process.env.PORT || 4173);
const quoteSource = (process.env.TUSHARE_QUOTE_SOURCE || 'sina').toLowerCase();
const tushareApiName = process.env.TUSHARE_API_NAME;
const tushareEndpoint = process.env.TUSHARE_ENDPOINT || 'http://api.tushare.pro';
const realtimeEndpoint = process.env.TUSHARE_REALTIME_ENDPOINT || 'https://hq.sinajs.cn/list=';
const portfolioDbPath = process.env.PORTFOLIO_DB_PATH || join(root, 'data', 'portfolio.sqlite');

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
};

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function normalizeCode(code) {
  const trimmed = String(code || '').trim().toUpperCase();
  if (!trimmed) {
    return '';
  }

  if (/\.(SH|SZ|BJ|HK)$/.test(trimmed)) {
    return trimmed;
  }

  if (/^(5|6|9)\d{5}$/.test(trimmed)) {
    return `${trimmed}.SH`;
  }

  if (/^(0|1|2|3)\d{5}$/.test(trimmed)) {
    return `${trimmed}.SZ`;
  }

  if (/^(4|8)\d{5}$/.test(trimmed)) {
    return `${trimmed}.BJ`;
  }

  return trimmed;
}

function tableToObjects(payload) {
  const fields = payload?.data?.fields || [];
  const items = payload?.data?.items || [];

  return items.map((item) => Object.fromEntries(fields.map((field, index) => [field, item[index]])));
}

function toSinaSymbol(tsCode) {
  const [code, exchange] = tsCode.split('.');
  return `${exchange.toLowerCase()}${code}`;
}

function fromSinaSymbol(symbol) {
  const exchange = symbol.slice(0, 2).toUpperCase();
  const code = symbol.slice(2);
  return `${code}.${exchange}`;
}

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseSinaQuoteLine(line) {
  const match = line.match(/^var hq_str_([a-z]{2}\d{6})="(.*)";?$/i);
  if (!match || !match[2]) {
    return null;
  }

  const values = match[2].split(',');
  if (!values[0]) {
    return null;
  }

  return {
    ts_code: fromSinaSymbol(match[1]),
    name: values[0],
    open: numberOrNull(values[1]),
    pre_close: numberOrNull(values[2]),
    price: numberOrNull(values[3]),
    high: numberOrNull(values[4]),
    low: numberOrNull(values[5]),
    bid: numberOrNull(values[6]),
    ask: numberOrNull(values[7]),
    volume: numberOrNull(values[8]),
    amount: numberOrNull(values[9]),
    date: values[30] || '',
    time: values[31] || '',
  };
}

async function fetchSinaRealtimeQuotes(codes) {
  const sinaSymbols = codes.map(toSinaSymbol).join(',');
  const url = realtimeEndpoint.includes('{symbols}')
    ? realtimeEndpoint.replace('{symbols}', sinaSymbols)
    : `${realtimeEndpoint}${realtimeEndpoint.includes('list=') ? '' : '?list='}${sinaSymbols}`;
  const sinaResponse = await fetch(url, {
    headers: {
      referer: 'https://finance.sina.com.cn/',
      'user-agent': 'Mozilla/5.0 stock-portfolio/0.1',
    },
  });

  if (!sinaResponse.ok) {
    throw new Error(`实时行情源请求失败：HTTP ${sinaResponse.status}`);
  }

  const buffer = new Uint8Array(await sinaResponse.arrayBuffer());
  const text = new TextDecoder('gb18030').decode(buffer);
  return text
    .split(/\r?\n/)
    .map((line) => parseSinaQuoteLine(line.trim()))
    .filter(Boolean);
}

async function fetchProQuotes(codes) {
  const token = process.env.TUSHARE_TOKEN;
  if (!token) {
    throw new Error('缺少 TUSHARE_TOKEN：仅在 TUSHARE_QUOTE_SOURCE=pro 时需要配置。');
  }

  if (!tushareApiName) {
    throw new Error('缺少 TUSHARE_API_NAME：Pro HTTP 模式必须指定可用的 Tushare Pro API 名称。');
  }

  const fields = [
    'ts_code',
    'name',
    'date',
    'time',
    'open',
    'pre_close',
    'price',
    'high',
    'low',
    'bid',
    'ask',
    'volume',
    'amount',
  ].join(',');

  const tushareResponse = await fetch(tushareEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      api_name: tushareApiName,
      token,
      params: { ts_code: codes.join(',') },
      fields,
    }),
  });

  if (!tushareResponse.ok) {
    throw new Error(`Tushare 请求失败：HTTP ${tushareResponse.status}`);
  }

  const tusharePayload = await tushareResponse.json();
  if (tusharePayload.code && tusharePayload.code !== 0) {
    throw new Error(tusharePayload.msg || 'Tushare 返回错误。');
  }

  return tableToObjects(tusharePayload);
}

async function fetchQuotes(codes) {
  if (quoteSource === 'sina') {
    return fetchSinaRealtimeQuotes(codes);
  }

  if (quoteSource === 'pro') {
    return fetchProQuotes(codes);
  }

  throw new Error(`未知行情源：${quoteSource}。可选值：sina、pro。`);
}

async function createPortfolioDatabase() {
  await mkdir(dirname(portfolioDbPath), { recursive: true });
  const db = await open({ filename: portfolioDbPath, driver: sqlite3.Database });
  await db.exec(`
    CREATE TABLE IF NOT EXISTS holdings (
      code TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      shares REAL NOT NULL CHECK (shares > 0),
      cost REAL NOT NULL CHECK (cost >= 0),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

const portfolioDb = createPortfolioDatabase();

function serializeHolding(row) {
  return {
    code: row.code,
    name: row.name || '',
    shares: Number(row.shares),
    cost: Number(row.cost),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function validateHoldingPayload(payload = {}) {
  const code = normalizeCode(payload.code);
  const name = String(payload.name || '').trim();
  const shares = Number(payload.shares);
  const cost = Number(payload.cost);

  if (!code || !Number.isFinite(shares) || shares <= 0 || !Number.isFinite(cost) || cost < 0) {
    return { error: '请填写有效的代码、持仓数量和成本价。' };
  }

  return { holding: { code, name, shares, cost } };
}

async function listHoldings() {
  const db = await portfolioDb;
  const rows = await db.all(`
    SELECT code, name, shares, cost, created_at, updated_at
    FROM holdings
    ORDER BY created_at ASC, code ASC
  `);
  return rows.map(serializeHolding);
}

async function upsertHolding(holding) {
  const db = await portfolioDb;
  await db.run(`
    INSERT INTO holdings (code, name, shares, cost, created_at, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(code) DO UPDATE SET
      name = excluded.name,
      shares = excluded.shares,
      cost = excluded.cost,
      updated_at = datetime('now')
  `, holding.code, holding.name, holding.shares, holding.cost);
  const row = await db.get(`
    SELECT code, name, shares, cost, created_at, updated_at
    FROM holdings
    WHERE code = ?
  `, holding.code);
  return serializeHolding(row);
}

async function deleteHolding(code) {
  const db = await portfolioDb;
  const result = await db.run('DELETE FROM holdings WHERE code = ?', code);
  return result.changes > 0;
}

async function clearHoldings() {
  const db = await portfolioDb;
  const result = await db.run('DELETE FROM holdings');
  return result.changes;
}

async function handleHoldings(request, response) {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  const codeFromPath = decodeURIComponent(url.pathname.replace(/^\/api\/holdings\/?/, ''));

  if (request.method === 'GET' && !codeFromPath) {
    sendJson(response, 200, { holdings: await listHoldings() });
    return;
  }

  if ((request.method === 'POST' || request.method === 'PUT') && !codeFromPath) {
    let body;
    try {
      body = JSON.parse(await readBody(request) || '{}');
    } catch {
      sendJson(response, 400, { error: '请求体不是有效 JSON。' });
      return;
    }

    const { holding, error } = validateHoldingPayload(body);
    if (error) {
      sendJson(response, 400, { error });
      return;
    }

    sendJson(response, 200, { holding: await upsertHolding(holding) });
    return;
  }

  if (request.method === 'DELETE') {
    if (!codeFromPath) {
      sendJson(response, 200, { deleted: await clearHoldings() });
      return;
    }

    const code = normalizeCode(codeFromPath);
    if (!code) {
      sendJson(response, 400, { error: '请提供要删除的证券代码。' });
      return;
    }

    const deleted = await deleteHolding(code);
    sendJson(response, deleted ? 200 : 404, deleted ? { deleted: code } : { error: '未找到对应持仓。' });
    return;
  }

  sendJson(response, 405, { error: 'Method not allowed' });
}

async function handleQuotes(request, response) {
  if (request.method !== 'POST') {
    sendJson(response, 405, { error: 'Method not allowed' });
    return;
  }

  let body;
  try {
    body = JSON.parse(await readBody(request) || '{}');
  } catch {
    sendJson(response, 400, { error: '请求体不是有效 JSON。' });
    return;
  }

  const codes = [...new Set((body.codes || []).map(normalizeCode).filter(Boolean))];
  if (!codes.length) {
    sendJson(response, 400, { error: '请至少传入一个证券代码。' });
    return;
  }

  const quotes = await fetchQuotes(codes);

  sendJson(response, 200, {
    source: quoteSource,
    apiName: quoteSource === 'pro' ? tushareApiName : 'sina-realtime-crawler',
    quotes,
    fetchedAt: new Date().toISOString(),
  });
}

async function handleStatic(request, response) {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const safePath = normalize(pathname).replace(/^(\.\.(\/|\\|$))+/, '');
  const filePath = join(publicDir, safePath);

  if (!filePath.startsWith(publicDir)) {
    response.writeHead(403);
    response.end('Forbidden');
    return;
  }

  try {
    const file = await readFile(filePath);
    response.writeHead(200, { 'content-type': contentTypes[extname(filePath)] || 'application/octet-stream' });
    response.end(file);
  } catch {
    const fallback = await readFile(join(publicDir, 'index.html'));
    response.writeHead(200, { 'content-type': contentTypes['.html'] });
    response.end(fallback);
  }
}

const server = createServer(async (request, response) => {
  try {
    if (request.url?.startsWith('/api/holdings')) {
      await handleHoldings(request, response);
      return;
    }

    if (request.url?.startsWith('/api/quotes')) {
      await handleQuotes(request, response);
      return;
    }

    await handleStatic(request, response);
  } catch (error) {
    console.error(error);
    sendJson(response, 500, { error: error instanceof Error ? error.message : '服务器内部错误。' });
  }
});

server.listen(port, () => {
  console.log(`持仓看板已启动：http://localhost:${port}`);
  console.log(`持仓 SQLite 数据库：${portfolioDbPath}`);
});
