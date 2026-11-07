export interface ByteRange {
  /** Inclusive. */
  start: number;
  /** Inclusive. */
  end: number;
}

export type RangeResult =
  | { kind: 'none' }
  | { kind: 'ok'; range: ByteRange }
  | { kind: 'unsatisfiable' };

/**
 * RFC 7233 single-range parser.
 *
 * Multi-range requests are deliberately not supported: video players never
 * send them, and answering one requires multipart/byteranges. If we see a
 * multi-range header we serve the first range only, which is a legal response
 * (a server may always return less than asked).
 */
export function parseRange(header: string | undefined, size: number): RangeResult {
  if (!header) return { kind: 'none' };

  const match = /^bytes=(.+)$/i.exec(header.trim());
  if (!match || match[1] === undefined) return { kind: 'unsatisfiable' };

  const first = match[1].split(',')[0]?.trim();
  if (!first) return { kind: 'unsatisfiable' };

  // Suffix form: "-500" means the last 500 bytes.
  if (first.startsWith('-')) {
    const suffixLength = Number(first.slice(1));
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return { kind: 'unsatisfiable' };
    if (size === 0) return { kind: 'unsatisfiable' };
    const start = Math.max(0, size - Math.floor(suffixLength));
    return { kind: 'ok', range: { start, end: size - 1 } };
  }

  const [startRaw, endRaw] = first.split('-');
  const start = Number(startRaw);
  if (!Number.isInteger(start) || start < 0) return { kind: 'unsatisfiable' };
  if (start >= size) return { kind: 'unsatisfiable' };

  let end: number;
  if (endRaw === undefined || endRaw === '') {
    end = size - 1;
  } else {
    const parsed = Number(endRaw);
    if (!Number.isInteger(parsed) || parsed < start) return { kind: 'unsatisfiable' };
    end = Math.min(parsed, size - 1);
  }

  return { kind: 'ok', range: { start, end } };
}

/**
 * Caps how much we promise to deliver in one response.
 *
 * Players commonly ask for "bytes=0-" on a 40 GB file. Serving that as one
 * open-ended body is fine for playback but makes seeking sluggish and pins a
 * reader on the session forever, so large open ranges get chunked.
 */
export function clampRange(range: ByteRange, size: number, maxChunk: number): ByteRange {
  if (maxChunk <= 0) return range;
  const length = range.end - range.start + 1;
  if (length <= maxChunk) return range;
  return { start: range.start, end: Math.min(size - 1, range.start + maxChunk - 1) };
}
