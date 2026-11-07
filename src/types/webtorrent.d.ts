/**
 * Minimal ambient types for webtorrent v3.
 *
 * webtorrent ships no types of its own and the DefinitelyTyped package
 * (@types/webtorrent) still describes the v0.x/v1.x API, which conflicts with
 * v3 in several places. Rather than fight it, we declare exactly the surface
 * we use. If you start calling more of the API, add it here.
 *
 * Note: webtorrent v2.8.x is NOT usable with current parse-torrent releases —
 * it expects infoHash as a Uint8Array while parse-torrent >=11.0.2x returns a
 * string, which makes every add() throw. Stay on v3.
 */
declare module 'webtorrent' {
  import type { Readable } from 'node:stream';
  import type { EventEmitter } from 'node:events';

  export interface TorrentFile {
    name: string;
    /** Path of the file inside the torrent, e.g. "Some.Show.S01/ep01.mkv" */
    path: string;
    length: number;
    downloaded: number;
    progress: number;
    createReadStream(opts?: { start?: number; end?: number }): Readable;
    select(priority?: number): void;
    deselect(): void;
  }

  export interface Torrent extends EventEmitter {
    infoHash: string;
    magnetURI: string;
    name: string;
    length: number;
    pieceLength: number;
    lastPieceLength: number;
    /** Non-null once metadata has arrived. */
    pieces: Array<unknown | null>;
    files: TorrentFile[];
    path: string;
    ready: boolean;
    paused: boolean;
    done: boolean;
    progress: number;
    downloaded: number;
    uploaded: number;
    downloadSpeed: number;
    uploadSpeed: number;
    numPeers: number;
    timeRemaining: number;
    /** webtorrent internal-ish but stable enough; guarded at every call site. */
    bitfield?: { get(index: number): boolean };
    strategy?: 'sequential' | 'rarest';
    select(start: number, end: number, priority?: number): void;
    deselect(start: number, end: number, priority?: number): void;
    critical(start: number, end: number): void;
    pause(): void;
    resume(): void;
    destroy(opts?: { destroyStore?: boolean }, cb?: (err?: Error) => void): void;
  }

  export interface TorrentOptions {
    path?: string;
    announce?: string[];
    maxWebConns?: number;
    strategy?: 'sequential' | 'rarest';
    /** Do not auto-select every file for download. */
    deselect?: boolean;
    store?: unknown;
    storeCacheSlots?: number;
  }

  export interface WebTorrentOptions {
    maxConns?: number;
    downloadLimit?: number;
    uploadLimit?: number;
    dht?: boolean;
    lsd?: boolean;
    natUpnp?: boolean | 'permanent';
    natPmp?: boolean;
    utp?: boolean;
    torrentPort?: number;
    dhtPort?: number;
    tracker?: boolean | Record<string, unknown>;
    webSeeds?: boolean;
  }

  export default class WebTorrent extends EventEmitter {
    constructor(opts?: WebTorrentOptions);
    torrents: Torrent[];
    downloadSpeed: number;
    uploadSpeed: number;
    progress: number;
    add(
      torrentId: string | Buffer,
      opts?: TorrentOptions,
      onTorrent?: (torrent: Torrent) => void
    ): Torrent;
    get(torrentId: string): Promise<Torrent | null> | Torrent | null;
    remove(
      torrentId: string | Torrent,
      opts?: { destroyStore?: boolean },
      cb?: (err?: Error) => void
    ): void;
    destroy(cb?: (err?: Error) => void): void;
  }
}
