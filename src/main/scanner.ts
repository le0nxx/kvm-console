import { execFile } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import { promisify } from 'node:util';
import { VENDORS } from './store';
import type { ScanHost, Scheme, VendorId } from './types';

const execFileAsync = promisify(execFile);

/* ------------------------------------------------------------------ helpers */

export function prefixFromNetmask(netmask: string): number {
  return netmask
    .split('.')
    .map((part) => Number(part))
    .map((n) => (n >>> 0).toString(2).split('').filter((b) => b === '1').length)
    .reduce((a, b) => a + b, 0);
}

export function cidrFromInterface(address: string, netmask: string): string {
  const prefix = prefixFromNetmask(netmask);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const ip = address.split('.').reduce((acc, n) => (acc << 8) + Number(n), 0) >>> 0;
  const base = ip & mask;
  const octets = [(base >>> 24) & 255, (base >>> 16) & 255, (base >>> 8) & 255, base & 255];
  return `${octets.join('.')}/${prefix}`;
}

/** OEM block of a Redfish service root, per vendor. */
interface OemIdentity {
  ServiceTag?: string;
  SerialNumber?: string;
  ProductName?: string;
}

/** Fields of `/redfish/v1` that the scanner reads back. */
interface RedfishIdentity {
  RedfishVersion?: string;
  Vendor?: string;
  Product?: string;
  SerialNumber?: string;
  Oem?: { Dell?: OemIdentity; Huawei?: OemIdentity; xFusion?: OemIdentity };
}

export interface LocalSubnet {
  iface: string;
  address: string;
  cidr: string;
}

export function localSubnets(): LocalSubnet[] {
  const out: LocalSubnet[] = [];
  for (const [iface, list] of Object.entries(os.networkInterfaces())) {
    for (const item of list ?? []) {
      if (item.family !== 'IPv4' || item.internal) continue;
      out.push({ iface, address: item.address, cidr: cidrFromInterface(item.address, item.netmask) });
    }
  }
  return out;
}

/** parse `ip neigh show` or `arp -an` output into ip -> mac */
export function parseArpTable(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const ip = /(\d{1,3}(?:\.\d{1,3}){3})/.exec(line)?.[1];
    const mac = /([0-9a-f]{2}(?::[0-9a-f]{2}){5})/i.exec(line)?.[1];
    if (ip && mac && mac !== '00:00:00:00:00:00') out[ip] = mac.toLowerCase();
  }
  return out;
}

export async function readArpTable(): Promise<Record<string, string>> {
  try {
    const { stdout } = await execFileAsync('ip', ['neigh', 'show'], { timeout: 3000 });
    return parseArpTable(stdout);
  } catch {
    try {
      const { stdout } = await execFileAsync('arp', ['-an'], { timeout: 3000 });
      return parseArpTable(stdout);
    } catch {
      return {};
    }
  }
}

/** how many hosts of a CIDR we will touch; /24 is the sweet spot for BMC subnets */
export function hostCount(cidr: string): number {
  const prefix = Number(cidr.split('/')[1] ?? 24);
  if (!Number.isFinite(prefix)) return 254;
  return Math.max(1, Math.min(254, 2 ** (32 - prefix) - 2));
}

