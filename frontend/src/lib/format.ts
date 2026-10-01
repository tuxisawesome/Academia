const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function compareNames(a: string, b: string): number {
  return collator.compare(a, b);
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`;
}

const dateFmt = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" });
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const fullFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "long", timeStyle: "short" });

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) return `Today, ${timeFmt.format(date)}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return `Yesterday, ${timeFmt.format(date)}`;
  return dateFmt.format(date);
}

/** The dates a page can be tagged with (the server's limits). */
export const FIRST_DAY = "1900-01-01";
export const LAST_DAY = "2200-12-31";

/**
 * Whether `value` is a date tags can have ("2026-03-05", FIRST_DAY to LAST_DAY). A date input
 * goes through years like 0002 and 0020 while a year is typed into it.
 */
export function isTagDay(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match || value < FIRST_DAY || value > LAST_DAY) return false;
  const [y, m, d] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

const shortDayFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

/** A calendar date as tags store it ("2026-03-05"), for display; `short` leaves out the year. */
export function formatDay(day: string, short = false): string {
  const [y, m, d] = day.split("-").map(Number);
  return (short ? shortDayFmt : dateFmt).format(new Date(y, m - 1, d));
}

export function formatDateLong(iso: string | null | undefined): string {
  if (!iso) return "—";
  return fullFmt.format(new Date(iso));
}

export function daysLeft(iso: string, retentionDays: number): number {
  const elapsed = (Date.now() - new Date(iso).getTime()) / 86_400_000;
  return Math.max(0, Math.ceil(retentionDays - elapsed));
}
