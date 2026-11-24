import type { Device } from './types';
import { RedfishClient, type RedfishCollection } from './redfish';

export interface SessionCleanup {
  ok: boolean;
  removed: number;
  message: string;
}

/**
 * iDRAC only allows a handful of concurrent web sessions. When they are all
 * taken (often by our own crashed tabs, or a colleague's browser), the login
 * page refuses to work. Redfish Basic auth does not consume a GUI session, so
 * we can list and delete them even in that state — the equivalent of
 * `racadm closessn -a`.
 */
export async function clearDellSessions(device: Device, password: string): Promise<SessionCleanup> {
  const origin = `${device.scheme}://${device.host}:${device.port}`;
  const client = new RedfishClient(origin, device.username, password);
  try {
    const collection = await client.getJson<RedfishCollection>('/redfish/v1/SessionService/Sessions');
    let removed = 0;
    for (const member of collection?.Members ?? []) {
      const id = member?.['@odata.id'];
      if (typeof id !== 'string') continue;
      const res = await client.raw('DELETE', id);
      if (res.status >= 200 && res.status < 300) removed++;
    }
    return {
      ok: true,
      removed,
      message: removed ? `已清理 ${removed} 个 iDRAC 会话` : '没有可清理的 iDRAC 会话',
    };
  } catch (err) {
    return {
      ok: false,
      removed: 0,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
