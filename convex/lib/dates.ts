export function msToIsoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function isoDateToMs(iso: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(iso);
  if (!m) return Date.parse(iso);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

export const DAY_MS = 24 * 60 * 60 * 1000;
