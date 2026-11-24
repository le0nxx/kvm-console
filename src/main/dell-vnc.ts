import type { Device } from './types';
import { RedfishClient, type RedfishCollection, type RedfishErrorBody } from './redfish';

export interface VncEnableResult {
  ok: boolean;
  port: number;
  message: string;
}

/**
 * iDRAC9 has a built-in VNC server (Services -> VNC). Enabling it lets us run
 * the console through our own noVNC page, inside a normal tile.
 */
export async function ensureDellVnc(
  device: Device,
  password: string,
  vncPassword: string,
): Promise<VncEnableResult> {
  const origin = `${device.scheme}://${device.host}:${device.port}`;
  const client = new RedfishClient(origin, device.username, password);
  try {
    const managers = await client.getJson<RedfishCollection>('/redfish/v1/Managers');
    const firstManager = managers?.Members?.[0]?.['@odata.id'];
    const managerPath = typeof firstManager === 'string' ? firstManager : '/redfish/v1/Managers/iDRAC.Embedded.1';
    const attrs = await client.getJson<{ Attributes?: Record<string, unknown> }>(`${managerPath}/Attributes`);
    const a = attrs?.Attributes ?? {};
    const enabled = String(a['VNCServer.1.Enable'] ?? '') === 'Enabled';
    const port = Number(a['VNCServer.1.Port'] || 5901) || 5901;
    const res = await client.raw('PATCH', `${managerPath}/Attributes`, {
      Attributes: {
        'VNCServer.1.Enable': 'Enabled',
        'VNCServer.1.Port': port,
        'VNCServer.1.Password': vncPassword,
      },
    });
    if (res.status >= 400) {
      let message = `HTTP ${res.status}`;
      try {
        const body = res.json as RedfishErrorBody | null;
        message = body?.error?.['@Message.ExtendedInfo']?.[0]?.Message ?? message;
      } catch {
        /* ignore */
      }
      return { ok: false, port, message };
    }
    return { ok: true, port, message: enabled ? 'VNC 已就绪' : '已启用 VNC' };
  } catch (err) {
    return { ok: false, port: 5901, message: err instanceof Error ? err.message : String(err) };
  }
}
