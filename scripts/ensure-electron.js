#!/usr/bin/env node
/**
 * Repairs the Electron binary when npm blocks dependency postinstall scripts.
 *
 * npm >= 11 can refuse to run `electron`'s own postinstall (allowScripts policy),
 * which leaves node_modules/electron/dist empty and makes `electron .` fail with
 * "Electron failed to install correctly". Root package scripts still run, so this
 * hook re-runs electron's installer on demand and fixes a missing path.txt.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const pkgDir = path.join(root, 'node_modules', 'electron');
const distDir = path.join(pkgDir, 'dist');
const pathTxt = path.join(pkgDir, 'path.txt');
const cacheDir = path.join(root, '.cache', 'electron');

function platformPath() {
  if (process.platform === 'win32') return 'electron.exe';
  if (process.platform === 'darwin') return 'Electron.app/Contents/MacOS/Electron';
  return 'electron';
}

function installed() {
  try {
    if (!fs.existsSync(pathTxt)) return false;
    const rel = fs.readFileSync(pathTxt, 'utf8').trim();
    return fs.existsSync(path.join(distDir, rel));
  } catch {
    return false;
  }
}

if (installed()) process.exit(0);

if (!fs.existsSync(pkgDir)) {
  console.error('[electron] node_modules/electron 不存在，请先执行 npm install');
  process.exit(0);
}

fs.mkdirSync(cacheDir, { recursive: true });

function runInstaller(extraEnv, label) {
  process.stdout.write(`[electron] 正在下载运行时（${label}）…\n`);
  const res = spawnSync(process.execPath, [path.join(pkgDir, 'install.js')], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, electron_config_cache: cacheDir, ...extraEnv },
  });
  return res.status === 0;
}

let ok = runInstaller({}, 'github');
if (!ok) {
  ok = runInstaller({ ELECTRON_MIRROR: 'https://npmmirror.com/mirrors/electron/' }, 'npmmirror');
}

// install.js exits early when dist/ exists but path.txt is missing.
if (!fs.existsSync(pathTxt) && fs.existsSync(path.join(distDir, platformPath()))) {
  fs.writeFileSync(pathTxt, platformPath());
}

if (!installed()) {
  console.error(
    [
      '[electron] 运行时仍未安装成功。可手动处理：',
      '  node node_modules/electron/install.js',
      '  国内网络可先设置 ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/',
    ].join('\n'),
  );
  process.exit(1);
}

process.stdout.write('[electron] 运行时已就绪\n');
