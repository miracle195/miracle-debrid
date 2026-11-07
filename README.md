# Miracle Debrid

A self-hosted debrid service. It takes a magnet, downloads it on your Linux
box, and serves the video back as a plain HTTP stream with proper `Range`
support — which is exactly what Stremio (and VLC, mpv, Infuse, or a browser)
needs to play and seek it.

Your player never touches BitTorrent. It sees an ordinary HTTP video URL.

```
Stremio  ──HTTP──▶  Miracle Debrid  ──BitTorrent──▶  swarm
         ◀─206────  (range requests)
```

## What it actually does

- **Streams while downloading.** Pieces are fetched in the order the player
  asks for them, so playback starts before the file is complete.
- **Downloads one file, not the whole pack.** Ask for S01E04 of a 60 GB season
  pack and it deselects everything else.
- **Picks the right episode.** Handles `S01E04`, `1x04`, `Season 1 Episode 4`,
  season-in-the-folder-name, and absolute numbering. Skips `sample` files.
- **Correct HTTP semantics.** 206 partial content, `Content-Range`, suffix
  ranges (`bytes=-4096`), 416 on out-of-bounds, HEAD, and abort handling for
  the constant seeking players do.
- **Bounded disk use.** LRU cache with a size cap; never evicts something
  currently being watched.
- **Token auth.** The token sits in the URL path, because Stremio cannot send
  headers.

## Requirements

Node.js 20+ on a Linux machine. That's it.

> **Important:** webtorrent **v3** is required. v2.8.x is broken against
> current `parse-torrent` releases (it expects `infoHash` as a `Uint8Array`
> while parse-torrent now returns a string, so every `add()` throws). The
> pinned version in `package.json` is correct — don't downgrade it.

## Install

### Option A — systemd (recommended for a dedicated box)

```bash
git clone <your-repo> miracle-debrid   # or copy the folder across
cd miracle-debrid
sudo bash deploy/install.sh
```

That installs Node if needed, creates a `miracle` service user, builds to
`/opt/miracle-debrid`, writes config to `/etc/miracle-debrid.env` with a
generated token, and starts the service.

```bash
journalctl -u miracle-debrid -f     # logs (the token is printed at startup)
sudo systemctl restart miracle-debrid
```

### Option B — Docker

```bash
cp .env.example .env      # edit PUBLIC_URL at minimum
docker compose up -d
docker compose logs -f
```

### Option C — run it by hand

```bash
npm install
npm run build
cp .env.example .env      # edit PUBLIC_URL
node --env-file=.env dist/index.js
```

## Point Stremio at it

1. Open `http://<server-ip>:11470/` in a browser — that's the dashboard.
2. Paste the access token (printed in the logs, also in `data/access-token`).
3. Copy the manifest URL it shows you:

   ```
   http://<server-ip>:11470/<token>/manifest.json
   ```

4. In Stremio: **Addons → paste the URL in the search box → Install.**

The dashboard's "Open in Stremio" button does the same thing via a
`stremio://` link.

**`PUBLIC_URL` must be the address your player can reach.** It gets baked into
the stream URLs handed to Stremio. If it says `127.0.0.1` and you're watching
on a different device, playback will fail while the manifest loads fine — that
is far and away the most common setup mistake.

## Where the magnets come from

This ships with **no indexers and no scrapers**. Out of the box the addon
returns an empty stream list. You supply sources one of two ways:

### 1. Your own library file — `data/sources.json`

```json
{
  "tt0031381": [
    {
      "title": "Some Public Domain Film 1080p",
      "magnet": "magnet:?xt=urn:btih:…",
      "size": 4294967296,
      "seeders": 12
    }
  ],
  "tt1234567:1:3": [
    { "title": "Show S01E03 720p", "magnet": "magnet:?xt=urn:btih:…" }
  ]
}
```

Keys are Stremio ids: `ttNNNNNNN` for a film, `ttNNNNNNN:season:episode` for an
episode, `ttNNNNNNN:season` for a season pack. The file is re-read whenever it
changes — no restart needed.

### 2. Your own Torznab endpoint (Jackett / Prowlarr)

If you already run one, point the service at it:

```bash
TORZNAB_URL=http://127.0.0.1:9117/api/v2.0/indexers/all/results/torznab
TORZNAB_API_KEY=your-key
```

The provider stays dormant unless both are set. Which indexers that endpoint
aggregates is your configuration — this project ships none.

### 3. Skip the addon entirely

