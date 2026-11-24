/* KVM Console renderer — small, framework-free. */
const api = window.kvm;
const el = (id) => document.getElementById(id);

const en = () => (window.i18n?.active?.() || 'zh') === 'en';
const t = (text, params) => (window.i18n?.t ? window.i18n.t(text, params) : text);
const termPrompt = () => `$ ${t('等待命令')}`;

const STATE_LABEL = {
  idle: '待连接',
  loading: '正在打开',
  login: '正在登录',
  kvm: '正在进入 KVM',
  ready: '就绪',
  manual: '需手动处理',
  error: '连接失败',
};

let state = null;
let scan = null;
let mediaFile = null;
let dockOpen = false;
let dockPanel = 'input';
let dockPicked = new Set();
let sidePanel = null;
let panelUi = { dockOpen: false, side: null, panel: null };
let targetsTouched = false;
let scanAutoAt = 0;
const PANEL_MODE = new URLSearchParams(location.search).has('panel');
if (PANEL_MODE) document.body.classList.add('panel-mode');
let tabsDragging = false;
let launcherQuery = '';
let launcherSel = 0;
let lastGridKey = '';
let toastTimer = null;
let landingDone = false;
let lastStates = new Map();
const pickedIps = new Set();

const THEME_KEY = 'kvm-theme';
let themeMode = localStorage.getItem(THEME_KEY) || 'auto';
const themeMedia = window.matchMedia('(prefers-color-scheme: light)');

function applyTheme() {
  const systemLight =
    state?.app && typeof state.app.nativeDark === 'boolean'
      ? !state.app.nativeDark
      : themeMedia.matches;
  const light = themeMode === 'light' || (themeMode === 'auto' && systemLight);
  document.documentElement.dataset.theme = light ? 'light' : 'dark';
  const select = el('set-theme');
  if (select) select.value = themeMode;
}

function cycleTheme() {
  themeMode = themeMode === 'auto' ? 'light' : themeMode === 'light' ? 'dark' : 'auto';
  localStorage.setItem(THEME_KEY, themeMode);
  applyTheme();
  toast(`主题：${themeMode === 'auto' ? '跟随系统' : themeMode === 'light' ? '日间' : '夜间'}`, 'ok', 1800);
}
let connectPrefill = null;
let pendingSerial = '';
const lastLicense = new Map();

const BUILTIN_CREDS = [
  { u: 'Administrator', p: 'Admin@9000', label: '华为 / 超聚变' },
  { u: 'admin', p: 'Admin@9000', label: '华为（新固件）' },
  { u: 'root', p: 'calvin', label: '戴尔 iDRAC' },
  { u: 'admin', p: 'admin', label: '浪潮 ISBMC' },
  { u: 'superuser', p: 'superuser', label: '浪潮（旧）' },
];

/* Saved presets live in fixed slots, so a pair keeps its position instead of
   shifting when another slot is cleared. */
const PRESET_SLOTS = 6;
const CRED_PRESET_KEY = 'kvm-cred-presets';

function credSlots() {
  let saved = [];
  try {
    const parsed = JSON.parse(localStorage.getItem(CRED_PRESET_KEY) || '[]');
    if (Array.isArray(parsed)) saved = parsed;
  } catch {
    /* ignore broken storage */
  }
  const slots = [];
  for (let i = 0; i < PRESET_SLOTS; i += 1) {
    const item = saved[i];
    slots.push(item && item.u && item.p ? { u: String(item.u), p: String(item.p) } : null);
  }
  return slots;
}

function writeCredSlots(slots) {
  localStorage.setItem(CRED_PRESET_KEY, JSON.stringify(slots.slice(0, PRESET_SLOTS)));
}

function renderPresets() {
  const builtin = BUILTIN_CREDS.map(
    (c) =>
      `<span class="preset-chip" data-u="${esc(c.u)}" data-p="${esc(c.p)}" title="${esc(c.label)}">${esc(c.u)} : ${esc(c.p)}</span>`,
  ).join('');
  const saved = credSlots()
    .map((c, i) =>
      c
        ? `<span class="preset-chip custom" data-slot="${i}" data-u="${esc(c.u)}" data-p="${esc(c.p)}">${esc(c.u)} : ${esc(c.p)}<b class="del" data-del="${i}" title="${esc(t('删除这个预设'))}">×</b></span>`
        : `<span class="preset-chip preset-empty" data-slot="${i}" title="${esc(t('点击把当前用户名和密码存到这个位置'))}">${esc(t('空位'))}</span>`,
    )
    .join('');
  const html = builtin + saved;
  for (const id of ['l-presets', 'c-presets']) {
    const box = el(id);
    if (box) box.innerHTML = html;
  }
}

function storeCredSlot(prefix, index) {
  const u = el(`${prefix}-username`).value.trim();
  const p = el(`${prefix}-password`).value;
  if (!u || !p) return toast('先填好用户名和密码，再存为预设', 'err');
  const slots = credSlots();
  slots[index] = { u, p };
  writeCredSlots(slots);
  renderPresets();
  return toast('已保存为快速预设', 'ok');
}

function vendorDefault(vendorId) {
  return (state.vendors || []).find((v) => v.id === vendorId)?.defaults?.[0] || null;
}

/** switching vendor overwrites user/password with that vendor's default pair */
function applyVendorDefaults(prefix) {
  const d = vendorDefault(el(`${prefix}-vendor`).value);
  if (!d) return;
  el(`${prefix}-username`).value = d.u;
  el(`${prefix}-password`).value = d.p;
}

function fillConnectDefaults() {
  applyVendorDefaults('c');
}

function fillLandingDefaults() {
  applyVendorDefaults('l');
}

function fillConnectForm(v) {
  el('c-host').value = v.host || '';
  el('c-port').value = String(v.port || 443);
  el('c-scheme').value = v.scheme || 'https';
  el('c-vendor').value = v.vendor || 'generic';
  el('c-username').value = v.username || '';
  el('c-password').value = v.password || '';
  el('c-name').value = v.name || '';
  el('c-kvm').value = '';
  el('c-mode').value = v.mode || 'auto';
  pendingSerial = v.serial || '';
  fillVendorInfo(el('c-vendor').value);
}

function openConnectFor(host, mode = 'auto') {
  const preset = (state.vendors || []).find((v) => v.id === (host.vendor || 'generic'))?.defaults?.[0];
  connectPrefill = {
    host: host.ip,
    port: host.port || 443,
    scheme: host.scheme || 'https',
    vendor: host.vendor || 'generic',
    username: host.credential?.username || preset?.u || '',
    password: host.credential?.password || preset?.p || '',
    name: host.model || host.title || '',
    serial: host.serial || '',
    mode,
  };
  openSide('connect', connectPrefill);
}

