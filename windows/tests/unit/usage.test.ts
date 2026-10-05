// The subscription's usage (src/core/usage.ts): what the `usage` event carries
// (pipe.rs, from Claude Code's status line), and how the meter reads it.

import { describe, expect, it } from "vitest";
import { live, parseUsage, percentLabel, usageLevel, usageTitle } from "../../src/core/usage";

const NOW = Date.UTC(2026, 9, 5, 15, 0, 0); // ms
const IN_AN_HOUR = NOW / 1000 + 3600; // s

describe("parseUsage", () => {
  it("takes the two windows the app sends", () => {
    expect(
      parseUsage({
        fiveHour: { usedPercentage: 42.5, resetsAt: IN_AN_HOUR },
        sevenDay: { usedPercentage: 18, resetsAt: IN_AN_HOUR + 86_400 },
      }),
    ).toEqual({
      fiveHour: { usedPercentage: 42.5, resetsAt: IN_AN_HOUR },
      sevenDay: { usedPercentage: 18, resetsAt: IN_AN_HOUR + 86_400 },
    });
  });

  it("a missing or odd window is null; no window at all is nothing", () => {
    expect(parseUsage({ fiveHour: null, sevenDay: { usedPercentage: 3, resetsAt: 9 } })).toEqual({
      fiveHour: null,
      sevenDay: { usedPercentage: 3, resetsAt: 9 },
    });
    expect(parseUsage({ fiveHour: { usedPercentage: 140, resetsAt: 9 } })?.fiveHour?.usedPercentage).toBe(100);
    for (const odd of [null, "x", {}, { fiveHour: { usedPercentage: "42", resetsAt: 9 } }, { fiveHour: { usedPercentage: 1 } }]) {
      expect(parseUsage(odd), JSON.stringify(odd)).toBeNull();
    }
  });
});

describe("the meter", () => {
  it("a window is shown until it resets, not after", () => {
    const w = { usedPercentage: 40, resetsAt: IN_AN_HOUR };
    expect(live(w, NOW)).toBe(w);
    expect(live(w, IN_AN_HOUR * 1000 - 1)).toBe(w);
    expect(live(w, IN_AN_HOUR * 1000)).toBeNull();
    expect(live(null, NOW)).toBeNull();
  });

  it("amber from 80 %, red from 95 %", () => {
    expect([0, 79.9, 80, 94.9, 95, 100].map(usageLevel)).toEqual(["ok", "ok", "warn", "warn", "high", "high"]);
  });

  it("whole percents, and a sliver used is never 0 %", () => {
    expect([0, 0.2, 0.5, 41.6, 99.6, 100].map(percentLabel)).toEqual(["0%", "1%", "1%", "42%", "100%", "100%"]);
  });

  it("the tooltip names both windows and when the 5-hour one resets, in local time", () => {
    const resets = new Date(IN_AN_HOUR * 1000);
    const at = `${String(resets.getHours()).padStart(2, "0")}:${String(resets.getMinutes()).padStart(2, "0")}`;
    const usage = {
      fiveHour: { usedPercentage: 42, resetsAt: IN_AN_HOUR },
      sevenDay: { usedPercentage: 18, resetsAt: IN_AN_HOUR + 86_400 },
    };
    expect(usageTitle(usage, NOW)).toBe(`5-hour limit: 42% used · resets at ${at}\nWeekly limit: 18% used`);
    // A window that has reset is left out.
    expect(usageTitle({ ...usage, sevenDay: { usedPercentage: 18, resetsAt: NOW / 1000 - 1 } }, NOW)).toBe(
      `5-hour limit: 42% used · resets at ${at}`,
    );
    expect(usageTitle(null, NOW)).toBe("");
  });
});
