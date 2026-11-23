#!/usr/bin/env node
/**
 * Launches Electron with a display backend that actually works on this machine.
 *
 * Lessons from the field:
 *  - `--ozone-platform` is consumed before the app's main script runs, so it
 *    must be on the command line (appendSwitch at runtime is too late).
 *  - Chromium's Wayland backend refuses Vulkan ("not compatible with Vulkan"),
 *    and several Mesa/Zink builds crash the GPU process under Wayland. X11 /
 *    XWayland is the safe default on a desktop, so we prefer it when DISPLAY
 *    exists and only use native Wayland when there is no X server at all.
 *  - If a backend still crashes early, fall back down a short ladder and
 *    remember the mode that worked.
 *
 * Overrides: KVM_WAYLAND=1 (force native Wayland), KVM_NO_WAYLAND=1 (force X11).
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const STATE_DIR = path.join(__dirname, '..', '.cache');
const STATE_FILE = path.join(STATE_DIR, 'display-preference.json');

let electronPath;
try {
  electronPath = require('electron');
} catch {
  console.error('[launch] Electron 运行时不可用，请先执行：node scripts/ensure-electron.js');
  process.exit(1);
}

const userArgs = process.argv.slice(2);
const env = { ...process.env };

const WAYLAND_FLAGS = ['--ozone-platform=wayland', '--disable-features=Vulkan'];
const X11_FLAGS = ['--ozone-platform=x11'];

const hasDisplay = Boolean(env.DISPLAY);
const hasWayland = Boolean(env.WAYLAND_DISPLAY);
const forceWayland = env.KVM_WAYLAND === '1';
const forceX11 = env.KVM_NO_WAYLAND === '1';

function withoutBackendFlags(args) {
  return args.filter(
    (a) => !a.startsWith('--ozone-platform') && !a.startsWith('--disable-features=Vulkan'),
  );
}

const cleanArgs = withoutBackendFlags(userArgs);
const hasSoft = cleanArgs.includes('--soft-render') || cleanArgs.includes('--disable-gpu');

let primary;
if (forceWayland && hasWayland) primary = { label: 'Wayland', flags: WAYLAND_FLAGS };
else if (forceX11 && hasDisplay) primary = { label: 'X11/XWayland', flags: X11_FLAGS };
else if (hasDisplay) primary = { label: 'X11/XWayland', flags: X11_FLAGS };
else if (hasWayland) primary = { label: 'Wayland', flags: WAYLAND_FLAGS };
else primary = { label: '默认', flags: [] };

let secondary = null;
if (primary.label !== 'Wayland' && hasWayland) secondary = { label: 'Wayland', flags: WAYLAND_FLAGS };
else if (primary.label !== 'X11/XWayland' && hasDisplay)
  secondary = { label: 'X11/XWayland', flags: X11_FLAGS };

const softArgs = cleanArgs.includes('--soft-render') ? cleanArgs : [...cleanArgs, '--soft-render'];

const attempts = [];
if (!hasSoft) {
  attempts.push({ label: primary.label, args: [...primary.flags, ...cleanArgs] });
  if (secondary) attempts.push({ label: secondary.label, args: [...secondary.flags, ...cleanArgs] });
}
attempts.push({ label: `${primary.label} + 软件渲染`, args: [...primary.flags, ...softArgs] });
attempts.push({
  label: '禁用 GPU',
  args: softArgs.includes('--disable-gpu')
    ? [...primary.flags, ...softArgs]
    : [...primary.flags, ...softArgs, '--disable-gpu'],
});

function loadPreferred() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).mode || null;
  } catch {
    return null;
  }
}

function savePreferred(mode) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ mode, at: new Date().toISOString() }, null, 2));
  } catch {
    /* best effort */
  }
}

const preferred = loadPreferred();
if (preferred) {
  const index = attempts.findIndex((a) => a.label === preferred);
  if (index > 0) attempts.unshift(attempts.splice(index, 1)[0]);
}

function run(attempt) {
  return new Promise((resolve) => {
    const started = Date.now();
    const args = ['.', ...attempt.args];
    console.log(`[launch] ${attempt.label}：electron ${args.join(' ')}`);
    const child = spawn(electronPath, args, { stdio: 'inherit', env });
    let settled = false;
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      resolve({ code, signal, elapsed: Date.now() - started });
    };
    child.on('exit', finish);
    child.on('error', (err) => {
      console.error('[launch] 启动失败：', err.message);
      finish(1, null);
    });
  });
}

async function main() {
  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i];
    const { code, signal, elapsed } = await run(attempt);

    if (signal === 'SIGINT' || signal === 'SIGTERM') {
      process.kill(process.pid, signal);
      return;
    }
    if (code === 0) {
      if (elapsed > 8000) savePreferred(attempt.label);
      process.exit(0);
    }

    if (i === attempts.length - 1 || elapsed >= 25000) {
      process.exit(code ?? 1);
    }
    console.warn(`[launch] ${attempt.label} 启动异常（${elapsed}ms），尝试下一种方式…`);
  }
}

main();