function savePreset(prefix) {
  const u = el(`${prefix}-username`).value.trim();
  const p = el(`${prefix}-password`).value;
  if (!u || !p) {
    toast('先填好用户名和密码，再存为预设', 'err');
    return;
  }
  const slots = credSlots();
  const exists =
    slots.some((c) => c && c.u === u && c.p === p) ||
    BUILTIN_CREDS.some((c) => c.u === u && c.p === p);
  if (exists) {
    toast('该组合已在预设里', 'ok');
    return;
  }
  const free = slots.indexOf(null);
  if (free < 0) {
    toast('预设已满，先删掉一个', 'err');
    return;
  }
  slots[free] = { u, p };
  writeCredSlots(slots);
  renderPresets();
  toast('已保存为快速预设', 'ok');
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ------------------------------------------------------------------ boot */
async function init() {
  applyTheme();
  el('term-output').textContent = termPrompt();
  themeMedia.addEventListener('change', () => { if (themeMode === 'auto') applyTheme(); });
  bindTopbar();
  bindSheets();
  renderDownloads();
  observeGrid();
  window.addEventListener('resize', sendGrid);

  const snapshot = await api.snapshot();
  render(snapshot);
  api.onState(render);
  api.onDownload(renderDownload);
  api.onScan((next) => {
    scan = next;
    if (state) state.scan = next;
    renderScan();
  });


  if (snapshot.app.encryption === 'plain' && !localStorage.getItem('warned-plain')) {
    localStorage.setItem('warned-plain', '1');
    toast('系统钥匙串不可用，凭据将以 base64 明文保存在本机', 'err', 7000);
  }
  setInterval(sendGrid, 1200);
}

function render(next) {
  if (!next) return;
  const prevFocusId = state?.focusId;
  state = next;
  scan = next.scan;
  applyTheme();
  const layout = state.layout || { cols: 3, rows: 3 };
  document.documentElement.style.setProperty('--cols', layout.cols);
  document.documentElement.style.setProperty('--rows', layout.rows);

  notifyTransitions(next.sessions || []);
  if (
    dockOpen &&
    !sidePanel &&
    state.mode === 'focus' &&
    state.focusId &&
    state.focusId !== prevFocusId &&
    !targetsTouched
  ) {
    dockPicked = new Set([state.focusId]);
  }
  if (sidePanel === 'connect') renderConnectRecent();
  renderDock();
  renderTopbarActive();
  notifyLicenses(next.devices || []);
  renderVendorOptions();
  renderPresets();
  renderTabs();
  renderTiles();
  renderStat();
  renderOverlay();
  renderFocusInfo();
  renderLanding();
  renderHistory();
  renderScan();
  renderDock();
  syncLayoutSeg();
  sendGrid();
}

function notifyLicenses(list) {
  for (const d of list) {
    const prev = lastLicense.get(d.id);
    if (d.license && d.license.state === 'activated' && prev !== 'activated') {
      toast(t('{host}：{note}', { host: d.host, note: t(d.license.note) }), 'ok', 9000);
    } else if (d.license && d.license.state === 'failed' && prev !== 'failed') {
      const deviceId = d.id;
      toast(t('{host}：{note}', { host: d.host, note: t(d.license.note) }), 'err', 0, {
        label: '手动上传许可',
        run: () => void uploadLicense(deviceId),
      });
    }
    lastLicense.set(d.id, d.license ? d.license.state : undefined);
  }
}

function notifyTransitions(list) {
  for (const s of list) {
    const prev = lastStates.get(s.id);
    if (s.state === 'manual' && prev !== 'manual') {
      const device = (state.devices || []).find((d) => d.id === s.id);
      if (device && device.license && device.license.state === 'failed') continue;
      toast(t('{name}：{detail}', { name: s.name, detail: t(s.detail || '需要手动处理') }), 'err', 10000);
    } else if (s.state === 'error' && prev !== 'error') {
      toast(t('{name}：{detail}', { name: s.name, detail: t(s.detail || '连接失败') }), 'err', 8000);
    }
  }
  lastStates = new Map(list.map((s) => [s.id, s.state]));
}

/* --------------------------------------------------------------- helpers */
const sessions = () => state.sessions || [];
const devices = () => state.devices || [];

function sessionOf(id) {
  return sessions().find((s) => s.id === id);
}

function labelOf(vendorId) {
  const normalized = vendorId === 'xfusion' ? 'huawei' : vendorId;
  const lang = window.__i18n?.active?.() || 'zh';
  const names = {
    huawei: { zh: '华为/超聚变', en: 'Huawei/xFusion' },
    dell: { zh: '戴尔 iDRAC', en: 'Dell iDRAC' },
    inspur: { zh: '浪潮', en: 'Inspur' },
    generic: { zh: '通用', en: 'Generic' },
  };
  if (names[normalized]) return names[normalized][lang];
  const v = (state.vendors || []).find((x) => x.id === normalized);
  return v ? v.label : normalized || '未知';
}

function relTime(ts) {
  if (!ts) return t('从未');
  const diff = Date.now() - ts;
  if (diff < 60_000) return t('刚刚');
  if (diff < 3_600_000) return t('{n} 分钟前', { n: Math.floor(diff / 60_000) });
  if (diff < 86_400_000) return t('{n} 小时前', { n: Math.floor(diff / 3_600_000) });
  return t('{n} 天前', { n: Math.floor(diff / 86_400_000) });
}

function sendGrid() {
  const tiles = el('tiles');
  if (!tiles) return;
  const r = tiles.getBoundingClientRect();
  const rect = {
    x: Math.round(r.left),
    y: Math.round(r.top),
    width: Math.round(r.width),
    height: Math.round(r.height),
  };
  const key = `${rect.x}:${rect.y}:${rect.width}:${rect.height}`;
  if (key === lastGridKey || rect.width < 10) return;
  lastGridKey = key;
  api.setGrid(rect);
}

function observeGrid() {
  if (typeof ResizeObserver === 'undefined') return;
  new ResizeObserver(() => sendGrid()).observe(el('tiles'));
}

/* ------------------------------------------------------------------ tabs */
function tabLabel(s) {
  return (s.model || s.name || s.host || '').trim();
}

function chipShell(s, i) {
  return `
    <div class="chip" data-id="${esc(s.id)}" title="Alt ${i + 1}">
      <span class="num">${i + 1}</span>
      <span class="dot ${s.state}"></span>
      <span class="who"><b>${esc(tabLabel(s))}</b><span class="host">${esc(s.host)}</span><span class="sn">SN：${esc(s.serial || '---')}</span></span>
      <button class="web ${s.webOpen ? 'on' : ''}" data-web="${esc(s.id)}" title="带外 Web（免密打开）">Web</button>
      <span class="x" data-close="${esc(s.id)}" title="关闭标签">×</span>
    </div>`;
}

let tabsSig = '';

function renderTabs() {
  if (tabsDragging) return;
  const list = sessions();
  if (!list.length) {
    el('strip').innerHTML = '<span class="muted small" style="padding:0 8px">没有打开的会话</span>';
    tabsSig = '';
    return;
  }
  const sig = list.map((s) => s.id).join(',');
  if (sig !== tabsSig) {
    tabsSig = sig;
    el('strip').innerHTML = list.map((s, i) => chipShell(s, i)).join('');
  }
  const nodes = el('strip').children;
  list.forEach((s, i) => {
    const node = nodes[i];
    if (!node) return;
    const dot = node.querySelector('.dot');
    if (dot) dot.className = `dot ${s.state}`;
    const host = node.querySelector('.host');
    if (host) host.textContent = s.host;
    const sn = node.querySelector('.sn');
    if (sn) sn.textContent = `SN：${s.serial || '---'}`;
    const name = node.querySelector('.who b');
    if (name) name.textContent = tabLabel(s);
    const web = node.querySelector('.web');
    if (web) web.classList.toggle('on', Boolean(s.webOpen));
    node.classList.toggle('active', state.mode === 'focus' && state.focusId === s.id);
  });
}

/* ----------------------------------------------------------------- tiles */
function tileShell(s, i) {
  return `
    <div class="tile" data-state="${s.state}" data-id="${esc(s.id)}">
      <div class="tile-face">
        <div class="row1">
          <span class="idx">${i + 1}</span>
          <span class="name">${esc(s.name)}</span>
          <span class="dot ${s.state}"></span>
        </div>
        <div class="host"></div>
        <div class="state"></div>
        <div class="actions">
          <button class="btn tiny" data-act="reconnect" data-id="${esc(s.id)}">重连</button>
          <button class="btn tiny" data-act="focus" data-id="${esc(s.id)}">打开</button>
          <button class="btn tiny license hidden" data-act="license" data-id="${esc(s.id)}">导入许可</button>
          <button class="btn tiny web" data-act="web" data-id="${esc(s.id)}">${s.webOpen ? 'KVM' : 'Web'}</button>
          <button class="btn tiny console hidden" data-act="console" data-id="${esc(s.id)}">显示控制台</button>
        </div>
      </div>
    </div>`;
}

function updateTile(node, s) {
  node.dataset.state = s.state;
  const dot = node.querySelector('.dot');
  if (dot) dot.className = `dot ${s.state}`;
  const name = node.querySelector('.name');
  if (name) name.textContent = s.name;
  const host = node.querySelector('.host');
  if (host) host.textContent = `${s.host} · ${labelOf(s.vendor)}${s.model ? ' · ' + s.model : ''}`;
  const st = node.querySelector('.state');
  if (st) {
    const spinner = ['loading', 'login', 'kvm'].includes(s.state) ? '<span class="spinner"></span>' : '';
    st.className = `state ${s.state === 'error' ? 'err' : s.state === 'manual' ? 'warn' : ''}`;
    st.innerHTML = `${spinner}${esc(s.detail || STATE_LABEL[s.state])}`;
  }
  const webBtn = node.querySelector('[data-act="web"]');
  if (webBtn) webBtn.textContent = s.webOpen ? 'KVM' : 'Web';
  const lic = node.querySelector('[data-act="license"]');
  if (lic) lic.classList.toggle('hidden', !(s.license && s.license.state === 'failed'));
  const open = node.querySelector('[data-act="focus"]');
  if (open) open.classList.toggle('hidden', s.state === 'error' || !!s.external);
  const con = node.querySelector('[data-act="console"]');
  if (con) con.classList.toggle('hidden', !s.external);
}

let tilesSig = '';

function renderTiles() {
  const layout = state.layout || { cols: 3, rows: 3 };
  const cells = layout.cols * layout.rows;
  const list = sessions();
  const sig = `${layout.cols}x${layout.rows}|${list.map((s) => s.id).join(',')}`;
  const container = el('tiles');
  if (sig !== tilesSig) {
    tilesSig = sig;
    let html = '';
    for (let i = 0; i < cells; i++) {
      const s = list[i];
      html += s ? tileShell(s, i) : '<div class="tile empty"></div>';
    }
    container.innerHTML = html;
  }
  const nodes = container.children;
  for (let i = 0; i < cells; i++) {
    const s = list[i];
    const node = nodes[i];
    if (!s || !node) continue;
    updateTile(node, s);
  }
  el('empty').classList.add('hidden');
}

function renderStat() {
  const list = sessions();
  const ready = list.filter((s) => s.state === 'ready').length;
  const bad = list.filter((s) => s.state === 'error').length;
  const counts = `${list.length} ${en() ? 'tabs' : '个标签'} · <b>${ready}</b> ${en() ? 'ready' : '就绪'}${
    bad ? ` · <span style="color:#f85149">${bad} ${en() ? 'failed' : '失败'}</span>` : ''
  }`;
  el('stat').innerHTML = `${counts} · v${esc(state.app.version)}${state.app.demo ? ' · DEMO' : ''}`;
}

function renderFocusInfo() {
  const info = el('focus-info');
  info.classList.toggle('hidden', state.mode !== 'focus');
  if (state.mode === 'focus' && state.focusId) {
    const s = sessionOf(state.focusId);
    el('focus-name').textContent = s ? `${s.name} · ${s.host}` : '';
  }
}

/* ---------------------------------------------------------------- landing */
function renderLanding() {
  // No landing/connect page: an empty grid is the resting state.
  const show = false;
  el('landing').classList.toggle('hidden', true);
  el('empty').classList.add('hidden');
  if (!show) {
    landingDone = false;
    return;
  }

  const recent = devices()
    .slice()
    .sort((a, b) => (b.lastUsedAt ?? b.createdAt) - (a.lastUsedAt ?? a.createdAt))
    .slice(0, 6);
  el('landing-recent').innerHTML =
    recent
      .map(
        (d) => `
        <div class="recent-row" data-id="${esc(d.id)}">
          <span class="dot ${d.open ? 'ready' : 'idle'}"></span>
          <span class="who"><b>${esc(d.name || d.host)}</b><span>${esc(d.host)}:${d.port} · ${esc(labelOf(d.vendor))}${d.model ? ' · ' + esc(d.model) : ''}</span></span>
          <span class="when">${esc(relTime(d.lastUsedAt))}</span>
        </div>`,
      )
      .join('') || '<div class="muted small">还没有连接记录</div>';

  if (!landingDone) {
    landingDone = true;
    fillLandingDefaults();
    setTimeout(() => el('l-host').focus(), 40);
  }
}

/* ---------------------------------------------------------------- history */
function renderHistory() {
  const list = devices()
    .slice()
    .sort((a, b) => (b.lastUsedAt ?? b.createdAt) - (a.lastUsedAt ?? a.createdAt));
  const historyBox = el('history-list');
  if (!historyBox) return;
  historyBox.innerHTML =
    list
      .map((d) => {
        const st = d.open ? sessionOf(d.id)?.state || 'loading' : 'idle';
        return `
        <div class="history-row" data-id="${esc(d.id)}">
          <span class="dot ${st}"></span>
          <span class="who">
            <b>${esc(d.name || d.host)} ${d.open ? '<span class="badge-open">已打开</span>' : ''}</b>
            <span>${esc(d.host)}:${d.port} · ${esc(labelOf(d.vendor))} · ${d.hasPassword ? esc(d.username) : esc(t('无凭据'))}</span>
          </span>
          <span class="when">${esc(relTime(d.lastUsedAt))}${d.ephemeral ? ` · ${esc(t('临时'))}` : ''}</span>
          <button class="btn tiny" data-act="open" data-id="${esc(d.id)}">${d.open ? '聚焦' : '连接'}</button>
          <button class="btn tiny ghost" data-act="del" data-id="${esc(d.id)}">删除</button>
        </div>`;
      })
      .join('') || '<div class="scan-empty">还没有连接记录</div>';
}

/* ------------------------------------------------------------------- scan */
function savedDeviceFor(ip, port) {
  return devices().find((d) => d.host === ip && (d.port || 443) === (port || 443) && d.hasPassword);
}

function renderScan() {
  const s = scan;
  if (!s) return;
  const input = el('scan-subnet');
  if (document.activeElement !== input) input.value = s.subnet || state?.app?.subnets?.[0]?.cidr || '';

  const pct = s.total ? Math.round((s.scanned / s.total) * 100) : 0;
  el('scan-bar-fill').style.width = `${pct}%`;
  document.querySelector('.scan-bar')?.classList.toggle('indeterminate', s.running && s.scanned === 0);
  el('btn-scan-start').classList.toggle('hidden', s.running);
  el('btn-scan-cancel').classList.toggle('hidden', !s.running);

  const status = s.running
    ? `扫描中 ${s.scanned}/${s.total} · 已发现 ${s.hosts.length} 台`
    : s.error
      ? `失败：${s.error}`
      : s.finishedAt
        ? `完成，发现 ${s.hosts.length} 台`
        : '扫描会尝试常见默认凭据（每台最多 2 次，避免锁号）';
  el('scan-status').textContent = status;

  el('scan-results').innerHTML =
    s.hosts
      .map((h) => {
        const saved = savedDeviceFor(h.ip, h.port) || (h.saved ? { model: h.model, serial: h.serial, username: h.savedUsername } : null);
        const mode = !h.redfish
          ? 'unavailable'
          : h.savedCredential || h.saved
            ? 'saved'
            : h.credential
              ? 'default'
              : 'unknown';
        const credLabel = { unavailable: '不可用', unknown: '未知', default: '默认', saved: '已保存' }[mode];
        const cred = `<span class="pill cred-${mode}">凭据：${credLabel}</span>`;
        return `
        <div class="scan-row ${pickedIps.has(h.ip) ? 'picked' : ''}" data-ip="${esc(h.ip)}">
          <input type="checkbox" class="pick" data-ip="${esc(h.ip)}" ${pickedIps.has(h.ip) ? 'checked' : ''} />
          <span class="ip-block">
            <span class="ip">${esc(h.ip)}${h.port && h.port !== 443 ? ':' + h.port : ''}</span>
            <span class="sn">SN：${esc(h.serial || saved?.serial || '---')}</span>
          </span>
          <span class="who">
            <b>${esc(h.model || saved?.model || h.title || h.vendorLabel || '未知设备')}</b>
            <span>${esc(labelOf(h.vendor || 'generic'))}${h.mac ? ' · ' + esc(h.mac) : ''}${h.latencyMs ? ' · ' + h.latencyMs + 'ms' : ''}</span>
          </span>
          <span class="scan-cred">${cred}</span>
          <span class="scan-actions">
            <button class="btn tiny" data-act="scan-connect" data-ip="${esc(h.ip)}">连接</button>
            <button class="btn tiny" data-act="scan-connect-vnc" data-ip="${esc(h.ip)}">VNC</button>
          </span>
        </div>`;
      })
      .join('') ||
    `<div class="scan-empty">${s.running ? '正在扫描…' : '还没有结果，输入网段后点“开始扫描”'}</div>`;

  const all = s.hosts.map((h) => h.ip);
  const pickedCount = all.filter((ip) => pickedIps.has(ip)).length;
  el('scan-select-all').checked = all.length > 0 && pickedCount === all.length;
  const btn = el('btn-scan-connect');
  btn.classList.toggle('hidden', pickedCount === 0);
  btn.textContent = `连接选中 (${pickedCount})`;
}

/* ------------------------------------------------------------------ media */
function humanSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}



