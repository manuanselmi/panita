// App state (src/core/state.ts + src/core/sessions.ts): the Claude Code
// sessions — creation, order, dwell, approval and click promotion, expiry,
// colours, same-name numbering — the right card's panitas and their grid
// (panitaGrid in src/core/layout.ts), and the opt-in integrations around them. State is a module
// singleton, so every test loads a fresh copy of the module; time is faked, and
// `window` stands in for the timers State schedules.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

async function freshState() {
  vi.resetModules();
  return import("../../src/core/state");
}

type Mod = Awaited<ReturnType<typeof freshState>>;
const ids = (tasks: { id: string }[]) => tasks.map((t) => t.id);
const names = (tasks: { name: string }[]) => tasks.map((t) => t.name);

let State: Mod["State"];
let DEFAULT_SETTINGS: Mod["DEFAULT_SETTINGS"];
let sessions: typeof import("../../src/core/sessions");
let layout: typeof import("../../src/core/layout");

/** A hook event from session `key` in folder …\<name>. */
const ev = (key: string, name = key, wslDistro: string | null = null) => ({
  key,
  sessionId: key,
  cwd: `C:\\p\\${name}`,
  name,
  wslDistro,
});

/** Advances the fake clock (and its timers) and returns the new time. */
const tick = (ms: number) => {
  vi.advanceTimersByTime(ms);
  return Date.now();
};

