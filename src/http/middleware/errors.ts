import type { NextFunction, Request, Response } from 'express';

import { createLogger } from '../../logger.js';
import { TorrentError } from '../../torrent/types.js';
import { TimeoutError } from '../../util/async.js';

const log = createLogger('http');

export function notFound(_req: Request, res: Response): void {
  res.status(404).json({ error: 'not_found' });
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (res.headersSent) {
    // Mid-body failure: the only honest thing left is to cut the connection.
    log.warn(`${req.method} ${req.path} failed after headers were sent`, err);
    res.destroy();
    return;
  }

  let status = 500;
  let message = 'Internal server error';

  if (err instanceof TorrentError) {
    status = err.status;
    message = err.message;
  } else if (err instanceof TimeoutError) {
    status = 504;
    message = err.message;
  } else if (err instanceof Error) {
    message = err.message;
  }

  if (status >= 500) log.error(`${req.method} ${req.path} -> ${status}`, err);
  else log.debug(`${req.method} ${req.path} -> ${status}: ${message}`);

  res.status(status).json({ error: statusSlug(status), message });
  void next;
}

function statusSlug(status: number): string {
  switch (status) {
    case 400: return 'bad_request';
    case 401: return 'unauthorized';
    case 404: return 'not_found';
    case 410: return 'gone';
    case 416: return 'range_not_satisfiable';
    case 502: return 'upstream_error';
    case 504: return 'timeout';
    default: return 'error';
  }
}

/** Wraps an async handler so rejections reach the error middleware. */
export function asyncRoute<T extends Request>(
  fn: (req: T, res: Response, next: NextFunction) => Promise<unknown>
) {
  return (req: T, res: Response, next: NextFunction): void => {
    void fn(req, res, next).catch(next);
  };
}
