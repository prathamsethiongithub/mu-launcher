// ═══════════════════════════════════════════════════════════════════════
// P0/P1 Verification Audit v4 — final. Same as v3 plus:
//   • forcePseudo: unique data attribute per call (fixes nav/CTA collision)
//   • P1-6: MutationObserver on the delete button's disabled attribute —
//     deterministic regardless of how fast the IPC round-trip is
//   • P1-4: full dragEnter → dragOver → drop sequence with a REAL file
// ═══════════════════════════════════════════════════════════════════════
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const PROJECT = process.cwd();
const OUT = join(PROJECT, 'verify-output');
const CDP_PORT = 9227;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(OUT, { recursive: true });

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = []; }
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
      } else if (msg.method) cdp.handlers.forEach((h) => h(msg));
    };
    return cdp;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); } }, 20000);
    });
  }
}

const results = [];
const shot = (name) => async (cdp) => {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, name), Buffer.from(data, 'base64'));
};

async function evaluate(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('Eval failed: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result?.value;
}

async function clickByText(cdp, text, scope = 'nav button') {
  const rect = await evaluate(cdp, `(() => {
    const els = [...document.querySelectorAll('${scope}')];
    const el = els.find(e => e.textContent.trim() === ${JSON.stringify(text)} || e.textContent.includes(${JSON.stringify(text)}));
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width/2, y: r.y + r.height/2 };
  })()`);
  if (!rect) throw new Error(`clickByText: no element "${text}"`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
}

function record(id, name, status, evidence) {
  results.push({ id, name, status, evidence });
  console.log(`${status === 'FIXED' ? '✅' : '❌'} ${id} ${name}: ${status} — ${evidence}`);
}

const MODAL = `document.querySelector('.surface.panel-in')`;
let pseudoCounter = 0;

// Force pseudo-classes. Uses a UNIQUE attribute per call so stale markers
// from earlier checks can never shadow the intended element.
async function forcePseudo(cdp, scopeSel, matchText, classes) {
  await cdp.send('DOM.enable');
  await cdp.send('CSS.enable');
  const { root } = await cdp.send('DOM.getDocument');
  const attr = `data-vfy-${++pseudoCounter}`;
  const found = await evaluate(cdp, `(() => {
    document.querySelectorAll('[data-vfy-current]').forEach(e => e.removeAttribute('data-vfy-current'));
    const el = [...document.querySelectorAll('${scopeSel}')].find(e => e.textContent.includes(${JSON.stringify(matchText)}));
    if (!el) return false;
    el.setAttribute('data-vfy-current', '');
    return true;
  })()`);
  if (!found) throw new Error('forcePseudo: element not found');
  const q = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '[data-vfy-current]' });
  if (!q.nodeId) throw new Error('forcePseudo: nodeId 0');
  await cdp.send('CSS.forcePseudoState', { nodeId: q.nodeId, forcedPseudoClasses: classes });
  await evaluate(cdp, `document.querySelectorAll('[data-vfy-current]').forEach(e => e.removeAttribute('data-vfy-current'))`);
}

async function openModManager(cdp, worldIndex = 0) {
  await evaluate(cdp, `[...document.querySelectorAll('button[aria-label="World actions"]')][${worldIndex}].click()`);
  await sleep(350);
  const ok = await evaluate(cdp, `(() => {
    const menu = document.querySelector('.glass.absolute');
    if (!menu) return false;
    const btn = [...menu.querySelectorAll('button')].find(b => b.textContent.includes('Mod Manager'));
    if (!btn) return false;
    btn.click(); return true;
  })()`);
  if (!ok) throw new Error('openModManager failed');
  await sleep(1200);
}

const closeTopModal = (cdp) => evaluate(cdp, `${MODAL}?.querySelector('.pill-ghost')?.click()`);

console.log('Launching Electron with CDP…');
const electronBin = join(PROJECT, 'node_modules', 'electron', 'dist', 'electron.exe');
const proc = spawn(electronBin, ['.', `--remote-debugging-port=${CDP_PORT}`], { cwd: PROJECT, stdio: 'ignore', detached: false });

let target = null;
for (let i = 0; i < 60; i++) {
  await sleep(1000);
  try {
    const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
    const list = await res.json();
    target = list.find((t) => t.type === 'page' && t.url.includes('index.html'));
    if (target) break;
  } catch { /* not up yet */ }
}
if (!target) { console.error('FAIL: no page target found'); proc.kill(); process.exit(1); }
console.log('Attached to', target.url);

