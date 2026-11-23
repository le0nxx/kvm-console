const test = require('node:test');
const assert = require('node:assert/strict');
const { startMockBmc } = require('../dist/main/mock.js');
const { RedfishClient } = require('../dist/main/redfish.js');

test('redfish virtual media flow against the mock BMC', async () => {
  const bmc = await startMockBmc();
  try {
    const client = new RedfishClient(`http://127.0.0.1:${bmc.port}`, 'admin', 'admin');
    assert.equal(await client.available(), true);

    const targets = await client.discover();
    assert.ok(targets.manager.includes('/Managers/'));
    assert.ok(targets.system && targets.system.includes('/Systems/'));
    assert.equal(targets.slots.length, 1);

    const slot = client.pickCdSlot(targets);
    assert.ok(slot);
    assert.equal(slot.inserted, false);

    await client.insertMedia(slot, 'http://192.168.1.50:9000/demo.iso');
    let status = await client.status(slot);
    assert.equal(status.inserted, true);
    assert.equal(status.image, 'http://192.168.1.50:9000/demo.iso');

    await client.bootOnce(targets.system, 'Cd');
    await client.ejectMedia(slot);
    status = await client.status(slot);
    assert.equal(status.inserted, false);
  } finally {
    await bmc.close();
  }
});

test('redfish reports a friendly error for a non-redfish endpoint', async () => {
  const bmc = await startMockBmc();
  try {
    const client = new RedfishClient(`http://127.0.0.1:${bmc.port}/nope`, 'admin', 'admin');
    await assert.rejects(() => client.discover());
  } finally {
    await bmc.close();
  }
});
