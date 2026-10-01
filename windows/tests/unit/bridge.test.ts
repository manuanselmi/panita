// The Tauri bridge (src/core/bridge.ts): the command names and argument
// shapes the Rust side expects, and what a failed call turns into. Tauri maps
// camelCase keys onto the Rust command's snake_case parameters, so
// `wslDistro` here is `wsl_distro` in `open_session` (lib.rs). The end-to-end
// suite checks the real round trip; this pins the contract.

import { afterEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: vi.fn() }));

/** A fresh bridge, inside Coucou (`__TAURI_INTERNALS__` present) or in a plain browser. */
async function load(inCoucou: boolean) {
  vi.resetModules();
  invoke.mockReset();
  vi.stubGlobal("window", inCoucou ? { __TAURI_INTERNALS__: {} } : undefined);
  return (await import("../../src/core/bridge")).Bridge;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("openSession", () => {
  it("calls open_session with the session's cwd, WSL distro and session id", async () => {
    const Bridge = await load(true);
    invoke.mockResolvedValue("focused");
    expect(await Bridge.openSession("/home/u/proj", "Ubuntu-24.04", "s-1")).toBe("focused");
    expect(invoke).toHaveBeenCalledWith("open_session", { cwd: "/home/u/proj", wslDistro: "Ubuntu-24.04", sessionId: "s-1" });

    invoke.mockResolvedValue("opened");
    expect(await Bridge.openSession(String.raw`C:\work\app`, null)).toBe("opened");
    // `sessionId` is `session_id` in Rust; without one the app skips the terminal step.
    expect(invoke).toHaveBeenLastCalledWith("open_session", { cwd: String.raw`C:\work\app`, wslDistro: null, sessionId: null });
  });

  it("reports every outcome as is", async () => {
    const Bridge = await load(true);
    for (const outcome of ["focused", "opened", "explorer", "failed"] as const) {
      invoke.mockResolvedValue(outcome);
      expect(await Bridge.openSession(null, null)).toBe(outcome);
    }
  });

  it("is 'failed' when the command errors — it never throws", async () => {
    const Bridge = await load(true);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    invoke.mockRejectedValue(new Error("command open_session not found"));
    await expect(Bridge.openSession("/home/u", "Ubuntu-24.04")).resolves.toBe("failed");
  });

  it("is 'failed' outside Coucou, without calling anything", async () => {
    const Bridge = await load(false);
    expect(await Bridge.openSession("/home/u", null)).toBe("failed");
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("hook targets", () => {
  it("pass the target through, and leave it out for Windows", async () => {
    const Bridge = await load(true);
    invoke.mockResolvedValue(null);
    await Bridge.hooksStatus();
    expect(invoke).toHaveBeenLastCalledWith("hooks_status", { target: undefined, start: false });
    await Bridge.hooksStatus("wsl:Ubuntu-24.04", true);
    expect(invoke).toHaveBeenLastCalledWith("hooks_status", { target: "wsl:Ubuntu-24.04", start: true });

    invoke.mockResolvedValue({ diff: "", backup: "", settingsPath: "", fingerprint: "f" });
    await Bridge.hooksPreview(true, "wsl:Ubuntu-24.04");
    expect(invoke).toHaveBeenLastCalledWith("hooks_preview", { install: true, target: "wsl:Ubuntu-24.04" });
    await Bridge.hooksApply(false, "f", "wsl:Ubuntu-24.04");
    expect(invoke).toHaveBeenLastCalledWith("hooks_apply", { install: false, fingerprint: "f", target: "wsl:Ubuntu-24.04" });
    await Bridge.hooksApply(true, "f");
    expect(invoke).toHaveBeenLastCalledWith("hooks_apply", { install: true, fingerprint: "f", target: undefined });
  });

  it("the companion VS Code extension: status quietly, install loudly", async () => {
    const Bridge = await load(true);
    const status = { codePath: "C:/x/code.cmd", installed: null, bundled: "0.1.0", vsixPath: "C:/x.vsix", upToDate: false, error: null };
    invoke.mockResolvedValue(status);
    expect(await Bridge.vscodeExtensionStatus()).toEqual(status);
    expect(invoke).toHaveBeenLastCalledWith("vscode_extension_status", undefined);
    invoke.mockResolvedValue("installed");
    await Bridge.vscodeExtensionInstall();
    expect(invoke).toHaveBeenLastCalledWith("vscode_extension_install", undefined);
    // An install that fails must reach the button that asked for it.
    invoke.mockRejectedValue("VS Code could not install it");
    await expect(Bridge.vscodeExtensionInstall()).rejects.toBe("VS Code could not install it");
  });

  it("surface preview and apply errors so the settings window can show them", async () => {
    const Bridge = await load(true);
    invoke.mockRejectedValue("settings.json isn't valid JSON");
    await expect(Bridge.hooksPreview(true, "windows")).rejects.toBe("settings.json isn't valid JSON");
    await expect(Bridge.hooksApply(true, "f", "windows")).rejects.toBe("settings.json isn't valid JSON");
  });
});
