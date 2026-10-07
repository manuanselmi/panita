// The subscription's usage (src/core/usage.ts): what the `usage` event carries
// (pipe.rs, from Claude Code's status line), and how the meter reads it.

import { describe, expect, it } from "vitest";
import { live, parseUsage, percentLabel, resetIn, untilNextMinute, usageLevel, usageTitle } from "../../src/core/usage";

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

  it("counts down to the reset in whole minutes, rounded up, and says nothing once it has reset", () => {
    const at = (s: number) => resetIn(NOW / 1000 + s, NOW);
    expect(at(5 * 3600)).toBe("5h 00m");
    expect(at(2 * 3600 + 14 * 60)).toBe("2h 14m");
    expect(at(2 * 3600 + 5 * 60 - 30)).toBe("2h 05m");
    expect(at(3600)).toBe("1h 00m");
    expect(at(3600 - 1)).toBe("1h 00m"); // 59 min 59 s: still the first minute of the hour
    expect(at(3600 - 60)).toBe("59m");
    expect(at(47 * 60)).toBe("47m");
    expect(at(61)).toBe("2m");
    expect(at(60)).toBe("1m");
    expect(at(0.001)).toBe("1m");
    expect(at(0)).toBeNull();
    expect(at(-5)).toBeNull();
  });

  it("the countdown redraws as the time left reaches the next whole minute", () => {
    const resetsAt = NOW / 1000 + 2 * 3600 + 14 * 60 + 25; // "2h 15m" for 25 s more
    expect(untilNextMinute(resetsAt, NOW)).toBe(25_050);
    expect(resetIn(resetsAt, NOW + 24_999)).toBe("2h 15m");
    expect(resetIn(resetsAt, NOW + 25_050)).toBe("2h 14m");
    // On a whole minute, the next change is a minute away.
    expect(untilNextMinute(NOW / 1000 + 120, NOW)).toBe(60_050);
    expect(untilNextMinute(NOW / 1000 + 0.5, NOW)).toBe(550);
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
