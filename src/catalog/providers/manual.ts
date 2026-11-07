import fs from 'node:fs';
import path from 'node:path';

import { config } from '../../config.js';
import { createLogger } from '../../logger.js';
import { detectQuality, type SourceProvider, type SourceQuery, type SourceResult } from '../sources.js';

const log = createLogger('source:manual');

/**
 * Shape of data/sources.json — a library you curate yourself.
 *
 * {
 *   "tt0031381": [
 *     { "title": "Some Public Domain Film 1080p", "magnet": "magnet:?xt=urn:btih:…" }
 *   ],
 *   "tt0000001:1:3": [
 *     { "title": "Show S01E03 720p", "magnet": "…", "size": 812000000, "seeders": 12 }
 *   ]
 * }
 *
 * Keys are Stremio ids: "ttNNNNNNN" for a film, "ttNNNNNNN:season:episode" for
 * an episode, or "ttNNNNNNN:season" for a whole-season pack.
 */
interface ManualEntry {
  title?: string;
  magnet: string;
  size?: number;
  seeders?: number;
  quality?: string;
}

type ManualLibrary = Record<string, ManualEntry[]>;

export class ManualProvider implements SourceProvider {
  readonly name = 'library';

  private cache: { mtimeMs: number; data: ManualLibrary } | null = null;

  private get file(): string {
    return path.join(config.dataDir, 'sources.json');
  }

  isEnabled(): boolean {
    return fs.existsSync(this.file);
  }

  private load(): ManualLibrary {
    try {
      const stat = fs.statSync(this.file);
      if (this.cache && this.cache.mtimeMs === stat.mtimeMs) return this.cache.data;

      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as ManualLibrary;
      this.cache = { mtimeMs: stat.mtimeMs, data: parsed };
      log.info(`loaded ${Object.keys(parsed).length} entries from sources.json`);
      return parsed;
    } catch (err) {
      log.warn('could not read sources.json', err);
      return {};
    }
  }

  search(query: SourceQuery): Promise<SourceResult[]> {
    const library = this.load();
    const { imdbId, season, episode } = query.id;

    const keys: string[] = [];
    if (season !== undefined && episode !== undefined) {
      keys.push(`${imdbId}:${season}:${episode}`, `${imdbId}:${season}`);
    }
    keys.push(imdbId);

    const out: SourceResult[] = [];
    for (const key of keys) {
      for (const entry of library[key] ?? []) {
        if (!entry?.magnet) continue;
        const title = entry.title ?? key;
        out.push({
          magnet: entry.magnet,
          title,
          provider: this.name,
          ...(entry.size !== undefined ? { size: entry.size } : {}),
          ...(entry.seeders !== undefined ? { seeders: entry.seeders } : {}),
          quality: entry.quality ?? detectQuality(title),
        });
      }
    }
    return Promise.resolve(out);
  }
}