function renderTopbarActive() {
  const mode = state?.mode;
  const set = (id, on) => el(id)?.classList.toggle('on', !!on);
  set('btn-connect', mode === 'connect');
  set('btn-scan', dockOpen && sidePanel === 'scan');
  set('btn-launcher', dockOpen && sidePanel === 'launcher');
  set('btn-connect', dockOpen && sidePanel === 'connect');
  set('btn-media', dockOpen && !sidePanel && dockPanel === 'media');
  set('btn-input', dockOpen && !sidePanel && dockPanel === 'input');
  set('btn-power', dockOpen && !sidePanel && dockPanel === 'power');
  set('btn-broadcast', !!state?.app?.broadcast);
}

function dockIds() {
  return [...dockPicked].filter((id) => sessions().some((s) => s.id === id));
}

function renderDock() {
  const dock = el('tool-dock');
  if (!dock) return;
  const show = dockOpen && !!state && ['grid', 'focus'].includes(state.mode);
  dock.classList.toggle('hidden', !show);

  const sheets = { connect: 'sheet-connect', scan: 'sheet-scan', launcher: 'sheet-launcher', shortcuts: 'sheet-shortcuts' };
  for (const [name, id] of Object.entries(sheets)) {
    const node = el(id);
    if (!node) continue;
    const on = show && sidePanel === name;
    node.classList.toggle('hidden', !on);
    node.classList.toggle('in-dock', on);
  }

  if (show) {
    const hideTargets = !!sidePanel || dockPanel === 'downloads';
    dock.querySelector('.dock-targets')?.classList.toggle('hidden', hideTargets);
    const tabs = dock.querySelector('.dock-tabs');
    if (tabs) tabs.classList.toggle('hidden', !!sidePanel);
    for (const tab of dock.querySelectorAll('.dock-tab')) {
      tab.classList.toggle('on', tab.dataset.panel === dockPanel);
    }
    for (const panel of ['input', 'media', 'power', 'broadcast', 'reconnect', 'terminal', 'downloads']) {
      const node = el(`dock-panel-${panel}`);
      if (node) node.classList.toggle('hidden', !!sidePanel || panel !== dockPanel);
    }
    const bcast = el('btn-broadcast-toggle');
    if (bcast) {
      const on = !!state?.app?.broadcast;
      bcast.textContent = on ? '停止广播' : '启用广播';
      bcast.classList.toggle('primary', !on);
      bcast.classList.toggle('danger', on);
      el('broadcast-state').textContent = on
        ? `广播中 · ${dockPicked.size} 个目标`
        : '未启用';
    }
    if (!sidePanel) {
      const list = sessions();
      dockPicked = new Set([...dockPicked].filter((id) => list.some((s) => s.id === id)));
      el('dock-list').innerHTML =
        list
          .map(
            (s) => `
            <label class="target-row">
              <input type="checkbox" data-id="${esc(s.id)}" ${dockPicked.has(s.id) ? 'checked' : ''} />
              <span class="dot ${s.state}"></span>
              <span class="who"><b>${esc(tabLabel(s))}</b><span>${esc(s.host)}</span></span>
            </label>`,
          )
          .join('') || '<div class="muted small">没有打开的会话</div>';

      // Always list every mounted image, regardless of the target selection.
      const rows = list
        .filter((s) => (state.media || {})[s.id]?.inserted)
        .map((s) => {
          const m = state.media[s.id];
          const extra = m.size ? ` · ${humanSize(m.size)}${m.speed ? ` · ${humanSize(m.speed)}/s` : ''}` : '';
          return `${s.host}: ${m.name || t('已挂载')}${extra}`;
        });
      el('dock-media-status').innerHTML = rows.join('<br>') || '没有已挂载的镜像';
    }
  }
  renderTopbarActive();
}

function updateLicenseBox() {
  const box = el('c-license');
  if (!box) return;
  box.classList.toggle('hidden', el('c-vendor').value !== 'dell');
}

