import { config } from './config.js';
import { log } from './logger.js';
import { startCacheSweeper, stopCacheSweeper } from './cache/store.js';
import { engine } from './torrent/engine.js';
import { startServer } from './http/server.js';
import { humanBytes } from './util/bytes.js';

async function main(): Promise<void> {
  log.info(`${config.addon.name} v${config.addon.version} starting`);
  log.info(`data dir      ${config.dataDir}`);
  log.info(`download dir  ${config.downloadDir}`);
  log.info(`cache cap     ${humanBytes(config.cache.maxBytes)}`);
  if (config.requireToken) {
    log.info(`access token  ${config.accessToken}`);
  } else {
    log.warn('REQUIRE_TOKEN is off — anyone who can reach this port can use it');
  }

  const server = await startServer();
  startCacheSweeper();

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`${signal} received, shutting down`);

    stopCacheSweeper();
    server.close();
    // Give in-flight responses a moment, then drop the swarm.
    setTimeout(() => {
      log.warn('forced exit after 15s');
      process.exit(1);
    }, 15_000).unref();

    await engine.shutdown();
    log.info('bye');
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason) => {
    log.error('unhandled rejection', reason);
  });
  process.on('uncaughtException', (err) => {
    // A torrent library throwing async is not a reason to drop everyone's
    // stream; log loudly and keep serving.
    log.error('uncaught exception', err);
  });
}

main().catch((err) => {
  log.error('fatal startup error', err);
  process.exit(1);
});
