import {
  app,
  BaseWindow,
  WebContentsView,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  globalShortcut,
  session as electronSession,
  type WebContents,
} from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  AppSnapshot,
  Device,
  DeviceInput,
  Rect,
  ScanState,
  UiMode,
  VendorId,
} from './types';
import { Store, VENDORS } from './store';
import { SessionManager } from './manager';
import { MediaService } from './media-service';
import {
  SHORTCUT_DEFS,
  defaultBindings,
  matchShortcut,
  type ShortcutDef,
} from './shortcuts';
import { clampRect, gridRects } from './layout';
import { startMockBmc, type MockBmc } from './mock';
import { hostCount, localSubnets, scanSubnet } from './scanner';
import { ensureDellLicense, installLicenseFile } from './dell-license';
import { VncBridge } from './vnc';
import { RedfishClient } from './redfish';
import type { KvmSession } from './session';

const ARGS = process.argv.slice(1);

if (process.platform === 'linux') {
  // Dev builds are started from a plain unzipped electron; the SUID sandbox
  // helper is not root-owned, so Chromium refuses to start without this.
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
}
// GPU-accelerated canvas aborts on some Wayland drivers (SIGTRAP/exit 133).
// Software rendering is the default; use `--gpu` to opt back in.
const forceSoft = !ARGS.includes('--gpu');
if (forceSoft) app.disableHardwareAcceleration();
// Keep Chromium's fatal log so a renderer CHECK can be diagnosed.
try {
  app.commandLine.appendSwitch('enable-logging', 'file');
  app.commandLine.appendSwitch('log-file', path.join(app.getPath('userData'), 'chromium.log'));
} catch {
  /* ignore */
}
// Chromium's GPU-accelerated 2D canvas can abort (SIGTRAP / exit 133) on some
// drivers while noVNC paints the framebuffer; keep canvas on the CPU.
app.commandLine.appendSwitch('disable-accelerated-2d-canvas');
app.commandLine.appendSwitch('disable-gpu-rasterization');

const DEMO = ARGS.includes('--demo');
const SMOKE = ARGS.includes('--smoke');
const CAPTURE = ARGS.includes('--capture');
const ARTIFACTS = path.join(process.cwd(), 'artifacts');
// In the grid we only surface live consoles; manual/error tiles show their
// status face with buttons so the actions stay clickable.
const GRID_VISIBLE = new Set(['login', 'kvm', 'ready']);
const FOCUS_VISIBLE = new Set(['login', 'kvm', 'ready', 'manual']);

let win: BaseWindow;
let shellView: WebContentsView;
let store: Store;
let manager: SessionManager;
let media: MediaService;
const localMedia = new Map<string, string>();
let panelView: WebContentsView | null = null;
let panelState: { side?: string; panel?: string; targets?: string[]; prefill?: any } | null = null;
let panelVisible = false;
let vncBridge: VncBridge;
let mock: MockBmc | undefined;

let mode: UiMode = 'grid';
let focusId: string | null = null;
let layoutSpec = { cols: 2, rows: 2 };
let gridSel = 0;
let broadcastOn = false;
let broadcastTargets = new Set<string>();
let broadcastingKey = false;
let layoutAuto = true;
let layoutCount = 0;
let singleFocusManual = false;
let singleFocusAuto = false;
let toolsOpen = false;
let gridRect: Rect | null = null;
let pushTimer: NodeJS.Timeout | undefined;
let scanState: ScanState = { running: false, subnet: '', scanned: 0, total: 0, hosts: [] };
let scanCancelled = false;
const wired = new WeakSet<WebContents>();

function emptyScan(): ScanState {
  return {
    running: false,
    subnet: localSubnets()[0]?.cidr ?? '',
    scanned: 0,
    total: 0,
    hosts: [],
  };
}

/** KDE can expose a dark theme while the portal/GTK reports prefer-light. Read kdeglobals first. */
function kdePrefersDark(): boolean | null {
  const paths = [
    process.env.XDG_CONFIG_HOME ? path.join(process.env.XDG_CONFIG_HOME, 'kdeglobals') : '',
    path.join(os.homedir(), '.config', 'kdeglobals'),
  ].filter(Boolean);
  for (const file of paths) {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const look = /^LookAndFeelPackage\s*=\s*(.+)$/im.exec(raw)?.[1] ?? '';
      const scheme = /^ColorScheme\s*=\s*(.+)$/im.exec(raw)?.[1] ?? '';
      if (/dark/i.test(`${look} ${scheme}`)) return true;
      if (/light|breeze/i.test(`${look} ${scheme}`) && !/dark/i.test(`${look} ${scheme}`)) return false;
      const rgb = /^BackgroundNormal\s*=\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/im.exec(raw);
      if (rgb) {
        const [r, g, b] = rgb.slice(1).map(Number);
        return 0.299 * r + 0.587 * g + 0.114 * b < 128;
      }
    } catch {
      /* try next */
    }
  }
  return null;
}

function systemDark(): boolean {
  const kde = kdePrefersDark();
  return kde === null ? nativeTheme.shouldUseDarkColors : kde;
}

function snapshot(): AppSnapshot {
  return {
    devices: store.publicList(),
    sessions: manager ? manager.order().map((s) => s.snapshot()) : [],
    mode,
    focusId,
    media: media ? media.status : {},
    layout: layoutSpec,
    vendors: VENDORS.map((v) => ({ id: v.id, label: v.label, hint: v.hint, defaults: v.defaults })),
    scan: scanState,
    app: {
      nativeDark: systemDark(),
      broadcast: broadcastOn,
      broadcastTargets: [...broadcastTargets],
      version: app.getVersion(),
      demo: DEMO,
      encryption: store ? store.encryption : 'plain',
      platform: process.platform,
      hostname: os.hostname(),
      subnets: localSubnets().map((s) => ({ iface: s.iface, cidr: s.cidr })),
    },
  };
}

function push(): void {
  if (!shellView || shellView.webContents.isDestroyed()) return;
  const snap = snapshot();
  shellView.webContents.send('state', snap);
  if (panelView && !panelView.webContents.isDestroyed()) {
    panelView.webContents.send('state', snap);
  }
}

function layoutPanel(): void {
  if (!panelView || panelView.webContents.isDestroyed()) return;
  const bounds = win.getContentBounds();
  panelView.setBounds({
    x: Math.max(0, bounds.width - 560),
    y: 56,
    width: Math.min(560, bounds.width),
    height: Math.max(0, bounds.height - 56),
  });
}

