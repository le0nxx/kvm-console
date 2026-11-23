const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { MediaServer } = require('../dist/main/media.js');

function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
  });
}

test('media server serves byte ranges for BMC reads', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kvm-media-'));
  const file = path.join(dir, 'test.iso');
  fs.writeFileSync(file, Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 256)));

  const server = new MediaServer();
  const port = await server.start();
  const token = server.publish(file);
  const url = `http://127.0.0.1:${port}/v1/${token}/test.iso`;

  const full = await get(url);
  assert.equal(full.status, 200);
  assert.equal(full.body.length, 4096);
  assert.equal(full.headers['accept-ranges'], 'bytes');

  const ranged = await get(url, { Range: 'bytes=100-199' });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.body.length, 100);
  assert.equal(ranged.headers['content-range'], 'bytes 100-199/4096');
  assert.equal(ranged.body[0], 100 % 256);

  const missing = await get(`http://127.0.0.1:${port}/v1/deadbeef/x.iso`);
  assert.equal(missing.status, 404);

  server.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('bindIpFor returns a usable local address', () => {
  const ip = MediaServer.bindIpFor('192.168.10.11');
  assert.match(ip, /^\d{1,3}(\.\d{1,3}){3}$/);
});