/** usable host addresses of a CIDR, network/broadcast excluded */
export function hostsInCidr(cidr: string): string[] {
  const [base, prefixRaw] = cidr.split('/');
  const parts = (base || '').split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return [];
  const prefix = Number(prefixRaw ?? 24);
  if (!Number.isFinite(prefix) || prefix < 8 || prefix > 32) return [];
  const ip = parts.reduce((acc, n) => (acc << 8) + n, 0) >>> 0;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const network = ip & mask;
  const size = 2 ** (32 - prefix);
  const count = Math.max(0, Math.min(254, size - 2));
  const out: string[] = [];
  for (let i = 1; i <= count; i++) {
    const n = (network + i) >>> 0;
    out.push([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'));
  }
  return out;
}

export function detectVendor(text: string): VendorId | undefined {
  const s = text.toLowerCase();
  if (!s) return undefined;
  if (/xfusion|fusion\s*server|超聚变/.test(s)) return 'xfusion';
  if (/huawei|ibmc|华为/.test(s)) return 'huawei';
  if (/dell|idrac|poweredge|戴尔/.test(s)) return 'dell';
  if (/inspur|isbmc|浪潮|nf5280/.test(s)) return 'inspur';
  return undefined;
}

interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  latencyMs: number;
}

function httpGet(
  url: string,
  opts: { timeout?: number; auth?: { username: string; password: string }; accept?: string } = {},
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const u = new URL(url);
    const lib = u.protocol === 'http:' ? http : https;
    const headers: Record<string, string> = { Accept: opts.accept ?? 'application/json,text/html' };
    if (opts.auth) {
      headers.Authorization = `Basic ${Buffer.from(`${opts.auth.username}:${opts.auth.password}`).toString('base64')}`;
    }
    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'http:' ? 80 : 443),
        path: `${u.pathname}${u.search}`,
        method: 'GET',
        headers,
        rejectUnauthorized: false,
        timeout: opts.timeout ?? 2500,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size <= 65536) chunks.push(c);
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
            latencyMs: Date.now() - started,
          }),
        );
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

function tcpOpen(host: string, port: number, timeout = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function pool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const current = index++;
      if (current >= items.length) return;
      await worker(items[current]);
    }
  });
  await Promise.all(runners);
}

/* ------------------------------------------------------------------- scan */

export interface ScanHooks {
  onProgress: (scanned: number, total: number) => void;
  onHost: (host: ScanHost) => void;
  isCancelled: () => boolean;
}

function candidateCredentials(vendor: VendorId | undefined): Array<{ u: string; p: string }> {
  if (vendor) {
    const preset = VENDORS.find((v) => v.id === vendor);
    if (preset?.defaults.length) return preset.defaults.slice(0, 2);
  }
  // unknown vendor: only two widely used pairs, to avoid lockouts
  return [
    { u: 'Administrator', p: 'Admin@9000' },
    { u: 'root', p: 'calvin' },
  ];
}

/**
 * Sweep a subnet for BMCs: TCP 443/80, Redfish identity, then (optionally)
 * verify default credentials. Credential attempts are capped at 2 per host.
 */
