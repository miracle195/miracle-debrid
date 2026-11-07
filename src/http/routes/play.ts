import { Router, type Request, type Response } from 'express';

import { createLogger } from '../../logger.js';
import { engine } from '../../torrent/engine.js';
import { mimeFor } from '../../torrent/filepick.js';
import { TorrentError } from '../../torrent/types.js';
import { clampRange, parseRange } from '../../util/range.js';
import { asyncRoute } from '../middleware/errors.js';
import { requireToken } from '../middleware/auth.js';

const log = createLogger('play');

/**
 * Open-ended ranges are capped so a "bytes=0-" from a player does not pin one
 * reader on the session for the entire film. 64 MB is comfortably more than
 * any player's buffer window.
 */
const MAX_OPEN_RANGE = 64 * 1024 * 1024;

export const playRouter: Router = Router({ mergeParams: true });

/**
 * GET  /:token/play/:infoHash/:fileIndex/:filename
 * HEAD /:token/play/:infoHash/:fileIndex/:filename
 *
 * The trailing filename is cosmetic but load-bearing in practice: several
 * players sniff the container from the URL extension before they trust
 * Content-Type.
 */
playRouter.head(
  '/play/:infoHash/:fileIndex/:filename?',
  requireToken,
  asyncRoute(handleHead)
);
playRouter.get(
  '/play/:infoHash/:fileIndex/:filename?',
  requireToken,
  asyncRoute(handleGet)
);

async function resolveTarget(req: Request): Promise<{
  session: Awaited<ReturnType<typeof engine.acquireByHash>>;
  fileIndex: number;
  length: number;
  name: string;
}> {
  const infoHash = String(req.params.infoHash ?? '').toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(infoHash)) {
    throw new TorrentError('infoHash must be 40 hex characters', 400);
  }

  const fileIndex = Number(req.params.fileIndex);
  if (!Number.isInteger(fileIndex) || fileIndex < 0) {
    throw new TorrentError('fileIndex must be a non-negative integer', 400);
  }

  const session = await engine.acquireByHash(infoHash);
  const file = session.fileAt(fileIndex);
  return { session, fileIndex, length: file.length, name: file.name };
}

function setCommonHeaders(res: Response, name: string, size: number): void {
  res.setHeader('Content-Type', mimeFor(name));
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'no-store');
  // Some clients refuse to seek without an explicit length hint on HEAD.
  res.setHeader('X-Content-Length', String(size));
  res.setHeader(
    'Content-Disposition',
    `inline; filename*=UTF-8''${encodeURIComponent(name)}`
  );
}

async function handleHead(req: Request, res: Response): Promise<void> {
  const { length, name } = await resolveTarget(req);
  setCommonHeaders(res, name, length);
  res.setHeader('Content-Length', String(length));
  res.status(200).end();
}

async function handleGet(req: Request, res: Response): Promise<void> {
  const { session, fileIndex, length, name } = await resolveTarget(req);

  const parsed = parseRange(req.headers.range, length);

  if (parsed.kind === 'unsatisfiable') {
    res.setHeader('Content-Range', `bytes */${length}`);
    res.status(416).json({ error: 'range_not_satisfiable', size: length });
    return;
  }

  const isPartial = parsed.kind === 'ok';
  const requested = isPartial ? parsed.range : { start: 0, end: Math.max(0, length - 1) };
  const range = clampRange(requested, length, MAX_OPEN_RANGE);
  const chunkSize = range.end - range.start + 1;

  if (length === 0) {
    res.status(200).end();
    return;
  }

  log.debug(
    `${session.infoHash.slice(0, 8)}#${fileIndex} ${range.start}-${range.end}/${length}` +
      ` (${req.headers.range ?? 'no range'})`
  );

  // Fill the head of the range before committing to a status code, so a dead
  // swarm surfaces as a clean 504 instead of a response that hangs forever.
  let head: Buffer;
  try {
    head = await session.prebuffer(fileIndex, range.start, range.end);
  } catch (err) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    throw err;
  }

  if (req.destroyed || res.writableEnded) return;

  setCommonHeaders(res, name, length);
  if (isPartial) {
    res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${length}`);
    res.status(206);
  } else {
    res.status(200);
  }
  res.setHeader('Content-Length', String(chunkSize));

  if (head.length >= chunkSize) {
    res.end(head.subarray(0, chunkSize));
    return;
  }

  if (head.length > 0 && !res.write(head)) {
    await new Promise<void>((resolve) => res.once('drain', resolve));
  }

  const remainderStart = range.start + head.length;
  const stream = session.createReadStream(fileIndex, remainderStart, range.end);

  const cleanup = (): void => {
    stream.destroy();
  };
  res.once('close', cleanup);
  res.once('error', cleanup);

  stream.on('error', (err: Error) => {
    log.debug(`stream aborted for ${session.infoHash.slice(0, 8)}: ${err.message}`);
    if (!res.writableEnded) res.destroy();
  });

  stream.pipe(res);
}
