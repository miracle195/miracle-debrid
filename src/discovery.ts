import dgram from 'node:dgram';
import { config } from './config.js';
import { createLogger } from './logger.js';
import { tokenPrefix } from './http/middleware/auth.js';

const log = createLogger('discovery');
const DISCOVERY_PORT = 11471;

/**
 * Starts a UDP listener on port 11471 to allow local network clients,
 * Nuvio scrapers, and Stremio companion tools to discover the server
 * dynamically even when the local IP address changes via DHCP.
 */
export function startDiscoveryService(): { stop: () => void } {
  let socket: dgram.Socket | null = null;
  try {
    socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    socket.on('error', (err) => {
      log.debug(`UDP discovery notice: ${err.message}`);
    });

    socket.on('message', (msg, rinfo) => {
      const text = msg.toString().trim().toLowerCase();
      if (text.includes('miracle') || text.includes('debrid') || text.includes('discover')) {
        const payload = JSON.stringify({
          service: 'miracle-debrid',
          version: config.addon.version,
          ip: config.localIp,
          hostname: config.localHostname,
          port: config.port,
          manifestUrl: `http://${config.localIp}:${config.port}${tokenPrefix()}/manifest.json`,
          localManifestUrl: `http://${config.localHostname}:${config.port}${tokenPrefix()}/manifest.json`,
        });

        socket?.send(payload, rinfo.port, rinfo.address, (err) => {
          if (!err) {
            log.info(`Responded to discovery ping from ${rinfo.address}:${rinfo.port}`);
          }
        });
      }
    });

    socket.bind(DISCOVERY_PORT, () => {
      try {
        socket?.setBroadcast(true);
        log.info(`Local network discovery service active on UDP port ${DISCOVERY_PORT}`);
      } catch {
        // Broadcast not critical if unicast works
      }
    });
  } catch (err) {
    log.debug(`Discovery service startup note: ${(err as Error).message}`);
  }

  return {
    stop: () => {
      try {
        socket?.close();
      } catch {}
    },
  };
}
