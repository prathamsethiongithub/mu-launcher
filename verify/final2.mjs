// Deterministic supplement v2: kill all CSS transitions, then read forced
// pseudo-state computed values. No animation timing races possible.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PROJECT = process.cwd();
const OUT = join(PROJECT, 'verify-output');
const CDP_PORT = 9231;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const cdp = new Cdp(ws);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && cdp.pending.has(msg.id)) {
        const { resolve, reject } = cdp.pending.get(msg.id);
        cdp.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      }
    };
    return cdp;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`timeout ${method}`)); } }, 15000);
    });
  }
}

const evalIn = async (cdp, expression) => {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true });
  return r.result?.value;
};

const electronBin = join(PROJECT, 'node_modules', 'electron', 'dist', 'electron.exe');
const proc = spawn(electronBin, ['.', `--remote-debugging-port=${CDP_PORT}`], { cwd: PROJECT, stdio: 'ignore' });

let target = null;
for (let i = 0; i < 60; i++) {
  await sleep(1000);
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    target = list.find((t) => t.type === 'page' && t.url.includes('index.html'));
    if (target) break;
  } catch {}
}
const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
await cdp.send('Page.enable');
await cdp.send('Page.bringToFront');
await sleep(3000);

// Kill all transitions/animations → computed style == final target value, instantly.
await evalIn(cdp, `(() => {
  const s = document.createElement('style');
  s.id = 'vfy-no-transitions';
  s.textContent = '*, *::before, *::after { transition: none !important; animation: none !important; }';
  document.head.appendChild(s);
  return true;
})()`);

// Force pseudo via DOM nodeId on the LIVE tree (no view switches happened → nodeIds valid).
async function forcePseudo(selector, classes) {
  await cdp.send('DOM.enable');
  await cdp.send('CSS.enable');
  const { root } = await cdp.send('DOM.getDocument');
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
  if (!nodeId) throw new Error('no nodeId for ' + selector);
  await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: classes });
}

const shot = async (name) => {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, name), Buffer.from(data, 'base64'));
};
const log = [];
const report = (line) => { log.push(line); console.log(line); };

// ── P1-2: CTA rest / hover / press ───────────────────────────────────
const readCta = `(() => { const s = getComputedStyle(document.querySelector('.cta-image-btn')); return { transform: s.transform, filter: s.filter }; })()`;
const rest = await evalIn(cdp, readCta);
await shot('21-p1-2-rest.png');
await forcePseudo('.cta-image-btn', ['hover']);
await sleep(150);
const hover = await evalIn(cdp, readCta);
await shot('22-p1-2-hover.png');
await forcePseudo('.cta-image-btn', ['hover', 'active']);
await sleep(150);
const active = await evalIn(cdp, readCta);
await shot('23-p1-2-press.png');
await forcePseudo('.cta-image-btn', []);
const p12 = hover.transform.includes('1.05') && hover.filter.includes('brightness(1.15)') && active.transform.includes('0.97');
report(`P1-2: rest=${rest.transform} | hover=${hover.transform} filter=${hover.filter} | active=${active.transform} → ${p12 ? 'FIXED' : 'STILL BROKEN'}`);

// ── P1-7: inactive nav hover ─────────────────────────────────────────
const readNav = `(() => {
  const b = [...document.querySelectorAll('nav button')].find(x => x.textContent.includes('Account') && !x.hasAttribute('aria-current'));
  const s = getComputedStyle(b);
  return { bg: s.backgroundColor, color: s.color, cls: b.className.match(/hover:[^ ]+/g) };
})()`;
const navRest = await evalIn(cdp, readNav);
await shot('24-p1-7-rest.png');
await forcePseudo('nav button:nth-child(3)', ['hover']);
await sleep(150);
const navHover = await evalIn(cdp, readNav);
await shot('25-p1-7-hover.png');
await forcePseudo('nav button:nth-child(3)', []);
const p17 = navHover.bg === 'rgba(255, 255, 255, 0.03)' && navHover.bg !== navRest.bg && navHover.color !== navRest.color;
report(`P1-7: rest bg=${navRest.bg} color=${navRest.color} | hover bg=${navHover.bg} color=${navHover.color} | classes=${JSON.stringify(navHover.cls)} → ${p17 ? 'FIXED' : 'STILL BROKEN'}`);

await sleep(300);
try { proc.kill(); } catch {}
writeFileSync(join(OUT, 'supplement-results.json'), JSON.stringify(log, null, 2));
process.exit(0);
