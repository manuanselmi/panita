// App state — mirror of AppState.swift (the parts the island needs).

import { PANITA_SLOTS, type BotEmoteName, type BotStateName, type IslandMode, type IslandViewName } from "./layout";
import type { EyeShape } from "../mochi/engine";
import type { Explanation } from "./explain";
import {
  SESSION_DWELL_MS, SESSION_EXPIRY_MS, orderSessions, pickOrdinal, pickSessionColor, sameOrder,
} from "./sessions";

export type AgentSource = "claudeCode" | "n8n";
export type PillBadge = "approval" | "finished" | "error";

export interface AgentTask {
  id: string;
  name: string;
  color: string;
  state: BotStateName;
  stepIndex: number;
  /** The last 20 steps. */
  steps: string[];
  /**
   * Steps ever appended. `steps` stops growing at 20, so its length cannot tell
   * the ticker that a new step arrived; this count can.
   */
  stepTotal: number;
  source: AgentSource;
  isIntegration: boolean;
  emote?: BotEmoteName | null;
  miniEye?: EyeShape | null;
  pillBadge?: PillBadge | null;
}

/** One Claude Code session (see sessions.ts). */
export interface SessionTask extends AgentTask {
  kind: "session";
  /** The payload's `session_id` ("" when the session is keyed by its folder). */
  sessionId: string;
  /**
   * The folder the session was first seen in. Kept, not followed: a `cd` inside
   * a Bash call would otherwise rename the session and move its "Open".
   */
  cwd: string;
  /** The WSL distribution the session runs in; null for a Windows session. */
  wslDistro: string | null;
  /** Last hook event or click — what the order follows. */
  lastActivity: number;
  /** Last hook event only — what the expiry follows. A click does not prove the session is alive. */
  lastEventAt: number;
  /**
   * Its number among the live sessions of the same name, for its whole life:
   * 1 is shown bare, 2 and up as "name 2" (see pickOrdinal in sessions.ts).
   */
  ordinal: number;
  /** The first prompt the island saw from it, one line, ~80 characters (its tooltip). */
  firstPrompt: string | null;
}

export const isSession = (t: AgentTask | null | undefined): t is SessionTask =>
  !!t && (t as SessionTask).kind === "session";

/** What a new hook event says about its session. */
export interface SessionEvent {
  key: string;
  sessionId: string;
  cwd: string;
  name: string;
  wslDistro: string | null;
}

export interface ApprovalInfo {
  requestId: string;
  sessionId: string;
  tool: string;
  command: string;
  /** The session asking. Held, not looked up: it may end while its card is up. */
  session: SessionTask;
  /**
   * What the command does, in a line of Spanish (src/core/explain.ts), or null
   * when nothing in it is known. Shown at once; replaced when the git branch it
   * mentions arrives.
   */
  explanation?: Explanation | null;
}

export interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
}

export type PromptContext =
  | { kind: "window"; appName: string; title: string; url?: string }
  | { kind: "file"; name: string; path?: string };

export interface ResultItem {
  label: string;
  detail: string;
  url?: string;
}

export interface SearchResult {
  title: string;
  items: ResultItem[];
  note?: string;
}

const task = (
  id: string, name: string, color: string, source: AgentSource,
): AgentTask => ({
  id, name, color, state: "idle", stepIndex: 0, steps: [], stepTotal: 0, source, isIntegration: true,
});

/**
 * AgentTask.integrationAgents — same ids, names and colours as macOS, minus the
 * always-on "VS Code" pill (`integration_claude`): every Claude Code session is
 * a task of its own now (State.sessions).
 */
export const INTEGRATION_AGENTS: AgentTask[] = [
  task("integration_resend", "Resend", "#22C55E", "n8n"),
  task("integration_n8n", "n8n", "#F29B38", "n8n"),
  task("integration_vercel", "Vercel", "#7C5CFF", "n8n"),
  task("integration_github", "GitHub", "#F4505E", "n8n"),
  task("integration_notion", "Notion", "#8C8C8C", "n8n"),
  task("integration_calcom", "Cal.com", "#C9956A", "n8n"),
  task("integration_stripe", "Stripe", "#0570DE", "n8n"),
];

export const TOGGLEABLE_INTEGRATION_IDS = [
  "integration_resend", "integration_n8n", "integration_vercel", "integration_github",
  "integration_notion", "integration_calcom", "integration_stripe",
];

