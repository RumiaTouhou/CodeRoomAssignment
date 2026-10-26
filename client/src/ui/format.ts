import type { UnixMs } from "../contract.js";

const timeFormatter = new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const dateTimeFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const dayMs = 24 * 60 * 60 * 1000;

/** "14:05" — compact 24h time for message metadata. */
export const formatTime = (at: UnixMs): string => timeFormatter.format(new Date(at));

export const formatDateTime = (at: UnixMs): string => dateTimeFormatter.format(new Date(at));

/** Uses compact time for recent messages, relative days for the first week, and a full date thereafter. */
export const formatMessageTime = (at: UnixMs, now: UnixMs = Date.now()): string => {
  const age = now - at;
  if (age < dayMs) return formatTime(at);
  const days = Math.floor(age / dayMs);
  if (days < 7) return `${days} ${days === 1 ? "day" : "days"} ago`;
  return formatDateTime(at);
};

/** "1.2 KB" — for byte counters near the composer limit. */
export const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
};

/** Deterministic 0..1 value from a seed string (avatar hue input). */
export const seedHash = (seed: string): number => {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return (hash % 360) / 360;
};

/** Up to two initials from a display name. */
export const initialsOf = (displayName: string): string => {
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? "?";
  const second = parts.length > 1 ? parts[parts.length - 1]?.[0] : undefined;
  return (first + (second ?? "")).toUpperCase();
};
