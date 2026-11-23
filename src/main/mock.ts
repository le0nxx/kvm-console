import http from 'node:http';
import { URL } from 'node:url';

/**
 * A fake BMC used by `npm run demo` so the UI, prewarm pipeline, auto-login,
 * KVM entry detection and the Redfish virtual-media path can be exercised
 * without touching real hardware.
 *
 * Hosts 127.0.0.1 ... 127.0.0.9 all resolve to this server and render a
 * different "node-0X" console, which also gives each device its own cookie jar.
 */

interface MediaState {
  inserted: boolean;
  image: string | null;
  boot: string | null;
}

const mediaByHost = new Map<string, MediaState>();

function stateFor(host: string): MediaState {
  if (!mediaByHost.has(host)) mediaByHost.set(host, { inserted: false, image: null, boot: null });
  return mediaByHost.get(host)!;
}

function nodeName(host: string): string {
  const last = host.split('.').pop() ?? '1';
  const n = Number(last);
  return `node-${String(Number.isFinite(n) ? n : 1).padStart(2, '0')}`;
}

function loginPage(host: string): string {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>${nodeName(host)} BMC 登录</title>
<style>
  body{margin:0;height:100vh;display:grid;place-items:center;background:#0f172a;
       font-family:system-ui,"Noto Sans SC",sans-serif;color:#e2e8f0}
  .card{width:360px;padding:36px;background:#111c33;border:1px solid #1e3a5f;border-radius:14px}
  h1{font-size:18px;margin:0 0 4px}
  p.sub{margin:0 0 24px;color:#7c8ba1;font-size:12px}
  label{display:block;font-size:12px;color:#93a4bd;margin:14px 0 6px}
  input{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:8px;border:1px solid #24405f;
        background:#0b1526;color:#e2e8f0;font-size:14px}
  button{width:100%;margin-top:22px;padding:11px;border:0;border-radius:8px;background:#1f6feb;
         color:#fff;font-size:14px;cursor:pointer}
  .foot{margin-top:16px;font-size:11px;color:#5b6b82;text-align:center}
</style></head><body>
<form class="card" method="POST" action="/login">
  <h1>${nodeName(host)} 管理界面</h1>
  <p class="sub">Mock BMC · demo only</p>
  <label>用户名</label>
  <input name="username" autocomplete="username" value="">
  <label>密码</label>
  <input name="password" type="password" autocomplete="current-password" value="">
  <button type="submit">登 录</button>
  <div class="foot">iBMC / iDRAC / ISBMC 通用登录模拟</div>
</form></body></html>`;
}

function dashboardPage(host: string): string {
  const name = nodeName(host);
  const odd = Number(host.split('.').pop()) % 2 === 1;
  const menu = odd
    ? `<button id="remote" class="tile" onclick="document.getElementById('kvmwrap').style.display='block'">
         远程控制 <span class="chev">▾</span>
       </button>
       <div id="kvmwrap" style="display:none;margin-top:8px">
         <a class="link" href="/kvm">KVM 控制台</a>
       </div>`
    : `<a class="tile" href="/kvm">KVM 控制台</a>`;
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>${name} · 管理</title>
<style>
  body{margin:0;background:#0b1220;color:#dbe4f0;font-family:system-ui,"Noto Sans SC",sans-serif}
  header{display:flex;align-items:center;justify-content:space-between;padding:14px 24px;
         background:#101b2e;border-bottom:1px solid #1d2f47}
  header b{font-size:15px} header span{color:#7c8ba1;font-size:12px}
  main{max-width:760px;margin:40px auto;padding:0 24px}
  .grid{display:grid;grid-template-columns:repeat(2,1fr);gap:14px}
  .tile{display:block;padding:18px;background:#101b2e;border:1px solid #1d2f47;border-radius:10px;
        color:#dbe4f0;text-decoration:none;font-size:14px;text-align:left;cursor:pointer}
  .tile:hover{border-color:#2f6feb}
  .link{display:inline-block;margin:10px 0 0 6px;color:#5aa2ff;font-size:14px}
  .chev{float:right;color:#5b6b82}
  .hint{margin-top:28px;color:#5b6b82;font-size:12px;line-height:1.7}
</style></head><body>
<header><b>${name}</b><span>Mock BMC · 192.168.10.${Number(host.split('.').pop())}</span></header>
<main>
  <div class="grid">
    ${menu}
    <div class="tile">系统信息</div>
    <div class="tile">虚拟介质</div>
    <div class="tile">电源管理</div>
  </div>
  <div class="hint">这是演示环境。奇数节点把 KVM 入口放在“远程控制”菜单下，用于验证两级点击识别。</div>
</main></body></html>`;
}

function kvmPage(host: string): string {
  const name = nodeName(host);
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>${name} · KVM</title>
<style>
  html,body{margin:0;height:100%;min-width:1280px;background:#05070b;overflow:hidden;font-family:system-ui,sans-serif}
  #wrap{height:100%;display:grid;place-items:center}
  canvas{max-width:100%;max-height:100%;box-shadow:0 0 40px rgba(30,120,255,.15)}
  #bar{position:fixed;left:0;right:0;top:0;height:30px;display:flex;align-items:center;
       gap:12px;padding:0 12px;background:#0b1220;border-bottom:1px solid #16233a;color:#8fa3bf;font-size:12px}
  #bar b{color:#dbe4f0} #bar .sp{flex:1}
  #bar button{background:#16233a;border:1px solid #24395b;color:#a9bcd8;border-radius:5px;padding:3px 9px;cursor:pointer}
</style></head><body>
<div id="bar"><b>KVM Console</b><span>${name}</span><span class="sp"></span>
  <span id="clock"></span><button>虚拟介质</button><button>发送 Ctrl+Alt+Del</button></div>
<div id="wrap"><canvas id="screen" width="1024" height="768"></canvas></div>
<script>
const c = document.getElementById('screen');
const g = c.getContext('2d');
const name = ${JSON.stringify(name)};
let t0 = performance.now();
function line(txt, x, y, color, size) {
  g.font = size + 'px "DejaVu Sans Mono", monospace';
  g.fillStyle = color;
  g.fillText(txt, x, y);
}
function draw(now) {
  const t = (now - t0) / 1000;
  g.fillStyle = '#04070d'; g.fillRect(0, 0, c.width, c.height);
  const grd = g.createLinearGradient(0, 0, c.width, c.height);
  grd.addColorStop(0, 'rgba(20,60,120,0.35)');
  grd.addColorStop(1, 'rgba(6,14,30,0.1)');
  g.fillStyle = grd; g.fillRect(0, 0, c.width, c.height);

  line('MOCK SERVER CONSOLE', 48, 70, '#5aa2ff', 20);
  line(name, 48, 150, '#e8f0ff', 54);
  line('BIOS ' + (name.endsWith('3') ? '2.14' : '2.09') + '   Memory 262144 MB   CPU 2 x Xeon', 48, 196, '#7f93ad', 18);

  const rows = [
    ['[  0.000000] Linux version 6.6.0-deploy (gcc 13.2)', '#9fb3cc'],
    ['[  0.412350] ACPI: Core revision 20230628', '#9fb3cc'],
    ['[  1.204881] smpboot: Allowing 128 CPUs', '#9fb3cc'],
    ['[  2.881004] systemd[1]: Reached target Local File Systems.', '#7fd6a0'],
    ['[  3.002144] eth0: link up, 25Gbps, full-duplex', '#7fd6a0'],
  ];
  rows.forEach((r, i) => line(r[0], 48, 270 + i * 30, r[1], 17));

  const sweep = (t * 120) % c.height;
  g.fillStyle = 'rgba(90,162,255,0.06)';
  g.fillRect(0, sweep, c.width, 26);

  line('FPS ' + Math.round(1000 / Math.max(1, now - (draw.last || now))) + '   uptime ' + t.toFixed(1) + 's',
       48, c.height - 36, '#43566f', 15);
  line('192.168.10.' + name.slice(-1) + '  ·  demo', c.width - 260, c.height - 36, '#43566f', 15);
  draw.last = now;
  document.getElementById('clock').textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  requestAnimationFrame(draw);
}
requestAnimationFrame(draw);
</script></body></html>`;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(text)) });
  res.end(text);
}

export interface MockBmc {
  port: number;
  close: () => Promise<void>;
}

export async function startMockBmc(preferredPort = 0): Promise<MockBmc> {
  const sessions = new Set<string>();
  let seq = 0;

  const server = http.createServer(async (req, res) => {
    const host = (req.headers.host ?? '127.0.0.1').split(':')[0];
    const url = new URL(req.url ?? '/', `http://${host}`);
    const path = url.pathname;
    const cookie = req.headers.cookie ?? '';
    const sid = /SID=([^;]+)/.exec(cookie)?.[1];
    const authed = !!sid && sessions.has(sid);

    // ---------- Redfish ----------
    if (path.startsWith('/redfish/')) {
      if (path === '/redfish/v1') {
        json(res, 200, {
          '@odata.id': '/redfish/v1',
          RedfishVersion: '1.6.0',
          Vendor: 'Mock',
          Managers: { '@odata.id': '/redfish/v1/Managers' },
          Systems: { '@odata.id': '/redfish/v1/Systems' },
        });
        return;
      }
      if (path === '/redfish/v1/Managers') {
        json(res, 200, { Members: [{ '@odata.id': '/redfish/v1/Managers/1' }] });
        return;
      }
      if (path === '/redfish/v1/Systems') {
        json(res, 200, { Members: [{ '@odata.id': '/redfish/v1/Systems/1' }] });
        return;
      }
      if (path === '/redfish/v1/Managers/1') {
        json(res, 200, { Id: '1', Name: 'Manager', VirtualMedia: { '@odata.id': '/redfish/v1/Managers/1/VirtualMedia' } });
        return;
      }
      if (path === '/redfish/v1/Managers/1/VirtualMedia') {
        json(res, 200, { Members: [{ '@odata.id': '/redfish/v1/Managers/1/VirtualMedia/CD' }] });
        return;
      }
      if (path === '/redfish/v1/Managers/1/VirtualMedia/CD') {
        const st = stateFor(host);
        json(res, 200, {
          Id: 'CD',
          Name: 'Virtual CD',
          MediaTypes: ['CD', 'DVD'],
          Inserted: st.inserted,
          Image: st.image,
          WriteProtected: true,
        });
        return;
      }
      if (path.endsWith('/Actions/VirtualMedia.InsertMedia') && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}');
        const st = stateFor(host);
        st.inserted = true;
        st.image = body.Image ?? 'http://example.invalid/image.iso';
        json(res, 200, {});
        return;
      }
      if (path.endsWith('/Actions/VirtualMedia.EjectMedia') && req.method === 'POST') {
        const st = stateFor(host);
        st.inserted = false;
        st.image = null;
        json(res, 200, {});
        return;
      }
      if (path === '/redfish/v1/Systems/1') {
        const st = stateFor(host);
        if (req.method === 'PATCH') {
          const body = JSON.parse((await readBody(req)) || '{}');
          st.boot = body?.Boot?.BootSourceOverrideTarget ?? null;
          json(res, 200, {});
          return;
        }
        json(res, 200, { Id: '1', Boot: { BootSourceOverrideTarget: st.boot } });
        return;
      }
      json(res, 404, { error: { message: 'not found' } });
      return;
    }

    // ---------- web UI ----------
    if (path === '/login' && req.method === 'POST') {
      const form = new URLSearchParams(await readBody(req));
      if ((form.get('username') ?? '').trim() && (form.get('password') ?? '')) {
        const id = `s${++seq}-${Date.now()}`;
        sessions.add(id);
        res.writeHead(302, { 'Set-Cookie': `SID=${id}; Path=/; HttpOnly`, Location: '/' });
        res.end();
      } else {
        res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(loginPage(host).replace('<form', '<p style="color:#f66">凭据不能为空</p><form'));
      }
      return;
    }
    if (!authed) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(loginPage(host));
      return;
    }
    if (path === '/kvm') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(kvmPage(host));
      return;
    }
    if (path === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(dashboardPage(host));
      return;
    }
    if (path === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });

  await new Promise<void>((resolve) => server.listen(preferredPort, '0.0.0.0', () => resolve()));
  const addr = server.address();
  return {
    port: typeof addr === 'object' && addr ? addr.port : 0,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
