import { Router, type Request, type Response } from 'express';

import { config } from '../../config.js';
import { createLogger } from '../../logger.js';
import { findSources } from '../../catalog/index.js';
import { resolveTitle } from '../../catalog/resolver.js';
import { engine } from '../../torrent/engine.js';
import { pickFile, toPickable } from '../../torrent/filepick.js';
import { TorrentError } from '../../torrent/types.js';
import { humanBytes } from '../../util/bytes.js';
import { infoHashFromMagnet, normalizeMagnet, parseStremioId } from '../../util/ids.js';
import { buildManifest, type StreamResponse, type StremioStream } from '../../stremio/manifest.js';
import { asyncRoute } from '../middleware/errors.js';
import { requireToken, tokenPrefix } from '../middleware/auth.js';

const log = createLogger('stremio');

export const stremioRouter: Router = Router({ mergeParams: true });

stremioRouter.get('/manifest.json', requireToken, (_req: Request, res: Response) => {
  res.json(buildManifest());
});

/**
 * GET /:token/stream/:type/:id.json
 *
 * Stremio calls this to fill the source list for a title. We answer with one
 * entry per candidate release; the actual download only starts when the user
 * picks one and the player hits /play.
 */
stremioRouter.get(
  '/stream/:type/:id.json',
  requireToken,
  asyncRoute(async (req: Request, res: Response) => {
    const type = String(req.params.type);
    if (type !== 'movie' && type !== 'series') {
      res.json({ streams: [] } satisfies StreamResponse);
      return;
    }

    const parsed = parseStremioId(String(req.params.id ?? ''));
    if (!parsed) {
      res.json({ streams: [] } satisfies StreamResponse);
      return;
    }

    const meta = await resolveTitle(parsed.imdbId, type);
    const results = await findSources({ id: parsed, type, meta });

    log.info(
      `${type} ${parsed.imdbId}${
        parsed.season !== undefined ? ` S${parsed.season}E${parsed.episode}` : ''
      } -> ${results.length} candidate(s)`
    );

    const base = `${config.publicUrl}${tokenPrefix()}`;
    const bingeGroup = `miracle-${parsed.imdbId}`;

    const streams: StremioStream[] = [];
    for (const result of results) {
      let infoHash: string | null;
      try {
        infoHash = infoHashFromMagnet(normalizeMagnet(result.magnet));
      } catch {
        continue;
      }
      if (!infoHash) continue;

      // Remember it now so /play can resolve the hash without the magnet.
      try {
        engine.rememberMagnet(result.magnet);
      } catch (err) {
        log.debug(`skipping unusable magnet: ${(err as Error).message}`);
        continue;
      }

      // fileIndex "auto" makes the server pick the right episode at play time,
      // which avoids fetching metadata for every candidate just to build a list.
      const episodePart =
        parsed.season !== undefined && parsed.episode !== undefined
          ? `?s=${parsed.season}&e=${parsed.episode}`
          : '';

      const detail = [
        result.quality ?? '',
        result.size ? humanBytes(result.size) : '',
        result.seeders !== undefined ? `${result.seeders} seeders` : '',
        result.provider,
      ]
        .filter(Boolean)
        .join(' · ');

      streams.push({
        name: `${config.addon.name}\n${result.quality ?? 'SD'}`,
        title: `${result.title}\n${detail}`,
        url: `${base}/resolve/${infoHash}/auto${episodePart}`,
        behaviorHints: {
          bingeGroup: `${bingeGroup}-${result.quality ?? 'sd'}`,
          notWebReady: false,
          ...(result.size ? { videoSize: result.size } : {}),
          filename: result.title,
        },
      });
    }

    res.json({
      streams,
      cacheMaxAge: 300,
      staleRevalidate: 600,
    } satisfies StreamResponse);
  })
);

/**
 * GET /:token/resolve/:infoHash/auto?s=&e=
 *
 * Fetches metadata, picks the right file, and 302s to the real /play URL.
 * Doing the pick here (rather than in /stream) means the swarm is only touched
 * for the release the user actually clicked.
 */
stremioRouter.get(
  '/resolve/:infoHash/auto',
  requireToken,
  asyncRoute(async (req: Request, res: Response) => {
    const infoHash = String(req.params.infoHash ?? '').toLowerCase();
    if (!/^[a-f0-9]{40}$/.test(infoHash)) {
      throw new TorrentError('infoHash must be 40 hex characters', 400);
    }

    const season = req.query.s !== undefined ? Number(req.query.s) : undefined;
    const episode = req.query.e !== undefined ? Number(req.query.e) : undefined;
    const want =
      Number.isInteger(season) && Number.isInteger(episode)
        ? { season: season!, episode: episode! }
        : null;

    const session = await engine.acquireByHash(infoHash);
    const picked = pickFile(toPickable(session.torrent.files), want);

    if (!picked) {
      throw new TorrentError(
        want
          ? `No file matching S${want.season}E${want.episode} in "${session.torrent.name}"`
          : `No video file found in "${session.torrent.name}"`,
        404
      );
    }

    session.selectOnly(picked.index);

    const target =
      `${config.publicUrl}${tokenPrefix()}/play/${infoHash}/${picked.index}/` +
      encodeURIComponent(picked.name);

    log.info(`resolved ${infoHash.slice(0, 8)} -> #${picked.index} "${picked.name}"`);
    res.redirect(302, target);
  })
);