function resetConnectForm() {
  const firstVendor = el('c-vendor').options[0]?.value || 'generic';
  el('c-vendor').value = firstVendor;
  el('c-host').value = subnetPrefix();
  el('c-port').value = '443';
  el('c-scheme').value = 'https';
  el('c-name').value = '';
  el('c-kvm').value = '';
  el('c-mode').value = 'auto';
  pendingSerial = '';
  el('connect-msg').textContent = '';
  fillVendorInfo(firstVendor);
  fillConnectDefaults();
  updateLicenseBox();
}

async function uploadLicenseFile(file) {
  if (!file) return;
  const host = el('c-host').value.trim();
  const port = Number(el('c-port').value) || 443;
  const username = el('c-username').value.trim();
  if (!host || !username) {
    toast('先在表单里填好 BMC 地址和用户名，再上传许可', 'err');
    return;
  }
  const password = el('c-password').value || (await api.passwordFor(host, port));
  if (!password) {
    toast('请先填写密码，再上传许可', 'err');
    return;
  }
  el('c-license-hint').textContent = '正在导入许可…';
  const res = await api.uploadLicense({
    host,
    port,
    scheme: el('c-scheme').value,
    username,
    password,
    file,
  });
  el('c-license-hint').textContent = res.message || (res.ok ? '许可已导入' : '许可导入失败');
  toast(res.message || (res.ok ? '许可已导入' : '许可导入失败'), res.ok ? 'ok' : 'err', 7000);
}

function autoScanOnce() {
  if (!state) return;
  if (scan?.running) return;
  // Already have results from a previous scan: keep them instead of rescanning.
  if ((scan?.hosts?.length ?? 0) > 0) return;
  if (Date.now() - scanAutoAt < 3000) return;
  const input = el('scan-subnet');
  const subnet = (input?.value || '').trim() || state.app?.subnets?.[0]?.cidr || '';
  if (!subnet) return;
  if (input && !input.value) input.value = subnet;
  scanAutoAt = Date.now();
  void api.scanStart(subnet);
}

function subnetPrefix() {
  const cidr = state?.app?.subnets?.[0]?.cidr || '';
  const m = /^(\d+\.\d+\.\d+)\./.exec(cidr);
  return m ? `${m[1]}.` : '';
}

function openSide(name, prefill) {
  if (!prefill && panelUi.dockOpen && panelUi.side === name) {
    api.setPanel(null);
    return;
  }
  api.setPanel({ side: name, prefill });
}

function defaultTargets() {
  if (state?.mode === 'focus' && state.focusId && sessions().some((s) => s.id === state.focusId)) {
    return [state.focusId];
  }
  return sessions().map((s) => s.id);
}

function openDock(panel) {
  if (panelUi.dockOpen && !panelUi.side && panelUi.panel === panel) {
    api.setPanel(null);
    return;
  }
  let targets = defaultTargets();
  if (panel === 'broadcast') {
    const saved = state?.app?.broadcastTargets || [];
    if (state?.app?.broadcast && saved.length) {
      targets = saved.filter((id) => sessions().some((s) => s.id === id));
      targetsTouched = true;
    } else {
      targetsTouched = false;
    }
  } else {
    targetsTouched = false;
  }
  api.setPanel({ panel, targets });
}

function syncBroadcastTargets() {
  if (state?.app?.broadcast) void api.setBroadcast({ on: true, targets: [...dockPicked] });
}

function closeDock() {
  api.setPanel(null);
}

api.onPanel?.((payload) => {
  panelUi = {
    dockOpen: !!payload?.dockOpen,
    side: payload?.side || null,
    panel: payload?.panel || null,
  };
  dockOpen = panelUi.dockOpen;
  sidePanel = panelUi.side;
  dockPanel = panelUi.panel;
  if (Array.isArray(payload?.targets)) {
    dockPicked = new Set(payload.targets);
    targetsTouched = false;
  }
  renderDock();
  if (sidePanel === 'launcher') {
    launcherQuery = '';
    launcherSel = 0;
    renderLauncher();
    setTimeout(() => el('launcher-input')?.focus(), 30);
    setTimeout(() => {
      window.focus();
      el('launcher-input')?.focus();
    }, 150);
  }
  if (sidePanel === 'connect') {
    if (payload?.prefill) {
      fillConnectForm(payload.prefill);
      connectPrefill = null;
    } else if (!el('c-host').value) {
      el('c-host').value = subnetPrefix();
    }
    renderConnectRecent();
    updateLicenseBox();
    const host = el('c-host').value.trim();
    if (host && !el('c-password').value) {
      api.passwordFor(host, Number(el('c-port').value) || 443).then((pw) => {
        if (pw && !el('c-password').value) el('c-password').value = pw;
      });
    }
    const freshVendor = !el('c-vendor').value;
    fillVendorInfo(el('c-vendor').value);
    if (freshVendor) fillConnectDefaults();
    setTimeout(() => el('c-host')?.focus(), 30);
  }
  if (sidePanel !== 'shortcuts' && shortcutCaptureId) {
    shortcutCaptureId = null;
    void api.shortcutsCapture(false);
  }
  if (sidePanel === 'shortcuts') renderShortcuts();
  if (sidePanel === 'scan') {
    if (!el('scan-subnet').value) {
      el('scan-subnet').value = state?.app?.subnets?.[0]?.cidr || '';
    }
    setTimeout(autoScanOnce, 200);
  }
});

/* ---------------------------------------------------------------- overlay */
function renderConnectRecent() {
  const list = devices()
    .slice()
    .sort((a, b) => (b.lastUsedAt ?? b.createdAt) - (a.lastUsedAt ?? a.createdAt))
    .slice(0, 8);
  el('connect-recent').innerHTML =
    list
      .map(
        (d) => `
        <div class="recent-row" data-id="${esc(d.id)}">
          <span class="dot ${d.open ? 'ready' : 'idle'}"></span>
          <span class="who"><b>${esc(d.model || d.name || d.host)}</b><span>${esc(d.host)}:${esc(String(d.port))} · ${esc(labelOf(d.vendor))}${d.mode === 'vnc' ? ' · VNC' : ''}</span></span>
          <span class="when">${esc(relTime(d.lastUsedAt))}</span>
        </div>`,
      )
      .join('') || '<div class="muted small">还没有历史连接</div>';
}

function renderOverlay() {
  // All panels now live in the right-hand dock; no full-page overlay.
}

/* --------------------------------------------------------------- launcher */
function launcherEntries() {
  const q = launcherQuery.trim().toLowerCase();
  const open = sessions().map((s) => ({ kind: 'session', id: s.id, s }));
  const openIds = new Set(open.map((x) => x.id));
  const hist = devices()
    .filter((d) => !openIds.has(d.id))
    .sort((a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0))
    .map((d) => ({ kind: 'device', id: d.id, d }));
  let all = [...open, ...hist];
  if (q) {
    all = all.filter((x) => {
      const text =
        x.kind === 'session'
          ? `${x.s.name} ${x.s.host} ${x.s.model ?? ''} ${labelOf(x.s.vendor)}`
          : `${x.d.name ?? ''} ${x.d.model ?? ''} ${x.d.host} ${x.d.serial ?? ''} ${labelOf(x.d.vendor)}`;
      return text.toLowerCase().includes(q);
    });
  }
  return all.slice(0, 40);
}

function activateLauncher(entry) {
  if (!entry) return;
  closeDock();
  if (entry.kind === 'session') api.setMode('focus', entry.id);
  else api.openHistory(entry.id);
}

async function removeLauncherEntry(id) {
  if (!id) return;
  const snapshot = await api.removeHistory(id);
  render(snapshot);
  renderLauncher();
  toast('已删除连接', 'ok', 1800);
}

function renderLauncher() {
  const items = launcherEntries();
  if (launcherSel >= items.length) launcherSel = Math.max(0, items.length - 1);
  const box = el('launcher-list');
  box.innerHTML =
    items
      .map((x, i) => {
        if (x.kind === 'session') {
          const s = x.s;
          const index = sessions().findIndex((y) => y.id === s.id);
          return `
          <div class="launcher-item ${i === launcherSel ? 'sel' : ''}" data-kind="session" data-id="${esc(s.id)}">
            <span class="idx">${index + 1}</span>
            <span class="dot ${s.state}"></span>
            <span class="who"><b>${esc(s.name)}</b><span>${esc(s.host)} · ${esc(labelOf(s.vendor))}${s.model ? ' · ' + esc(s.model) : ''}</span></span>
            <span class="st">${esc(STATE_LABEL[s.state] || s.state)}</span>
            <button class="launcher-del" data-id="${esc(s.id)}" title="删除连接">×</button>
          </div>`;
        }
        const d = x.d;
        return `
        <div class="launcher-item history ${i === launcherSel ? 'sel' : ''}" data-kind="device" data-id="${esc(d.id)}">
          <span class="idx">○</span>
          <span class="dot idle"></span>
          <span class="who"><b>${esc(d.name || d.model || d.host)}</b><span>${esc(d.host)}:${esc(String(d.port))} · ${esc(labelOf(d.vendor))}${d.model ? ' · ' + esc(d.model) : ''}</span></span>
          <span class="st">Recent</span>
          <button class="launcher-del" data-id="${esc(d.id)}" title="删除连接">×</button>
        </div>`;
      })
      .join('') || '<div class="sheet-hint">没有匹配的连接</div>';
  requestAnimationFrame(() => box.querySelector('.launcher-item.sel')?.scrollIntoView({ block: 'nearest' }));
}

/* --------------------------------------------------------------- shortcuts */
let shortcutData = null;
let shortcutCaptureId = null;

