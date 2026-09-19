// Final supplement: P1-2 (CTA hover/press) & P1-7 (nav hover) via REAL mouse
// events — the deterministic method already proven in round 1.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PROJECT = process.cwd();
const OUT = join(PROJECT, 'verify-output');
const CDP_PORT = 9229;
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
await sleep(3000);

// Fresh app lands on Play view; grab CTA & inactive nav button centers.
const targets = await evalIn(cdp, `(() => {
  const cta = document.querySelector('.cta-image-btn');
  const r1 = cta?.getBoundingClientRect();
  const nav = [...document.querySelectorAll('nav button')].find(b => b.textContent.includes('Account') && !b.hasAttribute('aria-current'));
  const r2 = nav?.getBoundingClientRect();
  return {
    cta: r1 ? { x: r1.x + r1.width/2, y: r1.y + r1.height/2 } : null,
    nav: r2 ? { x: r2.x + r2.width/2, y: r2.y + r2.height/2 } : null,
  };
})()`);

const readCta = `(() => { const s = getComputedStyle(document.querySelector('.cta-image-btn')); return { transform: s.transform, filter: s.filter }; })()`;
const readNav = `(() => { const b = [...document.querySelectorAll('nav button')].find(x => x.textContent.includes('Account') && !x.hasAttribute('aria-current')); const s = getComputedStyle(b); return { bg: s.backgroundColor, color: s.color }; })()`;
const shot = async (name) => {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, name), Buffer.from(data, 'base64'));
};
const move = (x, y) => cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });

const log = [];
const report = (line) => { log.push(line); console.log(line); };

// ── P1-7: nav hover with real mouse movement ─────────────────────────
const navRest = await evalIn(cdp, readNav);
await move(10, 10); await sleep(200);
await shot('16-p1-7-nav-rest-final.png');
await move(targets.nav.x, targets.nav.y); await sleep(400);
const navHover = await evalIn(cdp, readNav);
await shot('17-p1-7-nav-hover-final.png');
const navOk = navHover.bg.includes('0.03') && navHover.bg !== navRest.bg;
report(`P1-7 nav: bg ${navRest.bg} → ${navHover.bg}, color ${navRest.color} → ${navHover.color} → ${navOk ? 'FIXED' : 'STILL BROKEN'}`);

// ── P1-2: CTA rest / hover / press with real mouse ───────────────────
await move(10, 10); await sleep(400); // leave nav to clear :active/:hover
const ctaRest = await evalIn(cdp, readCta);
await shot('18-p1-2-cta-rest-final.png');
await move(targets.cta.x, targets.cta.y); await sleep(500);
const ctaHover = await evalIn(cdp, readCta);
await shot('19-p1-2-cta-hover-final.png');
// press and HOLD → :active stays active
await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: targets.cta.x, y: targets.cta.y, button: 'left', clickCount: 1 });
await sleep(500);
const ctaActive = await evalIn(cdp, readCta);
await shot('20-p1-2-cta-press-final.png');
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: targets.cta.x, y: targets.cta.y, button: 'left', clickCount: 1 });
const ctaOk = ctaHover.transform.includes('1.05') && ctaHover.filter.includes('brightness(1.15)')
  && ctaActive.transform.includes('0.97') && ctaRest.transform !== ctaHover.transform;
report(`P1-2 CTA: rest=${ctaRest.transform} hover=${ctaHover.transform} active=${ctaActive.transform}`);
report(`P1-2 CTA filter hover: ${ctaHover.filter} → ${ctaOk ? 'FIXED' : 'STILL BROKEN'}`);

await sleep(300);
try { proc.kill(); } catch {}
console.log('\nFINAL:', log.filter(l => l.includes('FIXED') || l.includes('BROKEN')).join(' | '));
process.exit(0);
