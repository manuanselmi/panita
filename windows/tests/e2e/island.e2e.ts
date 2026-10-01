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
  EXTENSION_ID,
  EXTENSION_MANIFEST,
  FAKE_CODE,
  INSTANCE,
  RESULTS_DIR,
  SANDBOX_HOME,
  fakeCodeCalls,
  runHookInWslHolding,
  wslHookCommandBeforePpid,
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
import { FakeVsCodeWindow, sideExtensionPipes, startSilentWindow } from "./fake-vscode";
import { IslandPage, SIZES, type Overview } from "./island-page";
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

/** The sessions of the multi-session tests: Windows ones, and one inside WSL. */
interface E2eSession {
  id: string;
  name: string;
  cwd: string;
  wsl?: string;
}
const S = {
  panita: { id: "e2e-s1", name: "panita", cwd: String.raw`C:\e2e\panita` },
  struxto: { id: "e2e-s2", name: "struxto", cwd: "/home/e2e/struxto", wsl: "Ubuntu-24.04" },
  hekta: { id: "e2e-s3", name: "hekta", cwd: String.raw`C:\e2e\hekta` },
  datasci: { id: "e2e-s4", name: "datasci", cwd: String.raw`C:\e2e\datasci` },
  personal: { id: "e2e-s5", name: "personal", cwd: String.raw`C:\e2e\personal` },
  sexto: { id: "e2e-s6", name: "sexto", cwd: String.raw`C:\e2e\sexto` },
} satisfies Record<string, E2eSession>;

/** A payload from session `s`, as Claude Code (and, for WSL, the relay) would send it. */
const payloadOf = (s: E2eSession, extra: Record<string, unknown> = {}) => ({
  session_id: s.id,
  transcript_path: String.raw`C:\e2e\transcript.jsonl`,
  cwd: s.cwd,
  ...(s.wsl ? { wsl_distro: s.wsl } : {}),
  ...extra,
});

const askFrom = (s: E2eSession, command: string) =>
  payloadOf(s, { permission_mode: "default", tool_name: "Bash", tool_input: { command, description: "e2e" } });

/**
 * The terminal-focus sessions. Their folders exist nowhere — every part of the
 * path is unique to this run — so no VS Code window on the desktop can ever
 * match them by title.
 */
