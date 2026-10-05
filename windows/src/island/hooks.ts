// Claude Code hook events → island state.
// Port of HookServer.processEvent / processPermissionRequest from the macOS app.
// Difference from macOS: no terminal filter. On Windows the hook fires from any
// terminal (Windows Terminal, VS Code, PowerShell, WSL…) and all of them are
// handled — each Claude Code session as its own task (State.sessions).

import { Bridge, onEvent } from "../core/bridge";
import { explainTool, resolveFolder } from "../core/explain";
import { promptSummary, sessionKey } from "../core/sessions";
import { Sound } from "../core/sound";
import {
  ALERT_VIEWS, State, type ApprovalInfo, type AskedQuestion, type PillBadge, type SessionTask,
} from "../core/state";
import type { IslandViewName } from "../core/layout";
import type { Island } from "./island";

/** Clears the approval card if no decision was made before the hook gave up. */
let pendingTimeout: number | null = null;

interface HookPayload {
  hook_event_name?: string;
  request_id?: string;
  session_id?: string;
  cwd?: string;
  /** Set by the relay for a session running inside WSL; empty or absent on Windows. */
  wsl_distro?: string;
  message?: string;
  /** UserPromptSubmit carries `prompt`; `message` belongs to Notification/Stop. */
  prompt?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

/** The events this file handles. Anything else changes nothing — it does not even create a session. */
const HANDLED = new Set([
  "SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure",
  "Notification", "Stop", "StopFailure", "SessionEnd", "SubagentStart", "SubagentStop",
  "PermissionRequest",
]);

const PROJECT_ALIASES: Record<string, string> = {
  "notch-buddy": "Notch Buddy",
  notchbuddy: "Notch Buddy",
  notch_buddy: "Notch Buddy",
};

function aliasProjectName(name: string): string {
  return PROJECT_ALIASES[name.toLowerCase()] ?? name;
}

function lastPathComponent(p: string): string {
  const cleaned = p.replace(/[\\/]+$/, "");
  const idx = Math.max(cleaned.lastIndexOf("\\"), cleaned.lastIndexOf("/"));
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

/**
 * Step labels, in Spanish for this fork. The macOS app (frenchStep()) and the
 * upstream Windows port use French ("Exécute", "Lit"); the verbs are kept short
 * because the ticker row is narrow and the argument follows after " · ".
 */
const TOOL_LABELS: Record<string, string> = {
  Bash: "Ejecuta",
  Read: "Lee",
  Write: "Escribe",
  Edit: "Edita",
  Glob: "Busca archivos",
  Grep: "Busca texto",
  WebSearch: "Busca en la web",
  WebFetch: "Abre página",
  TodoWrite: "Tareas",
  Task: "Agente",
  LS: "Lista",
  MultiEdit: "Edita",
  NotebookEdit: "Notebook",
  PowerShell: "Ejecuta",
  AskUserQuestion: "Pregunta",
};

function stepLabel(tool: string, input: Record<string, unknown>): string {
  const label = TOOL_LABELS[tool] ?? tool;
  const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : null);
  const cmd = str("command");
  if (cmd) return `${label} · ${cmd.slice(0, 40)}`;
  const path = str("path");
  if (path) return `${label} · ${lastPathComponent(path)}`;
  const file = str("file_path");
  if (file) return `${label} · ${lastPathComponent(file)}`;
  const query = str("query");
  if (query) return `${label} · ${query.slice(0, 40)}`;
  const question = questionOf(tool, input);
  if (question) return `${label} · ${question.text.slice(0, 40)}`;
  return label;
}

/** The tool Claude Code asks the user a multiple-choice question with. */
const ASK_TOOL = "AskUserQuestion";

/**
 * What an AskUserQuestion call asks: its first question, that question's
 * option labels, and how many questions follow. Null for any other tool, or
 * an input without a question in it. The input is
 * `{ questions: [{ question, header, options: [{ label, description }], multiSelect }] }`.
 */
export function questionOf(tool: string, input: Record<string, unknown>): AskedQuestion | null {
  if (tool !== ASK_TOOL || !Array.isArray(input.questions)) return null;
  const questions = input.questions.filter(
    (q): q is { question: string; options?: unknown } =>
      !!q && typeof q === "object" && typeof (q as { question?: unknown }).question === "string" &&
      !!(q as { question: string }).question.trim(),
  );
  const first = questions[0];
  if (!first) return null;
  const options = (Array.isArray(first.options) ? first.options : [])
    .map((o) => (o && typeof o === "object" ? (o as { label?: unknown }).label : null))
    .filter((label): label is string => typeof label === "string" && !!label.trim())
    .map((label) => label.trim());
  return { text: first.question.trim(), options, more: questions.length - 1 };
}

/**
 * What the Allow button actually authorises. Approving "Write" tells you nothing
 * — approving `Write · C:\…\.env` tells you everything, and the difference is
 * the whole point of approving from the island rather than blind.
 *
 * Ordered by how specific the field is, so an unfamiliar tool still shows
 * whatever identifying string it carries instead of falling back to its name.
 */
const APPROVAL_FIELDS = [
  "command", // Bash, PowerShell
  "file_path", // Write, Edit, MultiEdit, NotebookEdit
  "path", // Read, LS
  "url", // WebFetch
  "query", // WebSearch
  "pattern", // Glob, Grep
  "prompt", // Task
] as const;

function approvalTarget(tool: string, input: Record<string, unknown>): string {
  for (const field of APPROVAL_FIELDS) {
    const value = input[field];
    if (typeof value === "string" && value.trim()) {
      return `${tool} · ${value.trim()}`;
    }
  }
  return tool;
}

/** What an event says about its session: which one it is, and where it runs. */
function describeSession(payload: HookPayload) {
  const cwd = payload.cwd ?? "";
  return {
    key: sessionKey(payload.session_id, cwd),
    sessionId: (payload.session_id ?? "").trim(),
    cwd,
    name: aliasProjectName(lastPathComponent(cwd) || "Session"),
    wslDistro: payload.wsl_distro?.trim() || null,
  };
}

export function registerHookHandlers(island: Island) {
  void onEvent<HookPayload>("hook", (payload) => handleHook(island, payload));
}

function handleHook(island: Island, payload: HookPayload) {
  if (State.paused) {
    // Silence here used to cost Claude Code nearly two minutes: the relay waited
    // for a decision from an island that had already decided not to look. Say so,
    // and the terminal takes the question immediately.
    if (payload.request_id) void Bridge.approvalDecline(payload.request_id);
    return;
  }

  const name = payload.hook_event_name ?? "";
  if (!HANDLED.has(name)) return;
  const event = describeSession(payload);
  const now = Date.now();

  /** Alerts force the island open; work events only reveal the compact island. */
  const surface = (view: IslandViewName, isAlert: boolean) => {
    if (State.mode === "expanded") {
      if (isAlert) island.setView(view);
    } else if (isAlert) {
      island.alert(view);
    } else if (State.mode === "hidden") {
      island.reveal();
    }
  };

  /**
   * Opens the finished / error card about `s`. It never covers an approval card
   * (that one is waiting for a click), another session's card that is still up
   * (its buttons may be under the pointer), or an integration the user chose to
   * look at: `s` gets a badge on its panita instead.
   */
  const alertAbout = (s: SessionTask, view: IslandViewName, badge: PillBadge) => {
    const otherCardUp =
      State.mode === "expanded" &&
      ALERT_VIEWS.has(State.view) &&
      State.alertTask != null &&
      State.alertTask !== s;
    if (State.pendingApproval || State.focusId || otherCardUp) {
      s.pillBadge = badge;
      return;
    }
    State.alertTask = s;
    s.pillBadge = null;
    surface(view, true);
  };

  if (name === "SessionEnd") {
    // Gone from the island at once. A card about it that is still up keeps its
    // own reference, so an approval stays answerable.
    State.removeSession(event.key, now);
    State.notify();
    return;
  }

  if (name === "PermissionRequest" && payload.tool_name === ASK_TOOL) {
    // AskUserQuestion is not a permission. Claude Code puts the question up in
    // the terminal while it asks the hook — the two race — and an "allow"
    // without the user's answers is not an answer: all the old approval card
    // could do was deny the question outright. So the request goes straight
    // back, nothing waits on the island, and the question card says what is
    // being asked, with a way to the terminal that has it.
    if (payload.request_id) void Bridge.approvalDecline(payload.request_id);
    const s = State.sessionEvent(event, now);
    s.state = "question";
    s.question = questionOf(ASK_TOOL, payload.tool_input ?? {});
    Sound.play("question");
    alertAbout(s, "question", "approval");
    State.notify();
    return;
  }

  if (name === "PermissionRequest") {
    handlePermission(island, payload, event, now);
    State.notify();
    return;
  }

  const s = State.sessionEvent(event, now);
  // A session that was asking in its terminal (a declined second request, see
  // handlePermission, or a question) has been answered once it does anything
  // but notify.
  if (s.pillBadge === "approval" && name !== "Notification") s.pillBadge = null;
  // Its question was answered in the terminal, or the turn moved past it: the
  // card about it has nothing left to say.
  if (s.question && questionSettled(name, payload)) {
    s.question = null;
    if (State.mode === "expanded" && State.view === "question" && State.alertTask === s) {
      island.setView(State.defaultView());
    }
  }

  switch (name) {
    case "SessionStart":
      surface("overview", false);
      Sound.play("work");
      break;

    case "UserPromptSubmit": {
      s.state = "thinking";
      // The field is `prompt`; reading `message` meant this step was always blank.
      const asked = payload.prompt ?? payload.message;
      if (asked) State.appendStep(s.id, asked.slice(0, 60));
      // What the session was started for: its panita's tooltip, to tell apart
      // sessions of the same project.
      if (asked?.trim() && !s.firstPrompt) s.firstPrompt = promptSummary(asked);
      surface("overview", false);
      break;
    }

    case "PreToolUse": {
      s.state = "working";
      const tool = payload.tool_name ?? "Tool";
      State.appendStep(s.id, stepLabel(tool, payload.tool_input ?? {}));
      surface("overview", false);
      break;
    }

    case "PostToolUse":
      s.state = "working";
      break;

    case "PostToolUseFailure":
      s.state = "working";
      State.appendStep(s.id, "⚠ failed");
      break;

    case "Notification": {
      const message = payload.message ?? "";
      const lower = message.toLowerCase();
      if (lower.includes("rate limit") || lower.includes("limite d")) {
        s.state = "ratelimit";
        Sound.play("rate");
      } else if (message.endsWith("?")) {
        s.state = "question";
        State.appendStep(s.id, message);
      }
      break;
    }

    case "Stop":
      // Finished, not gone: the session stays on the island until SessionEnd.
      s.state = "finished";
      if (payload.message) State.appendStep(s.id, payload.message.slice(0, 60));
      Sound.play("finish");
      alertAbout(s, "finished", "finished");
      window.setTimeout(() => {
        // Unless it has moved on since: a new prompt within five seconds is not idle.
        if (s.state === "finished") s.state = "idle";
        if (s.pillBadge === "finished") s.pillBadge = null;
        State.notify();
      }, 5200);
      break;

    case "StopFailure":
      s.state = "error";
      Sound.play("error");
      alertAbout(s, "error", "error");
      break;

    case "SubagentStart":
      State.appendStep(s.id, "+ subagent");
      break;

    case "SubagentStop":
      State.appendStep(s.id, "• subagent done");
      break;
  }
  State.notify();
}

/**
 * Whether event `name` means a session's pending question is behind it: the
 * AskUserQuestion call itself has finished (answered, or rejected with Esc), or
 * the turn has. Not just any tool finishing — a subagent of the same session
 * may keep working while the question waits.
 */
function questionSettled(name: string, payload: HookPayload): boolean {
  switch (name) {
    case "PostToolUse":
    case "PostToolUseFailure":
      return payload.tool_name === ASK_TOOL;
    case "UserPromptSubmit":
    case "Stop":
    case "StopFailure":
      return true;
    default:
      return false;
  }
}

/**
 * The user folded the island over a permission card. The request goes back to
 * the terminal — which has been asking too since it came in — so nothing is
 * left waiting on a card nobody can see, and the asking session's panita
 * keeps an amber badge until it moves on. False when no request was up.
 */
export function handBackApproval(): boolean {
  const req = State.pendingApproval;
  if (!req) return false;
  void Bridge.log(`fold: request ${req.requestId || "(no id)"} back to the terminal`);
  if (req.requestId) void Bridge.approvalDecline(req.requestId);
  if (pendingTimeout != null) {
    window.clearTimeout(pendingTimeout);
    pendingTimeout = null;
  }
  State.pendingApproval = null;
  State.isPinned = false;
  req.session.pillBadge = "approval";
  // No longer held first; the usual order (and its dwell) applies again.
  State.reorderSessions();
  State.notify();
  return true;
}

function handlePermission(
  island: Island,
  payload: HookPayload,
  event: ReturnType<typeof describeSession>,
  now: number,
) {
  const requestId = payload.request_id ?? "";
  // One card, one request. A second one must never quietly replace the first
  // — that would leave a human staring at request B while request A waits for
  // a decision nobody can give. Hand it straight back to the terminal.
  if (State.pendingApproval && State.pendingApproval.requestId !== requestId) {
    if (requestId) void Bridge.approvalDecline(requestId);
    // Then, purely for the eye — the answer above has already gone out: badge
    // the session now asking in its terminal, so it can be told apart from the
    // others. The badge goes with that session's next event.
    State.sessionEvent(event, now).pillBadge = "approval";
    return;
  }

  const s = State.sessionEvent(event, now);
  if (pendingTimeout != null) window.clearTimeout(pendingTimeout);
  const tool = payload.tool_name ?? "Tool";
  const input = payload.tool_input ?? {};
  const request: ApprovalInfo = {
    requestId,
    sessionId: payload.session_id ?? "",
    tool,
    command: approvalTarget(tool, input),
    session: s,
    // Pure text work, well under a millisecond: the card shows it from the start.
    explanation: explainTool(tool, input),
  };
  State.pendingApproval = request;
  // The relay's short ack window closes in 800 ms; everything below this
  // line is synchronous, so the card really is up by the time it lands.
  if (requestId) void Bridge.approvalAck(requestId);
  s.state = "approval";
  s.pillBadge = null;
  // The asking session takes the left card at once, past the dwell and past an
  // integration the user was looking at: the card in front of them is about it.
  State.focusId = null;
  State.reorderSessions(now, true);
  State.isPinned = true;
  Sound.play("approval");
  island.alert("approval");
  // The card is up and acknowledged; only now ask git which branch a
  // "Commit en la rama actual" means.
  void fillBranches(request, input, event.cwd, event.wslDistro);

  // Coucou answers within 108 s or not at all; after that the terminal has
  // taken over and the card would be lying.
  armApprovalTimeout(island);
}

/**
 * Completes an explanation that names "la rama actual": asks the app for the
 * branch of each folder it mentions — the session's own (the payload's `cwd`,
 * which follows Claude Code's `cd`s), or one a `cd` in the command moves to —
 * and redraws the card with the names. Answers that arrive after the card has
 * gone, or for another card, are dropped; one that never comes, or a folder
 * that is not a repository, leaves "la rama actual".
 */
async function fillBranches(
  request: ApprovalInfo,
  input: Record<string, unknown>,
  cwd: string,
  wslDistro: string | null,
) {
  const dirs = request.explanation?.branchDirs ?? [];
  if (dirs.length === 0) return;
  const branches = new Map<string, string>();
  await Promise.all(
    dirs.map(async (key) => {
      const folder = resolveFolder(cwd, key, wslDistro != null);
      if (!folder) return;
      try {
        const branch = await Bridge.gitBranch(folder, wslDistro);
        if (branch) branches.set(key, branch);
      } catch {
        // No branch: the line keeps "la rama actual".
      }
    }),
  );
  if (branches.size === 0 || State.pendingApproval !== request) return;
  request.explanation = explainTool(request.tool, input, branches);
  State.notify();
}

function armApprovalTimeout(island: Island) {
  pendingTimeout = window.setTimeout(() => {
    pendingTimeout = null;
    const req = State.pendingApproval;
    if (!req) return;
    State.pendingApproval = null;
    State.isPinned = false;
    island.dropPin();
    if (req.session.state === "approval") req.session.state = "working";
    // No longer held first; the usual order (and its dwell) applies again.
    State.reorderSessions();
    if (State.view === "approval") island.setView(State.defaultView());
    State.notify();
  }, 110_000);
}

