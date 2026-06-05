const LEGACY_STORAGE_KEY = 'tool-box.stock-portfolio.holdings.v1';
const REFRESH_INTERVAL_MS = 60_000;

const elements = {
  form: document.querySelector('#holdingForm'),
  codeInput: document.querySelector('#codeInput'),
  nameInput: document.querySelector('#nameInput'),
  sharesInput: document.querySelector('#sharesInput'),
  costInput: document.querySelector('#costInput'),
  refreshBtn: document.querySelector('#refreshBtn'),
  autoRefreshInput: document.querySelector('#autoRefreshInput'),
  clearBtn: document.querySelector('#clearBtn'),
  holdingsBody: document.querySelector('#holdingsBody'),
  mobileHoldings: document.querySelector('#mobileHoldings'),
  emptyState: document.querySelector('#emptyState'),
  statusText: document.querySelector('#statusText'),
  lastRefreshText: document.querySelector('#lastRefreshText'),
  nextRefreshText: document.querySelector('#nextRefreshText'),
  totalCostText: document.querySelector('#totalCostText'),
  totalMarketValue: document.querySelector('#totalMarketValue'),
  todayProfit: document.querySelector('#todayProfit'),
  totalProfit: document.querySelector('#totalProfit'),
  totalReturn: document.querySelector('#totalReturn'),
};

let holdings = [];
let quotes = new Map();
let autoRefreshTimer;
let lastRefreshAt;
let isRefreshing = false;

function loadLegacyHoldings() {
  try {
    const parsed = JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.error || '服务端请求失败。');
  }

  return payload;
}

async function fetchHoldings() {
  const payload = await requestJson('/api/holdings');
  return Array.isArray(payload.holdings) ? payload.holdings : [];
}

async function persistHolding(holding) {
  const payload = await requestJson('/api/holdings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(holding),
  });
  return payload.holding;
}

async function deleteHolding(code) {
  await requestJson(`/api/holdings/${encodeURIComponent(code)}`, { method: 'DELETE' });
}

async function clearServerHoldings() {
  await requestJson('/api/holdings', { method: 'DELETE' });
}

async function migrateLegacyHoldingsIfNeeded() {
  const legacyHoldings = loadLegacyHoldings();
  if (holdings.length || !legacyHoldings.length) {
    return;
  }

  const imported = [];
  for (const legacyHolding of legacyHoldings) {
    const code = normalizeCode(legacyHolding.code);
    const shares = Number(legacyHolding.shares);
    const cost = Number(legacyHolding.cost);
    const name = String(legacyHolding.name || '').trim();
    if (!code || !Number.isFinite(shares) || shares <= 0 || !Number.isFinite(cost) || cost < 0) {
      continue;
    }

    imported.push(await persistHolding({ code, name, shares, cost }));
  }

  if (imported.length) {
    holdings = await fetchHoldings();
    localStorage.removeItem(LEGACY_STORAGE_KEY);
    elements.statusText.textContent = `已从浏览器旧数据迁移 ${imported.length} 条持仓到服务端 SQLite。`;
  }
}

