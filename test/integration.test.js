/**
 * End-to-end test of the real path: seed a file into a local swarm, add the
 * magnet through the API, then pull bytes back out over HTTP and check them
 * against the original. No internet required — a tracker runs on loopback.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Server as TrackerServer } from 'bittorrent-tracker';
import WebTorrent from 'webtorrent';

const TRACKER_PORT = 16969;
const SERVER_PORT = 11490;
const TOKEN = 'integration-token';
const BASE = `http://127.0.0.1:${SERVER_PORT}`;
const TRACKER = `http://127.0.0.1:${TRACKER_PORT}/announce`;
const FILE_SIZE = 8 * 1024 * 1024;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'miracle-it-'));
// Seed a directory so the torrent has two files and the picker has to choose.
const seedDir = path.join(tmp, 'seed', 'Test.Show.S01E02');
const serverData = path.join(tmp, 'server');
fs.mkdirSync(seedDir, { recursive: true });
fs.mkdirSync(serverData, { recursive: true });

// Deterministic pseudo-random payload, named so the picker treats it as video.
const payload = crypto.createHash('sha256').update('miracle').digest();
const content = Buffer.concat(
  Array.from({ length: Math.ceil(FILE_SIZE / payload.length) }, (_, i) =>
    crypto.createHash('sha256').update(payload).update(String(i)).digest()
  )
).subarray(0, FILE_SIZE);

const videoName = 'Test.Show.S01E02.1080p.mkv';
fs.writeFileSync(path.join(seedDir, videoName), content);
// A decoy the picker must ignore.
fs.writeFileSync(path.join(seedDir, 'Test.Show.S01E02-sample.mkv'), content.subarray(0, 65536));

let tracker;
let seeder;
let server;
let magnet;

async function waitForHealth(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server did not become healthy');
}

test.before(async () => {
  tracker = new TrackerServer({ udp: false, ws: false, stats: false, http: true });
  tracker.on('error', () => {});
  tracker.on('warning', () => {});
  await new Promise((resolve) => tracker.listen(TRACKER_PORT, '127.0.0.1', resolve));

  seeder = new WebTorrent({ dht: false, lsd: false, natUpnp: false, natPmp: false });
  seeder.on('error', () => {});
  magnet = await new Promise((resolve, reject) => {
    const t = seeder.seed(seedDir, { announce: [TRACKER] }, (torrent) =>
      resolve(torrent.magnetURI)
    );
    t.on('error', reject);
    setTimeout(() => reject(new Error('seeding timed out')), 30_000);
  });

  const { spawn } = await import('node:child_process');
  server = spawn('node', ['dist/index.js'], {
    env: {
      ...process.env,
      DATA_DIR: serverData,
      DOWNLOAD_DIR: path.join(serverData, 'downloads'),
      PORT: String(SERVER_PORT),
      HOST: '127.0.0.1',
      PUBLIC_URL: BASE,
      ACCESS_TOKEN: TOKEN,
      TRACKERS: TRACKER,
      DHT: 'false',
      LOG_LEVEL: 'warn',
      PREBUFFER_BYTES: '1MB',
      METADATA_TIMEOUT_MS: '30000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', () => {});
  server.stderr.on('data', () => {});

  await waitForHealth();
});

test.after(async () => {
  server?.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 200));
  await new Promise((r) => seeder?.destroy(r));
  await new Promise((r) => tracker?.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
});

const api = (p, init) =>
  fetch(`${BASE}${p}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`, ...(init?.headers ?? {}) },
  });

let playPath;

test('adds a magnet, fetches metadata, and picks the right file', async () => {
  const res = await api('/api/torrents', {
    method: 'POST',
    body: JSON.stringify({ magnet, season: 1, episode: 2 }),
  });
  const raw = await res.text();
  assert.equal(res.status, 201, `unexpected status ${res.status}: ${raw}`);
  const body = JSON.parse(raw);

  assert.equal(body.files.length, 2);
  assert.equal(body.picked.name, videoName, 'must skip the sample file');
  assert.ok(body.playUrl);
  playPath = new URL(body.playUrl).pathname;
});

test('HEAD reports the full length and advertises range support', async () => {
  const res = await fetch(`${BASE}${playPath}`, {
    method: 'HEAD',
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-length'), String(FILE_SIZE));
  assert.equal(res.headers.get('accept-ranges'), 'bytes');
  assert.equal(res.headers.get('content-type'), 'video/x-matroska');
});

test('serves a byte-exact range from the head of the file', async () => {
  const res = await fetch(`${BASE}${playPath}`, {
    headers: { Authorization: `Bearer ${TOKEN}`, Range: 'bytes=0-65535' },
  });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), `bytes 0-65535/${FILE_SIZE}`);
  assert.equal(res.headers.get('content-length'), '65536');

  const got = Buffer.from(await res.arrayBuffer());
  assert.equal(got.length, 65536);
  assert.ok(got.equals(content.subarray(0, 65536)), 'bytes must match the source file');
});

test('serves a byte-exact range from the middle (seek)', async () => {
  const start = 3_000_000;
  const end = 3_499_999;
  const res = await fetch(`${BASE}${playPath}`, {
    headers: { Authorization: `Bearer ${TOKEN}`, Range: `bytes=${start}-${end}` },
  });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), `bytes ${start}-${end}/${FILE_SIZE}`);

  const got = Buffer.from(await res.arrayBuffer());
  assert.equal(got.length, end - start + 1);
  assert.ok(got.equals(content.subarray(start, end + 1)));
});

test('serves the tail via a suffix range', async () => {
  const res = await fetch(`${BASE}${playPath}`, {
    headers: { Authorization: `Bearer ${TOKEN}`, Range: 'bytes=-4096' },
  });
  assert.equal(res.status, 206);
  const got = Buffer.from(await res.arrayBuffer());
  assert.ok(got.equals(content.subarray(FILE_SIZE - 4096)));
});

test('an open-ended range returns the whole file, intact', async () => {
  const res = await fetch(`${BASE}${playPath}`, {
    headers: { Authorization: `Bearer ${TOKEN}`, Range: 'bytes=0-' },
  });
  assert.equal(res.status, 206);
  const got = Buffer.from(await res.arrayBuffer());
  assert.equal(got.length, FILE_SIZE);
  assert.equal(
    crypto.createHash('sha256').update(got).digest('hex'),
    crypto.createHash('sha256').update(content).digest('hex'),
    'whole-file checksum must match'
  );
});

test('a request with no Range header returns 200 and the whole file', async () => {
  const res = await fetch(`${BASE}${playPath}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(res.status, 200);
  const got = Buffer.from(await res.arrayBuffer());
  assert.equal(got.length, FILE_SIZE);
});

test('an out-of-bounds range is rejected with 416', async () => {
  const res = await fetch(`${BASE}${playPath}`, {
    headers: { Authorization: `Bearer ${TOKEN}`, Range: `bytes=${FILE_SIZE + 10}-` },
  });
  assert.equal(res.status, 416);
  assert.equal(res.headers.get('content-range'), `bytes */${FILE_SIZE}`);
});

test('concurrent seeks all return correct bytes', async () => {
  const ranges = [
    [0, 32767],
    [1_000_000, 1_032_767],
    [5_000_000, 5_032_767],
    [FILE_SIZE - 32768, FILE_SIZE - 1],
  ];
  const results = await Promise.all(
    ranges.map(async ([s, e]) => {
      const res = await fetch(`${BASE}${playPath}`, {
        headers: { Authorization: `Bearer ${TOKEN}`, Range: `bytes=${s}-${e}` },
      });
      assert.equal(res.status, 206);
      return Buffer.from(await res.arrayBuffer());
    })
  );
  results.forEach((got, i) => {
    const [s, e] = ranges[i];
    assert.ok(got.equals(content.subarray(s, e + 1)), `range ${s}-${e} mismatched`);
  });
});

test('the resolve endpoint redirects to the episode file', async () => {
  const infoHash = /urn:btih:([a-f0-9]{40})/i.exec(magnet)[1].toLowerCase();
  const res = await fetch(`${BASE}/${TOKEN}/resolve/${infoHash}/auto?s=1&e=2`, {
    redirect: 'manual',
  });
  assert.equal(res.status, 302);
  assert.ok(decodeURIComponent(res.headers.get('location')).endsWith(videoName));
});

test('status reflects the live torrent', async () => {
  const body = await (await api('/api/status')).json();
  assert.equal(body.torrents.length, 1);
  assert.equal(body.torrents[0].files.length, 2);
  assert.ok(body.cache.bytes > 0, 'cache should report downloaded bytes');
});

test('dropping the torrent deletes its files', async () => {
  const infoHash = /urn:btih:([a-f0-9]{40})/i.exec(magnet)[1].toLowerCase();
  const res = await api(`/api/torrents/${infoHash}?deleteFiles=true`, { method: 'DELETE' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.removed, true);

  const cache = await (await api('/api/cache')).json();
  assert.equal(cache.entries.length, 0);
});
