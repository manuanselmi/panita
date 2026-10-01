// Claude Code hook events → island state (src/island/hooks.ts).
//
// hooks.ts is driven exactly as in the app: it registers a `hook` listener on
// the bridge, and each test calls that listener with a payload shaped like the
// ones coucou-hook forwards. The bridge and the sound engine are mocked, the
// island is a small fake that records what it was asked to do, and State is the
// real one — reloaded for every test so nothing leaks between them.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Island } from "../../src/island/island";
import type { IslandViewName } from "../../src/core/layout";

const bridge = vi.hoisted(() => ({
  handlers: new Map<string, (payload: unknown) => void>(),
  Bridge: {
    approvalAck: vi.fn(),
    approvalDecline: vi.fn(),
    approvalDecision: vi.fn(),
    log: vi.fn(),
    openSession: vi.fn(async () => "opened"),
    openUrl: vi.fn(),
    openN8n: vi.fn(),
  },
}));

vi.mock("../../src/core/bridge", () => ({
  IS_TAURI: false,
  Bridge: bridge.Bridge,
  onEvent: async (name: string, handler: (payload: unknown) => void) => {
    bridge.handlers.set(name, handler);
    return () => bridge.handlers.delete(name);
  },
}));

// Sounds need Web Audio; the tests only check which one is asked for.
vi.mock("../../src/core/sound", () => ({ Sound: { play: vi.fn() } }));

type Payload = Record<string, unknown>;

async function load() {
  vi.resetModules();
  bridge.handlers.clear();
  const { State } = await import("../../src/core/state");
  const { Sound } = await import("../../src/core/sound");
  const { registerHookHandlers } = await import("../../src/island/hooks");
  const open = await import("../../src/island/open");

  // No integrations unless a test turns some on: these tests are about sessions.
  State.settings.activeIntegrations = [];
  State.loadIntegrationTasks();

  // Mirrors what the real Island does with State for each call, minus the DOM.
  const island = {
    alert: vi.fn((view: IslandViewName) => {
      State.mode = "expanded";
      State.view = view;
    }),
    reveal: vi.fn(() => {
      if (State.mode === "hidden") State.mode = "compact";
    }),
    setView: vi.fn((view: IslandViewName) => {
      State.view = view;
    }),
    dropPin: vi.fn(),
  };
  registerHookHandlers(island as unknown as Island);

  const send = (payload: Payload) => {
    const handler = bridge.handlers.get("hook");
    if (!handler) throw new Error("hooks.ts never listened for `hook`");
    handler(payload);
  };
  /** The one session a single-session test talks to. */
  const only = () => {
    expect(State.sessions).toHaveLength(1);
    return State.sessions[0];
  };
  const named = (name: string) => {
    const s = State.sessions.find((x) => x.name === name);
    if (!s) throw new Error(`no session named ${name}: ${State.sessions.map((x) => x.name).join(", ")}`);
    return s;
  };
  const names = () => State.sessions.map((s) => s.name);
  return { State, Sound, island, send, only, named, names, open };
}

const CWD = String.raw`C:\Users\dev\projects\my-app`;

/** A payload from the session `id`, whose folder is …\<project>. */
function from(id: string, project: string, extra: Payload = {}): Payload {
  return { session_id: id, cwd: `C:\\Users\\dev\\projects\\${project}`, ...extra };
}

const work = (id: string, project: string, command: string) =>
  from(id, project, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });

