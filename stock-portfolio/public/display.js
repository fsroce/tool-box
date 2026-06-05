const REFRESH_INTERVAL_MS = 60_000;

const elements = {
  quoteSource: document.querySelector('#quoteSource'),
  quoteTime: document.querySelector('#quoteTime'),
  refreshTime: document.querySelector('#refreshTime'),
  refreshButton: document.querySelector('#refreshButton'),
  totalMarketValue: document.querySelector('#totalMarketValue'),
  todayProfit: document.querySelector('#todayProfit'),
  totalProfit: document.querySelector('#totalProfit'),
  totalReturn: document.querySelector('#totalReturn'),
  totalCost: document.querySelector('#totalCost'),
  positionCount: document.querySelector('#positionCount'),
  quoteStatus: document.querySelector('#quoteStatus'),
  statusText: document.querySelector('#statusText'),
  positionsBody: document.querySelector('#positionsBody'),
  mobilePositions: document.querySelector('#mobilePositions'),
  emptyState: document.querySelector('#emptyState'),
};

const moneyFormatter = new Intl.NumberFormat('zh-CN', {
  style: 'currency',
  currency: 'CNY',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const numberFormatter = new Intl.NumberFormat('zh-CN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const sharesFormatter = new Intl.NumberFormat('zh-CN', {
  maximumFractionDigits: 4,
});

let isRefreshing = false;
let refreshTimer;

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.error || '数据请求失败。');
  }

  return payload;
}

function formatMoney(value) {
  return Number.isFinite(Number(value)) ? moneyFormatter.format(Number(value)) : '--';
}

function formatNumber(value) {
  return Number.isFinite(Number(value)) ? numberFormatter.format(Number(value)) : '--';
}

function formatShares(value) {
  return Number.isFinite(Number(value)) ? sharesFormatter.format(Number(value)) : '--';
}

function formatPercent(value) {
  return Number.isFinite(Number(value)) ? `${numberFormatter.format(Number(value) * 100)}%` : '--';
}

function formatDateTime(value) {
  if (!value) {
    return '--';
  }

  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return String(value);
  }

  return date.toLocaleString('zh-CN', { hour12: false });
}

function formatQuoteDateTime(item) {
  const date = String(item?.quoteDate || '').trim();
  const time = String(item?.quoteTime || '').trim();
  return [date, time].filter(Boolean).join(' ') || '--';
}

function valueClass(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number === 0) {
    return 'muted';
  }

  return number > 0 ? 'profit' : 'loss';
}

function setValuedText(element, text, value) {
  element.textContent = text;
  element.classList.remove('profit', 'loss', 'muted');
  element.classList.add(valueClass(value));
}

function createCell(text, className = '') {
  const cell = document.createElement('td');
  cell.textContent = text;
  if (className) {
    cell.className = className;
  }
  return cell;
}

function createMetric(label, value, className = '') {
  const wrapper = document.createElement('div');
  const term = document.createElement('dt');
  const detail = document.createElement('dd');
  term.textContent = label;
  detail.textContent = value;
  if (className) {
    detail.className = className;
  }
  wrapper.append(term, detail);
  return wrapper;
}

function renderTablePosition(position) {
  const row = document.createElement('tr');
  row.append(
    createCell(position.code || '--'),
    createCell(position.name || '--'),
    createCell(formatShares(position.shares)),
    createCell(formatNumber(position.cost)),
    createCell(formatNumber(position.preClose)),
    createCell(formatNumber(position.price)),
    createCell(formatMoney(position.marketValue)),
    createCell(formatMoney(position.todayProfit), valueClass(position.todayProfit)),
    createCell(formatMoney(position.totalProfit), valueClass(position.totalProfit)),
    createCell(formatPercent(position.returnRate), valueClass(position.returnRate)),
    createCell(formatQuoteDateTime(position), 'muted'),
  );
  return row;
}

function renderMobilePosition(position) {
  const card = document.createElement('article');
  card.className = 'position-card';

  const header = document.createElement('header');
  const identity = document.createElement('div');
  const name = document.createElement('strong');
  const code = document.createElement('span');
  const marketValue = document.createElement('strong');
  name.textContent = position.name || '--';
  code.textContent = position.code || '--';
  marketValue.textContent = formatMoney(position.marketValue);
  identity.append(name, code);
  header.append(identity, marketValue);

  const metrics = document.createElement('dl');
  metrics.append(
    createMetric('现价', formatNumber(position.price)),
    createMetric('昨收', formatNumber(position.preClose)),
    createMetric('今日盈亏', formatMoney(position.todayProfit), valueClass(position.todayProfit)),
    createMetric('总盈亏', formatMoney(position.totalProfit), valueClass(position.totalProfit)),
    createMetric('收益率', formatPercent(position.returnRate), valueClass(position.returnRate)),
    createMetric('行情时间', formatQuoteDateTime(position), 'muted'),
  );

  card.append(header, metrics);
  return card;
}

function renderPortfolio(payload) {
  const summary = payload.summary || {};
  const meta = payload.meta || {};
  const positions = Array.isArray(payload.positions) ? payload.positions : [];
  const missingCodes = Array.isArray(meta.missingCodes) ? meta.missingCodes : [];

  elements.quoteSource.textContent = `行情源：${meta.source || '--'}`;
  elements.quoteTime.textContent = `行情时间：${[meta.quoteDate, meta.quoteTime].filter(Boolean).join(' ') || '--'}`;
  elements.refreshTime.textContent = `刷新时间：${formatDateTime(meta.fetchedAt)}`;
  elements.totalMarketValue.textContent = formatMoney(summary.totalMarketValue);
  setValuedText(elements.todayProfit, formatMoney(summary.todayProfit), summary.todayProfit);
  setValuedText(elements.totalProfit, formatMoney(summary.totalProfit), summary.totalProfit);
  setValuedText(elements.totalReturn, formatPercent(summary.totalReturn), summary.totalReturn);
  elements.totalCost.textContent = `总成本：${formatMoney(summary.totalCost)}`;
  elements.positionCount.textContent = `${summary.positionCount || positions.length} 只持仓`;
  elements.quoteStatus.textContent = meta.isComplete ? '行情完整' : `缺行情：${missingCodes.join('、') || '--'}`;
  elements.statusText.textContent = positions.length ? '数据已更新' : '暂无持仓数据';

  elements.positionsBody.replaceChildren(...positions.map(renderTablePosition));
  elements.mobilePositions.replaceChildren(...positions.map(renderMobilePosition));
  elements.emptyState.classList.toggle('visible', positions.length === 0);
}

async function loadPortfolio(refresh = false) {
  if (isRefreshing) {
    return;
  }

  isRefreshing = true;
  elements.refreshButton.disabled = true;
  elements.statusText.textContent = refresh ? '正在刷新价格...' : '正在读取持仓...';

  try {
    const payload = await requestJson('/api/display/portfolio/refresh', { method: 'POST' });
    renderPortfolio(payload);
  } catch (error) {
    elements.statusText.textContent = error instanceof Error ? error.message : '数据更新失败。';
  } finally {
    isRefreshing = false;
    elements.refreshButton.disabled = false;
  }
}

function resetRefreshTimer() {
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    if (document.visibilityState === 'visible') {
      loadPortfolio(true);
    }
  }, REFRESH_INTERVAL_MS);
}

elements.refreshButton.addEventListener('click', () => {
  loadPortfolio(true);
  resetRefreshTimer();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    loadPortfolio(true);
    resetRefreshTimer();
  }
});

loadPortfolio(false);
resetRefreshTimer();
