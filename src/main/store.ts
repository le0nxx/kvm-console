import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Device, DeviceInput, PublicDevice, VendorId } from './types';

export interface VendorPreset {
  id: VendorId;
  label: string;
  defaults: Array<{ u: string; p: string }>;
  hint: string;
}

export const VENDORS: VendorPreset[] = [
  {
    id: 'huawei',
    label: '华为 / 超聚变 iBMC',
    defaults: [
      { u: 'Administrator', p: 'Admin@9000' },
      { u: 'admin', p: 'Admin@9000' },
    ],
    hint: '华为 iBMC 与超聚变 iBMC 同源，KVM 入口通常在“远程控制”下',
  },
  {
    id: 'dell',
    label: '戴尔 iDRAC',
    defaults: [{ u: 'root', p: 'calvin' }],
    hint: '虚拟控制台/虚拟介质需要 Enterprise 许可证',
  },
  {
    id: 'inspur',
    label: '浪潮 ISBMC',
    defaults: [
      { u: 'admin', p: 'admin' },
      { u: 'superuser', p: 'superuser' },
    ],
    hint: '型号与固件差异较大，必要时在设备里手填 KVM 地址',
  },
  {
    id: 'generic',
    label: '通用 / 其他',
    defaults: [],
    hint: '使用通用登录与入口识别，失败时可手动操作或填 KVM 地址',
  },
];

export function vendorLabel(id: VendorId): string {
  const normalized = id === 'xfusion' ? 'huawei' : id;
  return VENDORS.find((v) => v.id === normalized)?.label ?? id;
}

interface StoreFile {
  version: number;
  devices: Device[];
  migrations?: Record<string, boolean>;
}

const MAX_HISTORY = 80;

export class Store {
  private file: string;
  private data: StoreFile = { version: 2, devices: [] };
  private ephemeralDevices: Device[] = [];
  private inMemory: boolean;
  encryption: 'safe' | 'plain' = 'plain';

  constructor(inMemory = false) {
    this.inMemory = inMemory;
    this.file = path.join(app.getPath('userData'), 'connections.json');
    if (inMemory) return;
    this.load();
    this.migrate();
  }

  /** Legacy Dell records were switched to VNC by the old auto-fallback. Default them back to Web KVM once; VNC remains a manual choice. */
  private migrate(): void {
    if (this.data.migrations?.dellVncToWeb) return;
    let changed = false;
    for (const d of this.data.devices) {
      if (d.vendor === 'dell' && d.mode === 'vnc') {
        d.mode = 'web';
        changed = true;
      }
    }
    this.data.migrations = { ...this.data.migrations, dellVncToWeb: true };
    if (changed) this.persist();
    else if (this.data.devices.length) this.persist();
  }

  private load(): void {
    for (const candidate of ['connections.json', 'devices.json']) {
      try {
        const raw = fs.readFileSync(path.join(app.getPath('userData'), candidate), 'utf8');
        const parsed = JSON.parse(raw) as StoreFile;
        if (parsed && Array.isArray(parsed.devices)) {
          this.data = { version: 2, devices: parsed.devices };
          break;
        }
      } catch {
        /* try next */
      }
    }
  }

