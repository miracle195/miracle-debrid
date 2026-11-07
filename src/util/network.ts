import os from 'node:os';

/**
 * Returns the primary non-internal IPv4 address on the local network (e.g. 192.168.x.x, 10.x.x.x).
 */
export function getLocalIp(): string {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

/**
 * Returns the local mDNS hostname (e.g. desktop-xxxx.local).
 */
export function getLocalHostname(): string {
  const raw = os.hostname().toLowerCase();
  return raw.endsWith('.local') ? raw : `${raw}.local`;
}
