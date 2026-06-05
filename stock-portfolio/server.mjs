import { createServer } from 'node:http';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
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
const host = process.env.HOST || '0.0.0.0';
const corsAllowedOrigins = new Set((process.env.PORTFOLIO_CORS_ORIGINS || [
  'https://bytedarice.com',
  'https://www.bytedarice.com',
  'http://bytedarice.com',
  'http://www.bytedarice.com',
].join(',')).split(',').map((origin) => origin.trim()).filter(Boolean));
const quoteSource = (process.env.PORTFOLIO_QUOTE_SOURCE || process.env.TUSHARE_QUOTE_SOURCE || (process.env.TUSHARE_TOKEN ? 'tushare' : 'sina')).toLowerCase();
const realtimeEndpoint = process.env.SINA_REALTIME_ENDPOINT || 'https://hq.sinajs.cn/list=';
const suggestEndpoint = process.env.SINA_SUGGEST_ENDPOINT || 'https://suggest3.sinajs.cn/suggest/type=11,12&key=';
const tushareApiName = process.env.TUSHARE_API_NAME || 'rt_k';
const tushareEndpoint = process.env.TUSHARE_ENDPOINT || 'http://api.tushare.pro';
const tushareRealtimeSrc = (process.env.TUSHARE_REALTIME_SRC || 'sina').toLowerCase();
const tushareRealtimeMode = (process.env.TUSHARE_REALTIME_MODE || 'http').toLowerCase();
const tushareFields = process.env.TUSHARE_FIELDS || [
  'ts_code',
  'name',
  'pre_close',
  'high',
  'open',
  'low',
  'close',
  'vol',
  'amount',
  'num',
  'ask_price1',
  'ask_volume1',
  'bid_price1',
  'bid_volume1',
  'trade_time',
].join(',');
const portfolioStorePath = resolve(root, process.env.PORTFOLIO_DATA_PATH || process.env.PORTFOLIO_DB_PATH || 'data/portfolio.json');
const authEnabled = process.env.PORTFOLIO_AUTH_DISABLED !== 'true';
const authUsername = process.env.PORTFOLIO_AUTH_USERNAME || 'admin';
const authPassword = process.env.PORTFOLIO_AUTH_PASSWORD || '';
const authSessionTtlHours = parsePositiveNumber(process.env.PORTFOLIO_AUTH_SESSION_TTL_HOURS, 12);
const authSessionTtlMs = authSessionTtlHours * 60 * 60 * 1000;
const authCookieName = 'stock_portfolio_session';
const sessions = new Map();

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
};

function parsePositiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sendJson(response, statusCode, payload, headers = {}) {
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8', ...headers });
  response.end(JSON.stringify(payload));
}

function isPublicCorsPath(pathname) {
  return pathname === '/api/display/portfolio' || pathname === '/api/display/portfolio/refresh';
}

function applyCorsHeaders(request, response, pathname) {
  const origin = request.headers.origin;
  if (!origin || !isPublicCorsPath(pathname) || !corsAllowedOrigins.has(origin)) {
    return false;
  }

  response.setHeader('access-control-allow-origin', origin);
  response.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  response.setHeader('access-control-allow-headers', 'content-type');
  response.setHeader('access-control-max-age', '600');
  response.setHeader('vary', 'Origin');
  return true;
}

