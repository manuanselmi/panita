// End to end: the real coucou-hook.exe → named pipe → the real app → the island
// webview, and back. Runs Coucou as the side instance `e2e` (TESTING.md) and
// drives the island over CDP — DOM queries and element.click(), never the mouse.
//
// The tests in the middle block share one running app and run in order; each
// leaves the island with no approval card pending.

import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Cdp } from "./cdp";
import {
  INSTANCE,
  RESULTS_DIR,
  SANDBOX_HOME,
  type HookRun,
  type RealInstall,
  type RunningApp,
  launchApp,
  pipeNames,
  readSideLog,
  real,
  realLogSince,
  realPipeName,
  removeSideDirs,
  runHook,
  runHookInWsl,
  side,
  sideDirsLeft,
  sidePipeName,
  snapshotRealInstall,
  stopApp,
  userSid,
  sleep,
  waitFor,
  waitForLog,
  webviewProcesses,
  wslHookCommand,
  wslPath,
  wslTarget,
} from "./harness";
import { IslandPage, SIZES } from "./island-page";
import { SettingsPage } from "./settings-page";

// The documented PermissionRequest output (https://code.claude.com/docs/en/hooks),
// written out here on purpose rather than imported from the Rust side.
const ALLOW_JSON = `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}\n`;
const DENY_JSON = `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Denied from Coucou"}}}\n`;

/** Fire-and-forget events must let Claude Code go on almost at once. */
const QUICK_MS = 3_000;
const PROJECT = "coucou-e2e-project";
const CWD = `C:\\e2e\\${PROJECT}`;
const SLOW = process.env.COUCOU_E2E_SLOW === "1";

const sid = userSid();
let realBefore: RealInstall;
/** Set once events sent with the side instance's name are seen in its own log. */
let routingProven = false;
/** The same, for events sent from inside WSL. */
let wslRoutingProven = false;
/** The running WSL distro the WSL cases use, or why they are skipped. */
const wsl = wslTarget();
const WSL_CWD = "/home/e2e/coucou-e2e-wsl";
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const base = (extra: Record<string, unknown> = {}) => ({
  session_id: "e2e-session",
  transcript_path: String.raw`C:\e2e\transcript.jsonl`,
  cwd: CWD,
  ...extra,
});

const permission = (command: string) =>
  base({ permission_mode: "default", tool_name: "Bash", tool_input: { command, description: "e2e" } });

beforeAll(() => {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  realBefore = snapshotRealInstall(sid);
});

