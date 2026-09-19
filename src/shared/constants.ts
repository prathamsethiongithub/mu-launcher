/**
 * The built-in Masters' Union SMP server — the single source of truth for its
 * host and port. Previously duplicated as identical string/number literals in
 * server-injector.ts, tray-manager.ts, world-manager.ts and PlayView.tsx;
 * every consumer must reference these constants instead of re-typing them.
 */
export const SMP_SERVER_HOST = 'prathamsethi.minekeep.gg';
export const SMP_SERVER_PORT = 25565;
