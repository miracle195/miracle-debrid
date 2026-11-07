import { Readable } from 'node:stream';
import type { Torrent, TorrentFile } from 'webtorrent';

import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { isVideoFile } from './filepick.js';
import { TorrentError, type SessionStats, type TorrentFileInfo } from './types.js';

const log = createLogger('session');

/**
 * One live torrent, plus the bookkeeping that decides when it may be torn
 * down. `readers` is the number of HTTP responses currently piping from it;
 * the idle sweeper only touches sessions with zero readers.
 */
export class TorrentSession {
  readonly infoHash: string;
  readonly torrent: Torrent;
  readonly addedAt = Date.now();

  private readerCount = 0;
  private lastAccess = Date.now();
  private selectedIndex: number | null = null;
  private destroyed = false;

  constructor(torrent: Torrent, fallbackInfoHash?: string) {
    this.torrent = torrent;
    // infoHash is only populated once metadata lands; sessions are built from
    // the ready callback so it is normally set, but a torrent that was torn
    // down mid-handshake can leave it undefined.
    const hash = torrent.infoHash ?? fallbackInfoHash;
    if (!hash) throw new TorrentError('Torrent has no infoHash yet', 500);
    this.infoHash = hash.toLowerCase();
  }

  get readers(): number {
    return this.readerCount;
  }

  get lastAccessAt(): number {
    return this.lastAccess;
  }

  get isDestroyed(): boolean {
    return this.destroyed;
  }

  touch(): void {
    this.lastAccess = Date.now();
  }

  files(): TorrentFileInfo[] {
    return this.torrent.files.map((f, index) => ({
      index,
      name: f.name,
      path: f.path,
      length: f.length,
      isVideo: isVideoFile(f.name),
    }));
  }

  fileAt(index: number): TorrentFile {
    const file = this.torrent.files[index];
    if (!file) {
      throw new TorrentError(`File index ${index} out of range for ${this.infoHash}`, 404);
    }
    return file;
  }

  /**
   * Downloads only the file we are about to serve. Without this, WebTorrent
   * happily pulls every file in a 60 GB season pack to play one episode.
   */
  selectOnly(index: number): void {
    if (this.selectedIndex === index) {
      this.touch();
      return;
    }
    const target = this.fileAt(index);

    for (const f of this.torrent.files) {
      try {
        f.deselect();
      } catch {
        /* deselect on an already-deselected file is a no-op we can ignore */
      }
    }
    try {
      // Belt and braces: drop any whole-torrent selection webtorrent added.
      if (Array.isArray(this.torrent.pieces) && this.torrent.pieces.length > 0) {
        this.torrent.deselect(0, this.torrent.pieces.length - 1, 0);
      }
    } catch {
      /* older/newer signature mismatch; the per-file deselect above covers us */
    }

    target.select(1);
    this.selectedIndex = index;
    this.touch();
    log.info(`${this.shortHash()} selected file #${index} "${target.name}"`);
  }

  /**
   * Reads [start, end] inclusive. The returned stream increments the reader
   * count for its whole lifetime, which keeps the idle sweeper away.
   */
  createReadStream(index: number, start: number, end: number): Readable {
    if (this.destroyed) throw new TorrentError('Session already destroyed', 410);

    const file = this.fileAt(index);
    if (start < 0 || end < start || end >= file.length) {
      throw new TorrentError(`Invalid byte range ${start}-${end} for "${file.name}"`, 416);
    }

    this.selectOnly(index);
    this.retain();

    const stream = file.createReadStream({ start, end });
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      this.release();
    };

    stream.once('end', release);
    stream.once('close', release);
    stream.once('error', (err: Error) => {
      // A player seeking or closing the tab aborts mid-stream constantly;
      // that is normal traffic, not a fault worth shouting about.
      log.debug(`${this.shortHash()} read stream ended: ${err.message}`);
      release();
    });

    return stream;
  }

  /**
   * Buffers the head of a range before the response starts, so players do not
   * open on an empty pipe. Resolves with whatever it managed to read.
   */
  async prebuffer(index: number, start: number, end: number): Promise<Buffer> {
    const want = Math.min(config.torrent.prebufferBytes, end - start + 1);
    if (want <= 0) return Buffer.alloc(0);

    const stream = this.createReadStream(index, start, start + want - 1);
    const chunks: Buffer[] = [];
    let size = 0;

    return new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => {
        stream.destroy();
        reject(
          new TorrentError(
            `Timed out waiting ${config.torrent.prebufferTimeoutMs}ms for the first ` +
              `${want} bytes — the swarm may have no seeders.`,
            504
          )
        );
      }, config.torrent.prebufferTimeoutMs);

      stream.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        size += chunk.length;
      });
      stream.once('end', () => {
        clearTimeout(timer);
        resolve(Buffer.concat(chunks, size));
      });
      stream.once('error', (err: Error) => {
        clearTimeout(timer);
        reject(new TorrentError(`Prebuffer failed: ${err.message}`, 502));
      });
    });
  }

  retain(): void {
    this.readerCount++;
    this.touch();
  }

  release(): void {
    this.readerCount = Math.max(0, this.readerCount - 1);
    this.touch();
  }

  stats(): SessionStats {
    const t = this.torrent;
    return {
      infoHash: this.infoHash,
      name: t.name ?? this.infoHash,
      totalLength: t.length ?? 0,
      downloaded: t.downloaded ?? 0,
      progress: t.progress ?? 0,
      downloadSpeed: t.downloadSpeed ?? 0,
      uploadSpeed: t.uploadSpeed ?? 0,
      numPeers: t.numPeers ?? 0,
      timeRemaining: t.timeRemaining ?? 0,
      ready: Boolean(t.ready),
      done: Boolean(t.done),
      readers: this.readerCount,
      addedAt: this.addedAt,
      lastAccessAt: this.lastAccess,
      selectedFileIndex: this.selectedIndex,
      files: this.files(),
    };
  }

  destroy(deleteFiles: boolean): Promise<void> {
    if (this.destroyed) return Promise.resolve();
    this.destroyed = true;
    return new Promise((resolve) => {
      try {
        this.torrent.destroy({ destroyStore: deleteFiles }, () => resolve());
      } catch (err) {
        log.warn(`${this.shortHash()} destroy threw`, err);
        resolve();
      }
      // WebTorrent occasionally never fires the callback on a half-dead
      // torrent; do not let shutdown hang on it.
      setTimeout(resolve, 5_000).unref?.();
    });
  }

  private shortHash(): string {
    return this.infoHash.slice(0, 8);
  }
}
