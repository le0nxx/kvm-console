import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Device } from './types';
import { RedfishClient, type RedfishCollection, type RedfishErrorBody } from './redfish';

export interface LicenseCandidate {
  path: string;
  name: string;
  xml: string;
  schema: string;
  soldAt: number;
  evalDays?: number;
  transferable: boolean;
  label: string;
}

export interface LicenseResult {
  state: 'ok' | 'activated' | 'none' | 'failed';
  note: string;
}

/** where we look for Dell iDRAC license XML files */
export function licenseDirs(): string[] {
  const dirs: string[] = [];
  if (process.env.KVM_LICENSE_DIR) dirs.push(process.env.KVM_LICENSE_DIR);
  dirs.push(path.join(os.homedir(), 'Downloads', '戴尔', 'iDRAC_Trial_License-戴尔试用许可'));
  dirs.push(path.join(os.homedir(), '.config', 'kvm-console', 'licenses'));
  dirs.push(path.join(process.cwd(), 'licenses'));
  return [...new Set(dirs)].filter((dir) => {
    try {
      return fs.statSync(dir).isDirectory();
    } catch {
      return false;
    }
  });
}

function walk(dir: string, depth: number, out: string[]): void {
  if (depth < 0) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, depth - 1, out);
    else if (/\.xml$/i.test(entry.name)) out.push(full);
  }
}

export function parseLicense(file: string): LicenseCandidate | null {
  let xml: string;
  try {
    xml = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  if (!/<lns:LicenseClass/i.test(xml)) return null;
  const schema = /<lns:Schema[^>]*lns:ID="([^"]+)"/i.exec(xml)?.[1] ?? '';
  const soldRaw = /<lns:UTCdateSold>([^<]+)/i.exec(xml)?.[1] ?? '';
  const soldAt = soldRaw ? Date.parse(soldRaw) : 0;
  const evalDays = Number(/<lns:Evaluation[^>]*lns:Duration="P(\d+)D"/i.exec(xml)?.[1] ?? 0) || undefined;
  const transferable = /<lns:TransferableLicense>\s*true/i.test(xml);
  const label = /<lns:lang_en>([^<]+)/i.exec(xml)?.[1]?.trim() ?? path.basename(file);
  return { path: file, name: path.basename(file), xml, schema, soldAt, evalDays, transferable, label };
}

export function scanLicenses(dirs = licenseDirs()): LicenseCandidate[] {
  const files: string[] = [];
  for (const dir of dirs) walk(dir, 3, files);
  return files
    .map(parseLicense)
    .filter((x): x is LicenseCandidate => !!x)
    .sort((a, b) => b.soldAt - a.soldAt);
}

function generationOf(model: string): 'iDRAC8' | 'iDRAC9' | 'iDRAC10' {
  if (/17G/i.test(model)) return 'iDRAC10';
  if (/13G/i.test(model)) return 'iDRAC8';
  return 'iDRAC9';
}

function errorText(res: { text: string; json: unknown }): string {
  try {
    const body = res.json as RedfishErrorBody | null;
    const info = body?.error?.['@Message.ExtendedInfo']?.[0];
    if (info?.Message) return String(info.Message);
    if (body?.error?.message) return String(body.error.message);
  } catch {
    /* ignore */
  }
  return (res.text || '').replace(/\s+/g, ' ').slice(0, 200) || '未知错误';
}

async function deleteLicenses(client: RedfishClient): Promise<void> {
  try {
    const list = await client.getJson<RedfishCollection>('/redfish/v1/LicenseService/Licenses');
    for (const member of list?.Members ?? []) {
      const id = member?.['@odata.id'];
      if (typeof id === 'string') await client.raw('DELETE', id).catch(() => undefined);
    }
  } catch {
    /* nothing to delete */
  }
}

/**
 * Dell iDRAC refuses a new evaluation license while an expired one is still
 * installed, so we drop stale entries first and retry. Licenses live in a
 * folder the user can populate (see licenseDirs()).
 */
