import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

export class RedfishError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'RedfishError';
  }
}

export interface VirtualMediaSlot {
  path: string;
  id: string;
  name: string;
  mediaTypes: string[];
  inserted: boolean;
  image: string | null;
}

export interface RedfishTargets {
  manager: string;
  system?: string;
  slots: VirtualMediaSlot[];
}

/** Common collection envelope returned by Redfish. */
export interface RedfishCollection {
  Members?: Array<Record<string, unknown>>;
}

/** Error payload shared by Redfish services (Dell and Huawei shapes). */
export interface RedfishErrorBody {
  error?: { message?: string; '@Message.ExtendedInfo'?: Array<{ Message?: string }> };
  '@Message.ExtendedInfo'?: Array<{ Message?: string }>;
}

interface RawResponse {
  status: number;
  text: string;
  json: unknown;
}

function request(
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: string,
  timeoutMs = 12000,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'http:' ? 80 : 443),
        path: `${u.pathname}${u.search}`,
        method,
        headers,
        rejectUnauthorized: false,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c as Buffer));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: unknown = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode ?? 0, text, json });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error(`请求超时（${timeoutMs}ms）`)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

export class RedfishClient {
  private base: string;
  private auth: string;

  constructor(
    origin: string,
    username: string,
    password: string,
  ) {
    this.base = origin.replace(/\/+$/, '');
    this.auth = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  }

