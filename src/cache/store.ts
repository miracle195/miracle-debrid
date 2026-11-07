import fs from 'node:fs/promises';
import path from 'node:path';

import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { engine } from '../torrent/engine.js';
import { humanBytes } from '../util/bytes.js';

const log = createLogger('cache');

export interface CacheEntry {
  infoHash: string;
  dir: string;
  bytes: number;
  lastAccessAt: number;
  live: boolean;
  readers: number;
}

async function dirSize(dir: string): Promise<{ bytes: number; newestMtime: number }> {
  let bytes = 0;
  let newestMtime = 0;

  const walk = async (current: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        try {
          const stat = await fs.stat(full);
          bytes += stat.size;
          const touched = Math.max(stat.mtimeMs, stat.atimeMs);
          if (touched > newestMtime) newestMtime = touched;
        } catch {
          /* file vanished mid-walk; ignore */
        }
      }
    }
  };

  await walk(dir);
  return { bytes, newestMtime };
}

/** Download folders are named "<infohash>" or "<infohash>-<slug>". */
function infoHashFromDirName(name: string): string | null {
  const m = /^([a-f0-9]{40})(?:-|$)/i.exec(name);
  return m?.[1]?.toLowerCase() ?? null;
}

export async function listCache(): Promise<CacheEntry[]> {
  let dirents;
  try {
    dirents = await fs.readdir(config.downloadDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const entries: CacheEntry[] = [];
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;
    const infoHash = infoHashFromDirName(dirent.name);
    if (!infoHash) continue;

    const full = path.join(config.downloadDir, dirent.name);
    const { bytes, newestMtime } = await dirSize(full);
    const session = engine.getSession(infoHash);

    entries.push({
      infoHash,
      dir: full,
      bytes,
      lastAccessAt: session?.lastAccessAt ?? newestMtime,
      live: Boolean(session),
      readers: session?.readers ?? 0,
    });
  }
  return entries;
}

export async function totalCacheBytes(): Promise<number> {
  const entries = await listCache();
  return entries.reduce((sum, e) => sum + e.bytes, 0);
}

export async function evictOne(infoHash: string): Promise<boolean> {
  const hash = infoHash.toLowerCase();
  const session = engine.getSession(hash);
  if (session && session.readers > 0) {
    log.warn(`refusing to evict ${hash.slice(0, 8)} — ${session.readers} active reader(s)`);
    return false;
  }

  await engine.remove(hash, false);

  const entries = await listCache();
  const entry = entries.find((e) => e.infoHash === hash);
  if (!entry) return false;

  await fs.rm(entry.dir, { recursive: true, force: true });
  log.info(`evicted ${hash.slice(0, 8)} (${humanBytes(entry.bytes)})`);
  return true;
}

/**
 * Drops least-recently-used torrents until the cache fits under the cap.
 * Anything with an active reader, or touched within CACHE_MIN_AGE_MS, is left
 * alone — evicting the film someone is currently watching would be rude.
 */
export async function sweep(): Promise<{ freed: number; evicted: string[] }> {
  const entries = await listCache();
  let total = entries.reduce((sum, e) => sum + e.bytes, 0);

  if (total <= config.cache.maxBytes) return { freed: 0, evicted: [] };

  log.info(
    `cache at ${humanBytes(total)} over cap ${humanBytes(config.cache.maxBytes)}, sweeping`
  );

  const now = Date.now();
  const candidates = entries
    .filter((e) => e.readers === 0)
    .filter((e) => now - e.lastAccessAt > config.cache.minAgeMs)
    .sort((a, b) => a.lastAccessAt - b.lastAccessAt);

  const evicted: string[] = [];
  let freed = 0;

  for (const entry of candidates) {
    if (total <= config.cache.maxBytes) break;
    const ok = await evictOne(entry.infoHash);
    if (!ok) continue;
    total -= entry.bytes;
    freed += entry.bytes;
    evicted.push(entry.infoHash);
  }

  if (total > config.cache.maxBytes) {
    log.warn(
      `still ${humanBytes(total)} after sweep — everything left is either in use ` +
        `or too recent to evict`
    );
  }

  return { freed, evicted };
}

let timer: NodeJS.Timeout | null = null;

export function startCacheSweeper(): void {
  if (timer) return;
  timer = setInterval(() => {
    sweep().catch((err) => log.error('sweep failed', err));
  }, config.cache.sweepIntervalMs);
  timer.unref?.();
  log.info(
    `sweeper running every ${Math.round(config.cache.sweepIntervalMs / 1000)}s, ` +
      `cap ${humanBytes(config.cache.maxBytes)}`
  );
}

export function stopCacheSweeper(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
