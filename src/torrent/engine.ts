import fs from 'node:fs';
import path from 'node:path';
import WebTorrent, { type Torrent } from 'webtorrent';

import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { humanBytes } from '../util/bytes.js';
import { infoHashFromMagnet, normalizeMagnet, safeSlug } from '../util/ids.js';
import { singleFlight } from '../util/async.js';
import { TorrentSession } from './session.js';
import { TorrentError, type SessionStats } from './types.js';

const log = createLogger('engine');

export interface AddOptions {
  /** Human-readable name, used for the on-disk folder and the UI. */
  displayName?: string;
}

/**
 * Owns the single WebTorrent client and the map of live sessions.
 *
 * Everything that wants to stream goes through `acquire()`, which is
 * single-flighted per infohash so concurrent requests share one swarm.
 */
export class TorrentEngine {
  private readonly client: WebTorrent;
  private readonly sessions = new Map<string, TorrentSession>();
  private readonly magnets = new Map<string, string>();
  private readonly flight = singleFlight<TorrentSession>();
  private sweeper: NodeJS.Timeout | null = null;
  private shuttingDown = false;

  constructor() {
    this.client = new WebTorrent({
      maxConns: config.torrent.maxConns,
      dht: config.torrent.dht,
      ...(config.torrent.torrentPort > 0 ? { torrentPort: config.torrent.torrentPort } : {}),
      ...(config.torrent.downloadLimit >= 0
        ? { downloadLimit: config.torrent.downloadLimit }
        : {}),
      ...(config.torrent.uploadLimit >= 0 ? { uploadLimit: config.torrent.uploadLimit } : {}),
    });

    this.client.on('error', (err: unknown) => {
      // Client-level errors are usually a single bad torrent; never fatal.
      log.warn('webtorrent client error', err);
    });

    this.loadMagnetIndex();
    this.startSweeper();
  }

  // ---------------------------------------------------------------- lifecycle

  private startSweeper(): void {
    this.sweeper = setInterval(() => {
      void this.sweepIdle();
    }, 60_000);
    this.sweeper.unref?.();
  }

  private async sweepIdle(): Promise<void> {
    if (this.shuttingDown) return;
    const now = Date.now();
    for (const [hash, session] of this.sessions) {
      if (session.readers > 0) continue;
      if (now - session.lastAccessAt < config.torrent.idleTimeoutMs) continue;

      const keepFiles = true; // the cache store decides when bytes get deleted
      log.info(`idle teardown of ${hash.slice(0, 8)} (${session.torrent.name})`);
      this.sessions.delete(hash);
      await session.destroy(!keepFiles);
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.sweeper) clearInterval(this.sweeper);
    await Promise.all([...this.sessions.values()].map((s) => s.destroy(false)));
    this.sessions.clear();
    await new Promise<void>((resolve) => {
      this.client.destroy(() => resolve());
      setTimeout(resolve, 5_000).unref?.();
    });
    log.info('engine shut down');
  }

  // ------------------------------------------------------------------ magnets

  private get magnetIndexPath(): string {
    return path.join(config.dataDir, 'magnets.json');
  }

  /**
   * An infohash alone cannot be re-added after a restart — we need the tracker
   * list and name back — so every magnet we have ever seen is persisted.
   */
  private loadMagnetIndex(): void {
    try {
      if (!fs.existsSync(this.magnetIndexPath)) return;
      const raw = JSON.parse(fs.readFileSync(this.magnetIndexPath, 'utf8')) as unknown;
      if (raw && typeof raw === 'object') {
        for (const [hash, magnet] of Object.entries(raw as Record<string, string>)) {
          if (typeof magnet === 'string') this.magnets.set(hash.toLowerCase(), magnet);
        }
      }
      log.info(`loaded ${this.magnets.size} known magnets`);
    } catch (err) {
      log.warn('could not read magnet index, starting empty', err);
    }
  }