  private async call(
    path: string,
    method = 'GET',
    body?: unknown,
    extra: Record<string, string> = {},
  ): Promise<RawResponse> {
    const headers: Record<string, string> = {
      Authorization: this.auth,
      Accept: 'application/json',
      'OData-Version': '4.0',
    };
    let payload: string | undefined;
    if (body !== undefined) {
      payload = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(payload));
    }
    Object.assign(headers, extra);
    return request(`${this.base}${path}`, method, headers, payload);
  }

  async getJson<T = Record<string, unknown>>(path: string): Promise<T> {
    const res = await this.call(path);
    if (res.status === 401) throw new RedfishError('Redfish 认证失败（用户名或密码错误）', 401);
    if (res.status === 404) throw new RedfishError(`Redfish 资源不存在：${path}`, 404);
    if (res.status >= 400) throw new RedfishError(`Redfish 请求失败 HTTP ${res.status}：${path}`, res.status);
    if (!res.json) throw new RedfishError(`Redfish 返回非 JSON：${path}`);
    return res.json as T;
  }

  async raw(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<RawResponse> {
    return this.call(path, method, body, headers);
  }

  async available(): Promise<boolean> {
    try {
      const res = await this.call('/redfish/v1');
      return res.status === 200;
    } catch {
      return false;
    }
  }

  async discover(): Promise<RedfishTargets> {
    const root = await this.getJson<{ RedfishVersion?: string }>('/redfish/v1');
    if (!root || !root.RedfishVersion) {
      throw new RedfishError('该设备未提供标准 Redfish 服务');
    }

    let managerPath: string | undefined;
    try {
      const managers = await this.getJson<RedfishCollection>('/redfish/v1/Managers');
      for (const m of managers?.Members ?? []) {
        const path = m?.['@odata.id'];
        if (typeof path === 'string') {
          managerPath = path;
          break;
        }
      }
    } catch {
      /* fall through to defaults */
    }
    if (!managerPath) managerPath = '/redfish/v1/Managers/1';

    let systemPath: string | undefined;
    try {
      const systems = await this.getJson<RedfishCollection>('/redfish/v1/Systems');
      const first = systems?.Members?.[0]?.['@odata.id'];
      if (typeof first === 'string') systemPath = first;
    } catch {
      systemPath = undefined;
    }

    const slots = await this.listVirtualMedia(managerPath);
    return { manager: managerPath, system: systemPath, slots };
  }

  private async listVirtualMedia(managerPath: string): Promise<VirtualMediaSlot[]> {
    const candidates: string[] = [];
    try {
      const collection = await this.getJson<RedfishCollection>(`${managerPath}/VirtualMedia`);
      for (const m of collection?.Members ?? []) {
        const path = m?.['@odata.id'];
        if (typeof path === 'string') candidates.push(path);
      }
    } catch {
      /* some BMCs only expose fixed slots */
    }
    for (const fallback of ['/CD', '/DVD', '/2', '/1']) {
      if (candidates.length === 0) candidates.push(`${managerPath}/VirtualMedia${fallback}`);
    }

    const slots: VirtualMediaSlot[] = [];
    for (const path of candidates) {
      try {
        const vm = await this.getJson(path);
        if (!vm) continue;
        slots.push({
          path,
          id: String(vm.Id ?? path.split('/').pop()),
          name: String(vm.Name ?? 'Virtual Media'),
          mediaTypes: Array.isArray(vm.MediaTypes) ? vm.MediaTypes.map(String) : [],
          inserted: Boolean(vm.Inserted),
          image: vm.Image ? String(vm.Image) : null,
        });
      } catch {
        /* ignore unavailable slot */
      }
    }
    return slots;
  }

  pickCdSlot(targets: RedfishTargets): VirtualMediaSlot | undefined {
    const score = (s: VirtualMediaSlot): number => {
      const text = `${s.id} ${s.name} ${s.mediaTypes.join(' ')}`.toLowerCase();
      let n = 0;
      if (/cd|dvd/.test(text)) n += 4;
      if (s.mediaTypes.some((t) => /cd|dvd/i.test(t))) n += 2;
      if (s.inserted) n += 1;
      return n;
    };
    const sorted = [...targets.slots].sort((a, b) => score(b) - score(a));
    return sorted[0];
  }

  private async vmmTarget(slot: VirtualMediaSlot): Promise<string | undefined> {
    try {
      const detail = await this.getJson<{ Oem?: Record<string, Record<string, unknown>> }>(slot.path);
      for (const oem of Object.values(detail?.Oem ?? {})) {
        const actions = (oem?.Actions ?? {}) as Record<string, { target?: string }>;
        const target =
          actions['#VirtualMedia.VmmControl']?.target ?? actions['#VirtualMedia.InsertMedia']?.target;
        if (target) return String(target);
      }
    } catch {
      /* ignore */
    }
    return undefined;
  }

  async insertMedia(slot: VirtualMediaSlot, imageUrl: string): Promise<void> {
    const res = await this.call(`${slot.path}/Actions/VirtualMedia.InsertMedia`, 'POST', {
      Image: imageUrl,
      Inserted: true,
      WriteProtected: true,
    });
    if (res.status === 401) throw new RedfishError('Redfish 认证失败（用户名或密码错误）', 401);
    if (res.status < 400) return;

    // Huawei/xFusion iBMC uses an OEM VmmControl action instead.
    const target = await this.vmmTarget(slot);
    if (target) {
      // Clear any stale connection first, otherwise the BMC reports
      // "virtual media has been connected before".
      await this.call(target, 'POST', { VmmControlType: 'Disconnect' }).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 1200));
      const oem = await this.call(target, 'POST', { VmmControlType: 'Connect', Image: imageUrl });
      if (oem.status >= 400) {
        throw new RedfishError(
          `挂载失败 HTTP ${oem.status}${oem.text ? `：${oem.text.slice(0, 200)}` : ''}`,
          oem.status,
        );
      }
      const taskPath = (oem.json as Record<string, unknown> | null)?.['@odata.id'];
      if (typeof taskPath === 'string') {
        for (let i = 0; i < 8; i++) {
          await new Promise((r) => setTimeout(r, 700));
          const task = await this.getJson<{
            TaskState?: string;
            Messages?: { Message?: string } | Array<{ Message?: string }>;
          }>(taskPath).catch(() => null);
          if (!task) break;
          if (task.TaskState === 'Exception') {
            const messages = task.Messages ?? {};
            const msg = (Array.isArray(messages) ? messages[0]?.Message : messages.Message) ??
              'BMC 未接受虚拟介质连接';
            throw new RedfishError(`挂载失败：${msg}`, 400);
          }
          if (task.TaskState === 'Completed') break;
        }
      }
      return;
    }
    throw new RedfishError(
      `挂载失败 HTTP ${res.status}${res.text ? `：${res.text.slice(0, 160)}` : ''}`,
      res.status,
    );
  }

  async ejectMedia(slot: VirtualMediaSlot): Promise<void> {
    const res = await this.call(`${slot.path}/Actions/VirtualMedia.EjectMedia`, 'POST', {});
    if (res.status < 400 || res.status === 404) return;
    const target = await this.vmmTarget(slot);
    if (target) {
      const oem = await this.call(target, 'POST', { VmmControlType: 'Disconnect' });
      if (oem.status < 400) return;
    }
    throw new RedfishError(`卸载失败 HTTP ${res.status}`, res.status);
  }

  async bootOnce(systemPath: string, device: 'Cd' | 'Pxe' | 'Hdd' = 'Cd'): Promise<void> {
    let lastStatus = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const sys = await this.getJson(systemPath);
        const etag = sys?.['@odata.etag'];
        const res = await this.call(
          systemPath,
          'PATCH',
          { Boot: { BootSourceOverrideTarget: device, BootSourceOverrideEnabled: 'Once' } },
          etag ? { 'If-Match': String(etag) } : undefined,
        );
        if (res.status === 412) {
          lastStatus = 412;
          await new Promise((r) => setTimeout(r, 1200));
          continue;
        }
        if (res.status >= 400) {
          throw new RedfishError(`设置启动项失败 HTTP ${res.status}`, res.status);
        }
        return;
      } catch (err) {
        if (err instanceof RedfishError) throw err;
        lastStatus = 0;
      }
    }
    throw new RedfishError(`设置启动项失败 HTTP ${lastStatus || 412}`, lastStatus || 412);
  }

  async resetSystem(systemPath: string, resetType: string): Promise<void> {
    const res = await this.call(`${systemPath}/Actions/ComputerSystem.Reset`, 'POST', {
      ResetType: resetType,
    });
    if (res.status >= 400) {
      throw new RedfishError(`电源操作失败 HTTP ${res.status}`, res.status);
    }
  }

  async status(slot: VirtualMediaSlot): Promise<{ inserted: boolean; image: string | null }> {
    const vm = await this.getJson(slot.path);
    return { inserted: Boolean(vm?.Inserted), image: vm?.Image ? String(vm.Image) : null };
  }
}
