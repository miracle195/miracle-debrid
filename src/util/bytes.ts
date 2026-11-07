const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

export function humanBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '?';
  let value = n;
  let i = 0;
  while (value >= 1024 && i < UNITS.length - 1) {
    value /= 1024;
    i++;
  }
  const digits = value >= 100 || i === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${UNITS[i]}`;
}

export function humanSpeed(bytesPerSec: number): string {
  return `${humanBytes(bytesPerSec)}/s`;
}

export function humanDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}
