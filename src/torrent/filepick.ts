import type { TorrentFile } from 'webtorrent';

export const VIDEO_EXTENSIONS = new Set([
  '.mkv', '.mp4', '.m4v', '.avi', '.mov', '.wmv', '.flv', '.webm',
  '.mpg', '.mpeg', '.m2ts', '.ts', '.ogv', '.divx', '.vob', '.3gp',
]);

/** Files that are technically video but are never the feature. */
const JUNK_PATTERNS = [
  /\bsample\b/i,
  /\btrailer\b/i,
  /\bextras?\b/i,
  /\bfeaturettes?\b/i,
  /\bbehind[ ._-]the[ ._-]scenes\b/i,
  /\bdeleted[ ._-]scenes?\b/i,
  /\brarbg\b/i,
  /\bproof\b/i,
  /\bscreens?\b/i,
];

export interface PickableFile {
  index: number;
  name: string;
  path: string;
  length: number;
}

export function toPickable(files: TorrentFile[]): PickableFile[] {
  return files.map((f, index) => ({
    index,
    name: f.name,
    path: f.path,
    length: f.length,
  }));
}

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot).toLowerCase();
}

export function isVideoFile(name: string): boolean {
  return VIDEO_EXTENSIONS.has(extensionOf(name));
}

function isJunk(file: PickableFile, largest: number): boolean {
  const haystack = file.path;
  if (JUNK_PATTERNS.some((re) => re.test(haystack))) return true;
  // A "sample" that forgot to say so: under 8% of the biggest video file.
  if (largest > 0 && file.length < largest * 0.08) return true;
  return false;
}

export interface EpisodeRef {
  season: number;
  episode: number;
}

/**
 * Matches the common ways an episode is written into a filename.
 * Ordered most-specific first; each returns {season, episode}.
 */
const EPISODE_PATTERNS: Array<{ re: RegExp; season: number; episode: number }> = [
  // S01E02, s1e2, S01.E02, S01 E02
  { re: /\bs(\d{1,2})[ ._-]?e(\d{1,3})\b/i, season: 1, episode: 2 },
  // 1x02, 01x02
  { re: /\b(\d{1,2})x(\d{1,3})\b/i, season: 1, episode: 2 },
  // Season 1 Episode 2
  { re: /\bseason[ ._-]?(\d{1,2})[ ._-]+episode[ ._-]?(\d{1,3})\b/i, season: 1, episode: 2 },
  // S01 - 02  (season folder + loose episode number)
  { re: /\bs(\d{1,2})\b[^\d]{1,6}\b(\d{1,3})\b/i, season: 1, episode: 2 },
];

/** Absolute numbering used by anime and some packs: "- 105", "E105", "[105]". */
const ABSOLUTE_PATTERNS: RegExp[] = [
  /(?:^|[^\d])(?:e|ep|episode)[ ._-]?(\d{1,4})(?:[^\d]|$)/i,
  /[ ._-]-[ ._-](\d{1,4})[ ._-]/,
  /\[(\d{1,4})\]/,
];

export function parseEpisodeFromName(name: string): EpisodeRef | null {
  for (const { re, season, episode } of EPISODE_PATTERNS) {
    const m = re.exec(name);
    if (!m) continue;
    const s = Number(m[season]);
    const e = Number(m[episode]);
    if (Number.isInteger(s) && Number.isInteger(e)) return { season: s, episode: e };
  }
  return null;
}

function parseAbsoluteEpisode(name: string): number | null {
  // Strip things that look like resolution/year so 1080p and 2019 don't win.
  const cleaned = name
    .replace(/\b\d{3,4}[pi]\b/gi, ' ')
    .replace(/\b(19|20)\d{2}\b/g, ' ')
    .replace(/\bx?26[45]\b/gi, ' ')
    .replace(/\b(?:h|x)\.?26[45]\b/gi, ' ');
  for (const re of ABSOLUTE_PATTERNS) {
    const m = re.exec(cleaned);
    const raw = m?.[1];
    if (raw === undefined) continue;
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0 && n < 2000) return n;
  }
  return null;
}

/**
 * Picks the file to stream.
 *
 * For movies: the largest non-junk video file.
 * For series: the file whose season/episode matches; falls back to absolute
 * episode numbering, then to positional order inside a single-season pack.
 * Returns null when the torrent contains no usable video.
 */
export function pickFile(files: PickableFile[], want?: EpisodeRef | null): PickableFile | null {
  const videos = files.filter((f) => isVideoFile(f.name));
  if (videos.length === 0) return null;

  const largest = Math.max(...videos.map((f) => f.length));
  const candidates = videos.filter((f) => !isJunk(f, largest));
  const pool = candidates.length > 0 ? candidates : videos;

  if (!want) {
    return pool.reduce((best, f) => (f.length > best.length ? f : best), pool[0]!);
  }

  // 1. Explicit SxxExx anywhere in the path (folder names count).
  const exact = pool.filter((f) => {
    const ref = parseEpisodeFromName(f.path) ?? parseEpisodeFromName(f.name);
    return ref !== null && ref.season === want.season && ref.episode === want.episode;
  });
  if (exact.length > 0) {
    return exact.reduce((best, f) => (f.length > best.length ? f : best), exact[0]!);
  }

  // 2. Episode-only match when the whole torrent is clearly one season.
  const episodeOnly = pool.filter((f) => {
    const ref = parseEpisodeFromName(f.path);
    if (ref) return false; // already ruled out above
    const abs = parseAbsoluteEpisode(f.name);
    return abs === want.episode;
  });
  if (episodeOnly.length === 1) return episodeOnly[0]!;

  // 3. Absolute numbering (anime style): match the raw absolute number.
  const absolute = pool.filter((f) => parseAbsoluteEpisode(f.name) === want.episode);
  if (absolute.length === 1) return absolute[0]!;

  // 4. Single-file torrent that is presumably the episode itself.
  if (pool.length === 1) return pool[0]!;

  // 5. Last resort: sort naturally and index by episode number.
  const sorted = [...pool].sort((a, b) =>
    a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' })
  );
  const byIndex = sorted[want.episode - 1];
  return byIndex ?? null;
}

/** MIME type used in the streaming response. */
export function mimeFor(name: string): string {
  switch (extensionOf(name)) {
    case '.mp4':
    case '.m4v':
      return 'video/mp4';
    case '.mkv':
      return 'video/x-matroska';
    case '.webm':
      return 'video/webm';
    case '.avi':
      return 'video/x-msvideo';
    case '.mov':
      return 'video/quicktime';
    case '.ts':
    case '.m2ts':
      return 'video/mp2t';
    case '.mpg':
    case '.mpeg':
      return 'video/mpeg';
    case '.wmv':
      return 'video/x-ms-wmv';
    case '.flv':
      return 'video/x-flv';
    case '.ogv':
      return 'video/ogg';
    case '.srt':
      return 'application/x-subrip';
    case '.vtt':
      return 'text/vtt';
    default:
      return 'application/octet-stream';
  }
}
