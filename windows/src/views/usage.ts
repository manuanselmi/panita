// The usage meter: the subscription's 5-hour window as the time left until it
// resets, a hairline bar and its percentage (src/core/usage.ts). Two of them:
// one centred in the open island's header strip, one in the middle of the
// compact island. Neither is a button — a press on the header's one is a press
// on the strip, which folds and drags the island. Hidden until a status line
// has said something, and again once its window has reset.
//
// Motion, all of it finite: each time a meter comes on screen (the island
// opening, or folding back) its bar fills from empty and the percentage counts
// up with it; a new reading eases the bar to its new length, and one that went
// up sends a glint along it. The countdown redraws itself once a minute, and
// only while its meter is on screen: nothing ticks behind a hidden island.

import { h } from "./dom";
import { State } from "../core/state";
import { live, percentLabel, resetIn, untilNextMinute, usageLevel, usageTitle } from "../core/usage";

export interface UsageMeter {
  el: HTMLElement;
  /** Redraws from State.usage. `shown`: the meter is on screen in the island's current mode. */
  sync(nowMs: number, shown: boolean): void;
}

/** How long the bar and the percentage take to reach a new reading — style.css's .usage-fill transition. */
const EASE_MS = 900;

/** cubic-bezier(0.22, 1, 0.36, 1), the bar's transition, near enough for the digits to keep up. */
function easeOutQuint(k: number): number {
  return 1 - (1 - k) ** 5;
}

export function buildUsageMeter(variant: "header" | "compact"): UsageMeter {
  const reset = h("span", { class: "usage-reset" });
  const fill = h("i", { class: "usage-fill" });
  const pct = h("span", { class: "usage-pct" });
  const el = h(
    "div",
    { class: `usage ${variant}`, "data-level": "ok" },
    reset,
    h("span", { class: "usage-track" }, fill),
    pct,
  );
  // Hidden until a status line has said something: an empty track is not a 0 %.
  el.style.display = "none";
  fill.addEventListener("animationend", () => fill.classList.remove("glint"));

  let key = "";
  let wasShown = false;
  /** The percentage the bar shows, or is easing to; null while there is none. */
  let at: number | null = null;
  let counting: number | null = null;
  let ticking: number | null = null;

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
      at = null;
      return;
    }
    reset.textContent = left ?? "";
    el.dataset.level = usageLevel(five.usedPercentage);
    el.title = usageTitle(State.usage, nowMs);

    const to = five.usedPercentage;
    if (!shown) {
      // Off screen nothing moves: the reading is just set, for the next time it shows.
      fill.style.width = `${to}%`;
      settle(to);
    } else if (appearing || at == null) {
      moveBar(0, to, true);
      countTo(0, to);
    } else if (to !== at) {
      moveBar(at, to, false);
      countTo(at, to);
    }
    at = to;
  }

  return { el, sync };
}