describe(`side instance "${INSTANCE}"`, () => {
  let app: RunningApp;
  let cdp: Cdp;
  let page: IslandPage;
  let settings: SettingsPage | undefined;
  /** The side instance's staged relay, as the WSL distro sees it. */
  let relayLinux = "";

  beforeAll(async () => {
    app = await launchApp(sid);
    ({ cdp } = await Cdp.connect(app.port, (t) => t.title === "Coucou" && !t.url.includes("settings")));
    page = new IslandPage(cdp);
    await page.watch();
    // Let the launch greeting play out so later events meet a resting island.
    await waitFor("the launch greeting to finish", async () => !(await page.greetingVisible()), 20_000, 200);
    await page.settle();
  }, 120_000);

  afterAll(async () => {
    try {
      if (page) {
        fs.writeFileSync(path.join(RESULTS_DIR, "island-console.log"), page.consoleLines.join("\n"));
        await page.screenshot("99-last").catch(() => undefined);
      }
      if (app) await stopApp(app, () => page?.quit() ?? Promise.resolve());
    } finally {
      settings?.cdp.close();
      cdp?.close();
      fs.writeFileSync(path.join(RESULTS_DIR, "side-instance.log"), readSideLog());
      removeSideDirs();
    }
  }, 60_000);

  it("starts isolated from the real install", async () => {
    expect(readSideLog()).toMatch(new RegExp(String.raw`--- Coucou \S+ started \(instance ${INSTANCE}\) ---`));
    expect(pipeNames()).toContain(sidePipeName(sid));
    expect(fs.existsSync(side.stagedHook)).toBe(true);

    // The WebView2 profile is the side instance's, and only its browser has the
    // debugging port — along with the island's usual flags from tauri.conf.json.
    const browser = webviewProcesses(side.webviewDir).filter((p) => !/--type=/.test(p.commandLine ?? ""));
    expect(browser.length).toBeGreaterThan(0);
    for (const p of browser) {
      expect(p.commandLine).toContain(`--remote-debugging-port=${app.port}`);
      expect(p.commandLine).toContain("--autoplay-policy=no-user-gesture-required");
      expect(p.commandLine).toContain("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection");
    }
    for (const p of webviewProcesses(real.webviewDir)) {
      expect(p.commandLine ?? "").not.toContain("--remote-debugging-port");
    }

    // The front end is the embedded build, not a dev server.
    const targets = await Cdp.targets(app.port);
    expect(targets.map((t) => t.url).sort()).toEqual(["http://tauri.localhost/", "http://tauri.localhost/settings.html"]);

    await page.screenshot("01-after-greeting");
  });

  it("forwards work events to the log and the island", async () => {
    const from = readSideLog().length;
    const runs = [
      await runHook("UserPromptSubmit", base({ prompt: "Run the end-to-end suite" })),
      await runHook("PreToolUse", base({ tool_name: "Bash", tool_input: { command: "echo hello-e2e" } })),
      await runHook("PostToolUse", base({ tool_name: "Bash", tool_input: { command: "echo hello-e2e" }, tool_response: { stdout: "hello-e2e" } })),
    ];
    for (const run of runs) {
      expect(run).toMatchObject({ code: 0, stdout: "", stderr: "" });
      expect(run.ms).toBeLessThan(QUICK_MS);
    }
    // Arriving in the side instance's log is also what proves the relay talks to
    // the side instance: nothing before this sends it a PermissionRequest.
    await waitForLog(/hook PostToolUse/, 5_000, from);
    const lines = readSideLog().slice(from);
    const order = ["hook UserPromptSubmit", "hook PreToolUse", "hook PostToolUse"].map((l) => lines.indexOf(l));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    routingProven = true;

    const view = await page.waitForView("the overview naming the session", (v) => v.classes.includes("overview") && v.who === PROJECT);
    expect(view.text).toContain("Claude Code");
    await waitFor("the ticker to show the Bash step", async () => (await page.tickerText()).includes("Exécute · echo hello-e2e"));
    await page.screenshot("02-working");
  });

  it("PermissionRequest → Allow prints the documented allow JSON", async () => {
    const from = readSideLog().length;
    const hook = runHook("PermissionRequest", permission("rm -rf ./build-e2e"));

    await page.waitForApproval("Bash · rm -rf ./build-e2e");
    const [, id] = await waitForLog(/hook PermissionRequest id=(\S+)/, 5_000, from);
    // Expanded to the approval card, and acknowledged to the relay.
    await waitFor("the island to expand", async () => (await page.settle()).width === SIZES.expanded.width);
    await page.screenshot("03-approval");

    await page.click("Allow");
    const run = await hook;
    expect(run.stdout).toBe(ALLOW_JSON);
    expect(run).toMatchObject({ code: 0, stderr: "" });

    const log = readSideLog().slice(from);
    expect(log).toContain(`decision id=${id} allow`);
    expect(log).toContain(`hook id=${id} answered allow`);
    await page.waitForView("the card to close", (v) => v.code === null);
    await page.screenshot("04-after-allow");
  });

  it("PermissionRequest → Deny prints the documented deny JSON", async () => {
    const from = readSideLog().length;
    const hook = runHook("PermissionRequest", permission("git push --force"));
    await page.waitForApproval("Bash · git push --force");
    const [, id] = await waitForLog(/hook PermissionRequest id=(\S+)/, 5_000, from);

    await page.click("Deny");
    const run = await hook;
    expect(run.stdout).toBe(DENY_JSON);
    expect(run).toMatchObject({ code: 0, stderr: "" });
    expect(readSideLog().slice(from)).toContain(`hook id=${id} answered deny`);
    await page.waitForView("the card to close", (v) => v.code === null);
  });

  it("a second request while a card is up goes straight back to the terminal", async () => {
    const from = readSideLog().length;
    const first = runHook("PermissionRequest", permission("echo first"));
    await page.waitForApproval("Bash · echo first");

    const second = await runHook("PermissionRequest", permission("echo second"));
    expect(second).toMatchObject({ code: 0, stdout: "", stderr: "" });
    expect(second.ms).toBeLessThan(QUICK_MS);
    const [, secondId] = await waitForLog(/decline id=(\S+)/, 5_000, from);
    await waitForLog(new RegExp(`hook id=${secondId} not shown`), 5_000, from);

    // The first card is untouched and still answerable.
    expect((await page.activeView())?.code).toBe("Bash · echo first");
    await page.screenshot("05-second-request-declined");
    await page.click("Allow");
    expect((await first).stdout).toBe(ALLOW_JSON);
  });

  it("an unresponsive island costs the relay under a second, not two minutes", async () => {
    const from = readSideLog().length;
    // Hang the page's main thread for a few seconds: the event reaches the
    // webview but nothing can run the handler, so nobody acks. (Debugger.pause
    // was tried first; it only takes effect at some later statement, often after
    // the ack has already gone out.) Not awaited — the reply comes when it ends.
    const hang = cdp.evaluate(`(() => { const end = Date.now() + 3000; while (Date.now() < end) {} return true; })()`);
    await sleep(200);
    let run: HookRun | undefined;
    try {
      run = await runHook("PermissionRequest", permission("echo frozen"), 10_000);
    } finally {
      await hang;
    }
    expect(run).toMatchObject({ code: 0, stdout: "", stderr: "" });
    // The app gives the island 800 ms to put the card up (pipe.rs ACK_TIMEOUT).
    expect(run!.ms).toBeGreaterThanOrEqual(700);
    expect(run!.ms).toBeLessThan(QUICK_MS);
    const [, id] = await waitForLog(/hook id=(\S+) island never acknowledged/, 5_000, from);

    // Unfrozen, the island catches up and shows a card for a request that is
    // already gone. Answering it must reach nobody.
    await page.waitForApproval("Bash · echo frozen");
    await page.click("Deny");
    await waitForLog(new RegExp(`decision id=${id} deny`), 5_000, from);
    // One for the late ack, one for the click: both found nobody waiting.
    const orphan = `reply for id=${id} — no pending request`;
    await waitFor("both replies to find nobody", () => readSideLog().slice(from).split(orphan).length - 1 >= 2, 5_000);
    await page.waitForView("the stale card to close", (v) => v.code === null);
  });

  it("a paused island declines at once", async () => {
    const from = readSideLog().length;
    await page.emit("tray", "pause"); // what the tray's Pause item sends
    try {
      const run = await runHook("PermissionRequest", permission("echo paused"));
      expect(run).toMatchObject({ code: 0, stdout: "", stderr: "" });
      expect(run.ms).toBeLessThan(QUICK_MS);
      const [, id] = await waitForLog(/decline id=(\S+)/, 5_000, from);
      await waitForLog(new RegExp(`hook id=${id} not shown`), 5_000, from);
      expect((await page.activeView())?.code ?? null).toBeNull();
    } finally {
      await page.emit("tray", "pause"); // and back
    }
  });

  it("Stop opens the finished card", async () => {
    const from = readSideLog().length;
    const run = await runHook("Stop", base({ stop_hook_active: false }));
    expect(run).toMatchObject({ code: 0, stdout: "", stderr: "" });
    await waitForLog(/hook Stop/, 5_000, from);
    const view = await page.waitForView("the finished card", (v) => v.text.includes("Claude Code finished"));
    expect(view.who).toBe(PROJECT);
    expect(view.buttons).toEqual(["Open terminal", "OK"]);
    await page.screenshot("06-finished");
  });

  it("SessionEnd resets the session to the bare VS Code pill", async () => {
    const from = readSideLog().length;
    const run = await runHook("SessionEnd", base({ reason: "exit" }));
    expect(run).toMatchObject({ code: 0, stdout: "", stderr: "" });
    await waitForLog(/hook SessionEnd/, 5_000, from);
    await page.waitForView("the session name to reset", (v) => v.who === "VS Code");
  });

  // ── openSession ─────────────────────────────────────────────────────────────
  // Focusing or opening VS Code would take the user's foreground, so only the
  // refusals run here: they prove the command, its argument names and the
  // decision path end to end, and do nothing on screen. Activation is a
  // supervised check (TESTING.md).

  it("openSession is wired, and refuses what it cannot use without doing anything", async () => {
    const from = readSideLog().length;
    expect(await page.invoke("open_session", { cwd: "relative/dir", wslDistro: "not a distro!" })).toBe("failed");
    await waitForLog(/open session \(WSL\): refused — not a WSL distro name/, 5_000, from);
    // If `wslDistro` did not reach Rust as `wsl_distro`, this would read as a
    // Windows session with an absolute Linux path — refused differently.
    expect(await page.invoke("open_session", { cwd: "C:\\a", wslDistro: "Ubuntu-24.04" })).toBe("failed");
    await waitForLog(/open session \(WSL\): refused — the WSL session's folder is not an absolute Linux path/, 5_000, from);
    expect(await page.invoke("open_session", { cwd: "relative/dir", wslDistro: null })).toBe("failed");
    await waitForLog(/open session \(Windows\): refused — the session's folder is not an absolute Windows path/, 5_000, from);
  });

  // ── Hook targets, in the sandbox home ───────────────────────────────────────
  // The side instance runs with COUCOU_TEST_HOME, so every target's
  // settings.json is a file under test-results/e2e/sandbox-home. Each test
  // checks the row points there before it clicks anything.

  it("Settings: the Windows row installs and uninstalls the unchanged Windows command", async () => {
    settings ??= new SettingsPage((await Cdp.connect(app.port, (t) => t.url.includes("settings.html"))).cdp);
    const file = path.join(SANDBOX_HOME, "windows", ".claude", "settings.json");
    await settings.shown();
    const row = await settings.waitForRow("windows", (r) => r.state === "Not installed");
    expect(row.label).toBe("Windows");
    expect(row.path).toBe(file); // the sandbox, never a real home

    await settings.clickInRow("windows", "Install…");
    const pv = await settings.waitForPreview("the Windows diff", (p) => p.diff !== null);
    expect(pv.paths).toContain(file);
    const expected = `"${side.stagedHook.replace(/\\/g, "/")}" PreToolUse`;
    expect(pv.diff).toContain(JSON.stringify(expected).slice(1, -1));
    await settings.click("Back up and write");
    await settings.waitForPreview("the done notice", (p) => p.ok?.startsWith("Done.") ?? false);
    const after = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(after.hooks.PreToolUse).toEqual([{ hooks: [{ type: "command", command: expected, timeout: 10 }] }]);
    expect(Object.keys(after.hooks)).toHaveLength(12);

    await settings.waitForRow("windows", (r) => r.state === "Installed");
    await settings.clickInRow("windows", "Uninstall…");
    await settings.waitForPreview("the removal diff", (p) => p.diff !== null);
    await settings.click("Back up and remove");
    await settings.waitForPreview("the done notice", (p) => p.ok?.startsWith("Done.") ?? false);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({});
    await settings.waitForRow("windows", (r) => r.state === "Not installed");
  });

  // ── WSL ─────────────────────────────────────────────────────────────────────
  // The relay run from inside the user's (already running) distro through WSL
  // interop, as a Claude Code session there runs it. Skipped without WSL.

  it("a Windows session's events carry no wsl_distro", async () => {
    await page.recordHooks();
    const run = await runHook("PreToolUse", base({ cwd: "C:\\e2e\\windows-side", tool_name: "Bash", tool_input: { command: "echo win" } }));
    expect(run).toMatchObject({ code: 0, stdout: "", stderr: "" });
    const seen = await waitFor("the Windows payload in the island", async () =>
      (await page.hooksSeen()).find((p) => p.cwd === "C:\\e2e\\windows-side"));
    expect(seen).not.toHaveProperty("wsl_distro");
  });

  it("a WSL session's events reach the island with wsl_distro", async (ctx) => {
    if (!wsl.distro) return ctx.skip(wsl.skip ?? undefined);
    const distro = wsl.distro;
    relayLinux = wslPath(distro, side.stagedHook);
    const from = readSideLog().length;
    const run = await runHookInWsl(distro, wslHookCommand(relayLinux, "PreToolUse"), {
      hook_event_name: "PreToolUse",
      session_id: "e2e-wsl-session",
      cwd: WSL_CWD,
      tool_name: "Bash",
      tool_input: { command: "echo from-wsl" },
    });
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toBe("");
    // Arriving in the side instance's own log is what proves the route from
    // WSL: no PermissionRequest is sent from there before this.
    await waitForLog(new RegExp(`hook PreToolUse wsl=${escapeRe(distro)}`), 5_000, from);
    wslRoutingProven = true;
    const seen = await waitFor("the WSL payload in the island", async () =>
      (await page.hooksSeen()).find((p) => p.cwd === WSL_CWD));
    expect(seen.wsl_distro).toBe(distro);
    expect(seen.hook_event_name).toBe("PreToolUse");
  });

  it("PermissionRequest from WSL → Allow prints the documented allow JSON inside WSL", async (ctx) => {
    if (!wsl.distro || !wslRoutingProven) return ctx.skip(wsl.skip ?? "WSL routing not proven");
    const from = readSideLog().length;
    const hook = runHookInWsl(wsl.distro, wslHookCommand(relayLinux, "PermissionRequest"), {
      hook_event_name: "PermissionRequest",
      session_id: "e2e-wsl-session",
      cwd: WSL_CWD,
      permission_mode: "default",
      tool_name: "Bash",
      tool_input: { command: "echo approved-in-wsl", description: "e2e" },
    });
    await page.waitForApproval("Bash · echo approved-in-wsl");
    await waitForLog(new RegExp(`hook PermissionRequest id=\\S+ wsl=${escapeRe(wsl.distro)}`), 5_000, from);
    await page.screenshot("07-wsl-approval");
    await page.click("Allow");
    const run = await hook;
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toBe(ALLOW_JSON);
    await page.waitForView("the card to close", (v) => v.code === null);
  });

  it("Settings: install into the WSL distro, run the installed command from WSL, uninstall", async (ctx) => {
    if (!wsl.distro || !wslRoutingProven) return ctx.skip(wsl.skip ?? "WSL routing not proven");
    const distro = wsl.distro;
    const id = `wsl:${distro}`;
    settings ??= new SettingsPage((await Cdp.connect(app.port, (t) => t.url.includes("settings.html"))).cdp);
    // A distro's settings.json as it often looks: other settings, and another
    // tool's hook calling a Windows program through interop.
    const file = path.join(SANDBOX_HOME, "wsl", distro, ".claude", "settings.json");
    const original = {
      model: "claude-opus-5",
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "powershell.exe -NoProfile -File notify.ps1", async: true }] }],
      },
    };
    const originalText = JSON.stringify(original, null, 2);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, originalText);

    await settings.shown();
    expect(await settings.targets()).toContain(id);
    const row = await settings.waitForRow(id, (r) => r.state === "Not installed");
    expect(row.label).toBe(`WSL · ${distro}`);
    expect(row.path).toBe(file); // the sandbox, never the distro's real home
    await settings.screenshot("09-settings-targets");

    await settings.clickInRow(id, "Install…");
    const pv = await settings.waitForPreview("the WSL diff", (p) => p.diff !== null);
    expect(pv.paths).toContain(file);
    expect(pv.hint).toContain(`WSL · ${distro}`);
    expect(pv.diff).toContain(JSON.stringify(wslHookCommand(relayLinux, "PreToolUse")).slice(1, -1));
    await page.screenshot("08-after-wsl-events");
    await settings.screenshot("10-settings-wsl-diff");
    await settings.click("Back up and write");
    const done = await settings.waitForPreview("the done notice", (p) => p.ok?.startsWith("Done.") ?? false);
    expect(done.ok).toContain(`Claude Code session in ${distro}`);

    // Every event points at the relay through its Linux path, with the distro;
    // the other tool's hook and the other settings are untouched.
    const after = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(after.model).toBe("claude-opus-5");
    expect(after.hooks.Stop[0]).toEqual(original.hooks.Stop[0]);
    for (const [event, timeout] of [["PreToolUse", 10], ["PermissionRequest", 120], ["Stop", 10]] as const) {
      expect(after.hooks[event].at(-1)).toEqual({
        hooks: [{ type: "command", command: wslHookCommand(relayLinux, event), timeout }],
      });
    }
    expect(Object.keys(after.hooks)).toHaveLength(12);
    const backups = fs.readdirSync(path.dirname(file)).filter((f) => f.startsWith("settings.json.bak-"));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(path.dirname(file), backups[0]), "utf8")).toBe(originalText);

    // The command exactly as installed, run by a Linux shell.
    const from = readSideLog().length;
    const installed: string = after.hooks.PreToolUse.at(-1).hooks[0].command;
    const run = await runHookInWsl(distro, installed, {
      hook_event_name: "PreToolUse",
      session_id: "e2e-wsl-installed",
      cwd: "/home/e2e/installed-command",
      tool_name: "Read",
      tool_input: { file_path: "/home/e2e/installed-command/README.md" },
    });
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toBe("");
    await waitForLog(new RegExp(`hook PreToolUse wsl=${escapeRe(distro)}`), 5_000, from);
    const seen = await waitFor("the installed command's payload", async () =>
      (await page.hooksSeen()).find((p) => p.cwd === "/home/e2e/installed-command"));
    expect(seen.wsl_distro).toBe(distro);

    // Uninstall puts the file back the way it was.
    await settings.waitForRow(id, (r) => r.state === "Installed");
    await settings.clickInRow(id, "Uninstall…");
    await settings.waitForPreview("the removal diff", (p) => p.diff !== null);
    await settings.click("Back up and remove");
    await settings.waitForPreview("the done notice", (p) => p.ok?.startsWith("Done.") ?? false);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(original);

    // Leave the island without a WSL session in it.
    await runHookInWsl(distro, wslHookCommand(relayLinux, "SessionEnd"), {
      hook_event_name: "SessionEnd", session_id: "e2e-wsl-session", cwd: WSL_CWD, reason: "exit",
    });
  }, 90_000);

  it.runIf(SLOW)("an unanswered card times out with empty stdout (COUCOU_E2E_SLOW=1, ~2 min)", async () => {
    const from = readSideLog().length;
    const hook = runHook("PermissionRequest", permission("echo nobody-answers"), 130_000);
    await page.waitForApproval("Bash · echo nobody-answers");
    const run = await hook;
    expect(run).toMatchObject({ code: 0, stdout: "", stderr: "" });
    // The app gives up first (108 s) and closes the pipe; the relay's own 110 s
    // budget is the backstop.
    expect(run.ms).toBeGreaterThan(100_000);
    expect(run.ms).toBeLessThan(115_000);
    await waitForLog(/hook id=\S+ timed out — terminal takes over/, 5_000, from);
    // The island drops its card on its own clock (110 s from when it showed it).
    await page.waitForView("the card to drop", (v) => v.code === null, 10_000);
  }, 150_000);

  it("the island threw no uncaught exception", () => {
    expect(page.exceptions).toEqual([]);
  });
});