function handleCorsPreflight(request, response, pathname) {
  if (request.method !== 'OPTIONS' || !isPublicCorsPath(pathname)) {
    return false;
  }

  if (!applyCorsHeaders(request, response, pathname)) {
    response.writeHead(403);
    response.end();
    return true;
  }

  response.writeHead(204);
  response.end();
  return true;
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

function isSupportedCode(code) {
  return /^\d{6}\.(SH|SZ|BJ)$/.test(code) || /^\d{5}\.HK$/.test(code);
}

function tableToObjects(payload) {
  const fields = payload?.data?.fields || [];
  const items = payload?.data?.items || [];

  return items.map((item) => Object.fromEntries(fields.map((field, index) => [field, item[index]])));
}

function toSinaSymbol(tsCode) {
  const normalizedCode = normalizeCode(tsCode);
  if (!isSupportedCode(normalizedCode)) {
    throw new Error(`不支持的证券代码：${tsCode}。请使用 A 股 6 位代码或 5 位港股代码并带交易所后缀。`);
  }

  const [code, exchange] = normalizedCode.split('.');
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

function cleanQuoteName(value) {
  return String(value || '').trim();
}

function splitDateTime(value) {
  const rawValue = String(value || '').trim();
  if (!rawValue) {
    return { date: '', time: '' };
  }

  const normalizedValue = rawValue.replace('T', ' ');
  const match = normalizedValue.match(/^(\d{4})-?(\d{2})-?(\d{2})(?:\s+(\d{2}:\d{2}:\d{2}))?/);
  if (match) {
    return {
      date: `${match[1]}-${match[2]}-${match[3]}`,
      time: match[4] || '',
    };
  }

  if (/^\d{2}:\d{2}:\d{2}$/.test(rawValue)) {
    return { date: '', time: rawValue };
  }

  return { date: '', time: rawValue };
}

function getQuotePrice(quote) {
  const price = Number(quote?.price ?? quote?.close);
  const preClose = Number(quote?.pre_close);
  return Number.isFinite(price) && price > 0 ? price : preClose;
}

function getQuotePreClose(quote) {
  const preClose = Number(quote?.pre_close);
  return Number.isFinite(preClose) && preClose > 0 ? preClose : null;
}

function getQuoteDate(quote) {
  if (quote?.date) {
    return String(quote.date);
  }

  if (quote?.trade_date) {
    return splitDateTime(quote.trade_date).date;
  }

  return splitDateTime(quote?.trade_time).date;
}

function getQuoteTime(quote) {
  if (quote?.time) {
    return String(quote.time);
  }

  return splitDateTime(quote?.trade_time).time;
}

function normalizeTushareHttpQuote(quote) {
  const quoteDate = getQuoteDate(quote);
  const quoteTime = getQuoteTime(quote);

  return {
    ...quote,
    ts_code: normalizeCode(quote.ts_code || quote.code),
    name: cleanQuoteName(quote.name),
    open: numberOrNull(quote.open),
    pre_close: numberOrNull(quote.pre_close),
    price: numberOrNull(quote.price ?? quote.close),
    high: numberOrNull(quote.high),
    low: numberOrNull(quote.low),
    bid: numberOrNull(quote.bid ?? quote.bid_price1),
    ask: numberOrNull(quote.ask ?? quote.ask_price1),
    volume: numberOrNull(quote.volume ?? quote.vol),
    amount: numberOrNull(quote.amount),
    date: quoteDate,
    time: quoteTime,
  };
}

function sumValues(items, key) {
  return items.reduce((total, item) => total + item[key], 0);
}

function sumCompleteValues(items, key) {
  if (items.some((item) => !Number.isFinite(item[key]))) {
    return null;
  }

  return items.reduce((total, item) => total + item[key], 0);
}

function roundNumber(value, digits = 2) {
  if (!Number.isFinite(value)) {
    return null;
  }

  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function parseSinaQuoteLine(line) {
  const match = line.match(/^var hq_str_([a-z]{2}\d{5,6})="(.*)";?$/i);
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

function requireTushareToken() {
  const token = process.env.TUSHARE_TOKEN;
  if (!token) {
    throw new Error('缺少 TUSHARE_TOKEN：PORTFOLIO_QUOTE_SOURCE=tushare 时必须配置在服务端环境变量中。');
  }

  return token;
}

async function fetchTushareRealtimeQuotes(codes) {
  requireTushareToken();

  if (tushareRealtimeSrc !== 'sina') {
    throw new Error('当前 Node 实时行情实现只支持 Tushare realtime_quote 的 src=sina。');
  }

  // Tushare realtime_quote 是爬虫版实时行情；默认 src=sina，不走 Pro HTTP 服务器。
  return fetchSinaRealtimeQuotes(codes);
}

async function fetchTushareHttpQuotes(codes) {
  const token = requireTushareToken();
  const params = { ts_code: codes.join(',') };

  if (tushareApiName === 'realtime_quote') {
    params.src = tushareRealtimeSrc;
  }

  const tushareResponse = await fetch(tushareEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      api_name: tushareApiName,
      token,
      params,
      fields: tushareFields,
    }),
  });

  if (!tushareResponse.ok) {
    throw new Error(`Tushare 请求失败：HTTP ${tushareResponse.status}`);
  }

  const tusharePayload = await tushareResponse.json();
  if (tusharePayload.code && tusharePayload.code !== 0) {
    throw new Error(tusharePayload.msg || 'Tushare 返回错误。');
  }

  return tableToObjects(tusharePayload).map(normalizeTushareHttpQuote);
}

async function fetchTushareQuotes(codes) {
  if (tushareApiName === 'realtime_quote' && tushareRealtimeMode === 'crawler') {
    return fetchTushareRealtimeQuotes(codes);
  }

  return fetchTushareHttpQuotes(codes);
}

async function fetchQuotes(codes) {
  if (quoteSource === 'sina') {
    return fetchSinaRealtimeQuotes(codes);
  }

  if (quoteSource === 'tushare' || quoteSource === 'pro') {
    return fetchTushareQuotes(codes);
  }

  throw new Error(`未知行情源：${quoteSource}。可选值：sina、tushare。`);
}

function pickQuoteForCode(quotes, code) {
  const normalizedCode = normalizeCode(code);
  return quotes.find((quote) => normalizeCode(quote?.ts_code) === normalizedCode) || quotes[0] || null;
}

function buildSuggestUrl(keyword) {
  const encodedKeyword = encodeURIComponent(keyword);
  if (suggestEndpoint.includes('{keyword}')) {
    return suggestEndpoint.replace('{keyword}', encodedKeyword);
  }

  return `${suggestEndpoint}${suggestEndpoint.includes('key=') ? '' : suggestEndpoint.includes('?') ? '&key=' : '?key='}${encodedKeyword}`;
}

function normalizeSinaSuggestSymbol(symbol) {
  const match = String(symbol || '').trim().toLowerCase().match(/^([a-z]{2})(\d{5,6})$/);
  if (!match) {
    return '';
  }

  return `${match[2]}.${match[1].toUpperCase()}`;
}

function parseSinaSuggestText(text) {
  const match = text.match(/suggestvalue="([^"]*)"/);
  if (!match || !match[1]) {
    return [];
  }

  return match[1]
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const fields = entry.split(',');
      const symbol = fields[3] || '';
      const code = normalizeSinaSuggestSymbol(symbol) || normalizeCode(fields[2]);
      const name = cleanQuoteName(fields[4] || fields[0]);
      return {
        code,
        name,
        symbol,
        rawCode: fields[2] || '',
        market: code.split('.')[1] || '',
      };
    })
    .filter((item) => item.code && item.name && isSupportedCode(item.code));
}