function accelFromEvent(e) {
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return null;
  const parts = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.shiftKey) parts.push('Shift');
  if (e.altKey) parts.push('Alt');
  if (e.metaKey) parts.push('Meta');
  let key = e.key;
  if (key === ' ') key = 'Space';
  else if (key.length === 1) key = key.toUpperCase();
  else if (key === 'Escape') key = 'Esc';
  else if (key === 'Delete') key = 'Delete';
  parts.push(key);
  return parts.join('+');
}

async function renderShortcuts() {
  if (!shortcutData) shortcutData = await api.shortcutsGet();
  const list = el('shortcut-list');
  if (!list || !shortcutData) return;
  const groups = [];
  for (const def of shortcutData.defs) {
    let g = groups.find((x) => x.name === def.group);
    if (!g) groups.push((g = { name: def.group, items: [] }));
    g.items.push(def);
  }
  list.innerHTML = groups
    .map(
      (g) => `<div class="sc-group">${esc(g.name)}</div>` +
        g.items
          .map((def) => {
            const accel = shortcutData.bindings[def.id] || '';
            return `<div class="sc-row"><span>${esc(def.label)}</span><button class="sc-key ${accel ? '' : 'sc-empty'}" data-sc="${esc(def.id)}">${esc(accel || '未绑定')}</button></div>`;
          })
          .join(''),
    )
    .join('');
}

async function beginShortcutCapture(btn) {
  const id = btn.dataset.sc;
  shortcutCaptureId = id;
  await api.shortcutsCapture(true);
  btn.classList.add('capturing');
  btn.textContent = '按下组合键…';
  const handler = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') {
      document.removeEventListener('keydown', handler, true);
      shortcutCaptureId = null;
      await api.shortcutsCapture(false);
      renderShortcuts();
      return;
    }
    if (e.key === 'Backspace' || e.key === 'Delete') {
      document.removeEventListener('keydown', handler, true);
      shortcutCaptureId = null;
      await api.shortcutsCapture(false);
      const res = await api.shortcutsSet(id, '');
      if (!res.ok) toast(res.message, 'err');
      shortcutData = { ...shortcutData, bindings: res.bindings };
      renderShortcuts();
      return;
    }
    const accel = accelFromEvent(e);
    if (!accel) return;
    document.removeEventListener('keydown', handler, true);
    shortcutCaptureId = null;
    await api.shortcutsCapture(false);
    const res = await api.shortcutsSet(id, accel);
    if (!res.ok) toast(res.message, 'err');
    shortcutData = { ...shortcutData, bindings: res.bindings || shortcutData.bindings };
    renderShortcuts();
  };
  document.addEventListener('keydown', handler, true);
}

function bindShortcutUi() {
  el('shortcut-list')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-sc]');
    if (b) beginShortcutCapture(b);
  });
  el('shortcut-reset')?.addEventListener('click', async () => {
    const res = await api.shortcutsReset();
    if (res?.bindings) shortcutData = { ...shortcutData, bindings: res.bindings };
    renderShortcuts();
  });
}

/* ------------------------------------------------------------------ forms */
function renderVendorOptions() {
  const vendors = state.vendors || [];
  const sig = vendors.map((v) => `${v.id}:${v.label}`).join('|');
  for (const id of ['l-vendor', 'c-vendor']) {
    const sel = el(id);
    if (sel.dataset.sig === sig) continue;
    const current = sel.value;
    sel.dataset.sig = sig;
    sel.innerHTML = vendors.map((v) => `<option value="${esc(v.id)}">${esc(labelOf(v.id))}</option>`).join('');
    sel.value = current || 'huawei';
  }
}

function fillVendorInfo(vendorId) {
  const vendor = (state.vendors || []).find((v) => v.id === vendorId);
  el('c-hint').textContent = vendor ? vendor.hint : '';
}

function connectPayloadFromSheet(ephemeral) {
  return {
    host: el('c-host').value.trim(),
    port: Number(el('c-port').value) || 443,
    scheme: el('c-scheme').value,
    vendor: el('c-vendor').value,
    username: el('c-username').value.trim(),
    password: el('c-password').value,
    name: el('c-name').value.trim(),
    kvmUrl: el('c-kvm').value.trim(),
    mode: el('c-mode').value === 'auto' ? undefined : el('c-mode').value,
    serial: pendingSerial || undefined,
    ephemeral,
  };
}

async function submitConnect(ephemeral) {
  const payload = connectPayloadFromSheet(ephemeral);
  if (!payload.host) {
    el('connect-msg').className = 'form-msg err';
    el('connect-msg').textContent = 'BMC 地址不能为空';
    return;
  }
  el('connect-msg').className = 'form-msg';
  el('connect-msg').textContent = '正在连接…';
  const res = await api.connect(payload);
  if (!res.ok) {
    el('connect-msg').className = 'form-msg err';
    el('connect-msg').textContent = res.message || '连接失败';
    return;
  }
  el('connect-msg').textContent = '';
  el('c-password').value = '';
  pendingSerial = '';
  toast(ephemeral ? '已连接（不记历史）' : '已连接', 'ok');
  void api.setPanel(null);
}

async function landingConnect(ephemeral) {
  const host = el('l-host').value.trim();
  if (!host) {
    el('landing-msg').className = 'form-msg err';
    el('landing-msg').textContent = '请输入 BMC 地址';
    el('l-host').focus();
    return;
  }
  const payload = {
    host,
    port: 443,
    scheme: 'https',
    vendor: el('l-vendor').value,
    username: el('l-username').value.trim(),
    password: el('l-password').value,
    mode: el('l-mode').value === 'auto' ? undefined : el('l-mode').value,
    name: '',
    ephemeral,
  };
  el('landing-msg').className = 'form-msg';
  el('landing-msg').textContent = '正在连接…';
  const res = await api.connect(payload);
  if (!res.ok) {
    el('landing-msg').className = 'form-msg err';
    el('landing-msg').textContent = res.message || '连接失败';
    return;
  }
  el('landing-msg').textContent = '';
  el('l-password').value = '';
}