async function loadHoldingsFromServer() {
  try {
    holdings = await fetchHoldings();
    await migrateLegacyHoldingsIfNeeded();
    renderHoldings();
    refreshQuotes();
  } catch (error) {
    elements.statusText.textContent = error instanceof Error ? error.message : '读取服务端持仓失败。';
    renderHoldings();
  }
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

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

function formatMoney(value) {
  if (!Number.isFinite(value)) {
    return '--';
  }
  return new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY', maximumFractionDigits: 2 }).format(value);
}

function formatNumber(value, digits = 2) {
  if (!Number.isFinite(value)) {
    return '--';
  }
  return new Intl.NumberFormat('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
}

function formatPercent(value) {
  if (!Number.isFinite(value)) {
    return '--';
  }
  return `${formatNumber(value * 100, 2)}%`;
}

function formatRefreshTime(date) {
  if (!date) {
    return '--';
  }
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function getQuotePrice(quote) {
  const price = Number(quote?.price);
  const preClose = Number(quote?.pre_close);
  return Number.isFinite(price) && price > 0 ? price : preClose;
}

function getPreClose(quote) {
  const preClose = Number(quote?.pre_close);
  return Number.isFinite(preClose) && preClose > 0 ? preClose : Number.NaN;
}

function signedClass(value) {
  if (!Number.isFinite(value) || value === 0) {
    return 'muted';
  }
  return value > 0 ? 'profit' : 'loss';
}

function buildRows() {
  return holdings.map((holding) => {
    const quote = quotes.get(holding.code);
    const price = getQuotePrice(quote);
    const preClose = getPreClose(quote);
    const costValue = holding.shares * holding.cost;
    const hasPrice = Number.isFinite(price);
    const marketValue = hasPrice ? holding.shares * price : Number.NaN;
    const todayProfit = hasPrice && Number.isFinite(preClose) ? holding.shares * (price - preClose) : Number.NaN;
    const totalProfit = hasPrice ? marketValue - costValue : Number.NaN;
    const returnRate = costValue > 0 && hasPrice ? totalProfit / costValue : Number.NaN;

    return { holding, quote, price, preClose, costValue, marketValue, todayProfit, totalProfit, returnRate };
  });
}

function sumFinite(rows, key) {
  const values = rows.map((row) => row[key]).filter(Number.isFinite);
  return values.length ? values.reduce((total, value) => total + value, 0) : Number.NaN;
}

function renderSummary(rows) {
  const totalCost = sumFinite(rows, 'costValue');
  const marketValue = sumFinite(rows, 'marketValue');
  const todayProfit = sumFinite(rows, 'todayProfit');
  const totalProfit = sumFinite(rows, 'totalProfit');
  const returnRate = totalCost > 0 && Number.isFinite(totalProfit) ? totalProfit / totalCost : Number.NaN;

  elements.totalMarketValue.textContent = formatMoney(marketValue);
  elements.todayProfit.textContent = formatMoney(todayProfit);
  elements.todayProfit.className = signedClass(todayProfit);
  elements.totalProfit.textContent = formatMoney(totalProfit);
  elements.totalProfit.className = signedClass(totalProfit);
  elements.totalReturn.textContent = formatPercent(returnRate);
  elements.totalReturn.className = signedClass(totalProfit);
  elements.totalCostText.textContent = `总成本：${formatMoney(totalCost)}`;
}

function rowName(holding, quote) {
  return quote?.name || holding.name || '';
}

function renderDesktopRows(rows) {
  elements.holdingsBody.innerHTML = rows.map(({ holding, quote, price, preClose, marketValue, todayProfit, totalProfit, returnRate }) => `
    <tr>
      <td>${escapeHtml(holding.code)}</td>
      <td>${rowName(holding, quote) ? escapeHtml(rowName(holding, quote)) : '<span class="muted">--</span>'}</td>
      <td>${formatNumber(holding.shares, 0)}</td>
      <td>${formatMoney(holding.cost)}</td>
      <td>${formatMoney(preClose)}</td>
      <td>${formatMoney(price)}</td>
      <td>${formatMoney(marketValue)}</td>
      <td class="${signedClass(todayProfit)}">${formatMoney(todayProfit)}</td>
      <td class="${signedClass(totalProfit)}">${formatMoney(totalProfit)}</td>
      <td class="${signedClass(totalProfit)}">${formatPercent(returnRate)}</td>
      <td>${quote?.date || '--'} ${quote?.time || ''}</td>
      <td>
        <div class="row-actions">
          <button class="icon-button" data-action="edit" data-code="${escapeHtml(holding.code)}" type="button">编辑</button>
          <button class="icon-button" data-action="delete" data-code="${escapeHtml(holding.code)}" type="button">删除</button>
        </div>
      </td>
    </tr>
  `).join('');
}

function renderMobileRows(rows) {
  elements.mobileHoldings.innerHTML = rows.map(({ holding, quote, price, preClose, marketValue, todayProfit, totalProfit, returnRate }) => `
    <article class="holding-card">
      <header>
        <div>
          <strong>${escapeHtml(rowName(holding, quote) || holding.code)}</strong>
          <span>${escapeHtml(holding.code)}</span>
        </div>
        <div class="row-actions">
          <button class="icon-button" data-action="edit" data-code="${escapeHtml(holding.code)}" type="button">编辑</button>
          <button class="icon-button" data-action="delete" data-code="${escapeHtml(holding.code)}" type="button">删除</button>
        </div>
      </header>
      <dl>
        <div><dt>数量</dt><dd>${formatNumber(holding.shares, 0)}</dd></div>
        <div><dt>成本价</dt><dd>${formatMoney(holding.cost)}</dd></div>
        <div><dt>昨收</dt><dd>${formatMoney(preClose)}</dd></div>
        <div><dt>现价</dt><dd>${formatMoney(price)}</dd></div>
        <div><dt>市值</dt><dd>${formatMoney(marketValue)}</dd></div>
        <div><dt>今日盈亏</dt><dd class="${signedClass(todayProfit)}">${formatMoney(todayProfit)}</dd></div>
        <div><dt>总盈亏</dt><dd class="${signedClass(totalProfit)}">${formatMoney(totalProfit)}</dd></div>
        <div><dt>收益率</dt><dd class="${signedClass(totalProfit)}">${formatPercent(returnRate)}</dd></div>
      </dl>
      <p>行情时间：${quote?.date || '--'} ${quote?.time || ''}</p>
    </article>
  `).join('');
}

function renderRefreshMeta() {
  elements.lastRefreshText.textContent = `上次刷新：${formatRefreshTime(lastRefreshAt)}`;
  elements.nextRefreshText.textContent = elements.autoRefreshInput.checked
    ? `自动刷新：每 ${Math.round(REFRESH_INTERVAL_MS / 1000)} 秒`
    : '自动刷新：已关闭';
}

function renderHoldings() {
  const rows = buildRows();
  renderDesktopRows(rows);
  renderMobileRows(rows);
  elements.emptyState.classList.toggle('visible', holdings.length === 0);
  renderSummary(rows);
  renderRefreshMeta();
}

function resetAutoRefreshTimer() {
  clearInterval(autoRefreshTimer);
  if (!elements.autoRefreshInput.checked) {
    renderRefreshMeta();
    return;
  }

  autoRefreshTimer = setInterval(() => {
    refreshQuotes({ silent: true });
  }, REFRESH_INTERVAL_MS);
  renderRefreshMeta();
}

async function refreshQuotes({ silent = false } = {}) {
  if (isRefreshing) {
    return;
  }

  if (!holdings.length) {
    elements.statusText.textContent = '还没有持仓，新增后即可刷新行情。';
    renderHoldings();
    return;
  }

  isRefreshing = true;
  elements.refreshBtn.disabled = true;
  elements.refreshBtn.textContent = '刷新中...';
  if (!silent) {
    elements.statusText.textContent = '正在从 Tushare 拉取行情...';
  }

  try {
    const response = await fetch('/api/quotes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ codes: holdings.map((holding) => holding.code) }),
    });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || '行情刷新失败。');
    }

    quotes = new Map(payload.quotes.map((quote) => [quote.ts_code, quote]));
    lastRefreshAt = new Date(payload.fetchedAt);
    renderHoldings();
    elements.statusText.textContent = `已更新 ${payload.quotes.length} 条行情。`;
    resetAutoRefreshTimer();
  } catch (error) {
    elements.statusText.textContent = error instanceof Error ? error.message : '行情刷新失败。';
  } finally {
    isRefreshing = false;
    elements.refreshBtn.disabled = false;
    elements.refreshBtn.textContent = '立即刷新';
  }
}