function permission(id: string, tool: string, input: Payload, extra: Payload = {}): Payload {
  return {
    hook_event_name: "PermissionRequest",
    request_id: id,
    session_id: "session-1",
    cwd: CWD,
    tool_name: tool,
    tool_input: input,
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // hooks.ts and State schedule through `window.setTimeout`.
  vi.stubGlobal("window", globalThis);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("step labels (PreToolUse)", () => {
  const cases: [string, Payload, string][] = [
    ["Bash", { command: "npm test" }, "Ejecuta · npm test"],
    ["PowerShell", { command: "Get-ChildItem" }, "Ejecuta · Get-ChildItem"],
    ["Bash", { command: "x".repeat(80) }, `Ejecuta · ${"x".repeat(40)}`],
    ["Read", { file_path: String.raw`C:\repo\src\main.ts` }, "Lee · main.ts"],
    ["Write", { file_path: "/home/me/notes.md", content: "…" }, "Escribe · notes.md"],
    ["LS", { path: "C:/repo/src/" }, "Lista · src"],
    ["WebSearch", { query: "tauri single instance" }, "Busca en la web · tauri single instance"],
    // Grep's `pattern` is not one of the fields a step shows.
    ["Grep", { pattern: "TODO" }, "Busca texto"],
    ["mcp__linear__get_issue", { id: "ABC-1" }, "mcp__linear__get_issue"],
  ];

  it.each(cases)("%s %j → %s", async (tool, input, label) => {
    const { send, only } = await load();
    send({ hook_event_name: "PreToolUse", cwd: CWD, tool_name: tool, tool_input: input });
    expect(only().steps.at(-1)).toBe(label);
  });

  it("falls back to `Tool` when the event names no tool", async () => {
    const { send, only } = await load();
    send({ hook_event_name: "PreToolUse", cwd: CWD });
    expect(only().steps).toEqual(["Tool"]);
  });

  it("marks the session as working, names it after the folder, and reveals the island", async () => {
    const { State, send, only, island } = await load();
    send({ hook_event_name: "PreToolUse", cwd: CWD, tool_name: "Bash", tool_input: { command: "ls" } });
    expect(only()).toMatchObject({ state: "working", name: "my-app", cwd: CWD, stepIndex: 0, stepTotal: 1 });
    expect(island.reveal).toHaveBeenCalledOnce();
    expect(island.alert).not.toHaveBeenCalled();
    expect(State.mode).toBe("compact");
  });

  it("keeps counting steps past the 20 the list holds", async () => {
    const { send, only } = await load();
    for (let i = 1; i <= 25; i++) send(work("s", "app", `step ${i}`));
    expect(only().steps).toHaveLength(20);
    expect(only().steps.at(-1)).toBe("Ejecuta · step 25");
    expect(only().stepTotal).toBe(25);
  });
});

describe("approval target (PermissionRequest)", () => {
  const cases: [string, Payload, string][] = [
    ["Bash", { command: "rm -rf ./build" }, "Bash · rm -rf ./build"],
    // The full path, not the file name: this is what is being authorised.
    ["Write", { file_path: String.raw`C:\repo\.env`, content: "SECRET=1" }, String.raw`Write · C:\repo\.env`],
    ["WebFetch", { url: "https://example.com", prompt: "summarise" }, "WebFetch · https://example.com"],
    ["Glob", { pattern: "**/*.ts" }, "Glob · **/*.ts"],
    ["Task", { prompt: "  refactor the parser  " }, "Task · refactor the parser"],
    // Ordered by specificity: a command wins over a path.
    ["Odd", { file_path: "/a/b", command: "make" }, "Odd · make"],
    // Blank values are skipped rather than shown.
    ["Bash", { command: "   ", file_path: "/x/y" }, "Bash · /x/y"],
    ["Mystery", { count: 3 }, "Mystery"],
  ];

  it.each(cases)("%s %j → %s", async (tool, input, target) => {
    const { State, send } = await load();
    send(permission("r-1", tool, input));
    expect(State.pendingApproval?.command).toBe(target);
  });
});

describe("PermissionRequest", () => {
  it("acks at once, pins the card and opens the approval view", async () => {
    const { State, Sound, send, only, island } = await load();
    send(permission("42-1", "Bash", { command: "git push" }));

    expect(bridge.Bridge.approvalAck).toHaveBeenCalledExactlyOnceWith("42-1");
    expect(bridge.Bridge.approvalDecline).not.toHaveBeenCalled();
    expect(State.pendingApproval).toEqual({
      requestId: "42-1",
      sessionId: "session-1",
      tool: "Bash",
      command: "Bash · git push",
      session: only(),
    });
    expect(State.isPinned).toBe(true);
    expect(only().state).toBe("approval");
    expect(island.alert).toHaveBeenCalledExactlyOnceWith("approval");
    expect(State.view).toBe("approval");
    expect(Sound.play).toHaveBeenCalledWith("approval");
  });

  it("names the session asking, and puts it on the left card at once", async () => {
    const { State, send, named } = await load();
    send(work("a", "alpha", "one"));
    send(work("b", "beta", "two"));
    send(work("c", "gamma", "three"));
    // gamma is the most recent, but the dwell still holds the order for now.
    send(permission("r-1", "Bash", { command: "rm x" }, from("a", "alpha")));

    expect(State.pendingApproval?.session).toBe(named("alpha"));
    expect(State.subjectTask).toBe(named("alpha"));
    expect(State.focusTask).toBe(named("alpha"));

    // Still first while it waits, however busy the others are.
    send(work("b", "beta", "four"));
    vi.advanceTimersByTime(5_000);
    send(work("c", "gamma", "five"));
    vi.advanceTimersByTime(5_000);
    expect(State.focusTask).toBe(named("alpha"));
  });

  it("takes the card even over an integration the user is looking at", async () => {
    const { State, send, only, island } = await load();
    State.settings.activeIntegrations = ["integration_github"];
    State.loadIntegrationTasks();
    State.select("integration_github");
    send(permission("42-1", "Bash", { command: "git push" }));

    expect(island.alert).toHaveBeenCalledExactlyOnceWith("approval");
    expect(State.focusId).toBeNull();
    expect(State.focusTask).toBe(only());
    expect(bridge.Bridge.approvalAck).toHaveBeenCalledWith("42-1");
  });

  it("hands a second request straight back to the terminal", async () => {
    const { State, send } = await load();
    send(permission("first", "Bash", { command: "one" }));
    send(permission("second", "Bash", { command: "two" }));

    expect(bridge.Bridge.approvalDecline).toHaveBeenCalledExactlyOnceWith("second");
    expect(bridge.Bridge.approvalAck).toHaveBeenCalledExactlyOnceWith("first");
    expect(State.pendingApproval?.requestId).toBe("first");
    expect(State.pendingApproval?.command).toBe("Bash · one");
  });

  it("declines another session's request too, and badges that session until it moves on", async () => {
    const { State, send, named } = await load();
    send(work("b", "beta", "build"));
    send(permission("first", "Bash", { command: "one" }, from("a", "alpha")));
    send(permission("second", "Bash", { command: "two" }, from("b", "beta")));

    // Exactly as before: declined, the first card untouched.
    expect(bridge.Bridge.approvalDecline).toHaveBeenCalledExactlyOnceWith("second");
    expect(bridge.Bridge.approvalAck).toHaveBeenCalledExactlyOnceWith("first");
    expect(State.pendingApproval?.session).toBe(named("alpha"));
    expect(State.focusTask).toBe(named("alpha"));
    // beta is asking in its terminal.
    expect(named("beta").pillBadge).toBe("approval");

    // Its terminal's own notification is not an answer; its next tool event is.
    send(from("b", "beta", { hook_event_name: "Notification", message: "Claude needs your permission" }));
    expect(named("beta").pillBadge).toBe("approval");
    send(from("b", "beta", { hook_event_name: "PostToolUse", tool_name: "Bash" }));
    expect(named("beta").pillBadge).toBeNull();
  });

  it("drops the card after 110 s, when the relay has given up", async () => {
    const { State, send, only, island } = await load();
    send(permission("r-1", "Bash", { command: "sleep" }));

    vi.advanceTimersByTime(109_999);
    expect(State.pendingApproval).not.toBeNull();

    vi.advanceTimersByTime(1);
    expect(State.pendingApproval).toBeNull();
    expect(State.isPinned).toBe(false);
    expect(island.dropPin).toHaveBeenCalledOnce();
    expect(only()).toMatchObject({ state: "working", pillBadge: null });
    expect(island.setView).toHaveBeenCalledWith("overview");
  });

  it("keeps the card answerable when its session ends while it is up", async () => {
    const { State, send } = await load();
    send(permission("r-1", "Bash", { command: "rm x" }, from("a", "alpha")));
    send(from("a", "alpha", { hook_event_name: "SessionEnd", reason: "exit" }));
    expect(State.sessions).toEqual([]);
    expect(State.pendingApproval?.requestId).toBe("r-1");
    expect(State.subjectTask?.name).toBe("alpha");
  });

  it("is declined while paused, and nothing else changes", async () => {
    const { State, send, island } = await load();
    State.paused = true;
    send(permission("r-1", "Bash", { command: "x" }));

    expect(bridge.Bridge.approvalDecline).toHaveBeenCalledExactlyOnceWith("r-1");
    expect(bridge.Bridge.approvalAck).not.toHaveBeenCalled();
    expect(State.pendingApproval).toBeNull();
    expect(State.sessions).toEqual([]);
    expect(island.alert).not.toHaveBeenCalled();
  });
});

describe("session events", () => {
  it("UserPromptSubmit reads `prompt` (not `message`) and starts thinking", async () => {
    const { send, only } = await load();
    send({ hook_event_name: "UserPromptSubmit", cwd: CWD, prompt: "p".repeat(100), message: "ignored" });
    expect(only().state).toBe("thinking");
    expect(only().steps).toEqual(["p".repeat(60)]);
  });

  it("UserPromptSubmit still shows a `message` when there is no prompt", async () => {
    const { send, only } = await load();
    send({ hook_event_name: "UserPromptSubmit", cwd: CWD, message: "from message" });
    expect(only().steps).toEqual(["from message"]);
  });

  it("names the session after the folder, with the macOS aliases, or `Session`", async () => {
    const { send, named } = await load();
    send({ hook_event_name: "SessionStart", session_id: "a", cwd: "/Users/me/notch-buddy/" });
    expect(named("Notch Buddy").cwd).toBe("/Users/me/notch-buddy/");
    send({ hook_event_name: "SessionStart", session_id: "b", cwd: "" });
    expect(named("Session").cwd).toBe("");
  });

  it("keeps the folder it was first seen in, even if a later event says otherwise", async () => {
    const { send, only } = await load();
    send(from("a", "alpha", { hook_event_name: "SessionStart" }));
    send({ ...work("a", "alpha", "cd src"), cwd: String.raw`C:\Users\dev\projects\alpha\src` });
    expect(only()).toMatchObject({ name: "alpha", cwd: String.raw`C:\Users\dev\projects\alpha` });
  });

  it("PostToolUse keeps working; PostToolUseFailure records the failure", async () => {
    const { send, only } = await load();
    send({ hook_event_name: "PostToolUse", cwd: CWD });
    expect(only().state).toBe("working");
    expect(only().steps).toEqual([]);
    send({ hook_event_name: "PostToolUseFailure", cwd: CWD });
    expect(only().steps).toEqual(["⚠ failed"]);
  });

  it("Stop opens the finished card about that session, then goes idle; the session stays", async () => {
    const { State, send, only, island, Sound } = await load();
    send({ hook_event_name: "Stop", cwd: CWD, message: "All done" });

    expect(only().state).toBe("finished");
    expect(only().steps.at(-1)).toBe("All done");
    expect(island.alert).toHaveBeenCalledExactlyOnceWith("finished");
    expect(State.alertTask).toBe(only());
    expect(Sound.play).toHaveBeenCalledWith("finish");

    vi.advanceTimersByTime(5200);
    expect(only()).toMatchObject({ state: "idle", pillBadge: null });
  });

  it("Stop does not reset a session that has already moved on", async () => {
    const { send, only } = await load();
    send({ hook_event_name: "Stop", cwd: CWD });
    vi.advanceTimersByTime(2000);
    send({ hook_event_name: "UserPromptSubmit", cwd: CWD, prompt: "next" });
    vi.advanceTimersByTime(3200);
    expect(only().state).toBe("thinking");
  });

  it("the finished card names the session that finished, not the one leading", async () => {
    const { State, send, named } = await load();
    send(work("a", "alpha", "one"));
    send(work("b", "beta", "two"));
    vi.advanceTimersByTime(3000);
    send(work("b", "beta", "three"));
    expect(State.focusTask).toBe(named("beta"));

    send(from("a", "alpha", { hook_event_name: "Stop" }));
    expect(State.view).toBe("finished");
    expect(State.subjectTask).toBe(named("alpha"));
    // Whatever the order does meanwhile, the card stays about alpha.
    vi.advanceTimersByTime(3000);
    send(work("b", "beta", "four"));
    expect(State.subjectTask).toBe(named("alpha"));
  });

  it("a second Stop while a finished card is up badges instead of replacing it", async () => {
    const { State, send, named, island } = await load();
    send(from("a", "alpha", { hook_event_name: "Stop" }));
    send(from("b", "beta", { hook_event_name: "Stop" }));
    expect(island.alert).toHaveBeenCalledOnce();
    expect(State.subjectTask).toBe(named("alpha"));
    expect(named("beta").pillBadge).toBe("finished");
  });

  it("Stop never covers a pending approval card", async () => {
    const { State, send, named, island } = await load();
    send(permission("r-1", "Bash", { command: "rm x" }, from("a", "alpha")));
    send(from("b", "beta", { hook_event_name: "Stop" }));
    expect(State.view).toBe("approval");
    expect(island.setView).not.toHaveBeenCalled();
    expect(named("beta").pillBadge).toBe("finished");
  });

  it("Stop only badges the session when an integration is on the left card", async () => {
    const { State, send, only, island } = await load();
    State.settings.activeIntegrations = ["integration_vercel"];
    State.loadIntegrationTasks();
    State.select("integration_vercel");
    send({ hook_event_name: "Stop", cwd: CWD });
    expect(island.alert).not.toHaveBeenCalled();
    expect(only().pillBadge).toBe("finished");
  });

  it("StopFailure is an error, shown on its card", async () => {
    const { State, send, only, island } = await load();
    send({ hook_event_name: "StopFailure", cwd: CWD });
    expect(only().state).toBe("error");
    expect(island.alert).toHaveBeenCalledExactlyOnceWith("error");
    expect(State.subjectTask).toBe(only());
  });

  it("Notification: rate limits and questions change the state, the rest is ignored", async () => {
    const { send, only } = await load();
    send({ hook_event_name: "Notification", cwd: CWD, message: "Claude is waiting for your input" });
    expect(only().state).toBe("idle");
    send({ hook_event_name: "Notification", cwd: CWD, message: "Shall I continue?" });
    expect(only()).toMatchObject({ state: "question", steps: ["Shall I continue?"] });
    send({ hook_event_name: "Notification", cwd: CWD, message: "Rate limit reached" });
    expect(only().state).toBe("ratelimit");
  });

  it("subagents leave a trace in the steps", async () => {
    const { send, only } = await load();
    send({ hook_event_name: "SubagentStart", cwd: CWD });
    send({ hook_event_name: "SubagentStop", cwd: CWD });
    expect(only().steps).toEqual(["+ subagent", "• subagent done"]);
  });

  it("SessionEnd removes the session; its next event brings it back fresh", async () => {
    const { State, send } = await load();
    send({ hook_event_name: "UserPromptSubmit", cwd: CWD, prompt: "go" });
    send({ hook_event_name: "PreToolUse", cwd: CWD, tool_name: "Read", tool_input: { file_path: "/a/b.ts" } });
    send({ hook_event_name: "SessionEnd", cwd: CWD });
    expect(State.sessions).toEqual([]);
    expect(State.defaultView()).toBe("empty");

    send({ hook_event_name: "UserPromptSubmit", cwd: CWD, prompt: "again" });
    expect(State.sessions).toHaveLength(1);
    expect(State.sessions[0].steps).toEqual(["again"]);
  });

  it("a SessionEnd for a session never seen creates nothing", async () => {
    const { State, send } = await load();
    send(from("ghost", "ghost", { hook_event_name: "SessionEnd" }));
    expect(State.sessions).toEqual([]);
  });

  it("ignores unknown events and everything while paused", async () => {
    const { State, send } = await load();
    send({ hook_event_name: "SomethingNew", cwd: CWD });
    expect(State.sessions).toEqual([]);
    State.paused = true;
    send({ hook_event_name: "UserPromptSubmit", cwd: CWD, prompt: "hi" });
    expect(State.sessions).toEqual([]);
  });
});

describe("several sessions", () => {
  it("each keeps its own name, steps and state", async () => {
    const { send, named, names } = await load();
    send(work("a", "alpha", "npm test"));
    send(work("b", "beta", "cargo build"));
    send(work("a", "alpha", "npm run lint"));
    send(from("b", "beta", { hook_event_name: "UserPromptSubmit", prompt: "and now?" }));

    expect(names().sort()).toEqual(["alpha", "beta"]);
    expect(named("alpha")).toMatchObject({
      state: "working",
      steps: ["Ejecuta · npm test", "Ejecuta · npm run lint"],
    });
    expect(named("beta")).toMatchObject({ state: "thinking", steps: ["Ejecuta · cargo build", "and now?"] });
  });

  it("are told apart by session_id, even in the same folder", async () => {
    const { State, send } = await load();
    send(work("a", "shared", "one"));
    send(work("b", "shared", "two"));
    expect(State.sessions).toHaveLength(2);
    expect(new Set(State.sessions.map((s) => s.color)).size).toBe(2);
  });

  it("fall back to the folder when an event has no session_id", async () => {
    const { State, send } = await load();
    send({ hook_event_name: "PreToolUse", cwd: String.raw`C:\p\one`, tool_name: "Bash", tool_input: { command: "x" } });
    send({ hook_event_name: "PreToolUse", cwd: String.raw`C:\p\one`, tool_name: "Bash", tool_input: { command: "y" } });
    send({ hook_event_name: "PreToolUse", cwd: String.raw`C:\p\two`, tool_name: "Bash", tool_input: { command: "z" } });
    expect(State.sessions.map((s) => [s.name, s.steps.length]).sort()).toEqual([["one", 2], ["two", 1]]);
  });

  it("carry wsl_distro through, and null for a Windows session", async () => {
    const { send, named } = await load();
    send({ hook_event_name: "SessionStart", session_id: "w", cwd: "/home/me/struxto", wsl_distro: "Ubuntu-24.04" });
    send({ hook_event_name: "SessionStart", session_id: "x", cwd: String.raw`C:\p\panita`, wsl_distro: "" });
    send({ hook_event_name: "SessionStart", session_id: "y", cwd: String.raw`C:\p\hekta` });
    expect(named("struxto")).toMatchObject({ wslDistro: "Ubuntu-24.04", cwd: "/home/me/struxto" });
    expect(named("panita").wslDistro).toBeNull();
    expect(named("hekta").wslDistro).toBeNull();
  });
});

describe("Open", () => {
  async function three() {
    const ctx = await load();
    const { send } = ctx;
    send({ ...work("w", "struxto", "pytest"), cwd: "/home/me/struxto", wsl_distro: "Ubuntu" });
    vi.advanceTimersByTime(2_500);
    send(work("p", "panita", "npm test"));
    vi.advanceTimersByTime(2_500);
    send(work("h", "hekta", "make"));
    vi.advanceTimersByTime(2_500);
    // Most recent first: hekta, then panita, then struxto.
    expect(ctx.names()).toEqual(["hekta", "panita", "struxto"]);
    return ctx;
  }

  it("↗ on the left card opens the primary session", async () => {
    const { open } = await three();
    open.openPrimary();
    expect(bridge.Bridge.openSession).toHaveBeenCalledExactlyOnceWith(String.raw`C:\Users\dev\projects\hekta`, null, "h");
  });

  it("↗ on the right card opens the second session", async () => {
    const { open } = await three();
    open.openSecond();
    expect(bridge.Bridge.openSession).toHaveBeenCalledExactlyOnceWith(String.raw`C:\Users\dev\projects\panita`, null, "p");
  });

  it("a WSL session is opened with its distro", async () => {
    const { State, open } = await three();
    State.select(State.sessions.find((s) => s.name === "struxto")!.id);
    open.openPrimary();
    expect(bridge.Bridge.openSession).toHaveBeenCalledExactlyOnceWith("/home/me/struxto", "Ubuntu", "w");
  });

  it("Open terminal on the finished card opens the session that finished", async () => {
    const { send, open } = await three();
    send({ ...from("w", "struxto", { hook_event_name: "Stop" }), cwd: "/home/me/struxto", wsl_distro: "Ubuntu" });
    open.openSubject();
    expect(bridge.Bridge.openSession).toHaveBeenCalledExactlyOnceWith("/home/me/struxto", "Ubuntu", "w");
  });

  it("a session known only by its folder is opened without a session id", async () => {
    const { send, open } = await load();
    send({ hook_event_name: "PreToolUse", cwd: String.raw`C:\p\one`, tool_name: "Bash", tool_input: { command: "x" } });
    open.openPrimary();
    // The app finds no terminal to show and goes straight to the window.
    expect(bridge.Bridge.openSession).toHaveBeenCalledExactlyOnceWith(String.raw`C:\p\one`, null, null);
  });

  it("an integration on the left card still opens its own page", async () => {
    const { State, open } = await three();
    State.settings.activeIntegrations = ["integration_vercel", "integration_n8n"];
    State.loadIntegrationTasks();
    State.select("integration_vercel");
    open.openPrimary();
    expect(bridge.Bridge.openUrl).toHaveBeenCalledExactlyOnceWith("https://vercel.com/dashboard");
    State.select("integration_n8n");
    open.openPrimary();
    expect(bridge.Bridge.openN8n).toHaveBeenCalledOnce();
    expect(bridge.Bridge.openSession).not.toHaveBeenCalled();
  });
});
