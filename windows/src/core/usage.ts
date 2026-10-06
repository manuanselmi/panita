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

// ── A session's context window ────────────────────────────────────────────────
//
// The same status line says, for the session that runs it, how full its context
// window is (pipe.rs, `context` event). The left card shows it for the session
// it is showing.

export interface SessionContext {
  /** Percent of the context window in use, 0–100. */
  usedPercentage: number;
  /** Tokens in the window now; null when Claude Code left it out. */
  tokens: number | null;
  /** The window's size in tokens; null when Claude Code left it out. */
  windowSize: number | null;
}

/** The `context` event's payload: whose window, and how full. Null when it says nothing usable. */
export function parseContext(payload: unknown): { sessionId: string; context: SessionContext } | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);
  if (typeof p.sessionId !== "string" || !p.sessionId.trim()) return null;
  if (typeof p.usedPercentage !== "number" || !Number.isFinite(p.usedPercentage)) return null;
  return {
    sessionId: p.sessionId.trim(),
    context: {
      usedPercentage: Math.min(100, Math.max(0, p.usedPercentage)),
      tokens: count(p.tokens),
      windowSize: count(p.windowSize),
    },
  };
}

/** A token count the way /context writes it: "950", "61.4k", "613k", "1M", "1.2M". */
export function tokenLabel(n: number): string {
  const short = (v: number) => String(v >= 100 ? Math.round(v) : Number(v.toFixed(1)));
  // From 999.5k up it would round to "1000k".
  if (n >= 999_500) return `${short(n / 1_000_000)}M`;
  if (n >= 1_000) return `${short(n / 1_000)}k`;
  return String(Math.round(n));
}

/** The context bar's tooltip: "Context: 613k of 1M tokens (61%)", or just the percentage. */
export function contextTitle(c: SessionContext): string {
  const pct = percentLabel(c.usedPercentage);
  if (c.tokens == null) return `Context: ${pct} used`;
  const of = c.windowSize ? ` of ${tokenLabel(c.windowSize)}` : "";
  return `Context: ${tokenLabel(c.tokens)}${of} tokens (${pct})`;
}