async function lookupQuoteForCode(code) {
  const normalizedCode = normalizeCode(code);
  if (!isSupportedCode(normalizedCode)) {
    throw new Error(`不支持的证券代码：${code}。`);
  }

  const quotes = await fetchQuotes([normalizedCode]);
  return pickQuoteForCode(quotes, normalizedCode);
}

async function searchSinaSuggest(keyword) {
  const trimmedKeyword = String(keyword || '').trim();
  if (!trimmedKeyword) {
    return [];
  }

  const suggestResponse = await fetch(buildSuggestUrl(trimmedKeyword), {
    headers: {
      referer: 'https://finance.sina.com.cn/',
      'user-agent': 'Mozilla/5.0 stock-portfolio/0.1',
    },
  });

  if (!suggestResponse.ok) {
    throw new Error(`证券名称搜索失败：HTTP ${suggestResponse.status}`);
  }

  const buffer = new Uint8Array(await suggestResponse.arrayBuffer());
  const text = new TextDecoder('gb18030').decode(buffer);
  return parseSinaSuggestText(text);
}

async function resolveSecurity(query) {
  const rawQuery = String(query || '').trim();
  const normalizedCode = normalizeCode(rawQuery);

  if (isSupportedCode(normalizedCode)) {
    const quote = await lookupQuoteForCode(normalizedCode);
    return {
      query: rawQuery,
      type: 'code',
      matches: quote
        ? [{
            code: normalizedCode,
            name: cleanQuoteName(quote.name),
            symbol: toSinaSymbol(normalizedCode),
            market: normalizedCode.split('.')[1],
            quote,
          }]
        : [],
    };
  }

  const matches = await searchSinaSuggest(rawQuery);
  return {
    query: rawQuery,
    type: 'name',
    matches,
  };
}