describe("afterwards", () => {
  it(`the side instance is gone and its folders are removed`, () => {
    expect(pipeNames()).not.toContain(sidePipeName(sid));
    expect(webviewProcesses(side.webviewDir)).toEqual([]);
    expect(sideDirsLeft()).toEqual([]);
  });

  // Only now, with the routing proven above, is it safe to run the relay with
  // nobody on the side instance's pipe.
  it("with the side instance gone, the relay exits at once with empty stdout", async (ctx) => {
    if (!routingProven) ctx.skip();
    expect(pipeNames()).not.toContain(sidePipeName(sid));
    for (const event of ["PreToolUse", "PermissionRequest"]) {
      const run = await runHook(event, permission("echo nobody-home"));
      expect(run).toMatchObject({ code: 0, stdout: "", stderr: "" });
      expect(run.ms).toBeLessThan(QUICK_MS);
    }
  });

  it("the real install was not touched", () => {
    const after = snapshotRealInstall(sid);
    // Same processes, same pipe, no restart, no inbox created.
    expect(after.processes).toEqual(realBefore.processes);
    expect(after.pipePresent).toBe(realBefore.pipePresent);
    expect(after.startedLines).toBe(realBefore.startedLines);
    expect(after.inboxExists).toBe(realBefore.inboxExists);
    if (realBefore.pipePresent) expect(pipeNames()).toContain(realPipeName(sid));
    // The real ~/.claude/settings.json files — Windows, and the WSL distro's —
    // are byte for byte what they were: hook installs went to the sandbox.
    // (Claude Code itself rarely rewrites them; if this fails, look at what
    // changed before blaming the suite.)
    expect(after.claudeSettings).toEqual(realBefore.claudeSettings);

    // The real log may legitimately grow while the suite runs — any Claude Code
    // session on this machine (including the one running these tests) goes
    // through the real relay. None of it can come from the suite: the side
    // instance's own lines never appear there.
    const appended = realLogSince(realBefore);
    expect(appended.filter((l) => l.includes(`instance ${INSTANCE}`))).toEqual([]);
    fs.writeFileSync(
      path.join(RESULTS_DIR, "real-install.json"),
      JSON.stringify({ before: realBefore, after, appendedRealLogLines: appended }, null, 2),
    );
  });
});