function ensurePanelView(): WebContentsView {
  if (panelView && !panelView.webContents.isDestroyed()) return panelView;
  panelView = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, '../preload/shell.js'), contextIsolation: true },
  });
  win.contentView.addChildView(panelView);
  wireShortcuts(panelView.webContents);
  panelView.webContents.on('blur', () => {
    if (panelVisible) setTimeout(focusPanelIfOpen, 0);
  });
  panelView.setVisible(false);
  panelView.setBounds({ x: 0, y: 0, width: 1, height: 1 });
  void panelView.webContents.loadFile(path.join(__dirname, '../../src/renderer/index.html'), {
    query: { panel: '1' },
  });
  panelView.webContents.on('did-finish-load', () => {
    if (shellView && panelView) panelView.webContents.send('state', snapshot());
    if (panelState && panelView) {
      panelView.webContents.send('panel-state', {
        dockOpen: true,
        side: panelState.side ?? null,
        panel: panelState.panel ?? null,
        targets: panelState.targets,
        prefill: panelState.prefill,
      });
      setTimeout(() => panelView?.webContents.focus(), 80);
    }
  });
  return panelView;
}

function focusPanelIfOpen(): void {
  if (!panelVisible || !panelView || panelView.webContents.isDestroyed()) return;
  if (!win.isFocused()) return;
  panelView.webContents.focus();
}

function setPanelState(next: { side?: string; panel?: string; targets?: string[]; prefill?: any } | null): void {
  panelState = next;
  if (!next) {
    if (panelView && !panelView.webContents.isDestroyed()) {
      panelView.setBounds({ x: 0, y: 0, width: 1, height: 1 });
      panelView.setVisible(false);
      panelVisible = false;
    }
    const target = (focusId ? manager?.get(focusId) : null) ?? manager?.order()[0];
    if (target) target.webContents.focus();
    else shellView?.webContents.focus();
    const closed = { dockOpen: false };
    shellView?.webContents.send('panel-state', closed);
    panelView?.webContents.send('panel-state', closed);
    return;
  }
  const view = ensurePanelView();
  win.contentView.addChildView(view);
  layoutPanel();
  view.setVisible(true);
  panelVisible = true;
  view.webContents.focus();
  setTimeout(() => {
    if (panelState && panelView && panelVisible) panelView.webContents.focus();
  }, 120);
  const payload = {
    dockOpen: true,
    side: next.side ?? null,
    panel: next.panel ?? null,
    targets: next.targets,
    prefill: next.prefill,
  };
  shellView?.webContents.send('panel-state', payload);
  view.webContents.send('panel-state', payload);
  return;

}

function schedulePush(): void {
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = undefined;
    push();
  }, 80);
}

function pushScan(): void {
  if (!shellView || shellView.webContents.isDestroyed()) return;
  shellView.webContents.send('scan:update', scanState);
}

function contentArea(): Rect {
  const b = win.getContentBounds();
  return { x: 0, y: 0, width: b.width, height: b.height };
}

function gridArea(): Rect {
  const area = contentArea();
  const fallback: Rect = { x: 8, y: 72, width: area.width - 16, height: area.height - 160 };
  return clampRect(gridRect ?? fallback, area);
}

let globalAccels: string[] = [];

function debugShortcut(entry: Record<string, unknown>): void {
  try {
    fs.appendFileSync(
      path.join(app.getPath('userData'), 'shortcut-debug.log'),
      `${new Date().toISOString()} ${JSON.stringify(entry)}\n`,
    );
  } catch {
    /* ignore */
  }
}

function refreshGlobalShortcuts(): void {
  for (const accel of globalAccels) {
    try { globalShortcut.unregister(accel); } catch { /* ignore */ }
  }
  globalAccels = [];
  if (shortcutCapture || !win || !win.isFocused()) return;
  for (const def of SHORTCUT_DEFS) {
    const accel = bindingFor(def);
    if (!accel) continue;
    try {
      if (globalShortcut.register(accel, () => {
        if (win?.isFocused()) runShortcut(def.id);
      })) globalAccels.push(accel);
    } catch {
      /* unsupported accelerator */
    }
  }
}

function installAccelerators(): void {
  if (!win) return;
  if (shortcutCapture) {
    Menu.setApplicationMenu(null);
    refreshGlobalShortcuts();
    return;
  }
  const items = SHORTCUT_DEFS.filter((def) => bindingFor(def)).map((def) => ({
    label: def.label,
    accelerator: bindingFor(def),
    click: () => runShortcut(def.id),
  }));
  if (!items.length) {
    Menu.setApplicationMenu(null);
    win.setMenuBarVisibility(false);
    refreshGlobalShortcuts();
    return;
  }
  const menu = Menu.buildFromTemplate([{ label: 'KVM Console', submenu: items }]);
  Menu.setApplicationMenu(menu);
  win.setMenuBarVisibility(false);
  refreshGlobalShortcuts();
}

function setMode(next: UiMode, id: string | null = null): void {
  const previousFocus = focusId;
  mode = next;
  focusId = next === 'focus' ? id : null;
  if (next === 'grid') {
    const list = manager?.order() ?? [];
    const idx = list.findIndex((s) => s.id === previousFocus);
    gridSel = idx >= 0 ? idx : Math.min(gridSel, Math.max(0, list.length - 1));
  }
  applyLayout();
  schedulePush();
  if (next === 'focus' && focusId) {
    manager?.get(focusId)?.webContents.focus();
  }
}

function syncAutoLayout(): void {
  if (!manager) return;
  const count = manager.order().length;
  if (count !== layoutCount) {
    layoutCount = count;
    layoutAuto = true;
    singleFocusManual = false;
    if (count > 1 && singleFocusAuto && mode === 'focus') {
      singleFocusAuto = false;
      setMode('grid');
    }
  }
  if (count === 1 && !singleFocusManual && mode === 'grid') {
    const only = manager.order()[0];
    if (only) {
      singleFocusAuto = true;
      setMode('focus', only.id);
    }
  }
  if (!layoutAuto) return;
  const next =
    count <= 4 ? { cols: 2, rows: 2 } : count <= 9 ? { cols: 3, rows: 3 } : { cols: 4, rows: 3 };
  if (next.cols !== layoutSpec.cols || next.rows !== layoutSpec.rows) {
    layoutSpec = next;
  }
}