/* ------------------------------------------------------------------ bind */
function bindTopbar() {
  el('download-chip').addEventListener('click', () => openDock('downloads'));
  el('download-folder').addEventListener('click', (e) => {
    e.stopPropagation();
    void api.openDownloadsFolder();
  });
  el('download-clear').addEventListener('click', (e) => {
    e.stopPropagation();
    for (const [key, d] of downloads) {
      if (d.state === 'started' || d.state === 'progress') continue;
      downloads.delete(key);
    }
    renderDownloads();
  });
  el('download-list').addEventListener('click', (e) => {
    const open = e.target.closest('[data-download-open]');
    if (!open) return;
    const row = open.closest('.download-row');
    if (row?.dataset.path) void api.openDownload(row.dataset.path);
  });
  el('btn-connect').addEventListener('click', () => openSide('connect'));
  el('btn-scan').addEventListener('click', () => openSide('scan'));
  el('btn-terminal').addEventListener('click', () => {
    openDock('terminal');
    setTimeout(() => el('term-command')?.focus(), 120);
  });
  el('btn-media').addEventListener('click', () => openDock('media'));
  el('btn-input').addEventListener('click', () => openDock('input'));
  el('btn-power').addEventListener('click', () => openDock('power'));
  el('btn-launcher').addEventListener('click', () => openSide('launcher'));
  el('btn-settings').addEventListener('click', () => openSide('shortcuts'));
  if (!PANEL_MODE) {
    document.addEventListener('pointerdown', (e) => {
      if (!panelUi.dockOpen) return;
      if (e.target.closest('#topbar')) return;
      if (e.target.closest('#tool-dock') || e.target.closest('#panel')) return;
      api.setPanel(null);
    }, true);
  }
  el('tiles').addEventListener('pointerdown', (e) => {
    if (!PANEL_MODE && panelUi.dockOpen && !e.target.closest('#tool-dock')) api.setPanel(null);
  });
  el('grid').addEventListener('pointerdown', (e) => {
    if (!PANEL_MODE && panelUi.dockOpen && !e.target.closest('#tool-dock')) api.setPanel(null);
  });
  el('btn-broadcast').addEventListener('click', () => openDock('broadcast'));
  el('btn-broadcast-toggle').addEventListener('click', () => {
    if (state?.app?.broadcast) {
      void api.setBroadcast({ on: false });
      return;
    }
    if (!dockPicked.size) {
      toast('先勾选至少一个目标', 'err');
      return;
    }
    void api.setBroadcast({ on: true, targets: [...dockPicked] });
  });
  const langSel = el('set-lang');
  if (langSel) {
    langSel.value = localStorage.getItem('kvm-lang') || 'auto';
    langSel.addEventListener('change', () => {
      localStorage.setItem('kvm-lang', langSel.value);
      api.reloadUi();
    });
  }
  const themeSel = el('set-theme');
  if (themeSel) {
    themeSel.value = themeMode;
    themeSel.addEventListener('change', () => {
      themeMode = themeSel.value;
      localStorage.setItem(THEME_KEY, themeMode);
      applyTheme();
    });
  }
  el('btn-reconnect-all').addEventListener('click', () => openDock('reconnect'));
  el('btn-empty-connect').addEventListener('click', () => openSide('connect'));
  el('btn-landing-scan').addEventListener('click', () => openSide('scan'));

  el('layout-seg').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    if (state?.mode === 'focus') api.setMode('grid');
    api.setLayout(Number(btn.dataset.cols), Number(btn.dataset.rows));
    localStorage.setItem('layout', JSON.stringify({ cols: btn.dataset.cols, rows: btn.dataset.rows }));
  });

  el('strip').addEventListener('click', (e) => {
    const webBtn = e.target.closest('[data-web]');
    if (webBtn) {
      e.stopPropagation();
      const id = webBtn.dataset.web;
      const focused = state.mode === 'focus' && state.focusId === id;
      const call = state.mode === 'focus' && !focused ? api.showWeb(id) : api.toggleWeb(id);
      call.then((open) => {
        webBtn.classList.toggle('on', Boolean(open));
      });
      return;
    }
    const close = e.target.closest('[data-close]');
    if (close) {
      e.stopPropagation();
      api.closeSession(close.dataset.close);
      return;
    }
    const chip = e.target.closest('.chip');
    if (chip) {
      if (suppressChipClick) return;
      // Selecting text inside a tab must not count as a click.
      const sel = window.getSelection();
      if (
        sel &&
        !sel.isCollapsed &&
        sel.toString().trim() &&
        (chip.contains(sel.anchorNode) || chip.contains(sel.focusNode))
      ) {
        return;
      }
      const id = chip.dataset.id;
      const target = sessions().find((s) => s.id === id);
      const focused = state.mode === 'focus' && state.focusId === id;
      if (focused && !target?.webOpen) api.setMode('grid', id);
      else api.focusKvm(id);
    }
  });

  let dragState = null;
  let suppressChipClick = false;
  el('strip').addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('.x') || e.target.closest('.web')) return;
    const chip = e.target.closest('.chip');
    if (!chip) return;
    dragState = { id: chip.dataset.id, chip, x: e.clientX, y: e.clientY, dragging: false };
  });
  document.addEventListener('pointermove', (e) => {
    if (!dragState) return;
    if (!dragState.dragging) {
      if (Math.hypot(e.clientX - dragState.x, e.clientY - dragState.y) < 5) return;
      dragState.dragging = true;
      suppressChipClick = true;
      window.getSelection()?.removeAllRanges();
      document.body.classList.add('dragging-tab');
      dragState.chip.classList.add('dragging');
      tabsDragging = true;
    }
    const under = document.elementFromPoint(e.clientX, e.clientY);
    const target = under?.closest?.('.chip');
    if (target && target !== dragState.chip) {
      const r = target.getBoundingClientRect();
      const before = e.clientX < r.left + r.width / 2;
      const ref = before ? target : target.nextSibling;
      if (ref !== dragState.chip) el('strip').insertBefore(dragState.chip, ref);
    }
  });
  document.addEventListener('pointerup', async () => {
    if (!dragState) return;
    const current = dragState;
    dragState = null;
    document.body.classList.remove('dragging-tab');
    current.chip.classList.remove('dragging');
    tabsDragging = false;
    if (!current.dragging) return;
    const ids = [...el('strip').querySelectorAll('.chip')].map((c) => c.dataset.id);
    const ok = await api.reorder(ids);
    toast(ok ? '标签顺序已保存' : '调整顺序失败', ok ? 'ok' : 'err', 1500);
    setTimeout(() => {
      suppressChipClick = false;
    }, 50);
  });

  el('tiles').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    if (btn.dataset.act === 'reconnect') api.reconnect(btn.dataset.id);
    if (btn.dataset.act === 'focus') api.setMode('focus', btn.dataset.id);
    if (btn.dataset.act === 'license') void uploadLicense(btn.dataset.id);
    if (btn.dataset.act === 'web') {
      e.stopPropagation();
      api.toggleWeb(btn.dataset.id);
    }
    if (btn.dataset.act === 'console') api.focusConsole(btn.dataset.id);
  });

  el('landing-recent').addEventListener('click', (e) => {
    const row = e.target.closest('.recent-row');
    if (row) api.openHistory(row.dataset.id);
  });

  el('btn-landing-connect').addEventListener('click', () => landingConnect(false));
  el('btn-landing-only').addEventListener('click', () => landingConnect(true));
  el('l-vendor').addEventListener('change', fillLandingDefaults);
  el('l-save-preset').addEventListener('click', () => savePreset('l'));
  el('c-save-preset').addEventListener('click', () => savePreset('c'));
  bindPresetBox('l-presets', 'l');
  bindPresetBox('c-presets', 'c');
  el('l-host').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') landingConnect(false);
  });
  el('l-password').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') landingConnect(false);
  });
}

const DOWNLOAD_STORE = 'kvm-downloads-v1';
const downloads = new Map();
try {
  const saved = JSON.parse(localStorage.getItem(DOWNLOAD_STORE) || '[]');
  for (const d of Array.isArray(saved) ? saved : []) if (d?.key) downloads.set(d.key, d);
} catch { /* ignore */ }

function saveDownloads() {
  try {
    localStorage.setItem(DOWNLOAD_STORE, JSON.stringify([...downloads.values()].slice(-80)));
  } catch { /* ignore */ }
}

function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v >= 1024 * 1024 * 1024) return `${(v / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (v >= 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`;
  if (v >= 1024) return `${(v / 1024).toFixed(0)} KB`;
  return `${v} B`;
}

function renderDownloads() {
  const chip = el('download-chip');
  const list = el('download-list');
  if (!chip || !list) return;
  const rows = [...downloads.values()].sort((a, b) => (b.updated || 0) - (a.updated || 0));
  const active = rows.filter((d) => d.state === 'started' || d.state === 'progress');
  let pct = 0;
  if (active.length) {
    const cur = active[0];
    pct = cur.total > 0 ? Math.min(100, Math.round((cur.received / cur.total) * 100)) : 0;
    chip.style.setProperty('--p', String(pct));
    chip.classList.add('downloading');
    chip.title = `${cur.name} · ${pct}%`;
  } else {
    chip.style.setProperty('--p', '0');
    chip.classList.remove('downloading');
    chip.title = '下载管理';
  }
  chip.classList.toggle('done', !active.length && rows.some((d) => d.state === 'done'));
  chip.classList.toggle('failed', !active.length && rows.some((d) => d.state === 'error'));
  chip.classList.remove('hidden');

  saveDownloads();
  if (!rows.length) {
    list.innerHTML = '<div class="muted small">还没有下载</div>';
    return;
  }
  list.innerHTML = rows
    .map((d) => {
      const p = d.total > 0 ? Math.min(100, Math.round((d.received / d.total) * 100)) : 0;
      const status = d.state === 'done'
        ? esc(t('完成'))
        : d.state === 'error'
          ? esc(d.error ? t('失败：{error}', { error: d.error }) : t('失败'))
          : `${p}%`;
      return `
        <div class="download-row" data-path="${esc(d.path || '')}">
          <div class="download-main">
            <div class="download-name" title="${esc(d.path || d.name)}">${esc(d.name)}</div>
            <div class="download-meta">${status}${d.total ? ` · ${fmtBytes(d.received)} / ${fmtBytes(d.total)}` : ''}</div>
            ${d.state === 'started' || d.state === 'progress' ? `<div class="download-bar-mini"><i style="width:${p}%"></i></div>` : ''}
          </div>
          ${d.path ? '<button class="btn tiny ghost" data-download-open>打开</button>' : ''}
        </div>`;
    })
    .join('');
}

function renderDownload(ev) {
  const chip = el('download-chip');
  if (!chip || !ev) return;
  const key = ev.path || `${ev.id || ''}:${ev.name || ''}`;
  downloads.set(key, { ...ev, key, updated: Date.now() });
  renderDownloads();
}

function syncLayoutSeg() {
  const layout = state.layout || { cols: 3, rows: 3 };
  for (const btn of el('layout-seg').querySelectorAll('button')) {
    btn.classList.toggle('on', Number(btn.dataset.cols) === layout.cols && Number(btn.dataset.rows) === layout.rows);
  }
}

const PRESET_KEY = 'kvm-text-presets';
const DEFAULT_PRESETS = ['Admin@9000'];

function textPresets() {
  try {
    const raw = JSON.parse(localStorage.getItem(PRESET_KEY) || 'null');
    if (Array.isArray(raw)) return raw.filter((x) => typeof x === 'string' && x.trim());
  } catch {
    /* ignore */
  }
  return [...DEFAULT_PRESETS];
}

function saveTextPresets(list) {
  localStorage.setItem(PRESET_KEY, JSON.stringify([...new Set(list.map((x) => x.trim()).filter(Boolean))]));
  renderTextPresets();
}

async function sendDockText(text) {
  const ids = dockIds();
  if (!ids.length) return toast('先勾选至少一台服务器', 'err');
  if (!text) return toast('先输入或粘贴要发送的文本', 'err');
  let ok = 0;
  for (const id of ids) {
    if (await api.typeText(id, text)) ok += 1;
    await new Promise((r) => setTimeout(r, 120));
  }
  toast(`已发送到 ${ok}/${ids.length} 台`, ok === ids.length ? 'ok' : 'err');
}

function renderTextPresets() {
  const box = el('preset-list');
  if (!box) return;
  const list = textPresets();
  box.innerHTML = list
    .map(
      (p, i) => `<span class="preset-chip" title="点击填入">
        <button class="preset-use" data-i="${i}">${esc(p)}</button>
        <button class="preset-del" data-i="${i}" title="删除">×</button>
      </span>`,
    )
    .join('') || '<span class="muted small">还没有预设</span>';
}

