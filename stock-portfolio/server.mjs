import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = fileURLToPath(new URL('.', import.meta.url));
const execFileAsync = promisify(execFile);

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
const configuredDbPath = process.env.STOCK_PORTFOLIO_DB;
const dbPath = configuredDbPath
  ? (isAbsolute(configuredDbPath) ? configuredDbPath : join(root, configuredDbPath))
  : join(root, 'data', 'portfolio.sqlite');
const pythonBin = process.env.PYTHON || 'python3';

mkdirSync(dirname(dbPath), { recursive: true });

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

const sqliteHelperPath = join(root, 'scripts', 'sqlite_helper.py');

async function runSqlite(action, payload = {}) {
  const { stdout } = await execFileAsync(pythonBin, [sqliteHelperPath, dbPath, action, JSON.stringify(payload)], {
    maxBuffer: 1024 * 1024,
  });
  return JSON.parse(stdout || '{}');
}

function validateHolding(input) {
  const code = normalizeCode(input?.code);
  const shares = Number(input?.shares);
  const cost = Number(input?.cost);
  const name = String(input?.name || '').trim();

  if (!code || !Number.isFinite(shares) || shares <= 0 || !Number.isFinite(cost) || cost < 0) {
    throw new Error('请填写有效的代码、持仓数量和成本价。');
  }

  return { code, name, shares, cost };
}

async function handleHoldings(request, response) {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);

  if (request.method === 'GET') {
    sendJson(response, 200, await runSqlite('list'));
    return;
  }

  if (request.method === 'POST') {
    let body;
    try {
      body = JSON.parse(await readBody(request) || '{}');
    } catch {
      sendJson(response, 400, { error: '请求体不是有效 JSON。' });
      return;
    }

    try {
      sendJson(response, 200, await runSqlite('upsert', validateHolding(body)));
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : '持仓保存失败。' });
    }
    return;
  }

  if (request.method === 'DELETE') {
    const code = normalizeCode(url.searchParams.get('code'));
    if (code) {
      sendJson(response, 200, await runSqlite('delete', { code }));
    } else {
      sendJson(response, 200, await runSqlite('clear'));
    }
    return;
  }

  sendJson(response, 405, { error: 'Method not allowed' });
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
});
