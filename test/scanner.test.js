const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseArpTable,
  cidrFromInterface,
  detectVendor,
  hostCount,
  hostsInCidr,
} = require('../dist/main/scanner.js');

test('parseArpTable reads ip neigh output', () => {
  const text = [
    '192.168.10.11 dev eth0 lladdr aa:bb:cc:dd:ee:01 REACHABLE',
    '192.168.10.12 dev eth0 lladdr aa:bb:cc:dd:ee:02 STALE',
    '192.168.10.13 dev eth0 FAILED',
  ].join('\n');
  const table = parseArpTable(text);
  assert.equal(table['192.168.10.11'], 'aa:bb:cc:dd:ee:01');
  assert.equal(table['192.168.10.12'], 'aa:bb:cc:dd:ee:02');
  assert.equal(table['192.168.10.13'], undefined);
});

test('parseArpTable also understands arp -an', () => {
  const table = parseArpTable('? (192.168.1.5) at 00:11:22:33:44:55 [ether] on eth0');
  assert.equal(table['192.168.1.5'], '00:11:22:33:44:55');
});

test('cidrFromInterface computes the network', () => {
  assert.equal(cidrFromInterface('192.168.10.37', '255.255.255.0'), '192.168.10.0/24');
  assert.equal(cidrFromInterface('10.1.2.3', '255.255.0.0'), '10.1.0.0/16');
});

test('hostCount caps huge ranges at one /24', () => {
  assert.equal(hostCount('192.168.10.0/24'), 254);
  assert.equal(hostCount('10.0.0.0/16'), 254);
});

test('hostsInCidr honours the network address', () => {
  assert.deepEqual(hostsInCidr('192.168.8.12/30'), ['192.168.8.13', '192.168.8.14']);
  assert.equal(hostsInCidr('192.168.8.0/24').length, 254);
  assert.equal(hostsInCidr('192.168.8.0/24')[0], '192.168.8.1');
  assert.equal(hostsInCidr('192.168.8.0/24').at(-1), '192.168.8.254');
});

test('detectVendor recognises the big four', () => {
  assert.equal(detectVendor('Huawei iBMC'), 'huawei');
  assert.equal(detectVendor('xFusion FusionServer'), 'xfusion');
  assert.equal(detectVendor('Dell Inc. PowerEdge R750'), 'dell');
  assert.equal(detectVendor('Inspur NF5280M6'), 'inspur');
  assert.equal(detectVendor('unknown vendor'), undefined);
});
