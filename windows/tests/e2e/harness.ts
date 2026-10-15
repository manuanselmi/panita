// Everything the end-to-end suite needs around the app: where things are, how
// to build, launch and stop the side instance, how to run the real relay, and
// the guards that keep all of it away from the user's real install.
//
// The suite runs Coucou as the side instance COUCOU_INSTANCE=e2e (see
// hook/src/instance.rs and TESTING.md). Its own name, rather than the `dev` a
// developer may use by hand, because the suite wipes its instance's folders
// before and after every run.
//
// Hard rules, enforced here rather than trusted:
//   * Only ever stop a process this suite started, and only after checking its
//     executable is the dev build in target/debug — never by name.
//   * Only ever delete the side instance's own folders (`Coucou-<instance>`,
//     `fr.louisraille.coucou.<instance>`), checked by exact name and parent —
//     and never while any app serves that instance's pipe: another checkout may
//     be running the suite under the same name (COUCOU_E2E_INSTANCE avoids it).
//   * Never open the real relay pipe. Pipes are only *listed*: `fs.existsSync`
//     or `stat` on a pipe path would connect to whoever serves it.
//   * Refuse to launch binaries that do not know about COUCOU_INSTANCE: an old
//     build would ignore the variable and run as the real install.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const WINDOWS_DIR = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const APP_EXE = path.join(WINDOWS_DIR, "target", "debug", "coucou.exe");
export const HOOK_EXE = path.join(WINDOWS_DIR, "target", "release", "coucou-hook.exe");
export const RESULTS_DIR = path.join(WINDOWS_DIR, "test-results", "e2e");
const PID_FILE = path.join(RESULTS_DIR, "app.pid");
/**
 * The side instance's sandbox home (COUCOU_TEST_HOME, see hooks::test_home):
 * every hook target's settings.json lives under it instead of the real homes —
 * `windows\.claude\settings.json` and `wsl\<distro>\.claude\settings.json`.
 */
export const SANDBOX_HOME = path.join(RESULTS_DIR, "sandbox-home");
/**
 * A stand-in for VS Code's `code` command, first on the side instance's PATH:
 * the app's `code --list-extensions`, `code --install-extension` and `code
 * <folder>` all land here, are recorded in `calls.txt`, and nothing reaches
 * the user's VS Code. See writeFakeCode().
 */
export const FAKE_CODE_DIR = path.join(RESULTS_DIR, "fake-code");
export const FAKE_CODE = path.join(FAKE_CODE_DIR, "code.cmd");
/**
 * The fake Claude Code for the chat cases: `claude.cmd`, running
 * tests/e2e/fake-claude.mjs, in the same folder as the fake `code` — first on
 * the side instance's PATH, so the island's chat finds it before the real one.
 */
export const FAKE_CLAUDE = path.join(FAKE_CODE_DIR, "claude.cmd");
/** The companion VS Code extension's manifest (vscode-extension/package.json). */
export const EXTENSION_MANIFEST = JSON.parse(
  fs.readFileSync(path.join(WINDOWS_DIR, "vscode-extension", "package.json"), "utf8"),
) as { publisher: string; name: string; version: string };
export const EXTENSION_ID = `${EXTENSION_MANIFEST.publisher}.${EXTENSION_MANIFEST.name}`;

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`%${name}% is not set`);
  return value;
}

/** The side instance the suite runs as. Never empty: empty would mean the real install. */
export const INSTANCE = (() => {
  const name = (process.env.COUCOU_E2E_INSTANCE ?? "e2e").trim().toLowerCase();
  if (!/^[a-z0-9]{1,32}$/.test(name)) {
    throw new Error(`COUCOU_E2E_INSTANCE=${JSON.stringify(name)} is not a usable instance name`);
  }
  return name;
})();

const LOCALAPPDATA = path.resolve(requiredEnv("LOCALAPPDATA"));
const APPDATA = path.resolve(requiredEnv("APPDATA"));

/** The side instance's folders, as hook/src/instance.rs derives them. */
export const side = {
  localDir: path.join(LOCALAPPDATA, `Coucou-${INSTANCE}`),
  configDir: path.join(APPDATA, `Coucou-${INSTANCE}`),
  webviewDir: path.join(LOCALAPPDATA, `fr.louisraille.coucou.${INSTANCE}`),
  get log() {
    return path.join(this.localDir, "coucou.log");
  },
  get stagedHook() {
    return path.join(this.localDir, "bin", "coucou-hook.exe");
  },
};

