// The settings window, seen through CDP — DOM queries and element.click() only,
// like island-page.ts. The window stays hidden: its page is loaded at launch,
// and clicking a button in a hidden page needs no real input and no focus.

import fs from "node:fs";
import path from "node:path";
import { Cdp } from "./cdp";
import { RESULTS_DIR, sleep, waitFor } from "./harness";

/** One hook target's row in Settings → Claude Code. */
export interface TargetRow {
  label: string;
  state: string;
  /** The settings.json path the row shows, once it has been checked. */
  path: string | null;
  buttons: string[];
  error: string | null;
}

/** The Claude Code section while a diff is on screen (or just after). */
export interface PreviewView {
  hint: string;
  diff: string | null;
  paths: string[];
  buttons: string[];
  ok: string | null;
  error: string | null;
}

const SECTION = `document.querySelector('section[data-section="claude-code"]')`;

export class SettingsPage {
  constructor(readonly cdp: Cdp) {}

  /** What lib.rs's show_settings_window tells the page; the cue to check every target. */
  shown(): Promise<unknown> {
    return this.cdp.evaluate(
      `window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "settings-shown", payload: null })`,
    );
  }

  row(target: string): Promise<TargetRow | null> {
    return this.cdp.evaluate<TargetRow | null>(`(() => {
      const el = ${SECTION}?.querySelector(${JSON.stringify(`[data-target="${target}"]`)});
      if (!el) return null;
      return {
        label: el.querySelector(".name")?.textContent ?? "",
        state: el.querySelector(".state")?.textContent ?? "",
        path: el.querySelector(".path")?.textContent ?? null,
        buttons: [...el.querySelectorAll("button")].map((b) => b.textContent ?? ""),
        error: el.querySelector(".notice.err")?.textContent ?? null,
      };
    })()`);
  }

  /** Every row's target id, in order. */
  targets(): Promise<string[]> {
    return this.cdp.evaluate<string[]>(
      `[...(${SECTION}?.querySelectorAll("[data-target]") ?? [])].map((el) => el.getAttribute("data-target"))`,
    );
  }

  waitForRow(target: string, accept: (r: TargetRow) => boolean, timeoutMs = 20_000): Promise<TargetRow> {
    return waitFor(`the ${target} row to be accepted`, async () => {
      const r = await this.row(target);
      return r && accept(r) ? r : null;
    }, timeoutMs, 150);
  }

  async clickInRow(target: string, label: string) {
    const clicked = await this.cdp.evaluate<boolean>(`(() => {
      const el = ${SECTION}?.querySelector(${JSON.stringify(`[data-target="${target}"]`)});
      const b = [...(el?.querySelectorAll("button") ?? [])].find((b) => b.textContent === ${JSON.stringify(label)});
      if (!b || b.disabled) return false;
      b.click();
      return true;
    })()`);
    if (!clicked) throw new Error(`no enabled "${label}" button in the ${target} row`);
  }

  preview(): Promise<PreviewView> {
    return this.cdp.evaluate<PreviewView>(`(() => {
      const s = ${SECTION};
      return {
        hint: s?.querySelector(".hint")?.textContent ?? "",
        diff: s?.querySelector(".diff")?.textContent ?? null,
        paths: [...(s?.querySelectorAll(".path") ?? [])].map((p) => p.textContent ?? ""),
        buttons: [...(s?.querySelectorAll("button") ?? [])].map((b) => b.textContent ?? ""),
        ok: s?.querySelector(".notice.ok")?.textContent ?? null,
        error: s?.querySelector(".notice.err")?.textContent ?? null,
      };
    })()`);
  }

  waitForPreview(what: string, accept: (p: PreviewView) => boolean, timeoutMs = 20_000): Promise<PreviewView> {
    return waitFor(what, async () => {
      const p = await this.preview();
      return accept(p) ? p : null;
    }, timeoutMs, 150);
  }

  /**
   * A PNG of the (hidden) settings page, for a human to look at. WebView2 may
   * not paint a hidden window, so this gives up after a few seconds and
   * returns null rather than holding the test.
   */
  async screenshot(name: string): Promise<string | null> {
    const shot = await Promise.race([this.cdp.screenshot().catch(() => null), sleep(5_000).then(() => null)]);
    if (!shot) return null;
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    const file = path.join(RESULTS_DIR, `${name}.png`);
    fs.writeFileSync(file, shot);
    return file;
  }

  /** Clicks a button anywhere in the Claude Code section (the preview's Confirm / Cancel). */
  async click(label: string) {
    const clicked = await this.cdp.evaluate<boolean>(`(() => {
      const b = [...(${SECTION}?.querySelectorAll("button") ?? [])].find((b) => b.textContent === ${JSON.stringify(label)});
      if (!b || b.disabled) return false;
      b.click();
      return true;
    })()`);
    if (!clicked) throw new Error(`no enabled "${label}" button in the Claude Code section`);
  }
}
