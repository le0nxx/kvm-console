import type { BaseWindow } from 'electron';
import type { Store } from './store';
import { KvmSession } from './session';
import type { VncBridge } from './vnc';
import type { Device } from './types';

/**
 * Tabs = sessions for devices with `open === true`. History entries that are
 * not open have no WebContentsView at all, which keeps memory flat when the
 * technician has connected to dozens of short-lived BMC IPs over time.
 */
export class SessionManager {
  private sessions = new Map<string, KvmSession>();

  constructor(
    private win: BaseWindow,
    private store: Store,
    private onUpdate: () => void,
    private onCreated: (session: KvmSession) => void,
    private onMeta?: (id: string, patch: { vnc?: Device['vnc']; model?: string; serial?: string }) => void,
    private vnc?: VncBridge,
    private onOffline?: (device: Device) => void,
    private onDownload?: (id: string, event: import('./types').DownloadEvent) => void,
    private onShortcutInput?: (input: { control: boolean; shift: boolean; alt: boolean; meta: boolean; key: string; code?: string }) => void,
  ) {}

  syncOpen(): void {
    const desired = this.openDevices();
    const ids = new Set(desired.map((d) => d.id));
    for (const [id, session] of this.sessions) {
      if (!ids.has(id)) {
        session.destroy();
        this.sessions.delete(id);
      }
    }
    for (const device of desired) {
      if (this.sessions.has(device.id)) continue;
      const session = new KvmSession(
        this.win,
        device,
        this.store.passwordOf(device.id),
        {
          onUpdate: () => this.onUpdate(),
          onMeta: (id, patch) => this.onMeta?.(id, patch),
          onOffline: (device) => this.onOffline?.(device),
          onDownload: (id, event) => this.onDownload?.(id, event),
          onShortcutInput: (input) => this.onShortcutInput?.(input),
        },
        this.vnc,
      );
      this.sessions.set(device.id, session);
      this.onCreated(session);
    }
  }

  private openDevices() {
    return this.store.list().filter((d) => d.open);
  }

  get(id: string): KvmSession | undefined {
    return this.sessions.get(id);
  }

  list(): KvmSession[] {
    return [...this.sessions.values()];
  }

  /** sessions in inventory order (tile/tab order) */
  order(): KvmSession[] {
    return this.openDevices()
      .map((d) => this.sessions.get(d.id))
      .filter((s): s is KvmSession => !!s);
  }

  /** open a tab and start connecting */
  connect(id: string): KvmSession | undefined {
    this.store.setOpen(id, true);
    this.store.touch(id);
    this.syncOpen();
    const session = this.sessions.get(id);
    if (session) void session.start();
    return session;
  }

  close(id: string): void {
    const session = this.sessions.get(id);
    this.sessions.delete(id);
    session?.destroy();
    this.store.setOpen(id, false);
  }

  restart(id: string): void {
    this.close(id);
    this.store.setOpen(id, true);
    this.syncOpen();
    const fresh = this.sessions.get(id);
    if (fresh) void fresh.start();
  }

  async prewarmOpen(concurrency = 3): Promise<void> {
    const queue = this.order();
    const workers = Array.from({ length: Math.min(Math.max(1, concurrency), queue.length) }, async () => {
      for (;;) {
        const next = queue.shift();
        if (!next) return;
        await next.start();
      }
    });
    await Promise.all(workers);
  }

  async reconnectAll(): Promise<void> {
    await Promise.all(this.list().map((s) => s.start()));
  }

  /** Ask every console to close so the BMC frees its KVM slot. */
  async releaseAll(): Promise<void> {
    await Promise.all(this.list().map((s) => s.releaseKvm()));
  }

  destroyAll(): void {
    for (const session of this.sessions.values()) session.destroy();
    this.sessions.clear();
  }
}