function applyLayout(): void {
  if (!manager || !win) return;
  const sessions = manager.order();
  const area = gridArea();

  if (mode === 'grid') {
    const gridArea = toolsOpen ? { ...area, width: Math.max(360, area.width - 720) } : area;
    const rects = gridRects(gridArea, { ...layoutSpec, gap: 8, inset: 2 });
    if (gridSel >= sessions.length) gridSel = Math.max(0, sessions.length - 1);
    sessions.forEach((session, index) => {
      const rect = rects[index];
      if (!rect) {
        session.setVisible(false);
        session.setGridSelected(false);
        return;
      }
      const visible = GRID_VISIBLE.has(session.state) && !session.external;
      session.setVisible(visible, rect);
      session.setGridSelected(visible && index === gridSel);
      // With the side panel open we keep the existing zoom and simply clip.
      if (visible && !toolsOpen) session.scheduleFit(rect);
    });
    return;
  }

  if (mode === 'focus' && focusId) {
    const focusArea = toolsOpen
      ? { ...area, width: Math.max(360, area.width - 720) }
      : area;
    for (const session of sessions) {
      const visible = session.id === focusId && FOCUS_VISIBLE.has(session.state);
      session.setGridSelected(false);
      session.setVisible(visible, focusArea);
      if (visible && !toolsOpen) session.scheduleFit(focusArea);
    }
    return;
  }

  for (const session of sessions) {
    session.setGridSelected(false);
    session.setVisible(false);
  }
}

function focusIndex(index: number): void {
  const session = manager.order()[index];
  if (session) setMode('focus', session.id);
}

let shortcutBindings: Record<string, string> = defaultBindings();
let shortcutCapture = false;

function shortcutsFile(): string {
  return path.join(app.getPath('userData'), 'shortcuts.json');
}

function bindingFor(def: (typeof SHORTCUT_DEFS)[number]): string {
  const value = shortcutBindings[def.id];
  return !value || /Unidentified/i.test(value) ? def.fallback : value;
}

function loadShortcuts(): void {
  try {
    const raw = JSON.parse(fs.readFileSync(shortcutsFile(), 'utf8'));
    shortcutBindings = { ...defaultBindings(), ...(raw && typeof raw === 'object' ? raw : {}) };
    if (shortcutBindings['connect.new'] === 'Ctrl+Shift+T' && !shortcutBindings['launcher']) {
      shortcutBindings['launcher'] = 'Ctrl+Shift+T';
      shortcutBindings['connect.new'] = 'Ctrl+Shift+N';
      saveShortcuts();
    }
    let changed = false;
    for (const def of SHORTCUT_DEFS) {
      const value = shortcutBindings[def.id];
      if (value && /Unidentified/i.test(value)) {
        shortcutBindings[def.id] = def.fallback;
        changed = true;
      }
    }
    if (!shortcutBindings['mode.toggle']) {
      shortcutBindings['mode.toggle'] = 'Ctrl+Shift+Space';
      changed = true;
    }
    if (changed) saveShortcuts();
  } catch {
    shortcutBindings = defaultBindings();
  }
}

function saveShortcuts(): void {
  try {
    fs.writeFileSync(shortcutsFile(), JSON.stringify(shortcutBindings, null, 2));
  } catch {
    /* ignore */
  }
}

function closeSessionById(id: string): void {
  const device = store.get(id);
  if (focusId === id) setMode('grid');
  manager.close(id);
  if (device?.ephemeral) store.remove(id);
  const remaining = manager.order();
  if (gridSel >= remaining.length) gridSel = Math.max(0, remaining.length - 1);
  setTimeout(() => {
    if (remaining.length) remaining[0].webContents.focus();
    else shellView?.webContents.focus();
  }, 50);
  applyLayout();
  schedulePush();
}

let lastShortcutAction = '';
let lastShortcutAt = 0;
function runShortcut(action: string): void {
  debugShortcut({ src: 'run', action, mode, focusId, gridSel, count: manager?.order().length ?? 0 });
  const now = Date.now();
  if (action === lastShortcutAction && now - lastShortcutAt < 250) return;
  lastShortcutAction = action;
  lastShortcutAt = now;
  const send = (name: string) => shellView?.webContents.send('shortcut', name);
  const list = manager.order();
  if (action === 'tab.prev' || action === 'tab.next') {
    if (!list.length) return;
    const delta = action === 'tab.next' ? 1 : -1;
    if (mode === 'grid') {
      gridSel = (gridSel + delta + list.length) % list.length;
      applyLayout();
      schedulePush();
      return;
    }
    let index = list.findIndex((s) => s.id === focusId);
    if (index < 0) index = 0;
    const next = list[(index + delta + list.length) % list.length];
    setMode('focus', next.id);
    return;
  }
  if (action === 'tab.close') {
    const id = focusId ?? list[list.length - 1]?.id;
    if (id) closeSessionById(id);
    return;
  }
  if (action === 'connect.new') {
    if (panelState?.side === 'connect') setPanelState(null);
    else send('connect');
    return;
  }
  if (action === 'app.quit') return app.quit();
  if (action === 'mode.toggle') {
    if (mode === 'focus') setMode('grid');
    else {
      const id = list[gridSel]?.id ?? focusId ?? list[0]?.id;
      if (id) setMode('focus', id);
    }
    debugShortcut({ src: 'after-toggle', action, mode, focusId, gridSel, count: list.length });
    return;
  }
  if (action === 'reconnect.all') {
    void manager.reconnectAll();
    return;
  }
  if (action === 'reconnect.panel') return send('reconnect');
  if (action === 'theme.toggle') return send('theme');
  const map: Record<string, string> = {
    'panel.scan': 'scan',
    'panel.history': 'history',
    'panel.media': 'media',
    'panel.input': 'input',
    'panel.power': 'power',
    'panel.broadcast': 'broadcast',
    'panel.settings': 'settings',
    launcher: 'launcher',
  };
  if (map[action]) send(map[action]);
}

function handleConfiguredShortcut(event: Electron.Event, input: Electron.Input): boolean {
  if (shortcutCapture) return false;
  if (input.type !== 'keyDown') return false;
  for (const def of SHORTCUT_DEFS) {
    const accel = bindingFor(def);
    if (accel && matchShortcut(input, accel)) {
      event.preventDefault();
      runShortcut(def.id);
      return true;
    }
  }
  return false;
}

function cycleFocus(delta: number): void {
  const sessions = manager.order();
  if (!sessions.length) return;
  const current = sessions.findIndex((s) => s.id === focusId);
  const next = (current + delta + sessions.length) % sessions.length;
  setMode('focus', sessions[next].id);
}

function isBrowserShortcut(input: Electron.Input): boolean {
  const key = (input.key ?? '').toLowerCase();
  const ctrl = input.control;
  const shift = input.shift;
  if (/^f(5|11|12)$/.test(key)) return true;
  if (!ctrl) return false;
  // App-level shortcuts keep working.
  if (shift && ['r', 'm', 'd', 'n'].includes(key)) return false;
  if (['r', 'w', 'n', 't', 'p', 'f', 'g', 'u'].includes(key)) return true;
  if (shift && ['i', 'j', 'c'].includes(key)) return true;
  if (['+', '=', '-', '0'].includes(key)) return true;
  return false;
}

