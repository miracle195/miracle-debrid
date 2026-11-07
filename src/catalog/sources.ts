import type { ParsedStremioId } from '../util/ids.js';
import type { TitleMeta } from './resolver.js';

/** One playable candidate: a magnet plus whatever the provider knew about it. */
export interface SourceResult {
  /** magnet: URI or bare infohash. */
  magnet: string;
  /** Release title as the provider reported it. */
  title: string;
  /** Total size in bytes, if known. */
  size?: number;
  seeders?: number;
  /** e.g. "1080p", "2160p" — parsed from the title when absent. */
  quality?: string;
  /** Where this came from, shown in the Stremio stream list. */
  provider: string;
}

export interface SourceQuery {
  id: ParsedStremioId;
  type: 'movie' | 'series';
  meta: TitleMeta | null;
}

export interface SourceProvider {
  readonly name: string;
  /** False when the provider is not configured; it is then skipped silently. */
  isEnabled(): boolean;
  search(query: SourceQuery): Promise<SourceResult[]>;
}

const QUALITY_PATTERNS: Array<[RegExp, string]> = [
  [/\b(2160p|4k|uhd)\b/i, '2160p'],
  [/\b1080p\b/i, '1080p'],
  [/\b720p\b/i, '720p'],
  [/\b576p\b/i, '576p'],
  [/\b480p\b/i, '480p'],
];

export function detectQuality(title: string): string | undefined {
  for (const [re, label] of QUALITY_PATTERNS) {
    if (re.test(title)) return label;
  }
  return undefined;
}

const QUALITY_RANK: Record<string, number> = {
  '2160p': 5,
  '1080p': 4,
  '720p': 3,
  '576p': 2,
  '480p': 1,
};

/**
 * Ranks candidates the way a person would: quality first, then how healthy the
 * swarm looks, then size as a rough proxy for bitrate.
 */
export function rankResults(results: SourceResult[]): SourceResult[] {
  return [...results].sort((a, b) => {
    const qa = QUALITY_RANK[a.quality ?? detectQuality(a.title) ?? ''] ?? 0;
    const qb = QUALITY_RANK[b.quality ?? detectQuality(b.title) ?? ''] ?? 0;
    if (qa !== qb) return qb - qa;

    const sa = a.seeders ?? 0;
    const sb = b.seeders ?? 0;
    if (sa !== sb) return sb - sa;

    return (b.size ?? 0) - (a.size ?? 0);
  });
}

/** Drops duplicates that different providers reported for the same swarm. */
export function dedupeByInfoHash(results: SourceResult[]): SourceResult[] {
  const seen = new Set<string>();
  const out: SourceResult[] = [];
  for (const r of results) {
    const m = /urn:btih:([a-z0-9]+)/i.exec(r.magnet);
    const key = (m?.[1] ?? r.magnet).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}
