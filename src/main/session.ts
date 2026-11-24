import { app, BaseWindow, WebContentsView, type BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { Device, DownloadEvent, Rect, SessionSnapshot, SessionState } from './types';
import { VENDORS } from './store';
import { clearDellSessions } from './dell-session';
import { ensureDellVnc } from './dell-vnc';
import { ensureHuaweiVnc } from './huawei-vnc';
import { RedfishClient } from './redfish';
import type { VncBridge } from './vnc';
import crypto from 'node:crypto';
import {
  consentScript,
  dismissDialogScript,
  dismissPostLoginScript,
  fallbackFillScript,
  filledStateScript,
  focusFieldScript,
  frameProbeScript,
  healthScript,
  kvmLimitScript,
  launchConsoleScript,
  launchKvmScript,
  startConsoleScript,
  loginErrorTextScript,
  openMediaPanelScript,
  prepareLoginScript,
  sessionLimitScript,
  probeScript,
  submitLoginScript,
} from './scripts';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Wait for a loading page to settle. Electron's own WebContents.executeJavaScript
 * does this by attaching a `did-stop-loading` listener on every call, which piles
 * up when a page keeps navigating (MaxListenersExceededWarning). One shared
 * waiter per page avoids that.
 */
const pageReady = new WeakMap<Electron.WebContents, Promise<void>>();

function whenPageReady(wc: Electron.WebContents): Promise<void> {
  if (wc.isDestroyed() || !wc.isLoading()) return Promise.resolve();
  let wait = pageReady.get(wc);
  if (!wait) {
    wait = new Promise<void>((resolve) => {
      wc.once('did-stop-loading', () => {
        pageReady.delete(wc);
        resolve();
      });
    });
    pageReady.set(wc, wait);
  }
  return wait;
}

/**
 * Run a script in the page's main frame. Unlike WebContents.executeJavaScript
 * this never waits for the page to load, so callers pair it with whenPageReady
 * and their own timeout instead of registering listeners per call.
 */
function execInPage<T>(wc: Electron.WebContents, script: string): Promise<T> {
  if (wc.isDestroyed()) return Promise.reject(new Error('page is gone'));
  const frame = wc.mainFrame;
  if (!frame) return Promise.reject(new Error('no main frame'));
  return frame.executeJavaScript(script, true) as Promise<T>;
}

export interface SessionHooks {
  onUpdate: (session: KvmSession) => void;
  onMeta?: (id: string, patch: { vnc?: Device['vnc']; model?: string; serial?: string }) => void;
  onOffline?: (device: Device) => void;
  onDownload?: (id: string, event: DownloadEvent) => void;
  onShortcutInput?: (input: { control: boolean; shift: boolean; alt: boolean; meta: boolean; key: string; code?: string }) => void;
}

function debugSession(entry: Record<string, unknown>): void {
  try {
    fs.appendFileSync(
      path.join(app.getPath('userData'), 'debug.log'),
      `${new Date().toISOString()} ${JSON.stringify(entry)}\n`,
    );
  } catch {
    /* ignore */
  }
}

function wcFocus(wc: Electron.WebContents): void {
  try { wc.focus(); } catch { /* ignore */ }
}

export class KvmSession {
  readonly id: string;
  readonly device: Device;
  readonly view: WebContentsView;
  webView: WebContentsView | null = null;
  webOpen = false;
  private lastWebOpen = false;
  state: SessionState = 'idle';
  detail = '';
  canvas?: { w: number; h: number };

  private win: BaseWindow;
  private zoom = 1;
  private fitTimer?: NodeJS.Timeout;
  private lastFitW = 0;
  private lastFitH = 0;
  private lastRect?: Rect;
  private attached = false;
  private loginUser = '';
  private loginPass = '';
  private limitRetried = false;
  private consoleWin?: BrowserWindow;
  private crashCount = 0;
  private vncActive = false;
  private vncUrl?: string;
  private dellPopup: string | null = null;
  private downloadHandler?: (_e: Electron.Event, item: Electron.DownloadItem) => void;
  private manualTimer?: NodeJS.Timeout;
  private identityLearned = false;
  private lastVisible?: boolean;
  private lastBounds?: Rect;
  private hiddenBounds?: Rect;
  private password: string;
  private running = false;
  private disposed = false;
  private healthTimer?: NodeJS.Timeout;
  private hooks: SessionHooks;

  constructor(
    win: BaseWindow,
    device: Device,
    password: string,
    hooks: SessionHooks,
    private vnc?: VncBridge,
  ) {
    this.id = device.id;
    this.device = device;
    this.win = win;
    this.password = password;
    this.hooks = hooks;
    this.view = new WebContentsView({
      webPreferences: {
        partition: 'persist:kvm',
        preload: path.join(__dirname, '../preload/session.js'),
        nodeIntegrationInSubFrames: true,
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        spellcheck: false,
      },
    });
    try {
      this.view.setBackgroundColor('#05070b');
      try { this.view.setBorderRadius(12); } catch { /* older Electron */ }
    } catch {
      /* older electron */
    }
    win.contentView.addChildView(this.view);
    this.attached = true;
    this.setVisible(false);
    this.wireTransientHandlers();
  }

  get webContents() {
    return this.view.webContents;
  }

  get external(): boolean {
    return !!this.consoleWin;
  }

  /** Last-resort shortcut hook for cross-origin iframes where a preload may not run. */
  private hookFrameShortcuts(wc: Electron.WebContents): void {
    const inject = (frame: Electron.WebFrameMain) => {
      void frame
        .executeJavaScript(
          `(() => {
            if (window.__kvmKeyHook) return true;
            window.__kvmKeyHook = true;
            window.addEventListener('keydown', (e) => {
              if (!e.ctrlKey && !e.altKey && !e.metaKey) return;
              try {
                console.log('__KVM_KEY__' + JSON.stringify({
                  control: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey,
                  key: e.key, code: e.code, trusted: e.isTrusted
                }));
              } catch (err) {}
            }, true);
            return true;
          })()`,
          true,
        )
        .catch(() => undefined);
    };
    wc.on('frame-created', (_e, details) => { if (details.frame) inject(details.frame); });
    wc.on('did-frame-finish-load', () => {
      try {
        for (const frame of wc.mainFrame.framesInSubtree) inject(frame);
      } catch {
        /* frame may be gone */
      }
    });
    wc.on('console-message', (event: any) => {
      const text = event?.message;
      if (typeof text !== 'string') return;
      debugSession({ event: 'console', id: this.id, text: text.slice(0, 500) });
      if (text.startsWith('__KVM_KEYDBG__')) {
        this.hooks.onShortcutInput?.({
          control: false, shift: false, alt: false, meta: false,
          key: '__debug', code: text.slice('__KVM_KEYDBG__'.length),
        });
        return;
      }
      if (!text.startsWith('__KVM_KEY__')) return;
      try {
        const input = JSON.parse(text.slice('__KVM_KEY__'.length));
        this.hooks.onShortcutInput?.(input);
      } catch {
        /* ignore malformed frame message */
      }
    });
  }

  private wireTransientHandlers(): void {
    const wc = this.view.webContents;
    wc.setAudioMuted(true);
    wc.setZoomFactor(1);
    this.hookFrameShortcuts(wc);

    this.downloadHandler = (_e, item) => {
      const url = item.getURL();
      const fileName = item.getFilename() || '';
      if (/\.jnlp(\?|$)/i.test(url) || /\.jnlp$/i.test(fileName)) {
        item.cancel();
        this.setState('manual', '该 iBMC 只提供 Java KVM（kvm.jnlp），已阻止下载；请使用 HTML5 控制台或连接页的 VNC');
        return;
      }
      let target = '';
      try {
        const dir = path.join(app.getPath('downloads'), 'KVM-Console');
        fs.mkdirSync(dir, { recursive: true });
        const raw = item.getFilename() || 'download.bin';
        const safe = raw.replace(/[\\/:*?"<>|]+/g, '_') || 'download.bin';
        target = path.join(dir, safe);
        const dot = safe.lastIndexOf('.');
        const base = dot > 0 ? safe.slice(0, dot) : safe;
        const ext = dot > 0 ? safe.slice(dot) : '';
        for (let i = 1; fs.existsSync(target); i += 1) target = path.join(dir, `${base}-${i}${ext}`);
        item.setSavePath(target);
        const name = safe;
        const emit = (state: DownloadEvent['state'], error?: string) => {
          this.hooks.onDownload?.(this.id, {
            name,
            path: target,
            state,
            received: item.getReceivedBytes(),
            total: item.getTotalBytes(),
            error,
          });
        };
        emit('started');
        let last = 0;
        item.on('updated', () => {
          if (Date.now() - last < 120) return;
          last = Date.now();
          emit('progress');
        });
        item.on('done', (_evt, state) => {
          if (state === 'completed') emit('done');
          else emit('error', state);
        });
      } catch (err) {
        item.cancel();
        this.setState('manual', `下载保存失败：${err instanceof Error ? err.message : String(err)}`);
      }
    };
    wc.session.on('will-download', this.downloadHandler);

    // Vendor popups are adopted in-place where possible.
    wc.setWindowOpenHandler(({ url }) => {
      if (!url || url === 'about:blank') return { action: 'deny' };
      if (/\/restgui\//i.test(url) && !/\/restgui\/(js|css|images?)\//i.test(url)) {
        this.dellPopup = url;
        this.setState('kvm', '正在打开 iDRAC 控制台');
        return { action: 'deny' };
      }
      if (/^https?:\/\//i.test(url)) {
        this.setState('kvm', '正在接管厂商控制台窗口');
        setTimeout(() => {
          if (!this.disposed) wc.loadURL(url).catch(() => undefined);
        }, 50);
      }
      return { action: 'deny' };
    });

    wc.on('did-fail-load', (_e, code, desc, _url, isMainFrame) => {
      if (!isMainFrame || code === -3) return;
      this.setState('error', `页面加载失败：${desc} (${code})`);
      if ([-106, -109, -118, -137].includes(code)) this.hooks.onOffline?.(this.device);
    });

    wc.on('render-process-gone', (_e, details) => {
      if (this.disposed) return;
      this.crashCount += 1;
      try {
        const dir = path.join(process.cwd(), 'artifacts');
        fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(
          path.join(dir, 'renderer-crash.log'),
          `${new Date().toISOString()} ${this.device.host} ${details.reason} exit=${details.exitCode}\n`,
        );
      } catch {
        /* ignore */
      }
      if (this.crashCount >= 3) {
        if (this.vncActive) {
          // Self-heal: next launch runs without GPU acceleration.
          try {
            fs.writeFileSync(path.join(app.getPath('userData'), 'soft-render'), '1');
          } catch {
            /* ignore */
          }
        }
        this.setState('error', '渲染进程反复退出，已停止自动重启；下次启动会自动改用软件渲染');
        return;
      }
      // First two failures retry silently (no error toast).
      this.detail = `连接中断，正在自动恢复（${this.crashCount}/2）`;
      this.setState('kvm', this.detail);
      setTimeout(() => {
        if (this.disposed) return;
        if (this.vncActive && this.vncUrl) {
          // Only reload the console page: no re-login, no VNC re-config.
          this.view.webContents.loadURL(this.vncUrl).catch(() => undefined);
        } else {
          void this.start();
        }
      }, 2000);
    });

    wc.on('unresponsive', () => this.setState('error', '页面无响应'));
  }

  baseUrl(): string {
    return `${this.device.scheme}://${this.device.host}:${this.device.port}/`;
  }

  private async run<T>(script: string, timeoutMs = 8000): Promise<T | null> {
    const wc = this.view.webContents;
    if (wc.isDestroyed()) return null;
    try {
      let timedOut = false;
      return await Promise.race<T | null>([
        whenPageReady(wc).then(() => (timedOut ? null : execInPage<T>(wc, script))),
        sleep(timeoutMs).then(() => {
          timedOut = true;
          return null;
        }),
      ]);
    } catch {
      return null;
    }
  }

  private async load(url: string): Promise<void> {
    const wc = this.view.webContents;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const done = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        wc.off('did-finish-load', onLoad);
        wc.off('did-fail-load', onFail);
        err ? reject(err) : resolve();
      };
      const onLoad = () => done();
      const onFail = (_e: unknown, code: number, desc: string, _u: string, isMainFrame: boolean) => {
        if (!isMainFrame || code === -3) return;
        done(new Error(`打开失败：${desc} (${code})`));
      };
      const timer = setTimeout(() => done(new Error('页面加载超时（25s）')), 25000);
      wc.once('did-finish-load', onLoad);
      wc.on('did-fail-load', onFail);
      wc.loadURL(url).catch((err: Error) => done(err));
    });
    await this.decorateFrame();
  }

  private setState(state: SessionState, detail = ''): void {
    if (this.disposed) return;
    this.state = state;
    this.detail = detail;
    debugSession({ event: 'state', id: this.id, state, detail, url: this.safeUrl() });
    // The KVM page replaces the dashboard/login page; zoom computed for those
    // pages is wrong, so refit as soon as the console surface is ready.
    if ((state === 'ready' || state === 'manual') && this.lastRect) {
      this.scheduleFit(this.lastRect, true);
    }
    if (state === 'ready') {
      setTimeout(() => {
        try {
          wcFocus(this.view.webContents);
        } catch {
          /* ignore */
        }
        void this.run('(() => { const c = document.querySelector("canvas"); if (c) { c.setAttribute("tabindex", "0"); c.focus(); } return true; })()', 1200)
          .catch(() => undefined)
          .finally(() => {
            if (this.device.vendor === 'dell') void this.captureDebugShots();
          });
      }, 500);
    }
    this.hooks.onUpdate(this);
  }

  async start(): Promise<void> {
    debugSession({ event: 'start', id: this.id, host: this.device.host, vendor: this.device.vendor, mode: this.device.mode });
    if (this.running || this.disposed) return;
    this.running = true;
    this.limitRetried = false;
    this.vncActive = false;
    this.stopHealth();
    // Render the BMC UI at a desktop-ish CSS width even inside a small tile.
    // Otherwise responsive BMC dashboards (iDRAC) hide the console entry.
    if (this.device.vendor === 'dell') {
      // iDRAC hides the console entry in a narrow responsive layout; give the
      // hidden view a desktop-sized viewport while it boots and logs in.
      this.hiddenBounds = { x: 0, y: 0, width: 1280, height: 800 };
      this.view.setBounds(this.hiddenBounds);
      try {
        this.view.webContents.setZoomFactor(1);
      } catch {
        /* ignore */
      }
    } else {
      const tileW = this.lastRect?.width ?? 640;
      const initialZoom = Math.max(0.25, Math.min(1, Math.round((tileW / 1280) * 100) / 100));
      try {
        this.view.webContents.setZoomFactor(initialZoom);
      } catch {
        /* ignore */
      }
    }
    this.canvas = undefined;
    try {
      this.setState('loading', '正在打开管理页面');
      await this.load(this.baseUrl());

      this.setState('login', '正在自动登录');
      const tLogin = Date.now();
      const login = await this.autoLogin();
      debugSession({ event: 'auto-login', id: this.id, result: login });
      if (login === 'manual') {
        if (this.state !== 'error') this.setState('manual', this.detail || '请手动登录');
        this.watchManualLogin();
        return;
      }

      await this.dismissPostLogin();
      await sleep(250);

      const loopback = /^(127\.|localhost$)/.test(this.device.host);
      const mode = loopback
        ? 'web'
        : this.device.vendor === 'dell'
          ? this.device.mode === 'vnc'
            ? 'vnc'
            : 'dell-web'
          : this.device.mode === 'vnc'
            ? 'vnc'
            : 'web';

      if (mode === 'dell-web') {
        if (await this.startDellWebConsole()) return;
        this.detail = 'iDRAC 内嵌控制台不可用';
        this.setState('manual', this.detail);
        return;
      }

      if (mode === 'vnc' && this.vnc) {
        // Huawei/xFusion VNC takes an 8-character password; auth truncates.
        const vncPassword = this.device.vendor === 'dell' ? 'calvin12' : 'Admin@9000';

        // Fast path: if VNC is already listening and accepts our password,
        // don't touch the BMC configuration at all.
        // VNC authentication uses exactly 8 bytes; send the truncated form so
        // it matches what the BMC stored (the iBMC form only accepts 8 chars).
        const viewerPassword = vncPassword.slice(0, 8);
        // Cached VNC profile: skip probing/configuring when it still works.
        const cached = this.device.vnc;
        if (cached?.enabled && (await this.connectVnc(cached.port, viewerPassword))) {
          this.setState('ready', 'VNC 控制台');
          this.startHealth();
          return;
        }
        const existing = await this.probeVncPort();
        if (existing && (await this.connectVnc(existing, viewerPassword))) {
          this.device.vnc = { enabled: true, port: existing, verifiedAt: Date.now() };
          this.hooks.onMeta?.(this.id, { vnc: this.device.vnc });
          this.setState('ready', 'VNC 控制台');
          this.startHealth();
          return;
        }

        let result: { ok: boolean; port: number; message: string };
        if (this.device.vendor === 'dell') {
          // Manual VNC mode only; never used as a fallback.
          result = await ensureDellVnc(this.device, this.password, vncPassword);
        } else {
          // Huawei/xFusion: the public Redfish VncService has no switch; the
          // web UI uses a private API from the logged-in page.
          let page = await this.enableHuaweiVncViaPage(vncPassword.slice(0, 8), this.password);
          result = page.ok ? await this.waitTcp(page.port) : { ok: false, port: page.port, message: page.message };
          if (!result.ok) {
            // One retry: the confirm dialog sometimes needs a second pass.
            page = await this.enableHuaweiVncViaPage(vncPassword.slice(0, 8), this.password);
            if (page.ok) result = await this.waitTcp(page.port);
            else result = { ok: false, port: page.port, message: page.message };
          }
        }
        if (!result.ok) {
          this.detail = `VNC 启用失败：${result.message}`;
          this.setState('manual', this.detail);
          return;
        }
        if (await this.connectVnc(result.port, viewerPassword)) {
          this.device.vnc = { enabled: true, port: result.port, verifiedAt: Date.now() };
          this.hooks.onMeta?.(this.id, { vnc: this.device.vnc });
          this.setState('ready', 'VNC 控制台');
          this.startHealth();
          return;
        }
        const tail = await this.run<string>('(document.body.innerText || "").slice(-260)', 2500);
        console.log('[vnc] page tail', JSON.stringify(tail));
        this.device.vnc = { enabled: false, port: result.port, verifiedAt: Date.now() };
        this.hooks.onMeta?.(this.id, { vnc: this.device.vnc });
        this.detail = 'VNC 已开启，但控制台连接失败（密码可能被改过或会话已满）';
        this.setState('manual', this.detail);
        return;
      }

      this.setState('kvm', '正在进入 KVM');
      await this.openKvm();
      if (this.external) {
        // iDRAC console lives in its own window; the dashboard has no canvas.
        this.startHealth();
        return;
      }
      await this.waitForFrame();
      this.startHealth();
    } catch (err) {
      this.setState('error', err instanceof Error ? err.message : String(err));
    } finally {
      this.running = false;
    }
  }

  private framesInPage(): any[] {
    const root: any = this.view.webContents.mainFrame;
    const out: any[] = [];
    try {
      const subtree = typeof root.framesInSubtree === 'function' ? root.framesInSubtree : null;
      if (subtree) out.push(...subtree);
      else out.push(root, ...(root.frames ?? []));
    } catch {
      out.push(root);
    }
    return out;
  }

  private async frameExec(frame: any, code: string, timeoutMs = 2500): Promise<any> {
    try {
      if (typeof frame.isDestroyed === 'function' && frame.isDestroyed()) return null;
      return await Promise.race([frame.executeJavaScript(code, true), sleep(timeoutMs).then(() => null)]);
    } catch {
      return null;
    }
  }

  private async hasPasswordAnywhere(): Promise<boolean> {
    for (const frame of this.framesInPage()) {
      const found = await this.frameExec(
        frame,
        `!![...document.querySelectorAll('input[type=password]')].find((e) => { const r = e.getBoundingClientRect(); return r.width > 4 && r.height > 4; })`,
        1500,
      );
      if (found) return true;
    }
    return false;
  }

  /**
   * Type through the browser instead of assigning `value`. Huawei/Dell consoles
   * are framework apps, often with the form inside an iframe, and ignore
   * synthetic input events; trusted typing plus a frame-aware fallback works.
   */
  private async loginWithTrustedInput(): Promise<'submitted' | 'not-found' | 'unfilled'> {
    const wc = this.view.webContents;
    for (const frame of this.framesInPage()) {
      const found = await this.frameExec(
        frame,
        `!![...document.querySelectorAll('input[type=password]')].find((e) => { const r = e.getBoundingClientRect(); return r.width > 4 && r.height > 4; })`,
      );
      if (!found) continue;

      const prepared = await this.frameExec(frame, prepareLoginScript());
      if (!prepared || !prepared.ok) continue;

      try {
        wc.focus();
        if (prepared.hasUser) {
          await this.frameExec(frame, focusFieldScript('user'));
          await sleep(80);
          wc.insertText(this.loginUser);
          await sleep(120);
        }
        await this.frameExec(frame, focusFieldScript('pw'));
        await sleep(80);
        wc.insertText(this.loginPass);
        await sleep(150);

        let filled = await this.frameExec(frame, filledStateScript());
        if (!filled || !filled.pw || !filled.user) {
          filled = await this.frameExec(frame, fallbackFillScript(this.loginUser, this.loginPass));
          await sleep(150);
        }
        if (!filled || !filled.pw) return 'unfilled';
        if (prepared.hasUser && !filled.user) return 'unfilled';

        await this.frameExec(frame, submitLoginScript());
        return 'submitted';
      } catch {
        const filled = await this.frameExec(frame, fallbackFillScript(this.loginUser, this.loginPass));
        if (filled && filled.pw) {
          await this.frameExec(frame, submitLoginScript());
          return 'submitted';
        }
        return 'unfilled';
      }
    }
    return 'not-found';
  }

  private resolveCredentials(pageTitle: string): { username: string; password: string } {
    let vendor = this.device.vendor;
    if (vendor === 'generic') {
      const t = pageTitle.toLowerCase();
      if (/xfusion|fusion/.test(t)) vendor = 'xfusion';
      else if (/ibmc|huawei/.test(t)) vendor = 'huawei';
      else if (/idrac|dell/.test(t)) vendor = 'dell';
      else if (/isbmc|inspur/.test(t)) vendor = 'inspur';
    }
    const preset = VENDORS.find((v) => v.id === vendor);
    const fallback = preset?.defaults[0];
    return {
      username: this.device.username || fallback?.u || '',
      password: this.password || fallback?.p || '',
    };
  }

  private async autoLogin(): Promise<'ok' | 'manual'> {
    const probe = await this.run<any>(probeScript());
    if (!probe) {
      this.detail = '无法读取登录页';
      return 'manual';
    }

    // Consent screens come first on some firmware; SPA forms render late; the
    // form itself may live in an iframe, so check every frame.
    if (!probe.hasPassword) {
      const clicked = await this.run<string | null>(consentScript(), 4000);
      if (clicked) await sleep(600);
      for (let i = 0; i < 8; i++) {
        if (await this.hasPasswordAnywhere()) break;
        await sleep(500);
      }
    }

    if (!(await this.hasPasswordAnywhere())) return 'ok';

    // iDRAC: all GUI sessions occupied -> kick them once, then retry login.
    const limited = await this.run<boolean>(sessionLimitScript(), 2500);
    if (limited) {
      const pre = this.resolveCredentials(String(probe.title || ''));
      if (this.device.vendor === 'dell' && pre.username && pre.password && !this.limitRetried) {
        this.limitRetried = true;
        const cleanup = await clearDellSessions(this.device, pre.password);
        if (cleanup.removed > 0) {
          this.detail = `${cleanup.message}，正在重新登录`;
          this.hooks.onUpdate(this);
          await sleep(1200);
          await this.load(this.baseUrl());
          return this.autoLogin();
        }
        this.detail = `iDRAC 会话数已满，自动清理失败：${cleanup.message}`;
        return 'manual';
      }
      this.detail = 'iDRAC 会话数已满：请用 racadm closessn -a 或浏览器登出后重试';
      return 'manual';
    }

    // Credentials may be missing (e.g. connected from scan without a match) or
    // only half-filled. Fall back to the vendor's first default pair — one
    // attempt only, never a brute-force loop.
    // Re-read the title: Angular/iBMC sets <title> after bootstrap, so the
    // value captured right after load is often empty.
    const titled = await this.run<any>(probeScript(), 4000);
    const creds = this.resolveCredentials(String(titled?.title || probe.title || ''));
    this.loginUser = creds.username;
    this.loginPass = creds.password;
    if (!this.loginUser || !this.loginPass) {
      this.detail = '缺少用户名或密码，请手动填写后登录';
      return 'manual';
    }

    if (probe.locked) {
      this.detail = '账号可能已被锁定，请手动处理';
      return 'manual';
    }
    if (probe.forceChange) {
      this.detail = '该设备要求首次登录修改密码，请手动完成';
      return 'manual';
    }

    const outcome = await this.loginWithTrustedInput();
    if (outcome === 'not-found') {
      this.detail = '未找到登录表单，请手动登录';
      return 'manual';
    }
    if (outcome === 'unfilled') {
      this.detail = '自动填充未生效（页面可能禁止脚本输入），请手动登录';
      return 'manual';
    }

    for (let i = 0; i < 26; i++) {
      await sleep(700);
      if (!(await this.hasPasswordAnywhere())) {
        if (probe.forceChange) {
          this.detail = '该设备要求修改默认密码，请手动完成';
          return 'manual';
        }
        return 'ok';
      }
    }

    let errorText = '';
    for (const frame of this.framesInPage()) {
      const text = await this.frameExec(frame, loginErrorTextScript(), 1500);
      if (text) {
        errorText = String(text);
        break;
      }
    }
    this.detail = errorText
      ? `登录失败：${errorText}`
      : '自动登录未成功（凭据错误或需要验证码），请手动登录';
    return 'manual';
  }

  private async dumpDiagnostics(tag: string): Promise<void> {
    try {
      const href = await this.run<string>('location.href', 2000);
      const title = await this.run<string>('document.title', 2000);
      const text = await this.run<string>('(document.body && document.body.innerText || "").slice(0, 3000)', 3000);
      const buttons = await this.run<string[]>(
        `[...document.querySelectorAll('button,a,[role=button]')].map((e) => ((e.innerText || '') + '').trim()).filter(Boolean).slice(0, 80)`,
        3000,
      );
      const dir = path.join(process.cwd(), 'artifacts');
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const base = `${tag}-${this.device.host}-${stamp}`;
      fs.writeFileSync(
        path.join(dir, `${base}.txt`),
        JSON.stringify({ href, title, text, buttons, state: this.state, detail: this.detail }, null, 1),
        'utf8',
      );
      const img = await this.view.webContents.capturePage();
      if (!img.isEmpty()) fs.writeFileSync(path.join(dir, `${base}.png`), img.toPNG());
    } catch {
      /* best effort */
    }
  }

  private async probeVncPort(): Promise<number | undefined> {
    const net = await import('node:net');
    for (const port of [5901, 5900, 5902, 5903]) {
      const open = await new Promise<boolean>((resolve) => {
        const sock = net.connect({ host: this.device.host, port });
        const done = (v: boolean) => {
          sock.destroy();
          resolve(v);
        };
        sock.setTimeout(900, () => done(false));
        sock.on('connect', () => done(true));
        sock.on('error', () => done(false));
      });
      if (open) return port;
    }
    return undefined;
  }

  private async startDellWebConsole(): Promise<boolean> {
    if (!this.vnc) return false;
    this.dellPopup = null;
    const wc = this.view.webContents;
    try {
      const current = wc.getURL();
      const base = current.split('#')[0];
      if (!/restgui\/index\.html\?/.test(base)) return false;
      const target = `${base}&vconsole`;
      const token = /[?&]([a-f0-9]{16,})/i.exec(base)?.[1] || '';

      // Fast path: ask the API directly with the page's XSRF token instead of
      // reloading the whole &vconsole SPA just to make it call this endpoint.
      if (token) {
        const direct = await wc
          .executeJavaScript(
            `fetch('/sysmgmt/2015/server/vconsole', { headers: { 'XSRF-TOKEN': ${JSON.stringify(token)} }, credentials: 'same-origin' })
               .then(r => (r.ok ? r.text() : '')).catch(() => '')`,
            true,
          )
          .catch(() => '');
        if (direct && direct.includes('VCSID=')) {
          const loc = JSON.parse(direct).Location as string;
          const qs = new URL(loc).searchParams;
          const vcsid = qs.get('VCSID') || '';
          const key2 = qs.get('VCSID2') || '';
          if (vcsid && key2) {
            const cookies = await wc.session.cookies.get({ url: base });
            const cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
            const scheme = this.device.scheme === 'http' ? 'ws' : 'wss';
            const wsUrl = `${scheme}://${this.device.host}/vnc/vconsole?vck=${vcsid}`;
            const url = this.vnc!.viewerUrlForWebSocket(wsUrl, cookie, key2);
            this.vncActive = true;
            this.vncUrl = url;
            this.hiddenBounds = { x: 0, y: 0, width: 1024, height: 768 };
            this.view.setBounds(this.hiddenBounds);
            this.view.setVisible(false);
            this.lastBounds = this.hiddenBounds;
            this.lastVisible = false;
            const t0 = Date.now();
            await this.load(url);
            this.setState('kvm', '正在连接 iDRAC 控制台…');
            for (let i = 0; i < 80; i++) {
              await sleep(250);
              const st = await this.run<string>('document.body?.dataset.state || ""', 1000).catch(() => '');
              if (st === 'connected') {
                this.canvas = undefined;
                this.setState('ready', 'Web 控制台');
                this.startHealth();
                return true;
              }
              if (st === 'error') break;
            }
            const reason = await this.run<string>('document.body?.dataset.error || ""', 1000).catch(() => '');
            this.detail = reason ? `控制台连接失败：${reason}` : '连接 iDRAC 控制台超时';
            this.setState('manual', this.detail);
            return false;
          }
        }
      }

      const hook = `(() => {
        window.__loc = null;
        const O = XMLHttpRequest.prototype.open;
        const S = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function (m, u) { this.__u = String(u); return O.apply(this, arguments); };
        XMLHttpRequest.prototype.send = function () {
          const x = this;
          this.addEventListener('load', function () {
            try { if (/server\\/vconsole/.test(x.__u)) window.__loc = x.responseText; } catch (e) {}
          });
          return S.apply(this, arguments);
        };
      })();`;
      const dbg = wc.debugger;
      if (!dbg.isAttached()) dbg.attach('1.3');
      await dbg.sendCommand('Page.enable');
      await dbg.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: hook });
      await this.load(target);

      let raw: string | null = null;
      for (let i = 0; i < 40; i++) {
        raw = await this.run<string | null>('window.__loc || null', 1200);
        if (raw || this.dellPopup) break;
        await sleep(250);
      }
      if (this.dellPopup) {
        const popup = this.dellPopup;
        await this.load(popup);
        await this.decorateFrame();
        this.canvas = undefined;
        this.setState('ready', 'Web 控制台');
        this.startHealth();
        return true;
      }
      if (!raw) return false;
      const loc = JSON.parse(raw).Location as string;
      const qs = new URL(loc).searchParams;
      const vcsid = qs.get('VCSID') || '';
      const key2 = qs.get('VCSID2') || '';
      if (!vcsid || !key2) return false;

      const cookies = await wc.session.cookies.get({ url: base });
      const cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
      const scheme = this.device.scheme === 'http' ? 'ws' : 'wss';
      const wsUrl = `${scheme}://${this.device.host}/vnc/vconsole?vck=${vcsid}`;
      const url = this.vnc.viewerUrlForWebSocket(wsUrl, cookie, key2);
      this.vncActive = true;
      this.vncUrl = url;
      this.hiddenBounds = { x: 0, y: 0, width: 1024, height: 768 };
      this.view.setBounds(this.hiddenBounds);
      this.view.setVisible(false);
      this.lastBounds = this.hiddenBounds;
      this.lastVisible = false;
      await this.load(url);
      await sleep(300);
      this.canvas = undefined;
      this.setState('ready', 'Web 控制台');
      this.startHealth();
      return true;
    } catch {
      return false;
    }
  }

  private async connectVnc(port: number, password: string): Promise<boolean> {
    if (!this.vnc) return false;
    const url = this.vnc.viewerUrl(this.device.host, port, password);
    this.vncActive = true;
    this.vncUrl = url;
    this.hiddenBounds = { x: 0, y: 0, width: 1024, height: 768 };
    this.view.setBounds(this.hiddenBounds);
    this.view.setVisible(false);
    this.lastBounds = this.hiddenBounds;
    this.lastVisible = false;
    await this.load(url);
    for (let i = 0; i < 30; i++) {
      const st = await this.run<string>('document.body.dataset.state || ""', 1500);
      if (st === 'connected') return true;
      if (st === 'error') return false;
      await sleep(400);
    }
    return false;
  }

  private async enableHuaweiVncViaPage(
    vncPassword: string,
    loginPassword: string,
  ): Promise<{ ok: boolean; port: number; message: string }> {
    const pwd = JSON.stringify(vncPassword);
    await this.run(`location.hash = '#/navigate/service/vnc'; true`, 2000);
    for (let i = 0; i < 20; i++) {
      const ready = await this.run<boolean>(
        `!!document.querySelector('#vncEnable_awrapper') || !!document.querySelector('#vncPassword')`,
        1500,
      );
      if (ready) break;
      if (i === 6) {
        await this.run(
          `(() => { const a = [...document.querySelectorAll('a,li,span,div')].find((x) => /^VNC$/i.test(((x.innerText || '') + '').trim())); if (a) a.click(); return true; })()`,
          1500,
        );
      }
      await sleep(500);
    }

    const toggle = await this.run<string>(
      `(() => {
        const sw = document.querySelector('#vncEnable_awrapper');
        if (!sw) return 'no-switch';
        if (/off/.test(String(sw.className))) { sw.click(); return 'toggled'; }
        return 'already-on';
      })()`,
      3000,
    );
    await sleep(700);

    const filled = await this.run<string>(
      `(() => {
        const setVal = (el, v) => {
          const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          set.call(el, v);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.dispatchEvent(new Event('blur', { bubbles: true }));
        };
        const p1 = document.querySelector('#vncPassword');
        const p2 = document.querySelector('#vncPwdConfirm');
        if (!p1 || !p2) return 'no-password-fields';
        setVal(p1, ${pwd});
        setVal(p2, ${pwd});
        return 'filled';
      })()`,
      3000,
    );
    await sleep(700);

    const saved = await this.run<string>(
      `(() => {
        const btn = [...document.querySelectorAll('button')].find((b) => /^save$/i.test((b.innerText || '').trim()));
        if (!btn) return 'no-save';
        if (btn.disabled) return 'save-disabled';
        btn.click();
        return 'saved';
      })()`,
      3000,
    );
    await sleep(1500);
    const loginPwd = JSON.stringify(loginPassword);
    const confirmed = await this.run<string>(
      `(() => {
        const setVal = (el, v) => {
          const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          set.call(el, v);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.dispatchEvent(new Event('blur', { bubbles: true }));
        };
        const inputs = [...document.querySelectorAll('input')].filter(
          (i) => i.offsetParent && /password/i.test(i.type + ' ' + i.className) && i.id !== 'vncPassword' && i.id !== 'vncPwdConfirm',
        );
        const input = inputs[inputs.length - 1];
        if (input) setVal(input, ${loginPwd});
        const ok = [...document.querySelectorAll('button')].find((b) => /^ok$/i.test((b.innerText || '').trim()));
        if (!ok) return input ? 'no-ok' : 'no-dialog';
        ok.click();
        return 'confirmed';
      })()`,
      4000,
    );

    if (saved !== 'saved') {
      const route = await this.run<string>('location.hash || location.pathname', 1500);
      const dom = await this.run<any>(
        `(() => ({ text: (document.body.innerText || '').slice(0, 220), inputs: [...document.querySelectorAll('input')].map((i) => i.id).slice(0, 12), switches: [...document.querySelectorAll('a.ti3-switch')].map((a) => ({ id: a.id, cls: a.className })) }))()`,
        2500,
      );
      console.log('[vnc] dom', JSON.stringify(dom));
      return {
        ok: false,
        port: 5900,
        message: `VNC 页面操作失败（页面 ${route || '?'}，开关 ${toggle || '?'}，密码框 ${filled || '?'}，保存 ${saved || '?'}，确认 ${confirmed || '?'}）`,
      };
    }
    return this.waitTcp(5900);
  }

  private async waitTcp(port: number): Promise<{ ok: boolean; port: number; message: string }> {
    const net = await import('node:net');
    for (let i = 0; i < 25; i++) {
      const open = await new Promise<boolean>((resolve) => {
        const sock = net.connect({ host: this.device.host, port });
        const done = (v: boolean) => { sock.destroy(); resolve(v); };
        sock.setTimeout(1500, () => done(false));
        sock.on('connect', () => done(true));
        sock.on('error', () => done(false));
      });
      if (open) return { ok: true, port, message: '已启用 VNC' };
      await sleep(700);
    }
    return { ok: false, port, message: `VNC 已配置但端口 ${port} 未监听` };
  }

  private async dismissPostLogin(): Promise<void> {
    for (let i = 0; i < 3; i++) {
      const clicked = await this.run<string | null>(dismissPostLoginScript(), 3000);
      if (!clicked) return;
      await sleep(400);
    }
  }

  private async kvmLimitReached(): Promise<boolean> {
    return Boolean(await this.run<boolean>(kvmLimitScript(), 2500));
  }

  /** Huawei/xFusion: drop existing web/KVM sessions so a new console can attach. */
  private async kickHuaweiSessions(): Promise<boolean> {
    if (this.device.vendor === 'dell') return false;
    try {
      const origin = `${this.device.scheme}://${this.device.host}:${this.device.port}`;
      const client = new RedfishClient(origin, this.device.username, this.password);
      const col = await client.getJson('/redfish/v1/SessionService/Sessions');
      let removed = 0;
      for (const member of col?.Members ?? []) {
        const path = member?.['@odata.id'];
        if (!path) continue;
        const res = await client.raw('DELETE', path);
        if (res.status < 400) removed += 1;
      }
      return removed > 0;
    } catch {
      return false;
    }
  }

  private async kickAndRetryKvm(): Promise<boolean> {
    if (this.limitRetried) return false;
    this.limitRetried = true;
    this.detail = 'KVM 会话数已满，正在清理旧会话…';
    this.hooks.onUpdate(this);
    const kicked = await this.kickHuaweiSessions();
    if (!kicked) return false;
    this.detail = '已清理旧会话，正在重新登录…';
    this.hooks.onUpdate(this);
    await this.load(this.baseUrl());
    await sleep(1200);
    await this.autoLogin();
    await sleep(800);
    await this.openKvm();
    return true;
  }

  private async openKvm(): Promise<void> {
    if (this.device.kvmUrl) {
      await this.load(this.device.kvmUrl);
      return;
    }

    const probe = await this.run<any>(probeScript(), 4000);
    const title = String(probe?.title || '');
    const isIbmc =
      /ibmc/i.test(title) || this.device.vendor === 'huawei' || this.device.vendor === 'xfusion';
    const isIdrac = /idrac/i.test(title) || this.device.vendor === 'dell';

    if (isIbmc) {
      // iBMC 3.x: /#/kvm_h5 is the HTML5 console. It is gated by two storage
      // keys the home-page "Start" button sets; navigating directly avoids the
      // menu entry that is often disabled.
      const navigated = await this.run<boolean>(
        `(() => {
          try { sessionStorage.setItem('kvmConnect', '1'); } catch (e) {}
          try { localStorage.setItem('H5ClientModel', 'Private'); } catch (e) {}
          location.hash = '#/kvm_h5';
          return true;
        })()`,
        5000,
      );
      if (navigated) {
        await sleep(1800);
        if (await this.kvmLimitReached()) {
          if (await this.kickAndRetryKvm()) return;
          this.detail = 'KVM 会话数已满，自动清理失败：请在 iBMC「用户与安全 → 在线用户」注销旧会话后重连';
          this.setState('manual', this.detail);
          return;
        }
        return;
      }
    }

    // Generic: click a console entry, in any frame. The dashboard is an SPA and
    // may still be rendering right after login, so poll for a while.
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      for (const frame of this.framesInPage()) {
        const started = await this.frameExec(frame, startConsoleScript(), 4000);
        if (started && started.ok) {
          for (let k = 0; k < 20 && !this.external; k++) await sleep(500);
          if (this.external) return;
        }
      }
      for (const frame of this.framesInPage()) {
        const clicked = await this.frameExec(frame, launchKvmScript(), 9000);
        if (clicked && clicked.ok) {
          await sleep(1500);
          // iDRAC-style UIs need a second click on "Start/Launch ...".
          for (const inner of this.framesInPage()) {
            const launched = await this.frameExec(inner, launchConsoleScript(), 4000);
            if (launched && launched.ok) break;
          }
          return;
        }
      }
      await sleep(1000);
    }
    const license = this.device.license;
    this.detail =
      license && license.state !== 'ok' && license.note
        ? `KVM 入口未找到：${license.note}`
        : '未找到 KVM 入口，请手动点击，或在连接里填写 KVM 地址';
    this.setState('manual', this.detail);
  }

  /** After a manual web login, go straight to the HTML5 console instead of clicking iBMC's Java/KVM entry. */
  private watchManualLogin(): void {
    if (this.manualTimer) clearInterval(this.manualTimer);
    this.manualTimer = setInterval(async () => {
      if (this.disposed || this.state !== 'manual') {
        if (this.manualTimer) clearInterval(this.manualTimer);
        this.manualTimer = undefined;
        return;
      }
      const url = this.view.webContents.getURL();
      if (!url || /\/login|#\/login/i.test(url)) return;
      const stillLogin = await this.run<boolean>(
        `(() => [...document.querySelectorAll('input[type=password]')].some((e) => {
          const r = e.getBoundingClientRect();
          return r.width > 4 && r.height > 4;
        }))()`,
        1200,
      ).catch(() => false);
      if (stillLogin) return;
      if (this.manualTimer) clearInterval(this.manualTimer);
      this.manualTimer = undefined;
      this.setState('kvm', '检测到登录成功，正在打开控制台');
      await this.openKvm();
      await this.waitForFrame();
    }, 2000);
  }

  private async waitForFrame(): Promise<void> {
    for (let i = 0; i < 45; i++) {
      const frame = await this.run<any>(frameProbeScript(), 4000);
      if (frame && frame.ok) {
        this.canvas = { w: Number(frame.w), h: Number(frame.h) };
        this.setState('ready', `${frame.w}×${frame.h}`);
        return;
      }
      await sleep(600);
    }
    if (await this.kvmLimitReached()) {
      if (this.device.vendor !== 'dell' && (await this.kickAndRetryKvm())) {
        await this.waitForFrame();
        return;
      }
      this.detail = 'KVM 会话数已满，自动清理失败：请在 iBMC「用户与安全 → 在线用户」注销旧会话后重连';
      this.setState('manual', this.detail);
      return;
    }
    const lic = this.device.license;
    this.setState(
      'manual',
      lic && lic.state !== 'ok' && this.device.vendor === 'dell'
        ? `虚拟控制台不可用：${lic.note}`
        : '未检测到画面信号，但页面已打开，可直接操作',
    );
  }

  private startHealth(): void {
    this.stopHealth();
    void this.learnIdentity();
    this.healthTimer = setInterval(() => void this.healthCheck(), 12000);
  }

  /** Read model/SN from Redfish once the console is up, so future scans show the real model. */
  private async learnIdentity(): Promise<void> {
    if (this.identityLearned || this.disposed) return;
    this.identityLearned = true;
    let model = '';
    let serial = '';
    if (this.device.vendor === 'dell') {
      try {
        const info = await this.run<any>(
          `fetch('/sysmgmt/2015/bmc/info').then(r => r.json()).catch(() => null)`,
          3000,
        );
        const attrs = info?.Attributes ?? {};
        model = attrs.SystemModelName ? String(attrs.SystemModelName) : '';
        const title = String(attrs.GUITitleBar || '');
        const m = /^iDRAC-(.+)$/i.exec(title);
        if (m) serial = m[1];
      } catch {
        /* optional */
      }
    }
    try {
      const client = new RedfishClient(
        `${this.device.scheme}://${this.device.host}:${this.device.port}`,
        this.device.username,
        this.password,
      );
      const targets = await client.discover();
      if (targets.system) {
        const sys = await client.getJson(targets.system);
        if (sys?.Model && !model) model = String(sys.Model);
        const tag = String(
          sys?.Oem?.Dell?.DellSystem?.ChassisServiceTag ||
          sys?.Oem?.Dell?.DellSystem?.ServiceTag ||
          '',
        );
        if (tag) serial = tag;
        else if (!serial && sys?.SerialNumber) serial = String(sys.SerialNumber);
      }
    } catch {
      /* identity is best effort */
    }
    if (model) this.device.model = model;
    if (serial) this.device.serial = serial;
    if (model || serial) this.hooks.onMeta?.(this.id, { model, serial });
  }

  private stopHealth(): void {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = undefined;
  }

  private async healthCheck(): Promise<void> {
    if (this.running || this.disposed) return;
    if (this.state === 'manual') {
      // User logged in by hand. Do NOT re-run the stored credentials here:
      // they are exactly what failed, and another attempt may lock the account.
      if (this.running || !this.detail.includes('登录')) return;
      if (await this.hasPasswordAnywhere()) return;
      this.running = true;
      try {
        this.setState('kvm', '检测到已登录，正在进入 KVM');
        await this.openKvm();
        await this.waitForFrame();
      } finally {
        this.running = false;
        this.startHealth();
      }
      return;
    }
    if (this.state !== 'ready') return;
    const health = await this.run<any>(healthScript(), 5000);
    if (!health) return;
    if (health.timeout) {
      await this.run(dismissDialogScript(), 3000);
      this.detail = '会话超时，正在重新连接';
      void this.start();
      return;
    }
    if (health.hasPassword) {
      this.detail = '登录态丢失，正在重新登录';
      void this.start();
    }
  }

  /**
   * The vendor console is usually laid out for a full window (1024/1920 wide).
   * Dropped into a 500px tile it overflows and shows a cropped corner, which is
   * unusable. Chromium's page zoom is the cheapest way to make the whole page
   * fit the tile; mouse coordinates keep working because the browser scales
   * them for us.
   */
  scheduleFit(rect: Rect, force = false): void {
    if (this.disposed) return;
    this.lastRect = rect;
    if (!force && Math.abs(rect.width - this.lastFitW) < 6 && Math.abs(rect.height - this.lastFitH) < 6) return;
    this.lastFitW = rect.width;
    this.lastFitH = rect.height;
    if (this.fitTimer) clearTimeout(this.fitTimer);
    this.fitTimer = setTimeout(() => void this.applyFit(rect), 200);
  }

  /** Rounded pane frame injected into the embedded page (views cannot clip natively). */
  private async decorateFrame(): Promise<void> {
    if (this.disposed) return;
    const wc = this.view.webContents;
    if (wc.isDestroyed()) return;
    try {
      await wc.insertCSS(`
        #__kvm_frame_border {
          position: fixed; inset: 0; border-radius: 12px; pointer-events: none;
          box-shadow: inset 0 0 0 1px rgba(128, 136, 145, 0.55);
          z-index: 2147483647;
        }
      `);
      await wc.executeJavaScript(
        `(() => {
          let el = document.getElementById('__kvm_frame_border');
          if (!el) {
            el = document.createElement('div');
            el.id = '__kvm_frame_border';
            (document.body || document.documentElement).appendChild(el);
          }
          return true;
        })()`,
        true,
      );
    } catch {
      /* page may forbid injection */
    }
  }

  private async applyFit(rect: Rect): Promise<void> {
    if (this.disposed || this.vncActive) return;
    if (rect.width < 120 || rect.height < 80) return;
    const wc = this.view.webContents;
    if (wc.isDestroyed()) return;

    try {
      wc.setZoomFactor(1);
    } catch {
      return;
    }
    await sleep(70);

    const info = await this.run<{
      cw: number;
      ch: number;
      top: number;
      sw: number;
      sh: number;
    }>(
      `(() => {
        const c = document.querySelector('canvas');
        if (c) {
          c.style.position = '';
          c.style.left = '';
          c.style.top = '';
          c.style.width = '';
          c.style.height = '';
          c.style.maxWidth = '';
          c.style.maxHeight = '';
          c.style.zIndex = '';
          c.style.background = '';
        }
        for (const id of ['__kvm_canvas_fit', '__kvm_cover_fit', '__kvm_fit_style']) {
          const node = document.getElementById(id);
          if (node) node.remove();
        }
        const r = c ? c.getBoundingClientRect() : null;
        const de = document.documentElement;
        const b = document.body;
        return {
          cw: r ? Math.round(r.width) : 0,
          ch: r ? Math.round(r.height) : 0,
          top: r ? Math.max(0, Math.round(r.top)) : 0,
          sw: Math.max(de ? de.scrollWidth : 0, b ? b.scrollWidth : 0),
          sh: Math.max(de ? de.scrollHeight : 0, b ? b.scrollHeight : 0)
        };
      })()`,
      3000,
    );
    if (!info) return;

    let zoom: number;
    if (info.cw > 2 && info.ch > 2) {
      // Contain: keep the whole console visible, preserve aspect ratio.
      zoom = Math.min(rect.width / info.cw, rect.height / (info.top + info.ch));
    } else if (info.sw > 2 && info.sh > 2) {
      zoom = Math.min(rect.width / info.sw, rect.height / info.sh);
    } else {
      return;
    }
    zoom = Math.max(0.15, Math.min(1.5, Math.round(zoom * 100) / 100));
    this.zoom = zoom;
    try {
      wc.setZoomFactor(zoom);
    } catch {
      /* ignore */
    }
    await sleep(70);
    await this.run(
      `(() => {
        const c = document.querySelector('canvas');
        if (c) c.scrollIntoView({ block: 'center', inline: 'center' });
        return true;
      })()`,
      2000,
    );
  }

  patchDevice(patch: Partial<Device>): void {
    Object.assign(this.device, patch);
    if (patch.license && this.state === 'manual' && this.device.vendor === 'dell') {
      this.detail =
        patch.license.state === 'ok'
          ? '许可已就绪，正在重新进入 KVM'
          : `虚拟控制台不可用：${patch.license.note}`;
    }
    this.hooks.onUpdate(this);
  }

  /** Grid keyboard selection highlight, injected above the unmodified vendor page. */
  setGridSelected(on: boolean): void {
    const views = [this.view, this.webView].filter(Boolean) as WebContentsView[];
    for (const v of views) {
      const wc = v.webContents;
      if (wc.isDestroyed()) continue;
      void whenPageReady(wc)
        .then(() =>
          execInPage(
            wc,
            `(() => {
              let el = document.getElementById('__kvm_grid_sel');
              if (!el) {
                el = document.createElement('div');
                el.id = '__kvm_grid_sel';
                el.style.cssText = 'position:fixed;inset:0;border-radius:12px;pointer-events:none;z-index:2147483646;border:3px solid #3daee9;box-sizing:border-box;';
                (document.body || document.documentElement).appendChild(el);
              }
              el.style.display = ${on ? "'block'" : "'none'"};
              const frame = document.getElementById('__kvm_frame_border');
              if (frame) {
                frame.style.inset = ${on ? "'3px'" : "''"};
                frame.style.borderRadius = ${on ? "'9px'" : "''"};
              }
              return true;
            })()`,
          ),
        )
        .catch(() => undefined);
    }
  }

  setVisible(visible: boolean, rect?: Rect): void {
    if (this.disposed) return;
    if (rect) this.lastBounds = rect;
    const b = (rect ?? this.lastBounds ?? this.hiddenBounds) as Rect;
    const hidden = { x: 0, y: 0, width: 1, height: 1 };
    const active = this.webOpen && this.webView ? this.webView : this.view;
    const inactive = active === this.view ? this.webView : this.view;
    try {
      // Always apply both views: stale hidden web views would otherwise cover
      // other panes after a toggle.
      this.view.setBounds(visible ? b : hidden);
      this.webView?.setBounds(visible ? b : hidden);
      this.view.setVisible(visible && active === this.view);
      this.webView?.setVisible(visible && active === this.webView);
    } catch {
      /* view may be gone during teardown */
    }
    this.lastVisible = visible;
  }

  /** Reset guest modifier state through the RFB instance itself (works even
   *  when the canvas is not focused). */
  private async resetGuestKeyboard(): Promise<void> {
    const ok = await this.run(
      `(() => {
        const r = window.__rfb;
        if (!r || typeof r.sendKey !== 'function') return false;
        const mods = [[0xffe9,'AltLeft'],[0xffe3,'ControlLeft'],[0xffe1,'ShiftLeft'],[0xffe7,'MetaLeft']];
        for (const [ks, code] of mods) {
          try { r.sendKey(ks, code, true); r.sendKey(ks, code, false); } catch (e) {}
        }
        return true;
      })()`,
      1500,
    ).catch(() => undefined);
    debugSession({ event: 'reset-keyboard', id: this.id, ok });
  }

  /** Force a known-up modifier state in the guest (down+up pair). */
  releaseModifiers(): void {
    const wc = this.view.webContents;
    if (wc.isDestroyed()) return;
    for (const key of ['Alt', 'Control', 'Shift', 'Meta']) {
      try {
        wc.sendInputEvent({ type: 'keyDown', keyCode: key });
        wc.sendInputEvent({ type: 'keyUp', keyCode: key });
      } catch {
        /* ignore */
      }
    }
  }

  typeText(text: string): void {
    const wc = this.view.webContents;
    wc.focus();
    const chars = Array.from(text.slice(0, 4000));
    let i = 0;
    const next = () => {
      if (i >= chars.length || this.disposed) return;
      const ch = chars[i++];
      const info = this.charInfo(ch);
      if (!info) {
        setTimeout(next, 4);
        return;
      }
      const mods = info.shift ? (['shift'] as const) : [];
      try {
        if (info.shift) wc.sendInputEvent({ type: 'keyDown', keyCode: 'Shift', modifiers: ['shift'] });
        wc.sendInputEvent({ type: 'keyDown', keyCode: info.key, modifiers: [...mods] });
        if (info.text) wc.sendInputEvent({ type: 'char', keyCode: info.text, modifiers: [...mods] });
        wc.sendInputEvent({ type: 'keyUp', keyCode: info.key, modifiers: [...mods] });
        if (info.shift) wc.sendInputEvent({ type: 'keyUp', keyCode: 'Shift' });
      } catch {
        return;
      }
      setTimeout(next, 8);
    };
    next();
  }

  /** US-layout physical key info; shifted symbols keep their base key plus Shift. */
  private charInfo(ch: string): { key: string; code: string; vk: number; shift: boolean; text?: string } | null {
    if (/^[a-z]$/.test(ch)) return { key: ch, code: `Key${ch.toUpperCase()}`, vk: ch.toUpperCase().charCodeAt(0), shift: false, text: ch };
    if (/^[A-Z]$/.test(ch)) return { key: ch, code: `Key${ch}`, vk: ch.charCodeAt(0), shift: true, text: ch };
    if (/^[0-9]$/.test(ch)) return { key: ch, code: `Digit${ch}`, vk: 48 + Number(ch), shift: false, text: ch };
    if (ch === ' ') return { key: ' ', code: 'Space', vk: 32, shift: false, text: ' ' };
    if (ch === '\n' || ch === '\r') return { key: 'Enter', code: 'Enter', vk: 13, shift: false };
    if (ch === '\t') return { key: 'Tab', code: 'Tab', vk: 9, shift: false };
    const shifted: Record<string, [string, string, number]> = {
      '!': ['1', 'Digit1', 49], '@': ['2', 'Digit2', 50], '#': ['3', 'Digit3', 51],
      '$': ['4', 'Digit4', 52], '%': ['5', 'Digit5', 53], '^': ['6', 'Digit6', 54],
      '&': ['7', 'Digit7', 55], '*': ['8', 'Digit8', 56], '(': ['9', 'Digit9', 57],
      ')': ['0', 'Digit0', 48], '_': ['-', 'Minus', 189], '+': ['=', 'Equal', 187],
      '{': ['[', 'BracketLeft', 219], '}': [']', 'BracketRight', 221],
      '|': ['\\', 'Backslash', 220], ':': [';', 'Semicolon', 186],
      '"': ["'", 'Quote', 222], '<': [',', 'Comma', 188], '>': ['.', 'Period', 190],
      '?': ['/', 'Slash', 191], '~': ['`', 'Backquote', 192],
    };
    if (shifted[ch]) {
      const [key, code, vk] = shifted[ch];
      return { key, code, vk, shift: true, text: ch };
    }
    const plain: Record<string, [string, number]> = {
      '-': ['Minus', 189], '=': ['Equal', 187], '[': ['BracketLeft', 219],
      ']': ['BracketRight', 221], '\\': ['Backslash', 220], ';': ['Semicolon', 186],
      "'": ['Quote', 222], ',': ['Comma', 188], '.': ['Period', 190], '/': ['Slash', 191],
      '`': ['Backquote', 192],
    };
    if (plain[ch]) {
      const [code, vk] = plain[ch];
      return { key: ch, code, vk, shift: false, text: ch };
    }
    return null;
  }

  private keyInfo(key: string): { key: string; code: string; vk: number } | null {
    const k = key.trim();
    if (/^F\d{1,2}$/i.test(k)) {
      const n = Number(k.slice(1));
      if (n >= 1 && n <= 24) return { key: `F${n}`, code: `F${n}`, vk: 111 + n };
    }
    const named: Record<string, [string, number]> = {
      delete: ['Delete', 46],
      del: ['Delete', 46],
      insert: ['Insert', 45],
      backspace: ['Backspace', 8],
      enter: ['Enter', 13],
      escape: ['Escape', 27],
      esc: ['Escape', 27],
      tab: ['Tab', 9],
      space: ['Space', 32],
      arrowup: ['ArrowUp', 38],
      arrowdown: ['ArrowDown', 40],
      arrowleft: ['ArrowLeft', 37],
      arrowright: ['ArrowRight', 39],
      home: ['Home', 36],
      end: ['End', 35],
      pageup: ['PageUp', 33],
      pagedown: ['PageDown', 34],
    };
    const hit = named[k.toLowerCase()];
    if (hit) return { key: hit[0], code: hit[0], vk: hit[1] };
    if (/^[a-z]$/i.test(k)) {
      return { key: k.toLowerCase(), code: `Key${k.toUpperCase()}`, vk: k.toUpperCase().charCodeAt(0) };
    }
    if (/^[0-9]$/.test(k)) return { key: k, code: `Digit${k}`, vk: k.charCodeAt(0) };
    if (k === '=' || k === '+') return { key: k, code: 'Equal', vk: 187 };
    if (k === '-') return { key: '-', code: 'Minus', vk: 189 };
    return null;
  }

  private async clickIbmcCombination(reskey: string): Promise<boolean> {
    const wc = this.view.webContents;
    try {
      let item = await this.run<{ x: number; y: number; w: number } | null>(
        `(() => {
          const el = document.querySelector('[reskey="${reskey}"]');
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width) };
        })()`,
        1500,
      );
      const icon = await this.run<{ x: number; y: number } | null>(
        `(() => {
          const el = document.getElementById('btn_keyboard');
          if (!el) return null;
          const r = el.getBoundingClientRect();
          if (r.width < 2 || r.height < 2) return null;
          return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
        })()`,
        2000,
      );
      if (!icon) return false;
      const dbg = wc.debugger;
      if (!dbg.isAttached()) dbg.attach('1.3');
      const click = async (x: number, y: number) => {
        await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
        await dbg.sendCommand('Input.dispatchMouseEvent', {
          type: 'mousePressed', x, y, button: 'left', clickCount: 1,
        });
        await dbg.sendCommand('Input.dispatchMouseEvent', {
          type: 'mouseReleased', x, y, button: 'left', clickCount: 1,
        });
      };
      if (!item || item.w <= 0) {
        await click(icon.x, icon.y);
        await sleep(250);
        item = await this.run<{ x: number; y: number; w: number } | null>(
          `(() => {
            const el = document.querySelector('[reskey="${reskey}"]');
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width) };
          })()`,
          2000,
        );
      }
      if (!item || item.w <= 0) return false;
      await click(item.x, item.y);
      return true;
    } catch {
      return false;
    }
  }

  canLocalMount(): boolean {
    return !this.vncActive && !this.external;
  }

  /** Mount an ISO through the vendor web console's own local-file uploader. */
  async unmountLocalIso(): Promise<boolean> {
    const wc = this.view.webContents;
    try {
      const dbg = wc.debugger;
      if (!dbg.isAttached()) dbg.attach('1.3');
      const icon = await this.run<{ x: number; y: number } | null>(
        `(() => {
          const el = document.getElementById('btn_cdrom');
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
        })()`,
        1500,
      );
      if (!icon) return false;
      const visible = await this.run<boolean>(
        `(() => { const b=document.getElementById('cdromConnect'); return Boolean(b && b.getBoundingClientRect().width > 0); })()`,
        1200,
      );
      if (!visible) {
        await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: icon.x, y: icon.y, button: 'left', clickCount: 1 });
        await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: icon.x, y: icon.y, button: 'left', clickCount: 1 });
        await sleep(500);
      }
      const text = await this.run<string>(
        `(() => { const b=document.getElementById('cdromConnect'); return b ? b.innerText : ''; })()`,
        1200,
      );
      if (!/disconnect/i.test(text || '')) return false;
      await this.run(`(() => { const b=document.getElementById('cdromConnect'); if (b) b.click(); return true; })()`, 1200);
      for (let i = 0; i < 10; i++) {
        await sleep(400);
        const t = await this.run<string>(
          `(() => { const b=document.getElementById('cdromConnect'); return b ? b.innerText : ''; })()`,
          1000,
        );
        if (/connect/i.test(t || '') && !/disconnect/i.test(t || '')) return true;
      }
      return true;
    } catch {
      return false;
    }
  }

  async mountLocalIso(filePath: string): Promise<{ ok: boolean; message: string }> {
    const wc = this.view.webContents;
    try {
      wc.focus();
      const icon = await this.run<{ x: number; y: number } | null>(
        `(() => {
          const el = document.getElementById('btn_cdrom');
          if (!el) return null;
          const r = el.getBoundingClientRect();
          if (r.width < 2) return null;
          return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
        })()`,
        2000,
      );
      if (!icon) return { ok: false, message: '当前页面没有 CD/DVD 菜单' };

      const dbg = wc.debugger;
      if (!dbg.isAttached()) dbg.attach('1.3');
      const click = async (x: number, y: number) => {
        await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
        await dbg.sendCommand('Input.dispatchMouseEvent', {
          type: 'mousePressed', x, y, button: 'left', clickCount: 1,
        });
        await dbg.sendCommand('Input.dispatchMouseEvent', {
          type: 'mouseReleased', x, y, button: 'left', clickCount: 1,
        });
      };

      const menuVisible = await this.run<boolean>(
        `(() => { const b=document.getElementById('cdromConnect'); return Boolean(b && b.getBoundingClientRect().width > 0); })()`,
        1500,
      );
      if (!menuVisible) {
        await click(icon.x, icon.y);
        await sleep(700);
      }

      await this.run(
        `(() => { const r=document.querySelector('#cdrom_submenu input[type=radio]'); if (r) r.click(); return true; })()`,
        1500,
      );

      await dbg.sendCommand('DOM.enable');
      const doc = await dbg.sendCommand('DOM.getDocument', { depth: 2 });
      const node = await dbg.sendCommand('DOM.querySelector', {
        nodeId: doc.root.nodeId,
        selector: '#isoCdromId input[type=file]',
      });
      if (!node?.nodeId) return { ok: false, message: '没有找到镜像文件选择框' };
      await dbg.sendCommand('DOM.setFileInputFiles', { files: [filePath], nodeId: node.nodeId });

      let enabled = false;
      for (let i = 0; i < 24; i++) {
        await sleep(400);
        const st = await this.run<{ disabled: boolean } | null>(
          `(() => { const b=document.getElementById('cdromConnect'); return b ? { disabled: Boolean(b.disabled) } : null; })()`,
          1200,
        );
        if (st && !st.disabled) {
          enabled = true;
          break;
        }
      }
      if (!enabled) return { ok: false, message: '已选择镜像，但 BMC 没有启用连接按钮' };

      await this.run(`(() => { const b=document.getElementById('cdromConnect'); if (b) b.click(); return true; })()`, 1500);
      for (let i = 0; i < 40; i++) {
        await sleep(500);
        const text = await this.run<string>(
          `(() => { const b=document.getElementById('cdromConnect'); return b ? b.innerText : ''; })()`,
          1200,
        );
        if (/disconnect/i.test(text || '')) {
          await this.run(`(() => { const b=document.getElementById('btn_cdrom'); if (b) b.click(); return true; })()`, 1000);
          return { ok: true, message: `已通过本地上传挂载 ${filePath.split('/').pop()}` };
        }
      }
      return { ok: false, message: '本地上传已开始，但 BMC 没有在 20 秒内确认连接' };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  async injectKey(input: Electron.Input): Promise<void> {
    if (this.disposed) return;
    const wc = this.view.webContents;
    if (wc.isDestroyed()) return;
    const info = this.keyInfo(input.key || '');
    if (!info) return;
    let mask = 0;
    if (input.alt) mask |= 1;
    if (input.control) mask |= 2;
    if (input.meta) mask |= 4;
    if (input.shift) mask |= 8;
    try {
      const dbg = wc.debugger;
      if (!dbg.isAttached()) dbg.attach('1.3');
      const base = {
        modifiers: mask,
        key: info.key,
        code: info.code,
        windowsVirtualKeyCode: info.vk,
        nativeVirtualKeyCode: info.vk,
      };
      if (input.type === 'keyUp') {
        await dbg.sendCommand('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
      } else {
        await dbg.sendCommand('Input.dispatchKeyEvent', {
          ...base,
          type: 'rawKeyDown',
          text: info.key.length === 1 ? info.key : undefined,
        });
      }
    } catch {
      /* ignore */
    }
  }

  async sendCombo(modifiers: string[], key: string): Promise<void> {
    const wc = this.view.webContents;
    wc.focus();
    await sleep(40);

    let mask = 0;
    for (const m of modifiers) {
      const v = m.toLowerCase();
      if (v === 'alt') mask |= 1;
      else if (v === 'control' || v === 'ctrl') mask |= 2;
      else if (v === 'meta' || v === 'command') mask |= 4;
      else if (v === 'shift') mask |= 8;
    }

    const combo = [...modifiers.map((m) => m.toLowerCase()), key.toLowerCase()].join('+');
    const ibmcReskey: Record<string, string> = {
      'control+alt+delete': 'KVM_KEY_CTRL_ALT_DEL',
      'ctrl+alt+delete': 'KVM_KEY_CTRL_ALT_DEL',
      'alt+tab': 'KVM_KEY_ALT_TAB',
      'control+escape': 'KVM_KEY_CTRL_ESC',
      'control+shift': 'KVM_KEY_CTRL_SHIFT',
      'control+space': 'KVM_KEY_CTRL_SPACE',
    };
    const normalized = combo.replace(/ctrl/g, 'control').replace(/del$/, 'delete');
    const reskey = ibmcReskey[normalized] ?? ibmcReskey[combo];
    if (reskey) {
      if (await this.clickIbmcCombination(reskey)) return;
    }

    // Focus the console canvas so viewers that bind keys to it see the event.
    await this.run(
      `(() => {
        const c = document.querySelector('canvas');
        if (c) {
          if (!c.hasAttribute('tabindex')) c.setAttribute('tabindex', '0');
          c.focus();
        }
        return true;
      })()`,
      1500,
    );

    const info = this.keyInfo(key);
    // sendInputEvent does not maintain modifier state (ctrlKey/altKey stay
    // false), so use CDP for a trusted key with a real virtual key code.
    if (info) {
      try {
        const dbg = wc.debugger;
        if (!dbg.isAttached()) dbg.attach('1.3');
        const base = {
          modifiers: mask,
          key: info.key,
          code: info.code,
          windowsVirtualKeyCode: info.vk,
          nativeVirtualKeyCode: info.vk,
        };
        const ctrl = (mask & 2) !== 0;
        const alt = (mask & 1) !== 0;
        // Send modifiers as their own key events too: iDRAC tracks key state.
        if (ctrl) {
          await dbg.sendCommand('Input.dispatchKeyEvent', {
            type: 'rawKeyDown', modifiers: 2, key: 'Control', code: 'ControlLeft',
            windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17,
          });
        }
        if (alt) {
          await dbg.sendCommand('Input.dispatchKeyEvent', {
            type: 'rawKeyDown', modifiers: mask, key: 'Alt', code: 'AltLeft',
            windowsVirtualKeyCode: 18, nativeVirtualKeyCode: 18,
          });
        }
        await dbg.sendCommand('Input.dispatchKeyEvent', { ...base, type: 'rawKeyDown' });
        await dbg.sendCommand('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
        if (alt) {
          await dbg.sendCommand('Input.dispatchKeyEvent', {
            type: 'keyUp', modifiers: ctrl ? 2 : 0, key: 'Alt', code: 'AltLeft',
            windowsVirtualKeyCode: 18, nativeVirtualKeyCode: 18,
          });
        }
        if (ctrl) {
          await dbg.sendCommand('Input.dispatchKeyEvent', {
            type: 'keyUp', modifiers: 0, key: 'Control', code: 'ControlLeft',
            windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17,
          });
        }
        return;
      } catch {
        /* fall back below */
      }
    }

    const keyName: Record<string, string> = {
      control: 'Control',
      ctrl: 'Control',
      alt: 'Alt',
      shift: 'Shift',
      meta: 'Meta',
      command: 'Meta',
    };
    const modKeys = modifiers.map((m) => keyName[m.toLowerCase()]).filter(Boolean);
    for (const mod of modKeys) wc.sendInputEvent({ type: 'keyDown', keyCode: mod });
    wc.sendInputEvent({ type: 'keyDown', keyCode: key });
    wc.sendInputEvent({ type: 'keyUp', keyCode: key });
    for (const mod of [...modKeys].reverse()) wc.sendInputEvent({ type: 'keyUp', keyCode: mod });
  }

  focusConsole(): boolean {
    if (this.consoleWin && !this.consoleWin.isDestroyed()) {
      this.consoleWin.show();
      this.consoleWin.focus();
      return true;
    }
    return false;
  }

  async openMediaPanel(): Promise<{ ok: boolean; label?: string }> {
    const res = await this.run<any>(openMediaPanelScript(), 6000);
    return { ok: Boolean(res?.ok), label: res?.label };
  }

  ensureWebView(): WebContentsView {
    if (!this.webView || this.webView.webContents.isDestroyed()) {
      this.webView = new WebContentsView({
        webPreferences: {
          partition: 'persist:kvm',
          preload: path.join(__dirname, '../preload/session.js'),
          nodeIntegrationInSubFrames: true,
          contextIsolation: true,
          sandbox: false,
          nodeIntegration: false,
          backgroundThrottling: false,
        },
      });
      try {
        this.webView.setBackgroundColor('#05070b');
        this.hookFrameShortcuts(this.webView.webContents);
        try { this.webView.setBorderRadius(12); } catch { /* older Electron */ }
        this.webView.webContents.setAudioMuted(true);
        this.webView.webContents.setZoomFactor(1);
      } catch {
        /* ignore */
      }
      void this.loadWebHome();
    }
    return this.webView;
  }

  async loadWebHome(): Promise<void> {
    if (!this.webView) return;
    try {
      if (this.device.vendor === 'dell') {
        const current = this.view.webContents.getURL();
        const m = /^(https?:\/\/[^/]+)\/restgui\/index\.html\?[^#]+/.exec(current);
        if (m) {
          await this.webView.webContents.loadURL(`${m[0]}#/`);
          return;
        }
      }
      await this.webView.webContents.loadURL(this.baseUrl());
    } catch {
      /* keep whatever the BMC returned */
    }
    await this.attemptWebLogin();
    await this.dismissWebWarnings();
    await this.decorateWebFrame();
  }

  private async decorateWebFrame(): Promise<void> {
    if (!this.webView || this.webView.webContents.isDestroyed()) return;
    const wc = this.webView.webContents;
    try {
      await wc.insertCSS(`
        #__kvm_frame_border {
          position: fixed; inset: 0; border-radius: 12px; pointer-events: none;
          box-shadow: inset 0 0 0 1px rgba(128, 136, 145, 0.55);
          z-index: 2147483647;
        }
      `);
      await wc.executeJavaScript(
        `(() => {
          let el = document.getElementById('__kvm_frame_border');
          if (!el) {
            el = document.createElement('div');
            el.id = '__kvm_frame_border';
            (document.body || document.documentElement).appendChild(el);
          }
          return true;
        })()`,
        true,
      );
    } catch {
      /* ignore */
    }
  }

  private webLoginBusy = false;

  private async dismissWebWarnings(): Promise<void> {
    if (!this.webView || this.webView.webContents.isDestroyed()) return;
    const wc = this.webView.webContents;
    const script = `(() => {
      const vis = (e) => {
        const r = e.getBoundingClientRect();
        const s = getComputedStyle(e);
        return r.width > 4 && r.height > 4 && s.display !== 'none' && s.visibility !== 'hidden';
      };
      const warn = /default password|initial password|password.{0,30}(default|initial)|change.{0,20}password|默认密码|初始密码|出厂密码|首次登录|修改密码/i;
      const boxes = [...document.querySelectorAll(
        '[role="dialog"], .modal, .modal-dialog, .ui-dialog, .ti3-modal, .ant-modal, .swal2-popup, .dialog, .modal-content'
      )].filter(vis);
      for (const box of boxes) {
        if (!warn.test(box.innerText || '')) continue;
        const buttons = [...box.querySelectorAll('button, a, [role="button"], .ti3-btn-primary, .btn-primary, input[type=button]')].filter(vis);
        const ok = buttons.find((b) => /^(ok|确定|知道了|我已知晓|关闭|继续|i understand|continue|got it)/i.test((b.innerText || b.value || '').trim()));
        if (ok) { ok.click(); return 'clicked:' + (ok.innerText || ok.value || '').trim(); }
      }
      // Warning banner without a dialog container.
      const nodes = [...document.querySelectorAll('body *')].filter(vis);
      for (const n of nodes) {
        if (!warn.test((n.innerText || '').trim())) continue;
        let p = n;
        for (let depth = 0; depth < 6 && p; depth++, p = p.parentElement) {
          const buttons = [...p.querySelectorAll('button, a, [role="button"], .ti3-btn-primary, .btn-primary')].filter(vis);
          const ok = buttons.find((b) => /^(ok|确定|知道了|我已知晓|关闭|继续|i understand|continue|got it)/i.test((b.innerText || b.value || '').trim()));
          if (ok) { ok.click(); return 'banner:' + (ok.innerText || '').trim(); }
        }
      }
      return null;
    })()`;
    for (let i = 0; i < 16; i++) {
      try {
        const done = await wc.executeJavaScript(script, true);
        if (done) return;
      } catch {
        return;
      }
      await sleep(700);
    }
  }

  private async attemptWebLogin(): Promise<void> {
    // Huawei/xFusion share the KVM login cookie, so their web view is already
    // authenticated. Only iDRAC needs an explicit form login.
    if (!this.webView || this.webLoginBusy) return;
    this.webLoginBusy = true;
    const wc = this.webView.webContents;
    const user = this.device.username || '';
    const pass = this.password || '';
    try {
      if (!user || !pass) return;
      let kickedSessions = false;
      const dbg = wc.debugger;
      try {
        if (!dbg.isAttached()) dbg.attach('1.3');
      } catch {
        return;
      }
      await sleep(300);
      for (let attempt = 0; attempt < 20; attempt++) {
        const ready = await wc
          .executeJavaScript(
            `(() => {
              const u = document.querySelector('#account, input[name="username"], #username');
              const p = document.querySelector('#loginPwd, input[name="password"], #password');
              const vis = (e) => e && e.getBoundingClientRect().width > 4;
              return Boolean(vis(u) && vis(p));
            })()`,
            true,
          )
          .catch(() => false);
        if (!ready) {
          await sleep(350);
          continue;
        }
        const doc = await dbg.sendCommand('DOM.getDocument', { depth: -1, pierce: true });
        const find = async (selectors: string[]) => {
          for (const sel of selectors) {
            const res = await dbg
              .sendCommand('DOM.querySelector', { nodeId: doc.root.nodeId, selector: sel })
              .catch(() => null);
            if (res?.nodeId) return res.nodeId;
          }
          return 0;
        };
        const u = await find(['#account', 'input[name="username"]', '#username', 'input[name="user"]']);
        const p = await find(['#loginPwd', 'input[name="password"]', '#password', 'input[type="password"]']);
        if (!u || !p) {
          await sleep(700);
          continue;
        }
        const typeInto = async (nodeId: number, text: string) => {
          text = text.trim();
          await dbg.sendCommand('DOM.focus', { nodeId });
          try {
            const ok = await wc.executeJavaScript(
              `(() => {
                const el = document.activeElement;
                if (!el || !('value' in el)) return false;
                const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
                if (!setter) return false;
                setter.call(el, ${JSON.stringify(text)});
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                return el.value === ${JSON.stringify(text)};
              })()`,
              true,
            );
            if (ok) return;
          } catch {
            /* fall through to synthetic typing */
          }
          await dbg.sendCommand('Input.insertText', { text });
        };
        await typeInto(u, user);
        await typeInto(p, pass);
        await sleep(250);
        const btn = await wc
          .executeJavaScript(
            `(() => {
              const nodes = [...document.querySelectorAll('button,#btLogin,input[type=submit],[role=button]')];
              const b = nodes.find((x) => /log\s*in|登录/i.test(((x.innerText || x.value || '') + '').trim()));
              if (!b) return null;
              const r = b.getBoundingClientRect();
              if (r.width < 4) return null;
              return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
            })()`,
            true,
          )
          .catch(() => null);
        if (btn) {
          await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: btn.x, y: btn.y, button: 'left', clickCount: 1 });
          await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: btn.x, y: btn.y, button: 'left', clickCount: 1 });
        } else {
          await dbg.sendCommand('Input.dispatchKeyEvent', {
            type: 'keyDown', key: 'Enter', code: 'Enter',
            windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r',
          });
          await dbg.sendCommand('Input.dispatchKeyEvent', {
            type: 'keyUp', key: 'Enter', code: 'Enter',
            windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
          });
        }
        await sleep(3000);
        if (!kickedSessions) {
          const body = await wc.executeJavaScript('document.body.innerText', true).catch(() => '');
          if (/RAC0218|maximum number of user sessions/i.test(body || '')) {
            kickedSessions = true;
            try {
              const origin = `${this.device.scheme}://${this.device.host}:${this.device.port}`;
              const client = new RedfishClient(origin, this.device.username, this.password);
              const col = await client.getJson('/redfish/v1/SessionService/Sessions');
              for (const member of col?.Members ?? []) {
                const path = member?.['@odata.id'];
                if (path) await client.raw('DELETE', path);
              }
            } catch {
              /* best effort */
            }
            await sleep(1500);
            continue;
          }
        }
        const still = await wc
          .executeJavaScript(`Boolean(document.querySelector('input[type="password"]'))`, true)
          .catch(() => false);
        if (!still) return;
      }
    } catch {
      /* login is best effort */
    } finally {
      this.webLoginBusy = false;
    }
  }

  toggleWeb(): { view: WebContentsView; open: boolean; created: boolean } {
    const created = !this.webView;
    const view = this.ensureWebView();
    this.webOpen = !this.webOpen;
    this.lastWebOpen = !this.webOpen;
    if (this.lastBounds) view.setBounds(this.lastBounds);
    if (this.webOpen) void this.dismissWebWarnings();
    return { view, open: this.webOpen, created };
  }

  snapshot(): SessionSnapshot {
    return {
      id: this.id,
      name: this.device.name || this.device.host,
      vendor: this.device.vendor,
      model: this.device.model,
      host: this.device.host,
      state: this.state,
      detail: this.detail,
      serial: this.device.serial,
      license: this.device.license,
      external: !!this.consoleWin,
      canvas: this.canvas,
      webOpen: this.webOpen,
    };
  }

  private async captureDebugShots(): Promise<void> {
    try {
      const dir = path.join(app.getPath('userData'), 'debug-shots');
      fs.mkdirSync(dir, { recursive: true });
      for (let i = 0; i < 12; i += 1) {
        await sleep(800);
        if (this.disposed) return;
        const img = await this.view.webContents.capturePage().catch(() => null);
        if (img && !img.isEmpty()) {
          fs.writeFileSync(path.join(dir, `${this.id}-${String(i).padStart(2, '0')}.png`), img.toPNG());
        }
      }
      debugSession({ event: 'debug-shots-done', id: this.id });
    } catch {
      /* ignore */
    }
  }

  private safeUrl(): string {
    try {
      const u = new URL(this.view.webContents.getURL());
      return `${u.origin}${u.pathname}`;
    } catch {
      return '';
    }
  }

  async capture(): Promise<Buffer | null> {
    if (this.disposed) return null;
    try {
      const img = await this.view.webContents.capturePage();
      return img.isEmpty() ? null : img.toPNG();
    } catch {
      return null;
    }
  }

  /** Navigate away so the BMC sees the console close and frees the KVM slot. */
  async releaseKvm(): Promise<void> {
    const wc = this.view.webContents;
    if (wc.isDestroyed()) return;
    try {
      await Promise.race([wc.loadURL('about:blank'), sleep(800)]);
    } catch {
      /* ignore */
    }
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.downloadHandler) {
      try { this.view.webContents.session.off('will-download', this.downloadHandler); } catch { /* ignore */ }
      this.downloadHandler = undefined;
    }
    this.stopHealth();
    if (this.manualTimer) clearInterval(this.manualTimer);
    this.manualTimer = undefined;
    try {
      this.consoleWin?.close();
    } catch {
      /* ignore */
    }
    const views = [this.view, this.webView].filter(Boolean) as WebContentsView[];
    this.webView = null;
    let closed = false;
    const finish = () => {
      if (closed) return;
      closed = true;
      for (const v of views) {
        try {
          this.win.contentView.removeChildView(v);
        } catch {
          /* ignore */
        }
        try {
          if (!v.webContents.isDestroyed()) v.webContents.close();
        } catch {
          /* ignore */
        }
      }
    };
    if (views.every((v) => v.webContents.isDestroyed())) {
      finish();
      return;
    }
    for (const v of views) {
      if (v.webContents.isDestroyed()) continue;
      v.webContents.loadURL('about:blank').catch(() => undefined);
    }
    setTimeout(finish, 200);
    setTimeout(finish, 1200);
  }
}
