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

export function formatDateLong(iso: string | null | undefined): string {
  if (!iso) return "—";
  return fullFmt.format(new Date(iso));
}

export function daysLeft(iso: string, retentionDays: number): number {
  const elapsed = (Date.now() - new Date(iso).getTime()) / 86_400_000;
  return Math.max(0, Math.ceil(retentionDays - elapsed));
}
