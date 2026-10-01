// Where the island is drawn inside its 720 px window. Rust places the window and
// hands over the island's centre in it (src-tauri/src/island.rs); islandLeft
// turns that into the island's left edge for whatever width it has right now.

import { describe, expect, it } from "vitest";
import { COMPACT_W, EXPANDED_W, NOTCH_W, PANEL_W, islandLeft } from "../../src/core/layout";

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
