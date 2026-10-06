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
  /** The approval card's explanation line, when it shows one. */
  explain: string | null;
  /** Its parts, and which are flagged dangerous (red, with the ⚠ up front). */
  explainParts: { text: string; danger: boolean }[];
  explainWarn: boolean;
}

/** The approval or question card's rows, as laid out on screen (IslandPage.cardLayout). */
export interface CardLayout {
  inside: boolean;
  ordered: boolean;
  cardHeight: number;
  /** Space between the card's top edge and the first row, and between the last row and its bottom edge. */
  topGap: number;
  bottomGap: number;
  rows: { top: number; height: number }[];
  /** Lines the explanation (approval) or the options (question) take on screen; 0 when not shown. */
  explainLines: number;
  /** Its text is cut short: more of it than the lines on screen hold. */
  explainClamped: boolean;
  /** Its width on screen, px. */
  explainWidth: number;
  /** Lines the question takes (question card), 0 otherwise. */
  titleLines: number;
  /** The ↗ (approval card), or null without one: inside the card, clear of every row's text. */
  jump: { inside: boolean; clear: boolean } | null;
}

/**
 * How a label ("struxto-especificador 2") fits its box: its number must stay
 * inside it however long the name, and only the name part may be cut.
 */
export interface LabelFit {
  text: string;
  /** " 2", or "" for the first of a name. */
  suffix: string;
  /** The number is drawn, and inside the label and its card. */
  suffixInside: boolean;
  /** The name part is cut short (ends in "…" on screen). */
  truncated: boolean;
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
  primary:
    | (Shown & {
        title: string | null;
        count: string | null;
        label: LabelFit;
        /** "Claude Code" after the name: whole or hidden, never cut to "C…". */
        tool: "whole" | "hidden" | "cut";
      })
    | null;
  /** The right card's panitas, row by row, left to right. */
  panitas: (Shown & { id: string; badge: string | null; title: string | null; label: LabelFit })[];
  /** Panitas per row of the grid. */
  rows: number[];
  /** The "+N" in the last slot. */
  more: string | null;
  /** The quiet line of an otherwise empty right card. */
  quiet: string | null;
  /**
   * Both cards lie within the overview, and every panita within the right
   * card (meaningful once the island is open).
   */
  fits: boolean;
}

/** The compact island's mini Mochis, and its "+N". */
export interface Compact {
  minis: { id: string; color: string }[];
  more: string | null;
}

/** In-page helper: how a `.label` fits (see LabelFit). */
const LABEL_FIT = `(label) => {
  const nr = label.querySelector(".label-nr");
  const name = label.querySelector(".label-name") ?? label;
  const card = label.closest(".card");
  const box = label.getBoundingClientRect();
  const r = nr?.getBoundingClientRect();
  const c = card?.getBoundingClientRect();
  return {
    text: label.textContent ?? "",
    suffix: nr?.textContent ?? "",
    suffixInside: !nr || (r.width > 0 && r.right <= box.right + 0.5 && r.left >= box.left - 0.5 && (!c || r.right <= c.right + 0.5)),
    truncated: name.scrollWidth > name.clientWidth + 0.5,
  };
}`;

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

