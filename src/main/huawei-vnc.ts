import net from 'node:net';
import type { Device } from './types';
import { RedfishClient } from './redfish';

export interface VncEnableResult {
  ok: boolean;
  port: number;
  message: string;
}

function canConnect(host: string, port: number, timeoutMs = 2500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.on('connect', () => done(true));
    socket.on('error', () => done(false));
  });
}

/** Huawei/xFusion iBMC exposes an OEM VNC service; enable it and probe the port. */
export async function ensureHuaweiVnc(
  device: Device,
  password: string,
  vncPassword: string,
): Promise<VncEnableResult> {
  const origin = `${device.scheme}://${device.host}:${device.port}`;
  const client = new RedfishClient(origin, device.username, password);
  const path = '/redfish/v1/Managers/1/VncService';
  try {
    const svc = await client.getJson(path);
    const etag = svc?.['@odata.etag'];
    const res = await client.raw(
      'PATCH',
      path,
      { Password: vncPassword, SSLEncryptionEnabled: false },
      etag ? { 'If-Match': String(etag) } : undefined,
    );
    if (res.status >= 400) {
      const msg =
        res.json?.error?.['@Message.ExtendedInfo']?.[0]?.Message ??
        res.json?.['@Message.ExtendedInfo']?.[0]?.Message ??
        `HTTP ${res.status}`;
      return { ok: false, port: 5900, message: msg };
    }
  } catch (err) {
    return {
      ok: false,
      port: 5900,
      message: err instanceof Error ? err.message : String(err),
    };
  }
  for (const port of [5900, 5901, 5902, 5903]) {
    if (await canConnect(device.host, port)) {
      return { ok: true, port, message: '已启用 VNC' };
    }
  }
  return {
    ok: false,
    port: 5900,
    message: 'VNC 服务未开放端口（当前 iBMC 固件可能不支持 VNC）',
  };
}