async function fillHoldingNameFromQuote(holding) {
  if (holding.name) {
    return holding;
  }

  try {
    const quote = await lookupQuoteForCode(holding.code);
    const name = cleanQuoteName(quote?.name);
    return name ? { ...holding, name } : holding;
  } catch (error) {
    console.warn(`自动获取 ${holding.code} 名称失败：`, error instanceof Error ? error.message : error);
    return holding;
  }
}

function parseCookies(header = '') {
  const cookies = {};
  for (const part of header.split(';')) {
    const separatorIndex = part.indexOf('=');
    if (separatorIndex < 0) {
      continue;
    }

    const key = part.slice(0, separatorIndex).trim();
    const value = part.slice(separatorIndex + 1).trim();
    if (!key) {
      continue;
    }

    try {
      cookies[key] = decodeURIComponent(value);
    } catch {
      cookies[key] = value;
    }
  }
  return cookies;
}

function safeEquals(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function isHttpsRequest(request) {
  return request.socket.encrypted || request.headers['x-forwarded-proto'] === 'https';
}

function buildSessionCookie(token, request) {
  const maxAge = Math.floor(authSessionTtlMs / 1000);
  const secureFlag = isHttpsRequest(request) ? '; Secure' : '';
  return `${authCookieName}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secureFlag}`;
}

function buildExpiredSessionCookie(request) {
  const secureFlag = isHttpsRequest(request) ? '; Secure' : '';
  return `${authCookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureFlag}`;
}

function pruneExpiredSessions(now = Date.now()) {
  for (const [token, session] of sessions.entries()) {
    if (session.expiresAt <= now) {
      sessions.delete(token);
    }
  }
}

function createSession(username) {
  pruneExpiredSessions();
  const token = randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + authSessionTtlMs;
  sessions.set(token, { username, expiresAt });
  return { token, expiresAt };
}

function getSession(request) {
  if (!authEnabled) {
    return { username: 'local', expiresAt: Number.POSITIVE_INFINITY };
  }

  const token = parseCookies(request.headers.cookie || '')[authCookieName];
  if (!token) {
    return null;
  }

  const session = sessions.get(token);
  if (!session) {
    return null;
  }

  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }

  return session;
}

function requireAuth(request, response) {
  if (getSession(request)) {
    return true;
  }

  sendJson(response, 401, { error: '请先登录后再访问持仓管理。' });
  return false;
}

