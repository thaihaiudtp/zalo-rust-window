// Run with: node --test scripts/check-bridge.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function page(pathname) {
  const sent = [];
  const sandbox = {
    location: { pathname, origin: 'http://127.0.0.1:47821' },
    chrome: { webview: { postMessage: (text) => sent.push(JSON.parse(text)) } },
    __zaloBridgeSpec: {
      globals: ['$zdb'], members: {}, values: {}, ipc: {
        '$zdb.onReceiveSession': { channel: 'db-authenticated', type: 'SUBSCRIBE' },
        '$zdb.sendRequest': { channel: 'shared-worker-req-events', type: 'REQUEST' },
      },
    },
    queueMicrotask, console, setTimeout,
  };
  sandbox.window = sandbox;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../host-scripts/bridge.js'), 'utf8'), sandbox);
  return { sandbox, sent };
}

test('worker retains session events until its bundle subscribes', async () => {
  const { sandbox } = page('/shared-worker.html');
  sandbox.__olazHostMessage({ kind: 'ipc', channel: 'db-authenticated', args: [{ userId: 'test' }] });
  let received;
  sandbox.$zdb.onReceiveSession((_event, session) => { received = session; });
  await new Promise(queueMicrotask);
  assert.equal(received.userId, 'test');
});

test('async requests include page identity and settle by promise id', async () => {
  const { sandbox, sent } = page('/index.html');
  const result = sandbox.$zdb.sendRequest({ act: 4 });
  const request = sent.find((message) => message.kind === 'invoke');
  assert.equal(request.page, 'main');
  assert.equal(request.channel, 'shared-worker-req-events');
  sandbox.__olazHostMessage({ kind: 'response', id: request.id, value: 'ok' });
  assert.equal(await result, 'ok');
});
