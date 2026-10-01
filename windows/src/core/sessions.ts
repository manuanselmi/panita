// Claude Code sessions: the rules that do not need the app around them — the
// timings, the colour palette and the order. AppState (state.ts) owns the list
// itself and the two timers that apply these rules.
//
// Each Claude Code session is its own task, keyed by the hook payload's
// `session_id`. There used to be a single `integration_claude` task that every
// event overwrote, so two sessions mixed their steps in one ticker, the name
// flipped to whichever spoke last, and "Open" went there too.

/**
 * Minimum time between two changes of the session order.
 *
 * The order is "most recent activity first". Two sessions working at once both
 * fire hook events every second or so; applied literally, they would swap the
 * left and right cards on every event and the island would flicker between
 * them. So once the order changes it holds for at least this long; a change
 * that comes sooner waits for the dwell to run out, and the order is then
 * recomputed from the activity at that moment. Two seconds is long enough to
 * read a step, short enough that the session you just switched to shows up at
 * once.
 */
export const SESSION_DWELL_MS = 2_000;

/**
 * A session with no hook event for this long is dropped from the island.
 *
 * `SessionEnd` is the normal way out, but a terminal closed with its window's ✕,
 * a killed process or a crashed machine never sends it. An hour is past any
 * ordinary pause — a lunch break, a long build inside a single tool call — yet
 * stale sessions do not pile up for days. A dropped session simply comes back,
 * with a fresh step list, on its next event.
 */
export const SESSION_EXPIRY_MS = 60 * 60_000;

/** At most this many panitas (mini Mochis) in a row; the rest are a "+N". */
export const PANITA_CAP = 3;

/**
 * Session colours. All of them read on the black island and on the #141518
 * card, at dot size and as a mini Mochi body; neighbouring entries are far apart
 * in hue so two live sessions never look alike. Mostly the macOS project colours
 * (IslandConst.projectColors), with a lighter violet and a lime added.
 */
export const SESSION_COLORS = [
  "#38BDF8", // sky
  "#FF5A4E", // coral
  "#2EC4A0", // teal
  "#F29B38", // orange
  "#A78BFA", // violet
  "#EC4899", // pink
  "#EAB308", // yellow
  "#A3E635", // lime
] as const;

function hash(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/**
 * The colour for a new session, chosen once and kept for its whole life.
 *
 * Each project name has a preferred colour (a hash into the palette), so a
 * project usually comes back in the same colour after its session ends. If a
 * live session already wears it, the next free colour in the palette is taken:
 * live sessions never share a colour while there are fewer of them than
 * colours. Past that, the least-worn colour.
 */
export function pickSessionColor(projectName: string, inUse: readonly string[]): string {
  const start = hash(projectName.toLowerCase()) % SESSION_COLORS.length;
  let best: string = SESSION_COLORS[start];
  let bestCount = Number.POSITIVE_INFINITY;
  for (let i = 0; i < SESSION_COLORS.length; i++) {
    const color = SESSION_COLORS[(start + i) % SESSION_COLORS.length];
    const count = inUse.filter((c) => c === color).length;
    if (count === 0) return color;
    if (count < bestCount) {
      best = color;
      bestCount = count;
    }
  }
  return best;
}

/**
 * The order sessions would have with no dwell: the one waiting on an approval
 * card first, then most recent activity first. Ties keep their current order
 * (Array.prototype.sort is stable).
 */
export function orderSessions<T extends { id: string; lastActivity: number }>(
  sessions: readonly T[],
  firstId: string | null,
): T[] {
  return [...sessions].sort(
    (a, b) =>
      Number(b.id === firstId) - Number(a.id === firstId) || b.lastActivity - a.lastActivity,
  );
}

export function sameOrder(a: readonly { id: string }[], b: readonly { id: string }[]): boolean {
  return a.length === b.length && a.every((t, i) => t.id === b[i].id);
}

/**
 * Which session a hook event belongs to: its `session_id`, or its folder when
 * an event carries none (Claude Code always sends one; this is a safety net).
 */
export function sessionKey(sessionId: string | undefined, cwd: string | undefined): string {
  const id = (sessionId ?? "").trim();
  return id ? `session:${id}` : `cwd:${cwd ?? ""}`;
}
