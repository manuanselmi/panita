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

// ── Telling sessions apart ───────────────────────────────────────────────────
//
// A session is called what Claude Code calls it: the name given with
// `/rename`, or else the title Claude Code writes for the session after its
// first prompt ("Pintado de tabiques STR-161") — the name `/resume` lists.
// Hooks do not carry it; the session's status line does (`session_name`),
// from its first answer on (pipe.rs, `session-name` event). Until then the
// session is named after its folder, and several sessions in one project —
// three terminals on `struxto-especificador`, say — would all read the same.
//
// So each session also gets a number: the smallest one no live session of the
// same name holds. The first is shown bare, the others with their number:
// "struxto-especificador", "struxto-especificador 2", "… 3". A session keeps
// its number for as long as it keeps its name, so a label never jumps from one
// live session to another: if the first one ends, the second stays "… 2"
// (alone, it is still told apart from the one that ended), and the next new
// session takes the free number — bare again. While none ends in between, the
// numbers follow the order of creation. A session that is named — by Claude
// Code, or by its folder when it had none — takes the free number for its new
// name, which is nearly always none at all.

/** The number a new session called `name` gets, given the sessions alive now. */
export function pickOrdinal(
  name: string,
  live: readonly { name: string; ordinal: number }[],
): number {
  const taken = new Set(live.filter((s) => s.name === name).map((s) => s.ordinal));
  let n = 1;
  while (taken.has(n)) n++;
  return n;
}

/**
 * A task's label in two parts: the name, which may be cut with "…" to fit, and
 * the suffix (" 2"), which must stay readable. Integrations have no number.
 */
export function labelParts(task: { name: string; ordinal?: number }): { name: string; suffix: string } {
  const n = task.ordinal ?? 1;
  return { name: task.name, suffix: n > 1 ? ` ${n}` : "" };
}

/** The label in one string: "struxto-especificador 2". */
export function displayName(task: { name: string; ordinal?: number }): string {
  const { name, suffix } = labelParts(task);
  return name + suffix;
}

/**
 * The quiet word after a session's name on the left card: its folder once
 * the session goes by a name of its own — the project it belongs to — and
 * "Claude Code" while the name still is the folder.
 */
export function sessionTag(task: { name: string; folder: string }): string {
  return task.folder && task.folder !== task.name ? task.folder : "Claude Code";
}

/**
 * The `session-name` event's payload (pipe.rs): whose name, and the name.
 * Null when it says nothing usable.
 */
export function parseSessionName(payload: unknown): { sessionId: string; name: string } | null {
  if (!payload || typeof payload !== "object") return null;
  const { sessionId, name } = payload as Record<string, unknown>;
  if (typeof sessionId !== "string" || !sessionId.trim()) return null;
  if (typeof name !== "string" || !name.trim()) return null;
  return { sessionId: sessionId.trim(), name: name.trim() };
}

/** Longest first prompt kept for a session's tooltip. */
export const FIRST_PROMPT_MAX = 80;

/** A prompt as the tooltip shows it: one line, at most FIRST_PROMPT_MAX characters. */
export function promptSummary(prompt: string): string {
  const line = prompt.replace(/\s+/g, " ").trim();
  return line.length <= FIRST_PROMPT_MAX ? line : `${line.slice(0, FIRST_PROMPT_MAX - 1).trimEnd()}…`;
}

/**
 * Which session a hook event belongs to: its `session_id`, or its folder when
 * an event carries none (Claude Code always sends one; this is a safety net).
 */
export function sessionKey(sessionId: string | undefined, cwd: string | undefined): string {
  const id = (sessionId ?? "").trim();
  return id ? `session:${id}` : `cwd:${cwd ?? ""}`;
}