beforeEach(async () => {
  vi.stubGlobal("window", globalThis);
  vi.useFakeTimers();
  ({ State, DEFAULT_SETTINGS } = await freshState());
  sessions = await import("../../src/core/sessions");
  layout = await import("../../src/core/layout");
  State.settings.activeIntegrations = [];
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("default view", () => {
  it("is `empty` with nothing at all, `overview` with a session or an integration", () => {
    expect(State.defaultView()).toBe("empty");
    State.sessionEvent(ev("a"));
    expect(State.defaultView()).toBe("overview");
    State.removeSession("a");
    expect(State.defaultView()).toBe("empty");
    State.settings.activeIntegrations = ["integration_github"];
    State.loadIntegrationTasks();
    expect(State.defaultView()).toBe("overview");
  });
});

describe("sessions: creation", () => {
  it("a first event creates the session, on the left card", () => {
    const s = State.sessionEvent(ev("a", "panita", "Ubuntu"));
    expect(s).toMatchObject({
      kind: "session",
      id: "a",
      name: "panita",
      folder: "panita",
      title: null,
      cwd: String.raw`C:\p\panita`,
      wslDistro: "Ubuntu",
      state: "idle",
      steps: [],
      stepTotal: 0,
      isIntegration: false,
      ordinal: 1,
      firstPrompt: null,
    });
    expect(sessions.SESSION_COLORS).toContain(s.color);
    expect(State.focusTask).toBe(s);
    expect(State.panitas).toEqual([]);
  });

  it("later events update the same session, never a second one", () => {
    const first = State.sessionEvent(ev("a"));
    tick(1000);
    const again = State.sessionEvent(ev("a"));
    expect(again).toBe(first);
    expect(State.sessions).toHaveLength(1);
    expect(again.lastActivity).toBe(Date.now());
  });

  it("keeps the last 20 steps and counts them all", () => {
    State.sessionEvent(ev("a"));
    for (let i = 1; i <= 25; i++) State.appendStep("a", `step ${i}`);
    const s = State.sessions[0];
    expect(s.steps).toHaveLength(20);
    expect(s.steps[0]).toBe("step 6");
    expect(s.stepIndex).toBe(19);
    expect(s.stepTotal).toBe(25);
  });
});

describe("sessions: order", () => {
  it("most recent activity first", () => {
    State.sessionEvent(ev("a"));
    tick(100);
    State.sessionEvent(ev("b"));
    tick(sessions.SESSION_DWELL_MS);
    State.sessionEvent(ev("c"));
    expect(names(State.sessions)).toEqual(["c", "b", "a"]);
    expect(State.focusTask?.name).toBe("c");
    // Everyone else is a panita, in the same order.
    expect(names(State.panitas)).toEqual(["b", "a"]);
  });

  it("holds a new order for the dwell, then catches up without another event", () => {
    State.sessionEvent(ev("a"));
    tick(100);
    State.sessionEvent(ev("b")); // the first change: at once
    expect(names(State.sessions)).toEqual(["b", "a"]);
    tick(400);
    State.sessionEvent(ev("a")); // 0.4 s later: held
    expect(names(State.sessions)).toEqual(["b", "a"]);
    tick(sessions.SESSION_DWELL_MS - 401);
    expect(names(State.sessions)).toEqual(["b", "a"]);
    tick(1);
    expect(names(State.sessions)).toEqual(["a", "b"]);
  });

  it("two sessions alternating swap at most once per dwell", () => {
    State.sessionEvent(ev("a"));
    State.sessionEvent(ev("b"));
    let swaps = 0;
    let primary = State.focusTask?.id;
    State.subscribe(() => {
      if (State.focusTask?.id !== primary) {
        swaps++;
        primary = State.focusTask?.id;
      }
    });
    // An event every 300 ms, alternating, for ten seconds.
    for (let i = 0; i < 34; i++) {
      tick(300);
      State.sessionEvent(ev(i % 2 ? "a" : "b"));
    }
    expect(swaps).toBeGreaterThan(0);
    expect(swaps).toBeLessThanOrEqual(Math.ceil(10_200 / sessions.SESSION_DWELL_MS));
  });

  it("a session arriving during the dwell joins at the back, then moves up", () => {
    State.sessionEvent(ev("a"));
    tick(100);
    State.sessionEvent(ev("b"));
    tick(100);
    State.sessionEvent(ev("c"));
    expect(names(State.sessions)).toEqual(["b", "a", "c"]);
    tick(sessions.SESSION_DWELL_MS);
    expect(names(State.sessions)).toEqual(["c", "b", "a"]);
  });

  it("holds still while the pointer is on the open island", () => {
    State.mode = "expanded";
    State.sessionEvent(ev("a"));
    tick(100);
    State.sessionEvent(ev("b"));
    State.setPointerOnIsland(true);
    tick(5_000);
    State.sessionEvent(ev("a"));
    tick(5_000);
    expect(names(State.sessions)).toEqual(["b", "a"]);
    State.setPointerOnIsland(false);
    expect(names(State.sessions)).toEqual(["a", "b"]);
  });

  it("does not hold for a pointer on the compact island", () => {
    State.mode = "compact";
    State.sessionEvent(ev("a"));
    tick(100);
    State.sessionEvent(ev("b"));
    State.setPointerOnIsland(true);
    tick(5_000);
    State.sessionEvent(ev("a"));
    expect(names(State.sessions)).toEqual(["a", "b"]);
  });

  it("a session waiting on an approval card goes first at once, and stays first", () => {
    State.sessionEvent(ev("a"));
    tick(100);
    State.sessionEvent(ev("b"));
    tick(100);
    const c = State.sessionEvent(ev("c"));
    State.pendingApproval = { requestId: "r", sessionId: "c", tool: "Bash", command: "x", session: c };
    State.reorderSessions(Date.now(), true); // within b's dwell
    expect(State.focusTask).toBe(c);
    tick(3_000);
    State.sessionEvent(ev("a"));
    tick(3_000);
    expect(State.focusTask).toBe(c);
    State.pendingApproval = null;
    State.reorderSessions();
    expect(State.focusTask?.name).toBe("a");
  });
});

describe("sessions: a click on a panita", () => {
  it("puts that session on the left card at once, past the dwell", () => {
    State.sessionEvent(ev("a"));
    tick(100);
    State.sessionEvent(ev("b"));
    tick(100);
    State.sessionEvent(ev("c"));
    // b led for 0.1 s only; a click does not wait.
    State.select("a");
    expect(State.focusTask?.name).toBe("a");
    expect(names(State.panitas)).toEqual(["c", "b"]);
  });

  it("counts as activity: it holds for the dwell, then the newest leads again", () => {
    State.sessionEvent(ev("a"));
    State.sessionEvent(ev("b"));
    tick(sessions.SESSION_DWELL_MS);
    State.select("a");
    tick(500);
    State.sessionEvent(ev("b"));
    expect(State.focusTask?.name).toBe("a");
    tick(sessions.SESSION_DWELL_MS);
    expect(State.focusTask?.name).toBe("b");
  });

  it("clears that session's badge", () => {
    State.sessionEvent(ev("a"));
    const b = State.sessionEvent(ev("b"));
    b.pillBadge = "finished";
    State.select("b");
    expect(b.pillBadge).toBeNull();
  });

  it("ignores ids it does not know", () => {
    State.sessionEvent(ev("a"));
    State.select("nope");
    expect(State.focusTask?.name).toBe("a");
    expect(State.focusId).toBeNull();
  });
});

describe("sessions: lifecycle", () => {
  it("SessionEnd removes the session; the next one takes the left card", () => {
    State.sessionEvent(ev("a"));
    tick(sessions.SESSION_DWELL_MS);
    State.sessionEvent(ev("b"));
    expect(State.focusTask?.name).toBe("b");
    State.removeSession("b");
    expect(names(State.sessions)).toEqual(["a"]);
    expect(State.focusTask?.name).toBe("a");
  });

  it("a session silent for an hour is dropped, on its own timer", () => {
    State.sessionEvent(ev("old"));
    tick(30 * 60_000);
    State.sessionEvent(ev("busy"));
    tick(30 * 60_000 - 1);
    expect(names(State.sessions).sort()).toEqual(["busy", "old"]);
    tick(1);
    expect(names(State.sessions)).toEqual(["busy"]);
    tick(30 * 60_000);
    expect(State.sessions).toEqual([]);
  });

  it("a click is not a sign of life", () => {
    State.sessionEvent(ev("a"));
    tick(59 * 60_000);
    State.select("a");
    tick(60_000);
    expect(State.sessions).toEqual([]);
  });

  it("an expired session comes back on its next event, with fresh steps", () => {
    State.sessionEvent(ev("a"));
    State.appendStep("a", "before");
    tick(sessions.SESSION_EXPIRY_MS);
    expect(State.sessions).toEqual([]);
    const back = State.sessionEvent(ev("a"));
    expect(back.steps).toEqual([]);
  });

  it("is also pruned by the next event, should its timer be late", () => {
    State.sessionEvent(ev("old"));
    vi.setSystemTime(Date.now() + sessions.SESSION_EXPIRY_MS + 5_000); // the clock jumps, no timer runs
    State.sessionEvent(ev("new"));
    expect(names(State.sessions)).toEqual(["new"]);
  });

  it("no timer is left once there are no sessions", () => {
    State.sessionEvent(ev("a"));
    tick(100);
    State.sessionEvent(ev("b"));
    tick(100);
    State.sessionEvent(ev("a"));
    State.removeSession("a");
    State.removeSession("b");
    tick(sessions.SESSION_DWELL_MS);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("sessions: colours", () => {
  it("stay the same for a session's whole life", () => {
    const a = State.sessionEvent(ev("a"));
    const color = a.color;
    for (let i = 0; i < 6; i++) {
      tick(sessions.SESSION_DWELL_MS);
      State.sessionEvent(ev(`s${i}`));
      State.sessionEvent(ev("a"));
      State.select(`s${i}`);
    }
    expect(a.color).toBe(color);
  });

  it("differ between live sessions, up to the size of the palette", () => {
    // Twelve names, so several of them prefer the same colour.
    const all = Array.from({ length: sessions.SESSION_COLORS.length }, (_, i) =>
      State.sessionEvent(ev(`k${i}`, `project-${i % 3}`)),
    );
    expect(new Set(all.map((s) => s.color)).size).toBe(sessions.SESSION_COLORS.length);
  });

  it("past the palette, the least-worn colour", () => {
    for (let i = 0; i < sessions.SESSION_COLORS.length + 2; i++) State.sessionEvent(ev(`k${i}`));
    const counts = new Map<string, number>();
    for (const s of State.sessions) counts.set(s.color, (counts.get(s.color) ?? 0) + 1);
    expect(Math.max(...counts.values())).toBe(2);
  });

  it("a project gets its usual colour back once it is free again", () => {
    const usual = State.sessionEvent(ev("a", "panita")).color;
    expect(sessions.pickSessionColor("panita", [])).toBe(usual);
    // A second panita session meanwhile wears another one.
    expect(State.sessionEvent(ev("b", "panita")).color).not.toBe(usual);
    State.removeSession("a");
    State.removeSession("b");
    expect(State.sessionEvent(ev("c", "panita")).color).toBe(usual);
  });

  it("read on the dark island: none too dark, none grey", () => {
    for (const hex of sessions.SESSION_COLORS) {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
      const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      expect(luminance, hex).toBeGreaterThan(0.2);
      expect(Math.max(r, g, b) - Math.min(r, g, b), hex).toBeGreaterThan(0.35);
    }
  });
});

describe("the right card: panitas", () => {
  const sessionsIn = (keys: string[]) => {
    for (const k of keys) {
      State.sessionEvent(ev(k));
      tick(sessions.SESSION_DWELL_MS);
    }
  };

  it("six others fill the six slots", () => {
    sessionsIn(["a", "b", "c", "d", "e", "f", "g"]);
    expect(State.focusTask?.name).toBe("g");
    const { shown, more } = State.panitaSlots();
    expect(names(shown)).toEqual(["f", "e", "d", "c", "b", "a"]);
    expect(more).toBe(0);
  });

  it("past six, five panitas and the +N in the last slot", () => {
    sessionsIn(["a", "b", "c", "d", "e", "f", "g", "h"]);
    const { shown, more } = State.panitaSlots();
    expect(names(shown)).toEqual(["g", "f", "e", "d", "c"]);
    expect(more).toBe(2);
    expect(names(State.panitas)).toEqual(["g", "f", "e", "d", "c", "b", "a"]);
  });

  it("the compact island's four cells follow the same rule", () => {
    sessionsIn(["a", "b", "c", "d", "e"]);
    expect(names(State.panitaSlots(4).shown)).toEqual(["d", "c", "b", "a"]);
    sessionsIn(["f"]);
    expect(names(State.panitaSlots(4).shown)).toEqual(["e", "d", "c"]);
    expect(State.panitaSlots(4).more).toBe(2);
  });

  it("the grid looks balanced at every count", () => {
    const grid = (n: number) => {
      const g = layout.panitaGrid(n);
      return [g.rows.join("+"), g.cols, g.shown, g.more, g.size];
    };
    expect(grid(0)).toEqual(["", 0, 0, 0, 0]);
    // One row, centred, larger Mochis while everyone fits on it.
    expect(grid(1)).toEqual(["1", 1, 1, 0, 26]);
    expect(grid(2)).toEqual(["2", 2, 2, 0, 26]);
    expect(grid(3)).toEqual(["3", 3, 3, 0, 26]);
    // Four is a square, not three and an orphan.
    expect(grid(4)).toEqual(["2+2", 2, 4, 0, 20]);
    expect(grid(5)).toEqual(["3+2", 3, 5, 0, 20]);
    expect(grid(6)).toEqual(["3+3", 3, 6, 0, 20]);
    // Past six: five and the "+N", which takes the sixth slot.
    expect(grid(7)).toEqual(["3+3", 3, 5, 2, 20]);
    expect(grid(8)).toEqual(["3+3", 3, 5, 3, 20]);
    expect(grid(30)).toEqual(["3+3", 3, 5, 25, 20]);
    for (let n = 1; n <= 30; n++) {
      const g = layout.panitaGrid(n);
      expect(g.shown + g.more, `${n}`).toBe(n);
      expect(g.rows.reduce((a, b) => a + b, 0), `${n}`).toBe(Math.min(n, layout.PANITA_SLOTS));
      expect(Math.max(...g.rows), `${n}`).toBeLessThanOrEqual(g.cols);
    }
  });

  it("a hidden session can still come forward by itself", () => {
    for (const k of ["a", "b", "c", "d", "e", "f", "g"]) {
      State.sessionEvent(ev(k));
      tick(sessions.SESSION_DWELL_MS);
    }
    State.sessionEvent(ev("a"));
    expect(State.focusTask?.name).toBe("a");
  });
});

describe("sessions: same name", () => {
  /** A session in folder …\<name>, keyed `key`. */
  const named = (key: string, name: string) => State.sessionEvent(ev(key, name));
  const labels = () => State.sessions.map((s) => sessions.displayName(s)).sort();

  it("are numbered in order of creation: bare, then 2, 3", () => {
    const [a, b, c] = ["s1", "s2", "s3"].map((k) => named(k, "struxto-especificador"));
    expect([a.ordinal, b.ordinal, c.ordinal]).toEqual([1, 2, 3]);
    expect([a, b, c].map(sessions.displayName)).toEqual([
      "struxto-especificador",
      "struxto-especificador 2",
      "struxto-especificador 3",
    ]);
    // Other names count on their own.
    expect(named("p", "panita").ordinal).toBe(1);
  });

  it("keep their number for life; a newcomer takes the free one", () => {
    named("s1", "x");
    const b = named("s2", "x");
    named("s3", "x");
    State.removeSession("s1");
    for (let i = 0; i < 5; i++) {
      tick(sessions.SESSION_DWELL_MS);
      State.sessionEvent(ev("s2", "x"));
      State.select("s3");
    }
    // Alone or not, the second stays "x 2": its label never moves to another session.
    expect(b.ordinal).toBe(2);
    expect(labels()).toEqual(["x 2", "x 3"]);
    expect(named("s4", "x").ordinal).toBe(1);
    expect(labels()).toEqual(["x", "x 2", "x 3"]);
    expect(named("s5", "x").ordinal).toBe(4);
  });

  it("an expired session frees its number too", () => {
    named("s1", "x");
    tick(30 * 60_000);
    named("s2", "x");
    tick(30 * 60_000);
    expect(State.sessions.map((s) => s.id)).toEqual(["s2"]);
    expect(named("s3", "x").ordinal).toBe(1);
  });

  it("a session named only later (no folder at first) gets a number for that name", () => {
    named("s1", "x");
    const late = State.sessionEvent({ key: "s2", sessionId: "s2", cwd: "", name: "Session", wslDistro: null });
    expect(late.ordinal).toBe(1);
    State.sessionEvent(ev("s2", "x"));
    expect(late.name).toBe("x");
    expect(late.ordinal).toBe(2);
  });

  it("a session Claude Code names goes by that name, numbered only among sessions of that name", () => {
    const [a, b, c] = ["s1", "s2", "s3"].map((k) => named(k, "struxto-especificador"));
    expect(State.nameSession("s2", "Agente especificador Opus máximo STR-161")).toBe(true);
    expect(b).toMatchObject({
      name: "Agente especificador Opus máximo STR-161", ordinal: 1, folder: "struxto-especificador",
    });
    // The others keep their numbers: a label never moves to another session.
    expect([a, c].map(sessions.displayName)).toEqual(["struxto-especificador", "struxto-especificador 3"]);
    // Two sessions /rename'd alike are told apart the same way.
    expect(State.nameSession("s3", "Agente especificador Opus máximo STR-161")).toBe(true);
    expect(sessions.displayName(c)).toBe("Agente especificador Opus máximo STR-161 2");
    // Same name again, or a session the island does not know: nothing changes.
    expect(State.nameSession("s3", "Agente especificador Opus máximo STR-161")).toBe(false);
    expect(State.nameSession("nobody", "x")).toBe(false);
    expect(State.sessions).toHaveLength(3);
    // Its folder still decides nothing but the colour it was given at first.
    State.sessionEvent(ev("s2", "struxto-especificador"));
    expect(b.name).toBe("Agente especificador Opus máximo STR-161");
  });

  it("a session Claude Code names before its folder is known keeps that name", () => {
    const late = State.sessionEvent({ key: "s1", sessionId: "s1", cwd: "", name: "Session", wslDistro: null });
    State.nameSession("s1", "apollo");
    State.sessionEvent(ev("s1", "scout"));
    expect(late).toMatchObject({ name: "apollo", folder: "scout", cwd: String.raw`C:\p\scout`, ordinal: 1 });
  });

  it("the left card's tag is the folder once the name is not, else Claude Code", () => {
    expect(sessions.sessionTag({ name: "Pintado de tabiques", folder: "struxto-especificador" })).toBe("struxto-especificador");
    expect(sessions.sessionTag({ name: "panita", folder: "panita" })).toBe("Claude Code");
    expect(sessions.sessionTag({ name: "Session", folder: "" })).toBe("Claude Code");
  });

  it("the session-name event says whose name and the name, or nothing", () => {
    expect(sessions.parseSessionName({ sessionId: " a ", name: " apollo " })).toEqual({ sessionId: "a", name: "apollo" });
    for (const bad of [null, "apollo", {}, { sessionId: "a" }, { name: "apollo" }, { sessionId: "", name: "x" }, { sessionId: "a", name: " " }, { sessionId: "a", name: 3 }]) {
      expect(sessions.parseSessionName(bad)).toBeNull();
    }
  });

  it("labels split into a name that may be cut and a number that may not", () => {
    expect(sessions.labelParts({ name: "struxto-especificador", ordinal: 3 })).toEqual({
      name: "struxto-especificador",
      suffix: " 3",
    });
    expect(sessions.labelParts({ name: "panita", ordinal: 1 })).toEqual({ name: "panita", suffix: "" });
    // Integrations have no number.
    expect(sessions.labelParts({ name: "GitHub" })).toEqual({ name: "GitHub", suffix: "" });
  });

  it("first prompts are kept as one line of at most 80 characters", () => {
    expect(sessions.promptSummary("  Arreglá\n\n el   build ")).toBe("Arreglá el build");
    const long = "x".repeat(200);
    const summary = sessions.promptSummary(long);
    expect(summary).toHaveLength(sessions.FIRST_PROMPT_MAX);
    expect(summary.endsWith("…")).toBe(true);
  });
});

describe("integrations", () => {
  it("load only the active ones, in the declared order", () => {
    State.settings.activeIntegrations = ["integration_github", "integration_resend"];
    State.loadIntegrationTasks();
    expect(ids(State.tasks)).toEqual(["integration_resend", "integration_github"]);
    expect(State.focusId).toBeNull();
  });

  it("there is no VS Code pill any more: sessions are their own tasks", async () => {
    const { INTEGRATION_AGENTS } = await import("../../src/core/state");
    expect(ids(INTEGRATION_AGENTS)).not.toContain("integration_claude");
  });

  it("none ships switched on: a fresh island shows sessions only", async () => {
    expect(DEFAULT_SETTINGS.activeIntegrations).toEqual([]);
    const fresh = (await freshState()).State;
    fresh.loadIntegrationTasks();
    expect(fresh.tasks).toEqual([]);
    expect(fresh.defaultView()).toBe("empty");
  });

  it("come after the sessions, in the same grid with the same cap", () => {
    State.settings.activeIntegrations = ["integration_github", "integration_vercel"];
    State.loadIntegrationTasks();
    for (const k of ["a", "b", "c", "d"]) {
      State.sessionEvent(ev(k));
      tick(sessions.SESSION_DWELL_MS);
    }
    expect(State.focusTask?.name).toBe("d");
    expect(names(State.panitas)).toEqual(["c", "b", "a", "Vercel", "GitHub"]);
    expect(State.panitaSlots().more).toBe(0);
    const compact = State.panitaSlots(4);
    expect(names(compact.shown)).toEqual(["c", "b", "a"]);
    expect(compact.more).toBe(2);
  });

  it("with no session, the first integration takes the left card", () => {
    State.settings.activeIntegrations = ["integration_github", "integration_vercel"];
    State.loadIntegrationTasks();
    expect(State.focusTask?.id).toBe("integration_vercel");
    expect(ids(State.panitas)).toEqual(["integration_github"]);
  });

  it("a clicked integration holds the left card until a session is clicked", () => {
    State.settings.activeIntegrations = ["integration_github"];
    State.loadIntegrationTasks();
    State.sessionEvent(ev("a"));
    State.tasks[0].pillBadge = "finished";
    State.select("integration_github");
    expect(State.focusTask?.id).toBe("integration_github");
    expect(State.tasks[0].pillBadge).toBeNull();
    // The session is a panita now, and its activity does not take the card back.
    expect(names(State.panitas)).toEqual(["a"]);
    tick(5_000);
    State.sessionEvent(ev("a"));
    expect(State.focusTask?.id).toBe("integration_github");
    State.select("a");
    expect(State.focusTask?.name).toBe("a");
    expect(State.focusId).toBeNull();
  });

  it("toggle on and off, capped at four, never in place", () => {
    State.settings.activeIntegrations = [
      "integration_resend", "integration_n8n", "integration_vercel", "integration_github",
    ];
    State.loadIntegrationTasks();
    const before = State.settings.activeIntegrations;
    State.toggleIntegration("integration_notion");
    expect(State.settings.activeIntegrations).toHaveLength(4);
    State.toggleIntegration("integration_resend");
    State.toggleIntegration("integration_notion");
    expect(State.settings.activeIntegrations).toEqual([
      "integration_n8n",
      "integration_vercel",
      "integration_github",
      "integration_notion",
    ]);
    expect(before).toHaveLength(4);
    expect(ids(State.tasks)).toEqual([
      "integration_n8n",
      "integration_vercel",
      "integration_github",
      "integration_notion",
    ]);
  });

  it("toggling ignores unknown ids", () => {
    State.toggleIntegration("integration_claude");
    expect(State.settings.activeIntegrations).toEqual([]);
  });

  it("switching off the integration on the left card hands it back to the sessions", () => {
    State.settings.activeIntegrations = ["integration_github"];
    State.loadIntegrationTasks();
    State.sessionEvent(ev("a"));
    State.select("integration_github");
    State.toggleIntegration("integration_github");
    expect(State.focusId).toBeNull();
    expect(State.focusTask?.name).toBe("a");
  });
});

describe("what the view is about", () => {
  it("the asking session on the approval card, the finished one on its card, the left card otherwise", () => {
    const a = State.sessionEvent(ev("a"));
    tick(sessions.SESSION_DWELL_MS);
    const b = State.sessionEvent(ev("b"));
    expect(State.subjectTask).toBe(b);

    State.view = "finished";
    State.alertTask = a;
    expect(State.subjectTask).toBe(a);

    State.view = "approval";
    State.pendingApproval = { requestId: "r", sessionId: "a", tool: "Bash", command: "x", session: a };
    expect(State.subjectTask).toBe(a);

    State.view = "overview";
    expect(State.subjectTask).toBe(State.focusTask);
  });

  it("effectiveState prefers the override, then the subject's state", () => {
    const a = State.sessionEvent(ev("a"));
    State.updateTask("a", "working");
    expect(State.effectiveState).toBe("working");
    State.stateOverride = "dizzy";
    expect(State.effectiveState).toBe("dizzy");
    State.stateOverride = null;
    a.state = "finished";
    expect(State.effectiveState).toBe("finished");
  });

  it("notifies subscribers on every change, until they unsubscribe", () => {
    State.sessionEvent(ev("a"));
    const listener = vi.fn();
    const off = State.subscribe(listener);
    State.updateTask("a", "thinking");
    State.appendStep("a", "x");
    expect(listener).toHaveBeenCalledTimes(2);
    off();
    State.updateTask("a", "idle");
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe("pure helpers", () => {
  it("sessionKey: the session_id, else the folder", () => {
    expect(sessions.sessionKey("abc", "C:/x")).toBe("session:abc");
    expect(sessions.sessionKey("  ", "C:/x")).toBe("cwd:C:/x");
    expect(sessions.sessionKey(undefined, undefined)).toBe("cwd:");
  });

  it("orderSessions: the pinned one first, then most recent, ties kept", () => {
    const list = [
      { id: "a", lastActivity: 1 },
      { id: "b", lastActivity: 3 },
      { id: "c", lastActivity: 3 },
      { id: "d", lastActivity: 2 },
    ];
    expect(ids(sessions.orderSessions(list, null))).toEqual(["b", "c", "d", "a"]);
    expect(ids(sessions.orderSessions(list, "a"))).toEqual(["a", "b", "c", "d"]);
  });
});