/** The real install. Read, never written. */
export const real = {
  localDir: path.join(LOCALAPPDATA, "Coucou"),
  configDir: path.join(APPDATA, "Coucou"),
  webviewDir: path.join(LOCALAPPDATA, "fr.louisraille.coucou"),
  log: path.join(LOCALAPPDATA, "Coucou", "coucou.log"),
};

// ── Small utilities ───────────────────────────────────────────────────────────

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor<T>(
  what: string,
  probe: () => T | null | undefined | false | Promise<T | null | undefined | false>,
  timeoutMs = 10_000,
  intervalMs = 100,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown = null;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (err) {
      last = err;
    }
    await sleep(intervalMs);
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}${last ? ` (last error: ${String(last)})` : ""}`);
}

const samePath = (a: string | null | undefined, b: string) =>
  !!a && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/** Runs a PowerShell script (passed encoded, so no quoting surprises) and parses its JSON output. */
function powershellJson<T>(script: string): T[] {
  const encoded = Buffer.from(`${script} | ConvertTo-Json -Compress -Depth 3`, "utf16le").toString("base64");
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (r.status !== 0) throw new Error(`powershell failed: ${r.stderr}`);
  const text = r.stdout.trim();
  if (!text) return [];
  const parsed = JSON.parse(text) as T | T[];
  return Array.isArray(parsed) ? parsed : [parsed];
}

export interface Proc {
  pid: number;
  path: string | null;
  commandLine: string | null;
}

function processes(filter: string): Proc[] {
  return powershellJson<{ ProcessId: number; ExecutablePath: string | null; CommandLine: string | null }>(
    `Get-CimInstance Win32_Process -Filter "${filter}" | Select-Object ProcessId, ExecutablePath, CommandLine`,
  ).map((p) => ({ pid: p.ProcessId, path: p.ExecutablePath, commandLine: p.CommandLine }));
}

export const coucouProcesses = () => processes("Name = 'coucou.exe'");

/** WebView2 processes whose profile lives under `userDataDir`. */
export function webviewProcesses(userDataDir: string): Proc[] {
  const needle = userDataDir.toLowerCase() + "\\ebwebview";
  return processes("Name = 'msedgewebview2.exe'").filter((p) =>
    (p.commandLine ?? "").toLowerCase().includes(needle),
  );
}

/** The account SID, which the relay pipe name carries. */
/** Extended window style bits (winuser.h) the island's window is checked for. */
export const WS_EX = {
  TOPMOST: 0x0000_0008,
  TRANSPARENT: 0x0000_0020,
  TOOLWINDOW: 0x0000_0080,
  APPWINDOW: 0x0004_0000,
  LAYERED: 0x0008_0000,
  NOACTIVATE: 0x0800_0000,
} as const;

export interface TopWindow {
  hwnd: number;
  title: string;
  className: string;
  visible: boolean;
  /** GWL_EXSTYLE, as GetWindowLongPtrW reads it. */
  exStyle: number;
}

/**
 * The top-level windows of process `pid`, with their extended style. Read
 * only: EnumWindows and GetWindowLongPtrW, which work across processes and
 * change nothing — no focus, no input, no window touched.
 */
export function topLevelWindows(pid: number): TopWindow[] {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`not a PID: ${pid}`);
  const script = `
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class E2eWindows {
  delegate bool EnumProc(IntPtr hwnd, IntPtr lp);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr lp);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr hwnd, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr hwnd, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] static extern IntPtr GetWindowLongPtr(IntPtr hwnd, int index);
  public static List<object[]> Of(uint pid) {
    var found = new List<object[]>();
    EnumWindows((h, _) => {
      uint owner;
      GetWindowThreadProcessId(h, out owner);
      if (owner == pid) {
        var title = new StringBuilder(256);
        GetWindowTextW(h, title, title.Capacity);
        var cls = new StringBuilder(256);
        GetClassNameW(h, cls, cls.Capacity);
        found.Add(new object[] { h.ToInt64(), title.ToString(), cls.ToString(), IsWindowVisible(h), GetWindowLongPtr(h, -20).ToInt64() & 0xFFFFFFFFL });
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@
[E2eWindows]::Of(${pid}) | ForEach-Object { [pscustomobject]@{ hwnd = $_[0]; title = $_[1]; className = $_[2]; visible = $_[3]; exStyle = $_[4] } }`;
  return powershellJson<TopWindow>(script);
}

/** The island's window in process `pid`: the Tauri window titled "Coucou" (Settings has a title of its own). */
export function islandWindow(pid: number): TopWindow {
  const found = topLevelWindows(pid).filter((w) => w.title === "Coucou" && w.className === "Tauri Window");
  if (found.length !== 1) {
    throw new Error(`expected one island window in PID ${pid}, found ${JSON.stringify(found)}`);
  }
  return found[0];
}

export function userSid(): string {
  const whoami = path.join(requiredEnv("SystemRoot"), "System32", "whoami.exe");
  const r = spawnSync(whoami, ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true });
  const sid = r.stdout.trim().split(",").at(-1)?.replace(/"/g, "");
  if (!sid?.startsWith("S-")) throw new Error(`could not read the user SID: ${r.stdout} ${r.stderr}`);
  return sid;
}

/** Names of the named pipes that exist right now. Listing never connects to them. */
export function pipeNames(): string[] {
  return fs.readdirSync("\\\\.\\pipe\\");
}

export const sidePipeName = (sid: string) => `coucou-${INSTANCE}-${sid}`;
export const realPipeName = (sid: string) => `coucou-${sid}`;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address ? resolve(address.port) : reject()));
    });
  });
}

/** Fails unless `exe` was built with side-instance support (see the header). */
export function assertKnowsInstances(exe: string) {
  if (!fs.existsSync(exe)) throw new Error(`${exe} is missing — build it first (see TESTING.md)`);
  if (!fs.readFileSync(exe).includes("COUCOU_INSTANCE")) {
    throw new Error(`${exe} predates COUCOU_INSTANCE; it would run as the real install. Rebuild it.`);
  }
}

// ── Build ─────────────────────────────────────────────────────────────────────

/** Child-process environment with cargo reachable even if it is not on PATH yet. */
export function toolEnv(): NodeJS.ProcessEnv {
  const cargoBin = path.join(process.env.USERPROFILE ?? "", ".cargo", "bin");
  const env = { ...process.env };
  // The suite must never hand its own instance name to the build, or to anything
  // that is not the side instance itself.
  delete env.COUCOU_INSTANCE;
  if (fs.existsSync(cargoBin)) {
    // Windows spells it `Path`, Git Bash and MSYS spell it `PATH`, and a plain
    // object copy of process.env is case-sensitive: writing `PATH` next to an
    // existing `Path` hands the child two variables and it may pick the one
    // holding cargo alone (npm then "is not recognized"). Update whichever exists.
    const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
    env[key] = `${cargoBin};${env[key] ?? ""}`;
  }
  return env;
}

/**
 * `tauri build --debug --no-bundle`: target/debug/coucou.exe with the front end
 * embedded (no Vite server needed), plus target/release/coucou-hook.exe through
 * the `prebuild` script. Incremental after the first run.
 */
export function buildAll() {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const logFile = path.join(RESULTS_DIR, "build.log");
  const started = Date.now();
  const r = spawnSync("npm run tauri -- build --debug --no-bundle", {
    cwd: WINDOWS_DIR,
    env: toolEnv(),
    shell: true,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  fs.writeFileSync(logFile, `${r.stdout ?? ""}\n${r.stderr ?? ""}`);
  if (r.status !== 0) {
    const tail = `${r.stdout}\n${r.stderr}`.split("\n").slice(-40).join("\n");
    throw new Error(`build failed (full log: ${logFile}):\n${tail}`);
  }
  return { seconds: Math.round((Date.now() - started) / 1000), logFile };
}

// ── Side instance folders ─────────────────────────────────────────────────────

/** Deletes one of the side instance's own folders, and nothing else, ever. */
function removeSideDir(dir: string) {
  const parent = path.dirname(dir);
  const base = path.basename(dir);
  const allowed =
    (samePath(parent, LOCALAPPDATA) && (base === `Coucou-${INSTANCE}` || base === `fr.louisraille.coucou.${INSTANCE}`)) ||
    (samePath(parent, APPDATA) && base === `Coucou-${INSTANCE}`);
  if (!allowed || [real.localDir, real.configDir, real.webviewDir].some((r) => samePath(r, dir))) {
    throw new Error(`refusing to delete ${dir}`);
  }
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}

/**
 * True while an app serves this side instance's pipe — this run's, or another
 * run's: two checkouts running the suite at once with the same instance name.
 */
export function sideInstanceRunning(): boolean {
  return pipeNames().some((name) => name.startsWith(`coucou-${INSTANCE}-`));
}

/**
 * Deletes the side instance's folders — unless an app is still serving its
 * pipe. Then they belong to a run in progress (this one's app failed to quit,
 * or another checkout is running the suite under the same name), and wiping
 * them would pull its log and settings out from under it. Returns whether it
 * deleted them.
 */
export function removeSideDirs(): boolean {
  if (sideInstanceRunning()) {
    console.warn(`[e2e] a "${INSTANCE}" instance is still running; its folders are left alone`);
    return false;
  }
  for (const dir of [side.localDir, side.configDir, side.webviewDir]) removeSideDir(dir);
  return true;
}

export function sideDirsLeft(): string[] {
  return [side.localDir, side.configDir, side.webviewDir].filter((d) => fs.existsSync(d));
}

/** Settings for the side instance: muted, so a test run never plays sounds at the user. */
/** `extra` goes over the defaults, e.g. `{ islandX: 1 }` for an island left at the right edge. */
function writeSideSettings(extra: Record<string, unknown> = {}) {
  fs.mkdirSync(side.configDir, { recursive: true });
  const settings = {
    soundEnabled: false,
    soundVolume: 0.12,
    autoCloseInterval: 15,
    absenceInterval: 180,
    // The shipped default (src/core/state.ts): no integration, only sessions.
    activeIntegrations: [],
    screen: "primary",
    autostart: false,
    hooksInstalled: false,
    model: "claude-opus-5",
    ...extra,
  };
  fs.writeFileSync(path.join(side.configDir, "settings.json"), JSON.stringify(settings, null, 2));
}

/**
 * The fake `code` (FAKE_CODE_DIR): a batch file that appends its arguments to
 * calls.txt and answers like VS Code's CLI would — `--list-extensions` lists
 * one unrelated extension, plus ours once `--install-extension` has been
 * "run". It opens nothing.
 */
function writeFakeCode() {
  fs.rmSync(FAKE_CODE_DIR, { recursive: true, force: true });
  fs.mkdirSync(FAKE_CODE_DIR, { recursive: true });
  const script = [
    "@echo off",
    'echo %*>> "%~dp0calls.txt"',
    'if "%~1"=="--list-extensions" (',
    "  echo ms-python.python@2026.1.0",
    '  if exist "%~dp0installed.txt" type "%~dp0installed.txt"',
    "  exit /b 0",
    ")",
    'if "%~1"=="--install-extension" (',
    `  > "%~dp0installed.txt" echo ${EXTENSION_ID}@${EXTENSION_MANIFEST.version}`,
    "  echo Extension was successfully installed.",
    "  exit /b 0",
    ")",
    "exit /b 0",
    "",
  ].join("\r\n");
  fs.writeFileSync(FAKE_CODE, script);
}

/** The fake Claude Code next to the fake `code` (see FAKE_CLAUDE). */
function writeFakeClaude() {
  fs.copyFileSync(path.join(WINDOWS_DIR, "tests", "e2e", "fake-claude.mjs"), path.join(FAKE_CODE_DIR, "fake-claude.mjs"));
  fs.writeFileSync(FAKE_CLAUDE, ["@echo off", 'node "%~dp0fake-claude.mjs" %*', ""].join("\r\n"));
}

/** What the fake Claude Code recorded: each start (args, cwd), message, crash and exit. */
export interface FakeClaudeEntry {
  pid: number;
  event: "start" | "message" | "crash" | "exit";
  args?: string[];
  cwd?: string;
  session?: string | null;
  text?: string;
}

export function fakeClaudeCalls(): FakeClaudeEntry[] {
  try {
    return fs
      .readFileSync(path.join(FAKE_CODE_DIR, "claude-calls.jsonl"), "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as FakeClaudeEntry);
  } catch {
    return [];
  }
}

/** Every call the side instance made to the fake `code`, oldest first. */
export function fakeCodeCalls(): string[] {
  try {
    return fs.readFileSync(path.join(FAKE_CODE_DIR, "calls.txt"), "utf8").split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

export function readSideLog(): string {
  try {
    return fs.readFileSync(side.log, "utf8");
  } catch {
    return "";
  }
}

/** Waits for a line of the side instance's log matching `re`, looking only past `from` bytes. */
export function waitForLog(re: RegExp, timeoutMs = 5_000, from = 0): Promise<RegExpMatchArray> {
  return waitFor(`log line ${re}`, () => readSideLog().slice(from).match(re), timeoutMs);
}

// ── The app ───────────────────────────────────────────────────────────────────

export interface RunningApp {
  child: ChildProcess;
  pid: number;
  port: number;
}

/** Stops a side instance left behind by a crashed run — only if it really is one of ours. */
export function stopLeftoverFromPidFile(): string | null {
  if (!fs.existsSync(PID_FILE)) return null;
  const pid = Number(fs.readFileSync(PID_FILE, "utf8").trim());
  fs.rmSync(PID_FILE, { force: true });
  const proc = coucouProcesses().find((p) => p.pid === pid);
  if (!proc || !samePath(proc.path, APP_EXE)) return null;
  killTree(pid);
  return `stopped leftover side instance pid ${pid}`;
}

function killTree(pid: number) {
  // Re-checked right before the kill: a PID is only ever ours while its
  // executable is the dev build. The installed coucou.exe can never match.
  const proc = coucouProcesses().find((p) => p.pid === pid);
  if (!proc) return;
  if (!samePath(proc.path, APP_EXE)) throw new Error(`pid ${pid} is ${proc.path}, not the dev build — not killing it`);
  spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
}

/** Reads the side instance's settings.json back. */
export function readSideSettings(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(side.configDir, "settings.json"), "utf8"));
}

/** `settings` goes over the suite's side settings (writeSideSettings). */
export async function launchApp(sid: string, settings: Record<string, unknown> = {}): Promise<RunningApp> {
  assertKnowsInstances(APP_EXE);
  stopLeftoverFromPidFile();
  if (pipeNames().includes(sidePipeName(sid))) {
    throw new Error(
      `\\\\.\\pipe\\${sidePipeName(sid)} already exists: another "${INSTANCE}" instance is running. ` +
        `Quit it from its tray icon (tooltip "Coucou (${INSTANCE})") and run again.`,
    );
  }

  if (!removeSideDirs()) throw new Error(`a "${INSTANCE}" instance appeared while launching; not starting another`);
  writeSideSettings(settings);
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.rmSync(SANDBOX_HOME, { recursive: true, force: true });
  fs.mkdirSync(SANDBOX_HOME, { recursive: true });
  writeFakeCode();
  writeFakeClaude();

  const port = await freePort();
  const output = fs.createWriteStream(path.join(RESULTS_DIR, "app-output.log"));
  const env = toolEnv();
  // The fake `code` first on PATH: whatever the app asks of VS Code reaches
  // the stand-in, never the user's VS Code (checked before anything is clicked).
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  env[pathKey] = `${FAKE_CODE_DIR};${env[pathKey] ?? ""}`;
  const child = spawn(APP_EXE, [], {
    cwd: WINDOWS_DIR,
    env: {
      ...env,
      COUCOU_INSTANCE: INSTANCE,
      // Hook installs from this instance go to the sandbox, never to a real
      // ~/.claude/settings.json (Windows or WSL). Only side instances honour it.
      COUCOU_TEST_HOME: SANDBOX_HOME,
      // Read by WebView2 itself, and only this process tree gets it. WebView2
      // appends it to the island's own additionalBrowserArgs (verified in
      // "starts isolated"), so the app runs with its usual flags plus this one.
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout?.pipe(output);
  child.stderr?.pipe(output);
  const pid = child.pid;
  if (!pid) throw new Error("the app did not start");
  fs.writeFileSync(PID_FILE, String(pid));

  const outcome = await waitFor(
    "the side instance to start and open its pipe",
    () => {
      if (child.exitCode !== null) return "exited";
      const ready =
        readSideLog().includes(`started (instance ${INSTANCE})`) && pipeNames().includes(sidePipeName(sid));
      return ready ? "ready" : null;
    },
    60_000,
    200,
  );
  if (outcome === "exited") {
    fs.rmSync(PID_FILE, { force: true });
    throw new Error(
      `the app exited with code ${child.exitCode} during startup (see test-results/e2e/app-output.log)`,
    );
  }
  return { child, pid, port };
}

/**
 * Quits the side instance: politely first (`quit_app`, like the tray's Quit, so
 * its notification-area icon goes away), then by force — only ever our own
 * PID, re-checked. Waits for its WebView2 processes too, so the folders can go.
 */
export async function stopApp(app: RunningApp, quitPolitely?: () => Promise<void>) {
  const alive = () => app.child.exitCode === null && app.child.signalCode === null;
  if (alive() && quitPolitely) {
    await quitPolitely().catch(() => undefined);
    await waitFor("the app to quit", () => !alive(), 10_000).catch(() => undefined);
  }
  if (alive()) {
    killTree(app.pid);
    await waitFor("the app to die", () => !alive(), 10_000);
  }
  fs.rmSync(PID_FILE, { force: true });

  // Its WebView2 browser and renderers follow within a few seconds.
  const gone = await waitFor("WebView2 to exit", () => webviewProcesses(side.webviewDir).length === 0, 20_000, 500)
    .then(() => true)
    .catch(() => false);
  if (!gone) {
    // Still ours: their profile folder is the side instance's.
    for (const p of webviewProcesses(side.webviewDir)) {
      spawnSync("taskkill.exe", ["/PID", String(p.pid), "/F"], { windowsHide: true });
    }
  }
}

// ── The relay ─────────────────────────────────────────────────────────────────

export interface HookRun {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

/**
 * Runs the real coucou-hook.exe the way Claude Code does — event name as the
 * argument, the event JSON on stdin — but with the side instance's name, so it
 * talks to the side instance's pipe. Killed after `timeoutMs` (code `null`) so a
 * relay that hangs fails its own test instead of the ones after it.
 */
export function runHook(event: string, payload: Record<string, unknown>, timeoutMs = 20_000): Promise<HookRun> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(HOOK_EXE, [event], {
      env: { ...toolEnv(), COUCOU_INSTANCE: INSTANCE },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, ms: Math.round(performance.now() - started) });
    });
    child.stdin.end(JSON.stringify({ hook_event_name: event, ...payload }));
  });
}

// ── WSL ───────────────────────────────────────────────────────────────────────
//
// The WSL cases run the relay from inside the user's own distro, through WSL
// interop, exactly as a Claude Code session there would. Only read-only
// commands run in the distro (sh, printf, wslpath, cmd.exe's echo) besides the
// relay itself, and only when the distro is *already running*: the suite never
// boots a WSL VM.
//
// The variable that sends the relay to the side instance must reach a Windows
// process started from Linux. Two mechanisms do that, and the suite uses both:
// it is set in wsl.exe's own (Windows) environment, which WSL interop hands to
// every Windows process started inside that session, and it is listed in
// WSLENV *without* a flag so Linux sees it too. (`/u` would be wrong for the
// second hop: it only covers Windows → Linux, so a value set inside Linux with
// `WSLENV=COUCOU_INSTANCE/u` never reaches the relay — `/w` or no flag does.)
// Then, before any event is sent, `cmd.exe /c echo %COUCOU_INSTANCE%` is run
// from the same shell: if it does not print the side instance's name, the
// relay would talk to the real install, and the run stops there.

const WSL_EXE = path.join(requiredEnv("SystemRoot"), "System32", "wsl.exe");

/** `wsl.exe -l …` prints UTF-16LE. */
function utf16Lines(buf: Buffer): string[] {
  return buf
    .toString("utf16le")
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .map((l) => l.replace(/\0/g, "").trim())
    .filter(Boolean);
}

export type WslTarget = { distro: string; skip: null } | { distro: null; skip: string };

/**
 * The distro the WSL cases use: COUCOU_E2E_WSL_DISTRO, else the default one —
 * and only if it is running right now. Otherwise the reason to skip.
 */
export function wslTarget(): WslTarget {
  if (!fs.existsSync(WSL_EXE)) return { distro: null, skip: "WSL is not installed" };
  let distro = process.env.COUCOU_E2E_WSL_DISTRO?.trim() || null;
  if (!distro) {
    try {
      // powershellJson pipes the last statement into ConvertTo-Json, so it
      // has to be a pipeline, not an `if`.
      const found = powershellJson<{ DistributionName: string | null }>(
        `$k = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss'; ` +
          `$d = (Get-ItemProperty $k -ErrorAction SilentlyContinue).DefaultDistribution; ` +
          `Get-ItemProperty "$k\\$d" -ErrorAction SilentlyContinue | Select-Object DistributionName`,
      );
      distro = found[0]?.DistributionName ?? null;
    } catch {
      distro = null;
    }
  }
  if (!distro) return { distro: null, skip: "no default WSL distro" };
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(distro)) return { distro: null, skip: `odd distro name ${JSON.stringify(distro)}` };
  const r = spawnSync(WSL_EXE, ["-l", "--running", "-q"], { windowsHide: true, timeout: 15_000 });
  const running = r.status === 0 ? utf16Lines(r.stdout) : [];
  if (!running.some((d) => d.toLowerCase() === distro!.toLowerCase())) {
    return { distro: null, skip: `${distro} is not running (the suite never starts a distro)` };
  }
  return { distro, skip: null };
}