function wireShortcuts(wc: WebContents): void {
  if (wired.has(wc)) return;
  wired.add(wc);
  let forwardUntil = 0;
  wc.on('before-input-event', (event, input) => {
    if (Date.now() < forwardUntil) return;
    if (input.type === 'keyDown' && (input.control || input.alt || input.meta)) {
      debugShortcut({ src: 'before', key: input.key, code: input.code, control: input.control, shift: input.shift, alt: input.alt, meta: input.meta });
    }
    if (handleConfiguredShortcut(event, input)) return;
    // Keep Chromium features (fullscreen, reload, devtools, zoom…) out of the
    // way, but still deliver the key to the KVM page.
    if (isBrowserShortcut(input)) {
      event.preventDefault();
      const isShell = shellView && wc === shellView.webContents;
      if (!isShell) {
        forwardUntil = Date.now() + 40;
        wc.sendInputEvent({
          type: input.type as 'keyDown' | 'keyUp',
          keyCode: input.key,
          modifiers: input.modifiers as never,
        });
      }
      return;
    }
    if (
      broadcastOn &&
      !broadcastingKey &&
      (input.type === 'keyDown' || input.type === 'keyUp') &&
      !input.control && !input.alt && !input.meta &&
      wc !== shellView?.webContents
    ) {
      const source = manager?.order().find((s) => s.webContents === wc);
      if (source) {
        broadcastingKey = true;
        const targets = (manager?.order() ?? []).filter(
          (s) => s.webContents !== wc && (broadcastTargets.size === 0 || broadcastTargets.has(s.id)),
        );
        void Promise.all(targets.map((s) => s.injectKey(input))).finally(() => {
          broadcastingKey = false;
        });
      }
    }
    if (input.type !== 'keyDown') return;
    const code = input.code ?? '';
    const key = (input.key ?? '').toLowerCase();

  });
}

async function createWindow(): Promise<void> {
  win = new BaseWindow({
    width: 1600,
    height: 960,
    minWidth: 1180,
    minHeight: 720,
    backgroundColor: '#07090f',
    title: 'KVM Console',
    icon: path.join(__dirname, '../../assets/icon-256.png'),
    show: false,
  });

  shellView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, '../preload/shell.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.contentView.addChildView(shellView);
  // Set bounds immediately: Electron does not always emit an initial resize
  // event, which leaves the shell view invisible (blank window).
  shellView.setBounds(contentArea());

  const resize = () => {
    shellView.setBounds(contentArea());
    applyLayout();
    schedulePush();
  };
  win.on('resize', () => {
    resize();
    layoutPanel();
  });
  win.on('closed', () => {
    manager?.destroyAll();
    media?.stop();
    app.quit();
  });

  resize();
  wireShortcuts(shellView.webContents);
  shellView.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  vncBridge = new VncBridge();
  await vncBridge.start();
  const recovering = new Set<string>();
  const normalizeSn = (v: string | undefined) => (v || '').trim().toUpperCase();

  async function recoverBySerial(device: Device): Promise<void> {
    const sn = normalizeSn(device.serial);
    if (!sn || recovering.has(device.id)) return;
    recovering.add(device.id);
    try {
      const password = store.passwordOf(device.id);
      const oldPrefix = device.host.split('.').slice(0, 3).join('.');
      const subnets = localSubnets().sort((a, b) => {
        const sa = a.cidr.startsWith(oldPrefix + '.') ? 0 : 1;
        const sb = b.cidr.startsWith(oldPrefix + '.') ? 0 : 1;
        return sa - sb;
      });
      for (const subnet of subnets) {
        if (!/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(subnet.cidr) || subnet.cidr.endsWith('/32')) continue;
        let hosts;
        try {
          hosts = await scanSubnet(
            subnet.cidr,
            { onProgress: () => {}, onHost: () => {}, isCancelled: () => false },
            {
            tryCredentials: true,
            known: Object.fromEntries(
              store.list().map((d) => [
                d.host,
                { username: d.username, password: store.passwordOf(d.id), model: d.model, serial: d.serial },
              ]),
            ),
          },
          );
        } catch {
          continue;
        }
        for (const host of hosts) {
          if (normalizeSn(host.serial) !== sn) continue;
          if (host.credential && host.credential.username !== device.username) continue;
          const scheme = host.scheme ?? 'https';
          try {
            const origin = `${scheme}://${host.ip}:${host.port ?? 443}`;
            const client = new RedfishClient(origin, device.username, password);
            await client.getJson('/redfish/v1/Systems');
          } catch {
            continue;
          }
          store.relocate(device.id, host.ip, host.port ?? 443, scheme);
          console.log('[recover] relocated', device.host, '->', host.ip, 'sn', sn);
          manager?.restart(device.id);
          schedulePush();
          return;
        }
      }
    } catch (err) {
      console.log('[recover] failed', err instanceof Error ? err.message : String(err));
    } finally {
      setTimeout(() => recovering.delete(device.id), 60_000);
    }
  }

  manager = new SessionManager(
    win,
    store,
    () => {
      syncAutoLayout();
      applyLayout();
      schedulePush();
    },
    (session) => {
      wireShortcuts(session.webContents);
      session.webContents.on('focus', () => {
        if (panelVisible) setTimeout(focusPanelIfOpen, 20);
      });
      session.webContents.on('before-mouse-event', (_event, mouse) => {
        if (!panelState) return;
        if (mouse.type !== 'mouseDown' || mouse.button !== 'left') return;
        setPanelState(null);
      });
    },
    (id, patch) => {
      store.updateMeta(id, patch);
      schedulePush();
    },
    vncBridge,
    (device) => void recoverBySerial(device),
    (id, event) => {
      shellView?.webContents.send('download', { id, ...event });
      panelView?.webContents.send('download', { id, ...event });
    },
    (input) => {
      debugShortcut({ src: 'frame', ...input });
      if (shortcutCapture) return;
      for (const def of SHORTCUT_DEFS) {
        const accel = bindingFor(def);
        if (accel && matchShortcut(input, accel)) {
          runShortcut(def.id);
          return;
        }
      }
    },
  );
  registerIpc();
  nativeTheme.on('updated', () => schedulePush());
  setInterval(() => schedulePush(), 5000);
  manager.syncOpen();
  syncAutoLayout();
  installAccelerators();

  if (SMOKE) {
    shellView.webContents.on('console-message', (event: any) => {
      console.log('[renderer]', event?.message ?? event);
    });
    shellView.webContents.on('preload-error', (_e, p, error) => {
      console.error('[preload]', p, error);
    });
  }

  try {
    await shellView.webContents.loadFile(path.join(__dirname, '../../src/renderer/index.html'));
  } catch (err) {
    console.error('[ui] shell 页面加载失败：', err);
  }

  // `did-finish-load` has already fired by the time loadFile resolves; showing
  // the window here is what actually puts it on screen in normal mode.
  push();
  if (!SMOKE || CAPTURE) {
    win.show();
    win.focus();
    console.log('[ui] window shown');
  }
}

