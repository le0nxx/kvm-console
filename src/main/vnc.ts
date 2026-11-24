import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { WebSocketServer, WebSocket } from 'ws';

function traceWire(dir: 'c2s' | 's2c', data: Buffer): void {
  try {
    const line = `${new Date().toISOString()} ${dir} len=${data.length} ${data.subarray(0, 48).toString('hex')}\n`;
    fs.appendFileSync(path.join(os.homedir(), '.config', 'kvm-console', 'wire-debug.log'), line);
  } catch {
    /* ignore */
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/**
 * noVNC speaks WebSocket, iDRAC exposes plain TCP VNC. This bridge serves the
 * bundled noVNC page from localhost and tunnels ws://127.0.0.1:<port>/v1/<token>
 * to the BMC's VNC port, so the console can live inside a normal tile.
 */
export class VncBridge {
  private wss?: WebSocketServer;
  private web?: http.Server;
  private targets = new Map<
    string,
    | { kind: 'tcp'; host: string; port: number }
    | { kind: 'dell'; wsUrl: string; cookie: string; key2: string }
  >();
  proxyPort = 0;
  webPort = 0;

  async start(): Promise<void> {
    if (this.wss && this.web) return;

    const root = path.join(__dirname, '../../src/renderer');
    this.web = http.createServer((req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const file = path.normalize(path.join(root, decodeURIComponent(url.pathname)));
        if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
          res.writeHead(404);
          res.end('not found');
          return;
        }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
        fs.createReadStream(file).pipe(res);
      } catch {
        res.writeHead(500);
        res.end();
      }
    });
    await new Promise<void>((resolve) => this.web!.listen(0, '127.0.0.1', resolve));
    const addr = this.web.address();
    this.webPort = typeof addr === 'object' && addr ? addr.port : 0;

    this.wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    this.wss.on('connection', (ws, req) => {
      const token = /^\/v1\/([a-f0-9]+)/.exec(req.url ?? '')?.[1];
      const target = token ? this.targets.get(token) : undefined;
      if (!target) {
        ws.close();
        return;
      }
      if (target.kind === 'dell') {
        const upstream = new WebSocket(target.wsUrl, 'binary', {
          headers: { Cookie: target.cookie, Origin: `https://${new URL(target.wsUrl).hostname}` },
          rejectUnauthorized: false,
        });
        const key2Frame = Buffer.alloc(2 + target.key2.length + 8);
        key2Frame[0] = 0xf7;
        key2Frame[1] = 0xb3;
        key2Frame.write(target.key2, 2, 'ascii');
        upstream.on('open', () => {
          /* wait for the key2 request */
        });
        upstream.on('message', (data) => {
          const buf = Buffer.from(data as Buffer);
          if (buf[0] !== 0xf7) traceWire('s2c', buf);
          if (buf[0] === 0xf7) {
            if (buf[1] === 0xb3) upstream.send(key2Frame);
            return; // Dell control frames are not RFB
          }
          try {
            ws.send(buf);
          } catch {
            /* ignore */
          }
        });
        ws.on('message', (data) => {
          const buf = Buffer.from(data as Buffer);
          traceWire('c2s', buf);
          if (upstream.readyState === WebSocket.OPEN) upstream.send(buf);
        });
        ws.on('close', () => upstream.close());
        upstream.on('close', () => {
          try {
            ws.close();
          } catch {
            /* ignore */
          }
        });
        upstream.on('error', () => ws.close());
      } else {
        const tcp = net.connect(target.port, target.host);
        tcp.on('data', (data) => {
          try {
            ws.send(data);
          } catch {
            /* ignore */
          }
        });
        ws.on('message', (data) => tcp.write(Buffer.from(data as Buffer)));
        ws.on('close', () => tcp.destroy());
        tcp.on('error', () => ws.close());
        tcp.on('close', () => {
          try {
            ws.close();
          } catch {
            /* ignore */
          }
        });
      }
    });
    await new Promise<void>((resolve) => this.wss!.on('listening', resolve));
    const wsAddr = this.wss.address();
    this.proxyPort = typeof wsAddr === 'object' && wsAddr ? wsAddr.port : 0;
  }

  /** viewer URL for a BMC VNC endpoint */
  viewerUrl(host: string, port: number, password: string): string {
    const token = crypto.randomBytes(10).toString('hex');
    this.targets.set(token, { kind: 'tcp', host, port });
    return this.viewerForToken(token, password);
  }

  /** Remote WebSocket console (iDRAC): bridge it and drop 0xF7 control frames. */
  viewerUrlForWebSocket(wsUrl: string, cookie: string, key2: string): string {
    const token = crypto.randomBytes(10).toString('hex');
    this.targets.set(token, { kind: 'dell', wsUrl, cookie, key2 });
    return this.viewerForToken(token, '');
  }

  private viewerForToken(token: string, password: string): string {
    const ws = `ws://127.0.0.1:${this.proxyPort}/v1/${token}`;
    const query = new URLSearchParams({ url: ws, password });
    return `http://127.0.0.1:${this.webPort}/novnc.html?${query.toString()}`;
  }
}