/** Where the island window and the island in it are, as Tauri and the DOM see them. */
export interface Placement {
  /** The island window, physical px. */
  window: { x: number; width: number };
  /** The display it is on, physical px. */
  monitor: { x: number; width: number };
  scale: number;
  /** The island inside the window, CSS px, and the window's own width. */
  island: { left: number; right: number };
  viewport: number;
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
      const explain = el.querySelector(".explain");
      const shown = explain && getComputedStyle(explain).display !== "none";
      return {
        classes: el.className,
        text: el.textContent ?? "",
        code: el.querySelector(".code")?.textContent ?? null,
        buttons: [...el.querySelectorAll("button.btn")].map((b) => b.querySelector("span")?.textContent ?? ""),
        who: name?.textContent ?? null,
        whoColor: dot ? hex(getComputedStyle(dot).backgroundColor) : null,
        explain: shown ? [...explain.querySelectorAll(".part, .sep")].map((p) => p.textContent).join("") : null,
        explainParts: shown ? [...explain.querySelectorAll(".part")].map((p) => ({ text: p.textContent, danger: p.classList.contains("danger") })) : [],
        explainWarn: !!(shown && explain.querySelector(".warn")),
      };
    })()`);
  }

  /** How the active view's name labels fit (who row, approval / finished cards). */
  labels(): Promise<LabelFit[]> {
    return this.cdp.evaluate<LabelFit[]>(`(() => {
      const fit = ${LABEL_FIT};
      return [...document.querySelectorAll("#views > .view.on .label")].map(fit);
    })()`);
  }

  /**
   * The approval or question card's layout: its rows — who, the command or the
   * question, the explanation or the options, the buttons — in order, inside
   * the card; and how the text row under the first one wraps.
   */
  cardLayout(view: "approval" | "question" = "approval"): Promise<CardLayout> {
    return this.cdp.evaluate(`(() => {
      const view = document.querySelector("#views > .view.${view}");
      const card = view.querySelector(".card").getBoundingClientRect();
      const shown = (el) => el && getComputedStyle(el).display !== "none";
      const selectors = ${JSON.stringify(view)} === "approval"
        ? [".who-row", ".code", ".explain", ".actions"]
        : [".who-row", ".title", ".explain", ".actions"];
      const els = selectors.map((s) => view.querySelector(s + ":not(.sizer)")).filter(shown);
      const rows = els.map((el) => el.getBoundingClientRect());
      const explain = view.querySelector(".explain:not(.sizer)");
      const title = view.querySelector(".title:not(.sizer)");
      const jumpEl = view.querySelector(".jump");
      const j = jumpEl ? jumpEl.getBoundingClientRect() : null;
      const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
      // Text runs, not row boxes: a row is as wide as the card, its words are not.
      const textRects = els.flatMap((el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        return [...range.getClientRects()];
      });
      return {
        inside: rows.every((r) => r.top >= card.top - 0.5 && r.bottom <= card.bottom + 0.5 && r.right <= card.right + 0.5),
        ordered: rows.every((r, i) => i === 0 || r.top >= rows[i - 1].bottom - 0.5),
        cardHeight: Math.round(card.height),
        topGap: Math.round(rows[0].top - card.top),
        bottomGap: Math.round(card.bottom - rows.at(-1).bottom),
        rows: rows.map((r) => ({ top: Math.round(r.top - card.top), height: Math.round(r.height) })),
        explainLines: shown(explain) ? Math.round(explain.clientHeight / 15) : 0,
        explainClamped: !!(shown(explain) && explain.scrollHeight > explain.clientHeight + 0.5),
        explainWidth: shown(explain) ? Math.round(explain.getBoundingClientRect().width) : 0,
        titleLines: ${JSON.stringify(view)} === "question" && shown(title) ? Math.round(title.clientHeight / 19) : 0,
        jump: j ? {
          inside: j.top >= card.top && j.bottom <= card.bottom && j.left >= card.left && j.right <= card.right,
          clear: textRects.every((r) => !overlaps(r, j)),
        } : null,
      };
    })()`);
  }

  /**
   * The two usage meters — in the open island's header and in the middle of
   * the compact island — as drawn: shown or not, their countdown, percentage,
   * level, fill and tooltip, and where their bar sits against the island.
   */
  usageMeters(): Promise<Record<"header" | "compact", {
    shown: boolean;
    /** The time left until the 5-hour window resets, "2h 14m". */
    reset: string | null;
    pct: string | null;
    level: string | null;
    fill: string | null;
    title: string;
    /** The bar's horizontal centre minus the island's, px. */
    offCentre: number;
    opacity: number;
  }>> {
    return this.cdp.evaluate(`(() => {
      const island = document.getElementById("island").getBoundingClientRect();
      const read = (el) => {
        const shown = !!el && getComputedStyle(el).display !== "none";
        const r = el?.querySelector(".usage-track").getBoundingClientRect();
        return {
          shown,
          reset: shown ? el.querySelector(".usage-reset").textContent : null,
          pct: shown ? el.querySelector(".usage-pct").textContent : null,
          level: shown ? el.dataset.level : null,
          fill: shown ? el.querySelector(".usage-fill").style.width : null,
          title: el?.title ?? "",
          offCentre: r ? Math.round((r.left + r.width / 2) - (island.left + island.width / 2)) : 0,
          opacity: el ? Number(getComputedStyle(el).opacity) : 0,
        };
      };
      return {
        header: read(document.querySelector("#header .usage")),
        compact: read(document.querySelector("#island > .usage.compact")),
      };
    })()`);
  }

  /** The left card's context meter, as drawn, and where it sits in the card. */
  contextMeter(): Promise<{
    shown: boolean;
    pct: string | null;
    level: string | null;
    fill: string | null;
    title: string;
    /** Its left and right edges against the ticker's (the steps above it), px: 0 is flush. */
    vsTicker: { left: number; right: number };
    /** px from the card's bottom edge. */
    bottom: number;
    /** Room between the bottom of the ticker and the top of the meter, px. */
    belowTicker: number;
  }> {
    return this.cdp.evaluate(`(() => {
      const card = document.querySelector("#views > .view.overview > .left > .card");
      const el = card.querySelector(".usage.context");
      const shown = getComputedStyle(el).display !== "none";
      const c = card.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      const t = card.querySelector(".ticker")?.getBoundingClientRect();
      return {
        shown,
        pct: shown ? el.querySelector(".usage-pct").textContent : null,
        level: shown ? el.dataset.level : null,
        fill: shown ? el.querySelector(".usage-fill").style.width : null,
        title: el.title,
        vsTicker: t ? { left: Math.round(r.left - t.left), right: Math.round(t.right - r.right) } : null,
        bottom: Math.round(c.bottom - r.bottom),
        belowTicker: t ? Math.round(r.top - t.bottom) : 0,
      };
    })()`);
  }

  /** The open island's header strip against the island's own edges, px (0 = flush). */
  headerEdges(): Promise<{ top: number; left: number; right: number }> {
    return this.cdp.evaluate(`(() => {
      const island = document.getElementById("island").getBoundingClientRect();
      const header = document.getElementById("header").getBoundingClientRect();
      return {
        top: Math.round(header.top - island.top),
        left: Math.round(header.left - island.left),
        right: Math.round(island.right - header.right),
      };
    })()`);
  }

  /** `element.click()` on the ↗ of the card on screen (approval card). Opens must be intercepted. */
  async clickCardOpen() {
    await this.assertOpensIntercepted("the card's ↗");
    const clicked = await this.cdp.evaluate<boolean>(`(() => {
      const button = document.querySelector("#views > .view.on .jump");
      if (!button) return false;
      button.click();
      return true;
    })()`);
    if (!clicked) throw new Error("no ↗ on the card on screen");
  }

  /** The overview's cards, read from the DOM whether or not the island is open. */
  overview(): Promise<Overview> {
    return this.cdp.evaluate<Overview>(`(() => {
      const hex = ${HEX};
      const fit = ${LABEL_FIT};
      const view = document.querySelector("#views > .view.overview");
      const shown = (el) => el && getComputedStyle(el).display !== "none";
      const name = view.querySelector(".who .name");
      const grid = view.querySelector(".others .panitas");
      const quiet = view.querySelector(".others .quiet");
      return {
        primary: name ? {
          name: name.textContent,
          color: hex(getComputedStyle(view.querySelector(".who .dot")).backgroundColor),
          title: name.getAttribute("title"),
          count: view.querySelector(".who .count")?.textContent ?? null,
          label: fit(name),
          tool: (() => {
            const slot = view.querySelector(".who .tool-slot")?.getBoundingClientRect();
            const tool = view.querySelector(".who .tool")?.getBoundingClientRect();
            if (!slot || !tool) return "hidden";
            if (tool.top >= slot.bottom - 0.5 || slot.width < 0.5) return "hidden";
            return tool.right <= slot.right + 0.5 ? "whole" : "cut";
          })(),
        } : null,
        panitas: shown(grid) ? [...grid.querySelectorAll(".panita:not(.more)")].map((p) => ({
          id: p.dataset.id,
          name: p.querySelector(".lbl").textContent,
          color: hex(p.dataset.color),
          badge: p.querySelector(".pill-badge")?.dataset.badge ?? null,
          title: p.getAttribute("title"),
          label: fit(p.querySelector(".lbl")),
        })) : [],
        rows: shown(grid) ? [...grid.querySelectorAll(".panita-row")].map((r) => r.children.length) : [],
        more: shown(grid) ? (grid.querySelector(".panita.more .more-disc")?.textContent ?? null) : null,
        quiet: shown(quiet) ? quiet.textContent : null,
        fits: (() => {
          const box = view.getBoundingClientRect();
          const cardsIn = [...view.querySelectorAll(".card")]
            .map((c) => c.getBoundingClientRect())
            .every((r) => r.left >= box.left - 0.5 && r.right <= box.right + 0.5);
          const right = view.querySelector(".right .card").getBoundingClientRect();
          const panitasIn = [...view.querySelectorAll(".others .panita")]
            .map((p) => p.getBoundingClientRect())
            .every((r) => r.left >= right.left - 0.5 && r.right <= right.right + 0.5 && r.top >= right.top - 0.5 && r.bottom <= right.bottom + 0.5);
          return cardsIn && panitasIn;
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

  /** `element.click()` on the left card's ↗ (the right card has none: its panitas are clicked). */
  async clickOpen() {
    await this.assertOpensIntercepted("the left card's ↗");
    const clicked = await this.cdp.evaluate<boolean>(`(() => {
      const button = document.querySelector(".view.overview .left .jump");
      if (!button) return false;
      button.click();
      return true;
    })()`);
    if (!clicked) throw new Error("no ↗ on the left card");
    const others = await this.cdp.evaluate<number>(`document.querySelectorAll(".view.overview .right .jump").length`);
    if (others !== 0) throw new Error("the right card has a ↗ again");
  }

  /**
   * `element.click()` on a ↗ with nothing intercepted: `open_session` reaches
   * Rust. Only for the terminal-focus tests, whose sessions live in folders
   * that exist nowhere (no VS Code window can match them) and whose side
   * instance has the fake `code` first on PATH — checked by the caller through
   * `vscode_extension_status` before the first such click. So the most it can
   * do is ask the suite's own fake extension, and record a call to the fake.
   */
  async clickOpenUnintercepted(which: "primary" | "second") {
    const intercepted = await this.cdp.evaluate<boolean>(`!!window.__e2eRealFetch`);
    if (intercepted) throw new Error("open_* commands are still intercepted; call restoreOpens() first");
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
   * From here on, every `open_*` command the page sends to Rust (open_session,
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
        window.__e2eRealFetch = realFetch;
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
   * Undoes interceptOpens(): `open_*` commands reach Rust again. Only for tests
   * whose calls are refused by Rust before anything opens.
   */
  async restoreOpens() {
    await this.cdp.evaluate(`(() => {
      if (window.__e2eRealFetch) window.fetch = window.__e2eRealFetch;
      delete window.__e2eRealFetch;
      delete window.__e2eOpens;
    })()`);
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

  /** Window, display and island positions (Tauri's window getters + the DOM). */
  placement(): Promise<Placement> {
    return this.cdp.evaluate<Placement>(`(async () => {
      const T = window.__TAURI_INTERNALS__;
      const label = "island";
      const pos = await T.invoke("plugin:window|outer_position", { label });
      const size = await T.invoke("plugin:window|outer_size", { label });
      const mon = await T.invoke("plugin:window|current_monitor", { label });
      const r = document.getElementById("island").getBoundingClientRect();
      return {
        window: { x: pos.x, width: size.width },
        monitor: { x: mon.position.x, width: mon.size.width },
        scale: mon.scaleFactor,
        island: { left: r.left, right: r.right },
        viewport: window.innerWidth,
      };
    })()`);
  }

  /**
   * A `click` on the open island's header: on the empty strip, or on the Home
   * tab's icon. Only the click event itself — no mousedown, which would arm
   * Rust's drag against the real mouse button. (`element.click()` on the tab
   * would also run its own handler; the event alone tests the strip's.)
   */
  async clickHeader(where: "strip" | "tab" | "usage") {
    const ok = await this.cdp.evaluate<boolean>(`(() => {
      const header = document.getElementById("header");
      const where = ${JSON.stringify(where)};
      const target = where === "tab" ? header.querySelector(".tab svg") : where === "usage" ? header.querySelector(".usage") : header;
      if (!target) return false;
      target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
      return true;
    })()`);
    if (!ok) throw new Error(`no header ${where} to click`);
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
