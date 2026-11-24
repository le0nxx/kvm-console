const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { MESSAGES, makePatterns, createTranslator, hasCjk, fill } = require('../src/renderer/i18n.js');

const translate = createTranslator(MESSAGES, makePatterns);
const ROOT = path.join(__dirname, '..');

test('exact labels translate and keep surrounding whitespace', () => {
  assert.equal(translate('终端'), 'Terminal');
  assert.equal(translate(' 等待命令 '), ' Waiting for a command ');
  assert.equal(translate('失败：'), '失败：');
});

test('English copy keeps sentence case instead of title case', () => {
  assert.equal(
    translate('输入命令，例如 getsysinfo / mc info'),
    'Enter a command, e.g. getsysinfo / mc info',
  );
  assert.equal(
    translate('命令会在勾选的目标上逐台执行；凭据由本机连接记录提供。'),
    'Runs on each selected target; credentials come from local connection records.',
  );
});

test('composed messages translate through patterns', () => {
  assert.equal(translate('3 分钟前'), '3 min ago');
  assert.equal(translate('9 个标签 · 6 就绪'), '9 tabs · 6 ready');
  assert.equal(translate('执行完成：3/9 台成功'), 'Done: 3/9 succeeded');
  assert.equal(translate('已发送 F2 到 3/9 台'), 'Sent F2 to 3/9');
  assert.equal(translate('凭据：不可用'), 'Credentials: Unavailable');
  assert.equal(translate('SN：SL1234'), 'SN: SL1234');
  assert.equal(translate('与「连接」冲突'), 'Conflicts with "连接"');
  assert.equal(translate('退出码 2'), 'Exit code 2');
  assert.equal(
    translate('该设备没有可用的虚拟光驱（可能缺少许可证或固件不支持 Redfish 虚拟介质）'),
    'No virtual optical drive available (license missing, or the firmware lacks Redfish virtual media)',
  );
});

test('main-process status messages translate', () => {
  for (const [source, expected] of [
    ['页面无响应', 'Page is not responding'],
    ['正在进入 KVM', 'Entering the KVM'],
    ['未检测到画面信号，但页面已打开，可直接操作', 'No video signal detected, but the page is open and usable'],
    ['下载保存失败：磁盘已满', 'Download could not be saved: 磁盘已满'],
    ['连接中断，正在自动恢复（1/2）', 'Connection lost; recovering automatically (1/2)'],
    ['页面加载失败：ERR_CONNECTION_REFUSED (-102)', 'Page failed to load: ERR_CONNECTION_REFUSED (-102)'],
  ]) {
    assert.equal(translate(source), expected, source);
  }
});

test('unknown and non-Chinese text is left untouched', () => {
  assert.equal(translate('Hello world'), 'Hello world');
  assert.equal(translate(''), '');
  assert.equal(translate('任务：测试'), '任务：测试');
});

test('params fill both languages', () => {
  assert.equal(fill('{n} tabs · {ready} ready', { n: 3, ready: 2 }), '3 tabs · 2 ready');
  assert.equal(fill('{n} 个标签 · {ready} 就绪', { n: 3, ready: 2 }), '3 个标签 · 2 就绪');
  assert.equal(fill('{host}：{note}', { host: 'a' }), 'a：{note}');
});

test('catalog values are English and keep their placeholders', () => {
  for (const [key, value] of Object.entries(MESSAGES)) {
    assert.ok(!hasCjk(value), `${key} -> ${value} still has Chinese`);
    const keyParams = (key.match(/\{(\w+)\}/g) || []).sort();
    const valueParams = (value.match(/\{(\w+)\}/g) || []).sort();
    assert.deepEqual(valueParams, keyParams, `${key} placeholder mismatch`);
  }
});

test('static markup has no untranslated Chinese', () => {
  let html = fs.readFileSync(path.join(ROOT, 'src/renderer/index.html'), 'utf8');
  html = html
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<pre[^>]*data-no-i18n[\s\S]*?<\/pre>/g, '')
    .replace(/<option[^>]*data-no-i18n[^>]*>[\s\S]*?<\/option>/g, '');

  const strings = [];
  for (const m of html.matchAll(/>([^<>]+)</g)) {
    const text = m[1].trim();
    if (hasCjk(text)) strings.push(text);
  }
  for (const m of html.matchAll(/(?:placeholder|title|aria-label)="([^"]+)"/g)) {
    if (hasCjk(m[1])) strings.push(m[1]);
  }

  const untranslated = strings.filter((text) => hasCjk(translate(text)));
  assert.deepEqual(untranslated, [], `markup still Chinese in English: ${untranslated.join(' | ')}`);
});
