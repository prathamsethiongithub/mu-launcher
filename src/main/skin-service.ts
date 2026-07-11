import { app } from 'electron';
import { join } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from 'fs';
import { timedFetch } from './net';

/**
 * Resolves the authenticated player's skin as a data URL, in the MAIN
 * process — the renderer never talks to the network (mirrors the auth/token
 * architecture) and data: URLs sidestep CORS entirely.
 *
 * Source of truth: Mojang session server (profile → textures property →
 * skin PNG). Fallback: Crafatar. Results are disk-cached per UUID for 24h
 * so repeat opens are instant and offline-friendly.
 */

export interface SkinResult {
  dataUrl: string;
  /** Minecraft arm model: 'slim' (Alex, 3px arms) or 'default' (Steve). */
  model: 'slim' | 'default';
}

interface CacheMeta {
  model: 'slim' | 'default';
  fetchedAt: number;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export class SkinService {
  private cacheDir: string;

  constructor() {
    this.cacheDir = join(app.getPath('userData'), 'skins');
  }

  private cachePaths(uuid: string): { png: string; meta: string } {
    const safe = uuid.replace(/[^a-fA-F0-9]/g, '');
    return {
      png: join(this.cacheDir, `${safe}.png`),
      meta: join(this.cacheDir, `${safe}.json`),
    };
  }

  private readCache(uuid: string): SkinResult | null {
    const { png, meta } = this.cachePaths(uuid);
    try {
      if (!existsSync(png) || !existsSync(meta)) return null;
      const parsed = JSON.parse(readFileSync(meta, 'utf-8')) as CacheMeta;
      if (Date.now() - parsed.fetchedAt > CACHE_TTL_MS) return null;
      const b64 = readFileSync(png).toString('base64');
      return { dataUrl: `data:image/png;base64,${b64}`, model: parsed.model };
    } catch {
      return null; // corrupt cache → refetch
    }
  }

  private writeCache(uuid: string, pngBuf: Buffer, model: 'slim' | 'default'): void {
    try {
      mkdirSync(this.cacheDir, { recursive: true });
      const { png, meta } = this.cachePaths(uuid);
      writeFileSync(png, pngBuf);
      const metaData: CacheMeta = { model, fetchedAt: Date.now() };
      writeFileSync(meta, JSON.stringify(metaData), 'utf-8');
    } catch (err) {
      console.warn('[skin-service] cache write failed (non-fatal):', err);
    }
  }

  /** Official path: session server profile → decoded textures → skin URL. */
  private async fetchFromMojang(uuid: string): Promise<{ buf: Buffer; model: 'slim' | 'default' }> {
    const undashed = uuid.replace(/-/g, '');
    const profileResp = await timedFetch(
      `https://sessionserver.mojang.com/session/minecraft/profile/${undashed}`,
      15_000,
    );
    if (!profileResp.ok) throw new Error(`session server HTTP ${profileResp.status}`);
    const profile = (await profileResp.json()) as {
      properties?: { name: string; value: string }[];
    };
    const texturesProp = profile.properties?.find((p) => p.name === 'textures');
    if (!texturesProp) throw new Error('profile has no textures property');

    const decoded = JSON.parse(Buffer.from(texturesProp.value, 'base64').toString('utf-8')) as {
      textures?: { SKIN?: { url: string; metadata?: { model?: string } } };
    };
    const skin = decoded.textures?.SKIN;
    if (!skin?.url) throw new Error('profile has no skin URL');

    const model: 'slim' | 'default' = skin.metadata?.model === 'slim' ? 'slim' : 'default';
    const pngResp = await timedFetch(skin.url, 20_000);
    if (!pngResp.ok) throw new Error(`skin download HTTP ${pngResp.status}`);
    return { buf: Buffer.from(await pngResp.arrayBuffer()), model };
  }

  /** Fallback CDN (no model metadata — assume default arms). */
  private async fetchFromCrafatar(uuid: string): Promise<{ buf: Buffer; model: 'slim' | 'default' }> {
    const undashed = uuid.replace(/-/g, '');
    const resp = await timedFetch(`https://crafatar.com/skins/${undashed}`, 20_000);
    if (!resp.ok) throw new Error(`crafatar HTTP ${resp.status}`);
    return { buf: Buffer.from(await resp.arrayBuffer()), model: 'default' };
  }

  /** Clear all cached skins (called on logout so fresh skin is fetched on next sign-in). */
  clearAll(): void {
    try {
      // Static imports, not require(): the main process is bundled into a
      // single out/main/index.js, so runtime require() of siblings fails.
      if (existsSync(this.cacheDir)) {
        for (const file of readdirSync(this.cacheDir)) {
          unlinkSync(join(this.cacheDir, file));
        }
        console.log('[skin-service] Cache cleared');
      }
    } catch (err) {
      console.warn('[skin-service] Cache clear failed (non-fatal):', err);
    }
  }

  /**
   * Write a known-good skin PNG straight into the cache (used after a skin
   * upload: the uploaded file IS the new skin, so caching it locally shows
   * the change instantly instead of waiting on Mojang CDN propagation).
   */
  putCache(uuid: string, pngBuf: Buffer, model: 'slim' | 'default'): SkinResult {
    this.writeCache(uuid, pngBuf, model);
    return { dataUrl: `data:image/png;base64,${pngBuf.toString('base64')}`, model };
  }

  /** Returns the skin for a UUID, or null if it can't be resolved (non-fatal). */
  async getSkin(uuid: string, opts?: { force?: boolean }): Promise<SkinResult | null> {
    if (!uuid) return null;

    // force bypasses the 24h cache — used by the studio's Refresh so a skin
    // changed outside the launcher (minecraft.net, in-game) shows up now.
    const cached = opts?.force ? null : this.readCache(uuid);
    if (cached) return cached;

    try {
      const { buf, model } = await this.fetchFromMojang(uuid);
      this.writeCache(uuid, buf, model);
      return { dataUrl: `data:image/png;base64,${buf.toString('base64')}`, model };
    } catch (mojangErr) {
      console.warn('[skin-service] Mojang path failed, trying fallback:', mojangErr);
      try {
        const { buf, model } = await this.fetchFromCrafatar(uuid);
        this.writeCache(uuid, buf, model);
        return { dataUrl: `data:image/png;base64,${buf.toString('base64')}`, model };
      } catch (fallbackErr) {
        console.warn('[skin-service] skin unavailable (decorative — continuing):', fallbackErr);
        return null;
      }
    }
  }
}
