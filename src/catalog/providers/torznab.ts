import { config } from '../../config.js';
import { createLogger } from '../../logger.js';
import { fetchWithTimeout } from '../../util/async.js';
import { detectQuality, type SourceProvider, type SourceQuery, type SourceResult } from '../sources.js';

const log = createLogger('source:torznab');

/**
 * Queries a Torznab endpoint you run yourself (Jackett or Prowlarr).
 *
 * Nothing is hard-coded here: no indexer list ships with this project. The
 * provider stays dormant unless TORZNAB_URL and TORZNAB_API_KEY are set, and
 * it only ever talks to the endpoint you point it at. Which indexers that
 * endpoint aggregates, and whether you have the rights to what it returns, is
 * entirely your configuration and your responsibility.
 */
export class TorznabProvider implements SourceProvider {
  readonly name = 'torznab';

  isEnabled(): boolean {
    return Boolean(config.sources.torznabUrl && config.sources.torznabApiKey);
  }

  async search(query: SourceQuery): Promise<SourceResult[]> {
    if (!this.isEnabled()) return [];

    const base = config.sources.torznabUrl!.replace(/\/+$/, '');
    const params = new URLSearchParams({
      apikey: config.sources.torznabApiKey!,
      extended: '1',
      limit: String(config.sources.maxResults * 2),
    });

    const { imdbId, season, episode } = query.id;
    const title = query.meta?.name;

    if (season !== undefined && episode !== undefined) {
      params.set('t', 'tvsearch');
      params.set('season', String(season));
      params.set('ep', String(episode));
      if (title) params.set('q', title);
      else params.set('imdbid', imdbId.replace(/^tt/, ''));
    } else {
      params.set('t', 'movie');
      params.set('imdbid', imdbId.replace(/^tt/, ''));
      if (title) params.set('q', query.meta?.year ? `${title} ${query.meta.year}` : title);
    }

    const url = `${base}/api?${params.toString()}`;

    try {
      const res = await fetchWithTimeout(url, config.sources.searchTimeoutMs, {
        headers: { accept: 'application/xml, text/xml' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const xml = await res.text();
      const results = parseTorznab(xml, this.name);
      log.info(`${results.length} result(s) for ${imdbId}`);
      return results;
    } catch (err) {
      log.warn(`search failed: ${(err as Error).message}`);
      return [];
    }
  }
}

/**
 * Deliberately regex-based rather than a full XML parser: Torznab responses
 * are flat and predictable, and this keeps the dependency list short.
 */
export function parseTorznab(xml: string, provider: string): SourceResult[] {
  const out: SourceResult[] = [];
  const items = xml.match(/<item[\s>][\s\S]*?<\/item>/g) ?? [];

  for (const item of items) {
    const title = decodeXml(tag(item, 'title') ?? '');
    if (!title) continue;

    const magnet =
      attrValue(item, 'magneturl') ??
      firstMatch(item, /<(?:torznab:)?magneturl>([\s\S]*?)<\/(?:torznab:)?magneturl>/i) ??
      magnetFromLink(item);

    const infoHash = attrValue(item, 'infohash');
    const resolved = magnet ?? (infoHash ? `magnet:?xt=urn:btih:${infoHash}` : null);
    if (!resolved) continue;

    const sizeRaw = tag(item, 'size') ?? attrValue(item, 'size');
    const seedRaw = attrValue(item, 'seeders');
    const size = sizeRaw ? Number(sizeRaw) : undefined;
    const seeders = seedRaw ? Number(seedRaw) : undefined;

    out.push({
      magnet: decodeXml(resolved),
      title,
      provider,
      ...(Number.isFinite(size) && size! > 0 ? { size } : {}),
      ...(Number.isFinite(seeders) ? { seeders } : {}),
      quality: detectQuality(title),
    });
  }

  return out;
}

function tag(xml: string, name: string): string | null {
  return firstMatch(xml, new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i'));
}

/** Reads <torznab:attr name="x" value="y" /> in either attribute order. */
function attrValue(xml: string, name: string): string | null {
  const forward = new RegExp(
    `<(?:torznab:)?attr[^>]*name=["']${name}["'][^>]*value=["']([^"']*)["']`,
    'i'
  );
  const reverse = new RegExp(
    `<(?:torznab:)?attr[^>]*value=["']([^"']*)["'][^>]*name=["']${name}["']`,
    'i'
  );
  return firstMatch(xml, forward) ?? firstMatch(xml, reverse);
}

function magnetFromLink(item: string): string | null {
  const link = tag(item, 'link') ?? firstMatch(item, /<enclosure[^>]*url=["']([^"']+)["']/i);
  if (link && /^magnet:\?/i.test(decodeXml(link).trim())) return decodeXml(link).trim();
  return null;
}

function firstMatch(input: string, re: RegExp): string | null {
  const m = re.exec(input);
  const value = m?.[1]?.trim();
  return value ? value : null;
}

function decodeXml(input: string): string {
  return input
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}
