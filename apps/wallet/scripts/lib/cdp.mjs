// Shared CDP plumbing for the verify-*.mjs drivers — the one copy of the
// "same recipe" block that used to be pasted into every driver. Drivers stay
// self-contained-except-Chrome(-and-this-lib): each still owns its stubs,
// scenario, and checks. Zero-dep (global WebSocket, Node 22+).
//
// Usage:
//   import { connectCdp } from './lib/cdp.mjs';
//   const b = await connectCdp();           // needs headless Chrome on :9224
//   await b.navigate(APP);
//   await b.waitFor(`document.getElementById('x')`, 'x renders');
//   b.check(await b.evaluate(b.text('x')) === 'y', 'x says y');
//   await b.shot('42-scenario.png');        // written to cwd — run from /tmp
//   b.close();
//   process.exit(process.exitCode || 0);
import { writeFileSync } from 'node:fs';

export async function connectCdp({ port = Number(process.env.CDP_PORT) || 9224, out = './' } = {}) {
  const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let msgId = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
  };
  const cdp = (method, params = {}, sid) => {
    const id = ++msgId;
    ws.send(JSON.stringify({ id, method, params, sessionId: sid }));
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  };
  let step = 0;
  const check = (cond, what) => { step++; console.log(`${cond ? '✅' : '❌'} ${step}. ${what}`); if (!cond) process.exitCode = 1; };

  // Each target (browser tab) gets its own session-bound helpers; drivers
  // that need a second, fresh tab call newTarget() again.
  async function newTarget() {
    const { targetId } = await cdp('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
    await cdp('Page.enable', {}, sessionId);

    async function evaluate(expression) {
      const { result, exceptionDetails } = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
      if (exceptionDetails) throw new Error('page threw: ' + (exceptionDetails.exception?.description || exceptionDetails.text));
      return result.value;
    }
    async function waitFor(expr, label, timeoutMs = 20000) {
      const t0 = Date.now();
      const guarded = `(() => { try { return !!(${expr}); } catch { return false; } })()`;
      while (Date.now() - t0 < timeoutMs) {
        if (await evaluate(guarded)) return;
        await new Promise((r) => setTimeout(r, 150));
      }
      throw new Error('timeout: ' + label);
    }
    async function shot(name) {
      const { data } = await cdp('Page.captureScreenshot', { format: 'png' }, sessionId);
      writeFileSync(out + name, Buffer.from(data, 'base64'));
      console.log('  [screenshot]', name);
    }
    return {
      cdp: (method, params = {}) => cdp(method, params, sessionId),
      navigate: (url) => cdp('Page.navigate', { url }, sessionId),
      evaluate,
      waitFor,
      shot,
      check,
      text: (id) => `document.getElementById('${id}').textContent`,
      setVal: (id, v) => evaluate(`{ const el = document.getElementById('${id}'); el.value = ${JSON.stringify(v)}; el.dispatchEvent(new Event('input',{bubbles:true})); }`),
      click: (id) => evaluate(`document.getElementById('${id}').click()`),
      newTarget,
      close: () => ws.close(),
    };
  }
  return newTarget();
}