async function bootstrapDevice(id: string): Promise<void> {
  const device = store.get(id);
  if (!device) return;
  const password = store.passwordOf(id);

  // Fill model/serial from Redfish so tabs and scan rows can show the SN.
  let vendor = device.vendor;
  try {
    const client = new RedfishClient(`${device.scheme}://${device.host}:${device.port}`, device.username, password);
    if (await client.available()) {
      const root = await client.getJson('/redfish/v1');
      if (vendor === 'generic' && /dell|idrac|poweredge/i.test(`${root?.Vendor ?? ''} ${root?.Product ?? ''}`)) {
        vendor = 'dell';
        store.updateMeta(id, { vendor });
        manager.get(id)?.patchDevice({ vendor });
      }
      const systems = await client.getJson('/redfish/v1/Systems');
      const member = systems?.Members?.[0]?.['@odata.id'];
      if (member) {
        const sys = await client.getJson(member);
        // Dell exposes the service tag (what admins actually use) under OEM;
        // SerialNumber is the chassis serial, which looks "wrong" to users.
        const dellOem = sys?.Oem?.Dell?.DellSystem;
        const serial = dellOem?.ChassisServiceTag
          ? String(dellOem.ChassisServiceTag)
          : sys?.SerialNumber
            ? String(sys.SerialNumber)
            : undefined;
        const model = sys?.Model ? String(sys.Model) : undefined;
        if (serial || model) {
          store.updateMeta(id, { serial, model });
          if (serial) store.dedupeSerial(id);
          manager.get(id)?.patchDevice({ serial, model });
          schedulePush();
        }
      }
    }
  } catch {
    /* serial is optional */
  }

  if (vendor === 'dell') {
    const result = await ensureDellLicense(device, password);
    store.updateMeta(id, { license: result });
    manager.get(id)?.patchDevice({ license: result });
    schedulePush();
    if (result.state === 'activated') {
      // Console menu only appears after the license is applied; retry the flow.
      setTimeout(() => void manager.get(id)?.start(), 1500);
    }
  }
}

function connectDevice(input: DeviceInput & { ephemeral?: boolean }): string {
  const existing = input.ephemeral
    ? undefined
    : store
        .list()
        .find(
          (d) =>
            !d.ephemeral &&
            d.host === input.host.trim() &&
            d.port === (input.port ?? 443),
        );
  const device = store.upsert({ ...input, id: existing?.id }, !input.ephemeral);
  store.touch(device.id);
  // An explicit connect must pick up changed settings (mode/vendor/password).
  if (manager.get(device.id)) manager.restart(device.id);
  else manager.connect(device.id);
  setMode('grid');
  void bootstrapDevice(device.id);
  return device.id;
}

