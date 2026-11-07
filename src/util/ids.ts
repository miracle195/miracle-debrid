import { config } from '../config.js';

export interface ParsedStremioId {
  imdbId: string;
  season?: number;
  episode?: number;
}

/**
 * Stremio content ids look like:
 *   movie  -> "tt0111161"
 *   series -> "tt0944947:1:9"   (imdb : season : episode)
 */
export function parseStremioId(raw: string): ParsedStremioId | null {
  const decoded = decodeURIComponent(raw).trim();
  const parts = decoded.split(':');
  const imdbId = parts[0];
  if (!imdbId || !/^tt\d{6,10}$/.test(imdbId)) return null;

  if (parts.length === 1) return { imdbId };
  if (parts.length !== 3) return null;

  const season = Number(parts[1]);
  const episode = Number(parts[2]);
  if (!Number.isInteger(season) || !Number.isInteger(episode)) return null;
  if (season < 0 || episode < 0) return null;

  return { imdbId, season, episode };
}

const INFOHASH_HEX = /^[a-f0-9]{40}$/i;
const INFOHASH_B32 = /^[a-z2-7]{32}$/i;

export function isInfoHash(value: string): boolean {
  return INFOHASH_HEX.test(value) || INFOHASH_B32.test(value);
}

/** Extracts the btih infohash from a magnet URI, lowercased. Null if absent. */
export function infoHashFromMagnet(magnet: string): string | null {
  const m = /xt=urn:btih:([a-z0-9]+)/i.exec(magnet);
  const hash = m?.[1];
  if (!hash || !isInfoHash(hash)) return null;
  return hash.toLowerCase();
}

/**
 * Accepts a bare infohash or a full magnet and returns a magnet URI with our
 * tracker list merged in. Bare infohashes are useless without trackers unless
 * DHT happens to know the swarm, so this matters.
 */
export function normalizeMagnet(input: string, displayName?: string): string {
  const trimmed = input.trim();

  if (isInfoHash(trimmed)) {
    return buildMagnet(trimmed.toLowerCase(), displayName, []);
  }

  if (!/^magnet:\?/i.test(trimmed)) {
    throw new Error('Not a magnet URI or infohash');
  }

  const url = new URL(trimmed);
  const hash = infoHashFromMagnet(trimmed);
  if (!hash) throw new Error('Magnet URI has no valid btih infohash');

  const existingTrackers = url.searchParams.getAll('tr');
  const name = displayName ?? url.searchParams.get('dn') ?? undefined;
  return buildMagnet(hash, name, existingTrackers);
}

function buildMagnet(infoHash: string, name: string | undefined, trackers: string[]): string {
  const params = new URLSearchParams();
  params.set('xt', `urn:btih:${infoHash}`);
  if (name) params.set('dn', name);

  const seen = new Set<string>();
  for (const tr of [...trackers, ...config.torrent.trackers]) {
    const t = tr.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    params.append('tr', t);
  }
  // URLSearchParams encodes ':' and '/' which some trackers dislike in the wild;
  // decoding them back keeps the magnet in its conventional shape.
  return `magnet:?${params.toString().replace(/%3A/g, ':').replace(/%2F/g, '/')}`;
}

/** Filesystem-safe, collision-free-enough slug for cache directory names. */
export function safeSlug(input: string, maxLength = 60): string {
  const slug = input
    .normalize('NFKD')
    .replace(/[^\w.\- ]+/g, '')
    .trim()
    .replace(/\s+/g, '.')
    .slice(0, maxLength);
  return slug || 'untitled';
}
