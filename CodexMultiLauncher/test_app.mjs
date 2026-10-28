import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { test } from 'node:test';

async function loadApp() {
  const elements = new Map();
  const document = {
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, { addEventListener() {}, classList: { toggle() {} } });
      return elements.get(selector);
    },
    querySelectorAll() { return []; },
  };
  const context = vm.createContext({ document, console, encodeURIComponent,
    window: { clearTimeout() {}, setTimeout() {}, setInterval() {} },
    fetch: async () => ({ ok: true, json: async () => ({ profiles: [], dataRoot: '' }) }),
  });
  vm.runInContext(await readFile(new URL('./app.js', import.meta.url), 'utf8'), context);
  await vm.runInContext('refreshPromise', context);
  vm.runInContext('render = () => {};', context);
  return context;
}

test('turning off calls stop without validating or saving edited configuration', async () => {
  const app = await loadApp();
  const requests = [];
  app.fetch = async (url, options) => {
    requests.push([url, options?.method]);
    return { ok: true, json: async () => ({ profiles: [], dataRoot: '' }) };
  };
  app.card = { dataset: { id: 'import-tokenapi' }, querySelector(selector) {
    assert.equal(selector, '.enabled', 'stopping must not read configuration fields');
    return { checked: false };
  } };
  await vm.runInContext('toggleRuntime(card)', app);
  assert.deepEqual(requests.map(([url]) => url), ['/api/profiles/import-tokenapi/stop', '/api/state']);
});

test('polling cannot redraw a card while its runtime request is pending', async () => {
  const app = await loadApp();
  let release;
  let redraws = 0;
  app.render = () => { redraws += 1; };
  app.fetch = async (url) => {
    if (url.endsWith('/stop')) await new Promise(resolve => { release = resolve; });
    return { ok: true, json: async () => ({ profiles: [], dataRoot: '' }) };
  };
  app.card = { dataset: { id: 'imported' }, querySelector() { return { checked: false }; } };
  const operation = vm.runInContext('toggleRuntime(card)', app);
  await vm.runInContext('refresh()', app);
  assert.equal(redraws, 0);
  release();
  await operation;
  assert.equal(redraws, 1);
});

test('a state response started before an operation cannot overwrite that operation', async () => {
  const app = await loadApp();
  let release;
  let redraws = 0;
  app.render = () => { redraws += 1; };
  app.fetch = async () => {
    await new Promise(resolve => { release = resolve; });
    return { ok: true, json: async () => ({ profiles: [], dataRoot: '' }) };
  };
  const refresh = vm.runInContext('refresh()', app);
  vm.runInContext('runtimeOperationCount += 1', app);
  release();
  await refresh;
  assert.equal(redraws, 0);
});

test('a disconnected service disables stale switches and reports recovery instructions', async () => {
  const app = await loadApp();
  const toggle = { disabled: false };
  const status = { textContent: '运行中' };
  app.document.querySelectorAll = selector => selector.endsWith('.enabled') ? [toggle] : [status];
  app.fetch = async () => { throw new TypeError('Failed to fetch'); };
  await vm.runInContext('refresh()', app);
  assert.equal(toggle.disabled, true);
  assert.equal(status.textContent, '连接已断开');
  assert.match(app.document.querySelector('#toast').textContent, /start.bat/);
  app.fetch = async () => ({ ok: true, json: async () => ({ profiles: [], dataRoot: '' }) });
  await vm.runInContext('refresh()', app);
  assert.equal(app.document.querySelector('#toast').textContent, '');
});
