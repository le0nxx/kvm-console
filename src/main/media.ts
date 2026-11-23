import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

interface Entry {
  file: string;
  name: string;
  size: number;
  bytes: number;
  startedAt: number;
  windowAt: number;
  windowBytes: number;
  speed: number;
}

/**
 * Tiny read-only HTTP file server used to hand ISOs to a BMC over Redfish
 * InsertMedia. Supports Range requests because BMCs read images in chunks.
 */
export class MediaServer {
  private server: http.Server | null = null;
  private entries = new Map<string, Entry>();
  port = 0;

  async start(preferredPort = 0): Promise<number> {
    if (this.server) return this.port;
    this.server = http.createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(preferredPort, '0.0.0.0', () => resolve());
    });
    const addr = this.server.address();
    this.port = typeof addr === 'object' && addr ? addr.port : 0;
    return this.port;
  }

  stop(): void {
    this.server?.close();
    this.server = null;
  }

  publish(file: string): string {
    const stat = fs.statSync(file);
    if (!stat.isFile()) throw new Error(`不是文件：${file}`);
    const token = crypto.randomBytes(12).toString('hex');
    this.entries.set(token, {
      file,
      name: path.basename(file),
      size: stat.size,
      bytes: 0,
      startedAt: Date.now(),
      windowAt: Date.now(),
      windowBytes: 0,
      speed: 0,
    });
    return token;
  }

  revoke(token: string): void {
    this.entries.delete(token);
  }

  stats(token: string): { name: string; size: number; bytes: number; speed: number } | null {
    const e = this.entries.get(token);
    if (!e) return null;
    return { name: e.name, size: e.size, bytes: e.bytes, speed: e.speed };
  }

  private track(entry: Entry, chunkLength: number): void {
    entry.bytes += chunkLength;
    entry.windowBytes += chunkLength;
    const now = Date.now();
    const dt = now - entry.windowAt;
    if (dt >= 800) {
      entry.speed = Math.round((entry.windowBytes / dt) * 1000);
      entry.windowBytes = 0;
      entry.windowAt = now;
    }
  }

  urlFor(token: string, ip: string): string {
    const entry = this.entries.get(token);
    if (!entry) throw new Error('媒体令牌不存在');
    return `http://${ip}:${this.port}/v1/${token}/${encodeURIComponent(entry.name)}`;
  }

  /** Prefer the local IPv4 address that shares a /24 with the BMC. */
  static bindIpFor(host: string): string {
    const ifaces = os.networkInterfaces();
    const candidates: Array<{ address: string; netmask: string }> = [];
    for (const list of Object.values(ifaces)) {
      for (const item of list ?? []) {
        if (item.family === 'IPv4' && !item.internal) {
          candidates.push({ address: item.address, netmask: item.netmask });
        }
      }
    }
    const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
    const m = host.match(ipv4);
    if (m) {
      const prefix = `${m[1]}.${m[2]}.${m[3]}.`;
      const same = candidates.find((c) => c.address.startsWith(prefix));
      if (same) return same.address;
    }
    return candidates[0]?.address ?? '127.0.0.1';
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
        return;
      }
      const m = url.pathname.match(/^\/v1\/([a-f0-9]+)\/[^/]*$/);
      const entry = m ? this.entries.get(m[1]) : undefined;
      if (!entry) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not found');
        return;
      }

      const range = req.headers.range;
      const baseHeaders: Record<string, string> = {
        'Content-Type': 'application/octet-stream',
        'Accept-Ranges': 'bytes',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(entry.name)}"`,
      };

      if (range) {
        const parsed = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
        let start = 0;
        let end = entry.size - 1;
        if (parsed) {
          if (parsed[1] === '' && parsed[2] !== '') {
            const suffix = Number(parsed[2]);
            start = Math.max(0, entry.size - suffix);
          } else {
            start = parsed[1] ? Number(parsed[1]) : 0;
            end = parsed[2] ? Number(parsed[2]) : entry.size - 1;
          }
        }
        if (start > end || start >= entry.size) {
          res.writeHead(416, { 'Content-Range': `bytes */${entry.size}` });
          res.end();
          return;
        }
        end = Math.min(end, entry.size - 1);
        res.writeHead(206, {
          ...baseHeaders,
          'Content-Range': `bytes ${start}-${end}/${entry.size}`,
          'Content-Length': String(end - start + 1),
        });
        if (req.method === 'HEAD') {
          res.end();
          return;
        }
        const ranged = fs.createReadStream(entry.file, { start, end });
        ranged.on('data', (chunk) => this.track(entry, chunk.length));
        ranged.pipe(res);
        return;
      }

      res.writeHead(200, { ...baseHeaders, 'Content-Length': String(entry.size) });
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      const full = fs.createReadStream(entry.file);
      full.on('data', (chunk) => this.track(entry, chunk.length));
      full.pipe(res);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(String(err));
    }
  }
}
