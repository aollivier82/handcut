// Runs the simulated-hands checks (tools/sim.js) in headless Edge against a
// running dev server and prints PASS/FAIL per gesture.
//   node tools/run-sim.mjs [url] [--only tChop,tTrim] [--shot name]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const url = args.find((a) => a.startsWith('http')) || 'http://localhost:47842/';
const only = args.includes('--only') ? args[args.indexOf('--only') + 1].split(',') : null;
const shot = args.includes('--shot') ? args[args.indexOf('--shot') + 1] : null;
const expr = args.includes('--eval') ? args[args.indexOf('--eval') + 1] : null;
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const port = 9300 + Math.floor(Math.random() * 500);
const userDir = path.resolve('work/edge-sim-' + port);
fs.mkdirSync(userDir, { recursive: true });

const edge = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${userDir}`, '--no-first-run', '--disable-extensions',
  '--autoplay-policy=no-user-gesture-required', '--window-size=1400,900', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function json(p, opt) {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}${p}`, opt);
      if (r.ok) return await r.json();
    } catch {}
    await sleep(250);
  }
  throw new Error('Edge did not start');
}

let failed = false;
try {
  await json('/json/version');
  const target = await json('/json/new?about:blank', { method: 'PUT' });
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method === 'Runtime.exceptionThrown') errors.push('EXCEPTION ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    else if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) errors.push(m.params.type.toUpperCase() + ' ' + m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
  };
  const send = (method, params = {}) => new Promise((resolve) => { const n = ++id; pending.set(n, resolve); ws.send(JSON.stringify({ id: n, method, params })); });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url });
  const evalJs = async (expression, timeout = 240000) => {
    const r = await Promise.race([send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }), sleep(timeout).then(() => ({ timeout: true }))]);
    if (r.timeout) throw new Error('evaluate timed out');
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
    return r.result?.result?.value;
  };
  for (let i = 0; i < 80; i++) {
    if (await evalJs('document.body.classList.contains("ready")').catch(() => false)) break;
    await sleep(250);
  }
  await sleep(1500);
  if (expr) {
    console.log(await evalJs(`(async () => { ${expr} })()`));
  } else {
    const list = only ? JSON.stringify(only) : 'null';
    const results = await evalJs(`(async () => { const sim = await import('/tools/sim.js'); const only = ${list}; if (!only) return await sim.runAll(); for (const n of only) { try { await sim[n](); } catch (e) { sim.results.push({ name: n + ' threw', ok: false, detail: String(e.stack || e) }); } } return sim.results; })()`);
    for (const r of results) {
      if (!r.ok) failed = true;
      console.log((r.ok ? 'PASS  ' : 'FAIL  ') + r.name + (r.ok ? '' : '\n        ' + r.detail));
    }
    console.log(results.filter((r) => r.ok).length + ' of ' + results.length + ' passed');
  }
  if (shot) {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync('work', { recursive: true });
    fs.writeFileSync(path.resolve('work', shot + '.png'), Buffer.from(r.result.data, 'base64'));
    console.log('screenshot work/' + shot + '.png');
  }
  if (errors.length) console.log('--- page errors/warnings\n' + [...new Set(errors)].slice(0, 20).join('\n'));
  ws.close();
} catch (e) {
  failed = true;
  console.error('run-sim failed:', e.message);
} finally {
  edge.kill();
  await sleep(400);
  try { fs.rmSync(userDir, { recursive: true, force: true }); } catch {}
}
process.exit(failed ? 1 : 0);
