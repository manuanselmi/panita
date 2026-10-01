// The companion VS Code extension (vscode-extension/): the pipe protocol and
// terminal matching in server.ts, run in plain Node with fake terminals, and
// the `vscode` glue in extension.ts against a stand-in `vscode` module
// (vscode-mock.ts). Real named pipes are used, but only under the instance name
// `unittest` — `\\.\pipe\coucou-unittest-vscode-*` — which no real Coucou or
// VS Code ever looks at.

import net from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONNECTION_TIMEOUT_MS,
  MAX_PIDS,
  MAX_REQUEST_BYTES,
  candidatePids,
  findTerminal,
  handle,
  parseInstance,
  parseRequest,
  pipeName,
  randomToken,
  serve,
  type Host,
  type Request,
  type TerminalLike,
  type WindowKind,
} from "../../vscode-extension/src/server";
import { Uri, mock, type FakeTerminal } from "./vscode-mock";

const INSTANCE = "unittest";

/** A terminal whose shell has `pid` (or never says), recording each show(). */
function terminal(name: string, pid: number | undefined | "never" | "fails"): FakeTerminal & { shown: (boolean | undefined)[] } {
  const shown: (boolean | undefined)[] = [];
  const processId =
    pid === "never" ? new Promise<undefined>(() => undefined)
    : pid === "fails" ? Promise.reject(new Error("disposed"))
    : Promise.resolve(pid);
  // A rejected promise nobody awaits yet must not fail the test run.
  processId.catch(() => undefined);
  return { name, processId, show: (preserveFocus?: boolean) => void shown.push(preserveFocus), shown };
}

function host(kind: WindowKind, terminals: TerminalLike[], name: string | null = "panita"): Host {
  return { windowKind: () => kind, windowName: () => name, terminals: () => terminals };
}

const LOCAL: WindowKind = { kind: "local" };
const req = (pids: number[], wsl: Request["wsl"] = null): string => JSON.stringify({ v: 1, pids, wsl });

/** One request over a real pipe; the reply line, or "" if the server closed without one. */
function ask(pipe: string, text: string | Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(pipe);
    let reply = "";
    socket.on("data", (d) => (reply += d));
    socket.on("end", () => resolve(reply));
    socket.on("close", () => resolve(reply));
    socket.on("error", reject);
    socket.write(text);
  });
}

const sidePipe = () => pipeName(INSTANCE, process.pid, randomToken());

describe("names", () => {
  it("reads COUCOU_INSTANCE with the relay's rules", () => {
    expect(parseInstance(undefined)).toEqual({ usable: true, name: null });
    expect(parseInstance("   ")).toEqual({ usable: true, name: null });
    expect(parseInstance(" Dev ")).toEqual({ usable: true, name: "dev" });
    expect(parseInstance("a".repeat(32))).toEqual({ usable: true, name: "a".repeat(32) });
    for (const bad of ["my dev", "dev-1", "dév", "../x", "a".repeat(33)]) {
      expect(parseInstance(bad), bad).toEqual({ usable: false });
    }
  });

  it("names the pipe per instance, the way the app's terminal.rs looks for it", () => {
    const token = "0123456789abcdef";
    expect(pipeName(null, 4242, token)).toBe(String.raw`\\.\pipe\coucou-vscode-4242-0123456789abcdef`);
    expect(pipeName("ext", 4242, token)).toBe(String.raw`\\.\pipe\coucou-ext-vscode-4242-0123456789abcdef`);
    expect(randomToken()).toMatch(/^[0-9a-f]{16}$/);
    expect(randomToken()).not.toBe(randomToken());
    expect(() => pipeName(null, 0, token)).toThrow();
    expect(() => pipeName(null, 1.5, token)).toThrow();
    expect(() => pipeName(null, 1, "XYZ")).toThrow();
  });
});

