/**
 * Server Pinger — Live Server Pulse phase 1.
 *
 * STANDALONE module: implements the modern Minecraft Server List Ping (SLP)
 * protocol (1.7+) over a raw TCP socket, with no third-party dependency and
 * no coupling to any other service in the main process.
 *
 * Protocol flow (all packets VarInt-length-prefixed):
 *   1. Handshake (state=handshake, packet id 0x00):
 *        protocol version −1 (means "status query"),
 *        server address (host), server port (u16 BE),
 *        next state 1 (= status).
 *      NOTE: the next state for status is 1, not 0 — 2 would be login.
 *   2. Status Request (packet id 0x00, empty body).
 *   3. Server responds with a JSON payload containing players/version/description.
 *
 * Failure contract: this function NEVER throws. Unreachable hosts, timeouts,
 * DNS failures, legacy (pre-1.7) servers and malformed payloads all resolve
 * to `{ online: false }` — a server being down is a normal answer, not an
 * error condition.
 *
 * Known limitation (phase 1): no DNS SRV record lookup. Servers that publish
 * their port via an `_minecraft._tcp` SRV record will only respond if the
 * caller passes the real port explicitly.
 */

import { Socket } from 'node:net';

export interface ServerStatus {
  online: boolean;
  players?: { online: number; max: number };
  version?: string;
  motd?: string;
}

const PING_TIMEOUT_MS = 5000;

/* ── VarInt helpers (Minecraft's wire format) ──────────────────────────── */

