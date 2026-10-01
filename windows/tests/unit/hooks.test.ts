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

const CLAUDE = "integration_claude";

type Payload = Record<string, unknown>;

async function load() {
  vi.resetModules();
  bridge.handlers.clear();
  const { State } = await import("../../src/core/state");
  const { Sound } = await import("../../src/core/sound");
  const { registerHookHandlers } = await import("../../src/island/hooks");

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
  const claude = () => {
    const task = State.tasks.find((t) => t.id === CLAUDE);
    if (!task) throw new Error("no Claude Code task");
    return task;
  };
  return { State, Sound, island, send, claude };
}

const CWD = String.raw`C:\Users\dev\projects\my-app`;

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
  // hooks.ts schedules through `window.setTimeout`.
  vi.stubGlobal("window", globalThis);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("step labels (PreToolUse)", () => {
  const cases: [string, Payload, string][] = [
    ["Bash", { command: "npm test" }, "Exécute · npm test"],
    ["PowerShell", { command: "Get-ChildItem" }, "Exécute · Get-ChildItem"],
    ["Bash", { command: "x".repeat(80) }, `Exécute · ${"x".repeat(40)}`],
    ["Read", { file_path: String.raw`C:\repo\src\main.ts` }, "Lit · main.ts"],
    ["Write", { file_path: "/home/me/notes.md", content: "…" }, "Écrit · notes.md"],
    ["LS", { path: "C:/repo/src/" }, "Liste · src"],
    ["WebSearch", { query: "tauri single instance" }, "Recherche web · tauri single instance"],
    // Grep's `pattern` is not one of the fields a step shows.
    ["Grep", { pattern: "TODO" }, "Recherche"],
    ["mcp__linear__get_issue", { id: "ABC-1" }, "mcp__linear__get_issue"],
  ];

  it.each(cases)("%s %j → %s", async (tool, input, label) => {
    const { send, claude } = await load();
    send({ hook_event_name: "PreToolUse", cwd: CWD, tool_name: tool, tool_input: input });
    expect(claude().steps.at(-1)).toBe(label);
  });

  it("falls back to `Tool` when the event names no tool", async () => {
    const { send, claude } = await load();
    send({ hook_event_name: "PreToolUse", cwd: CWD });
    expect(claude().steps).toEqual(["Tool"]);
  });

  it("marks the session as working, names it after the folder, and reveals the island", async () => {
    const { State, send, claude, island } = await load();
    send({ hook_event_name: "PreToolUse", cwd: CWD, tool_name: "Bash", tool_input: { command: "ls" } });
    expect(claude()).toMatchObject({ state: "working", name: "my-app", sessionCwd: CWD, stepIndex: 0 });
    expect(island.reveal).toHaveBeenCalledOnce();
    expect(island.alert).not.toHaveBeenCalled();
    expect(State.mode).toBe("compact");
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
    const { State, Sound, send, claude, island } = await load();
    send(permission("42-1", "Bash", { command: "git push" }));

    expect(bridge.Bridge.approvalAck).toHaveBeenCalledExactlyOnceWith("42-1");
    expect(bridge.Bridge.approvalDecline).not.toHaveBeenCalled();
    expect(State.pendingApproval).toEqual({
      requestId: "42-1",
      sessionId: "session-1",
      tool: "Bash",
      command: "Bash · git push",
    });
    expect(State.isPinned).toBe(true);
    expect(claude().state).toBe("approval");
    expect(island.alert).toHaveBeenCalledExactlyOnceWith("approval");
    expect(State.view).toBe("approval");
    expect(Sound.play).toHaveBeenCalledWith("approval");
  });

  it("badges the pill instead of stealing the view when another agent is focused", async () => {
    const { State, send, claude, island } = await load();
    State.setFocus("integration_github");
    send(permission("42-1", "Bash", { command: "git push" }));

    expect(island.alert).not.toHaveBeenCalled();
    expect(island.reveal).toHaveBeenCalled();
    expect(claude().pillBadge).toBe("approval");
    // Still acked: the badge is on screen and a human can act on it.
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

  it("drops the card after 110 s, when the relay has given up", async () => {
    const { State, send, claude, island } = await load();
    send(permission("r-1", "Bash", { command: "sleep" }));

    vi.advanceTimersByTime(109_999);
    expect(State.pendingApproval).not.toBeNull();

    vi.advanceTimersByTime(1);
    expect(State.pendingApproval).toBeNull();
    expect(State.isPinned).toBe(false);
    expect(island.dropPin).toHaveBeenCalledOnce();
    expect(claude()).toMatchObject({ state: "working", pillBadge: null });
    expect(island.setView).toHaveBeenCalledWith("overview");
  });

  it("is declined while paused, and nothing else changes", async () => {
    const { State, send, claude, island } = await load();
    State.paused = true;
    send(permission("r-1", "Bash", { command: "x" }));

    expect(bridge.Bridge.approvalDecline).toHaveBeenCalledExactlyOnceWith("r-1");
    expect(bridge.Bridge.approvalAck).not.toHaveBeenCalled();
    expect(State.pendingApproval).toBeNull();
    expect(claude().state).toBe("idle");
    expect(island.alert).not.toHaveBeenCalled();
  });
});

describe("session events", () => {
  it("UserPromptSubmit reads `prompt` (not `message`) and starts thinking", async () => {
    const { send, claude } = await load();
    send({ hook_event_name: "UserPromptSubmit", cwd: CWD, prompt: "p".repeat(100), message: "ignored" });
    expect(claude().state).toBe("thinking");
    expect(claude().steps).toEqual(["p".repeat(60)]);
  });

  it("UserPromptSubmit still shows a `message` when there is no prompt", async () => {
    const { send, claude } = await load();
    send({ hook_event_name: "UserPromptSubmit", cwd: CWD, message: "from message" });
    expect(claude().steps).toEqual(["from message"]);
  });

  it("names the session after the folder, with the macOS aliases, or `Session`", async () => {
    const { send, claude } = await load();
    send({ hook_event_name: "SessionStart", cwd: "/Users/me/notch-buddy/" });
    expect(claude().name).toBe("Notch Buddy");
    send({ hook_event_name: "SessionStart", cwd: "" });
    expect(claude().name).toBe("Session");
  });

  it("PostToolUse keeps working; PostToolUseFailure records the failure", async () => {
    const { send, claude } = await load();
    send({ hook_event_name: "PostToolUse", cwd: CWD });
    expect(claude().state).toBe("working");
    expect(claude().steps).toEqual([]);
    send({ hook_event_name: "PostToolUseFailure", cwd: CWD });
    expect(claude().steps).toEqual(["⚠ failed"]);
  });

  it("Stop opens the finished card when Claude is focused, then goes idle", async () => {
    const { send, claude, island, Sound } = await load();
    send({ hook_event_name: "Stop", cwd: CWD, message: "All done" });

    expect(claude().state).toBe("finished");
    expect(claude().steps.at(-1)).toBe("All done");
    expect(island.alert).toHaveBeenCalledExactlyOnceWith("finished");
    expect(Sound.play).toHaveBeenCalledWith("finish");

    vi.advanceTimersByTime(5200);
    expect(claude()).toMatchObject({ state: "idle", pillBadge: null });
  });

  it("Stop only badges the pill when another agent is focused", async () => {
    const { State, send, claude, island } = await load();
    State.setFocus("integration_vercel");
    send({ hook_event_name: "Stop", cwd: CWD });
    expect(island.alert).not.toHaveBeenCalled();
    expect(claude().pillBadge).toBe("finished");
  });

  it("StopFailure is an error, shown when focused", async () => {
    const { send, claude, island } = await load();
    send({ hook_event_name: "StopFailure", cwd: CWD });
    expect(claude().state).toBe("error");
    expect(island.alert).toHaveBeenCalledExactlyOnceWith("error");
  });

  it("Notification: rate limits and questions change the state, the rest is ignored", async () => {
    const { send, claude } = await load();
    send({ hook_event_name: "Notification", cwd: CWD, message: "Claude is waiting for your input" });
    expect(claude().state).toBe("idle");
    send({ hook_event_name: "Notification", cwd: CWD, message: "Shall I continue?" });
    expect(claude()).toMatchObject({ state: "question", steps: ["Shall I continue?"] });
    send({ hook_event_name: "Notification", cwd: CWD, message: "Rate limit reached" });
    expect(claude().state).toBe("ratelimit");
  });

  it("subagents leave a trace in the steps", async () => {
    const { send, claude } = await load();
    send({ hook_event_name: "SubagentStart", cwd: CWD });
    send({ hook_event_name: "SubagentStop", cwd: CWD });
    expect(claude().steps).toEqual(["+ subagent", "• subagent done"]);
  });

  it("SessionEnd clears the session back to the bare VS Code pill", async () => {
    const { State, send, claude } = await load();
    send({ hook_event_name: "UserPromptSubmit", cwd: CWD, prompt: "go" });
    send({ hook_event_name: "PreToolUse", cwd: CWD, tool_name: "Read", tool_input: { file_path: "/a/b.ts" } });
    State.setPillBadge(CLAUDE, "finished");
    send({ hook_event_name: "SessionEnd", cwd: CWD });
    expect(claude()).toMatchObject({
      name: "VS Code",
      state: "idle",
      steps: [],
      stepIndex: 0,
      pillBadge: null,
    });
  });

  it("ignores unknown events and everything while paused", async () => {
    const { State, send, claude } = await load();
    send({ hook_event_name: "SomethingNew", cwd: CWD });
    expect(claude()).toMatchObject({ state: "idle", steps: [], name: "VS Code" });
    State.paused = true;
    send({ hook_event_name: "UserPromptSubmit", cwd: CWD, prompt: "hi" });
    expect(claude()).toMatchObject({ state: "idle", steps: [], name: "VS Code" });
  });
});
