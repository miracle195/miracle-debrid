import { Router, type Request, type Response } from 'express';

import { config } from '../../config.js';
import { enabledProviders } from '../../catalog/index.js';
import { evictOne, listCache, sweep, totalCacheBytes } from '../../cache/store.js';
import { engine } from '../../torrent/engine.js';
import { pickFile, toPickable } from '../../torrent/filepick.js';
import { TorrentError } from '../../torrent/types.js';
import { humanBytes } from '../../util/bytes.js';
import { infoHashFromMagnet, normalizeMagnet } from '../../util/ids.js';
import { asyncRoute } from '../middleware/errors.js';
import { requireToken, tokenPrefix } from '../middleware/auth.js';

export const apiRouter: Router = Router({ mergeParams: true });

// Scoped to /api on purpose: a blanket apiRouter.use(requireToken) would also
// fire for "/" and lock the dashboard out behind a token it has not asked for
// yet.
apiRouter.use('/api', requireToken);

/** Everything the dashboard needs in one call. */
apiRouter.get(
  '/api/status',
  asyncRoute(async (_req: Request, res: Response) => {
    const cacheBytes = await totalCacheBytes();
    const global = engine.globalStats();
    res.json({
      addon: config.addon,
      publicUrl: config.publicUrl,
      manifestUrl: `${config.publicUrl}${tokenPrefix()}/manifest.json`,
      providers: enabledProviders(),
      torrents: engine.listSessions(),
      global,
      cache: {
        bytes: cacheBytes,
        human: humanBytes(cacheBytes),
        maxBytes: config.cache.maxBytes,
        maxHuman: humanBytes(config.cache.maxBytes),
      },
    });
  })
);

/**
 * POST /api/torrents  { magnet, season?, episode? }
 *
 * Adds a magnet, waits for metadata, picks the file, and hands back a
 * ready-to-play URL. This is the path the web UI uses.
 */
apiRouter.post(
  '/api/torrents',
  asyncRoute(async (req: Request, res: Response) => {
    const body = req.body as { magnet?: unknown; season?: unknown; episode?: unknown };
    const raw = typeof body?.magnet === 'string' ? body.magnet.trim() : '';
    if (!raw) throw new TorrentError('Body must include a "magnet" string', 400);

    let magnet: string;
    try {
      magnet = normalizeMagnet(raw);
    } catch (err) {
      throw new TorrentError((err as Error).message, 400);
    }

    const season = Number(body?.season);
    const episode = Number(body?.episode);
    const want =
      Number.isInteger(season) && Number.isInteger(episode) ? { season, episode } : null;

    const session = await engine.acquire(magnet);
    const picked = pickFile(toPickable(session.torrent.files), want);

    const base = `${config.publicUrl}${tokenPrefix()}`;
    res.status(201).json({
      infoHash: session.infoHash,
      name: session.torrent.name,
      files: session.files(),
      picked: picked ?? null,
      playUrl: picked
        ? `${base}/play/${session.infoHash}/${picked.index}/${encodeURIComponent(picked.name)}`
        : null,
      stats: session.stats(),
    });
  })
);

apiRouter.get(
  '/api/torrents',
  asyncRoute(async (_req: Request, res: Response) => {
    res.json({ torrents: engine.listSessions() });
  })
);

apiRouter.get(
  '/api/torrents/:infoHash',
  asyncRoute(async (req: Request, res: Response) => {
    const hash = String(req.params.infoHash ?? '').toLowerCase();
    const session = engine.getSession(hash);
    if (!session) throw new TorrentError('Torrent is not currently loaded', 404);
    res.json(session.stats());
  })
);

/** DELETE /api/torrents/:infoHash?deleteFiles=true */
apiRouter.delete(
  '/api/torrents/:infoHash',
  asyncRoute(async (req: Request, res: Response) => {
    const hash = String(req.params.infoHash ?? '').toLowerCase();
    const deleteFiles = req.query.deleteFiles === 'true' || req.query.deleteFiles === '1';

    const removed = deleteFiles ? await evictOne(hash) : await engine.remove(hash, false);
    res.json({ infoHash: hash, removed, filesDeleted: deleteFiles && removed });
  })
);

apiRouter.get(
  '/api/cache',
  asyncRoute(async (_req: Request, res: Response) => {
    const entries = await listCache();
    const bytes = entries.reduce((sum, e) => sum + e.bytes, 0);
    res.json({
      bytes,
      human: humanBytes(bytes),
      maxBytes: config.cache.maxBytes,
      entries: entries
        .sort((a, b) => b.bytes - a.bytes)
        .map((e) => ({ ...e, human: humanBytes(e.bytes) })),
    });
  })
);

apiRouter.post(
  '/api/cache/sweep',
  asyncRoute(async (_req: Request, res: Response) => {
    const result = await sweep();
    res.json({ ...result, freedHuman: humanBytes(result.freed) });
  })
);

/** Resolves a magnet to a play URL without the UI, for scripting. */
apiRouter.get(
  '/api/resolve',
  asyncRoute(async (req: Request, res: Response) => {
    const magnet = typeof req.query.magnet === 'string' ? req.query.magnet : '';
    if (!magnet) throw new TorrentError('Query must include ?magnet=', 400);

    const normalized = normalizeMagnet(magnet);
    const infoHash = infoHashFromMagnet(normalized);
    if (!infoHash) throw new TorrentError('Magnet has no infohash', 400);

    const session = await engine.acquire(normalized);
    const picked = pickFile(toPickable(session.torrent.files), null);
    const base = `${config.publicUrl}${tokenPrefix()}`;

    res.json({
      infoHash,
      name: session.torrent.name,
      playUrl: picked
        ? `${base}/play/${infoHash}/${picked.index}/${encodeURIComponent(picked.name)}`
        : null,
      files: session.files(),
    });
  })
);
