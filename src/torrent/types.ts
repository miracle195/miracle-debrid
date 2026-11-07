export interface TorrentFileInfo {
  index: number;
  name: string;
  path: string;
  length: number;
  isVideo: boolean;
}

export interface SessionStats {
  infoHash: string;
  name: string;
  totalLength: number;
  downloaded: number;
  progress: number;
  downloadSpeed: number;
  uploadSpeed: number;
  numPeers: number;
  timeRemaining: number;
  ready: boolean;
  done: boolean;
  readers: number;
  addedAt: number;
  lastAccessAt: number;
  selectedFileIndex: number | null;
  files: TorrentFileInfo[];
}

export class TorrentError extends Error {
  readonly status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.name = 'TorrentError';
    this.status = status;
  }
}
