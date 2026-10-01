// The island page, seen through CDP. Every interaction is DOM-level: queries,
// `element.click()` and Tauri's own JS bridge. Nothing here moves the mouse or
// types — the user's desktop is left alone (see TESTING.md).

import fs from "node:fs";
import path from "node:path";
import { Cdp } from "./cdp";
import { RESULTS_DIR, sleep, waitFor } from "./harness";

export interface ActiveView {
  /** `class` of the view element on screen (`.view.on`). */
  classes: string;
  text: string;
  /** The approval card's command line, when there is one. */
  code: string | null;
  /** Labels of the buttons in that view, e.g. ["Deny", "Allow"]. */
  buttons: string[];
  /** The task name in the view's "who" row, when there is one. */
  who: string | null;
}

export interface Box {
  width: number;
  height: number;
}

/** The island's three sizes (src/core/layout.ts): hidden, compact, expanded. */
export const SIZES = {
  hidden: { width: 184, height: 0 },
  compact: { width: 288, height: 32 },
  expanded: { width: 640 },
} as const;

export class IslandPage {
  readonly exceptions: string[] = [];
  readonly consoleLines: string[] = [];

  constructor(readonly cdp: Cdp) {}

  /** Starts collecting uncaught exceptions and console output from the page. */
  async watch() {
    this.cdp.on("Runtime.exceptionThrown", (p) => {
      const d = p.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined;
      this.exceptions.push(d?.exception?.description ?? d?.text ?? JSON.stringify(p));
    });
    this.cdp.on("Runtime.consoleAPICalled", (p) => {
      const args = (p.args as { value?: unknown; description?: string }[] | undefined) ?? [];
      this.consoleLines.push(`${String(p.type)}: ${args.map((a) => a.value ?? a.description ?? "").join(" ")}`);
    });
    await this.cdp.send("Runtime.enable");
  }

  activeView(): Promise<ActiveView | null> {
    return this.cdp.evaluate<ActiveView | null>(`(() => {
      const el = document.querySelector("#views > .view.on");
      if (!el) return null;
      return {
        classes: el.className,
        text: el.textContent ?? "",
        code: el.querySelector(".code")?.textContent ?? null,
        buttons: [...el.querySelectorAll("button.btn")].map((b) => b.querySelector("span")?.textContent ?? ""),
        who: el.querySelector(".who .name, .who-row .n")?.textContent ?? null,
      };
    })()`);
  }

  waitForView(what: string, accept: (v: ActiveView) => boolean, timeoutMs = 8_000): Promise<ActiveView> {
    return waitFor(what, async () => {
      const v = await this.activeView();
      return v && accept(v) ? v : null;
    }, timeoutMs);
  }

  /** The approval card for `command`, with both buttons on screen. */
  waitForApproval(command: string, timeoutMs = 8_000): Promise<ActiveView> {
    return this.waitForView(
      `the approval card for ${JSON.stringify(command)}`,
      (v) => v.code === command && v.buttons.includes("Allow") && v.buttons.includes("Deny"),
      timeoutMs,
    );
  }

  /** `element.click()` on the active view's button labelled `label`. No real input. */
  async click(label: string) {
    const clicked = await this.cdp.evaluate<boolean>(`(() => {
      const button = [...document.querySelectorAll("#views > .view.on button.btn")]
        .find((b) => b.querySelector("span")?.textContent === ${JSON.stringify(label)});
      if (!button) return false;
      button.click();
      return true;
    })()`);
    if (!clicked) throw new Error(`no "${label}" button in the active view`);
  }

  /** Text of the overview's session ticker (both the current and completed rows). */
  tickerText(): Promise<string> {
    return this.cdp.evaluate<string>(`document.querySelector(".view.overview .ticker")?.textContent ?? ""`);
  }

  box(): Promise<Box> {
    return this.cdp.evaluate<Box>(`(() => {
      const r = document.getElementById("island").getBoundingClientRect();
      return { width: Math.round(r.width), height: Math.round(r.height) };
    })()`);
  }

  greetingVisible(): Promise<boolean> {
    return this.cdp.evaluate<boolean>(
      `getComputedStyle(document.getElementById("greeting-canvas")).display !== "none"`,
    );
  }

  /** Waits until the island stops resizing (its springs have settled). */
  async settle(timeoutMs = 5_000): Promise<Box> {
    let previous = await this.box();
    return waitFor("the island to stop resizing", async () => {
      await sleep(120);
      const now = await this.box();
      const still = now.width === previous.width && now.height === previous.height;
      previous = now;
      return still ? now : null;
    }, timeoutMs, 0);
  }

  async screenshot(name: string): Promise<string> {
    await this.settle().catch(() => undefined);
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    const file = path.join(RESULTS_DIR, `${name}.png`);
    fs.writeFileSync(file, await this.cdp.screenshot());
    return file;
  }

  /** Emits an app event through Tauri's own JS API — what Rust does for the tray menu. */
  emit(event: string, payload: unknown): Promise<unknown> {
    return this.cdp.evaluate(
      `window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: ${JSON.stringify(event)}, payload: ${JSON.stringify(payload)} })`,
    );
  }

  /** Calls one of Coucou's commands from the page, as the island's own code would. */
  invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
    return this.cdp.evaluate<T>(
      `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})`,
    );
  }

  /**
   * Starts keeping a copy of every `hook` event payload the page receives —
   * a listener of its own beside the island's, registered through Tauri's
   * event plugin exactly as `onEvent` does it.
   */
  async recordHooks() {
    await this.cdp.evaluate(`(() => {
      if (window.__e2eHooks) return true;
      window.__e2eHooks = [];
      const T = window.__TAURI_INTERNALS__;
      return T.invoke("plugin:event|listen", {
        event: "hook",
        target: { kind: "Any" },
        handler: T.transformCallback((e) => window.__e2eHooks.push(e.payload)),
      }).then(() => true);
    })()`);
  }

  /** Payloads recorded since `recordHooks`, oldest first. */
  hooksSeen(): Promise<Record<string, unknown>[]> {
    return this.cdp.evaluate(`window.__e2eHooks ?? []`);
  }

  /** The tray's Quit, through the same command. The page goes away with the app. */
  async quit() {
    await this.cdp
      .evaluate(`window.__TAURI_INTERNALS__.invoke("quit_app"), true`)
      .catch(() => undefined);
  }
}
