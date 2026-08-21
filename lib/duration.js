/**
 * Human duration parsing/rendering helpers for dsh-plugin-loop.
 * Kept dependency-free so tests can import it without the harness packages.
 * @module dsh-plugin-loop/duration
 */

const UNIT_MS = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** One `<number><unit>` duration token. */
const DURATION_TOKEN = /(\d+(?:\.\d+)?)(ms|s|m|h|d)/gi;

/**
 * Parse a whitespace-free duration like `30m`, `1h30m`, or `2d` into
 * milliseconds. Returns `undefined` when the input is not a valid duration.
 * @param input - one duration token (no surrounding whitespace).
 * @returns whole milliseconds, or `undefined` when invalid.
 */
export function parseDurationMs(input) {
  if (typeof input !== "string") return undefined;
  const text = input.trim();
  if (text.length === 0) return undefined;
  let total = 0;
  let cursor = 0;
  let matched = false;
  for (const match of text.matchAll(DURATION_TOKEN)) {
    if (match.index !== cursor) return undefined;
    matched = true;
    cursor += match[0].length;
    total += Number(match[1]) * UNIT_MS[match[2].toLowerCase()];
  }
  if (!matched || cursor !== text.length) return undefined;
  if (!Number.isFinite(total) || total <= 0) return undefined;
  return Math.round(total);
}

/**
 * Render milliseconds as a compact human duration (`45s`, `30m`, `1h30m`, `2d`).
 * @param ms - non-negative milliseconds.
 * @returns the compact label.
 */
export function humanizeDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "?";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = Math.round(ms / 1000);
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const secs = seconds % 60;
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (secs || parts.length === 0) parts.push(`${secs}s`);
  return parts.join("");
}
