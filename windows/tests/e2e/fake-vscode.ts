// A fake VS Code window for the end-to-end suite: the companion extension's
// own pipe server (vscode-extension/src/server.ts), run in this Node process
// with terminals the test makes up. It serves the side instance's pipe name
// (`coucou-<instance>-vscode-*`), so the side instance finds it exactly as it
// would find a real window started with that COUCOU_INSTANCE — and never a
// real window: those (if any) serve `coucou-vscode-*`, which a side instance
// does not look at, and the suite never connects to any pipe itself.

import type net from "node:net";
import {
  parseRequest,
  pipeName,
  randomToken,
  serve,
  type Host,
  type Reply,
  type Request,
  type TerminalLike,
  type WindowKind,
} from "../../vscode-extension/src/server";
import { INSTANCE, pipeNames } from "./harness";

export interface FakeTerminal extends TerminalLike {
  /** Every `show(preserveFocus)` the extension made. */
  shows: (boolean | undefined)[];
}

export class FakeVsCodeWindow {
  /** Requests received (parsed), and what was answered, in order. */
  readonly requests: Request[] = [];
  readonly replies: Reply[] = [];
  readonly terminals: FakeTerminal[] = [];

  private constructor(
    readonly pipe: string,
    private readonly server: net.Server,
  ) {}

  static async start(window: WindowKind, windowName: string | null): Promise<FakeVsCodeWindow> {
    let self: FakeVsCodeWindow | null = null;
    const host: Host = {
      windowKind: () => window,
      windowName: () => windowName,
      terminals: () => self?.terminals ?? [],
    };
    const pipe = pipeName(INSTANCE, process.pid, randomToken());
    const server = await serve(host, {
      pipeName: pipe,
      onAnswer: (line, reply) => {
        const request = parseRequest(line);
        if (typeof request !== "string") self?.requests.push(request);
        self?.replies.push(reply);
      },
    });
    self = new FakeVsCodeWindow(pipe, server);
    return self;
  }

  /** A terminal tab whose shell has `pid`. */
  addTerminal(name: string, pid: number): FakeTerminal {
    const shows: (boolean | undefined)[] = [];
    const terminal: FakeTerminal = { name, processId: Promise.resolve(pid), show: (p) => void shows.push(p), shows };
    this.terminals.push(terminal);
    return terminal;
  }

  /** Our pipe's bare name, as `\\.\pipe\` lists it. */
  get listedName(): string {
    return this.pipe.replace(/^\\\\\.\\pipe\\/, "");
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

/**
 * A window whose extension is wedged: it takes the connection and never says
 * a word. The app must give up on it on its own clock.
 */
export async function startSilentWindow(): Promise<{ close(): Promise<void> }> {
  const { createServer } = await import("node:net");
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(pipeName(INSTANCE, process.pid, randomToken()), () => resolve());
  });
  return {
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

/** The side instance's extension pipes that exist right now (listed, never opened). */
export function sideExtensionPipes(): string[] {
  const prefix = `coucou-${INSTANCE}-vscode-`;
  return pipeNames().filter((name) => name.startsWith(prefix));
}
