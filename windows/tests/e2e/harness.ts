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
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const WINDOWS_DIR = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const APP_EXE = path.join(WINDOWS_DIR, "target", "debug", "coucou.exe");
export const HOOK_EXE = path.join(WINDOWS_DIR, "target", "release", "coucou-hook.exe");
export const RESULTS_DIR = path.join(WINDOWS_DIR, "test-results", "e2e");
const PID_FILE = path.join(RESULTS_DIR, "app.pid");

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
function writeSideSettings() {
  fs.mkdirSync(side.configDir, { recursive: true });
  const settings = {
    soundEnabled: false,
    soundVolume: 0.12,
    autoCloseInterval: 15,
    absenceInterval: 180,
    activeIntegrations: ["integration_resend", "integration_n8n", "integration_vercel", "integration_github"],
    screen: "primary",
    autostart: false,
    hooksInstalled: false,
    model: "claude-opus-5",
  };
  fs.writeFileSync(path.join(side.configDir, "settings.json"), JSON.stringify(settings, null, 2));
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

export async function launchApp(sid: string): Promise<RunningApp> {
  assertKnowsInstances(APP_EXE);
  stopLeftoverFromPidFile();
  if (pipeNames().includes(sidePipeName(sid))) {
    throw new Error(
      `\\\\.\\pipe\\${sidePipeName(sid)} already exists: another "${INSTANCE}" instance is running. ` +
        `Quit it from its tray icon (tooltip "Coucou (${INSTANCE})") and run again.`,
    );
  }

  if (!removeSideDirs()) throw new Error(`a "${INSTANCE}" instance appeared while launching; not starting another`);
  writeSideSettings();
  fs.mkdirSync(RESULTS_DIR, { recursive: true });

  const port = await freePort();
  const output = fs.createWriteStream(path.join(RESULTS_DIR, "app-output.log"));
  const child = spawn(APP_EXE, [], {
    cwd: WINDOWS_DIR,
    env: {
      ...toolEnv(),
      COUCOU_INSTANCE: INSTANCE,
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

// ── The real install ──────────────────────────────────────────────────────────

export interface RealInstall {
  processes: { pid: number; path: string | null }[];
  pipePresent: boolean;
  logBytes: number | null;
  logModified: Date | null;
  startedLines: number;
  inboxExists: boolean;
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
    processes: coucouProcesses()
      .filter((p) => !samePath(p.path, APP_EXE))
      .map((p) => ({ pid: p.pid, path: p.path })),
    pipePresent: pipeNames().includes(realPipeName(sid)),
    logBytes: stat?.size ?? null,
    logModified: stat?.mtime ?? null,
    startedLines: (log.match(/--- Coucou .* started/g) ?? []).length,
    inboxExists: fs.existsSync(path.join(real.localDir, "inbox")),
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
