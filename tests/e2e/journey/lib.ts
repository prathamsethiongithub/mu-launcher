/**
 * Journey-hunt instrumentation — the consumer-journey test library.
 *
 * Extends the persona lib's fetch-injection tradition with two capabilities
 * the journeys need:
 *
 * 1. SLOWED BODY STREAMS — for kill-mid-download we need a download whose
 *    body takes ~40s to arrive. patchMainFetch can only fail fast or answer
 *    instantly. This patch answers headers immediately, then drips N chunks
 *    at a fixed rate, so a process.kill() at any of 30/60/90% lands inside
 *    the stream. Test-side only: production code is never touched.
 *
 * 2. MSMC AUTH-CHAIN CANNING — msmc does not use Node's global fetch (it
 *    requires its own node-fetch), so patchMainFetch cannot see the
 *    token-refresh chain. We instead reach the REAL Auth class through the
 *    running main process's Module._cache (msmc is require-external in the
 *    esbuild bundle) and patch Auth.prototype.launch/.refresh. Identity
 *    Service's contract with the chain is structural (xbox.save(),
 *    minecraft.profile, minecraft.mclc()) — it never inspects values — so a
 *    canned chain is indistinguishable to it, and updateSession() really
 *    persists through saveTokens(). This gives us BOTH directions: seeding
 *    real encrypted tokens via the real addMicrosoftAccount path, and
 *    canning the refresh verdict.
 *
 * No egress is required anywhere: every URL the launcher touches during the
 * seeded journeys is answered from canned bodies.
 */

import type { ElectronApplication } from 'playwright';

/** A canned body that plays back slowly, chunk by chunk. */
export interface SlowBody {
  chunks: number;
  chunkBytes: number;
  intervalMs: number;
}

export type StreamRule =
  | { match: string; status: number; slow: SlowBody; contentType?: string }
  /** A fast, exact-size BINARY body (no JSON envelope) — for canned jars
   *  where the byte count is the contract (e.g. a resumed download). */
  | { match: string; status: number; bytes: number; contentType?: string }
  /** Never settles, and deliberately IGNORES the abort signal — a caller
   *  with a timeout (timedFetch) cannot time out a promise that never
   *  rejects. Used to pin an in-flight pipeline open with ZERO egress: the
   *  launch pipeline's first await is ensureFabric's timedFetch, so a hang
   *  here holds `launchInProgress` true for the whole observation window. */
  | { match: string; status: number; hang: true }
  /** Fails immediately with no egress — lets a pipeline settle on its own
   *  typed error instead of hanging on a real download. */
  | { match: string; status: number; reject: true }
  | { match: string; status: number; body: unknown; contentType?: string };

/** Inject into the MAIN process: intercept the given URL substrings and
 *  either drip-feed a slow body or answer instantly. Anything not matched
 *  falls through to the real fetch. */
