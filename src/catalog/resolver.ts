import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { fetchWithTimeout } from '../util/async.js';

const log = createLogger('meta');

export interface TitleMeta {
  imdbId: string;
  name: string;
  year?: number;
  type: 'movie' | 'series';
}

interface CinemetaResponse {
  meta?: {
    id?: string;
    name?: string;
    year?: string | number;
    releaseInfo?: string;
    type?: string;
  };
}

const cache = new Map<string, { value: TitleMeta | null; expires: number }>();
const TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Turns an IMDb id into a human title, because indexers are searched by name.
 * Uses Cinemeta, the same metadata addon Stremio itself ships with.
 * Failure is non-fatal — callers fall back to searching by raw id.
 */
export async function resolveTitle(
  imdbId: string,
  type: 'movie' | 'series'
): Promise<TitleMeta | null> {
  const key = `${type}:${imdbId}`;
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;

  const url = `${config.sources.cinemetaUrl}/meta/${type}/${encodeURIComponent(imdbId)}.json`;

  try {
    const res = await fetchWithTimeout(url, config.sources.searchTimeoutMs);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const body = (await res.json()) as CinemetaResponse;
    const meta = body.meta;
    if (!meta?.name) throw new Error('response had no meta.name');

    const yearRaw = String(meta.year ?? meta.releaseInfo ?? '');
    const yearMatch = /(\d{4})/.exec(yearRaw);

    const value: TitleMeta = {
      imdbId,
      name: meta.name,
      type,
      ...(yearMatch?.[1] ? { year: Number(yearMatch[1]) } : {}),
    };

    cache.set(key, { value, expires: Date.now() + TTL_MS });
    return value;
  } catch (err) {
    log.warn(`metadata lookup failed for ${imdbId}: ${(err as Error).message}`);
    cache.set(key, { value: null, expires: Date.now() + 60_000 });
    return null;
  }
}