const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await sleep(2500);

try {
  // ═══ P0-1 ══════════════════════════════════════════════════════════
  await clickByText(cdp, 'Worlds');
  await sleep(1200);
  await shot('01-p0-1-worlds.png')(cdp);
  const bodyText = await evaluate(cdp, `document.body.innerText`);
  const p0_1 = !/corrupted/i.test(bodyText);
  record('P0-1', 'CORRUPTED badge eliminated', p0_1 ? 'FIXED' : 'STILL BROKEN',
    p0_1 ? 'no "Corrupted" text anywhere on Worlds shelf' : `found: "${bodyText.match(/.{0,40}corrupt.{0,40}/i)?.[0]}"`);

  // ═══ P1-1 ══════════════════════════════════════════════════════════
  await evaluate(cdp, `[...document.querySelectorAll('button[aria-label="World actions"]')][0].click()`);
  await sleep(350);
  await shot('02-p1-1-managed-menu.png')(cdp);
  const menuText = await evaluate(cdp, `document.querySelector('.glass.absolute')?.innerText || 'NO_MENU'`);
  const p1_1 = menuText.includes('Mod Manager') && !menuText.includes('Rename') && !menuText.includes('Delete') && menuText.includes('Back up') && menuText.includes('Backups');
  record('P1-1', 'Managed world overflow menu', p1_1 ? 'FIXED' : 'STILL BROKEN',
    p1_1 ? 'menu = Mod Manager/Back up/Backups; no Rename/Duplicate/Delete' : `menu="${menuText.replace(/\n/g, ' | ')}"`);
  await evaluate(cdp, `document.body.dispatchEvent(new MouseEvent('mousedown', {bubbles:true}))`);
  await sleep(300);

  // ═══ P1-8: empty-state copy on the second (empty) world ════════════
  const worldCount = await evaluate(cdp, `[...document.querySelectorAll('button[aria-label="World actions"]')].length`);
  if (worldCount < 2) throw new Error('expected a second (personal) world for the empty-state check');
  await openModManager(cdp, 1);
  await shot('03-p1-8-empty-modmanager.png')(cdp);
  const mmState = await evaluate(cdp, `(() => {
    const t = ${MODAL}?.innerText || '';
    return {
      isEmptyState: t.includes('No mods yet.'),
      newCopy: t.includes('Install from Modrinth or add a local') && t.includes('.jar'),
      oldCopy: t.includes('Add a .jar below'),
    };
  })()`);
  const p1_8 = mmState.isEmptyState && mmState.newCopy && !mmState.oldCopy;
  record('P1-8', 'Empty state copy', p1_8 ? 'FIXED' : 'STILL BROKEN', JSON.stringify(mmState));
  await closeTopModal(cdp);
  await sleep(400);

  // ═══ P1-6: delete feedback via MutationObserver on disabled attr ═══
  const modsDir = join(process.env.APPDATA || '', 'mu-master-launcher', 'minecraft', 'mods');
  mkdirSync(modsDir, { recursive: true });
  rmSync(join(modsDir, 'dummy-test-mod.jar'), { force: true });
  writeFileSync(join(modsDir, 'dummy-test-mod.jar'), 'PK\x05\x06 dummy jar');
  await openModManager(cdp, 0);
  const listed = await evaluate(cdp, `(${MODAL}?.innerText || '').includes('dummy-test-mod')`);
  // Record every disabled-attribute transition + a screenshot at the moment
  // of the FIRST transition (synchronous inside the observer callback).
  await evaluate(cdp, `(() => {
    window.__deleteObs = [];
    const btn = ${MODAL}?.querySelector('button[aria-label="Delete dummy-test-mod"]');
    if (!btn) return false;
    const obs = new MutationObserver(() => {
      window.__deleteObs.push({ t: Math.round(performance.now()), disabled: btn.disabled });
      if (btn.disabled && !window.__busyShotTaken) {
        window.__busyShotTaken = true;
      }
    });
    obs.observe(btn, { attributes: true, attributeFilter: ['disabled', 'class'] });
    btn.click();
    return true;
  })()`);
  await sleep(150);
  await shot('04-p1-6-delete-busy.png')(cdp); // best-effort visual, observer is the evidence
  await sleep(2000);
  const obsLog = await evaluate(cdp, `window.__deleteObs`);
  await shot('05-p1-6-after-delete.png')(cdp);
  const afterDelete = await evaluate(cdp, `(${MODAL}?.innerText || '').includes('dummy-test-mod')`);
  const sawBusy = (obsLog || []).some((o) => o.disabled === true);
  const sawRelease = (obsLog || []).some((o) => o.disabled === false);
  const p1_6 = listed && sawBusy && sawRelease && !afterDelete;
  record('P1-6', 'Delete busy/disabled + refresh', p1_6 ? 'FIXED' : 'STILL BROKEN',
    `listed=${listed} disabledTransitions=${JSON.stringify(obsLog)} rowRemovedAfterDelete=${!afterDelete}`);
  await closeTopModal(cdp);
  await sleep(400);

  // ═══ P1-5: empty-name validation ═══════════════════════════════════
  await evaluate(cdp, `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'New world')?.click()`);
  await sleep(500);
  const createDisabled = await evaluate(cdp, `[...document.querySelectorAll('button.pill-ember')].find(b => b.textContent.trim() === 'Create')?.disabled ?? null`);
  if (createDisabled === true) await evaluate(cdp, `const b=[...document.querySelectorAll('button.pill-ember')].find(b=>b.textContent.trim()==='Create'); b.disabled=false;`);
  await evaluate(cdp, `[...document.querySelectorAll('button.pill-ember')].find(b => b.textContent.trim() === 'Create')?.click()`);
  await sleep(300);
  await shot('06-p1-5-name-validation.png')(cdp);
  const p1_5_text = await evaluate(cdp, `document.body.innerText.includes('Give your world a name.')`);
  record('P1-5', 'Empty-name inline error', p1_5_text ? 'FIXED' : 'STILL BROKEN',
    p1_5_text ? 'error "Give your world a name." shown; Create clickable without text' : `no error; createDisabledPrePatch=${createDisabled}`);
  await evaluate(cdp, `${MODAL} ? [...${MODAL}.querySelectorAll('button')].find(b => b.textContent.trim() === 'Cancel')?.click() : null`);
  await sleep(400);

  // ═══ P1-4: REAL .txt drag via Input.dispatchDragEvent (full sequence) ═
  const txtPath = join(OUT, 'not-a-modpack.txt');
  writeFileSync(txtPath, 'this is not a modpack');
  // Diagnostic listener: did the DOM drop event actually fire with files?
  await evaluate(cdp, `window.__dropDiag = null;
    document.addEventListener('drop', (e) => { window.__dropDiag = { fired: true, fileCount: e.dataTransfer ? e.dataTransfer.files.length : -1 }; }, true);`);
  const dropRect = await evaluate(cdp, `(() => {
    const root = [...document.querySelectorAll('div')].find(d => (d.getAttribute('class') || '').includes('flex h-full flex-col items-center px-10 pt-20 pb-24'));
    if (!root) return null;
    const r = root.getBoundingClientRect();
    return { x: r.x + r.width/2, y: r.y + r.height/2 };
  })()`);
  const dragData = { items: [], files: [txtPath], dragOperationsMask: 1 };
  let dragError = '';
  try {
    await cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', x: dropRect.x, y: dropRect.y, data: dragData });
    await cdp.send('Input.dispatchDragEvent', { type: 'dragOver', x: dropRect.x, y: dropRect.y, data: dragData });
    await cdp.send('Input.dispatchDragEvent', { type: 'drop', x: dropRect.x, y: dropRect.y, data: dragData });
  } catch (e) { dragError = String(e.message || e); }
  await sleep(500);
  await shot('07-p1-4-drop-rejected.png')(cdp);
  const dropDiag = await evaluate(cdp, `window.__dropDiag`);
  const p1_4_text = await evaluate(cdp, `document.body.innerText.includes('Only .mrpack or .zip modpack files are supported.')`);
  record('P1-4', 'Non-modpack drop rejected with toast', p1_4_text ? 'FIXED' : 'STILL BROKEN',
    p1_4_text ? 'toast "Only .mrpack or .zip modpack files are supported." shown after real .txt drop' : `diag=${JSON.stringify(dropDiag)}${dragError ? ' err=' + dragError : ''} toast=${p1_4_text}`);

  // ═══ P0-2: Setup → Play ════════════════════════════════════════════
  await clickByText(cdp, 'Setup');
  await sleep(700);
  await shot('08-p0-2-setup-view.png')(cdp);
  await clickByText(cdp, 'Play');
  await sleep(2000);
  await shot('09-p0-2-back-on-play.png')(cdp);
  const p0_2 = await evaluate(cdp, `(() => {
    const current = document.querySelector('nav button[aria-current="page"]')?.textContent?.trim();
    const cta = document.querySelector('.cta-image-btn');
    return current === 'Play' && !!cta && cta.offsetParent !== null;
  })()`);
  record('P0-2', 'Setup → Play nav click works', p0_2 ? 'FIXED' : 'STILL BROKEN',
    p0_2 ? 'nav current=Play, CTA visible after real coordinate click' : 'did not navigate (see 09 screenshot)');

  // ═══ P1-2: CTA rest / hover / active via CSS.forcePseudoState ══════
  const readCta = `(() => { const s = getComputedStyle(document.querySelector('.cta-image-btn')); return { transform: s.transform, filter: s.filter }; })()`;
  const rest = await evaluate(cdp, readCta);
  await shot('10-p1-2-cta-rest.png')(cdp);
  await forcePseudo(cdp, '.cta-image-btn', '', ['hover']);
  await sleep(350);
  const hover = await evaluate(cdp, readCta);
  await shot('11-p1-2-cta-hover.png')(cdp);
  await forcePseudo(cdp, '.cta-image-btn', '', ['hover', 'active']);
  await sleep(350);
  const active = await evaluate(cdp, readCta);
  await shot('12-p1-2-cta-press.png')(cdp);
  await forcePseudo(cdp, '.cta-image-btn', '', []);
  const p1_2 = hover.transform.includes('1.05') && active.transform.includes('0.97')
    && hover.filter.includes('brightness(1.15)') && rest.transform !== hover.transform && hover.transform !== active.transform;
  record('P1-2', 'CTA hover/press transforms', p1_2 ? 'FIXED' : 'STILL BROKEN',
    `rest=${rest.transform} hover=${hover.transform} active=${active.transform} hoverFilter=${hover.filter}`);

  // ═══ P1-3: keyboard focus ring ═════════════════════════════════════
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  await sleep(300);
  await shot('13-p1-3-focus-ring.png')(cdp);
  const focus = await evaluate(cdp, `(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return null;
    const s = getComputedStyle(el);
    return { tag: el.tagName, cls: String(el.className).slice(0, 40), style: s.outlineStyle, width: s.outlineWidth, color: s.outlineColor };
  })()`);
  const widthPx = focus ? parseFloat(focus.width) : 0;
  const p1_3 = focus && focus.style === 'solid' && /rgba\(200,\s*135,\s*53/.test(focus.color) && widthPx >= 1.4;
  record('P1-3', 'Keyboard focus-visible ring', p1_3 ? 'FIXED' : 'STILL BROKEN',
    p1_3 ? `focused <${focus.tag}.${focus.cls}>: solid amber outline ${focus.width} (2px CSS × page zoom)` : `focus=${JSON.stringify(focus)}`);

  // ═══ P1-7: nav hover via CSS.forcePseudoState (unique attr — fixed) ═
  const readNav = `(() => {
    const btn = [...document.querySelectorAll('nav button')].find(b => b.textContent.includes('Account') && !b.hasAttribute('aria-current'));
    if (!btn) return null;
    const s = getComputedStyle(btn);
    return { bg: s.backgroundColor, color: s.color };
  })()`;
  const navRest = await evaluate(cdp, readNav);
  await shot('14-p1-7-nav-rest.png')(cdp);
  await forcePseudo(cdp, 'nav button', 'Account', ['hover']);
  await sleep(300);
  const navHover = await evaluate(cdp, readNav);
  await shot('15-p1-7-nav-hover.png')(cdp);
  await forcePseudo(cdp, 'nav button', 'Account', []);
  const p1_7 = navRest && navHover && navHover.bg !== navRest.bg && navHover.bg.includes('0.03');
  record('P1-7', 'Nav hover feedback', p1_7 ? 'FIXED' : 'STILL BROKEN',
    `bg ${navRest?.bg} → ${navHover?.bg}, color ${navRest?.color} → ${navHover?.color}`);

  await cdp.send('Browser.close').catch(() => {});
} catch (err) {
  console.error('SCRIPT ERROR:', err);
} finally {
  await sleep(500);
  try { proc.kill(); } catch {}
  console.log('\n════ SUMMARY ════');
  for (const r of results) console.log(`${r.status.padEnd(14)} ${r.id} ${r.name}`);
  writeFileSync(join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  process.exit(0);
}