/** What an integration poller last reported. */
export interface IntegrationInfo {
  data: Record<string, unknown>;
  error: string | null;
  loaded: boolean;
  configured: boolean;
}

export interface Settings {
  soundEnabled: boolean;
  soundVolume: number;
  autoCloseInterval: number;
  absenceInterval: number;
  activeIntegrations: string[];
  screen: "primary" | "cursor";
  autostart: boolean;
  hooksInstalled: boolean;
  /** Claude model used by the chat. */
  model: string;
}

export const DEFAULT_SETTINGS: Settings = {
  soundEnabled: true,
  soundVolume: 0.12,
  autoCloseInterval: 15,
  absenceInterval: 180,
  // None by default: the island is about Claude Code sessions. Any of them can
  // still be switched on in Settings → Integrations; they then show as extra
  // panitas after the sessions. (The upstream default was Resend, n8n, Vercel
  // and GitHub.) NOTE: on a fresh install with no settings.json, Rust's
  // Settings::default() (src-tauri/src/settings.rs) is what boot() hands over,
  // and it still lists those four — it has to change there too.
  activeIntegrations: [],
  screen: "primary",
  autostart: false,
  hooksInstalled: false,
  model: "claude-opus-5",
};

type Listener = () => void;

class AppState {
  mode: IslandMode = "hidden";
  view: IslandViewName = "overview";

  /**
   * Claude Code sessions in display order: [0] is the primary (left card), the
   * rest are panitas on the right card. Reordered by reorderSessions() only.
   */
  sessions: SessionTask[] = [];
  /** The opt-in integrations (Settings → Integrations), in their declared order. */
  tasks: AgentTask[] = [];
  /**
   * An integration the user clicked to look at. It holds the left card until
   * another panita is clicked or a session asks for approval; null means the
   * sessions lead.
   */
  focusId: string | null = null;
  /** The session the finished / error card is about. Held for the same reason as ApprovalInfo.session. */
  alertTask: SessionTask | null = null;

  stateOverride: BotStateName | null = null;

  /** Cursor in logical screen pixels, origin top-left (like AppState.mousePosition). */
  mouse = { x: 0, y: 0 };
  /** Cursor relative to the island's top-left corner. */
  mouseInIsland = { x: 0, y: 0 };
  /** The cursor is over the island (with the hit margin). */
  pointerOnIsland = false;

  isPinned = false;
  paused = false;

  uploadProgress = 0;
  uploadDuration = 2.4;
  fileDragOver = false;

  promptContext: PromptContext | null = null;
  droppedFile: { name: string; path: string } | null = null;
  noteMessage: string | null = null;
  searchResult: SearchResult | null = null;
  chatHistory: ChatMessage[] = [];
  pendingApproval: ApprovalInfo | null = null;

  integrations: Record<string, IntegrationInfo> = {};

  lastActivity = performance.now();

  settings: Settings = { ...DEFAULT_SETTINGS };

  private listeners = new Set<Listener>();
  private lastReorderAt = Number.NEGATIVE_INFINITY;
  private reorderTimer: number | null = null;
  private expiryTimer: number | null = null;

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Marks the UI dirty; the island re-renders on the next frame. */
  notify() {
    for (const fn of this.listeners) fn();
  }

  // ── Who goes where ──────────────────────────────────────────────────────────

  /** The left card: an integration the user clicked, else the first session, else the first integration. */
  get focusTask(): AgentTask | null {
    const picked = this.focusId ? this.tasks.find((t) => t.id === this.focusId) : undefined;
    return picked ?? this.sessions[0] ?? this.tasks[0] ?? null;
  }

  /**
   * The first session that is not on the left card. The right card no longer
   * singles it out — every other session is a panita now — and nothing in this
   * branch reads it. It stays only for `openSecond` in src/island/open.ts, a
   * file another branch is changing at the same time; remove both together
   * once that lands.
   */
  get secondSession(): SessionTask | null {
    const focus = this.focusTask;
    return this.sessions.find((s) => s !== focus) ?? null;
  }

  /**
   * Everyone but the left card, sessions first (in display order), then
   * integrations: the right card's panitas and the compact island's grid.
   */
  get panitas(): AgentTask[] {
    const focus = this.focusTask;
    return this.allTasks.filter((t) => t !== focus);
  }

