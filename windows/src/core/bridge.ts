// Thin wrapper over the Tauri commands/events. Every call is a no-op when the
// page is opened in a plain browser, so the island can be iterated on with
// `npm run dev` alone.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { Settings } from "./state";

export const IS_TAURI =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!IS_TAURI) return null;
  try {
    return await invoke<T>(cmd, args);
  } catch (err) {
    console.error(`[coucou] ${cmd} failed`, err);
    return null;
  }
}

export interface BootInfo {
  settings: Settings;
  /** Logical screen rect of the monitor the island lives on. */
  screen: { x: number; y: number; width: number; height: number; scale: number };
  version: string;
  hookPath: string;
}

export const Bridge = {
  boot: () => call<BootInfo>("boot"),

  saveSettings: (settings: Settings) => call<void>("save_settings", { settings }),

  /** Shrink the window down to the invisible wake strip (hidden) or back to full. */
  setCollapsed: (collapsed: boolean) => call<void>("set_collapsed", { collapsed }),

  /**
   * Pushes the island shape in window coordinates. Rust flips click-through from
   * its own cursor poll, so the flag is never a frame behind a click.
   */
  setIslandRect: (x: number, y: number, width: number, height: number) =>
    call<void>("set_island_rect", { x, y, width, height }),

  /** Give the window keyboard focus (chat field) and take it away again. */
  focusWindow: (focused: boolean) => call<void>("focus_window", { focused }),

  reposition: () => call<void>("reposition"),

  openUrl: (url: string) => call<void>("open_url", { url }),

  /** "Open terminal" → opens the folder in VS Code when `code` is on PATH. */
  openInVSCode: (path: string | null) => call<boolean>("open_in_vscode", { path }),

  /**
   * "Open" for a Claude Code session: with the companion VS Code extension
   * installed, first shows the exact terminal tab the session runs in; then
   * brings the VS Code window it lives in to the front — restoring it,
   * switching virtual desktop if it is on another one — and only opens the
   * folder when no window has it (`code <cwd>`, or the WSL remote URI; Explorer
   * without `code`). `cwd`, `wslDistro` and `sessionId` are the hook payload's
   * `cwd`, `wsl_distro` (null for a Windows session; `cwd` is then a Linux
   * path) and `session_id` — the app remembers each session's terminal by it.
   * Never throws: anything that goes wrong is "failed".
   */
  openSession: async (
    cwd: string | null,
    wslDistro: string | null,
    sessionId: string | null = null,
  ): Promise<OpenSessionResult> =>
    (await call<OpenSessionResult>("open_session", { cwd, wslDistro, sessionId })) ?? "failed",

  quit: () => call<void>("quit_app"),

  openSettingsWindow: () => call<void>("open_settings_window"),

  /** Writes to %LOCALAPPDATA%\Coucou\coucou.log, next to the Rust lines. */
  log: (message: string) => call<void>("log_line", { message }),

  // ── Claude Code hooks ─────────────────────────────────────────────────────
  // A target is "windows" or "wsl:<distro>"; leaving it out means Windows.

  /** Windows, then each WSL distro. Read from the registry; starts nothing. */
  hooksTargets: () => call<HookTarget[]>("hooks_targets"),
  /**
   * Whether a target has Coucou's hooks. A stopped WSL distro is only started
   * to find out when `start` is true; otherwise it comes back `checked: false`.
   */
  hooksStatus: (target?: string, start = false) => call<HookStatus>("hooks_status", { target, start }),
  /** Diff to show before anything is written. `install: false` previews removal. */
  hooksPreview: (install: boolean, target?: string) =>
    callOrThrow<HookPreview>("hooks_preview", { install, target }),
  /**
   * Writes that target's ~/.claude/settings.json — only ever after an explicit
   * click, and only when the file still matches the preview the user looked at.
   */
  hooksApply: (install: boolean, fingerprint: string, target?: string) =>
    callOrThrow<string>("hooks_apply", { install, fingerprint, target }),

  // ── The companion VS Code extension (terminal focus) ─────────────────────
  /** Whether VS Code has it (`code --list-extensions`). Runs VS Code's CLI: only when the settings window shows. */
  vscodeExtensionStatus: () => call<ExtensionStatus>("vscode_extension_status"),
  /** `code --install-extension <bundled vsix> --force` — only ever from the Install / Update button. */
  vscodeExtensionInstall: () => callOrThrow<string>("vscode_extension_install"),

  approvalDecision: (requestId: string, decision: "allow" | "deny") =>
    call<void>("approval_decision", { requestId, decision }),
  /** "The card is up" — until this lands the relay only waits a moment. */
  approvalAck: (requestId: string) => call<void>("approval_ack", { requestId }),
  /** "Nobody can act on this" — Claude Code asks in the terminal right away. */
  approvalDecline: (requestId: string) => call<void>("approval_decline", { requestId }),

  // ── Chat, files, secrets ──────────────────────────────────────────────────
  /** One chat turn. The API key and any file bytes never leave Rust. */
  chatSend: (query: string, context: ChatContext | null) =>
    callOrThrow<{ text: string }>("chat_send", { query, context }),
  chatReset: () => call<void>("chat_reset"),
  /** Copies a dropped file into the inbox. */
  ingestFile: (path: string) => callOrThrow<DroppedFile>("ingest_file", { path }),
  /** Only ever tells you whether a key exists — never its value. */
  secretPresent: (key: string) => call<boolean>("secret_present", { key }),
  secretSet: (key: string, value: string) => callOrThrow<void>("secret_set", { key, value }),
  secretClear: (key: string) => callOrThrow<void>("secret_clear", { key }),

  // ── Integrations ──────────────────────────────────────────────────────────
  refreshIntegration: (id: string) => call<void>("refresh_integration", { id }),
  /** Opens the configured n8n instance in the browser. */
  openN8n: () => call<void>("open_n8n"),

  /** Tray → Pause. Stops the integration pollers, not just the island. */
  setPaused: (paused: boolean) => call<void>("set_paused", { paused }),
};