function encodeVarInt(value: number): Buffer {
  // >>> 0 keeps −1 (the "status query" protocol version) as unsigned 32-bit,
  // which encodes to the 5-byte FF FF FF FF 0F form the protocol expects.
  let v = value >>> 0;
  const bytes: number[] = [];
  while (true) {
    if ((v & 0xffffff80) === 0) {
      bytes.push(v);
      return Buffer.from(bytes);
    }
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
}

function readVarInt(buffer: Buffer, offset: number): { value: number; length: number } | null {
  let result = 0;
  let shift = 0;
  let cursor = offset;
  while (true) {
    if (cursor >= buffer.length) return null; // incomplete — caller waits for more data
    const byte = buffer[cursor]!;
    result |= (byte & 0x7f) << shift;
    cursor += 1;
    if ((byte & 0x80) === 0) return { value: result, length: cursor - offset };
    shift += 7;
    if (shift > 28) return null; // malformed — never valid in an SLP response
  }
}

function u16BE(value: number): Buffer {
  const buf = Buffer.alloc(2);
  buf.writeUInt16BE(value & 0xffff);
  return buf;
}

/* ── packet builders ───────────────────────────────────────────────────── */

function buildHandshake(host: string, port: number): Buffer {
  const addressBytes = Buffer.from(host, 'utf8');
  const handshake = Buffer.concat([
    encodeVarInt(0x00), // packet id: handshake
    encodeVarInt(-1), // protocol version: −1 = status query
    encodeVarInt(addressBytes.length),
    addressBytes,
    u16BE(port),
    encodeVarInt(1), // next state: 1 = status
  ]);
  return Buffer.concat([encodeVarInt(handshake.length), handshake]);
}

function buildStatusRequest(): Buffer {
  const request = encodeVarInt(0x00); // packet id: status request, empty body
  return Buffer.concat([encodeVarInt(request.length), request]);
}

/* ── response parsing ──────────────────────────────────────────────────── */

/** Flattens a chat component (string | {text, extra[]} | nested mix) to plain text. */
function extractMotd(description: unknown): string | undefined {
  if (typeof description === 'string') return description;
  if (!description || typeof description !== 'object') return undefined;
  const parts: string[] = [];
  const collect = (node: unknown): void => {
    if (typeof node === 'string') {
      parts.push(node);
    } else if (node && typeof node === 'object') {
      const obj = node as { text?: unknown; extra?: unknown };
      if (typeof obj.text === 'string') parts.push(obj.text);
      if (Array.isArray(obj.extra)) obj.extra.forEach(collect);
    }
  };
  collect(description);
  return parts.length > 0 ? parts.join('') : undefined;
}

/**
 * Parses one framed SLP response packet (already stripped of its length
 * prefix). Returns null for anything that isn't a well-formed modern status
 * response (wrong packet id, truncated JSON, legacy kick packet, …).
 */
function parseStatusResponse(payload: Buffer): ServerStatus | null {
  const packetId = readVarInt(payload, 0);
  if (!packetId || packetId.value !== 0x00) return null;

  const strLen = readVarInt(payload, packetId.length);
  if (!strLen || strLen.value <= 0) return null;

  const jsonStart = packetId.length + strLen.length;
  if (payload.length < jsonStart + strLen.value) return null;

  let parsed: {
    players?: { online?: unknown; max?: unknown };
    version?: { name?: unknown };
    description?: unknown;
  };
  try {
    parsed = JSON.parse(payload.subarray(jsonStart, jsonStart + strLen.value).toString('utf8'));
  } catch {
    return null;
  }

  const players =
    parsed.players &&
    typeof parsed.players.online === 'number' &&
    typeof parsed.players.max === 'number'
      ? { online: parsed.players.online, max: parsed.players.max }
      : undefined;

  const version =
    parsed.version && typeof parsed.version.name === 'string'
      ? parsed.version.name
      : undefined;

  return { online: true, players, version, motd: extractMotd(parsed.description) };
}

/* ── public API ────────────────────────────────────────────────────────── */

/**
 * Pings a Minecraft server with the modern Server List Ping protocol.
 *
 * @param host  Bare hostname or IP (no port suffix, no SRV resolution).
 * @param port  Server port (default 25565).
 * @returns The server's status, or `{ online: false }` for ANY failure
 *          (DNS, refused, timeout, malformed/legacy response). Never throws.
 */
export async function pingMinecraftServer(
  host: string,
  port: number = 25565,
): Promise<ServerStatus> {
  const offline: ServerStatus = { online: false };

  // Normalise inputs: an empty host or an out-of-range port can only come
  // from bad config, and both are answerable without touching the network.
  const cleanHost = typeof host === 'string' ? host.trim() : '';
  const cleanPort = Number.isFinite(port) ? Math.floor(port) : 25565;
  if (!cleanHost || cleanPort < 1 || cleanPort > 65535) return offline;

  return new Promise<ServerStatus>((resolve) => {
    let settled = false;
    let socket: Socket | null = null;
    let hardTimer: NodeJS.Timeout | null = null;
    let acc = Buffer.alloc(0);

    // Single settled guard: whichever of (data-complete, timeout, error,
    // hard-timer) fires first owns the answer; everything else is a no-op.
    const finish = (status: ServerStatus): void => {
      if (settled) return;
      settled = true;
      if (hardTimer) clearTimeout(hardTimer);
      if (socket) {
        socket.removeAllListeners();
        socket.destroy();
      }
      resolve(status);
    };

    // Hard backstop: socket.setTimeout only covers idle time, so a half-open
    // connection that never emits anything would otherwise hang the promise.
    hardTimer = setTimeout(() => finish(offline), PING_TIMEOUT_MS + 1000);

    try {
      socket = new Socket();
      socket.setTimeout(PING_TIMEOUT_MS);
      socket.setNoDelay(true);

      socket.on('error', () => finish(offline)); // DNS, refused, reset, …
      socket.on('timeout', () => finish(offline));
      socket.on('close', () => finish(offline)); // closed before a full response

      socket.on('connect', () => {
        if (settled) return;
        socket!.write(buildHandshake(cleanHost, cleanPort));
        socket!.write(buildStatusRequest());
      });

      socket.on('data', (chunk: Buffer) => {
        if (settled) return;
        acc = Buffer.concat([acc, chunk]);

        const length = readVarInt(acc, 0);
        if (!length) return; // length prefix still incomplete
        if (acc.length < length.length + length.value) return; // packet still incomplete

        const status = parseStatusResponse(acc.subarray(length.length, length.length + length.value));
        finish(status ?? offline);
      });

      socket.connect(cleanPort, cleanHost);
    } catch {
      // Constructor-level failure (exhausted fds, invalid args, …) — same
      // contract as every other failure path: a quiet "offline", never a throw.
      finish(offline);
    }
  });
}