The dashboard has a "Play a magnet" box: paste a magnet, get an HTTP URL back,
open it in VLC/mpv. No Stremio required.

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:11470/api/resolve?magnet=magnet:?xt=urn:btih:..."
```

## Configuration

Every setting is an environment variable; see `.env.example` for the annotated
list. The ones that matter most:

| Variable | Default | Notes |
|---|---|---|
| `PUBLIC_URL` | `http://127.0.0.1:11470` | **Must be reachable from the player.** |
| `ACCESS_TOKEN` | auto-generated | Persisted to `data/access-token`. |
| `PORT` | `11470` | HTTP port. |
| `TORRENT_PORT` | `0` (random) | Set a fixed port so you can forward it. |
| `DOWNLOAD_DIR` | `./data/downloads` | Put this on your big disk. |
| `CACHE_MAX_BYTES` | `100GB` | LRU eviction above this. |
| `PREBUFFER_BYTES` | `4MB` | Raise it if playback stutters on start. |
| `IDLE_TIMEOUT_MS` | `900000` | Drop the swarm 15 min after last reader. |
| `UPLOAD_LIMIT` | `131072` | Bytes/sec. `-1` for unlimited. |

### Ports to open

```bash
sudo ufw allow 11470/tcp        # HTTP (skip if only used via nginx/LAN)
sudo ufw allow 51413/tcp        # peers   — set TORRENT_PORT=51413
sudo ufw allow 51413/udp        # DHT
```

Peers reach you far better with that port forwarded on the router. Without it
you're limited to outbound connections and speeds suffer.

## HTTPS

The Stremio **desktop and Android apps** are happy with plain `http://` on a
LAN address — no TLS needed for a home setup.

The Stremio **web player** (`app.strem.io`) refuses non-HTTPS addons on a
non-localhost host. If you want that, or you're exposing this to the internet,
put nginx in front: `deploy/nginx.conf` has a working config with the
range/buffering/timeout settings that streaming needs. Then:

```bash
sudo certbot --nginx -d debrid.example.com
# and set PUBLIC_URL=https://debrid.example.com
```

## API

All routes accept the token as `/<token>/…`, `?token=…`, or
`Authorization: Bearer …`. `/health` is open.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/manifest.json` | Stremio addon manifest |
| `GET` | `/stream/:type/:id.json` | Stremio stream list |
| `GET` | `/resolve/:infoHash/auto?s=&e=` | Picks the file, 302s to `/play` |
| `GET`/`HEAD` | `/play/:infoHash/:fileIndex/:name` | The actual video stream |
| `POST` | `/api/torrents` | `{magnet, season?, episode?}` → play URL |
| `GET` | `/api/torrents` | Live torrents + stats |
| `DELETE` | `/api/torrents/:hash?deleteFiles=true` | Drop / delete |
| `GET` | `/api/cache` | Cache contents |
| `POST` | `/api/cache/sweep` | Force LRU eviction |
| `GET` | `/api/status` | Everything the dashboard shows |
| `GET` | `/health` | Liveness (no auth) |

## Writing a source provider

Implement the interface and register it in `src/catalog/index.ts`:

```ts
import type { SourceProvider, SourceQuery, SourceResult } from './sources.js';

export class MyProvider implements SourceProvider {
  readonly name = 'mine';
  isEnabled() { return Boolean(process.env.MY_API_KEY); }
  async search(q: SourceQuery): Promise<SourceResult[]> {
    // q.id.imdbId, q.id.season, q.id.episode, q.meta?.name, q.meta?.year
    return [{ magnet: 'magnet:?xt=urn:btih:…', title: '…', provider: this.name }];
  }
}
```

Failures are swallowed per-provider, so a broken one can't sink a lookup.

## Tests

```bash
npm test              # 29 unit tests — range parsing, file picking, parsers
npm run test:integration   # 12 end-to-end tests
npm run test:all
```

The integration suite is the interesting one: it starts a BitTorrent tracker
and a seeder on loopback, adds the magnet through the real API, and verifies
the streamed bytes match the source file exactly — head ranges, mid-file
seeks, suffix ranges, whole-file checksum, concurrent seeks, and 416s. No
internet needed.

## Troubleshooting

**Manifest installs but nothing plays.** `PUBLIC_URL` is wrong — it's pointing
somewhere your player can't reach. Check what URL the dashboard shows.

**"No metadata after 45000ms".** Nobody in the swarm answered. Dead torrent, or
your peer port is blocked. Try a magnet you know is healthy.

**Playback starts then stalls.** Slow swarm. Raise `PREBUFFER_BYTES` to
`16MB` so more is buffered before the response opens.

**Stream list is always empty.** Expected until you configure a source — see
"Where the magnets come from" above. `GET /api/status` lists active providers.

**Disk filling up.** Lower `CACHE_MAX_BYTES`, or `POST /api/cache/sweep`.

## Legal

This is plumbing. It downloads whatever infohash you hand it and serves the
bytes over HTTP — it has no catalogue, no index, and no opinion about content.
Downloading and sharing copyrighted material without permission is illegal in
most places, and BitTorrent uploads as it downloads, so you are distributing
too. Point it at things you have the right to: public-domain films, Creative
Commons releases, Linux distributions, your own media. That's on you.