export async function patchMainNetworkStream(
  app: ElectronApplication,
  rules: StreamRule[],
): Promise<void> {
  await app.evaluate(
    ({ }, cfg: StreamRule[]) => {
      // Preserve the ORIGINAL fetch once. Re-patching (multi-boot tests) must
      // compose onto the original, not onto the previous patch — binding the
      // current g.fetch here again would stack wrappers and, on the next
      // patch, strand the old ruleset behind an unreachable closure.
      const g = globalThis as unknown as { fetch: typeof fetch; __realFetch?: typeof fetch };
      if (g.__realFetch === undefined) g.__realFetch = g.fetch.bind(globalThis);
      const realFetch = g.__realFetch;
      const patched: typeof fetch = async (input, init) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        for (const rule of cfg) {
          if (!url.includes(rule.match)) continue;
          if ('reject' in rule) {
            // Fail fast, no egress: the caller sees a network error and can
            // settle on its own typed [E4xx]/[E3xx] verdict.
            throw new Error(`[e2e] network rejected: ${url}`);
          }
          if ('hang' in rule) {
            // A promise that never settles AND ignores the abort signal, so
            // a timeout-wrapped caller still hangs. No bytes ever leave.
            return new Promise<Response>(() => { /* pending forever */ });
          }
          if ('bytes' in rule) {
            const payload = new Uint8Array(rule.bytes);
            for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;
            return new Response(payload, {
              status: rule.status,
              headers: { 'content-type': rule.contentType ?? 'application/octet-stream' },
            });
          }
          if ('slow' in rule) {
            // Headers now; body drips in over slow.intervalMs * chunks.
            const total = rule.slow.chunks * rule.slow.chunkBytes;
            const encoder = new TextEncoder();
            const template = encoder.encode('0123456789abcdef');
            let sent = 0;
            const bodyStream = new ReadableStream<Uint8Array>({
              start(controller) {
                const drip = async (): Promise<void> => {
                  while (sent < total) {
                    await new Promise((r) => setTimeout(r, rule.slow.intervalMs));
                    const n = Math.min(rule.slow.chunkBytes, total - sent);
                    const piece = new Uint8Array(n);
                    for (let i = 0; i < n; i++) piece[i] = template[(sent + i) % template.length];
                    controller.enqueue(piece);
                    sent += n;
                  }
                  controller.close();
                };
                void drip();
              },
            });
            return new Response(bodyStream, {
              status: rule.status,
              headers: { 'content-type': rule.contentType ?? 'application/octet-stream' },
            });
          }
          const body = JSON.stringify(rule.body);
          return new Response(body, {
            status: rule.status,
            headers: { 'content-type': rule.contentType ?? 'application/json' },
          });
        }
        return realFetch(input as Parameters<typeof fetch>[0], init);
      };
      g.fetch = patched;
    },
    rules as unknown,
  );
}

/** Install a REPLACABLE clock shim. patchMainClock is idempotent-safe across
 *  calls: the original Date.now is captured once (on the first install) and
 *  stored on globalThis so a later call with offset 0 genuinely restores it.
 *  (The previous implementation captured the CURRENT Date.now — which, on a
 *  second call, was already the patched one: the "restore" re-wrapped the
 *  patch, so the shifted clock NEVER came back. That silent trap invalidated
 *  every downstream contract in expired-token.spec.ts — validateSession saw
 *  a still-shifted now and skipped the expiry branch entirely.)
 *
 *  Only the static clock moves — setTimeout/setInterval stay relative, and
 *  new Date().toISOString() of the CURRENT instant is also derived from the
 *  shifted now, exactly the world a back-dated machine sees. */
export async function shiftMainClock(app: ElectronApplication, offsetMs: number): Promise<void> {
  await app.evaluate(({ }, off: number) => {
    const g = globalThis as unknown as { __realDateNow?: () => number };
    if (g.__realDateNow === undefined) {
      g.__realDateNow = Date.now.bind(Date);
    }
    const realNow = g.__realDateNow;
    Date.now = () => realNow() + off;
  }, offsetMs);
}

/** Canned Modrinth bodies for the kill-mid-download journey. The jar URL is
 *  a matched-injection host — it never needs to resolve for real. */
export const MODRINTH_CANNED = {
  versionList: {
    match: 'api.modrinth.com/v2/project/journey-mod/version',
    status: 200,
    body: [
      {
        id: 'journey-ver-1',
        version_number: '1.0.0',
        files: [{ url: 'https://journey-hunt.invalid/jar', filename: 'journey-mod.jar', primary: true }],
        game_versions: ['1.21.1'],
        loaders: ['fabric'],
      },
    ],
  },
  jar: { match: 'journey-hunt.invalid/jar', status: 200 },
};

/** Slow-body spec: total = chunks × chunkBytes, paced at intervalMs per chunk.
 *  100ms/chunk → 163,840 B/s: the 90% kill threshold (2.36 MB) arrives at
 *  ~14.4s — comfortably inside the test's 30s growth-poll window. (The
 *  original 250ms/chunk needed 36s to reach 90% — a threshold the poll
 *  window could NEVER see: the test was unsatisfiable by construction.) */
export function jarSlowBody(chunks: number, chunkBytes: number): SlowBody {
  return { chunks, chunkBytes, intervalMs: 100 };
}

/** Deterministic veteran identity the fake chain reports to the launcher. */
export const JOURNEY_VETERAN = {
  uuid: 'journey-veteran-uuid-0001',
  name: 'journey-veteran',
};