describe("requests", () => {
  it("accepts the documented shapes", () => {
    expect(parseRequest(req([40, 30]))).toEqual({ v: 1, pids: [40, 30], wsl: null });
    expect(parseRequest('{"v":1,"pids":[1]}')).toEqual({ v: 1, pids: [1], wsl: null });
    expect(parseRequest('{"v":1,"wsl":{"distro":"Ubuntu-24.04","pids":[79609,2057]}}')).toEqual({
      v: 1, pids: [], wsl: { distro: "Ubuntu-24.04", pids: [79609, 2057] },
    });
  });

  it("refuses anything else, saying why", () => {
    const bad: [string, RegExp][] = [
      ["", /not JSON/],
      ["{", /not JSON/],
      ["[1,2]", /not a JSON object/],
      ["null", /not a JSON object/],
      ['"x"', /not a JSON object/],
      ['{"pids":[1]}', /unsupported version/],
      ['{"v":2,"pids":[1]}', /unsupported version/],
      ['{"v":"1","pids":[1]}', /unsupported version/],
      ['{"v":1,"pids":"1"}', /pids is not a list/],
      ['{"v":1,"pids":[0]}', /not a process id/],
      ['{"v":1,"pids":[-4]}', /not a process id/],
      ['{"v":1,"pids":[1.5]}', /not a process id/],
      ['{"v":1,"pids":["5"]}', /not a process id/],
      ['{"v":1,"pids":[4294967296]}', /not a process id/],
      ['{"v":1,"pids":[null]}', /not a process id/],
      [JSON.stringify({ v: 1, pids: Array.from({ length: MAX_PIDS + 1 }, (_, i) => i + 1) }), /more than/],
      ['{"v":1,"pids":[],"wsl":[1]}', /wsl is not an object/],
      ['{"v":1,"pids":[],"wsl":"Ubuntu"}', /wsl is not an object/],
      ['{"v":1,"pids":[],"wsl":{"distro":"my distro","pids":[1]}}', /distro name/],
      ['{"v":1,"pids":[],"wsl":{"distro":"x;rm -rf ~","pids":[1]}}', /distro name/],
      ['{"v":1,"pids":[],"wsl":{"pids":[1]}}', /distro name/],
      ['{"v":1,"pids":[],"wsl":{"distro":"Ubuntu"}}', /wsl.pids is not a list/],
    ];
    for (const [line, why] of bad) expect(parseRequest(line), line).toMatch(why);
  });

  it("a window looks only at the PIDs of the machine its terminals run on", () => {
    const r: Request = { v: 1, pids: [40, 30], wsl: { distro: "Ubuntu-24.04", pids: [79609, 2057] } };
    expect(candidatePids(r, LOCAL)).toEqual([40, 30]);
    expect(candidatePids(r, { kind: "wsl", distro: "Ubuntu-24.04" })).toEqual([79609, 2057]);
    expect(candidatePids(r, { kind: "wsl", distro: "ubuntu-24.04" })).toEqual([79609, 2057]);
    // A folderless WSL window cannot tell its distro: it may answer.
    expect(candidatePids(r, { kind: "wsl", distro: null })).toEqual([79609, 2057]);
    // Another distro's PIDs are another namespace's.
    expect(candidatePids(r, { kind: "wsl", distro: "Debian" })).toEqual([]);
    // SSH, containers: another machine.
    expect(candidatePids(r, { kind: "other", remote: "ssh-remote" })).toEqual([]);
    // A Windows session asks no WSL window anything.
    expect(candidatePids({ ...r, wsl: null }, { kind: "wsl", distro: null })).toEqual([]);
  });
});