export async function scanSubnet(
  cidr: string,
  hooks: ScanHooks,
  options: {
    tryCredentials?: boolean;
    known?: Record<string, { username: string; password: string; model?: string; serial?: string }>;
  } = {},
): Promise<ScanHost[]> {
  const hosts = hostsInCidr(cidr);
  if (!hosts.length) throw new Error(`无效网段：${cidr}`);
  const arp = await readArpTable();


  let scanned = 0;
  const responsive: Array<{ ip: string; port: number; scheme: Scheme; mac?: string }> = [];

  // Probe HTTPS and HTTP together and scan a /24 in two waves: sequential
  // probes doubled the worst-case time per dead address.
  await pool(hosts, 128, async (ip) => {
    if (hooks.isCancelled()) return;
    const [https, http] = await Promise.all([tcpOpen(ip, 443), tcpOpen(ip, 80)]);
    const port = https ? 443 : http ? 80 : 0;
    if (port) {
      responsive.push({ ip, port, scheme: port === 443 ? 'https' : 'http', mac: arp[ip] });
    }
    scanned++;
    if (scanned % 8 === 0 || scanned === hosts.length) hooks.onProgress(scanned, hosts.length);
  });

  // ARP-only hosts that did not answer on 443/80 are usually not BMCs; skip them.
  const results: ScanHost[] = [];
  await pool(responsive, 8, async (entry) => {
    if (hooks.isCancelled()) return;
    const host: ScanHost = {
      ip: entry.ip,
      port: entry.port,
      scheme: entry.scheme,
      mac: entry.mac,
    };
    const origin = `${entry.scheme}://${entry.ip}:${entry.port}`;

    try {
      const root = await httpGet(`${origin}/redfish/v1`, { accept: 'application/json' });
      host.latencyMs = root.latencyMs;
      let identity: RedfishIdentity | null = null;
      try {
        identity = JSON.parse(root.body);
      } catch {
        identity = null;
      }
      if (root.status === 200 && identity && identity.RedfishVersion) {
        host.redfish = true;
        const vendorText = `${identity.Vendor ?? ''} ${identity.Product ?? ''} ${identity.Oem?.Huawei?.ProductName ?? ''}`;
        host.vendor = detectVendor(vendorText);
        host.title = identity.Product || identity.Vendor;
        if (identity.SerialNumber) host.serial = String(identity.SerialNumber);
        const known = options.known?.[entry.ip];
        if (known) {
          host.savedUsername = known.username;
          if (known.serial && !host.serial) host.serial = known.serial;
          if (known.model && !host.model) host.model = known.model;
        }
        const oemSerial =
          identity.Oem?.Dell?.ServiceTag ??
          identity.Oem?.Huawei?.SerialNumber ??
          identity.Oem?.xFusion?.SerialNumber;
        if (oemSerial) host.serial = String(oemSerial);

        if (host.vendor === 'dell') {
          try {
            const info = await httpGet(`${origin}/sysmgmt/2015/bmc/info`, { accept: 'application/json' });
            const attrs = JSON.parse(info.body)?.Attributes ?? {};
            if (attrs.SystemModelName) host.model = String(attrs.SystemModelName);
            const title = String(attrs.GUITitleBar || '');
            if (!host.serial && /^iDRAC-/i.test(title)) host.serial = title.replace(/^iDRAC-/i, '');
          } catch {
            /* optional */
          }
        }

        if (options.tryCredentials !== false) {
          const creds = candidateCredentials(host.vendor);
          const known = options.known?.[entry.ip];
          if (known) creds.unshift({ u: known.username, p: known.password });
          for (const cred of creds) {
            if (hooks.isCancelled()) break;
            try {
              const systems = await httpGet(`${origin}/redfish/v1/Systems`, {
                accept: 'application/json',
                auth: { username: cred.u, password: cred.p },
              });
              if (systems.status === 200) {
                host.credential = { username: cred.u, password: cred.p };
                const isDefault = candidateCredentials(host.vendor).some(
                  (c) => c.u === cred.u && c.p === cred.p,
                );
                host.savedCredential = Boolean(known && cred.u === known.username && !isDefault);
                host.saved = host.savedCredential;
                try {
                  const parsed = JSON.parse(systems.body);
                  const member = parsed?.Members?.[0]?.['@odata.id'];
                  if (member) {
                    const sys = await httpGet(`${origin}${member}`, {
                      accept: 'application/json',
                      auth: { username: cred.u, password: cred.p },
                    });
                    const detail = JSON.parse(sys.body);
                    if (detail?.Model) host.model = String(detail.Model);
                    const dellTag = detail?.Oem?.Dell?.DellSystem?.ChassisServiceTag;
                    if (dellTag) host.serial = String(dellTag);
                    else if (detail?.SerialNumber) host.serial = String(detail.SerialNumber);
                  }
                } catch {
                  /* model detail optional */
                }
                break;
              }
            } catch {
              /* try next credential */
            }
          }
        }
      } else {
        const page = await httpGet(`${origin}/`, { accept: 'text/html' });
        const title = /<title[^>]*>([^<]*)<\/title>/i.exec(page.body)?.[1]?.trim();
        if (title) host.title = title;
        host.vendor = detectVendor(`${title ?? ''} ${page.headers.server ?? ''}`);
      }
    } catch (err) {
      host.error = err instanceof Error ? err.message : String(err);
    }

    if (!host.vendor) host.vendor = 'generic';
    host.vendorLabel = VENDORS.find((v) => v.id === host.vendor)?.label ?? host.vendor;
    results.push(host);
    hooks.onHost(host);
  });

  const score = (h: ScanHost) => (h.credential ? 3 : 0) + (h.redfish ? 2 : 0) + (h.vendor !== 'generic' ? 1 : 0);
  return results.sort(
    (a, b) => score(b) - score(a) || a.ip.localeCompare(b.ip, undefined, { numeric: true }),
  );
}
