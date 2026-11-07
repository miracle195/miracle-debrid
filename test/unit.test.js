import assert from 'node:assert/strict';
import test from 'node:test';

process.env.DATA_DIR = process.env.DATA_DIR ?? './.testdata';

const { parseRange, clampRange } = await import('../dist/util/range.js');
const { pickFile, parseEpisodeFromName, mimeFor } = await import('../dist/torrent/filepick.js');
const { normalizeMagnet, infoHashFromMagnet, parseStremioId } = await import('../dist/util/ids.js');
const { parseTorznab } = await import('../dist/catalog/providers/torznab.js');
const { parseBytes } = await import('../dist/config.js');

const SIZE = 1000;

test('range: absent header', () => {
  assert.equal(parseRange(undefined, SIZE).kind, 'none');
});

test('range: bytes=0-', () => {
  const r = parseRange('bytes=0-', SIZE);
  assert.equal(r.kind, 'ok');
  assert.deepEqual(r.range, { start: 0, end: 999 });
});

test('range: closed range', () => {
  const r = parseRange('bytes=100-199', SIZE);
  assert.deepEqual(r.range, { start: 100, end: 199 });
});

test('range: end past EOF is clamped', () => {
  const r = parseRange('bytes=900-5000', SIZE);
  assert.deepEqual(r.range, { start: 900, end: 999 });
});

test('range: suffix form', () => {
  const r = parseRange('bytes=-300', SIZE);
  assert.deepEqual(r.range, { start: 700, end: 999 });
});

test('range: suffix bigger than file starts at 0', () => {
  const r = parseRange('bytes=-99999', SIZE);
  assert.deepEqual(r.range, { start: 0, end: 999 });
});

test('range: start past EOF is unsatisfiable', () => {
  assert.equal(parseRange('bytes=1000-', SIZE).kind, 'unsatisfiable');
});

test('range: end before start is unsatisfiable', () => {
  assert.equal(parseRange('bytes=500-100', SIZE).kind, 'unsatisfiable');
});

test('range: garbage is unsatisfiable', () => {
  assert.equal(parseRange('items=1-2', SIZE).kind, 'unsatisfiable');
  assert.equal(parseRange('bytes=abc', SIZE).kind, 'unsatisfiable');
});

test('range: multi-range serves the first range', () => {
  const r = parseRange('bytes=0-99,200-299', SIZE);
  assert.deepEqual(r.range, { start: 0, end: 99 });
});

test('clampRange caps open-ended requests', () => {
  assert.deepEqual(clampRange({ start: 0, end: 999 }, SIZE, 100), { start: 0, end: 99 });
  assert.deepEqual(clampRange({ start: 0, end: 50 }, SIZE, 100), { start: 0, end: 50 });
  assert.deepEqual(clampRange({ start: 0, end: 999 }, SIZE, 0), { start: 0, end: 999 });
});

// ---------------------------------------------------------------- file picking

const file = (path, length) => ({ index: 0, name: path.split('/').pop(), path, length });
const withIndexes = (files) => files.map((f, index) => ({ ...f, index }));

test('picks the largest video for a movie', () => {
  const files = withIndexes([
    file('Movie/movie.mkv', 8_000_000_000),
    file('Movie/sample.mkv', 40_000_000),
    file('Movie/readme.txt', 900),
    file('Movie/poster.jpg', 120_000),
  ]);
  assert.equal(pickFile(files, null).name, 'movie.mkv');
});

test('ignores sample files even when reasonably sized', () => {
  const files = withIndexes([
    file('X/X-sample.mkv', 900_000_000),
    file('X/X.mkv', 4_000_000_000),
  ]);
  assert.equal(pickFile(files, null).name, 'X.mkv');
});

test('returns null when there is no video', () => {
  const files = withIndexes([file('a/notes.txt', 100), file('a/cover.png', 5000)]);
  assert.equal(pickFile(files, null), null);
});

test('matches SxxExx in a season pack', () => {
  const files = withIndexes([
    file('Show S01/Show.S01E01.1080p.mkv', 2_000_000_000),
    file('Show S01/Show.S01E02.1080p.mkv', 2_100_000_000),
    file('Show S01/Show.S01E03.1080p.mkv', 2_050_000_000),
  ]);
  assert.equal(pickFile(files, { season: 1, episode: 2 }).name, 'Show.S01E02.1080p.mkv');
});

test('matches 1x02 style naming', () => {
  const files = withIndexes([
    file('Show/Show 1x01.mp4', 700_000_000),
    file('Show/Show 1x02.mp4', 710_000_000),
  ]);
  assert.equal(pickFile(files, { season: 1, episode: 2 }).name, 'Show 1x02.mp4');
});

