import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function env(key: string): string | undefined {
  const v = process.env[key];
  return v === undefined || v.trim() === '' ? undefined : v.trim();
}

function num(key: string, fallback: number): number {
  const raw = env(key);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Env ${key} must be a number, got "${raw}"`);
  }
  return parsed;
}

function bool(key: string, fallback: boolean): boolean {
  const raw = env(key)?.toLowerCase();
  if (raw === undefined) return fallback;
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

/**
 * Parses sizes like "200GB", "512mb", "1099511627776".
 * Uses binary units (GB == GiB) because that is what df reports.
 */
export function parseBytes(input: string): number {
  const m = /^([\d.]+)\s*([kmgt]?i?b?)$/i.exec(input.trim());
  if (!m || m[1] === undefined) throw new Error(`Cannot parse size "${input}"`);
  const value = Number(m[1]);
  const unit = (m[2] ?? '').toLowerCase();
  const mult: Record<string, number> = {
    '': 1,
    b: 1,
    k: 1024,
    kb: 1024,
    kib: 1024,
    m: 1024 ** 2,
    mb: 1024 ** 2,
    mib: 1024 ** 2,
    g: 1024 ** 3,
    gb: 1024 ** 3,
    gib: 1024 ** 3,
    t: 1024 ** 4,
    tb: 1024 ** 4,
    tib: 1024 ** 4,
  };
  const factor = mult[unit];
  if (factor === undefined) throw new Error(`Unknown size unit in "${input}"`);
  return Math.floor(value * factor);
}

function bytes(key: string, fallback: string): number {
  return parseBytes(env(key) ?? fallback);
}

function list(key: string, fallback: string[]): string[] {
  const raw = env(key);
  if (!raw) return fallback;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const dataDir = path.resolve(env('DATA_DIR') ?? './data');
const downloadDir = path.resolve(env('DOWNLOAD_DIR') ?? path.join(dataDir, 'downloads'));

fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(downloadDir, { recursive: true });

/**
 * The access token gates every route except /health. Stremio has no header
 * auth, so the token travels as the first path segment of the addon URL.
 * If none is configured we generate one and persist it, so a fresh install is
 * never accidentally left open to the internet.
 */
function resolveToken(): string {
  const fromEnv = env('ACCESS_TOKEN');
  if (fromEnv) return fromEnv;

  const tokenFile = path.join(dataDir, 'access-token');
  if (fs.existsSync(tokenFile)) {
    const stored = fs.readFileSync(tokenFile, 'utf8').trim();
    if (stored) return stored;
  }
  const generated = randomBytes(16).toString('hex');
  fs.writeFileSync(tokenFile, generated + '\n', { mode: 0o600 });
  return generated;
}

/** Public trackers appended to every magnet to help peer discovery. */
const DEFAULT_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://explodie.org:6969/announce',
  'udp://tracker.dler.org:6969/announce',
  'udp://exodus.desync.com:6969/announce',
  'wss://tracker.openwebtorrent.com',
];

export const config = {
  /** Bind host. 127.0.0.1 when sitting behind nginx on the same box. */
  host: env('HOST') ?? '0.0.0.0',
  port: num('PORT', 11470),

  /**
   * Externally reachable base URL, no trailing slash.
   * This is what gets baked into the stream URLs Stremio receives, so it must
   * be reachable from whatever device is playing (not just from the server).
   */
  publicUrl: (env('PUBLIC_URL') ?? `http://127.0.0.1:${num('PORT', 11470)}`).replace(/\/+$/, ''),

  accessToken: resolveToken(),
  /** Set false only if the service is bound to loopback or a private LAN. */
  requireToken: bool('REQUIRE_TOKEN', true),

  dataDir,
  downloadDir,

  addon: {
    id: env('ADDON_ID') ?? 'community.miracle.debrid',
    name: env('ADDON_NAME') ?? 'Miracle Debrid',
    version: env('ADDON_VERSION') ?? '1.0.0',
    description:
      env('ADDON_DESCRIPTION') ??
      'Self-hosted debrid: downloads on the server and serves a plain HTTP stream.',
  },

  torrent: {
    /** Total peer connections across all torrents. */
    maxConns: num('TORRENT_MAX_CONNS', 60),
    /** Bytes/sec, -1 for unlimited. */
    downloadLimit: num('DOWNLOAD_LIMIT', -1),
    uploadLimit: num('UPLOAD_LIMIT', num('DOWNLOAD_LIMIT', -1) === -1 ? 131072 : 131072),
    dht: bool('DHT', true),
    /** Fixed inbound port makes firewall/port-forward rules possible. */
    torrentPort: num('TORRENT_PORT', 0),
    trackers: list('TRACKERS', DEFAULT_TRACKERS),
    /** How long to wait for metadata (magnet -> file list) before giving up. */
    metadataTimeoutMs: num('METADATA_TIMEOUT_MS', 45_000),
    /**
     * Bytes to buffer at the head of a range before we start writing the
     * response body. Prevents players from seeing an instant stall.
     */
    prebufferBytes: bytes('PREBUFFER_BYTES', '4MB'),
    prebufferTimeoutMs: num('PREBUFFER_TIMEOUT_MS', 60_000),
    /** Tear down a torrent with no readers after this long. */
    idleTimeoutMs: num('IDLE_TIMEOUT_MS', 15 * 60_000),
    /** Keep seeding finished torrents while they stay in cache. */
    seedAfterDownload: bool('SEED_AFTER_DOWNLOAD', false),
  },

  cache: {
    /** Evict least-recently-used torrents once the cache exceeds this. */
    maxBytes: bytes('CACHE_MAX_BYTES', '100GB'),
    sweepIntervalMs: num('CACHE_SWEEP_INTERVAL_MS', 5 * 60_000),
    /** Never evict something that was touched more recently than this. */
    minAgeMs: num('CACHE_MIN_AGE_MS', 10 * 60_000),
  },

  sources: {
    /** Torznab endpoint of YOUR OWN indexer aggregator (Jackett / Prowlarr). */
    torznabUrl: env('TORZNAB_URL'),
    torznabApiKey: env('TORZNAB_API_KEY'),
    searchTimeoutMs: num('SOURCE_SEARCH_TIMEOUT_MS', 12_000),
    maxResults: num('SOURCE_MAX_RESULTS', 15),
    /** Stremio's official metadata addon, used to turn tt-ids into titles. */
    cinemetaUrl: (env('CINEMETA_URL') ?? 'https://v3-cinemeta.strem.io').replace(/\/+$/, ''),
  },

  logLevel: (env('LOG_LEVEL') ?? 'info') as 'debug' | 'info' | 'warn' | 'error',
} as const;

export type Config = typeof config;