/**
 * Patch the REAL msmc Auth class inside the running main process so the
 * auth chain is canned:
 *
 *  - launch('electron', …) resolves immediately (no OAuth popup) — used by
 *    addMicrosoftAccount to MINT REAL encrypted tokens through the real
 *    updateSession/saveTokens path, with our deterministic profile.
 *  - refresh(refreshToken) resolves (refresh-ok) or rejects (refresh-fail).
 *
 * Must mutate the SAME exports object the bundled code captured at load
 * time — replacing Module._cache[k].exports would only affect future
 * require() callers, not identity-service's captured reference.
 */
export async function installMsmcCannedChain(
  app: ElectronApplication,
  mode: 'refresh-ok' | 'refresh-fail',
): Promise<void> {
  await app.evaluate(
    ({ }, m: { mode: 'refresh-ok' | 'refresh-fail'; uuid: string; name: string }) => {
      const fakeMinecraft = () => ({
        profile: { id: m.uuid, name: m.name },
        mclc: () => ({ access_token: 'canned-mc-access-token' }),
      });
      const fakeXbox = () => ({
        save: () => 'canned-refresh-token-NEW',
        getMinecraft: async () => fakeMinecraft(),
      });

      // msmc's exports are TS-transpiled getter-only properties (Object
      // .defineProperty with a get, no setter) — they can NOT be assigned.
      // But the getter hands back the REAL Auth class, and a class's
      // prototype is plain-mutable: patching .launch/.refresh intercepts
      // every instance identity-service ever builds (it reads msmc.Auth per
      // call site, so the getter path keeps working untouched).
      const cannedVerdict = (mode: string): unknown => {
        if (mode === 'refresh-fail') {
          throw new Error('[canned-msmc] refresh rejected by Microsoft');
        }
        return fakeXbox();
      };

      // esbuild bundles the launcher main but keeps msmc EXTERNAL (require is
      // preserved in out/main/index.js) — the cache entry exists at boot.
      // NOTE: evaluate() runs its function body in the MAIN process's GLOBAL
      // scope — `require` is a CJS wrapper local there and does NOT exist in
      // this scope. Electron also loads its entry through the 'electron'
      // stub, whose require is a bare function (no .resolve/.cache). But the
      // stub module's CONSTRUCTOR is the real Module class — its _cache is
      // the very registry out/main/index.js populated at boot. Locate msmc
      // by path segment (resolved keys end like node_modules/msmc/dist/…).
      const entryMod = process.mainModule as unknown as
        { constructor: { _cache: Record<string, { exports: Record<string, unknown> }> } }
        | undefined;
      if (!entryMod) {
        throw new Error('[e2e] no process.mainModule — app is not a CJS entry?');
      }
      const cache = entryMod.constructor._cache;
      const msmcKey = Object.keys(cache).find((k) =>
        k.replace(/\\/g, '/').includes('/node_modules/msmc/'),
      );
      if (!msmcKey) {
        throw new Error('[e2e] msmc not found in require cache — layout changed?');
      }
      const RealAuth = cache[msmcKey].exports.Auth as new (
        ...args: unknown[]
      ) => {
        launch: (...a: unknown[]) => Promise<unknown>;
        refresh: (...a: unknown[]) => Promise<unknown>;
      };
      if (typeof RealAuth !== 'function') {
        throw new Error('[e2e] msmc exports.Auth is not a class — layout changed?');
      }
      RealAuth.prototype.launch = async function (...a: unknown[]) {
        void a;
        return cannedVerdict('refresh-ok'); // launch always mints a fresh chain
      };
      RealAuth.prototype.refresh = async function (...a: unknown[]) {
        void a;
        return cannedVerdict(m.mode);
      };
    },
    { mode, uuid: JOURNEY_VETERAN.uuid, name: JOURNEY_VETERAN.name },
  );
}

/**
 * Shift the main process's Date.now() by the given offset (ms). Only the
 * static clock moves — setTimeout/setInterval stay relative, and new Date()
 * parsing of stored ISO strings is unaffected — so the launcher's expiry
 * comparisons see a "4 days later" world while every timer behaves.
 */