/** Env for wsl.exe: the side instance's name, on both sides of interop (see above). */
function wslEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...toolEnv(), COUCOU_INSTANCE: INSTANCE };
  const key = Object.keys(env).find((k) => k.toUpperCase() === "WSLENV") ?? "WSLENV";
  const listed = (env[key] ?? "").split(":").filter((v) => v && !/^COUCOU_INSTANCE(\/|$)/.test(v));
  env[key] = [...listed, "COUCOU_INSTANCE"].join(":");
  return env;
}

/** A read-only command inside the distro; stdout as text. */
export function wslRead(distro: string, script: string, ...args: string[]): string {
  const r = spawnSync(WSL_EXE, ["-d", distro, "-e", "sh", "-c", script, "e2e", ...args], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
  });
  if (r.status !== 0) throw new Error(`wsl ${script}: exit ${r.status}: ${r.stderr}`);
  return r.stdout;
}

/** `wslpath -u` inside the distro — how Linux sees a Windows path. */
export const wslPath = (distro: string, windowsPath: string) =>
  wslRead(distro, 'wslpath -u "$1"', windowsPath).trim();

/** `'<relay>' <Event> --wsl-distro "$WSL_DISTRO_NAME" --wsl-ppid "$PPID"` — the command Coucou installs in a distro. */
export function wslHookCommand(relayLinux: string, event: string): string {
  return `${wslHookCommandBeforePpid(relayLinux, event)} --wsl-ppid "$PPID"`;
}