  private saveMagnetIndex(): void {
    try {
      const tmp = `${this.magnetIndexPath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.magnets), null, 2));
      fs.renameSync(tmp, this.magnetIndexPath);
    } catch (err) {
      log.warn('could not persist magnet index', err);
    }
  }

  rememberMagnet(magnet: string): string {
    const normalized = normalizeMagnet(magnet);
    const hash = infoHashFromMagnet(normalized);
    if (!hash) throw new TorrentError('Magnet has no infohash', 400);
    this.magnets.set(hash, normalized);
    this.saveMagnetIndex();
    return hash;
  }

  knownMagnet(infoHash: string): string | undefined {
    return this.magnets.get(infoHash.toLowerCase());
  }

  // ----------------------------------------------------------------- sessions

  getSession(infoHash: string): TorrentSession | undefined {
    return this.sessions.get(infoHash.toLowerCase());
  }

  listSessions(): SessionStats[] {
    return [...this.sessions.values()].map((s) => s.stats());
  }

  /**
   * Returns a session with metadata already resolved, adding the torrent if it
   * is not live yet. Safe to call concurrently for the same magnet.
   */
  async acquire(magnetOrHash: string, opts: AddOptions = {}): Promise<TorrentSession> {
    const magnet = normalizeMagnet(magnetOrHash, opts.displayName);
    const infoHash = infoHashFromMagnet(magnet);
    if (!infoHash) throw new TorrentError('Could not determine infohash', 400);

    const existing = this.sessions.get(infoHash);
    if (existing && !existing.isDestroyed) {
      existing.touch();
      return existing;
    }

    this.magnets.set(infoHash, magnet);
    this.saveMagnetIndex();

    return this.flight(infoHash, () => this.addTorrent(magnet, infoHash, opts));
  }

  /** Resolves an infohash we have seen before, without needing the magnet. */
  async acquireByHash(infoHash: string): Promise<TorrentSession> {
    const hash = infoHash.toLowerCase();
    const live = this.sessions.get(hash);
    if (live && !live.isDestroyed) {
      live.touch();
      return live;
    }
    const magnet = this.magnets.get(hash);
    if (!magnet) {
      throw new TorrentError(
        `Unknown infohash ${hash}. Add it via POST /api/torrents first.`,
        404
      );
    }
    return this.acquire(magnet);
  }

  private addTorrent(
    magnet: string,
    infoHash: string,
    opts: AddOptions
  ): Promise<TorrentSession> {
    const folder = path.join(
      config.downloadDir,
      `${infoHash}${opts.displayName ? `-${safeSlug(opts.displayName)}` : ''}`
    );

    log.info(`adding ${infoHash.slice(0, 8)} -> ${folder}`);

    return new Promise<TorrentSession>((resolve, reject) => {
      let settled = false;
      let torrent: Torrent;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          torrent?.destroy({ destroyStore: false });
        } catch {
          /* torrent may already be gone */
        }
        reject(
          new TorrentError(
            `No metadata after ${config.torrent.metadataTimeoutMs}ms — nobody in the ` +
              `swarm answered for ${infoHash.slice(0, 8)}.`,
            504
          )
        );
      }, config.torrent.metadataTimeoutMs);

      const onReady = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);

        const session = new TorrentSession(torrent, infoHash);
        this.sessions.set(infoHash, session);

        // Nothing is selected until a stream asks for a specific file.
        for (const f of torrent.files) {
          try {
            f.deselect();
          } catch {
            /* ignore */
          }
        }
        if (torrent.strategy !== undefined) torrent.strategy = 'sequential';

        log.info(
          `ready ${infoHash.slice(0, 8)} "${torrent.name}" ` +
            `${torrent.files.length} file(s) ${humanBytes(torrent.length)}`
        );
        resolve(session);
      };

      try {
        torrent = this.client.add(
          magnet,
          {
            path: folder,
            announce: config.torrent.trackers,
            strategy: 'sequential',
            deselect: true,
          },
          () => onReady()
        );
      } catch (err) {
        clearTimeout(timer);
        reject(new TorrentError(`Could not add torrent: ${(err as Error).message}`, 400));
        return;
      }

      torrent.on('error', (err: Error) => {
        log.warn(`torrent ${infoHash.slice(0, 8)} error: ${err.message}`);
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new TorrentError(`Torrent error: ${err.message}`, 502));
      });

      torrent.on('done', () => {
        log.info(`download complete for ${infoHash.slice(0, 8)}`);
        if (!config.torrent.seedAfterDownload) {
          // Stop uploading but keep the files; readers still stream from disk.
          try {
            torrent.pause();
          } catch {
            /* ignore */
          }
        }
      });

      // `ready` may already have fired by the time we attach if the torrent was
      // in the client's cache; cover that case too.
      if (torrent.ready) onReady();
      else torrent.once('ready', onReady);
    });
  }

  async remove(infoHash: string, deleteFiles: boolean): Promise<boolean> {
    const hash = infoHash.toLowerCase();
    const session = this.sessions.get(hash);
    if (session) {
      this.sessions.delete(hash);
      await session.destroy(deleteFiles);
      return true;
    }
    return false;
  }

  globalStats(): { downloadSpeed: number; uploadSpeed: number; torrents: number } {
    return {
      downloadSpeed: this.client.downloadSpeed ?? 0,
      uploadSpeed: this.client.uploadSpeed ?? 0,
      torrents: this.sessions.size,
    };
  }
}

export const engine = new TorrentEngine();