function registerIpc(): void {
  ipcMain.handle('app:snapshot', () => snapshot());

  ipcMain.handle(
    'session:connect',
    (_e, input: DeviceInput & { ephemeral?: boolean }) => {
      try {
        const id = connectDevice(input);
        schedulePush();
        return { ok: true, id };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  ipcMain.handle('session:close', (_e, id: string) => {
    closeSessionById(id);
    return true;
  });

  ipcMain.on('shortcut-key', (event, input: { control: boolean; shift: boolean; alt: boolean; meta: boolean; key: string; code?: string }) => {
    debugShortcut({ src: 'preload', ...input });
    if (shortcutCapture) {
      event.returnValue = false;
      return;
    }
    for (const def of SHORTCUT_DEFS) {
      const accel = bindingFor(def);
      if (accel && matchShortcut(input, accel)) {
        runShortcut(def.id);
        event.returnValue = true;
        return;
      }
    }
    event.returnValue = false;
  });

  ipcMain.handle('shortcuts:get', () => ({ defs: SHORTCUT_DEFS as ShortcutDef[], bindings: shortcutBindings }));

  ipcMain.handle('shortcuts:set', (_e, id: string, accel: string) => {
    if (!SHORTCUT_DEFS.some((d) => d.id === id)) return { ok: false, message: '未知动作' };
    const value = String(accel || '').trim();
    if (value) {
      const clash = SHORTCUT_DEFS.find((d) => d.id !== id && shortcutBindings[d.id] === value);
      if (clash) return { ok: false, message: `与「${clash.label}」冲突` };
    }
    shortcutBindings = { ...shortcutBindings, [id]: value };
    saveShortcuts();
    installAccelerators();
    return { ok: true, bindings: shortcutBindings };
  });

  ipcMain.handle('ui:reload', () => {
    shellView?.webContents.reload();
    panelView?.webContents.reload();
    return true;
  });

  ipcMain.handle('shortcuts:capture', (_e, on: boolean) => {
    shortcutCapture = Boolean(on);
    installAccelerators();
    return true;
  });

  ipcMain.handle('shortcuts:reset', () => {
    shortcutBindings = defaultBindings();
    saveShortcuts();
    installAccelerators();
    return { ok: true, bindings: shortcutBindings };
  });

  ipcMain.handle('history:open', (_e, id: string) => {
    const device = store.get(id);
    if (!device) return { ok: false, message: '记录不存在' };
    manager.connect(id);
    setMode('grid');
    void bootstrapDevice(id);
    schedulePush();
    return { ok: true, id };
  });

  ipcMain.handle('history:remove', (_e, id: string) => {
    if (focusId === id) setMode('grid');
    manager.close(id);
    store.remove(id);
    applyLayout();
    schedulePush();
    return snapshot();
  });

  ipcMain.handle('sessions:reconnect', (_e, id: string) => {
    void manager.get(id)?.start();
    void bootstrapDevice(id);
    return true;
  });

  ipcMain.handle('sessions:focusConsole', (_e, id: string) => {
    return manager.get(id)?.focusConsole() ?? false;
  });

  ipcMain.handle('session:typeText', (_e, id: string, text: string) => {
    const session = manager.get(id);
    if (!session) return false;
    session.typeText(String(text ?? ''));
    return true;
  });

  const applyWeb = (id: string, show: boolean): boolean => {
    const session = manager.get(id);
    if (!session) return false;
    if (show && !session.webOpen) {
      const res = session.toggleWeb();
      if (res.created) {
        win.contentView.addChildView(res.view);
        wireShortcuts(res.view.webContents);
        res.view.webContents.setAudioMuted(true);
      }
    } else if (!show && session.webOpen) {
      session.toggleWeb();
    }
    if (panelView) win.contentView.addChildView(panelView);
    applyLayout();
    schedulePush();
    return session.webOpen;
  };

  ipcMain.handle('session:web', (_e, id: string) => {
    const session = manager.get(id);
    if (!session) return false;
    return applyWeb(id, !session.webOpen);
  });

  ipcMain.handle('session:kvm', (_e, id: string) => {
    const session = manager.get(id);
    if (!session) return false;
    singleFocusManual = true;
    singleFocusAuto = false;
    if (mode !== 'focus' || focusId !== id) setMode('focus', id);
    if (session.webOpen) applyWeb(id, false);
    applyLayout();
    schedulePush();
    return true;
  });

  ipcMain.handle('session:showWeb', (_e, id: string) => {
    const session = manager.get(id);
    if (!session) return false;
    if (mode !== 'focus' || focusId !== id) setMode('focus', id);
    return applyWeb(id, true);
  });

  ipcMain.handle('session:combo', async (_e, id: string, keys: string[]) => {
    const session = manager.get(id);
    if (!session || !Array.isArray(keys) || !keys.length) return false;
    const key = keys[keys.length - 1];
    await session.sendCombo(
      keys.slice(0, -1).map((k) => String(k).toLowerCase()),
      String(key),
    );
    return true;
  });

  ipcMain.handle('sessions:reorder', (_e, ids: string[]) => {
    try {
      store.reorder(ids);
      applyLayout();
      schedulePush();
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle('session:resetConnection', async (_e, id: string) => {
    const device = store.get(id);
    if (!device) return false;
    try {
      await electronSession.fromPartition('persist:kvm').clearStorageData({
        origin: `${device.scheme}://${device.host}:${device.port}`,
      });
    } catch {
      /* ignore */
    }
    manager.close(id);
    store.resetLocal(id);
    schedulePush();
    return true;
  });

  ipcMain.handle('sessions:reconnectAll', async () => {
    await manager.reconnectAll();
    return true;
  });

  ipcMain.handle('ui:panel', (_e, next: { side?: string; panel?: string; targets?: string[]; prefill?: any } | null) => {
    setPanelState(next);
    return true;
  });

  ipcMain.handle('ui:mode', (_e, next: UiMode, id: string | null) => {
    if (next !== 'focus' && next !== 'grid') toolsOpen = false;
    singleFocusManual = true;
    singleFocusAuto = false;
    setMode(next, id ?? null);
    return true;
  });

  ipcMain.handle('ui:broadcast', (_e, args: { on: boolean; targets?: string[] }) => {
    broadcastOn = Boolean(args?.on);
    if (Array.isArray(args?.targets)) broadcastTargets = new Set(args.targets);
    schedulePush();
    return { on: broadcastOn, targets: [...broadcastTargets] };
  });

  ipcMain.handle('ui:layout', (_e, cols: number, rows: number) => {
    layoutAuto = false;
    singleFocusManual = true;
    singleFocusAuto = false;
    layoutSpec = { cols: Math.max(1, Math.min(6, cols)), rows: Math.max(1, Math.min(4, rows)) };
    applyLayout();
    schedulePush();
    return layoutSpec;
  });

  ipcMain.on('ui:grid', (_e, rect: Rect) => {
    if (!rect || !Number.isFinite(rect.x) || !Number.isFinite(rect.width)) return;
    gridRect = {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
    applyLayout();
  });

  /* ------------------------------------------------------------- scanner */
  ipcMain.handle('scan:start', async (_e, cidr: string) => {
    if (scanState.running) return { ok: false, message: '扫描已在进行' };
    const subnet = (cidr || '').trim() || localSubnets()[0]?.cidr || '';
    if (!/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(subnet)) {
      return { ok: false, message: '网段格式应为 192.168.10.0/24' };
    }
    scanCancelled = false;
    scanState = {
      running: true,
      subnet,
      scanned: 0,
      total: hostCount(subnet),
      hosts: [],
      startedAt: Date.now(),
    };
    pushScan();
    schedulePush();

    void (async () => {
      try {
        await scanSubnet(
          subnet,
          {
            onProgress: (scanned, total) => {
              scanState.scanned = scanned;
              scanState.total = total;
              pushScan();
            },
            onHost: (host) => {
              scanState.hosts = [...scanState.hosts, host];
              pushScan();
            },
            isCancelled: () => scanCancelled,
          },
          {
            tryCredentials: true,
            known: Object.fromEntries(
              store.list().map((d) => [
                d.host,
                { username: d.username, password: store.passwordOf(d.id), model: d.model, serial: d.serial },
              ]),
            ),
          },
        );
        scanState.error = undefined;
      } catch (err) {
        scanState.error = err instanceof Error ? err.message : String(err);
      } finally {
        scanState.running = false;
        scanState.finishedAt = Date.now();
        pushScan();
        schedulePush();
      }
    })();

    return { ok: true, subnet };
  });

  ipcMain.handle('scan:cancel', () => {
    scanCancelled = true;
    return true;
  });

  /* --------------------------------------------------------------- media */
  ipcMain.handle('media:pick', async () => {
    const res = await dialog.showOpenDialog({
      title: '选择要挂载的镜像',
      properties: ['openFile'],
      filters: [
        { name: '镜像文件', extensions: ['iso', 'img', 'ima', 'bin'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    return res.canceled ? null : res.filePaths[0];
  });

  ipcMain.handle('media:mount', async (_e, args: { id: string; file: string; bootOnce: boolean }) => {
    const device = store.get(args.id);
    if (!device) return { ok: false, message: '设备不存在' };
    try {
      const live = manager.get(device.id);
      const localVendor = ['xfusion', 'huawei', 'inspur'].includes(device.vendor);
      if (localVendor && live?.canLocalMount()) {
        const local = await live.mountLocalIso(args.file);
        if (local.ok && args.bootOnce) {
          try {
            const origin = `${device.scheme}://${device.host}:${device.port}`;
            const client = new (await import('./redfish')).RedfishClient(
              origin, device.username, store.passwordOf(device.id),
            );
            await client.bootOnce('/redfish/v1/Systems/1', 'Cd');
          } catch {
            /* boot override is best effort */
          }
        }
        if (local.ok) {
          localMedia.set(device.id, args.file);
          media.status[device.id] = {
            inserted: true,
            image: args.file,
            name: args.file.split('/').pop(),
            bytes: 0,
            speed: 0,
          };
        }
        schedulePush();
        return local;
      }
      const result = await media.mount(device, store.passwordOf(device.id), args.file, args.bootOnce);
      schedulePush();
      return result;
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('device:password', (_e, args: { host: string; port?: number }) => {
    const port = args.port ?? 443;
    const device = store.list().find((d) => d.host === args.host && d.port === port);
    return device ? store.passwordOf(device.id) : '';
  });

  ipcMain.handle('power:action', async (_e, args: { id: string; action: string }) => {
    const device = store.get(args.id);
    if (!device) return { ok: false, message: '设备不存在' };
    const map: Record<string, string> = {
      on: 'On',
      off: 'ForceOff',
      shutdown: 'GracefulShutdown',
      reset: 'ForceRestart',
      graceful: 'GracefulRestart',
      nmi: 'Nmi',
    };
    const type = map[args.action];
    if (!type) return { ok: false, message: '未知电源操作' };
    try {
      const client = new RedfishClient(
        `${device.scheme}://${device.host}:${device.port}`,
        device.username,
        store.passwordOf(device.id),
      );
      const targets = await client.discover();
      if (!targets.system) return { ok: false, message: '未找到系统资源' };
      await client.resetSystem(targets.system, type);
      return { ok: true, message: `已发送 ${type}` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('media:eject', async (_e, id: string) => {
    const device = store.get(id);
    if (!device) return { ok: false, message: '设备不存在' };
    try {
      if (localMedia.has(id)) {
        const live = manager.get(id);
        const ok = (await live?.unmountLocalIso()) ?? false;
        localMedia.delete(id);
        media.status[id] = { inserted: false, image: null };
        schedulePush();
        return { ok, message: ok ? '已卸载' : '无法通过网页卸载，请在 KVM 工具栏中弹出光盘' };
      }
      const result = await media.eject(device, store.passwordOf(device.id));
      schedulePush();
      return result;
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('media:status', async () => {
    for (const device of manager.list().map((s) => s.device)) {
      if (localMedia.has(device.id)) continue;
      await media.refresh(device, store.passwordOf(device.id));
    }
    for (const [id, file] of localMedia) {
      media.status[id] = { inserted: true, image: file, name: file.split('/').pop(), bytes: 0, speed: 0 };
    }
    schedulePush();
    return snapshot();
  });

  ipcMain.handle('media:openPanel', async (_e, id: string) => {
    const session = manager.get(id);
    if (!session) return { ok: false, message: '会话未就绪' };
    setMode('focus', id);
    const result = await session.openMediaPanel();
    return result.ok
      ? { ok: true, message: `已打开厂商虚拟介质面板${result.label ? `（${result.label}）` : ''}` }
      : { ok: false, message: '未找到虚拟介质入口，请在控制台里手动打开' };
  });

  ipcMain.handle('license:pick', async () => {
    const res = await dialog.showOpenDialog({
      title: '选择 iDRAC 许可文件',
      properties: ['openFile'],
      filters: [{ name: '许可文件', extensions: ['xml', 'XML'] }],
    });
    return res.canceled ? null : res.filePaths[0];
  });

  ipcMain.handle('license:install', async (_e, args: { id: string; file: string }) => {
    const device = store.get(args.id);
    if (!device) return { ok: false, message: '设备不存在' };
    try {
      const result = await installLicenseFile(device, store.passwordOf(device.id), args.file);
      store.updateMeta(device.id, { license: result });
      manager.get(device.id)?.patchDevice({ license: result });
      schedulePush();
      if (result.state === 'activated') {
        setTimeout(() => void manager.get(device.id)?.start(), 1500);
      }
      return { ok: result.state === 'activated', message: result.note };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle(
    'license:upload',
    async (
      _e,
      args: {
        host: string;
        port?: number;
        scheme?: string;
        username: string;
        password: string;
        file: string;
      },
    ) => {
      try {
        const device: Device = {
          id: `license-${Date.now()}`,
          vendor: 'dell',
          host: args.host.trim(),
          port: args.port ?? 443,
          scheme: (args.scheme as 'https' | 'http') ?? 'https',
          username: args.username.trim(),
          secret: '',
          enc: 'plain',
          createdAt: Date.now(),
        };
        const result = await installLicenseFile(device, args.password, args.file);
        const existing = store.list().find((d) => d.host === device.host && d.port === device.port);
        if (existing) {
          store.updateMeta(existing.id, { license: result });
          manager.get(existing.id)?.patchDevice({ license: result });
          schedulePush();
        }
        return { ok: result.state === 'activated' || result.state === 'ok', message: result.note };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  ipcMain.handle('app:userData', async () => {
    const { shell } = await import('electron');
    await shell.openPath(app.getPath('userData'));
    return true;
  });
}

async function seedDemo(): Promise<void> {
  mock = await startMockBmc();
  const vendors: VendorId[] = ['huawei', 'dell', 'inspur'];
  const models = ['2288H V6', 'PowerEdge R750', '2288H V6', 'NF5280M6'];
  const items = Array.from({ length: 9 }, (_, i) => {
    const n = i + 1;
    return {
      name: `node-${String(n).padStart(2, '0')}`,
      vendor: vendors[i % vendors.length],
      model: models[i % models.length],
      host: `127.0.0.${n}`,
      port: mock!.port,
      scheme: 'http' as const,
      username: 'admin',
      password: 'admin',
      open: true,
    };
  });
  store.seedPlain(items);
  console.log(`[demo] mock BMC on :${mock.port}, 9 devices open`);
}

async function captureAll(tag: string): Promise<void> {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const area = gridArea();
  const rects = gridRects(area, { ...layoutSpec, gap: 8, inset: 2 });
  const shellImage = await shellView.webContents.capturePage();
  const shellSize = shellImage.getSize();
  const scale = shellSize.width / Math.max(1, win.getContentBounds().width);
  fs.writeFileSync(path.join(ARTIFACTS, `${tag}-shell.png`), shellImage.toPNG());

  const tiles: Array<{ index: number; id: string; rect: Rect; file: string }> = [];
  const sessions = manager.order();
  for (let i = 0; i < sessions.length; i++) {
    const rect = rects[i];
    if (!rect) continue;
    const image = await sessions[i].capture();
    if (!image) continue;
    const file = `${tag}-tile-${i}.png`;
    fs.writeFileSync(path.join(ARTIFACTS, file), image);
    tiles.push({ index: i, id: sessions[i].id, rect, file });
  }
  fs.writeFileSync(
    path.join(ARTIFACTS, `${tag}-layout.json`),
    JSON.stringify({ scale, shell: `${tag}-shell.png`, tiles }, null, 2),
  );
}

async function runSmoke(): Promise<void> {
  const started = Date.now();
  const result: any = { demo: DEMO, startedAt: new Date().toISOString() };
  const guard = setTimeout(() => {
    result.error = 'smoke timeout';
    fs.mkdirSync(ARTIFACTS, { recursive: true });
    fs.writeFileSync(
      path.join(ARTIFACTS, 'smoke.json'),
      JSON.stringify({ ...result, elapsedMs: Date.now() - started }, null, 2),
    );
    app.exit(2);
  }, 150000);

  try {
    if (!DEMO) {
      await bootstrapOpenSessions();
      await manager.prewarmOpen(2);
      await new Promise((r) => setTimeout(r, 9000));
      result.sessions = manager.order().map((s) => s.snapshot());
      if (CAPTURE) {
        win.show();
        await new Promise((r) => setTimeout(r, 1500));
        await captureAll('real');
      }
    }

    if (DEMO) {
      await manager.prewarmOpen(4);
      await new Promise((r) => setTimeout(r, 1000));



      result.sessions = manager.order().map((s) => s.snapshot());
      result.ready = manager.order().filter((s) => s.state === 'ready').length;
      result.history = store.publicList().length;

      const device = store.list()[0];
      const iso = path.join(os.tmpdir(), 'kvm-demo.iso');
      fs.writeFileSync(iso, Buffer.alloc(2 * 1024 * 1024, 7));
      result.media = await media.mount(device, store.passwordOf(device.id), iso, true);
      if (media.last) result.range = await media.checkRange(media.last.url);

      fs.mkdirSync(ARTIFACTS, { recursive: true });
      if (CAPTURE) {
        win.show();
        await new Promise((r) => setTimeout(r, 2500));
        await captureAll('grid');

        for (const [tag, next] of [
          ['connect', 'connect'],
          ['history', 'history'],
          ['scan', 'scan'],
          ['media', 'media'],
          ['launcher', 'launcher'],
        ] as const) {
          setMode(next);
          await new Promise((r) => setTimeout(r, 700));
          const shot = await shellView.webContents.capturePage();
          fs.writeFileSync(path.join(ARTIFACTS, `${tag}.png`), shot.toPNG());
        }

        const first = manager.order()[0]?.id ?? null;
        setMode('focus', first);
        await new Promise((r) => setTimeout(r, 1200));
        const focused = await shellView.webContents.capturePage();
        fs.writeFileSync(path.join(ARTIFACTS, 'focus-shell.png'), focused.toPNG());
        fs.writeFileSync(
          path.join(ARTIFACTS, 'focus-rect.json'),
          JSON.stringify({
            rect: gridArea(),
            scale: focused.getSize().width / Math.max(1, win.getContentBounds().width),
          }),
        );
        const tile = await manager.order()[0]?.capture();
        if (tile) fs.writeFileSync(path.join(ARTIFACTS, 'focus-tile.png'), tile);

        for (const session of [...manager.order()]) manager.close(session.id);
        setMode('grid');
        await new Promise((r) => setTimeout(r, 700));
        const landing = await shellView.webContents.capturePage();
        fs.writeFileSync(path.join(ARTIFACTS, 'landing.png'), landing.toPNG());

        await shellView.webContents.executeJavaScript("document.documentElement.dataset.theme='light'");
        await new Promise((r) => setTimeout(r, 500));
        const light = await shellView.webContents.capturePage();
        fs.writeFileSync(path.join(ARTIFACTS, 'light-shell.png'), light.toPNG());
        await shellView.webContents.executeJavaScript("document.documentElement.dataset.theme='dark'");
      }
    }
    result.snapshot = snapshot();
    result.elapsedMs = Date.now() - started;
    fs.mkdirSync(ARTIFACTS, { recursive: true });
    fs.writeFileSync(path.join(ARTIFACTS, 'smoke.json'), JSON.stringify(result, null, 2));
    console.log('[smoke]', JSON.stringify(result.sessions ?? [], null, 0));
    clearTimeout(guard);
    app.exit(0);
  } catch (err) {
    result.error = err instanceof Error ? err.stack ?? err.message : String(err);
    fs.mkdirSync(ARTIFACTS, { recursive: true });
    fs.writeFileSync(path.join(ARTIFACTS, 'smoke.json'), JSON.stringify(result, null, 2));
    console.error('[smoke] failed', err);
    clearTimeout(guard);
    app.exit(1);
  }
}

async function bootstrapOpenSessions(): Promise<void> {
  const ids = manager.order().map((s) => s.id);
  let index = 0;
  const workers = Array.from({ length: Math.min(3, ids.length) }, async () => {
    for (;;) {
      const id = ids[index++];
      if (!id) return;
      await bootstrapDevice(id);
    }
  });
  await Promise.all(workers);
}

async function main(): Promise<void> {
  await app.whenReady();
  Menu.setApplicationMenu(null);

  store = new Store(DEMO);
  if (DEMO) await seedDemo();

  scanState = emptyScan();
  media = new MediaService();

  electronSession.fromPartition('persist:kvm').setCertificateVerifyProc((_req, callback) => {
    callback(0);
  });
  electronSession.fromPartition('persist:kvm').setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'clipboard-read' || permission === 'clipboard-sanitized-write');
  });

  loadShortcuts();
  await createWindow();
  applyLayout();
  win.on('focus', () => {
    installAccelerators();
    setTimeout(focusPanelIfOpen, 0);
  });
  win.on('blur', () => refreshGlobalShortcuts());
  shellView?.webContents.on('focus', () => {
    if (panelVisible) setTimeout(focusPanelIfOpen, 0);
  });

























  if (SMOKE) {
    await runSmoke();
    return;
  }

  setMode('grid');
  if (manager.list().length) {
    void bootstrapOpenSessions();
    void manager.prewarmOpen(3);
  }
}

let quitting = false;
app.on('before-quit', (event) => {
  if (quitting) return;
  quitting = true;
  event.preventDefault();
  void (async () => {
    try {
      await manager?.releaseAll();
    } catch {
      /* ignore */
    }
    manager?.destroyAll();
    media?.stop();
    app.quit();
  })();
});

app.on('window-all-closed', () => app.quit());
process.on('uncaughtException', (err) => {
  console.error('[uncaught]', err);
});

void main();