  /**
   * The panitas that fit in `slots`, and how many are left for the "+N". The
   * "+N" takes the last slot, so past `slots` one fewer panita is drawn.
   */
  panitaSlots(slots = PANITA_SLOTS): { shown: AgentTask[]; more: number } {
    const all = this.panitas;
    if (all.length <= slots) return { shown: all, more: 0 };
    const shown = all.slice(0, Math.max(0, slots - 1));
    return { shown, more: all.length - shown.length };
  }

  /** Sessions and integrations alike: whatever may have a mini Mochi on screen. */
  get allTasks(): AgentTask[] {
    return [...this.sessions, ...this.tasks];
  }

  /**
   * What the view on screen is about: the asking session on the approval card,
   * the finished (or failed) one on its card, the left card otherwise. Those
   * cards name their own session, which need not be the left card's — it may
   * even have ended while its card is up.
   */
  get subjectTask(): AgentTask | null {
    if (this.view === "approval" && this.pendingApproval) return this.pendingApproval.session;
    if ((this.view === "finished" || this.view === "error") && this.alertTask) return this.alertTask;
    return this.focusTask;
  }

  get effectiveState(): BotStateName {
    return this.stateOverride ?? this.subjectTask?.state ?? "idle";
  }

  findTask(id: string): AgentTask | null {
    return this.allTasks.find((t) => t.id === id) ?? null;
  }

  /**
   * A click on a panita: it takes the left card. A session moves to the front
   * at once — the click counts as activity and skips the dwell; an integration
   * is held there (focusId) until another click.
   */
  select(id: string, now = Date.now()) {
    const session = this.sessions.find((s) => s.id === id);
    if (session) {
      this.focusId = null;
      session.pillBadge = null;
      session.lastActivity = now;
      this.reorderSessions(now, true);
    } else {
      const t = this.tasks.find((x) => x.id === id);
      if (!t) return;
      this.focusId = id;
      t.pillBadge = null;
    }
    this.notify();
  }

  updateTask(id: string, state: BotStateName) {
    const t = this.findTask(id);
    if (!t) return;
    t.state = state;
    this.notify();
  }

  appendStep(id: string, step: string) {
    const t = this.findTask(id);
    if (!t) return;
    t.steps.push(step);
    if (t.steps.length > 20) t.steps.shift();
    t.stepIndex = t.steps.length - 1;
    t.stepTotal += 1;
    this.notify();
  }

  setPillBadge(id: string, badge: PillBadge | null) {
    const t = this.findTask(id);
    if (!t) return;
    t.pillBadge = badge;
    this.notify();
  }

  // ── Sessions ────────────────────────────────────────────────────────────────

  /**
   * A hook event from a session: creates the session on its first event, stamps
   * its activity, and lets the order follow (subject to the dwell).
   */
  sessionEvent(ev: SessionEvent, now = Date.now()): SessionTask {
    this.expireSessions(now);
    let s = this.sessions.find((x) => x.id === ev.key);
    if (!s) {
      s = {
        kind: "session",
        id: ev.key,
        sessionId: ev.sessionId,
        name: ev.name,
        cwd: ev.cwd,
        wslDistro: ev.wslDistro,
        color: pickSessionColor(ev.name, this.sessions.map((x) => x.color)),
        state: "idle",
        stepIndex: 0,
        steps: [],
        stepTotal: 0,
        source: "claudeCode",
        isIntegration: false,
        lastActivity: now,
        lastEventAt: now,
        ordinal: pickOrdinal(ev.name, this.sessions),
        firstPrompt: null,
      };
      // It joins at the back; reorderSessions brings it forward as soon as the
      // dwell allows, which is at once unless the order just changed.
      this.sessions.push(s);
    } else {
      if (!s.cwd && ev.cwd) {
        // Named after its folder at last: a new name may need a number of its own.
        const others = this.sessions.filter((x) => x !== s);
        s.cwd = ev.cwd;
        s.name = ev.name;
        s.ordinal = pickOrdinal(ev.name, others);
      }
      if (ev.wslDistro) s.wslDistro = ev.wslDistro;
    }
    s.lastActivity = now;
    s.lastEventAt = now;
    this.reorderSessions(now);
    this.armExpiry(now);
    return s;
  }

  /** SessionEnd: the session leaves the island. Its cards, if up, keep their own copy. */
  removeSession(id: string, now = Date.now()) {
    const before = this.sessions.length;
    this.sessions = this.sessions.filter((s) => s.id !== id);
    if (this.sessions.length === before) return;
    this.armExpiry(now);
    this.reorderSessions(now);
    this.notify();
  }

