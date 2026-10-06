// The meters drawn from Claude Code's status line (src/core/usage.ts), all the
// same hairline bar and percentage:
//
// - The usage meter: the subscription's 5-hour window, with the time left
//   until it resets. Two of them: one centred in the open island's header
//   strip, one in the middle of the compact island. Neither is a button — a
//   press on the header's one is a press on the strip, which folds and drags
//   the island. Hidden until a status line has said something, and again once
//   its window has reset.
// - The context meter: how full the context window of the session on the left
//   card is, along the foot of that card. Hidden until that session's status
//   line has said so.
//
// Motion, all of it finite: each time a meter comes on screen (the island
// opening, or folding back; another session taking the left card) its bar
// fills from empty and the percentage counts up with it; a new reading eases
// the bar to its new length, and one that went up sends a glint along it. The
// countdown redraws itself once a minute, and only while its meter is on
// screen: nothing ticks behind a hidden island.

import { h } from "./dom";
import { State, type SessionTask } from "../core/state";
import {
  contextTitle, live, percentLabel, resetIn, untilNextMinute, usageLevel, usageTitle,
} from "../core/usage";

/** How long the bar and the percentage take to reach a new reading — style.css's .usage-fill transition. */
const EASE_MS = 900;

/** cubic-bezier(0.22, 1, 0.36, 1), the bar's transition, near enough for the digits to keep up. */
function easeOutQuint(k: number): number {
  return 1 - (1 - k) ** 5;
}

/** How a reading reaches the bar: at once (off screen), filling from empty, or from where it is. */
type Entry = "set" | "fresh" | "move";

interface Bar {
  track: HTMLElement;
  pct: HTMLElement;
  show(to: number, entry: Entry): void;
  /** Nothing to show any more: the next reading fills from empty. */
  forget(): void;
}

function buildBar(): Bar {
  const fill = h("i", { class: "usage-fill" });
  const track = h("span", { class: "usage-track" }, fill);
  const pct = h("span", { class: "usage-pct" });
  fill.addEventListener("animationend", () => fill.classList.remove("glint"));

  /** The percentage the bar shows, or is easing to; null while there is none. */
  let at: number | null = null;
  let counting: number | null = null;

  function countTo(from: number, to: number) {
    if (counting != null) cancelAnimationFrame(counting);
    const start = performance.now();
    const step = (now: number) => {
      const k = Math.min(1, (now - start) / EASE_MS);
      pct.textContent = percentLabel(k < 1 ? from + (to - from) * easeOutQuint(k) : to);
      counting = k < 1 ? requestAnimationFrame(step) : null;
    };
    counting = requestAnimationFrame(step);
  }

  function settle(to: number) {
    if (counting != null) cancelAnimationFrame(counting);
    counting = null;
    pct.textContent = percentLabel(to);
  }

  /** The bar from `from` to `to`; from scratch, it has to start at `from` first. */
  function moveBar(from: number, to: number, fresh: boolean) {
    if (fresh) {
      fill.style.transition = "none";
      fill.style.width = `${from}%`;
      void fill.offsetWidth;
      fill.style.transition = "";
    }
    fill.style.width = `${to}%`;
    if (to > from) {
      fill.classList.remove("glint");
      void fill.offsetWidth;
      fill.classList.add("glint");
    }
  }

  return {
    track,
    pct,
    show(to, entry) {
      if (entry === "set") {
        // Off screen nothing moves: the reading is just set, for the next time it shows.
        fill.style.width = `${to}%`;
        settle(to);
      } else if (entry === "fresh" || at == null) {
        moveBar(0, to, true);
        countTo(0, to);
      } else if (to !== at) {
        moveBar(at, to, false);
        countTo(at, to);
      }
      at = to;
    },
    forget() {
      at = null;
    },
  };
}

export interface UsageMeter {
  el: HTMLElement;
  /** Redraws from State.usage. `shown`: the meter is on screen in the island's current mode. */
  sync(nowMs: number, shown: boolean): void;
}

export function buildUsageMeter(variant: "header" | "compact"): UsageMeter {
  const reset = h("span", { class: "usage-reset" });
  const bar = buildBar();
  const el = h("div", { class: `usage ${variant}`, "data-level": "ok" }, reset, bar.track, bar.pct);
  // Hidden until a status line has said something: an empty track is not a 0 %.
  el.style.display = "none";

  let key = "";
  let wasShown = false;
  let ticking: number | null = null;

  function sync(nowMs: number, shown: boolean) {
    const five = live(State.usage?.fiveHour, nowMs);

    if (ticking != null) window.clearTimeout(ticking);
    ticking = five && shown
      ? window.setTimeout(() => sync(Date.now(), true), untilNextMinute(five.resetsAt, nowMs))
      : null;

    const left = five ? resetIn(five.resetsAt, nowMs) : null;
    const next = five ? `${five.usedPercentage}~${left}~${State.usage?.sevenDay?.usedPercentage}` : "";
    const appearing = shown && !wasShown;
    wasShown = shown;
    if (next === key && !appearing) return;
    key = next;

    el.style.display = five ? "" : "none";
    if (!five) {
      bar.forget();
      return;
    }
    reset.textContent = left ?? "";
    el.dataset.level = usageLevel(five.usedPercentage);
    el.title = usageTitle(State.usage, nowMs);
    bar.show(five.usedPercentage, !shown ? "set" : appearing ? "fresh" : "move");
  }

  return { el, sync };
}

export interface ContextMeter {
  el: HTMLElement;
  /** Redraws for the session on the left card (null: none there). `shown`: the card is on screen. */
  sync(task: SessionTask | null, shown: boolean): void;
}

export function buildContextMeter(): ContextMeter {
  const bar = buildBar();
  const el = h("div", { class: "usage context", "data-level": "ok" }, bar.track, bar.pct);
  el.style.display = "none";

  let key = "";
  let wasShown = false;
  let whose: string | null = null;

  return {
    el,
    sync(task, shown) {
      const c = task?.context ?? null;
      const next = c && task ? `${task.id}~${c.usedPercentage}~${c.tokens}~${c.windowSize}` : "";
      // Another session on the left card is a new meter, as much as the card coming on screen.
      const appearing = shown && (!wasShown || (task?.id ?? null) !== whose);
      wasShown = shown;
      whose = task?.id ?? null;
      if (next === key && !appearing) return;
      key = next;

      el.style.display = c ? "" : "none";
      if (!c) {
        bar.forget();
        return;
      }
      el.dataset.level = usageLevel(c.usedPercentage);
      el.title = contextTitle(c);
      bar.show(c.usedPercentage, !shown ? "set" : appearing ? "fresh" : "move");
    },
  };
}
