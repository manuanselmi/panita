// Coucou — terminal focus: the `vscode` side of server.ts.
//
// Runs in the *local* extension host of every window (`extensionKind: ["ui"]`),
// Remote-WSL windows included, because the named pipe Coucou talks to is a
// Windows one. The terminal API is the window's, whichever extension host asks:
// a UI extension in a Remote-WSL window sees the remote terminals, and their
// `processId` is the Linux shell's PID (the remote pty reports it).
//
// Nothing is read from the workspace and nothing leaves the machine: the pipe
// only answers which of this window's terminals, if any, has a given shell
// PID, and shows that one.

import * as vscode from "vscode";
import { parseInstance, pipeName, randomToken, serve, type Host, type WindowKind } from "./server";

/** `wsl+Ubuntu-24.04` → `Ubuntu-24.04`, from the window's folders or workspace file. */
function wslDistro(): string | null {
  const uris = [
    ...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri),
    ...(vscode.workspace.workspaceFile ? [vscode.workspace.workspaceFile] : []),
  ];
  for (const uri of uris) {
    if (uri.scheme === "vscode-remote" && uri.authority.toLowerCase().startsWith("wsl+")) {
      return decodeURIComponent(uri.authority.slice(4));
    }
  }
  return null;
}

function windowKind(): WindowKind {
  const remote = vscode.env.remoteName;
  if (!remote) return { kind: "local" };
  if (remote === "wsl") return { kind: "wsl", distro: wslDistro() };
  return { kind: "other", remote };
}

const host: Host = {
  windowKind,
  windowName: () => vscode.workspace.name ?? null,
  terminals: () => vscode.window.terminals,
};

/** What `activate` hands back: VS Code exposes it as the extension's exports. */
export interface Exports {
  /** The pipe this window serves, or null when it serves none. */
  pipeName: string | null;
}

export async function activate(context: vscode.ExtensionContext): Promise<Exports> {
  const output = vscode.window.createOutputChannel("Coucou terminal focus", { log: true });
  context.subscriptions.push(output);

  const instance = parseInstance(process.env.COUCOU_INSTANCE);
  if (!instance.usable) {
    // A side instance was meant; answering under the real install's name is
    // exactly what must not happen.
    output.warn("COUCOU_INSTANCE is not a usable instance name; not serving.");
    return { pipeName: null };
  }
  const name = pipeName(instance.name, process.pid, randomToken());
  try {
    const server = await serve(host, { pipeName: name, log: (line) => output.info(line) });
    context.subscriptions.push({ dispose: () => server.close() });
  } catch (err) {
    output.error(`could not serve ${name}: ${String(err)}`);
    return { pipeName: null };
  }
  return { pipeName: name };
}

export function deactivate() {
  // The server is closed through context.subscriptions.
}