async function handleAuth(request, response) {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);

  if (url.pathname === '/api/auth/status' && request.method === 'GET') {
    const session = getSession(request);
    sendJson(response, 200, {
      authEnabled,
      authenticated: Boolean(session),
      username: session?.username || '',
      passwordConfigured: !authEnabled || Boolean(authPassword),
      sessionTtlHours: authSessionTtlHours,
    });
    return;
  }

  if (url.pathname === '/api/auth/login' && request.method === 'POST') {
    if (!authEnabled) {
      sendJson(response, 200, { authEnabled: false, authenticated: true, username: 'local' });
      return;
    }

    if (!authPassword) {
      sendJson(response, 503, { error: '服务端未配置 PORTFOLIO_AUTH_PASSWORD，登录已被拒绝。' });
      return;
    }

    let body;
    try {
      body = JSON.parse(await readBody(request) || '{}');
    } catch {
      sendJson(response, 400, { error: '请求体不是有效 JSON。' });
      return;
    }

    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    if (!safeEquals(username, authUsername) || !safeEquals(password, authPassword)) {
      sendJson(response, 401, { error: '用户名或密码不正确。' });
      return;
    }

    const session = createSession(authUsername);
    sendJson(response, 200, {
      authenticated: true,
      username: authUsername,
      expiresAt: new Date(session.expiresAt).toISOString(),
    }, { 'set-cookie': buildSessionCookie(session.token, request) });
    return;
  }

  if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
    const token = parseCookies(request.headers.cookie || '')[authCookieName];
    if (token) {
      sessions.delete(token);
    }
    sendJson(response, 200, { authenticated: false }, { 'set-cookie': buildExpiredSessionCookie(request) });
    return;
  }

  sendJson(response, 404, { error: 'Not found' });
}

async function createPortfolioStore() {
  await mkdir(dirname(portfolioStorePath), { recursive: true });

  try {
    const payload = JSON.parse(await readFile(portfolioStorePath, 'utf8'));
    const holdings = Array.isArray(payload.holdings) ? payload.holdings.map(serializeHolding).filter((holding) => holding.code) : [];
    return { holdings };
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }

    const store = { holdings: [] };
    await savePortfolioStore(store);
    return store;
  }
}

async function savePortfolioStore(store) {
  await mkdir(dirname(portfolioStorePath), { recursive: true });
  const tempPath = `${portfolioStorePath}.${process.pid}.tmp`;
  await writeFile(tempPath, `${JSON.stringify({ holdings: store.holdings }, null, 2)}\n`);
  await rename(tempPath, portfolioStorePath);
}

const portfolioStore = createPortfolioStore();
let portfolioStoreWriteQueue = Promise.resolve();

function updatePortfolioStore(mutator) {
  const run = portfolioStoreWriteQueue.then(async () => {
    const store = await portfolioStore;
    const result = await mutator(store);
    await savePortfolioStore(store);
    return result;
  });
  portfolioStoreWriteQueue = run.catch(() => {});
  return run;
}

function serializeHolding(row) {
  return {
    code: row.code,
    name: row.name || '',
    shares: Number(row.shares),
    cost: Number(row.cost),
    createdAt: row.createdAt || row.created_at || new Date().toISOString(),
    updatedAt: row.updatedAt || row.updated_at || new Date().toISOString(),
  };
}

function validateHoldingPayload(payload = {}) {
  const code = normalizeCode(payload.code);
  const name = String(payload.name || '').trim();
  const shares = Number(payload.shares);
  const cost = Number(payload.cost);

  if (!code || !isSupportedCode(code)) {
    return { error: '请填写有效的证券代码，例如 600519、000001、600519.SH 或 00700.HK。' };
  }

  if (!Number.isFinite(shares) || shares <= 0 || !Number.isFinite(cost) || cost < 0) {
    return { error: '请填写有效的持仓数量和成本价。' };
  }

  return { holding: { code, name, shares, cost } };
}

async function listHoldings() {
  const store = await portfolioStore;
  return [...store.holdings]
    .map(serializeHolding)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.code.localeCompare(right.code));
}

