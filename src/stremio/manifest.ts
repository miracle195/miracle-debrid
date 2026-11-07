import { config } from '../config.js';

export interface StremioManifest {
  id: string;
  version: string;
  name: string;
  description: string;
  logo?: string;
  resources: Array<string | { name: string; types: string[]; idPrefixes?: string[] }>;
  types: string[];
  catalogs: unknown[];
  idPrefixes: string[];
  behaviorHints?: Record<string, unknown>;
}

export function buildManifest(): StremioManifest {
  return {
    id: config.addon.id,
    version: config.addon.version,
    name: config.addon.name,
    description: config.addon.description,
    resources: [
      {
        name: 'stream',
        types: ['movie', 'series'],
        idPrefixes: ['tt'],
      },
    ],
    types: ['movie', 'series'],
    catalogs: [],
    idPrefixes: ['tt'],
    behaviorHints: {
      configurable: true,
      configurationRequired: true,
      p2p: false,
    },
  };
}

export interface StremioStream {
  name: string;
  title?: string;
  description?: string;
  url: string;
  behaviorHints?: {
    bingeGroup?: string;
    notWebReady?: boolean;
    videoSize?: number;
    filename?: string;
  };
}

export interface StreamResponse {
  streams: StremioStream[];
  /** Seconds Stremio may cache this response. */
  cacheMaxAge?: number;
  staleRevalidate?: number;
}
