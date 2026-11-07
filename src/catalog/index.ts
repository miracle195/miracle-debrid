import { createLogger } from '../logger.js';
import { config } from '../config.js';
import { ManualProvider } from './providers/manual.js';
import { TorznabProvider } from './providers/torznab.js';
import {
  dedupeByInfoHash,
  rankResults,
  type SourceProvider,
  type SourceQuery,
  type SourceResult,
} from './sources.js';

const log = createLogger('catalog');

const providers: SourceProvider[] = [new ManualProvider(), new TorznabProvider()];

/** Register an extra provider at boot (see README, "Writing a provider"). */
export function registerProvider(provider: SourceProvider): void {
  providers.push(provider);
  log.info(`registered provider "${provider.name}"`);
}

export function enabledProviders(): string[] {
  return providers.filter((p) => p.isEnabled()).map((p) => p.name);
}

/**
 * Asks every configured provider at once and merges the answers. One slow or
 * broken provider must not sink the whole lookup, so failures resolve to [].
 */
export async function findSources(query: SourceQuery): Promise<SourceResult[]> {
  const active = providers.filter((p) => p.isEnabled());
  if (active.length === 0) {
    log.debug('no source providers enabled');
    return [];
  }

  const settled = await Promise.allSettled(active.map((p) => p.search(query)));

  const merged: SourceResult[] = [];
  settled.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      merged.push(...result.value);
    } else {
      log.warn(`provider "${active[i]?.name}" failed`, result.reason);
    }
  });

  return rankResults(dedupeByInfoHash(merged)).slice(0, config.sources.maxResults);
}

export type { SourceProvider, SourceQuery, SourceResult };