/** The command an older Coucou installed in a distro, before `--wsl-ppid`. */
export function wslHookCommandBeforePpid(relayLinux: string, event: string): string {
  return `'${relayLinux.replace(/'/g, `'\\''`)}' ${event} --wsl-distro "$WSL_DISTRO_NAME"`;
}

/**
 * The first lines of every script that runs the relay from WSL: `$1` is
 * cmd.exe's Linux path, `$2` the side instance's name. Unless a Windows
 * process started from this shell sees that name, nothing is sent (exit 97).
 */
const WSL_INSTANCE_CHECK = [
  // </dev/null: cmd.exe must not swallow the JSON meant for the relay.
  `seen=$("$1" /d /c "echo %COUCOU_INSTANCE%" </dev/null 2>/dev/null | tr -d '\\r')`,
  `if [ "$seen" != "$2" ]; then echo "COUCOU_INSTANCE does not reach Windows processes (got '$seen')" >&2; exit 97; fi`,
];

/** A hook run from WSL whose calling shell stays alive afterwards (see below). */
export interface HeldWslHook {
  /** The Linux PID of the shell the hook command ran under — the hook's `$PPID`. */
  parentPid: Promise<number>;
  /** Resolves once the hook command has exited (the shell then sleeps). */
  hookDone: Promise<number>;
  /** Everything, once the shell is gone. */
  closed: Promise<HookRun>;
  /** Ends our wsl.exe (and with it the sleeping shell). */
  stop(): void;
}

/**
 * Like runHookInWsl, but the hook command runs as a *child* of a shell that
 * then sleeps for `holdSeconds`: its `$PPID` is that shell, as it is Claude
 * Code in real life, and the shell is still alive — with its whole Linux
 * ancestry — when the test clicks ↗ and the app reads /proc. The shell's PID
 * is printed first on stderr. Read-only: `sh`, `sleep`, cmd.exe's echo and
 * the relay.
 */
export function runHookInWslHolding(
  distro: string,
  command: string,
  payload: Record<string, unknown>,
  holdSeconds = 30,
): HeldWslHook {
  const cmdExe = wslPath(distro, path.join(requiredEnv("SystemRoot"), "System32", "cmd.exe"));
  const script = [
    ...WSL_INSTANCE_CHECK,
    `echo "coucou-e2e-parent $$" >&2`,
    `sh -c "$3"`,
    `echo "coucou-e2e-hook-done $?" >&2`,
    `sleep "$4" </dev/null`,
  ].join("\n");
  const started = performance.now();
  const child = spawn(
    WSL_EXE,
    ["-d", distro, "-e", "sh", "-c", script, "e2e", cmdExe, INSTANCE, command, String(holdSeconds)],
    { env: wslEnv(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
  );
  let stdout = "";
  let stderr = "";
  const marker = (re: RegExp) =>
    new Promise<number>((resolve, reject) => {
      const look = () => {
        const m = stderr.match(re);
        if (m) resolve(Number(m[1]));
      };
      child.stderr.on("data", look);
      child.on("close", () => {
        look();
        reject(new Error(`the WSL shell ended first: ${stderr.trim()}`));
      });
    });
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const parentPid = marker(/coucou-e2e-parent (\d+)/);
  const hookDone = marker(/coucou-e2e-hook-done (\d+)/);
  // Whoever does not wait for these must not get an unhandled rejection.
  parentPid.catch(() => undefined);
  hookDone.catch(() => undefined);
  const closed = new Promise<HookRun>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr, ms: Math.round(performance.now() - started) }));
  });
  child.stdin.end(JSON.stringify(payload));
  return { parentPid, hookDone, closed, stop: () => void child.kill() };
}

/**
 * Runs a hook command line inside WSL, through `sh -c`, the way Claude Code
 * runs hooks there — JSON on stdin, whatever the relay prints on stdout — after
 * checking that the side instance's name really reaches Windows processes
 * started from that shell (exit code 97 and a message otherwise, with nothing
 * sent).
 */
export function runHookInWsl(
  distro: string,
  command: string,
  payload: Record<string, unknown>,
  timeoutMs = 20_000,
): Promise<HookRun> {
  const cmdExe = wslPath(distro, path.join(requiredEnv("SystemRoot"), "System32", "cmd.exe"));
  const script = [...WSL_INSTANCE_CHECK, `exec sh -c "$3"`].join("\n");
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(WSL_EXE, ["-d", distro, "-e", "sh", "-c", script, "e2e", cmdExe, INSTANCE, command], {
      env: wslEnv(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, ms: Math.round(performance.now() - started) });
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

// ── The real install ──────────────────────────────────────────────────────────

export interface RealInstall {
  processes: { pid: number; path: string | null }[];
  pipePresent: boolean;
  logBytes: number | null;
  logModified: Date | null;
  startedLines: number;
  inboxExists: boolean;
  /** The real ~/.claude/settings.json files (Windows, and the WSL distro's when it runs): path → SHA-256, or null if absent. */
  claudeSettings: Record<string, string | null>;
}

function sha256(file: string): string | null {
  try {
    return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
}

/** Where the real Claude Code settings live: Windows, and the running WSL distro's default user. */
function realClaudeSettingsPaths(): string[] {
  const paths = [path.join(requiredEnv("USERPROFILE"), ".claude", "settings.json")];
  const wsl = wslTarget();
  if (wsl.distro) {
    const home = wslRead(wsl.distro, 'printf %s "$HOME"');
    if (/^\/[^\\\0\n]*$/.test(home)) {
      paths.push(`\\\\wsl.localhost\\${wsl.distro}${home.replace(/\//g, "\\")}\\.claude\\settings.json`);
    }
  }
  return paths;
}

