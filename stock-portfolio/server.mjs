import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

function loadDotEnv() {
  const envPath = join(root, '.env');
  if (!existsSync(envPath)) {
    return;
  }

  const lines = readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)?\s*$/);
    if (!match || process.env[match[1]] !== undefined) {
      continue;
    }

    const value = (match[2] || '').replace(/^['"]|['"]$/g, '');
    process.env[match[1]] = value;
  }
}

loadDotEnv();

const publicDir = join(root, 'public');
const port = Number(process.env.PORT || 4173);
const tushareApiName = process.env.TUSHARE_API_NAME || 'realtime_quote';
const tushareEndpoint = process.env.TUSHARE_ENDPOINT || 'http://api.tushare.pro';

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

async function handleQuotes(request, response) {
  if (request.method !== 'POST') {
    sendJson(response, 405, { error: 'Method not allowed' });
    return;
  }

  const token = process.env.TUSHARE_TOKEN;
  if (!token) {
    sendJson(response, 500, { error: '缺少 TUSHARE_TOKEN，请先复制 .env.example 并配置环境变量。' });
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
    sendJson(response, 502, { error: `Tushare 请求失败：HTTP ${tushareResponse.status}` });
    return;
  }

  const tusharePayload = await tushareResponse.json();
  if (tusharePayload.code && tusharePayload.code !== 0) {
    sendJson(response, 502, { error: tusharePayload.msg || 'Tushare 返回错误。', raw: tusharePayload });
    return;
  }

  sendJson(response, 200, {
    apiName: tushareApiName,
    quotes: tableToObjects(tusharePayload),
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
