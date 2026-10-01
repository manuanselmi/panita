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
  /** The colour of the dot before that name, as #RRGGBB. */
  whoColor: string | null;
}

/** A session (or integration) as one of the overview's cards shows it. */
export interface Shown {
  name: string;
  /** #RRGGBB */
  color: string;
}

/** The overview's two cards, as a person reads them. */
export interface Overview {
  /** Left card. */
  primary: (Shown & { title: string | null; count: string | null }) | null;
  /** Top of the right card: the second session and its current step. */
  second: (Shown & { step: string; badge: string | null }) | null;
  /** The panitas under the divider, left to right. */
  panitas: (Shown & { id: string; badge: string | null })[];
  /** The "+N" after them. */
  more: string | null;
  /** The quiet line of an otherwise empty right card. */
  quiet: string | null;
  /** Both cards lie within the overview (meaningful once the island is open). */
  fits: boolean;
}

/** The compact island's mini Mochis, and its "+N". */
export interface Compact {
  minis: { id: string; color: string }[];
  more: string | null;
}

/** In-page helper: any CSS colour → #RRGGBB, so colours compare as strings. */
const HEX = `(c) => {
  const m = String(c).match(/\\d+/g);
  if (!m || String(c).startsWith("#")) return String(c).toUpperCase();
  return "#" + m.slice(0, 3).map((n) => Number(n).toString(16).padStart(2, "0")).join("").toUpperCase();
}`;

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
      const hex = ${HEX};
      const el = document.querySelector("#views > .view.on");
      if (!el) return null;
      const name = el.querySelector(".who .name, .who-row .n");
      const dot = name?.parentElement?.querySelector(".dot");
      return {
        classes: el.className,
        text: el.textContent ?? "",
        code: el.querySelector(".code")?.textContent ?? null,
        buttons: [...el.querySelectorAll("button.btn")].map((b) => b.querySelector("span")?.textContent ?? ""),
        who: name?.textContent ?? null,
        whoColor: dot ? hex(getComputedStyle(dot).backgroundColor) : null,
      };
    })()`);
  }

  /** The overview's cards, read from the DOM whether or not the island is open. */
  overview(): Promise<Overview> {
    return this.cdp.evaluate<Overview>(`(() => {
      const hex = ${HEX};
      const view = document.querySelector("#views > .view.overview");
      const shown = (el) => el && getComputedStyle(el).display !== "none";
      const name = view.querySelector(".who .name");
      const second = view.querySelector(".others .second");
      const row = view.querySelector(".others .panitas");
      const quiet = view.querySelector(".others .quiet");
      return {
        primary: name ? {
          name: name.textContent,
          color: hex(getComputedStyle(view.querySelector(".who .dot")).backgroundColor),
          title: name.getAttribute("title"),
          count: view.querySelector(".who .count")?.textContent ?? null,
        } : null,
        second: shown(second) ? {
          name: second.querySelector(".name").textContent,
          color: hex(getComputedStyle(second.querySelector(".dot")).backgroundColor),
          step: second.querySelector(".tick-text").textContent,
          badge: second.querySelector(".pill-badge")?.dataset.badge ?? null,
        } : null,
        panitas: shown(row) ? [...row.querySelectorAll(".panita:not(.more)")].map((p) => ({
          id: p.dataset.id,
          name: p.querySelector(".lbl").textContent,
          color: hex(p.dataset.color),
          badge: p.querySelector(".pill-badge")?.dataset.badge ?? null,
        })) : [],
        more: shown(row) ? (row.querySelector(".panita.more")?.textContent ?? null) : null,
        quiet: shown(quiet) ? quiet.textContent : null,
        fits: (() => {
          const box = view.getBoundingClientRect();
          return [...view.querySelectorAll(".card")]
            .map((c) => c.getBoundingClientRect())
            .every((r) => r.left >= box.left - 0.5 && r.right <= box.right + 0.5);
        })(),
      };
    })()`);
  }

  /** Waits until the overview satisfies `accept`, and returns it. */
  waitForOverview(what: string, accept: (o: Overview) => boolean, timeoutMs = 8_000): Promise<Overview> {
    return waitFor(what, async () => {
      const o = await this.overview();
      return accept(o) ? o : null;
    }, timeoutMs);
  }

  /** The compact island's grid. */
  compact(): Promise<Compact> {
    return this.cdp.evaluate<Compact>(`(() => {
      const hex = ${HEX};
      const grid = document.getElementById("mini-grid");
      return {
        minis: [...grid.querySelectorAll(".mini")].map((m) => ({ id: m.dataset.id, color: hex(m.dataset.color) })),
        more: grid.querySelector(".mini-more")?.textContent ?? null,
      };
    })()`);
  }

  /** `element.click()` on the panita named `name`. No real input. */
  async clickPanita(name: string) {
    const clicked = await this.cdp.evaluate<boolean>(`(() => {
      const panita = [...document.querySelectorAll(".view.overview .panitas .panita")]
        .find((p) => p.querySelector(".lbl")?.textContent === ${JSON.stringify(name)});
      if (!panita) return false;
      panita.click();
      return true;
    })()`);
    if (!clicked) throw new Error(`no panita named "${name}"`);
  }

  /** `element.click()` on the ↗ of the left card or of the second session. */
  async clickOpen(which: "primary" | "second") {
    await this.assertOpensIntercepted(`the ${which} card's ↗`);
    const selector = which === "primary" ? ".view.overview .left .jump" : ".view.overview .others .jump";
    const clicked = await this.cdp.evaluate<boolean>(`(() => {
      const button = document.querySelector(${JSON.stringify(selector)});
      if (!button) return false;
      button.click();
      return true;
    })()`);
    if (!clicked) throw new Error(`no ↗ on the ${which} card`);
  }

  /**
   * From here on, every `open_*` command the page sends to Rust (open_in_vscode,
   * open_url, …) is recorded and answered here instead of reaching the app: a
   * test can click "Open" without a VS Code or Explorer window appearing on the
   * desktop. Everything else still goes through.
   */
  async interceptOpens() {
    // Tauri's `invoke` is a read-only property, but its transport is a plain
    // fetch() to the IPC protocol (tauri/scripts/ipc-protocol.js), looked up at
    // call time. A command answered here never reaches Rust. The answer must
    // always resolve: a rejected fetch makes Tauri retry over postMessage, which
    // would.
    const ok = await this.cdp.evaluate<boolean>(`(async () => {
      "use strict";
      if (!window.__e2eOpens) {
        window.__e2eOpens = [];
        const realFetch = window.fetch.bind(window);
        window.fetch = (input, init) => {
          let url = null;
          try {
            url = new URL(typeof input === "string" ? input : input.url);
          } catch {}
          const ipc = url && (url.protocol === "ipc:" || url.hostname === "ipc.localhost");
          const cmd = ipc ? decodeURIComponent(url.pathname.slice(1)) : "";
          if (!cmd.startsWith("open_")) return realFetch(input, init);
          let args = null;
          try {
            args = JSON.parse(init && typeof init.body === "string" ? init.body : "null");
          } catch {}
          window.__e2eOpens.push({ cmd, args });
          return Promise.resolve(new Response("false", {
            headers: { "Content-Type": "application/json", "Tauri-Response": "ok" },
          }));
        };
      }
      // Prove it before any test relies on it: a command Rust does not have
      // must come back answered, and recorded, instead of failing over there.
      const answer = await window.__TAURI_INTERNALS__.invoke("open_e2e_probe", {});
      const probe = window.__e2eOpens.pop();
      return answer === false && probe?.cmd === "open_e2e_probe";
    })()`).catch(() => false);
    if (!ok) throw new Error("could not intercept open_* commands; refusing to click any Open button");
  }

  /**
   * Re-proves the interception right before a click that would open something.
   * Should Tauri ever give up on fetch and switch to postMessage, the probe goes
   * to Rust (an unknown command, harmless) and the click is refused.
   */
  private async assertOpensIntercepted(what: string) {
    try {
      await this.interceptOpens();
    } catch {
      throw new Error(`refusing to click ${what}: open_* commands are not intercepted`);
    }
  }

  /** The `open_*` commands recorded since interceptOpens(), oldest first. */
  opens(): Promise<{ cmd: string; args: Record<string, unknown> | null }[]> {
    return this.cdp.evaluate(`window.__e2eOpens ?? []`);
  }

  /**
   * Tells the island the pointer is nowhere near it, through the same `cursor`
   * event the Rust cursor poll sends. The poll only speaks when the real mouse
   * moves, so this holds as long as nobody moves it over the island — the
   * session order stands still while the pointer is on the open island.
   */
  pointerAway(): Promise<unknown> {
    return this.emit("cursor", { x: -10_000, y: -10_000 });
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
    // "Open terminal" and friends launch VS Code or Explorer on the desktop.
    if (/^open/i.test(label)) await this.assertOpensIntercepted(`"${label}"`);
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

  /**
   * The ticker rows a person can actually see, top to bottom: for each row with
   * any real opacity, the copy of its text that is showing (shimmering or dim,
   * whichever is more opaque) and the vertical span it is drawn on.
   */
  tickerRows(): Promise<{ text: string; top: number; bottom: number }[]> {
    return this.cdp.evaluate(`(() => {
      const opacity = (el) => Number(getComputedStyle(el).opacity);
      return [...document.querySelectorAll(".view.overview .ticker .ticker-row")]
        .filter((row) => opacity(row) > 0.5)
        .map((row) => {
          const shown = [...row.querySelectorAll(".tick-text")]
            .reduce((a, b) => (opacity(b) > opacity(a) ? b : a));
          const r = shown.getBoundingClientRect();
          return { text: shown.textContent ?? "", top: r.top, bottom: r.bottom };
        })
        .sort((a, b) => a.top - b.top);
    })()`);
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
    // A view fades in over 0.46 s (style.css, `.view.on`); settle() only waits
    // for the island's size. Without this the cards were caught half-faded.
    await sleep(500);
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

  /** The tray's Quit, through the same command. The page goes away with the app. */
  async quit() {
    await this.cdp
      .evaluate(`window.__TAURI_INTERNALS__.invoke("quit_app"), true`)
      .catch(() => undefined);
  }
}
