const LEGACY_STORAGE_KEY = 'tool-box.stock-portfolio.holdings.v1';
const REFRESH_INTERVAL_MS = 60_000;

const elements = {
  loginPanel: document.querySelector('#loginPanel'),
  managerApp: document.querySelector('#managerApp'),
  loginForm: document.querySelector('#loginForm'),
  usernameInput: document.querySelector('#usernameInput'),
  passwordInput: document.querySelector('#passwordInput'),
  loginStatus: document.querySelector('#loginStatus'),
  form: document.querySelector('#holdingForm'),
  codeInput: document.querySelector('#codeInput'),
  nameInput: document.querySelector('#nameInput'),
  sharesInput: document.querySelector('#sharesInput'),
  costInput: document.querySelector('#costInput'),
  resetFormBtn: document.querySelector('#resetFormBtn'),
  refreshBtn: document.querySelector('#refreshBtn'),
  autoRefreshInput: document.querySelector('#autoRefreshInput'),
  logoutBtn: document.querySelector('#logoutBtn'),
  clearBtn: document.querySelector('#clearBtn'),
  holdingsBody: document.querySelector('#holdingsBody'),
  mobileHoldings: document.querySelector('#mobileHoldings'),
  emptyState: document.querySelector('#emptyState'),
  statusText: document.querySelector('#statusText'),
  lastRefreshText: document.querySelector('#lastRefreshText'),
  nextRefreshText: document.querySelector('#nextRefreshText'),
  authUserText: document.querySelector('#authUserText'),
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
let authState = { authenticated: false, username: '', authEnabled: true, passwordConfigured: true };
let codeLookupRequestId = 0;
let nameWasAutoFilled = false;

function loadLegacyHoldings() {
  try {
    const parsed = JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function requestJson(url, options = {}, { skipAuthRedirect = false } = {}) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));

  if (response.status === 401 && !skipAuthRedirect) {
    handleLoggedOut(payload.error || '登录已过期，请重新登录。');
  }

  if (!response.ok) {
    throw new Error(payload.error || '服务端请求失败。');
  }

  return payload;
}

async function fetchAuthStatus() {
  return requestJson('/api/auth/status', {}, { skipAuthRedirect: true });
}

