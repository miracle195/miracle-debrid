import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express, { type Express, type Request, type Response } from 'express';

import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { engine } from '../torrent/engine.js';
import { apiRouter } from './routes/api.js';
import { playRouter } from './routes/play.js';
import { stremioRouter } from './routes/stremio.js';
import { errorHandler, notFound } from './middleware/errors.js';
import { tokenPrefix } from './middleware/auth.js';
import { startDiscoveryService } from '../discovery.js';

const log = createLogger('server');
const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, '../../public');

export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  // Behind nginx we want the real client IP in logs and rate decisions.
  app.set('trust proxy', true);

  // Stremio's web player is a different origin, so the addon must be open CORS.
  // The access token in the path is what actually gates access.
  app.use(
    cors({
      origin: '*',
      methods: ['GET', 'HEAD', 'POST', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'Range'],
      exposedHeaders: ['Content-Range', 'Accept-Ranges', 'Content-Length'],
      maxAge: 86400,
    })
  );

  app.use(express.json({ limit: '256kb' }));

  app.get('/health', (req: Request, res: Response) => {
    const host = req.get('host') || `${config.localIp}:${config.port}`;
    const proto = req.protocol || 'http';
    res.json({
      ok: true,
      service: 'miracle-debrid',
      uptime: Math.round(process.uptime()),
      torrents: engine.globalStats().torrents,
      version: config.addon.version,
      ip: config.localIp,
      hostname: config.localHostname,
      port: config.port,
      manifestUrl: `${proto}://${host}${tokenPrefix()}/manifest.json`,
      localManifestUrl: `http://${config.localHostname}:${config.port}${tokenPrefix()}/manifest.json`,
    });
  });

  // Every route is mounted twice: once under /:token for Stremio (which cannot
  // send headers) and once bare, so header/query auth still works.
  const routers = [stremioRouter, playRouter, apiRouter];
  for (const router of routers) {
    app.use('/:token', router);
    app.use('/', router);
  }

  app.use(express.static(publicDir, { index: false, maxAge: '1h' }));

  app.get(['/', '/configure', '/:token/configure'], (_req: Request, res: Response) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

export function startServer(): Promise<import('node:http').Server> {
  const app = createApp();

  return new Promise((resolve, reject) => {
    const server = app.listen(config.port, config.host, () => {
      const manifest = `${config.publicUrl}${tokenPrefix()}/manifest.json`;
      const localManifest = `http://${config.localHostname}:${config.port}${tokenPrefix()}/manifest.json`;
      log.info(`listening on http://${config.host}:${config.port}`);
      log.info(`local IP    http://${config.localIp}:${config.port}`);
      log.info(`mDNS host   http://${config.localHostname}:${config.port}`);
      log.info(`manifest    ${manifest}`);
      log.info(`LAN URL     ${localManifest} (persistent across IP/DHCP changes)`);
      log.info(`install in Stremio with: stremio://${localManifest.replace(/^https?:\/\//, '')}`);
      startDiscoveryService();
      resolve(server);
    });

    // Long-lived video responses must not be cut by the default header/idle
    // timeouts while the swarm is still warming up.
    server.requestTimeout = 0;
    server.headersTimeout = 120_000;
    server.keepAliveTimeout = 72_000;
    server.timeout = 0;

    server.on('error', reject);
  });
}