test('season lives in the folder name only', () => {
  const files = withIndexes([
    file('Show/Season 2/E01.mkv', 900_000_000),
    file('Show/Season 2/E02.mkv', 910_000_000),
  ]);
  assert.equal(pickFile(files, { season: 2, episode: 2 }).name, 'E02.mkv');
});

test('single-file torrent is used for any requested episode', () => {
  const files = withIndexes([file('random.name.mkv', 900_000_000)]);
  assert.equal(pickFile(files, { season: 3, episode: 7 }).name, 'random.name.mkv');
});

test('resolution and year do not masquerade as episode numbers', () => {
  assert.equal(parseEpisodeFromName('Movie.2019.1080p.BluRay.mkv'), null);
});

test('episode parser reads common forms', () => {
  assert.deepEqual(parseEpisodeFromName('Show.S03E11.mkv'), { season: 3, episode: 11 });
  assert.deepEqual(parseEpisodeFromName('Show 12x04.mkv'), { season: 12, episode: 4 });
  assert.deepEqual(
    parseEpisodeFromName('Show Season 2 Episode 8.mkv'),
    { season: 2, episode: 8 }
  );
});

test('mime types', () => {
  assert.equal(mimeFor('a.mkv'), 'video/x-matroska');
  assert.equal(mimeFor('a.MP4'), 'video/mp4');
  assert.equal(mimeFor('a.bin'), 'application/octet-stream');
});

// -------------------------------------------------------------------- magnets

const HASH = '08ada5a7a6183aae1e09d831df6748d566095a10';

test('bare infohash becomes a magnet with trackers', () => {
  const magnet = normalizeMagnet(HASH);
  assert.ok(magnet.startsWith('magnet:?'));
  assert.equal(infoHashFromMagnet(magnet), HASH);
  assert.ok(magnet.includes('tr=udp://'));
});

test('existing trackers survive normalization', () => {
  const input = `magnet:?xt=urn:btih:${HASH}&dn=Test&tr=udp://example.org:1337/announce`;
  const magnet = normalizeMagnet(input);
  assert.ok(magnet.includes('udp://example.org:1337/announce'));
  assert.ok(magnet.includes('dn=Test'));
});

test('uppercase infohash is normalized to lowercase', () => {
  assert.equal(infoHashFromMagnet(normalizeMagnet(HASH.toUpperCase())), HASH);
});

test('rubbish input throws', () => {
  assert.throws(() => normalizeMagnet('http://example.com/file.torrent'));
  assert.throws(() => normalizeMagnet('magnet:?xt=urn:btih:nothex'));
});

test('stremio id parsing', () => {
  assert.deepEqual(parseStremioId('tt0111161'), { imdbId: 'tt0111161' });
  assert.deepEqual(parseStremioId('tt0944947:2:9'), {
    imdbId: 'tt0944947',
    season: 2,
    episode: 9,
  });
  assert.equal(parseStremioId('notanid'), null);
  assert.equal(parseStremioId('tt0944947:2'), null);
});

// -------------------------------------------------------------------- torznab

test('torznab parser reads magneturl, size and seeders', () => {
  const xml = `<?xml version="1.0"?><rss><channel>
    <item>
      <title>Example Release 1080p</title>
      <size>1234567890</size>
      <torznab:attr name="magneturl" value="magnet:?xt=urn:btih:${HASH}" />
      <torznab:attr name="seeders" value="42" />
    </item>
    <item>
      <title>Other Release 720p</title>
      <torznab:attr value="${HASH}" name="infohash" />
    </item>
  </channel></rss>`;
  const results = parseTorznab(xml, 'test');
  assert.equal(results.length, 2);
  assert.equal(results[0].title, 'Example Release 1080p');
  assert.equal(results[0].size, 1234567890);
  assert.equal(results[0].seeders, 42);
  assert.equal(results[0].quality, '1080p');
  assert.equal(results[1].quality, '720p');
  assert.ok(results[1].magnet.includes(HASH));
});

test('torznab parser handles CDATA titles and magnet links', () => {
  const xml = `<rss><channel><item>
    <title><![CDATA[Some &amp; Release 2160p]]></title>
    <link>magnet:?xt=urn:btih:${HASH}&amp;dn=x</link>
  </item></channel></rss>`;
  const [r] = parseTorznab(xml, 'test');
  assert.equal(r.title, 'Some & Release 2160p');
  assert.equal(r.quality, '2160p');
  assert.ok(r.magnet.includes('&dn=x'));
});

// --------------------------------------------------------------------- config

test('parseBytes understands human sizes', () => {
  assert.equal(parseBytes('1024'), 1024);
  assert.equal(parseBytes('4MB'), 4 * 1024 ** 2);
  assert.equal(parseBytes('1.5gb'), Math.floor(1.5 * 1024 ** 3));
  assert.equal(parseBytes('2 TiB'), 2 * 1024 ** 4);
  assert.throws(() => parseBytes('lots'));
});
