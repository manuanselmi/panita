// The subscription's usage, as Claude Code hands it to its status line: the
// 5-hour window and the weekly one, each a percentage used and when it resets.
// Coucou's status line command is the relay (hooks.rs), and the app passes on
// only these numbers (pipe.rs, `usage` event). Nothing here asks anybody for
// them: no credential is involved.

export interface UsageWindow {
  /** Percent of the window used, 0–100. */
  usedPercentage: number;
  /** When the window resets, Unix seconds. */
  resetsAt: number;
}

export interface Usage {
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
}

function windowOf(value: unknown): UsageWindow | null {
  if (!value || typeof value !== "object") return null;
  const { usedPercentage, resetsAt } = value as Record<string, unknown>;
  if (typeof usedPercentage !== "number" || !Number.isFinite(usedPercentage)) return null;
  if (typeof resetsAt !== "number" || !Number.isFinite(resetsAt) || resetsAt <= 0) return null;
  return { usedPercentage: Math.min(100, Math.max(0, usedPercentage)), resetsAt };
}

/** The `usage` event's payload, or null when it carries no window at all. */
export function parseUsage(payload: unknown): Usage | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const usage = { fiveHour: windowOf(p.fiveHour), sevenDay: windowOf(p.sevenDay) };
  return usage.fiveHour || usage.sevenDay ? usage : null;
}

/** `w` while it has not reset yet; past its reset time it says nothing true any more. */
export function live(w: UsageWindow | null | undefined, nowMs: number): UsageWindow | null {
  return w && w.resetsAt * 1000 > nowMs ? w : null;
}

export type UsageLevel = "ok" | "warn" | "high";

/** How close to the limit: the bar turns amber at 80 %, red at 95 %. */
export function usageLevel(pct: number): UsageLevel {
  return pct >= 95 ? "high" : pct >= 80 ? "warn" : "ok";
}

/** "42%": whole percents; anything used but under one shows as 1%. */
export function percentLabel(pct: number): string {
  const rounded = Math.round(pct);
  return `${pct > 0 && rounded === 0 ? 1 : rounded}%`;
}

/**
 * Time left until `resetsAt` (Unix seconds), in whole minutes rounded up — the
 * way a countdown reads, so it never says "0m" while there is time left:
 * "2h 05m", "47m", "1m". Minutes are padded past the first hour so the text
 * keeps its width from one minute to the next. Null once the window has reset.
 */
export function resetIn(resetsAt: number, nowMs: number): string | null {
  const ms = resetsAt * 1000 - nowMs;
  if (ms <= 0) return null;
  const minutes = Math.ceil(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours}h ${String(minutes % 60).padStart(2, "0")}m` : `${minutes}m`;
}

/**
 * Milliseconds until resetIn's text changes: when the time left next reaches a
 * whole minute, plus a hair so the redraw lands on the new minute.
 */
export function untilNextMinute(resetsAt: number, nowMs: number): number {
  const ms = resetsAt * 1000 - nowMs;
  return ((((ms % 60_000) + 60_000) % 60_000) || 60_000) + 50;
}

/** Local time of day as "18:40". */
function clock(seconds: number): string {
  const d = new Date(seconds * 1000);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** The meter's tooltip: the 5-hour window, when it resets, and the week. */
export function usageTitle(usage: Usage | null, nowMs: number): string {
  const five = live(usage?.fiveHour, nowMs);
  const week = live(usage?.sevenDay, nowMs);
  const lines: string[] = [];
  if (five) lines.push(`5-hour limit: ${percentLabel(five.usedPercentage)} used · resets at ${clock(five.resetsAt)}`);
  if (week) lines.push(`Weekly limit: ${percentLabel(week.usedPercentage)} used`);
  return lines.join("\n");
}
