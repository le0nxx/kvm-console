import http from 'node:http';
import type { Device } from './types';
import { MediaServer } from './media';
import { RedfishClient, RedfishError, type VirtualMediaSlot } from './redfish';

function originOf(device: Device): string {
  return `${device.scheme}://${device.host}:${device.port}`;
}

export interface MountResult {
  ok: boolean;
  message: string;
  image?: string;
  slot?: string;
  bootOnce?: boolean;
}

/**
 * Redfish-first virtual media. The ISO is served by a local Range-capable
 * HTTP server and the BMC is told to fetch it; no upload through the browser.
 */
export class MediaService {
  private server = new MediaServer();
  private slots = new Map<string, VirtualMediaSlot>();
  private tokens = new Map<string, string>();
  private mountedAt = new Map<string, number>();
  status: Record<
    string,
    { inserted: boolean; image: string | null; name?: string; size?: number; bytes?: number; speed?: number }
  > = {};
  last?: { deviceId: string; url: string; local: string };

  async mount(device: Device, password: string, file: string, bootOnce: boolean): Promise<MountResult> {
    const port = await this.server.start();
    const token = this.server.publish(file);
    const ip = MediaServer.bindIpFor(device.host);
    const url = this.server.urlFor(token, ip);
    this.last = { deviceId: device.id, url, local: file };

    const client = new RedfishClient(originOf(device), device.username, password);
    try {
      const targets = await client.discover();
      const slot = client.pickCdSlot(targets);
      if (!slot) {
        throw new Error('该设备没有可用的虚拟光驱（可能缺少许可证或固件不支持 Redfish 虚拟介质）');
      }
      if (slot.inserted) {
        try {
          await client.ejectMedia(slot);
        } catch {
          /* ignore and insert anyway */
        }
      }
      await client.insertMedia(slot, url);
      if (bootOnce && targets.system) {
        // iDRAC can answer 412 while the previous override settles.
        let lastErr: unknown;
        for (let i = 0; i < 3; i++) {
          try {
            await client.bootOnce(targets.system, 'Cd');
            lastErr = undefined;
            break;
          } catch (err) {
            lastErr = err;
            const status = (err as { status?: number }).status;
            if (status === 412 && i < 2) {
              await new Promise((r) => setTimeout(r, 1500));
              continue;
            }
            throw err;
          }
        }
        if (lastErr) throw lastErr;
      }

      this.slots.set(device.id, slot);
      this.tokens.set(device.id, token);
      this.mountedAt.set(device.id, Date.now());
      const stats = this.server.stats(token);
      this.status[device.id] = {
        inserted: true,
        image: url,
        name: stats?.name,
        size: stats?.size,
        bytes: stats?.bytes ?? 0,
        speed: stats?.speed ?? 0,
      };
      return {
        ok: true,
        message: `已挂载 ${file.split('/').pop()}（${ip}:${port}）${bootOnce ? '，并设置下次从光驱启动' : ''}`,
        image: url,
        slot: slot.path,
        bootOnce,
      };
    } catch (err) {
      this.server.revoke(token);
      const message =
        err instanceof RedfishError || err instanceof Error ? err.message : String(err);
      return { ok: false, message: `Redfish 挂载失败：${message}` };
    }
  }

  async eject(device: Device, password: string): Promise<MountResult> {
    const client = new RedfishClient(originOf(device), device.username, password);
    try {
      let slot = this.slots.get(device.id);
      if (!slot) {
        const targets = await client.discover();
        slot = client.pickCdSlot(targets);
      }
      if (!slot) return { ok: false, message: '未找到虚拟光驱' };
      await client.ejectMedia(slot);
      const token = this.tokens.get(device.id);
      if (token) {
        this.server.revoke(token);
        this.tokens.delete(device.id);
      }
      this.mountedAt.delete(device.id);
      this.status[device.id] = { inserted: false, image: null };
      return { ok: true, message: '已卸载' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, message: `卸载失败：${message}` };
    }
  }

  async refresh(device: Device, password: string): Promise<{ inserted: boolean; image: string | null }> {
    const token = this.tokens.get(device.id);
    const stats = token ? this.server.stats(token) : null;
    const mountedAt = this.mountedAt.get(device.id) ?? 0;
    try {
      const client = new RedfishClient(originOf(device), device.username, password);
      const targets = await client.discover();
      const slot = client.pickCdSlot(targets);
      if (!slot) return { inserted: false, image: null };
      this.slots.set(device.id, slot);
      // BMCs often report Inserted=false right after mount, and some OEM
      // implementations never set it. Keep our mount sticky for a while.
      const ours =
        !!token &&
        (slot.inserted ||
          Boolean(slot.image) ||
          (stats?.bytes ?? 0) > 0 ||
          Date.now() - mountedAt < 120000);
      this.status[device.id] = {
        inserted: ours,
        image: ours ? slot.image ?? this.status[device.id]?.image ?? null : slot.image,
        name: stats?.name,
        size: stats?.size,
        bytes: stats?.bytes ?? 0,
        speed: stats?.speed ?? 0,
      };
      return { inserted: ours, image: this.status[device.id].image };
    } catch {
      return this.status[device.id] ?? { inserted: false, image: null };
    }
  }

  /** used by the smoke test: verify Range support on the media server */
  async checkRange(url: string): Promise<{ status: number; contentRange?: string }> {
    return new Promise((resolve) => {
      const req = http.request(url, { method: 'GET', headers: { Range: 'bytes=0-1023' } }, (res) => {
        res.resume();
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, contentRange: res.headers['content-range'] as string }),
        );
      });
      req.on('error', () => resolve({ status: 0 }));
      req.end();
    });
  }

  stop(): void {
    this.server.stop();
  }
}
