// The companion extension's pipe server — everything but the `vscode` glue
// (extension.ts), so it runs in plain Node: the unit tests drive it with fake
// terminals, and the end-to-end suite serves a fake VS Code window with it.
//
// Coucou asks every VS Code window "is this session's terminal one of yours?"
// when the user clicks a session's ↗ in the island. Each window's extension
// host serves one named pipe:
//
//   \\.\pipe\coucou-vscode-<extension host pid>-<16 random hex>
//   \\.\pipe\coucou-<instance>-vscode-<pid>-<hex>   (COUCOU_INSTANCE=<instance>)
//
// The instance part mirrors the relay's (hook/src/instance.rs): a side
// instance of Coucou — a dev build, the end-to-end suite — only ever finds the
// pipes of VS Code windows started with the same COUCOU_INSTANCE, never the
// user's real ones.
//
// Protocol: one JSON line in, one JSON line out, then the pipe closes.
//
//   → {"v":1,"pids":[<Windows PIDs>],"wsl":{"distro":"Ubuntu-24.04","pids":[<Linux PIDs>]}}
//   ← {"matched":true,"terminal":"<name>","window":"<workspace name>"}
//   ← {"matched":false}                      (or with "error" for a bad request)
//
// `pids` are the session's ancestor processes, nearest first: the relay's own
// Windows ancestry (hook/src/procs.rs) and, for a session inside WSL, the
// Linux chain up from Claude Code (the app's terminal.rs). `wsl` is absent or
// null for a Windows session. VS Code's `Terminal.processId` is the PID of the
// terminal's shell *on the machine the terminal runs on*: a Windows PID in a
// local window, a Linux PID in a Remote-WSL window (the remote server's pty
// reports it). So a local window looks for its terminals in `pids`, a WSL
// window in `wsl.pids` — and only for its own distro — and any other remote
// (SSH, containers) never answers: its PIDs are another machine's.
//
// On a match the terminal is shown and focused inside its window
// (`terminal.show(false)`); bringing the window itself to the front is the
// app's job, which is what `window` is for: `vscode.workspace.name` is the very
// string VS Code puts in the title as `${rootName}` (both come from
// labelService.getWorkspaceLabel), so the app can tell which window to raise.

import * as crypto from "node:crypto";
import * as net from "node:net";

export const PROTOCOL_VERSION = 1;
/** A request is a few hundred bytes; anything this long is not one. */
export const MAX_REQUEST_BYTES = 16 * 1024;
/** More ancestors than any real chain has (the relay stops at 24). */
export const MAX_PIDS = 64;
/** A connection that has not sent its line by then is dropped. */
export const CONNECTION_TIMEOUT_MS = 2_000;
/** How long one terminal may take to say its PID before it is skipped. */
export const PROCESS_ID_TIMEOUT_MS = 500;

/** Where this window's terminals run, hence which PIDs can be theirs. */
export type WindowKind =
  | { kind: "local" }
  /** `distro` is null when the window has no folder to read it from. */
  | { kind: "wsl"; distro: string | null }
  | { kind: "other"; remote: string };

/** The part of `vscode.Terminal` this needs. */
export interface TerminalLike {
  readonly name: string;
  readonly processId: PromiseLike<number | undefined>;
  show(preserveFocus?: boolean): void;
}

/** The part of the `vscode` API this needs: one window. */
export interface Host {
  windowKind(): WindowKind;
  /** `vscode.workspace.name`, or null in a window with no folder. */
  windowName(): string | null;
  terminals(): readonly TerminalLike[];
}

export interface Request {
  v: typeof PROTOCOL_VERSION;
  /** Windows PIDs, nearest first. */
  pids: number[];
  /** Linux PIDs inside `distro`, nearest first; null for a Windows session. */
  wsl: { distro: string; pids: number[] } | null;
}

export type Reply =
  | { matched: true; terminal: string; window: string | null }
  | { matched: false; error?: string };

// ── Names ─────────────────────────────────────────────────────────────────────

/**
 * COUCOU_INSTANCE, read with the relay's rules (hook/src/instance.rs): unset or
 * blank is the real install (`name: null`), otherwise 1–32 ASCII letters or
 * digits, case folded. Anything else is unusable — and must not fall back to
 * the real install's name.
 */
export function parseInstance(value: string | undefined): { usable: true; name: string | null } | { usable: false } {
  const text = (value ?? "").trim();
  if (!text) return { usable: true, name: null };
  const name = text.toLowerCase();
  return /^[a-z0-9]{1,32}$/.test(name) ? { usable: true, name } : { usable: false };
}

/** `\\.\pipe\coucou[-<instance>]-vscode-<pid>-<token>`. */
export function pipeName(instance: string | null, pid: number, token: string): string {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`not a process id: ${pid}`);
  if (!/^[0-9a-f]{16}$/.test(token)) throw new Error(`not a pipe token: ${token}`);
  return `\\\\.\\pipe\\coucou${instance ? `-${instance}` : ""}-vscode-${pid}-${token}`;
}

/** 16 random hex digits: two windows' extension hosts never share a pipe. */
export const randomToken = () => crypto.randomBytes(8).toString("hex");

// ── Requests ──────────────────────────────────────────────────────────────────

const isPid = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) > 0 && (n as number) <= 0xffff_ffff;