async function login(username, password) {
  return requestJson('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  }, { skipAuthRedirect: true });
}

async function logout() {
  return requestJson('/api/auth/logout', { method: 'POST' }, { skipAuthRedirect: true });
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

async function lookupCode(code) {
  const payload = await requestJson(`/api/lookup?code=${encodeURIComponent(code)}`);
  return payload;
}

function showManager(status) {
  authState = {
    authenticated: true,
    username: status.username || 'admin',
    authEnabled: status.authEnabled !== false,
    passwordConfigured: status.passwordConfigured !== false,
  };
  elements.loginPanel.hidden = true;
  elements.managerApp.hidden = false;
  elements.authUserText.textContent = authState.authEnabled
    ? `当前用户：${authState.username}`
    : '当前用户：本机免鉴权';
  elements.loginStatus.textContent = '';
  resetAutoRefreshTimer();
}

function handleLoggedOut(message = '请先登录。') {
  authState = { authenticated: false, username: '', authEnabled: true, passwordConfigured: true };
  holdings = [];
  quotes = new Map();
  lastRefreshAt = undefined;
  clearInterval(autoRefreshTimer);
  elements.managerApp.hidden = true;
  elements.loginPanel.hidden = false;
  elements.loginStatus.textContent = message;
  elements.loginStatus.className = 'auth-status';
  elements.passwordInput.value = '';
  if (!elements.usernameInput.value) {
    elements.usernameInput.value = 'admin';
  }
  renderHoldings();
  elements.usernameInput.focus();
}

async function initializeApp() {
  renderHoldings();

  try {
    const status = await fetchAuthStatus();
    if (status.authenticated || !status.authEnabled) {
      showManager(status);
      await loadHoldingsFromServer();
      return;
    }

    authState = {
      authenticated: false,
      username: '',
      authEnabled: status.authEnabled !== false,
      passwordConfigured: status.passwordConfigured !== false,
    };
    elements.managerApp.hidden = true;
    elements.loginPanel.hidden = false;
    elements.loginForm.querySelector('button[type="submit"]').disabled = !authState.passwordConfigured;
    elements.loginStatus.textContent = authState.passwordConfigured
      ? ''
      : '服务端未配置 PORTFOLIO_AUTH_PASSWORD，暂时无法登录。';
    elements.loginStatus.className = 'auth-status';
    if (!elements.usernameInput.value) {
      elements.usernameInput.value = 'admin';
    }
    elements.usernameInput.focus();
  } catch (error) {
    handleLoggedOut(error instanceof Error ? error.message : '无法读取登录状态，请检查本地服务。');
  }
}

async function migrateLegacyHoldingsIfNeeded() {
  const legacyHoldings = loadLegacyHoldings();
  if (!legacyHoldings.length) {
    return;
  }

  const imported = [];
  const knownCodes = new Set(holdings.map((holding) => holding.code));
  let skipped = 0;
  let failed = 0;

  for (const legacyHolding of legacyHoldings) {
    const code = normalizeCode(legacyHolding.code);
    const shares = Number(legacyHolding.shares);
    const cost = Number(legacyHolding.cost);
    const name = String(legacyHolding.name || '').trim();
    if (!isSupportedCode(code) || !Number.isFinite(shares) || shares <= 0 || !Number.isFinite(cost) || cost < 0) {
      skipped += 1;
      continue;
    }

    if (knownCodes.has(code)) {
      skipped += 1;
      continue;
    }

    try {
      imported.push(await persistHolding({ code, name, shares, cost }));
      knownCodes.add(code);
    } catch {
      failed += 1;
    }
  }

  if (imported.length) {
    holdings = await fetchHoldings();
  }

  if (!failed) {
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  }

  if (imported.length || skipped || failed) {
    elements.statusText.textContent = failed
      ? `已迁移 ${imported.length} 条旧持仓，${failed} 条失败，旧数据已保留。`
      : `已迁移 ${imported.length} 条旧持仓，跳过 ${skipped} 条已存在或无效数据。`;
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

function isSupportedCode(code) {
  return /^\d{6}\.(SH|SZ|BJ)$/.test(code) || /^\d{5}\.HK$/.test(code);
}

function applyAutoFilledName(name) {
  const trimmedName = String(name || '').trim();
  if (!trimmedName) {
    return false;
  }

  if (!elements.nameInput.value.trim() || nameWasAutoFilled) {
    elements.nameInput.value = trimmedName;
    nameWasAutoFilled = true;
    return true;
  }

  return false;
}

async function lookupCodeName({ silent = false } = {}) {
  const normalizedCode = normalizeCode(elements.codeInput.value);
  if (!normalizedCode) {
    return null;
  }

  elements.codeInput.value = normalizedCode;
  if (!isSupportedCode(normalizedCode)) {
    if (!silent) {
      elements.statusText.textContent = '请填写有效的证券代码，例如 600519、000001、600519.SH 或 00700.HK。';
    }
    return null;
  }

  const cachedQuote = quotes.get(normalizedCode);
  if (applyAutoFilledName(cachedQuote?.name)) {
    return cachedQuote;
  }

  const requestId = ++codeLookupRequestId;
  if (!silent) {
    elements.statusText.textContent = `正在识别 ${normalizedCode} 的股票名称...`;
  }

  try {
    const payload = await lookupCode(normalizedCode);
    if (requestId !== codeLookupRequestId) {
      return null;
    }

    if (payload.quote?.ts_code) {
      quotes.set(payload.quote.ts_code, payload.quote);
    }

    const filled = applyAutoFilledName(payload.name || payload.quote?.name);
    if (!silent) {
      elements.statusText.textContent = filled
        ? `已补全代码 ${normalizedCode}，股票名称为 ${elements.nameInput.value}。`
        : `已补全代码 ${normalizedCode}，行情源暂未返回名称。`;
    }
    return payload.quote || null;
  } catch (error) {
    if (!silent) {
      elements.statusText.textContent = error instanceof Error ? error.message : '股票名称识别失败。';
    }
    return null;
  }
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

function sumComplete(rows, key) {
  if (!rows.length || rows.some((row) => !Number.isFinite(row[key]))) {
    return Number.NaN;
  }

  return rows.reduce((total, row) => total + row[key], 0);
}

function sumKnown(rows, key) {
  return rows.length ? rows.reduce((total, row) => total + row[key], 0) : Number.NaN;
}

function renderSummary(rows) {
  const totalCost = sumKnown(rows, 'costValue');
  const marketValue = sumComplete(rows, 'marketValue');
  const todayProfit = sumComplete(rows, 'todayProfit');
  const totalProfit = sumComplete(rows, 'totalProfit');
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
      <td>${escapeHtml(quote?.date || '--')} ${escapeHtml(quote?.time || '')}</td>
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
      <p>行情时间：${escapeHtml(quote?.date || '--')} ${escapeHtml(quote?.time || '')}</p>
    </article>
  `).join('');
}

function renderRefreshMeta() {
  elements.lastRefreshText.textContent = `上次刷新：${formatRefreshTime(lastRefreshAt)}`;
  elements.nextRefreshText.textContent = !authState.authenticated
    ? '自动刷新：登录后启用'
    : elements.autoRefreshInput.checked
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
  if (!authState.authenticated || !elements.autoRefreshInput.checked) {
    renderRefreshMeta();
    return;
  }

  autoRefreshTimer = setInterval(() => {
    refreshQuotes({ silent: true });
  }, REFRESH_INTERVAL_MS);
  renderRefreshMeta();
}

async function refreshQuotes({ silent = false } = {}) {
  if (!authState.authenticated) {
    return;
  }

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
    elements.statusText.textContent = '正在从行情源拉取行情...';
  }

  try {
    const payload = await requestJson('/api/quotes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ codes: holdings.map((holding) => holding.code) }),
    });

    const quoteList = Array.isArray(payload.quotes) ? payload.quotes : [];
    quotes = new Map(quoteList.map((quote) => [quote.ts_code, quote]));
    lastRefreshAt = new Date(payload.fetchedAt);
    renderHoldings();
    const missingCodes = holdings.map((holding) => holding.code).filter((code) => !quotes.has(code));
    elements.statusText.textContent = missingCodes.length
      ? `已更新 ${quoteList.length} 条行情，${missingCodes.length} 条未返回：${missingCodes.join('、')}。`
      : `已更新 ${quoteList.length} 条行情。`;
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
  await lookupCodeName({ silent: true });
  const formData = new FormData(elements.form);
  const code = normalizeCode(formData.get('code'));
  const shares = Number(formData.get('shares'));
  const cost = Number(formData.get('cost'));
  const name = String(formData.get('name') || '').trim();

  if (!isSupportedCode(code)) {
    elements.statusText.textContent = '请填写有效的证券代码，例如 600519、000001、600519.SH 或 00700.HK。';
    return;
  }

  if (!Number.isFinite(shares) || shares <= 0 || !Number.isFinite(cost) || cost < 0) {
    elements.statusText.textContent = '请填写有效的持仓数量和成本价。';
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
    nameWasAutoFilled = false;
    renderHoldings();
    elements.statusText.textContent = savedHolding.name
      ? `持仓已保存到服务端 SQLite，名称为 ${savedHolding.name}。`
      : '持仓已保存到服务端 SQLite。';
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
    nameWasAutoFilled = false;
    elements.statusText.textContent = `正在编辑 ${holding.code}，保存后会覆盖这条持仓。`;
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

elements.loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const formData = new FormData(elements.loginForm);
  const username = String(formData.get('username') || '').trim();
  const password = String(formData.get('password') || '');
  const submitButton = elements.loginForm.querySelector('button[type="submit"]');

  submitButton.disabled = true;
  submitButton.textContent = '登录中...';
  elements.loginStatus.textContent = '正在验证身份...';

  try {
    const status = await login(username, password);
    showManager(status);
    await loadHoldingsFromServer();
  } catch (error) {
    elements.loginStatus.textContent = error instanceof Error ? error.message : '登录失败。';
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = '登录管理台';
  }
});

elements.logoutBtn.addEventListener('click', async () => {
  elements.logoutBtn.disabled = true;
  try {
    await logout();
    handleLoggedOut('已退出登录。');
  } catch (error) {
    elements.statusText.textContent = error instanceof Error ? error.message : '退出登录失败。';
  } finally {
    elements.logoutBtn.disabled = false;
  }
});

elements.resetFormBtn.addEventListener('click', () => {
  elements.form.reset();
  nameWasAutoFilled = false;
  elements.statusText.textContent = '表单已重置。';
});

elements.codeInput.addEventListener('input', () => {
  const rawCode = String(elements.codeInput.value || '').trim();
  if (/^\d{6}$/.test(rawCode)) {
    elements.codeInput.value = normalizeCode(rawCode);
    lookupCodeName({ silent: true });
  }
});

elements.codeInput.addEventListener('blur', () => {
  lookupCodeName();
});

elements.nameInput.addEventListener('input', () => {
  nameWasAutoFilled = false;
});

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

initializeApp();
