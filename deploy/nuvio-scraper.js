/**
 * Miracle Debrid Local Network Scraper for Nuvio
 *
 * This scraper automatically searches the local network for the running Miracle Debrid
 * server if the IP changes due to DHCP.
 */

let cachedServerUrl = null;
const DEFAULT_PORT = 11470;
const KNOWN_HOSTNAMES = ['miracle-debrid.local', 'desktop-2povfrl.local', 'localhost', '127.0.0.1'];

async function testServer(url) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1200);
    const res = await fetch(`${url}/health`, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return false;
    const data = await res.json();
    return data && (data.service === 'miracle-debrid' || data.ok === true);
  } catch {
    return false;
  }
}

async function discoverServer() {
  if (cachedServerUrl && (await testServer(cachedServerUrl))) {
    return cachedServerUrl;
  }

  // 1. Try local mDNS hostnames
  for (const host of KNOWN_HOSTNAMES) {
    const testUrl = `http://${host}:${DEFAULT_PORT}`;
    if (await testServer(testUrl)) {
      cachedServerUrl = testUrl;
      return testUrl;
    }
  }

  // 2. Scan common private subnets (e.g. 192.168.100.x, 192.168.1.x, 192.168.0.x)
  const subnets = ['192.168.100', '192.168.1', '192.168.0', '10.0.0'];
  for (const subnet of subnets) {
    const candidates = [];
    for (let i = 2; i <= 254; i++) {
      candidates.push(`http://${subnet}.${i}:${DEFAULT_PORT}`);
    }

    // Probe in small batches
    const batchSize = 25;
    for (let i = 0; i < candidates.length; i += batchSize) {
      const batch = candidates.slice(i, i + batchSize);
      const results = await Promise.all(
        batch.map(async (url) => {
          const isAlive = await testServer(url);
          return isAlive ? url : null;
        })
      );
      const found = results.find(Boolean);
      if (found) {
        cachedServerUrl = found;
        return found;
      }
    }
  }

  return null;
}

async function getStreams(tmdbId, mediaType, season, episode) {
  try {
    const serverUrl = await discoverServer();
    if (!serverUrl) {
      console.log('[Miracle Debrid] No server found on local network');
      return [];
    }

    // Convert TMDB id to IMDB if needed, or query server directly
    const type = mediaType === 'tv' || mediaType === 'series' ? 'series' : 'movie';
    const id = season && episode ? `${tmdbId}:${season}:${episode}` : tmdbId;

    const res = await fetch(`${serverUrl}/stream/${type}/${id}.json`);
    if (!res.ok) return [];

    const data = await res.json();
    return (data.streams || []).map((stream) => ({
      name: stream.name || 'Miracle Debrid',
      title: stream.title || 'Direct HTTP Stream',
      url: stream.url,
      quality: stream.name?.includes('4K') ? '4K' : stream.name?.includes('1080') ? '1080p' : 'Auto',
    }));
  } catch (err) {
    console.log('[Miracle Debrid] Error fetching streams:', err.message);
    return [];
  }
}

module.exports = { getStreams };
