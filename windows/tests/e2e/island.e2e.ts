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
} from "./harness";
import { IslandPage, SIZES, type Overview } from "./island-page";

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

beforeAll(() => {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  realBefore = snapshotRealInstall(sid);
});

describe(`side instance "${INSTANCE}"`, () => {
  let app: RunningApp;
  let cdp: Cdp;
  let page: IslandPage;

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
        { cmd: "open_in_vscode", args: { path: S.hekta.cwd } },
        { cmd: "open_in_vscode", args: { path: S.sexto.cwd } },
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
      expect((await page.opens()).slice(before)).toEqual([{ cmd: "open_in_vscode", args: { path: S.panita.cwd } }]);
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
