// A stand-in for the `vscode` module, for the companion extension's tests
// (vitest.config.ts aliases `vscode` to this file). Only what
// vscode-extension/src/extension.ts touches, driven by `mock` below.

export class Uri {
  constructor(
    readonly scheme: string,
    readonly authority: string,
    readonly path: string,
  ) {}

  /** `scheme://authority/path`, enough for the folder URIs the tests use. */
  static parse(text: string): Uri {
    const m = /^([a-z][a-z0-9+.-]*):\/\/([^/]*)(\/.*)?$/i.exec(text);
    if (!m) throw new Error(`not a URI: ${text}`);
    return new Uri(m[1], m[2], m[3] ?? "/");
  }
}

export interface FakeTerminal {
  name: string;
  processId: PromiseLike<number | undefined>;
  show: (preserveFocus?: boolean) => void;
}

/** What the fake VS Code window looks like, and what the extension did to it. */
export const mock = {
  remoteName: undefined as string | undefined,
  workspaceName: undefined as string | undefined,
  folders: [] as Uri[],
  workspaceFile: undefined as Uri | undefined,
  terminals: [] as FakeTerminal[],
  log: [] as string[],
  reset() {
    this.remoteName = undefined;
    this.workspaceName = undefined;
    this.folders = [];
    this.workspaceFile = undefined;
    this.terminals = [];
    this.log = [];
  },
};

export const env = {
  get remoteName() {
    return mock.remoteName;
  },
};

export const workspace = {
  get name() {
    return mock.workspaceName;
  },
  get workspaceFolders() {
    return mock.folders.length ? mock.folders.map((uri, index) => ({ uri, index, name: uri.path })) : undefined;
  },
  get workspaceFile() {
    return mock.workspaceFile;
  },
};

export const window = {
  get terminals() {
    return mock.terminals;
  },
  createOutputChannel(name: string) {
    const say = (level: string) => (message: string) => mock.log.push(`${level} ${message}`);
    return { name, info: say("info"), warn: say("warn"), error: say("error"), dispose() {} };
  },
};