async function buildPortfolioDisplayPayload() {
  const holdings = await listHoldings();
  const codes = holdings.map((holding) => holding.code);
  const fetchedAt = new Date().toISOString();
  const quotes = codes.length ? await fetchQuotes(codes) : [];
  const quoteMap = new Map(quotes.map((quote) => [normalizeCode(quote.ts_code), quote]));

  const positions = holdings.map((holding) => {
    const quote = quoteMap.get(holding.code);
    const price = quote ? getQuotePrice(quote) : null;
    const preClose = quote ? getQuotePreClose(quote) : null;
    const quoteDate = quote ? getQuoteDate(quote) : '';
    const quoteTime = quote ? getQuoteTime(quote) : '';
    const rawCostValue = holding.shares * holding.cost;
    const hasPrice = Number.isFinite(price);
    const hasPreClose = Number.isFinite(preClose);
    const rawMarketValue = hasPrice ? holding.shares * price : null;
    const rawTodayProfit = hasPrice && hasPreClose ? holding.shares * (price - preClose) : null;
    const rawTotalProfit = hasPrice ? rawMarketValue - rawCostValue : null;
    const rawReturnRate = rawCostValue > 0 && Number.isFinite(rawTotalProfit) ? rawTotalProfit / rawCostValue : null;

    return {
      code: holding.code,
      name: cleanQuoteName(quote?.name) || holding.name,
      shares: holding.shares,
      cost: holding.cost,
      costValue: roundNumber(rawCostValue),
      price: hasPrice ? price : null,
      preClose: hasPreClose ? preClose : null,
      marketValue: roundNumber(rawMarketValue),
      todayProfit: roundNumber(rawTodayProfit),
      totalProfit: roundNumber(rawTotalProfit),
      returnRate: roundNumber(rawReturnRate, 6),
      quoteDate,
      quoteTime,
      quoteStatus: quote ? 'ok' : 'missing',
    };
  });

  const missingCodes = positions
    .filter((position) => position.quoteStatus !== 'ok')
    .map((position) => position.code);
  const isComplete = missingCodes.length === 0;
  const totalCost = sumValues(positions, 'costValue');
  const totalMarketValue = isComplete ? sumCompleteValues(positions, 'marketValue') : null;
  const todayProfit = isComplete ? sumCompleteValues(positions, 'todayProfit') : null;
  const totalProfit = isComplete ? sumCompleteValues(positions, 'totalProfit') : null;
  const totalReturn = totalCost > 0 && Number.isFinite(totalProfit) ? totalProfit / totalCost : null;
  const latestQuote = positions.find((position) => position.quoteDate || position.quoteTime);

  return {
    meta: {
      source: quoteSource,
      fetchedAt,
      quoteDate: latestQuote?.quoteDate || '',
      quoteTime: latestQuote?.quoteTime || '',
      currency: 'CNY',
      isComplete,
      missingCodes,
    },
    summary: {
      totalCost: roundNumber(totalCost),
      totalMarketValue: roundNumber(totalMarketValue),
      todayProfit: roundNumber(todayProfit),
      totalProfit: roundNumber(totalProfit),
      totalReturn: roundNumber(totalReturn, 6),
      positionCount: positions.length,
    },
    positions,
  };
}

async function upsertHolding(holding) {
  return updatePortfolioStore((store) => {
    const now = new Date().toISOString();
    const existingIndex = store.holdings.findIndex((item) => item.code === holding.code);
    const nextHolding = serializeHolding({
      ...holding,
      createdAt: existingIndex >= 0 ? store.holdings[existingIndex].createdAt : now,
      updatedAt: now,
    });

    if (existingIndex >= 0) {
      store.holdings[existingIndex] = nextHolding;
    } else {
      store.holdings.push(nextHolding);
    }

    return nextHolding;
  });
}

async function deleteHolding(code) {
  return updatePortfolioStore((store) => {
    const previousLength = store.holdings.length;
    store.holdings = store.holdings.filter((holding) => holding.code !== code);
    return store.holdings.length < previousLength;
  });
}