function pidList(value: unknown, what: string): number[] | string {
  if (!Array.isArray(value)) return `${what} is not a list`;
  if (value.length > MAX_PIDS) return `${what} has more than ${MAX_PIDS} entries`;
  if (!value.every(isPid)) return `${what} holds something that is not a process id`;
  return value as number[];
}

/** A request line, or why it is not one. Nothing in it is trusted further than this. */
export function parseRequest(line: string): Request | string {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return "not JSON";
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return "not a JSON object";
  const obj = raw as Record<string, unknown>;
  if (obj.v !== PROTOCOL_VERSION) return `unsupported version ${JSON.stringify(obj.v)}`;
  const pids = pidList(obj.pids ?? [], "pids");
  if (typeof pids === "string") return pids;
  let wsl: Request["wsl"] = null;
  if (obj.wsl !== undefined && obj.wsl !== null) {
    if (typeof obj.wsl !== "object" || Array.isArray(obj.wsl)) return "wsl is not an object";
    const w = obj.wsl as Record<string, unknown>;
    // WSL's own rule for distro names.
    if (typeof w.distro !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(w.distro)) return "wsl.distro is not a distro name";
    const linux = pidList(w.pids, "wsl.pids");
    if (typeof linux === "string") return linux;
    wsl = { distro: w.distro, pids: linux };
  }
  return { v: PROTOCOL_VERSION, pids, wsl };
}

/** The PIDs this window's terminals could have, nearest first. */
export function candidatePids(request: Request, window: WindowKind): number[] {
  switch (window.kind) {
    case "local":
      return request.pids;
    case "wsl": {
      const wsl = request.wsl;
      if (!wsl) return [];
      // Distro names compare case-insensitively, as WSL does.
      const same = window.distro === null || window.distro.toLowerCase() === wsl.distro.toLowerCase();
      return same ? wsl.pids : [];
    }
    case "other":
      return [];
  }
}

/** A terminal's PID, or undefined if it has none, fails, or takes too long. */
async function processIdOf(terminal: TerminalLike, timeoutMs: number): Promise<number | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve(terminal.processId).then(undefined, () => undefined), late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The terminal whose shell is the nearest of `pids`. Nearest wins: the chain
 * runs from the session up through VS Code's own processes, and only its
 * first terminal shell is the session's.
 */
export async function findTerminal<T extends TerminalLike>(
  pids: readonly number[],
  terminals: readonly T[],
  timeoutMs = PROCESS_ID_TIMEOUT_MS,
): Promise<T | null> {
  if (pids.length === 0 || terminals.length === 0) return null;
  const ids = await Promise.all(terminals.map((t) => processIdOf(t, timeoutMs)));
  for (const pid of pids) {
    const i = ids.indexOf(pid);
    if (i >= 0) return terminals[i];
  }
  return null;
}

/** Answers one request line for this window; shows the terminal on a match. */
export async function handle(line: string, host: Host): Promise<Reply> {
  const request = parseRequest(line);
  if (typeof request === "string") return { matched: false, error: request };
  const terminal = await findTerminal(candidatePids(request, host.windowKind()), host.terminals());
  if (!terminal) return { matched: false };
  try {
    // false: take the keyboard focus too, as clicking the tab would.
    terminal.show(false);
  } catch (err) {
    return { matched: false, error: `could not show the terminal: ${String(err)}` };
  }
  return { matched: true, terminal: terminal.name, window: host.windowName() };
}

// ── The pipe ──────────────────────────────────────────────────────────────────

export interface ServeOptions {
  pipeName: string;
  log?: (line: string) => void;
  /** Called with each request line and the reply sent for it (tests). */
  onAnswer?: (line: string, reply: Reply) => void;
}

/**
 * Serves `host` on `pipeName` until the returned server is closed. Each
 * connection gets one answer: to its first line, or an error once it has sent
 * more than a request can be. Connections that say nothing are dropped.
 */
export function serve(host: Host, options: ServeOptions): Promise<net.Server> {
  const log = options.log ?? (() => undefined);
  const server = net.createServer((socket) => {
    let buffered = Buffer.alloc(0);
    let answered = false;
    const answer = (line: string, reply: Reply) => {
      options.onAnswer?.(line, reply);
      if (reply.matched) log(`terminal "${reply.terminal}" shown`);
      else if (reply.error) log(`bad request: ${reply.error}`);
      if (!socket.destroyed) socket.end(`${JSON.stringify(reply)}\n`);
    };
    socket.setTimeout(CONNECTION_TIMEOUT_MS, () => socket.destroy());
    socket.on("error", () => undefined);
    socket.on("data", (chunk: Buffer) => {
      if (answered) return;
      buffered = Buffer.concat([buffered, chunk]);
      const newline = buffered.indexOf(0x0a);
      if (newline < 0) {
        if (buffered.length > MAX_REQUEST_BYTES) {
          answered = true;
          answer("", { matched: false, error: "request too large" });
        }
        return;
      }
      answered = true;
      const line = buffered.subarray(0, newline).toString("utf8");
      handle(line, host).then(
        (reply) => answer(line, reply),
        (err: unknown) => answer(line, { matched: false, error: String(err) }),
      );
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.pipeName, () => {
      server.off("error", reject);
      server.on("error", (err) => log(`pipe error: ${String(err)}`));
      log(`serving ${options.pipeName}`);
      resolve(server);
    });
  });
}