  private persist(): void {
    if (this.inMemory) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ version: 2, devices: this.data.devices, migrations: this.data.migrations }, null, 2), 'utf8');
  }

  private seal(plain: string): { secret: string; enc: 'safe' | 'plain' } {
    let usable = false;
    try {
      const backend =
        typeof (safeStorage as unknown as { getSelectedStorageBackend?: () => string })
          .getSelectedStorageBackend === 'function'
          ? (safeStorage as unknown as { getSelectedStorageBackend: () => string }).getSelectedStorageBackend()
          : 'unknown';
      usable = safeStorage.isEncryptionAvailable() && backend !== 'basic_text';
    } catch {
      usable = false;
    }
    if (usable) {
      this.encryption = 'safe';
      return { secret: safeStorage.encryptString(plain).toString('base64'), enc: 'safe' };
    }
    this.encryption = 'plain';
    return { secret: Buffer.from(plain, 'utf8').toString('base64'), enc: 'plain' };
  }

  private unseal(secret: string, enc: 'safe' | 'plain'): string {
    if (!secret) return '';
    try {
      const buf = Buffer.from(secret, 'base64');
      if (enc === 'safe' && safeStorage.isEncryptionAvailable()) return safeStorage.decryptString(buf);
      return buf.toString('utf8');
    } catch {
      return '';
    }
  }

  /** persisted history + transient connections */
  list(): Device[] {
    return [...this.data.devices, ...this.ephemeralDevices];
  }

  /** persisted history, newest first */
  history(): Device[] {
    return this.data.devices
      .slice()
      .sort((a, b) => (b.lastUsedAt ?? b.createdAt) - (a.lastUsedAt ?? a.createdAt));
  }

  get(id: string): Device | undefined {
    return this.list().find((d) => d.id === id);
  }

  passwordOf(id: string): string {
    const d = this.get(id);
    return d ? this.unseal(d.secret, d.enc) : '';
  }

  publicList(): PublicDevice[] {
    return this.list().map((d) => ({
      id: d.id,
      name: d.name,
      vendor: d.vendor,
      model: d.model,
      host: d.host,
      port: d.port,
      scheme: d.scheme,
      username: d.username,
      kvmUrl: d.kvmUrl,
      note: d.note,
      serial: d.serial,
      mode: d.mode,
      license: d.license,
      hasPassword: !!d.secret,
      createdAt: d.createdAt,
      lastUsedAt: d.lastUsedAt,
      useCount: d.useCount ?? 0,
      open: !!d.open,
      ephemeral: !!d.ephemeral,
    }));
  }

  findBySerial(serial: string | undefined): Device | undefined {
    const key = (serial || '').trim().toUpperCase();
    if (!key) return undefined;
    return this.list().find((d) => (d.serial || '').trim().toUpperCase() === key);
  }

  dedupeSerial(id: string): void {
    const keep = this.get(id);
    const key = (keep?.serial || '').trim().toUpperCase();
    if (!key) return;
    const before = this.data.devices.length;
    this.data.devices = this.data.devices.filter(
      (d) => d.id === id || (d.serial || '').trim().toUpperCase() !== key,
    );
    if (this.data.devices.length !== before) this.persist();
  }

  relocate(id: string, host: string, port?: number, scheme?: Device['scheme']): Device | undefined {
    const d = this.get(id);
    if (!d) return undefined;
    d.host = host.trim();
    if (port) d.port = port;
    if (scheme) d.scheme = scheme;
    d.lastUsedAt = Date.now();
    if (!d.ephemeral) this.persist();
    return d;
  }

  upsert(input: DeviceInput, persist = true): Device {
    let existing = input.id ? this.get(input.id) : undefined;
    if (!existing && input.serial) {
      const bySerial = this.findBySerial(input.serial);
      if (bySerial && !bySerial.ephemeral) existing = bySerial;
    }
    let secret = existing?.secret ?? '';
    let enc = existing?.enc ?? this.encryption;
    if (typeof input.password === 'string' && input.password.length > 0) {
      const sealed = this.seal(input.password);
      secret = sealed.secret;
      enc = sealed.enc;
    }
    const device: Device = {
      id: existing?.id ?? crypto.randomUUID(),
      name: input.name?.trim() || undefined,
      vendor: input.vendor,
      model: input.model?.trim() || undefined,
      host: input.host.trim(),
      port: input.port ?? 443,
      scheme: input.scheme ?? 'https',
      username: input.username.trim(),
      secret,
      enc,
      kvmUrl: input.kvmUrl?.trim() || undefined,
      note: input.note?.trim() || undefined,
      serial: input.serial?.trim() || existing?.serial,
      mode: input.mode ?? existing?.mode,
      vnc: existing?.vnc,
      createdAt: existing?.createdAt ?? Date.now(),
      lastUsedAt: existing?.lastUsedAt,
      useCount: existing?.useCount ?? 0,
      open: existing?.open ?? false,
      pinned: existing?.pinned,
      ephemeral: persist ? undefined : true,
    };

    if (!persist) {
      this.ephemeralDevices = this.ephemeralDevices.filter((d) => d.id !== device.id);
      this.ephemeralDevices.push(device);
      return device;
    }

    if (existing && !existing.ephemeral) {
      const i = this.data.devices.findIndex((d) => d.id === existing.id);
      this.data.devices[i] = device;
    } else {
      this.data.devices.push(device);
    }
    this.prune();
    this.persist();
    return device;
  }

  /** manual tab order */
  reorder(ids: string[]): void {
    if (!Array.isArray(ids) || !ids.length) return;
    const map = new Map(this.data.devices.map((d) => [d.id, d]));
    const ordered = ids.map((id) => map.get(id)).filter((d): d is Device => !!d);
    const rest = this.data.devices.filter((d) => !ids.includes(d.id));
    this.data.devices = [...ordered, ...rest];

    const ephMap = new Map(this.ephemeralDevices.map((d) => [d.id, d]));
    const ephOrdered = ids.map((id) => ephMap.get(id)).filter((d): d is Device => !!d);
    const ephRest = this.ephemeralDevices.filter((d) => !ids.includes(d.id));
    this.ephemeralDevices = [...ephOrdered, ...ephRest];
    this.persist();
  }

  /** connection used: bump recency */
  touch(id: string): void {
    const d = this.get(id);
    if (!d) return;
    d.lastUsedAt = Date.now();
    d.useCount = (d.useCount ?? 0) + 1;
    if (!d.ephemeral) this.persist();
  }

  updateMeta(
    id: string,
    patch: {
      serial?: string;
      model?: string;
      vendor?: Device['vendor'];
      license?: Device['license'];
      vnc?: Device['vnc'];
    },
  ): void {
    const d = this.get(id);
    if (!d) return;
    if (patch.serial !== undefined) d.serial = patch.serial;
    if (patch.vnc !== undefined) d.vnc = patch.vnc;
    if (patch.model !== undefined && patch.model) d.model = patch.model;
    if (patch.vendor) d.vendor = patch.vendor;
    if (patch.license !== undefined) d.license = patch.license;
    if (!d.ephemeral) this.persist();
  }

  resetLocal(id: string): void {
    const d = this.get(id);
    if (!d) return;
    d.secret = '';
    d.vnc = undefined;
    d.mode = undefined;
    d.open = false;
    d.license = undefined;
    if (!d.ephemeral) this.persist();
  }

  setOpen(id: string, open: boolean): void {
    const d = this.get(id);
    if (!d) return;
    d.open = open;
    if (!d.ephemeral) this.persist();
  }

  remove(id: string): void {
    this.ephemeralDevices = this.ephemeralDevices.filter((d) => d.id !== id);
    this.data.devices = this.data.devices.filter((d) => d.id !== id);
    this.persist();
  }

  /** keep the history bounded; never drop pinned or currently open entries */
  private prune(): void {
    if (this.data.devices.length <= MAX_HISTORY) return;
    const ordered = this.data.devices
      .slice()
      .sort((a, b) => (a.lastUsedAt ?? a.createdAt) - (b.lastUsedAt ?? b.createdAt));
    const removable = ordered.filter((d) => !d.pinned && !d.open);
    const excess = this.data.devices.length - MAX_HISTORY;
    const drop = new Set(removable.slice(0, excess).map((d) => d.id));
    if (drop.size) this.data.devices = this.data.devices.filter((d) => !drop.has(d.id));
  }

  seedPlain(
    items: Array<{
      name?: string;
      vendor: VendorId;
      model: string;
      host: string;
      port: number;
      scheme: 'http';
      username: string;
      password: string;
      open?: boolean;
    }>,
  ): void {
    this.data.devices = items.map((it) => ({
      id: crypto.randomUUID(),
      name: it.name,
      vendor: it.vendor,
      model: it.model,
      host: it.host,
      port: it.port,
      scheme: it.scheme,
      username: it.username,
      secret: Buffer.from(it.password, 'utf8').toString('base64'),
      enc: 'plain' as const,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      useCount: 1,
      open: it.open ?? false,
    }));
    this.encryption = 'plain';
    this.persist();
  }

  /** CSV: name,host,vendor,username,password[,model][,port] */
  importCsv(text: string): { added: number; errors: string[] } {
    const errors: string[] = [];
    let added = 0;
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    for (const [i, line] of lines.entries()) {
      if (/^name\s*,/i.test(line)) continue;
      const cols = line.split(',').map((c) => c.trim());
      if (cols.length < 5) {
        errors.push(`第 ${i + 1} 行：需要 name,host,vendor,username,password`);
        continue;
      }
      const [name, host, vendor, username, password, model, port] = cols;
      const known = VENDORS.some((v) => v.id === vendor);
      if (!known) errors.push(`第 ${i + 1} 行：未知厂商 ${vendor}`);
      this.upsert({
        name: name || undefined,
        host,
        vendor: (known ? vendor : 'generic') as VendorId,
        username,
        password,
        model: model || undefined,
        port: port ? Number(port) : 443,
      });
      added++;
    }
    return { added, errors };
  }
}
