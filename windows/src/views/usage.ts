// The usage meter: the subscription's 5-hour window as a hairline bar and its
// percentage (src/core/usage.ts). Two of them: one centred in the open
// island's header strip, one in the middle of the compact island. Neither is a
// button — a press on the header's one is a press on the strip, which folds
// and drags the island. Hidden until a status line has said something, and
// again once its window has reset.

import { h } from "./dom";
import { State } from "../core/state";
import { live, percentLabel, usageLevel, usageTitle } from "../core/usage";

export interface UsageMeter {
  el: HTMLElement;
  sync(nowMs: number): void;
}

export function buildUsageMeter(variant: "header" | "compact"): UsageMeter {
  const fill = h("i", { class: "usage-fill" });
  const pct = h("span", { class: "usage-pct" });
  const el = h(
    "div",
    { class: `usage ${variant}`, "data-level": "ok" },
    variant === "header" ? h("span", { class: "usage-label", text: "5h" }) : null,
    h("span", { class: "usage-track" }, fill),
    pct,
  );
  // Hidden until a status line has said something: an empty track is not a 0 %.
  el.style.display = "none";
  let key = "";
  return {
    el,
    sync(nowMs: number) {
      const five = live(State.usage?.fiveHour, nowMs);
      const next = five ? `${five.usedPercentage}~${five.resetsAt}~${State.usage?.sevenDay?.usedPercentage}` : "";
      if (next === key) return;
      key = next;
      el.style.display = five ? "" : "none";
      if (!five) return;
      fill.style.width = `${five.usedPercentage}%`;
      pct.textContent = percentLabel(five.usedPercentage);
      el.dataset.level = usageLevel(five.usedPercentage);
      el.title = usageTitle(State.usage, nowMs);
    },
  };
}