function bindSheets() {
  /* connect */
  el('connect-form').addEventListener('submit', (e) => {
    e.preventDefault();
    submitConnect(false);
  });
  el('btn-connect-only').addEventListener('click', () => submitConnect(true));
  el('connect-recent').addEventListener('click', (e) => {
    const row = e.target.closest('.recent-row');
    if (!row) return;
    const d = devices().find((x) => x.id === row.dataset.id);
    if (!d) return;
    fillConnectForm({
      host: d.host,
      port: d.port,
      scheme: d.scheme,
      vendor: d.vendor,
      username: d.username,
      password: '',
      name: d.model || d.name || '',
      serial: d.serial || '',
      mode: d.mode || 'auto',
    });
    api.passwordFor(d.host, d.port).then((pw) => {
      if (pw) el('c-password').value = pw;
    });
    setTimeout(() => el('c-password').focus(), 30);
  });
  el('c-vendor').addEventListener('change', () => {
    fillVendorInfo(el('c-vendor').value);
    fillConnectDefaults();
    updateLicenseBox();
  });
  el('c-reset').addEventListener('click', resetConnectForm);
  el('c-license').addEventListener('click', (e) => {
    if (e.target.id !== 'c-license-file') el('c-license-file').click();
  });
  el('c-license-file').addEventListener('change', () => {
    const file = el('c-license-file').files?.[0];
    if (file) void uploadLicenseFile(api.pathForFile(file) || file.path);
  });
  for (const type of ['dragenter', 'dragover']) {
    el('c-license').addEventListener(type, (e) => {
      e.preventDefault();
      el('c-license').classList.add('over');
    });
  }
  el('c-license').addEventListener('dragleave', () => el('c-license').classList.remove('over'));
  el('c-license').addEventListener('drop', (e) => {
    e.preventDefault();
    el('c-license').classList.remove('over');
    const file = e.dataTransfer?.files?.[0];
    if (file) void uploadLicenseFile(api.pathForFile(file) || file.path);
  });
  /* history */
  el('history-list')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    const row = e.target.closest('.history-row');
    if (!row) return;
    const id = row.dataset.id;
    if (btn?.dataset.act === 'del') {
      if (!confirm(t('从历史中删除这条记录？（不影响 BMC 本身）'))) return;
      render(await api.removeHistory(id));
      return;
    }
    const target = devices().find((d) => d.id === id);
    if (target?.open) api.setMode('focus', id);
    else void api.openHistory(id);
    api.setPanel(null);
  });

  /* scan */
  el('scan-subnet').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!scan?.running) el('btn-scan-start').click();
    }
  });
  el('btn-scan-start').addEventListener('click', async () => {
    pickedIps.clear();
    const res = await api.scanStart(el('scan-subnet').value.trim());
    if (!res.ok) toast(res.message, 'err');
  });
  el('scan-select-all').addEventListener('change', () => {
    const all = (scan?.hosts || []).map((h) => h.ip);
    if (el('scan-select-all').checked) all.forEach((ip) => pickedIps.add(ip));
    else all.forEach((ip) => pickedIps.delete(ip));
    renderScan();
  });
  el('btn-scan-connect').addEventListener('click', () => void connectSelected());
  el('scan-results').addEventListener('change', (e) => {
    const cb = e.target.closest('.pick');
    if (!cb) return;
    if (cb.checked) pickedIps.add(cb.dataset.ip);
    else pickedIps.delete(cb.dataset.ip);
    renderScan();
  });
  el('btn-scan-cancel').addEventListener('click', () => api.scanCancel());
  el('scan-results').addEventListener('click', async (e) => {
    if (e.target.closest('input[type=checkbox]')) return;
    const btn = e.target.closest('button[data-act="scan-connect"], button[data-act="scan-connect-vnc"]');
    if (!btn) {
      const row = e.target.closest('.scan-row');
      if (row) {
        const ip = row.dataset.ip;
        if (pickedIps.has(ip)) pickedIps.delete(ip);
        else pickedIps.add(ip);
        renderScan();
      }
      return;
    }
    const ip = btn.dataset.ip;
    const vnc = btn.dataset.act === 'scan-connect-vnc';
    const host = (scan?.hosts || []).find((h) => h.ip === ip);
    if (!host) return;
    if (!host.credential) {
      openConnectFor(host, vnc ? 'vnc' : 'web');
      toast('该设备默认凭据不可用，请补充用户名/密码', 'err', 6000);
      return;
    }
    const saved = savedDeviceFor(host.ip, host.port);
    if (saved && !vnc) {
      await api.openHistory(saved.id);
      api.setPanel(null);
      return;
    }
    const vendor = host.vendor || 'generic';
    const preset = (state.vendors || []).find((v) => v.id === vendor)?.defaults?.[0];
    const savedPass = saved ? await api.passwordFor(saved.host, saved.port) : '';
    const payload = {
      host: host.ip,
      port: host.port ?? 443,
      scheme: host.scheme ?? 'https',
      vendor,
      username: host.credential?.username ?? saved?.username ?? preset?.u ?? '',
      password: host.credential?.password ?? savedPass ?? preset?.p ?? '',
      name: host.model || saved?.model || '',
      serial: host.serial || saved?.serial || undefined,
      mode: vnc ? 'vnc' : 'web',
      ephemeral: false,
    };
    btn.disabled = true;
    const res = await api.connect(payload);
    btn.disabled = false;
    if (!res.ok) toast(res.message || '连接失败', 'err');
    else void api.setPanel(null);
  });

  /* tool dock */
  el('tool-dock').addEventListener('click', (e) => {
    const tab = e.target.closest('.dock-tab');
    if (tab) {
      dockPanel = tab.dataset.panel;
      renderDock();
    }
  });
  el('dock-list').addEventListener('change', (e) => {
    const cb = e.target.closest('input[type=checkbox]');
    if (!cb) return;
    targetsTouched = true;
    if (cb.checked) dockPicked.add(cb.dataset.id);
    else dockPicked.delete(cb.dataset.id);
    syncBroadcastTargets();
  });
  el('dock-all').addEventListener('click', () => {
    targetsTouched = true;
    dockPicked = new Set(sessions().map((s) => s.id));
    renderDock();
    syncBroadcastTargets();
  });
  el('dock-none').addEventListener('click', () => {
    targetsTouched = true;
    dockPicked.clear();
    renderDock();
    syncBroadcastTargets();
  });
  el('dock-reset').addEventListener('click', () => {
    targetsTouched = false;
    dockPicked = new Set(defaultTargets());
    renderDock();
    syncBroadcastTargets();
  });
  renderTextPresets();
  el('preset-add').addEventListener('click', () => {
    const input = el('preset-input');
    const value = input.value.trim();
    if (!value) return;
    saveTextPresets([...textPresets(), value]);
    input.value = '';
  });
  el('preset-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      el('preset-add').click();
    }
  });
  el('preset-list').addEventListener('click', (e) => {
    const use = e.target.closest('.preset-use');
    if (use) {
      void sendDockText(textPresets()[Number(use.dataset.i)] || '');
      return;
    }
    const del = e.target.closest('.preset-del');
    if (del) {
      const list = textPresets();
      list.splice(Number(del.dataset.i), 1);
      saveTextPresets(list);
    }
  });
  async function runTerminal() {
    const ids = dockIds();
    if (!ids.length) return toast('先勾选至少一台服务器', 'err');
    const command = el('term-command').value.trim();
    if (!command) return toast('请输入命令', 'err');
    const tool = el('term-tool').value;
    const out = el('term-output');
    const run = el('term-run');
    run.disabled = true;
    out.textContent += `\n\n$ ${tool} ${command}\n`;
    let ok = 0;
    for (const id of ids) {
      const session = sessions().find((s) => s.id === id);
      out.textContent += `\n[${session?.host || id}]\n`;
      const res = await api.runTool(id, tool, command);
      out.textContent += (res?.output || res?.error || t('(无输出)')) + '\n';
      if (res?.ok) ok += 1;
      out.scrollTop = out.scrollHeight;
    }
    run.disabled = false;
    out.scrollTop = out.scrollHeight;
    toast(`执行完成：${ok}/${ids.length} 台成功`, ok === ids.length ? 'ok' : 'err');
  }
  el('term-run').addEventListener('click', () => void runTerminal());
  el('term-command').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void runTerminal();
    }
  });
  el('term-clear').addEventListener('click', () => {
    el('term-output').textContent = termPrompt();
  });

  el('dock-send').addEventListener('click', () => void sendDockText(el('dock-text').value));
  el('dock-keys').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-combo]');
    if (!btn) return;
    const ids = dockIds();
    if (!ids.length) return toast('先勾选至少一台服务器', 'err');
    const keys = btn.dataset.combo.split(',');
    let ok = 0;
    for (const id of ids) {
      if (await api.combo(id, keys)) ok += 1;
      await new Promise((r) => setTimeout(r, 80));
    }
    toast(`已发送 ${btn.textContent.trim()} 到 ${ok}/${ids.length} 台`, ok === ids.length ? 'ok' : 'err');
  });
  el('dock-pick').addEventListener('click', async () => {
    await pickIso();
    renderDock();
  });
  el('dock-mount').addEventListener('click', async () => {
    const ids = dockIds();
    if (!ids.length) return toast('先勾选至少一台服务器', 'err');
    if (!mediaFile) {
      const picked = await pickIso();
      if (!picked) return;
    }
    let ok = 0;
    let firstError = '';
    for (const id of ids) {
      const res = await api.mount(id, mediaFile, el('dock-boot').checked);
      if (res.ok) ok += 1;
      else if (!firstError) firstError = res.message;
      await new Promise((r) => setTimeout(r, 120));
    }
    toast(`已挂载 ${ok}/${ids.length} 台${firstError ? `：${firstError}` : ''}`, ok === ids.length ? 'ok' : 'err', 6000);
    render(await api.refreshMedia());
  });
  el('dock-eject').addEventListener('click', async () => {
    const ids = dockIds();
    if (!ids.length) return toast('先勾选至少一台服务器', 'err');
    let ok = 0;
    for (const id of ids) {
      const res = await api.eject(id);
      if (res.ok) ok += 1;
      await new Promise((r) => setTimeout(r, 80));
    }
    toast(`已卸载 ${ok}/${ids.length} 台`, ok === ids.length ? 'ok' : 'err');
    render(await api.refreshMedia());
  });
  let pendingConfirm = null;
  function showActionConfirm(label, enLabel, ids, run) {
    pendingConfirm = { run };
    const en = (window.__i18n?.active?.() || 'zh') === 'en';
    el('confirm-title').textContent = en ? 'Confirm Action' : '确认操作';
    el('power-confirm-text').innerHTML = en
      ? `<b class="hl">${esc(enLabel)}</b> <b class="hl">${ids.length}</b> servers? This cannot be undone.`
      : `本次将批量 <b class="hl">${esc(label)}</b> <b class="hl">${ids.length}</b> 台服务器，你确定要发送${esc(label)}指令吗？`;
    el('power-targets').innerHTML = ids
      .map((id) => {
        const s = sessionOf(id);
        return `<div class="confirm-target"><b>${esc(s?.name || id)}</b><span>${esc(s?.host || '')} · SN:${esc(s?.serial || '---')}</span></div>`;
      })
      .join('');
    el('power-confirm').classList.remove('hidden');
  }
  el('btn-reconnect-ids').addEventListener('click', () => {
    const ids = dockIds();
    if (!ids.length) return toast('先勾选至少一台服务器', 'err');
    showActionConfirm('重连', 'Reconnect', ids, async () => {
      let ok = 0;
      for (const id of ids) {
          if (await api.reconnect(id)) ok += 1;
        await new Promise((r) => setTimeout(r, 120));
      }
      toast(`已重连 ${ok}/${ids.length} 台`, ok === ids.length ? 'ok' : 'err');
      api.setPanel(null);
    });
  });
  el('btn-reset-connection').addEventListener('click', async () => {
    const ids = dockIds();
    if (!ids.length) return toast('先勾选至少一台服务器', 'err');
    if (!confirm(t('将清除 {n} 台服务器在本机保存的凭据、Cookie 和连接缓存，确定继续？', { n: ids.length }))) return;
    let ok = 0;
    for (const id of ids) {
      if (await api.resetConnection(id)) ok += 1;
    }
    toast(`已重置 ${ok}/${ids.length} 台`, ok === ids.length ? 'ok' : 'err');
    api.setPanel(null);
  });

  el('dock-power').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-power]');
    if (!btn) return;
    const ids = dockIds();
    if (!ids.length) return toast('先勾选至少一台服务器', 'err');
    const action = btn.dataset.power;
    const label = btn.textContent.trim();
    const enLabel = { on: 'Power On', shutdown: 'Soft Shutdown', off: 'Force Off', graceful: 'Soft Restart', reset: 'Force Restart', nmi: 'NMI' }[action] || label;
    showActionConfirm(label, enLabel, ids, async () => {
      let ok = 0;
      let firstError = '';
      for (const id of ids) {
          const res = await api.power(id, action);
        if (res.ok) ok += 1;
        else if (!firstError) firstError = res.message;
        await new Promise((r) => setTimeout(r, 120));
      }
      toast(`已发送 ${label} 到 ${ok}/${ids.length} 台${firstError ? `：${firstError}` : ''}`, ok === ids.length ? 'ok' : 'err', 5000);
    });
  });
  el('power-cancel').addEventListener('click', () => {
    pendingConfirm = null;
    el('power-confirm').classList.add('hidden');
  });
  el('power-ok').addEventListener('click', async () => {
    if (!pendingConfirm) return;
    const run = pendingConfirm.run;
    pendingConfirm = null;
    el('power-confirm').classList.add('hidden');
    await run();
  });

  /* launcher */
  const input = el('launcher-input');
  input.addEventListener('input', () => {
    launcherQuery = input.value;
    launcherSel = 0;
    renderLauncher();
  });
  document.addEventListener('keydown', (e) => {
    if (!panelUi.dockOpen || sidePanel !== 'launcher') return;
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (!['ArrowDown', 'ArrowUp', 'Enter', 'Delete'].includes(e.key)) return;
    const items = launcherEntries();
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      launcherSel = Math.min(items.length - 1, launcherSel + 1);
      renderLauncher();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      launcherSel = Math.max(0, launcherSel - 1);
      renderLauncher();
    } else if (e.key === 'Delete') {
      e.preventDefault();
      const entry = items[launcherSel];
      if (entry) void removeLauncherEntry(entry.id);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      activateLauncher(items[launcherSel]);
    } else if (e.key === 'Escape') {
      closeDock();
    }
  });
  el('launcher-list').addEventListener('click', async (e) => {
    const del = e.target.closest('.launcher-del');
    if (del) {
      e.stopPropagation();
      await removeLauncherEntry(del.dataset.id);
      return;
    }
    const item = e.target.closest('.launcher-item');
    if (!item) return;
    activateLauncher({ kind: item.dataset.kind, id: item.dataset.id });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (dockOpen) {
      e.preventDefault();
      closeDock();
    }
  });
  bindShortcutUi();