/** What the real install looks like right now — read only. */
export function snapshotRealInstall(sid: string): RealInstall {
  let log = "";
  let stat: fs.Stats | null = null;
  try {
    stat = fs.statSync(real.log);
    log = fs.readFileSync(real.log, "utf8");
  } catch {
    /* not installed, or never logged */
  }
  return {
    // Debug builds are side instances — this run's, or another checkout's
    // suite or `tauri dev` coming and going meanwhile — never the real install.
    processes: coucouProcesses()
      .filter((p) => !samePath(p.path, APP_EXE) && !/\\target\\debug\\coucou\.exe$/i.test(p.path ?? ""))
      .map((p) => ({ pid: p.pid, path: p.path })),
    pipePresent: pipeNames().includes(realPipeName(sid)),
    logBytes: stat?.size ?? null,
    logModified: stat?.mtime ?? null,
    startedLines: (log.match(/--- Coucou .* started/g) ?? []).length,
    inboxExists: fs.existsSync(path.join(real.localDir, "inbox")),
    claudeSettings: Object.fromEntries(realClaudeSettingsPaths().map((p) => [p, sha256(p)])),
  };
}

/** Lines appended to the real log since `snapshot`, for the report. */
export function realLogSince(snapshot: RealInstall): string[] {
  try {
    const buf = fs.readFileSync(real.log);
    return buf
      .subarray(snapshot.logBytes ?? 0)
      .toString("utf8")
      .split(/\r?\n/)
      .filter(Boolean);
  } catch {
    return [];
  }
}
