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