/**
 * - `focused`: an existing VS Code window for the session is now in front;
 * - `opened`: no window had it, `code` was asked to open the folder;
 * - `explorer`: no window and no `code` on PATH, Explorer shows the folder;
 * - `failed`: nothing happened — bad input, a launch that failed, or Windows
 *   refused to bring the window forward (its taskbar button flashes instead);
 *   or the extension showed the session's terminal but its window could not
 *   be told apart by title (a custom `window.title`), so it was not raised.
 */
export type OpenSessionResult = "focused" | "opened" | "explorer" | "failed";

export interface IntegrationUpdate {
  id: string;
  data: Record<string, unknown>;
  error: string | null;
  event: { success: boolean; label: string; detail: string | null } | null;
}

export type ChatContext =
  | { kind: "file"; name: string; path: string }
  | { kind: "window"; appName: string; title: string; url?: string };

export interface DroppedFile {
  name: string;
  path: string;
  size: number;
}

export interface HookTarget {
  /** "windows" or "wsl:<distro>" — what the hooks* calls take as `target`. */
  id: string;
  /** "Windows" or "WSL · <distro>". */
  label: string;
  kind: "windows" | "wsl";
  distro: string | null;
}

export interface HookStatus {
  target: string;
  label: string;
  installed: boolean;
  /** Installed, but with commands an older Coucou wrote: Install… would update them. */
  outdated: boolean;
  settingsPath: string;
  /** The relay as this target runs it: a Windows path, or its Linux path. */
  hookPath: string;
  hookReady: boolean;
  /** False for a stopped WSL distro that was not started: `installed` is unknown. */
  checked: boolean;
  /** Why the target cannot be read right now (WSL unreachable, invalid JSON…). */
  error: string | null;
}

export interface ExtensionStatus {
  /** The `code` command found on PATH; null without one. */
  codePath: string | null;
  /** The version VS Code has installed; null when it has none. */
  installed: string | null;
  /** The version this build of Coucou ships. */
  bundled: string;
  /** The bundled .vsix; null if this build has none. */
  vsixPath: string | null;
  upToDate: boolean;
  error: string | null;
}

export interface HookPreview {
  diff: string;
  backup: string;
  settingsPath: string;
  /** Hand back to hooksApply so only the reviewed diff is ever written. */
  fingerprint: string;
}

/** Same as `call`, but surfaces the error so the UI can show what went wrong. */
async function callOrThrow<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!IS_TAURI) throw new Error("not running inside Coucou");
  return invoke<T>(cmd, args);
}

export type BridgeEvent =
  | { name: "cursor"; payload: { x: number; y: number } }
  | { name: "tray"; payload: string }
  | { name: "hook"; payload: Record<string, unknown> }
  | { name: "screen-changed"; payload: null };

export interface DragDropPayload {
  type: "enter" | "over" | "drop" | "leave";
  paths?: string[];
}

/** Files dragged onto the island. Only reaches us when the window takes the mouse. */
export async function onDragDrop(handler: (e: DragDropPayload) => void) {
  if (!IS_TAURI) return () => {};
  return getCurrentWebview().onDragDropEvent((event) => {
    handler(event.payload as DragDropPayload);
  });
}

export async function onEvent<T>(name: string, handler: (payload: T) => void) {
  if (!IS_TAURI) return () => {};
  return listen<T>(name, (e) => handler(e.payload));
}
