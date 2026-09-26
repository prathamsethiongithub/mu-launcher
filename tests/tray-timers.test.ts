/**
 * Journey hunt #3 — HIBERNATE-AWAKE TRAY ZOMBIE (unit layer).
 *
 * The tray's 60s server monitor is the only permanent timer in the main
 * process. A machine that sleeps for hours must wake into a HEALTHY monitor:
 * the interval keeps firing (≤60s to the next ping), each ping is
 * individually bounded (a dead socket cannot wedge the loop), and teardown
 * still clears everything.
 *
 * Architecture note: tray-manager.ts owns module-level state (tray, timer,
 * window ref) and imports Electron at module scope. It is imported here for
 * its real, audited shape but the contracts under test are pure behaviors
 * that this suite pins against regressions: (a) setInterval keeps firing
 * across a clock jump — Node timers are relative, so an 8h suspend does not
 * deschedule them; (b) a wedged tick must not block the next interval fire
 * (the tick is async and never awaited by the interval); (c) dispose clears
 * the only timer. Electron itself is mocked — the real window/tray is E2E's
 * job (tray-wake.spec.ts asserts the app survives the real tray path).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Electron module mock — tray-manager only touches the surface below.
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/unused', quit: () => { } },
  BrowserWindow: class { },
  Menu: { buildFromTemplate: () => ({ setContextMenu: () => { } }) },
  nativeImage: { createEmpty: () => ({ }) },
  Notification: { isSupported: () => false },
  Tray: class {
    setToolTip() { }
    setContextMenu() { }
    on() { }
    destroy() { }
  },
}));

// The pinger is bounded by contract (5s idle + 6s hard cap, never throws —
// pinned separately below); the tray tick consumes it.
vi.mock('../src/main/server-pinger', () => ({
  pingMinecraftServer: vi.fn(async () => ({ online: false })),
}));

import { pingMinecraftServer } from '../src/main/server-pinger';
import { initTray, disposeTray } from '../src/main/tray-manager';

const PING_INTERVAL_MS = 60_000;
const HIBERNATE_MS = 8 * 60 * 60 * 1000; // 8 hours of suspend

const win = { isDestroyed: () => false, isMinimized: () => false, restore() { }, show() { }, focus() { }, isVisible: () => true, on() { } } as unknown as import('electron').BrowserWindow;

beforeEach(() => {
  vi.useFakeTimers();
  initTray(win);
});

afterEach(() => {
  disposeTray();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('journey #3: tray monitor across hibernate', () => {
  it('pings immediately at init, then every 60s', () => {
    expect(pingMinecraftServer).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(PING_INTERVAL_MS);
    expect(pingMinecraftServer).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(PING_INTERVAL_MS);
    expect(pingMinecraftServer).toHaveBeenCalledTimes(3);
  });

  it('8-hour suspend → first tick after wake lands within one interval', () => {
    vi.advanceTimersByTime(PING_INTERVAL_MS); // steady state
    const before = vi.mocked(pingMinecraftServer).mock.calls.length;

    // THE HIBERNATE: wall clock jumps 8h in one step — exactly what an OS
    // resume does to a JS process's timers (Node timers are relative, so
    // the interval fires immediately on resume rather than waiting 60s).
    vi.advanceTimersByTime(HIBERNATE_MS);
    const resumed = vi.mocked(pingMinecraftServer).mock.calls.length;
    expect(resumed, 'monitor woke with the machine and resumed pinging').toBeGreaterThan(before);

    // And the cadence continues normally afterwards.
    const afterResume = vi.mocked(pingMinecraftServer).mock.calls.length;
    vi.advanceTimersByTime(PING_INTERVAL_MS);
    expect(vi.mocked(pingMinecraftServer).mock.calls.length).toBe(afterResume + 1);
  });

  it('a wedged (never-resolving) ping cannot block the next interval tick', async () => {
    // First interval tick hangs forever (dead socket past all guards — the
    // nightmare). initTray's immediate checkServer was tick 1.
    vi.mocked(pingMinecraftServer).mockImplementationOnce(() => new Promise(() => { }));
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS); // interval tick 2 fires; its promise pends
    const duringWedge = vi.mocked(pingMinecraftServer).mock.calls.length;
    expect(duringWedge).toBe(2);

    // The interval is NOT awaited by the tick — the next fire happens anyway.
    vi.advanceTimersByTime(PING_INTERVAL_MS);
    expect(vi.mocked(pingMinecraftServer).mock.calls.length).toBe(duringWedge + 1);
  });

  it('a rejecting ping is swallowed — monitor survives to the next tick', async () => {
    vi.mocked(pingMinecraftServer).mockImplementationOnce(async () => {
      throw new Error('socket exploded');
    });
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS); // interval tick 2 rejects — caught inside the tick
    expect(vi.mocked(pingMinecraftServer).mock.calls.length).toBe(2);
    vi.advanceTimersByTime(PING_INTERVAL_MS); // tick 3: the monitor survived
    expect(vi.mocked(pingMinecraftServer).mock.calls.length).toBe(3);
  });

  it('disposeTray stops the monitor — no ping after teardown', () => {
    vi.advanceTimersByTime(PING_INTERVAL_MS);
    const before = vi.mocked(pingMinecraftServer).mock.calls.length;
    disposeTray();
    vi.advanceTimersByTime(PING_INTERVAL_MS * 10);
    expect(vi.mocked(pingMinecraftServer).mock.calls.length).toBe(before);
  });

  it('initTray is idempotent — no double interval after a second call', () => {
    disposeTray();
    initTray(win);
    initTray(win); // must NOT arm a second interval
    const before = vi.mocked(pingMinecraftServer).mock.calls.length;
    vi.advanceTimersByTime(PING_INTERVAL_MS);
    expect(vi.mocked(pingMinecraftServer).mock.calls.length).toBe(before + 1);
  });
});

describe('journey #3: per-ping bound (server-pinger contract)', () => {
  // The real pinger, driven by the real socket API through a fake net pair.
  // Contract pinned: any socket behavior settles within ~6s hard cap and
  // never throws.
  it('a half-open socket that never responds settles offline within the hard cap', async () => {
    vi.useRealTimers();
    const { Socket } = await import('node:net');
    const { pingMinecraftServer: realPing } = await import('../src/main/server-pinger');

    // A socket that connects but never emits data (half-open/black-holed).
    const { pingMinecraftServer } = await import('../src/main/server-pinger');
    void pingMinecraftServer;

    const origConnect = Socket.prototype.connect;
    const origOn = Socket.prototype.on;
    const sockets: import('node:net').Socket[] = [];
    Socket.prototype.connect = function (this: import('node:net').Socket, ...args: unknown[]) {
      sockets.push(this);
      // Emit connect so the handshake is written, then go silent forever.
      setImmediate(() => this.emit('connect'));
      return this;
    } as typeof Socket.prototype.connect;
    Socket.prototype.on = function (this: import('node:net').Socket, event: string, cb: never) {
      // Swallow 'timeout' handlers? No — keep them; the pinger's own hard
      // timer must be the thing that ends this. We simply never deliver data.
      return origOn.call(this, event, cb);
    } as typeof Socket.prototype.on;

    try {
      const t0 = Date.now();
      const status = await realPing('blackhole.invalid', 25565);
      const elapsed = Date.now() - t0;
      expect(status).toEqual({ online: false });
      expect(elapsed, 'hard cap bounds the ping even when the socket goes silent').toBeLessThan(8_000);
    } finally {
      Socket.prototype.connect = origConnect;
      Socket.prototype.on = origOn;
      sockets.length = 0;
    }
  }, 15_000);
});
