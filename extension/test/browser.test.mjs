// Fill behavior in real headless Chrome: content.js against test/fixture.html and test/widgets.html
// (fake worker, so no Gmail needed). Run: node --test test/browser.test.mjs
// Needs Google Chrome installed; the React widget cases fetch React/input-otp/react-otp-input from esm.sh.
import test from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = createServer(async (req, res) => {
  try {
    const body = await readFile(join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
    res.writeHead(200, { 'content-type': extname(req.url.split('?')[0]) === '.js' ? 'text/javascript' : 'text/html', 'cache-control': 'no-store' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const port = 9400 + Math.floor(Math.random() * 500);
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${await mkdtemp(join(tmpdir(), 'otp-chrome-'))}`, 'about:blank'], { stdio: 'ignore' });
let targets;
for (let i = 0; i < 50 && !targets; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); } catch { await sleep(200); } }
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0; const pending = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); pending.get(m.id)?.(m); pending.delete(m.id); });
const cdp = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });

async function run(path) {
  await cdp('Page.navigate', { url: base + path });
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    const r = await cdp('Runtime.evaluate', { expression: "document.body && document.body.getAttribute('data-result')", returnByValue: true });
    if (r.result.result.value) return JSON.parse(r.result.result.value);
  }
  throw new Error('no result from ' + path);
}

test.after(() => { ws.close(); chrome.kill(); server.close(); });

const DIGITS = ['6', '0', '4', '3', '1', '8'];
test('single field auto-fills', async () => assert.deepEqual((await run('/test/fixture.html?mode=single')).values, ['604318']));
test('auto-submit submits the form', async () => assert.equal((await run('/test/fixture.html?mode=single&submit=1')).title, 'submitted:604318'));
test('split boxes, typed per box', async () => assert.deepEqual((await run('/test/fixture.html?mode=split')).values, DIGITS));
test('split boxes, widget handles the paste', async () => {
  const r = await run('/test/fixture.html?mode=splitpaste');
  assert.deepEqual(r.values, DIGITS); assert.equal(r.pasteHandled, true);
});
test('other-site sender is not auto-filled', async () => {
  const r = await run('/test/fixture.html?mode=single&match=none&auto=0');
  assert.deepEqual(r.values, ['']); assert.equal(r.chip, true);
});
// `state` is what the app itself received, the value it would actually submit.
test('ordinary form fields get no chip (Time zone)', async () => assert.equal((await run('/test/fixture.html?mode=notcode')).chip, false));
test('input-otp (shadcn/ui)', async () => assert.equal((await run('/test/widgets.html?w=inputotp')).state, '604318'));
test('react-otp-input', async () => {
  const r = await run('/test/widgets.html?w=reactotp');
  assert.deepEqual(r.dom, DIGITS); assert.equal(r.state, '604318');
});
test('boxes that block paste', async () => assert.equal((await run('/test/widgets.html?w=vanilla')).state, '604318'));
test('boxes without maxlength=1', async () => {
  const r = await run('/test/widgets.html?w=nomax');
  assert.deepEqual(r.dom, DIGITS); assert.equal(r.state, '604318');
});
