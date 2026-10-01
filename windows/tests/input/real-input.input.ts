// ⚠  MOVES THE REAL MOUSE AND CLICKS. Run only on an idle desktop you are not
// using, and only on purpose:
//
//     set COUCOU_ALLOW_REAL_INPUT=1 && npm run test:input
//
// Without that variable every test here is skipped. Neither `npm test` nor
// `npm run test:e2e` ever runs this file.
//
// SCAFFOLD: written alongside the end-to-end suite but never run by its author
// (it was built on a machine somebody was working on). Expect to adjust it the
// first time you run it. It covers what CDP cannot fake (TESTING.md):
//   * hover-to-reveal: the hidden island wakes when the pointer touches the
//     strip at the top-centre of the primary display;
//   * a real click on the island opens it without taking the foreground from
//     whatever window had it (WS_EX_NOACTIVATE).
//
// It runs the same side instance as the end-to-end suite (COUCOU_INSTANCE=e2e).
// Before any click it checks, with WindowFromPoint, that the window under the
// pointer belongs to that instance's process — a click never lands on anything
// else. The pointer is put back where it was at the end.

import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Cdp } from "../e2e/cdp";
import { type RunningApp, launchApp, removeSideDirs, stopApp, userSid, waitFor } from "../e2e/harness";
import { IslandPage, SIZES } from "../e2e/island-page";

const ALLOWED = process.env.COUCOU_ALLOW_REAL_INPUT === "1";

const WIN32 = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class In {
  [StructLayout(LayoutKind.Sequential)] public struct P { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out P p);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(P p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
}
"@
`;

/** Runs a PowerShell snippet with the Win32 helpers above and returns its JSON. */
function win32<T>(snippet: string): T {
  const script = `${WIN32}\n${snippet} | ConvertTo-Json -Compress`;
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (r.status !== 0) throw new Error(`powershell: ${r.stderr}`);
  return JSON.parse(r.stdout.trim()) as T;
}

const cursor = () => win32<{ X: number; Y: number }>(`$p = New-Object In+P; [void][In]::GetCursorPos([ref]$p); $p`);
const moveTo = (x: number, y: number) => win32<boolean>(`[In]::SetCursorPos(${x}, ${y})`);
const foreground = () => win32<number>(`[In]::GetForegroundWindow().ToInt64()`);
/** Primary display size (SM_CXSCREEN / SM_CYSCREEN), in this PowerShell's coordinates. */
const screen = () => win32<{ w: number; h: number }>(`@{ w = [In]::GetSystemMetrics(0); h = [In]::GetSystemMetrics(1) }`);
/**
 * PID owning the top-level window under the pointer. The top-level one (GA_ROOT):
 * the island's webview child window belongs to the WebView2 browser process.
 */
const ownerUnderPointer = () =>
  win32<number>(
    `$p = New-Object In+P; [void][In]::GetCursorPos([ref]$p); ` +
      `$top = [In]::GetAncestor([In]::WindowFromPoint($p), 2); ` +
      `[uint32]$owner = 0; [void][In]::GetWindowThreadProcessId($top, [ref]$owner); $owner`,
  );
const clickHere = () => win32<boolean>(`[In]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 60; [In]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero); $true`);

describe.runIf(ALLOWED)("real input — moves the mouse", () => {
  let app: RunningApp;
  let cdp: Cdp;
  let page: IslandPage;
  let home: { X: number; Y: number };

  beforeAll(async () => {
    home = cursor();
    app = await launchApp(userSid());
    ({ cdp } = await Cdp.connect(app.port, (t) => t.title === "Coucou"));
    page = new IslandPage(cdp);
    await waitFor("the greeting to finish", async () => !(await page.greetingVisible()), 20_000, 200);
  }, 120_000);

  afterAll(async () => {
    if (home) moveTo(home.X, home.Y);
    if (app) await stopApp(app, () => page?.quit() ?? Promise.resolve());
    cdp?.close();
    removeSideDirs();
  }, 60_000);

  it("hovering the top-centre strip wakes the hidden island", async () => {
    const { w, h } = screen();
    // Away from the island, then wait out the 60 s petit → hidden delay.
    moveTo(Math.round(w / 2), Math.round(h / 2));
    await waitFor("the island to hide", async () => (await page.box()).height <= 1, 90_000, 500);

    moveTo(Math.round(w / 2), 1);
    await waitFor(
      "the island to peek out",
      async () => {
        const b = await page.box();
        return b.width === SIZES.compact.width && b.height === SIZES.compact.height;
      },
      3_000,
    );
  }, 120_000);

  it("a real click opens the island and leaves the foreground window alone", async () => {
    const { w } = screen();
    moveTo(Math.round(w / 2), 12); // inside the compact island (32 px tall)
    await page.settle();
    // Never click unless the pointer is on the side instance's own window.
    expect(ownerUnderPointer()).toBe(app.pid);

    const before = foreground();
    clickHere();
    await waitFor("the island to open", async () => (await page.settle()).width === SIZES.expanded.width, 3_000);
    expect(foreground()).toBe(before);
  }, 30_000);
});