elements.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const formData = new FormData(elements.form);
  const code = normalizeCode(formData.get('code'));
  const shares = Number(formData.get('shares'));
  const cost = Number(formData.get('cost'));
  const name = String(formData.get('name') || '').trim();

  if (!code || !Number.isFinite(shares) || shares <= 0 || !Number.isFinite(cost) || cost < 0) {
    elements.statusText.textContent = '请填写有效的代码、持仓数量和成本价。';
    return;
  }

  const submitButton = elements.form.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  submitButton.textContent = '保存中...';

  try {
    const savedHolding = await persistHolding({ code, name, shares, cost });
    const existingIndex = holdings.findIndex((holding) => holding.code === savedHolding.code);
    if (existingIndex >= 0) {
      holdings[existingIndex] = savedHolding;
    } else {
      holdings.push(savedHolding);
    }

    elements.form.reset();
    renderHoldings();
    elements.statusText.textContent = '持仓已保存到服务端 SQLite。';
    refreshQuotes();
  } catch (error) {
    elements.statusText.textContent = error instanceof Error ? error.message : '保存持仓失败。';
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = '保存持仓';
  }
});

async function handleHoldingAction(event) {
  const button = event.target.closest('button[data-action]');
  if (!button) {
    return;
  }

  const code = button.dataset.code;
  const holding = holdings.find((item) => item.code === code);
  if (!holding) {
    return;
  }

  if (button.dataset.action === 'edit') {
    elements.codeInput.value = holding.code;
    elements.nameInput.value = holding.name || '';
    elements.sharesInput.value = holding.shares;
    elements.costInput.value = holding.cost;
    elements.codeInput.focus();
    return;
  }

  button.disabled = true;
  try {
    await deleteHolding(code);
    holdings = holdings.filter((item) => item.code !== code);
    quotes.delete(code);
    renderHoldings();
    elements.statusText.textContent = '持仓已从服务端 SQLite 删除。';
  } catch (error) {
    elements.statusText.textContent = error instanceof Error ? error.message : '删除持仓失败。';
  } finally {
    button.disabled = false;
  }
}

elements.holdingsBody.addEventListener('click', handleHoldingAction);
elements.mobileHoldings.addEventListener('click', handleHoldingAction);
elements.refreshBtn.addEventListener('click', () => refreshQuotes());
elements.autoRefreshInput.addEventListener('change', resetAutoRefreshTimer);
elements.clearBtn.addEventListener('click', async () => {
  if (!holdings.length || !confirm('确定清空所有持仓吗？')) {
    return;
  }

  elements.clearBtn.disabled = true;
  try {
    await clearServerHoldings();
    holdings = [];
    quotes = new Map();
    renderHoldings();
    elements.statusText.textContent = '已清空服务端 SQLite 中的持仓。';
  } catch (error) {
    elements.statusText.textContent = error instanceof Error ? error.message : '清空持仓失败。';
  } finally {
    elements.clearBtn.disabled = false;
  }
});

renderHoldings();
resetAutoRefreshTimer();
loadHoldingsFromServer();