export async function ensureDellLicense(device: Device, password: string): Promise<LicenseResult> {
  const origin = `${device.scheme}://${device.host}:${device.port}`;
  const client = new RedfishClient(origin, device.username, password);
  if (!(await client.available())) {
    return { state: 'none', note: 'Redfish 不可用，跳过许可检查' };
  }
  const service = await client.raw('GET', '/redfish/v1/LicenseService');
  if (service.status !== 200) {
    return { state: 'none', note: '该设备没有 Redfish 许可服务' };
  }

  let model = '';
  try {
    const managers = await client.getJson<RedfishCollection>('/redfish/v1/Managers');
    const managerPath = managers?.Members?.[0]?.['@odata.id'];
    if (typeof managerPath === 'string') {
      const manager = await client.getJson<{ Model?: string }>(managerPath);
      model = String(manager?.Model ?? '');
    }
  } catch {
    /* keep default generation */
  }

  let installed: Array<Record<string, unknown>> = [];
  try {
    const list = await client.getJson<RedfishCollection>('/redfish/v1/LicenseService/Licenses');
    installed = list?.Members ?? [];
  } catch {
    installed = [];
  }

  let hasValid = false;
  const expired: string[] = [];
  for (const member of installed) {
    const id = member?.['@odata.id'];
    if (typeof id !== 'string') continue;
    try {
      const detail = await client.getJson<{ ExpirationDate?: string }>(id);
      const expiry = detail?.ExpirationDate ? Date.parse(detail.ExpirationDate) : 0;
      if (expiry && expiry < Date.now()) expired.push(id);
      else hasValid = true;
    } catch {
      hasValid = true;
    }
  }
  if (hasValid) return { state: 'ok', note: '已安装有效许可' };

  for (const id of expired) {
    await client.raw('DELETE', id).catch(() => undefined);
  }

  const generation = generationOf(model);
  const genLabel = /(1[3-7])G/i.exec(model)?.[1]?.toUpperCase() ?? '';
  const candidates = scanLicenses()
    .filter((c) => c.schema === generation)
    .sort((a, b) => {
      // prefer files whose name mentions this server's generation (14G/15G/...)
      const score = (c: LicenseCandidate) => (genLabel && c.name.toUpperCase().includes(genLabel) ? 1 : 0);
      return score(b) - score(a) || b.soldAt - a.soldAt;
    });
  if (!candidates.length) {
    return {
      state: 'none',
      note: `未找到 ${generation} 许可文件（目录：${licenseDirs().join('、') || '未配置'}）`,
    };
  }

  let lastError = '';
  for (const candidate of candidates.slice(0, 3)) {
    const licenseString = Buffer.from(candidate.xml, 'utf8').toString('base64');
    let res = await client.raw('POST', '/redfish/v1/LicenseService/Licenses', { LicenseString: licenseString });
    if (res.status >= 200 && res.status < 300) {
      return { state: 'activated', note: `已导入试用许可：${candidate.name}` };
    }
    lastError = errorText(res);

    if (/expired|过期/i.test(lastError)) {
      await deleteLicenses(client);
      res = await client.raw('POST', '/redfish/v1/LicenseService/Licenses', { LicenseString: licenseString });
      if (res.status >= 200 && res.status < 300) {
        return { state: 'activated', note: `已移除旧许可并导入：${candidate.name}` };
      }
      lastError = errorText(res);
    }
  }

  const hint = /expired|过期/i.test(lastError) ? '（该机器可能已经用过试用许可，需换正式许可）' : '';
  return { state: 'failed', note: `试用许可导入失败：${lastError}${hint}` };
}


/** Import one XML chosen by the user (manual fallback when auto-pick fails). */
export async function installLicenseFile(
  device: Device,
  password: string,
  file: string,
): Promise<LicenseResult> {
  const parsed = parseLicense(file);
  if (!parsed) return { state: 'failed', note: '许可导入失败：无法解析该 XML 文件' };
  const origin = `${device.scheme}://${device.host}:${device.port}`;
  const client = new RedfishClient(origin, device.username, password);
  const service = await client.raw('GET', '/redfish/v1/LicenseService');
  if (service.status !== 200) {
    return { state: 'failed', note: '许可导入失败：该设备没有 Redfish 许可服务' };
  }
  const licenseString = Buffer.from(parsed.xml, 'utf8').toString('base64');
  let res = await client.raw('POST', '/redfish/v1/LicenseService/Licenses', { LicenseString: licenseString });
  if (res.status >= 200 && res.status < 300) {
    return { state: 'activated', note: `已导入许可：${parsed.name}` };
  }
  let error = errorText(res);
  if (/expired|过期/i.test(error)) {
    await deleteLicenses(client);
    res = await client.raw('POST', '/redfish/v1/LicenseService/Licenses', { LicenseString: licenseString });
    if (res.status >= 200 && res.status < 300) {
      return { state: 'activated', note: `已移除旧许可并导入：${parsed.name}` };
    }
    error = errorText(res);
  }
  return { state: 'failed', note: `许可导入失败：${error}` };
}
