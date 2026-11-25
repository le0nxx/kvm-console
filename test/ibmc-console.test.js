const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const { ibmcHtml5Script, launchKvmScript } = require('../dist/main/scripts.js');

const VISIBLE = () => ({ visibility: 'visible', display: 'block', opacity: '1' });

function element({ id = '', className = '', title = '', text = '' } = {}) {
  return {
    id,
    className,
    title,
    text,
    disabled: false,
    children: [],
    innerText: text,
    value: '',
    getBoundingClientRect: () => ({ width: 40, height: 20 }),
    getAttribute: (name) => (name === 'title' ? title : null),
    matches: () => true,
    click: () => {},
  };
}

/**
 * Minimal page used by both injected scripts: `settle()` advances a fake clock so
 * the scripts' polling loops finish immediately, and `canvasAfter` lets a click
 * or a route change start a console.
 */
function page({ items = [], hash = '#/navigate/home', acceptRoute = false, limitText = '', canvasAfter = 0 } = {}) {
  let ticks = 0;
  let canvas = false;
  const location = {
    href: 'https://192.168.8.9/',
    get hash() { return hash; },
    set hash(value) { if (acceptRoute || value !== '#/kvm_h5') hash = value; },
  };
  for (const item of items) {
    item.click = () => { item.clicks = (item.clicks || 0) + 1; };
  }
  const document = {
    title: 'iBMC 192.168.8.9',
    body: { innerText: limitText },
    querySelectorAll(selector) {
      if (selector === 'input[type=password]' || selector === 'canvas') {
        return selector === 'canvas' && canvas ? [{ width: 1024, height: 768 }] : [];
      }
      if (selector === '#h5Only, #h5Share') return items.filter((el) => el.id === 'h5Only' || el.id === 'h5Share');
      return items;
    },
    getElementById: (id) => items.find((el) => el.id === id) || null,
  };
  const env = {
    document,
    location,
    sessionStorage: { setItem() {} },
    localStorage: { setItem() {} },
    getComputedStyle: VISIBLE,
    setTimeout: (fn) => { ticks += 1; if (ticks === canvasAfter) canvas = true; setImmediate(fn); },
    setImmediate,
    console,
    Promise,
    Date: { now: () => ticks * 500 },
  };
  return env;
}

test('iBMC HTML5: clicks the HTML5 menu entry, never the Java one', async () => {
  const h5Private = element({ id: 'h5Only', className: 'itemDisable', title: 'HTML5 Integrated Remote Console (Private)' });
  const h5Shared = element({ id: 'h5Share', title: 'HTML5 Integrated Remote Console (Shared)' });
  const javaPrivate = element({ id: 'javaOnly', title: 'Java Integrated Remote Console (Private)' });
  const javaShared = element({ id: 'javaShare', title: 'Java Integrated Remote Console (Shared)' });
  const env = page({ items: [javaPrivate, javaShared, h5Private, h5Shared], canvasAfter: 6 });

  const res = await vm.runInNewContext(ibmcHtml5Script(), env);

  assert.equal(res.ok, true);
  assert.equal(res.via, 'entry');
  assert.equal(h5Shared.clicks, 1);
  assert.equal(h5Private.clicks, undefined, 'disabled HTML5 entry must not be clicked');
  assert.equal(javaPrivate.clicks, undefined, 'Java entry must not be clicked');
  assert.equal(javaShared.clicks, undefined, 'Java entry must not be clicked');
});

test('iBMC HTML5: reports no-h5 instead of falling back to Java', async () => {
  const javaPrivate = element({ id: 'javaOnly', title: 'Java Integrated Remote Console (Private)' });
  const env = page({ items: [javaPrivate] });

  const res = await vm.runInNewContext(ibmcHtml5Script(), env);

  assert.equal(res.ok, false);
  assert.equal(res.reason, 'no-h5');
  assert.equal(javaPrivate.clicks, undefined);
});

test('iBMC HTML5: takes the #/kvm_h5 route when the console renders', async () => {
  const env = page({ acceptRoute: true, canvasAfter: 3 });
  const res = await vm.runInNewContext(ibmcHtml5Script(), env);
  assert.equal(res.ok, true);
  assert.equal(res.via, 'route');
});

test('generic launcher prefers an HTML5 entry over a Java one', async () => {
  const java = element({ id: 'java', text: 'Java Integrated Remote Console' });
  const h5 = element({ id: 'h5', text: 'HTML5 Integrated Remote Console' });
  const env = page({ items: [java, h5] });

  const res = await vm.runInNewContext(launchKvmScript(), env);

  assert.equal(res.ok, true);
  assert.equal(h5.clicks, 1);
  assert.equal(java.clicks, undefined);
});