api.onShortcut?.((name) => {
    if (name === 'history') openSide('launcher');
    if (name === 'launcher') openSide('launcher');
    if (name === 'connect') openSide('connect');
    if (name === 'media') openDock('media');
    if (name === 'terminal') openDock('terminal');
    if (name === 'scan') openSide('scan');
    if (name === 'input') openDock('input');
    if (name === 'power') openDock('power');
    if (name === 'reconnect') openDock('reconnect');
    if (name === 'broadcast') openDock('broadcast');
    if (name === 'settings') openSide('shortcuts');
    if (name === 'theme') cycleTheme();
  });
}

function bindPresetBox(id, prefix) {
  const box = el(id);
  if (!box) return;
  box.addEventListener('click', (e) => {
    const del = e.target.closest('[data-del]');
    if (del) {
      const slots = credSlots();
      slots[Number(del.dataset.del)] = null;
      writeCredSlots(slots);
      renderPresets();
      return;
    }
    const chip = e.target.closest('.preset-chip');
    if (!chip) return;
    if (chip.classList.contains('preset-empty')) {
      storeCredSlot(prefix, Number(chip.dataset.slot));
      return;
    }
    el(`${prefix}-username`).value = chip.dataset.u;
    el(`${prefix}-password`).value = chip.dataset.p;
  });
}

async function uploadLicense(deviceId) {
  const file = await api.pickLicense();
  if (!file) return;
  const res = await api.installLicense(deviceId, file);
  if (res.ok) {
    toast(res.message, 'ok', 6000);
    return;
  }
  toast(res.message, 'err', 0, {
    label: '重试上传',
    run: () => void uploadLicense(deviceId),
  });
}

async function connectSelected() {
  const picked = (scan?.hosts || []).filter((h) => pickedIps.has(h.ip));
  if (!picked.length) return;
  const hosts = picked.filter((h) => h.credential || savedDeviceFor(h.ip, h.port));
  const missing = picked.filter((h) => !h.credential && !savedDeviceFor(h.ip, h.port));
  const btn = el('btn-scan-connect');
  btn.disabled = true;
  let ok = 0;
  for (const h of hosts) {
    const saved = savedDeviceFor(h.ip, h.port);
    const vendor = h.vendor || saved?.vendor || 'generic';
    const preset = (state.vendors || []).find((v) => v.id === vendor)?.defaults?.[0];
    const savedPass = saved ? await api.passwordFor(saved.host, saved.port) : '';
    const res = await api.connect({
      host: h.ip,
      port: h.port ?? 443,
      scheme: h.scheme ?? 'https',
      vendor,
      username: h.credential?.username ?? saved?.username ?? preset?.u ?? '',
      password: h.credential?.password ?? savedPass ?? preset?.p ?? '',
      name: h.model || saved?.model || '',
      serial: h.serial || saved?.serial || undefined,
      ephemeral: false,
    });
    if (res.ok) ok++;
  }
  btn.disabled = false;
  pickedIps.clear();
  if (hosts.length) toast(`已连接 ${ok}/${hosts.length} 台`, ok === hosts.length ? 'ok' : 'err');
  if (!missing.length) api.setPanel(null);
  if (missing.length) {
    const first = missing[0];
    openConnectFor(first);
    toast(`还有 ${missing.length} 台默认凭据不可用，请补充密码`, 'err', 7000);
    return;
  }
  api.setMode('grid');
}

async function pickIso() {
  const file = await api.pickIso();
  if (!file) return null;
  mediaFile = file;
  const name = file.split('/').pop();
  const label = el('dock-file');
  if (label) {
    label.textContent = name;
    label.title = file;
  }
  return file;
}

/* ------------------------------------------------------------------ toast */
function toast(message, kind = '', ms = 4200, action = null) {
  const node = el('toast');
  node.className = `toast ${kind}`;
  node.innerHTML = '';

  const text = document.createElement('span');
  text.className = 'toast-text';
  text.textContent = message;
  node.appendChild(text);

  if (action) {
    const btn = document.createElement('button');
    btn.className = 'toast-action';
    btn.textContent = action.label;
    btn.addEventListener('click', () => action.run());
    node.appendChild(btn);

    const close = document.createElement('button');
    close.className = 'toast-close';
    close.textContent = '×';
    close.title = '关闭';
    close.addEventListener('click', () => node.classList.add('hidden'));
    node.appendChild(close);
  }

  node.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = ms > 0 ? setTimeout(() => node.classList.add('hidden'), ms) : null;
}

init().catch((err) => {
  document.body.innerHTML = `<pre style="color:#f88;padding:20px">${esc(err && err.stack ? err.stack : err)}</pre>`;
});