  /** Drops every session without a hook event for SESSION_EXPIRY_MS. */
  expireSessions(now = Date.now()) {
    const alive = this.sessions.filter((s) => now - s.lastEventAt < SESSION_EXPIRY_MS);
    if (alive.length === this.sessions.length) return;
    this.sessions = alive;
    this.armExpiry(now);
    this.notify();
  }

  /**
   * One timer, set for the next session due to expire, rather than a periodic
   * sweep: the island must cost nothing while hidden, and this wakes it at most
   * once per expiring session. Hook events re-arm it.
   */
  private armExpiry(now: number) {
    if (this.expiryTimer != null) window.clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    if (this.sessions.length === 0) return;
    const due = Math.min(...this.sessions.map((s) => s.lastEventAt)) + SESSION_EXPIRY_MS;
    this.expiryTimer = window.setTimeout(() => {
      this.expiryTimer = null;
      this.expireSessions();
    }, Math.max(1_000, due - now));
  }

  /**
   * Puts the sessions in order: the one waiting on an approval card first, then
   * the most recent activity first — but no more often than every
   * SESSION_DWELL_MS (see there for why), and not while the pointer is on the
   * open island, so a panita never slides away from under a click. A change that
   * has to wait is retried when the dwell runs out, or when the pointer leaves.
   * `force` skips both: an approval and a click are the user's business, and
   * show at once.
   */
  reorderSessions(now = Date.now(), force = false) {
    const desired = orderSessions(this.sessions, this.pendingApproval?.session.id ?? null);
    const same = sameOrder(desired, this.sessions);
    if (force) {
      this.clearReorderTimer();
      if (!same) {
        this.sessions = desired;
        this.notify();
      }
      // Restarts the dwell even when nothing moved: a click on the session that
      // already leads still earns it its two seconds.
      this.lastReorderAt = now;
      return;
    }
    if (same) {
      this.clearReorderTimer();
      return;
    }
    const frozen = this.mode === "expanded" && this.pointerOnIsland;
    const wait = this.lastReorderAt + SESSION_DWELL_MS - now;
    if (!frozen && wait <= 0) {
      this.clearReorderTimer();
      this.sessions = desired;
      this.lastReorderAt = now;
      this.notify();
      return;
    }
    if (frozen) {
      // No timer: setPointerOnIsland(false), or the island closing, retries.
      this.clearReorderTimer();
      return;
    }
    if (this.reorderTimer == null) {
      this.reorderTimer = window.setTimeout(() => {
        this.reorderTimer = null;
        this.reorderSessions();
      }, wait);
    }
  }

  private clearReorderTimer() {
    if (this.reorderTimer != null) window.clearTimeout(this.reorderTimer);
    this.reorderTimer = null;
  }

  /** From the island's cursor poll. The order may move again once the pointer leaves. */
  setPointerOnIsland(on: boolean) {
    if (this.pointerOnIsland === on) return;
    this.pointerOnIsland = on;
    if (!on) this.reorderSessions();
  }

  // ── Integrations ────────────────────────────────────────────────────────────

  /** loadIntegrationTasks() — the opt-in integrations (max 4), in their declared order. */
  loadIntegrationTasks() {
    for (const proto of INTEGRATION_AGENTS) {
      const shouldLoad = this.settings.activeIntegrations.includes(proto.id);
      const idx = this.tasks.findIndex((t) => t.id === proto.id);
      if (shouldLoad && idx < 0) this.tasks.push({ ...proto, steps: [] });
      if (!shouldLoad && idx >= 0) this.tasks.splice(idx, 1);
    }
    // Keep the declared order so panitas never shuffle.
    const order = INTEGRATION_AGENTS.map((t) => t.id);
    this.tasks.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    if (this.focusId && !this.tasks.some((t) => t.id === this.focusId)) this.focusId = null;
    this.notify();
  }

  toggleIntegration(id: string) {
    if (!TOGGLEABLE_INTEGRATION_IDS.includes(id)) return;
    const active = this.settings.activeIntegrations;
    if (active.includes(id)) {
      this.settings.activeIntegrations = active.filter((x) => x !== id);
    } else {
      if (active.length >= 4) return;
      this.settings.activeIntegrations = [...active, id];
    }
    this.loadIntegrationTasks();
  }

  defaultView(): IslandViewName {
    return this.sessions.length === 0 && this.tasks.length === 0 ? "empty" : "overview";
  }
}

export const State = new AppState();
