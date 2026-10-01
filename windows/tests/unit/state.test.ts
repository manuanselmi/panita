// App state (src/core/state.ts): the integration pills, the 4-integration cap,
// focus and the default view. State is a module singleton, so every test loads
// a fresh copy of the module.

import { beforeEach, describe, expect, it, vi } from "vitest";

async function freshState() {
  vi.resetModules();
  const mod = await import("../../src/core/state");
  return mod;
}

const ids = (tasks: { id: string }[]) => tasks.map((t) => t.id);

let State: Awaited<ReturnType<typeof freshState>>["State"];
let DEFAULT_SETTINGS: Awaited<ReturnType<typeof freshState>>["DEFAULT_SETTINGS"];

beforeEach(async () => {
  ({ State, DEFAULT_SETTINGS } = await freshState());
});

describe("default view", () => {
  it("is `empty` with no pill at all and `overview` otherwise", () => {
    expect(State.tasks).toEqual([]);
    expect(State.defaultView()).toBe("empty");
    State.loadIntegrationTasks();
    expect(State.defaultView()).toBe("overview");
  });
});

describe("loadIntegrationTasks", () => {
  it("always loads VS Code, plus the active integrations, in the declared order", () => {
    State.settings.activeIntegrations = ["integration_github", "integration_resend"];
    State.loadIntegrationTasks();
    expect(ids(State.tasks)).toEqual(["integration_claude", "integration_resend", "integration_github"]);
    expect(State.focusId).toBe("integration_claude");
  });

  it("matches the shipped defaults", () => {
    expect(DEFAULT_SETTINGS.activeIntegrations).toHaveLength(4);
    State.loadIntegrationTasks();
    expect(ids(State.tasks)).toEqual([
      "integration_claude",
      "integration_resend",
      "integration_n8n",
      "integration_vercel",
      "integration_github",
    ]);
  });

  it("gives every pill its own steps, so a removed and re-added pill starts clean", async () => {
    const { INTEGRATION_AGENTS } = await import("../../src/core/state");
    State.loadIntegrationTasks();
    State.appendStep("integration_resend", "deployed");
    State.toggleIntegration("integration_resend");
    State.toggleIntegration("integration_resend");
    expect(State.tasks.find((t) => t.id === "integration_resend")?.steps).toEqual([]);
    expect(INTEGRATION_AGENTS.every((t) => t.steps.length === 0)).toBe(true);
  });

  it("keeps an existing focus", () => {
    State.focusId = "integration_vercel";
    State.loadIntegrationTasks();
    expect(State.focusId).toBe("integration_vercel");
  });
});

describe("toggleIntegration", () => {
  beforeEach(() => State.loadIntegrationTasks());

  it("removes an active integration and adds an inactive one", () => {
    State.toggleIntegration("integration_n8n");
    expect(State.settings.activeIntegrations).not.toContain("integration_n8n");
    expect(ids(State.tasks)).not.toContain("integration_n8n");

    State.toggleIntegration("integration_stripe");
    expect(State.settings.activeIntegrations).toContain("integration_stripe");
    expect(ids(State.tasks).at(-1)).toBe("integration_stripe");
  });

  it("caps the opt-in integrations at four", () => {
    expect(State.settings.activeIntegrations).toHaveLength(4);
    State.toggleIntegration("integration_notion");
    expect(State.settings.activeIntegrations).toHaveLength(4);
    expect(ids(State.tasks)).not.toContain("integration_notion");

    // Making room lets it in.
    State.toggleIntegration("integration_resend");
    State.toggleIntegration("integration_notion");
    expect(State.settings.activeIntegrations).toEqual([
      "integration_n8n",
      "integration_vercel",
      "integration_github",
      "integration_notion",
    ]);
  });

  it("never toggles VS Code", () => {
    State.toggleIntegration("integration_claude");
    expect(ids(State.tasks)).toContain("integration_claude");
    expect(State.settings.activeIntegrations).not.toContain("integration_claude");
  });

  it("moves the focus back to VS Code when the focused pill goes away", () => {
    State.setFocus("integration_github");
    State.toggleIntegration("integration_github");
    expect(State.focusId).toBe("integration_claude");
  });

  it("does not mutate the settings array in place", () => {
    const before = State.settings.activeIntegrations;
    State.toggleIntegration("integration_n8n");
    expect(before).toHaveLength(4);
    expect(State.settings.activeIntegrations).not.toBe(before);
  });
});

describe("focus and tasks", () => {
  beforeEach(() => State.loadIntegrationTasks());

  it("setFocus clears that pill's badge and ignores unknown ids", () => {
    State.setPillBadge("integration_vercel", "finished");
    State.setFocus("integration_vercel");
    expect(State.focusTask?.id).toBe("integration_vercel");
    expect(State.focusTask?.pillBadge).toBeNull();
    State.setFocus("integration_nope");
    expect(State.focusId).toBe("integration_vercel");
  });

  it("otherTasks is everything but the focused pill", () => {
    State.setFocus("integration_n8n");
    expect(ids(State.otherTasks)).not.toContain("integration_n8n");
    expect(State.otherTasks).toHaveLength(State.tasks.length - 1);
  });

  it("falls back to the first task when the focus id is stale", () => {
    State.focusId = "integration_gone";
    expect(State.focusTask?.id).toBe("integration_claude");
  });

  it("effectiveState prefers the override, then the focused task", () => {
    State.updateTask("integration_claude", "working");
    expect(State.effectiveState).toBe("working");
    State.stateOverride = "dizzy";
    expect(State.effectiveState).toBe("dizzy");
  });

  it("keeps the last 20 steps, points at the newest, and counts them all", () => {
    for (let i = 1; i <= 25; i++) State.appendStep("integration_claude", `step ${i}`);
    const claude = State.tasks[0];
    expect(claude.steps).toHaveLength(20);
    expect(claude.steps[0]).toBe("step 6");
    expect(claude.stepIndex).toBe(19);
    // What the ticker counts by: the list stops growing, this does not.
    expect(claude.stepTotal).toBe(25);
  });

  it("notifies subscribers on every change, until they unsubscribe", () => {
    const listener = vi.fn();
    const off = State.subscribe(listener);
    State.updateTask("integration_claude", "thinking");
    State.appendStep("integration_claude", "x");
    expect(listener).toHaveBeenCalledTimes(2);
    off();
    State.updateTask("integration_claude", "idle");
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