describe("matching", () => {
  it("the nearest ancestor wins, whatever the order of the tabs", async () => {
    // relay → bash 40 → claude 30 → pwsh 20 (the session's tab) → Code 10.
    const session = terminal("pwsh", 20);
    const other = terminal("other", 99);
    const code = terminal("weird", 10);
    expect(await findTerminal([40, 30, 20, 10], [code, other, session])).toBe(session);
    expect(await findTerminal([40, 30, 20, 10], [other])).toBeNull();
    expect(await findTerminal([], [session])).toBeNull();
    expect(await findTerminal([20], [])).toBeNull();
  });

  it("a terminal that has no PID, fails or never answers is skipped, in bounded time", async () => {
    const session = terminal("bash", 20);
    const started = Date.now();
    const found = await findTerminal([20], [terminal("a", undefined), terminal("b", "fails"), terminal("c", "never"), session], 100);
    expect(found).toBe(session);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("handle shows the match and focuses it, and names the window", async () => {
    const session = terminal("pwsh", 20);
    const other = terminal("node", 21);
    expect(await handle(req([30, 20]), host(LOCAL, [other, session]))).toEqual({
      matched: true, terminal: "pwsh", window: "panita",
    });
    expect(session.shown).toEqual([false]);
    expect(other.shown).toEqual([]);
    // A window without a folder says so.
    expect(await handle(req([20]), host(LOCAL, [session], null))).toEqual({ matched: true, terminal: "pwsh", window: null });
  });

  it("no match, a bad request or a show that throws all answer matched: false", async () => {
    const session = terminal("pwsh", 20);
    expect(await handle(req([1, 2]), host(LOCAL, [session]))).toEqual({ matched: false });
    expect(await handle("garbage", host(LOCAL, [session]))).toEqual({ matched: false, error: "not JSON" });
    const broken: TerminalLike = { name: "x", processId: Promise.resolve(20), show: () => { throw new Error("disposed"); } };
    expect(await handle(req([20]), host(LOCAL, [broken]))).toMatchObject({ matched: false, error: expect.stringMatching(/disposed/) });
    expect(session.shown).toEqual([]);
  });
});

describe("the pipe", () => {
  let closeServer: (() => Promise<void>) | null = null;
  afterEach(async () => {
    await closeServer?.();
    closeServer = null;
  });

  async function start(h: Host, onAnswer?: (line: string) => void) {
    const name = sidePipe();
    const server = await serve(h, { pipeName: name, onAnswer });
    closeServer = () => new Promise((r) => server.close(() => r()));
    return name;
  }

  it("answers one JSON line with one JSON line", async () => {
    const session = terminal("pwsh", 20);
    const seen: string[] = [];
    const name = await start(host(LOCAL, [session]), (line) => seen.push(line));
    const reply = await ask(name, `${req([30, 20])}\n`);
    expect(reply.endsWith("\n")).toBe(true);
    expect(JSON.parse(reply)).toEqual({ matched: true, terminal: "pwsh", window: "panita" });
    expect(seen).toEqual([req([30, 20])]);
    expect(session.shown).toEqual([false]);
    // Chunked writes are reassembled; only the first line counts.
    const again = await ask(name, Buffer.from(`${req([999])}\n${req([20])}\n`));
    expect(JSON.parse(again)).toEqual({ matched: false });
  });

  it("malformed input gets an error answer, not a crash", async () => {
    const name = await start(host(LOCAL, [terminal("pwsh", 20)]));
    expect(JSON.parse(await ask(name, "not json\n"))).toEqual({ matched: false, error: "not JSON" });
    expect(JSON.parse(await ask(name, Buffer.from([0xff, 0xfe, 0x0a])))).toMatchObject({ matched: false });
    expect(JSON.parse(await ask(name, "x".repeat(MAX_REQUEST_BYTES + 10)))).toEqual({
      matched: false, error: "request too large",
    });
    // Still serving.
    expect(JSON.parse(await ask(name, `${req([20])}\n`))).toMatchObject({ matched: true });
  });

  it("a connection that never sends its line is dropped", async () => {
    const name = await start(host(LOCAL, []));
    const started = Date.now();
    expect(await ask(name, "{")).toBe("");
    const waited = Date.now() - started;
    expect(waited).toBeGreaterThanOrEqual(CONNECTION_TIMEOUT_MS - 100);
    expect(waited).toBeLessThan(CONNECTION_TIMEOUT_MS + 2_000);
  }, CONNECTION_TIMEOUT_MS + 5_000);
});

describe("extension.ts in a VS Code window", () => {
  const disposers: { dispose(): unknown }[] = [];
  const context = { subscriptions: disposers };

  beforeEach(() => {
    mock.reset();
    vi.stubEnv("COUCOU_INSTANCE", INSTANCE);
  });
  afterEach(async () => {
    for (const d of disposers.splice(0)) await d.dispose();
    vi.unstubAllEnvs();
  });

  async function activate() {
    // Not reset between tests: the module reads the window lazily, and a fresh
    // copy would get a fresh `vscode` stand-in that `mock` no longer drives.
    const ext = await import("../../vscode-extension/src/extension");
    // The real ExtensionContext has far more; activate only uses subscriptions.
    return ext.activate(context as never);
  }

  it("a local window serves its instance's pipe and shows the matching terminal", async () => {
    const session = terminal("pwsh", process.pid);
    mock.terminals = [terminal("other", 1), session];
    mock.workspaceName = "panita";
    const { pipeName: name } = await activate();
    expect(name).toMatch(new RegExp(String.raw`^\\\\\.\\pipe\\coucou-${INSTANCE}-vscode-${process.pid}-[0-9a-f]{16}$`));
    expect(JSON.parse(await ask(name!, `${req([123456, process.pid])}\n`))).toEqual({
      matched: true, terminal: "pwsh", window: "panita",
    });
    expect(session.shown).toEqual([false]);
    // Linux PIDs mean nothing to a local window.
    expect(JSON.parse(await ask(name!, `${req([], { distro: "Ubuntu", pids: [process.pid] })}\n`))).toEqual({ matched: false });
    expect(mock.log.some((l) => l.includes(`serving ${name}`))).toBe(true);
  });

  it("a Remote-WSL window matches Linux PIDs of its own distro only", async () => {
    const shell = terminal("bash", 2057);
    mock.remoteName = "wsl";
    mock.folders = [Uri.parse("vscode-remote://wsl+Ubuntu-24.04/home/u/struxto")];
    mock.workspaceName = "struxto [WSL: Ubuntu-24.04]";
    mock.terminals = [shell];
    const { pipeName: name } = await activate();
    // The same number as a Windows PID: not this window's.
    expect(JSON.parse(await ask(name!, `${req([2057])}\n`))).toEqual({ matched: false });
    expect(JSON.parse(await ask(name!, `${req([], { distro: "Debian", pids: [2057] })}\n`))).toEqual({ matched: false });
    expect(JSON.parse(await ask(name!, `${req([5], { distro: "Ubuntu-24.04", pids: [79609, 2057] })}\n`))).toEqual({
      matched: true, terminal: "bash", window: "struxto [WSL: Ubuntu-24.04]",
    });
    expect(shell.shown).toEqual([false]);
  });

  it("a multi-root WSL workspace finds its distro in the workspace file", async () => {
    mock.remoteName = "wsl";
    // Distro names compare case-insensitively, as WSL does.
    mock.workspaceFile = Uri.parse("vscode-remote://wsl+debian/home/u/w.code-workspace");
    mock.terminals = [terminal("zsh", 77)];
    const { pipeName: name } = await activate();
    expect(JSON.parse(await ask(name!, `${req([], { distro: "Debian", pids: [77] })}\n`))).toMatchObject({ matched: true });
    expect(JSON.parse(await ask(name!, `${req([], { distro: "Ubuntu", pids: [77] })}\n`))).toEqual({ matched: false });
  });

  it("other remotes never answer", async () => {
    mock.remoteName = "ssh-remote";
    mock.terminals = [terminal("bash", 77)];
    const { pipeName: name } = await activate();
    expect(JSON.parse(await ask(name!, `${req([77], { distro: "Ubuntu", pids: [77] })}\n`))).toEqual({ matched: false });
  });

  it("an unusable COUCOU_INSTANCE serves nothing rather than the real install's name", async () => {
    vi.stubEnv("COUCOU_INSTANCE", "not usable!");
    expect(await activate()).toEqual({ pipeName: null });
    expect(mock.log).toEqual(["warn COUCOU_INSTANCE is not a usable instance name; not serving."]);
  });

  it("deactivating closes the pipe", async () => {
    const { pipeName: name } = await activate();
    for (const d of disposers.splice(0)) await d.dispose();
    await new Promise((r) => setTimeout(r, 50));
    await expect(ask(name!, `${req([1])}\n`)).rejects.toThrow(/ENOENT/);
  });
});