const TAG = Math.random().toString(16).slice(2, 10);
const T = {
  win: { id: `e2e-term-win-${TAG}`, name: `termwin${TAG}`, cwd: String.raw`C:\coucou-e2e-${TAG}\termwin${TAG}` },
  wsl: { id: `e2e-term-wsl-${TAG}`, name: `termwsl${TAG}`, cwd: `/coucou-e2e-${TAG}/termwsl${TAG}` },
} satisfies Record<string, E2eSession>;

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
  /** Set once the side instance is shown to use the fake `code` (FAKE_CODE). */
  let codeIsFake = false;
  /** The fake VS Code window of the terminal-focus tests, while it serves. */
  let fakeWindow: FakeVsCodeWindow | null = null;

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
      await fakeWindow?.close();
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
    await waitFor("the ticker to show the Bash step", async () => (await page.tickerText()).includes("Ejecuta · echo hello-e2e"));
    await page.screenshot("02-working");
  });

  it("ticker rows never draw on top of each other", async () => {
    // Regression: the dim copy of a completed step took its static position, one
    // line box below its own row, and landed on the current step (ticker.ts).
    // Only steps wider than the row trigger it — a short text leaves room for the
    // dim copy on the same line — so both steps here are long, like real commands.
    // Measured on the open overview: what a person actually looks at.
    const long = (n: number) => `step${n}; cd C:/Users/someone/Documents/GitHub/project && git status --short`;
    for (const n of [1, 2]) {
      const run = await runHook("PreToolUse", base({ tool_name: "Bash", tool_input: { command: long(n) } }));
      expect(run).toMatchObject({ code: 0, stdout: "" });
    }
    await waitFor("the ticker to show the second long step", async () => (await page.tickerText()).includes("step2;"));
    await page.emit("tray", "open");
    await page.waitForView("the overview to open", (v) => v.classes.includes("overview") && v.who === PROJECT);
    await waitFor("the island to expand", async () => (await page.settle()).width === SIZES.expanded.width);
    const rows = await waitFor("the ticker to rest with two visible rows", async () => {
      const before = await page.tickerRows();
      await sleep(150);
      const after = await page.tickerRows();
      const drawn = after.length >= 2 && after.every((r) => r.bottom > r.top);
      return drawn && JSON.stringify(before) === JSON.stringify(after) ? after : null;
    });
    await page.screenshot("02b-ticker-open");
    for (let i = 1; i < rows.length; i++) {
      const [upper, lower] = [rows[i - 1], rows[i]];
      expect(lower.top, `rows overlap: ${JSON.stringify(rows)}`).toBeGreaterThanOrEqual(upper.bottom - 0.5);
    }
    // One session: nobody else to show on the right.
    expect((await page.overview()).quiet).toBe("No other sessions");
  });

  it("the ticker keeps up past twenty steps", async () => {
    // A session keeps its last 20 steps; the ticker used to count by that list
    // and froze on the twentieth step of every long session.
    for (let n = 1; n <= 23; n++) {
      const run = await runHook("PreToolUse", base({ tool_name: "Bash", tool_input: { command: `count-${n}` } }));
      expect(run).toMatchObject({ code: 0, stdout: "" });
    }
    await waitFor("the ticker to show the 23rd step", async () => (await page.tickerText()).includes("count-23"), 10_000);
  });

  it("PermissionRequest → Allow prints the documented allow JSON", async () => {
    const from = readSideLog().length;
    const hook = runHook("PermissionRequest", permission("rm -rf ./build-e2e"));

    const card = await page.waitForApproval("Bash · rm -rf ./build-e2e");
    expect(card.who).toBe(PROJECT);
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

  it("SessionEnd removes the session: the island has nothing left to show", async () => {
    const from = readSideLog().length;
    const run = await runHook("SessionEnd", base({ reason: "exit" }));
    expect(run).toMatchObject({ code: 0, stdout: "", stderr: "" });
    await waitForLog(/hook SessionEnd/, 5_000, from);
    // The finished card is still up (it keeps its own copy of the session); the
    // home view behind it is now the empty card.
    await page.emit("tray", "open");
    await page.waitForView("the empty card", (v) => v.text.includes("Nothing running right now."));
  });

  describe("several sessions at once", () => {
    /** Each session's colour, as first seen: it must never change. */
    const seen = new Map<string, string>();

    /** Records the colours on screen, checks they never change and differ between sessions. */
    function checkColours(o: Overview) {
      const shown = [o.primary, o.second, ...o.panitas].filter((x) => x != null);
      for (const { name, color } of shown) {
        if (!seen.has(name)) seen.set(name, color);
        expect(color, `${name}'s colour changed`).toBe(seen.get(name));
      }
      const colours = shown.map((x) => x.color);
      expect(new Set(colours).size, `colours repeat: ${JSON.stringify(shown)}`).toBe(colours.length);
    }

    async function work(s: E2eSession, command: string) {
      for (const [event, extra] of [
        ["UserPromptSubmit", { prompt: `${s.name}: ${command}` }],
        ["PreToolUse", { tool_name: "Bash", tool_input: { command } }],
      ] as const) {
        const run = await runHook(event, payloadOf(s, extra));
        expect(run).toMatchObject({ code: 0, stdout: "", stderr: "" });
      }
    }

    async function openIsland() {
      await page.emit("tray", "open");
      await waitFor("the island to expand", async () => (await page.settle()).width === SIZES.expanded.width);
    }

    const names = (o: Overview) => o.panitas.map((p) => p.name);
    /** Longer than the right card is wide, on purpose. */
    const SEXTO_COMMAND = "cargo test --workspace --all-features -- --nocapture";

    it("two sessions: the newest on the left, the other one on the right", async () => {
      await page.pointerAway();
      await page.interceptOpens();
      await work(S.panita, "npm test");
      await work(S.struxto, "pytest -q");
      const o = await page.waitForOverview(
        "struxto on the left, panita on the right",
        (o) => o.primary?.name === "struxto" && o.second?.name === "panita",
      );
      expect(o.second?.step).toBe("Ejecuta · npm test");
      expect(o.panitas).toEqual([]);
      // wsl_distro came through the real relay and stays with the session.
      expect(o.primary?.title).toBe("/home/e2e/struxto (WSL · Ubuntu-24.04)");
      checkColours(o);
      await openIsland();
      await page.screenshot("10-two-sessions");
    });

    it("three sessions: the third leads, the first becomes a panita", async () => {
      await work(S.hekta, "make build");
      const o = await page.waitForOverview(
        "hekta, struxto, then the panita",
        (o) => o.primary?.name === "hekta" && o.second?.name === "struxto" && names(o).join() === "panita",
      );
      expect(o.more).toBeNull();
      checkColours(o);
      await openIsland();
      await page.screenshot("11-three-sessions");
    });

    it("six sessions: three panitas and a +1, in order of activity", async () => {
      await work(S.datasci, "jupyter nbconvert --execute analysis.ipynb");
      await work(S.personal, "git status");
      await work(S.sexto, SEXTO_COMMAND);
      const o = await page.waitForOverview(
        "sexto, personal, then datasci hekta struxto +1",
        (o) =>
          o.primary?.name === "sexto" &&
          o.second?.name === "personal" &&
          names(o).join() === "datasci,hekta,struxto" &&
          o.more === "+1",
      );
      checkColours(o);
      // Six sessions, six colours (panita, behind the +1, was seen earlier).
      expect(new Set(seen.values()).size).toBe(6);
      await openIsland();
      await page.screenshot("12-six-sessions");
    });

    it("a click on a panita puts that session on the left at once", async () => {
      await page.clickPanita("hekta");
      // Well under the 2 s dwell: a click does not wait for it.
      const o = await page.waitForOverview(
        "hekta on the left",
        (o) => o.primary?.name === "hekta" && o.second?.name === "sexto",
        1_500,
      );
      expect(names(o)).toEqual(["personal", "datasci", "struxto"]);
      expect(o.more).toBe("+1");
      checkColours(o);
      // sexto's step is a long command: it ends in "…" inside the card rather
      // than stretching the card past the island (it used to).
      expect(o.second?.step).toBe(`Ejecuta · ${SEXTO_COMMAND.slice(0, 40)}`);
      await openIsland();
      expect((await page.overview()).fits).toBe(true);
      await page.screenshot("13-panita-click");
    });

    it("each ↗ opens the session it sits on", async () => {
      const before = (await page.opens()).length;
      await page.clickOpen("primary");
      await page.clickOpen("second");
      const opens = (await page.opens()).slice(before);
      expect(opens).toEqual([
        { cmd: "open_session", args: { cwd: S.hekta.cwd, wslDistro: null, sessionId: S.hekta.id } },
        { cmd: "open_session", args: { cwd: S.sexto.cwd, wslDistro: null, sessionId: S.sexto.id } },
      ]);
    });

    it("the approval card names the session asking; Allow still answers exactly", async () => {
      const from = readSideLog().length;
      const hook = runHook("PermissionRequest", askFrom(S.datasci, "rm -rf ./datasci-build"));
      const card = await page.waitForApproval("Bash · rm -rf ./datasci-build");
      expect(card.who).toBe("datasci");
      expect(card.whoColor).toBe(seen.get("datasci"));
      await waitForLog(/hook PermissionRequest id=(\S+)/, 5_000, from);
      await page.screenshot("14-approval-session");

      await page.click("Allow");
      const run = await hook;
      expect(run.stdout).toBe(ALLOW_JSON);
      expect(run).toMatchObject({ code: 0, stderr: "" });
      // The answered session is on the left card of the overview the user lands on.
      await page.waitForView("the card to close", (v) => v.code === null);
      await page.waitForOverview("datasci on the left", (o) => o.primary?.name === "datasci", 1_500);
    });

    it("another session's request while a card is up is declined, and that session badged", async () => {
      const from = readSideLog().length;
      const first = runHook("PermissionRequest", askFrom(S.struxto, "rm -rf ./struxto-cache"));
      await page.waitForApproval("Bash · rm -rf ./struxto-cache");

      const second = await runHook("PermissionRequest", askFrom(S.personal, "git push --force"));
      expect(second).toMatchObject({ code: 0, stdout: "", stderr: "" });
      expect(second.ms).toBeLessThan(QUICK_MS);
      const [, secondId] = await waitForLog(/decline id=(\S+)/, 5_000, from);
      await waitForLog(new RegExp(`hook id=${secondId} not shown`), 5_000, from);

      // The first card is untouched and still names its own session.
      const card = await page.activeView();
      expect(card?.code).toBe("Bash · rm -rf ./struxto-cache");
      expect(card?.who).toBe("struxto");
      await page.screenshot("14b-second-request-declined");

      await page.click("Deny");
      expect((await first).stdout).toBe(DENY_JSON);
      await page.waitForView("the card to close", (v) => v.code === null);
      // Back on the overview: personal asks in its terminal now, and says so.
      const o = await page.waitForOverview("personal's badge", (o) =>
        [o.second, ...o.panitas].some((p) => p?.name === "personal" && p.badge === "approval"),
      );
      expect(o.primary?.name).toBe("struxto");
    });

    it("Stop opens the finished card naming that session; Open terminal opens it", async () => {
      // panita is behind the +1 at this point: the card is about it all the same.
      const run = await runHook("Stop", payloadOf(S.panita, { stop_hook_active: false }));
      expect(run).toMatchObject({ code: 0, stdout: "", stderr: "" });
      const view = await page.waitForView("panita's finished card", (v) => v.text.includes("Claude Code finished"));
      expect(view.who).toBe("panita");
      expect(view.whoColor).toBe(seen.get("panita"));
      expect(view.buttons).toEqual(["Open terminal", "OK"]);
      await page.screenshot("15-finished-session");

      const before = (await page.opens()).length;
      await page.click("Open terminal");
      expect((await page.opens()).slice(before)).toEqual([
        { cmd: "open_session", args: { cwd: S.panita.cwd, wslDistro: null, sessionId: S.panita.id } },
      ]);
    });

    it("the compact island shows the other sessions in their colours", async () => {
      await page.click("OK");
      await waitFor("the compact island", async () => (await page.settle()).width === SIZES.compact.width);
      const grid = await page.compact();
      // Six sessions: the leader is the big Mochi, five others → three minis and a +2.
      expect(grid.minis).toHaveLength(3);
      expect(grid.more).toBe("+2");
      const colourOf = new Map(Object.values(S).map((s) => [`session:${s.id}`, seen.get(s.name)]));
      for (const mini of grid.minis) expect(mini.color, mini.id).toBe(colourOf.get(mini.id));
      await page.screenshot("16-compact");
    });

    it("SessionEnd takes a session off; the last one alone, then nothing", async () => {
      await openIsland(); // back to the overview from the compact island
      const order = Object.values(S);
      for (const [i, s] of order.entries()) {
        const run = await runHook("SessionEnd", payloadOf(s, { reason: "exit" }));
        expect(run).toMatchObject({ code: 0, stdout: "", stderr: "" });
        const left = order.slice(i + 1).map((x) => x.name);
        // With nobody left the overview gives way to the empty card (below), and
        // a view off screen is not redrawn.
        if (left.length === 0) break;
        const o = await page.waitForOverview(`${s.name} to be gone`, (o) => {
          const shown = [o.primary?.name, o.second?.name, ...names(o)].filter(Boolean) as string[];
          return !shown.includes(s.name) && shown.every((n) => left.includes(n));
        });
        if (left.length > 0) checkColours(o);
        if (left.length === 1) {
          expect(o.primary?.name).toBe(left[0]);
          expect(o.second).toBeNull();
          expect(o.quiet).toBe("No other sessions");
          await openIsland();
          await page.screenshot("17-one-session");
        }
      }
      await page.waitForView("the empty card", (v) => v.text.includes("Nothing running right now."));
    });
  });

  // ── openSession ─────────────────────────────────────────────────────────────
  // Focusing or opening VS Code would take the user's foreground, so only the
  // refusals run here: they prove the command, its argument names and the
  // decision path end to end, and do nothing on screen. Activation is a
  // supervised check (TESTING.md).

  it("openSession is wired, and refuses what it cannot use without doing anything", async () => {
    // These calls must reach Rust: lift the open_* interception the session
    // tests installed. Every input below is refused before anything is opened.
    await page.restoreOpens();
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

  // ── Terminal focus ──────────────────────────────────────────────────────────
  // ↗ asks the companion VS Code extension to show the session's own terminal
  // tab. The extension here is FakeVsCodeWindow — the extension's real server
  // code, serving the side instance's pipe name, with made-up terminals — and
  // the island's ↗ is clicked with nothing intercepted. That is safe because
  // the sessions live in folders that exist nowhere (no window on the desktop
  // can match them, so nothing is activated) and the side instance's `code` is
  // the fake, which the first test proves before any click.

  it("the side instance's `code` is the suite's fake", async () => {
    const status = await page.invoke<{ codePath: string | null; vsixPath: string | null }>("vscode_extension_status");
    expect(status.codePath?.toLowerCase()).toBe(FAKE_CODE.toLowerCase());
    expect(status.vsixPath).toMatch(/coucou-terminal-focus\.vsix$/);
    codeIsFake = true;
  });

  it("↗ has the extension show the Windows session's own terminal, found by the relay's ancestry", async (ctx) => {
    if (!codeIsFake) return ctx.skip("the side instance's `code` is not the fake");
    expect(sideExtensionPipes(), "another fake window is serving").toEqual([]);
    const windowName = `coucou-e2e-window-${TAG}`;
    fakeWindow = await FakeVsCodeWindow.start({ kind: "local" }, windowName);
    fakeWindow.addTerminal("another tab", 4);
    // This process spawns the relay, so it is the relay's nearest ancestor: a
    // terminal whose shell has this PID stands for the tab the session runs in.
    const tab = fakeWindow.addTerminal("e2e-terminal", process.pid);
    expect(sideExtensionPipes()).toEqual([fakeWindow.listedName]);

    for (const [event, extra] of [
      ["UserPromptSubmit", { prompt: "terminal focus" }],
      ["PreToolUse", { tool_name: "Bash", tool_input: { command: "echo terminal-focus" } }],
    ] as const) {
      expect(await runHook(event, payloadOf(T.win, extra))).toMatchObject({ code: 0, stdout: "", stderr: "" });
    }
    await page.emit("tray", "open");
    await page.waitForOverview("the terminal session on the left", (o) => o.primary?.name === T.win.name);

    const from = readSideLog().length;
    const codeCalls = fakeCodeCalls().length;
    await page.clickOpenUnintercepted("primary");
    await waitFor("the extension to be asked", () => fakeWindow!.requests.length >= 1);
    const [request] = fakeWindow.requests;
    // The relay's Windows ancestry, nearest first: this process, then its parent.
    expect(request.pids[0]).toBe(process.pid);
    expect(request.pids[1]).toBe(process.ppid);
    expect(request.wsl).toBeNull();
    expect(fakeWindow.replies).toEqual([{ matched: true, terminal: "e2e-terminal", window: windowName }]);
    expect(tab.shows).toEqual([false]);
    await waitForLog(new RegExp(`open session \\(Windows\\): terminal "e2e-terminal" focused in "${windowName}" \\(\\d+ ms\\)`), 5_000, from);
    // No window on the desktop has that name or that folder: none is raised,
    // and since the session is known to be in a VS Code window, none is opened.
    await waitForLog(/open session \(Windows\): terminal shown, window not raised/, 5_000, from);
    expect(fakeCodeCalls().length).toBe(codeCalls);
    await page.screenshot("18-terminal-focus");
  });

  it("no matching terminal, no extension, or no record: ↗ is the window step alone, as before", async (ctx) => {
    if (!codeIsFake || !fakeWindow) return ctx.skip("the previous test did not run");
    // A window whose terminals are all someone else's.
    fakeWindow.terminals.length = 0;
    fakeWindow.addTerminal("someone else", 4);
    let from = readSideLog().length;
    await page.clickOpenUnintercepted("primary");
    await waitForLog(/open session \(Windows\): 1 of 1 VS Code window\(s\) answered; none has its terminal/, 5_000, from);
    // What ↗ did before the extension existed: no window has the folder, so
    // `code <cwd>` — here, the fake.
    await waitForLog(/open session \(Windows\): no VS Code window for it — asked `code` to open it/, 5_000, from);
    expect(fakeCodeCalls().at(-1)).toBe(T.win.cwd);

    // A wedged extension: it takes the connection and never answers. The app
    // gives up on its own deadline (1.5 s) and goes on.
    await fakeWindow.close();
    fakeWindow = null;
    const silent = await startSilentWindow();
    try {
      from = readSideLog().length;
      const clicked = Date.now();
      await page.clickOpenUnintercepted("primary");
      await waitForLog(/open session \(Windows\): no extension answered \(1 asked: timed out; \d+ ms\)/, 5_000, from);
      await waitForLog(/open session \(Windows\): no VS Code window for it — asked `code` to open it/, 5_000, from);
      expect(Date.now() - clicked).toBeLessThan(4_000);
    } finally {
      await silent.close();
    }

    // No extension at all.
    expect(sideExtensionPipes()).toEqual([]);
    from = readSideLog().length;
    await page.clickOpenUnintercepted("primary");
    await waitForLog(/open session \(Windows\): no extension answered — no VS Code window serves one/, 5_000, from);
    await waitForLog(/open session \(Windows\): no VS Code window for it — asked `code` to open it/, 5_000, from);

    // SessionEnd forgets the session's terminal.
    expect(await runHook("SessionEnd", payloadOf(T.win, { reason: "exit" }))).toMatchObject({ code: 0, stdout: "" });
    from = readSideLog().length;
    expect(await page.invoke("open_session", { cwd: T.win.cwd, wslDistro: null, sessionId: T.win.id })).toBe("opened");
    await waitForLog(/open session \(Windows\): no terminal recorded for it/, 5_000, from);
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

  it("Settings: the VS Code terminal focus row installs the bundled extension — through the fake `code`", async (ctx) => {
    if (!codeIsFake) return ctx.skip("the side instance's `code` is not the fake");
    settings ??= new SettingsPage((await Cdp.connect(app.port, (t) => t.url.includes("settings.html"))).cdp);
    await settings.shown();
    const row = await settings.waitForExtensionRow((r) => r.state === "Not installed");
    expect(row.label).toBe("VS Code terminal focus");
    // The stand-in, never the user's VS Code — checked before the click.
    expect(row.path?.toLowerCase()).toBe(FAKE_CODE.toLowerCase());
    expect(fakeCodeCalls()).toContain("--list-extensions --show-versions");

    const before = fakeCodeCalls().length;
    await settings.clickInExtensionRow("Install");
    const done = await settings.waitForExtensionRow((r) => r.state === `Installed ${EXTENSION_MANIFEST.version}`);
    expect(done.notice).toMatch(/^Installed\./);
    expect(done.buttons).toEqual([]); // up to date: nothing to click
    const install = fakeCodeCalls().slice(before).find((c) => c.startsWith("--install-extension "));
    expect(install).toMatch(/ --force$/);
    // The package the app shipped: the real .vsix this build made (a zip).
    const vsix = install!.replace(/^--install-extension /, "").replace(/ --force$/, "").replace(/^"|"$/g, "");
    expect(path.basename(vsix)).toBe("coucou-terminal-focus.vsix");
    expect(vsix, "a plain path, not Tauri's verbatim \\\\?\\ form").toMatch(/^[A-Za-z]:\\/);
    expect(fs.readFileSync(vsix).subarray(0, 2).toString("latin1")).toBe("PK");
    expect(readSideLog()).toContain(`installing the VS Code extension ${EXTENSION_MANIFEST.version}`);
    expect(EXTENSION_ID).toBe("coucou.terminal-focus");
    await settings.screenshot("11-settings-extension");
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
    // The relay's terminal hints stay in the app (terminal.rs).
    expect(seen).not.toHaveProperty("ancestor_pids");
    expect(seen).not.toHaveProperty("wsl_ppid");
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
    expect(seen).not.toHaveProperty("wsl_ppid");
  });

  it("↗ on a WSL session: the app walks /proc in the distro, and the WSL window shows the terminal", async (ctx) => {
    if (!wsl.distro || !wslRoutingProven) return ctx.skip(wsl.skip ?? "WSL routing not proven");
    if (!codeIsFake) return ctx.skip("the side instance's `code` is not the fake");
    const distro = wsl.distro;
    expect(sideExtensionPipes(), "another fake window is serving").toEqual([]);
    const windowName = `${T.wsl.name} [WSL: ${distro}]`;
    const vsWindow = await FakeVsCodeWindow.start({ kind: "wsl", distro }, windowName);
    fakeWindow = vsWindow;
    // The hook command exactly as installed, run by a shell that stays alive:
    // its `$PPID` is that shell, which stands for Claude Code.
    const held = runHookInWslHolding(distro, wslHookCommand(relayLinux, "PreToolUse"), {
      hook_event_name: "PreToolUse",
      session_id: T.wsl.id,
      cwd: T.wsl.cwd,
      tool_name: "Bash",
      tool_input: { command: "echo held-in-wsl" },
    });
    try {
      const parent = await held.parentPid;
      // In a Remote-WSL window, a terminal's processId is its Linux shell's PID.
      const tab = vsWindow.addTerminal("e2e-wsl-terminal", parent);
      expect(await held.hookDone).toBe(0);
      await page.emit("tray", "open");
      await page.waitForOverview("the WSL terminal session on the left", (o) => o.primary?.name === T.wsl.name);

      const from = readSideLog().length;
      await page.clickOpenUnintercepted("primary");
      await waitFor("the WSL window to be asked", () => vsWindow.requests.length >= 1, 10_000);
      const [request] = vsWindow.requests;
      expect(request.wsl?.distro).toBe(distro);
      // The Linux chain, read from /proc at click time: the shell first, then up.
      expect(request.wsl?.pids[0]).toBe(parent);
      expect(request.wsl!.pids.length).toBeGreaterThan(2);
      // Interop: the relay's Windows ancestry runs through the wsl.exe this
      // process started — and on to this process.
      expect(request.pids).toContain(process.pid);
      expect(vsWindow.replies).toEqual([{ matched: true, terminal: "e2e-wsl-terminal", window: windowName }]);
      expect(tab.shows).toEqual([false]);
      await waitForLog(new RegExp(`open session \\(WSL\\): terminal "e2e-wsl-terminal" focused in "${escapeRe(windowName)}" \\(\\d+ ms\\)`), 10_000, from);
      await waitForLog(/open session \(WSL\): terminal shown, window not raised/, 5_000, from);
    } finally {
      held.stop();
      await held.closed.catch(() => undefined);
      await vsWindow.close();
      fakeWindow = null;
      await runHook("SessionEnd", payloadOf(T.wsl, { reason: "exit" }));
    }
  }, 60_000);

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

  it("Settings: a WSL install from before --wsl-ppid is outdated, and Update… goes through the diff", async (ctx) => {
    if (!wsl.distro || !wslRoutingProven) return ctx.skip(wsl.skip ?? "WSL routing not proven");
    const distro = wsl.distro;
    const id = `wsl:${distro}`;
    settings ??= new SettingsPage((await Cdp.connect(app.port, (t) => t.url.includes("settings.html"))).cdp);
    const file = path.join(SANDBOX_HOME, "wsl", distro, ".claude", "settings.json");
    // Every event, as the previous version of Coucou wrote it.
    const events: [string, number][] = [
      ["SessionStart", 10], ["SessionEnd", 10], ["UserPromptSubmit", 10], ["PreToolUse", 10],
      ["PostToolUse", 10], ["PostToolUseFailure", 10], ["PermissionRequest", 120], ["Notification", 10],
      ["Stop", 10], ["StopFailure", 10], ["SubagentStart", 10], ["SubagentStop", 10],
    ];
    const entry = (command: string, timeout: number) => [{ hooks: [{ type: "command", command, timeout }] }];
    const old = { hooks: Object.fromEntries(events.map(([e, t]) => [e, entry(wslHookCommandBeforePpid(relayLinux, e), t)])) };
    const oldText = JSON.stringify(old, null, 2);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, oldText);

    await settings.shown();
    const row = await settings.waitForRow(id, (r) => r.state === "Installed — update available");
    expect(row.path).toBe(file); // the sandbox, never the distro's real home
    expect(row.buttons).toEqual(["Update…", "Uninstall…"]);
    await settings.clickInRow(id, "Update…");
    const pv = await settings.waitForPreview("the update diff", (p) => p.diff !== null);
    expect(pv.diff).toContain(JSON.stringify(wslHookCommand(relayLinux, "PreToolUse")).slice(1, -1));
    expect(pv.diff).toContain(JSON.stringify(wslHookCommandBeforePpid(relayLinux, "PreToolUse")).slice(1, -1));
    await settings.click("Back up and write");
    await settings.waitForPreview("the done notice", (p) => p.ok?.startsWith("Done.") ?? false);

    const after = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const [event, timeout] of events) {
      expect(after.hooks[event]).toEqual(entry(wslHookCommand(relayLinux, event), timeout));
    }
    const backups = fs.readdirSync(path.dirname(file)).filter((f) => f.startsWith("settings.json.bak-"));
    expect(backups.map((b) => fs.readFileSync(path.join(path.dirname(file), b), "utf8"))).toContain(oldText);
    await settings.waitForRow(id, (r) => r.state === "Installed");
    // Only the sandbox's copy of the distro's home.
    fs.rmSync(path.join(SANDBOX_HOME, "wsl", distro), { recursive: true, force: true });
  }, 60_000);

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
    // And no fake VS Code window is left serving.
    expect(sideExtensionPipes()).toEqual([]);
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