async function clearHoldings() {
  return updatePortfolioStore((store) => {
    const deleted = store.holdings.length;
    store.holdings = [];
    return deleted;
  });
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

    const enrichedHolding = await fillHoldingNameFromQuote(holding);
    sendJson(response, 200, { holding: await upsertHolding(enrichedHolding) });
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

async function handleLookup(request, response) {
  if (request.method !== 'GET') {
    sendJson(response, 405, { error: 'Method not allowed' });
    return;
  }

  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  const query = String(url.searchParams.get('query') || url.searchParams.get('code') || '').trim();
  if (!query) {
    sendJson(response, 400, { error: '请提供证券代码或股票名称。' });
    return;
  }

  const result = await resolveSecurity(query);
  const primaryMatch = result.matches[0] || null;
  sendJson(response, 200, {
    ...result,
    code: primaryMatch?.code || normalizeCode(query),
    name: primaryMatch?.name || '',
    quote: primaryMatch?.quote || null,
    fetchedAt: new Date().toISOString(),
  });
}

async function handleDisplayPortfolio(request, response) {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  applyCorsHeaders(request, response, url.pathname);

  if (request.method !== 'GET') {
    sendJson(response, 405, { error: 'Method not allowed' });
    return;
  }

  sendJson(response, 200, await buildPortfolioDisplayPayload());
}

async function handleDisplayPortfolioRefresh(request, response) {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  applyCorsHeaders(request, response, url.pathname);

  if (request.method !== 'POST') {
    sendJson(response, 405, { error: 'Method not allowed' });
    return;
  }

  sendJson(response, 200, await buildPortfolioDisplayPayload());
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

  const unsupportedCodes = codes.filter((code) => !isSupportedCode(code));
  if (unsupportedCodes.length) {
    sendJson(response, 400, { error: `不支持的证券代码：${unsupportedCodes.join('、')}。` });
    return;
  }

  const quotes = await fetchQuotes(codes);

  sendJson(response, 200, {
    source: quoteSource,
    apiName: quoteSource === 'sina' ? 'sina-realtime-crawler' : tushareApiName,
    quotes,
    fetchedAt: new Date().toISOString(),
  });
}

async function handleStatic(request, response) {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  const staticPathname = url.pathname === '/' || url.pathname === '/admin'
      ? '/index.html'
      : url.pathname === '/display'
        ? '/display.html'
        : url.pathname;
  const pathname = decodeURIComponent(staticPathname);
  const safePath = normalize(pathname).replace(/^(\.\.(\/|\\|$))+/, '');
  const filePath = resolve(publicDir, `.${safePath}`);

  if (filePath !== publicDir && !filePath.startsWith(`${publicDir}${sep}`)) {
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
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);

    if (handleCorsPreflight(request, response, url.pathname)) {
      return;
    }

    if (url.pathname.startsWith('/api/auth/')) {
      await handleAuth(request, response);
      return;
    }

    if (url.pathname === '/api/lookup') {
      await handleLookup(request, response);
      return;
    }

    if (url.pathname === '/api/display/portfolio') {
      await handleDisplayPortfolio(request, response);
      return;
    }

    if (url.pathname === '/api/display/portfolio/refresh') {
      await handleDisplayPortfolioRefresh(request, response);
      return;
    }

    if (url.pathname === '/api/holdings' || url.pathname.startsWith('/api/holdings/')) {
      if (!requireAuth(request, response)) {
        return;
      }
      await handleHoldings(request, response);
      return;
    }

    if (url.pathname === '/api/quotes') {
      if (!requireAuth(request, response)) {
        return;
      }
      await handleQuotes(request, response);
      return;
    }

    await handleStatic(request, response);
  } catch (error) {
    console.error(error);
    sendJson(response, 500, { error: error instanceof Error ? error.message : '服务器内部错误。' });
  }
});

server.listen(port, host, () => {
  console.log(`持仓看板已启动：http://${host}:${port}`);
  console.log(`持仓数据文件：${portfolioStorePath}`);
  if (authEnabled && !authPassword) {
    console.warn('鉴权已启用，但未配置 PORTFOLIO_AUTH_PASSWORD；登录会被拒绝。');
  }
});
