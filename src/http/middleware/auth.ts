import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

import { config } from '../../config.js';

declare module 'express-serve-static-core' {
  interface Request {
    /** Populated by requireToken so handlers can rebuild tokenised URLs. */
    accessToken?: string;
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Stremio cannot send custom headers, so the token lives in the URL path
 * (`/:token/manifest.json`). We also accept a bearer header or `?token=` for
 * curl and the management UI.
 */
export function requireToken(req: Request, res: Response, next: NextFunction): void {
  if (!config.requireToken) {
    req.accessToken = config.accessToken;
    next();
    return;
  }

  const fromPath = typeof req.params.token === 'string' ? req.params.token : undefined;
  const fromQuery = typeof req.query.token === 'string' ? req.query.token : undefined;
  const header = req.get('authorization');
  const fromHeader = header?.toLowerCase().startsWith('bearer ')
    ? header.slice(7).trim()
    : undefined;

  const candidate = fromPath ?? fromHeader ?? fromQuery;

  if (candidate && constantTimeEqual(candidate, config.accessToken)) {
    req.accessToken = candidate;
    next();
    return;
  }

  res.status(401).json({
    error: 'unauthorized',
    message:
      'Missing or invalid access token. Use /<token>/manifest.json, ?token=…, ' +
      'or an Authorization: Bearer header.',
  });
}

/** Prefix for building absolute URLs that carry the token. */
export function tokenPrefix(): string {
  return config.requireToken ? `/${config.accessToken}` : '';
}
