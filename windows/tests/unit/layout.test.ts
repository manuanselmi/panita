// Where the island is drawn inside its 720 px window. Rust places the window and
// hands over the island's centre in it (src-tauri/src/island.rs); islandLeft
// turns that into the island's left edge for whatever width it has right now.

import { describe, expect, it } from "vitest";
import {
  COMPACT_W, EXPANDED_W, NOTCH_H, NOTCH_W, PANEL_H, PANEL_W, VIEW_LAYOUTS, islandLeft, islandSize,
} from "../../src/core/layout";

describe("islandSize: cards that grow with their text", () => {
  it("the approval and question cards add what they ask for", () => {
    expect(islandSize("expanded", "approval", 0, 30)).toEqual({ w: EXPANDED_W, h: VIEW_LAYOUTS.approval.height + 30 });
    expect(islandSize("expanded", "question", 0, 19)).toEqual({ w: EXPANDED_W, h: VIEW_LAYOUTS.question.height + 19 });
    expect(islandSize("expanded", "approval")).toEqual({ w: EXPANDED_W, h: VIEW_LAYOUTS.approval.height });
  });

  it("no other view grows, and nothing grows while the island is closed", () => {
    expect(islandSize("expanded", "overview", 0, 30).h).toBe(VIEW_LAYOUTS.overview.height);
    expect(islandSize("expanded", "finished", 0, 30).h).toBe(VIEW_LAYOUTS.finished.height);
    expect(islandSize("compact", "approval", 0, 30)).toEqual({ w: COMPACT_W, h: NOTCH_H });
    expect(islandSize("hidden", "approval", 0, 30).h).toBe(0);
  });

  it("never past the window, and never smaller than the card", () => {
    expect(islandSize("expanded", "approval", 0, 1_000).h).toBe(PANEL_H);
    expect(islandSize("expanded", "approval", 0, -20).h).toBe(VIEW_LAYOUTS.approval.height);
  });
});

describe("islandLeft", () => {
  it("centred in the panel, as before the island could move", () => {
    for (const w of [NOTCH_W, COMPACT_W, EXPANDED_W]) {
      expect(islandLeft(PANEL_W / 2, w)).toBe((PANEL_W - w) / 2);
    }
  });

  it("flush right: the compact island ends on the window's right edge, and so does the open one", () => {
    // Rust's centre for an island dragged all the way right (panel_cx).
    const cx = PANEL_W - COMPACT_W / 2;
    expect(islandLeft(cx, COMPACT_W) + COMPACT_W).toBe(PANEL_W);
    expect(islandLeft(cx, EXPANDED_W) + EXPANDED_W).toBe(PANEL_W);
    // Every width in between, as it springs open: never past the edge.
    for (let w = COMPACT_W; w <= EXPANDED_W; w += 16) {
      expect(islandLeft(cx, w) + w).toBe(PANEL_W);
    }
  });

  it("flush left: it opens towards the right", () => {
    const cx = COMPACT_W / 2;
    expect(islandLeft(cx, COMPACT_W)).toBe(0);
    expect(islandLeft(cx, EXPANDED_W)).toBe(0);
  });

  it("partway to an edge: centred while it fits, then held inside", () => {
    const cx = 480; // 120 px right of the middle
    expect(islandLeft(cx, COMPACT_W)).toBe(cx - COMPACT_W / 2);
    expect(islandLeft(cx, EXPANDED_W)).toBe(PANEL_W - EXPANDED_W);
  });
});
