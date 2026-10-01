// Settings window — the place where anything that writes to disk is confirmed.
// Stage 2 covers the Claude Code hooks and the general preferences; API keys and
// integrations land here too in a later stage.

import "./settings.css";
import { Bridge, onEvent, type ExtensionStatus, type HookStatus, type HookTarget } from "../core/bridge";
import { DEFAULT_SETTINGS, type Settings } from "../core/state";
import { h, clear } from "../views/dom";

let settings: Settings = { ...DEFAULT_SETTINGS };
let version = "";

const root = document.getElementById("settings-root")!;

async function save() {
  await Bridge.saveSettings(settings);
}

// ── Reusable bits ─────────────────────────────────────────────────────────────

function toggle(on: boolean, onChange: (v: boolean) => void): HTMLElement {
  const el = h("button", { class: on ? "switch on" : "switch", "aria-pressed": on });
  el.addEventListener("click", () => {
    const next = !el.classList.contains("on");
    el.classList.toggle("on", next);
    onChange(next);
  });
  return el;
}

function statusDot(ok: boolean): HTMLElement {
  return h("i", { class: "dot", style: `background:${ok ? "#22c55e" : "#f4505e"}` });
}

function renderDiff(text: string): HTMLElement {
  const box = h("div", { class: "diff" });
  for (const line of text.split("\n")) {
    const cls = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx";
    box.append(h("div", { class: cls, text: line }));
  }
  return box;
}

// ── Claude Code section ───────────────────────────────────────────────────────
//
// One row per place Claude Code runs: Windows, then each WSL distro. Each has
// its own settings.json, status and Install / Uninstall, and each goes through
// the same preview → backup → write-on-click flow.

const WINDOWS_TARGET: HookTarget = { id: "windows", label: "Windows", kind: "windows", distro: null };

/**
 * What a row knows. `null`: not looked at yet — WSL distros are only checked
 * once the window is actually shown (`settings-shown`), because the page itself
 * is loaded, hidden, when Coucou starts.
 */
type TargetState = HookStatus | "checking" | null;

const GREY = "#6b7079";
const AMBER = "#f5a524";
const GREEN = "#22c55e";
const RED = "#f4505e";

/** The companion VS Code extension's row: checked once the window is shown. */
type ExtensionState = ExtensionStatus | "checking" | "installing" | null;

function claudeSection(targets: HookTarget[], windows: HookStatus | null, relayPath: string) {
  const states = new Map<string, TargetState>();
  for (const t of targets) states.set(t.id, t.kind === "windows" ? windows : null);
  let relayReady = windows?.hookReady ?? false;
  /** The target whose diff is on screen; rows are not redrawn under it. */
  let previewing: string | null = null;
  let extension: ExtensionState = null;
  let extensionNotice: { ok: boolean; text: string } | null = null;

  const head = h("h2", {});
  const body = h("div", { style: "display:flex;flex-direction:column;gap:12px" });
  const section = h("section", { "data-section": "claude-code" }, head, body);

  const known = (s: TargetState | undefined): s is HookStatus => typeof s === "object" && s !== null;
  const anyInstalled = () => [...states.values()].some((s) => known(s) && s.checked && s.installed);

  function redraw() {
    clear(head);
    head.append(statusDot(anyInstalled()), h("span", { text: "Claude Code" }));
    if (previewing) return;
    clear(body);
    draw();
  }

  async function check(target: HookTarget, start: boolean) {
    states.set(target.id, "checking");
    redraw();
    const status = await Bridge.hooksStatus(target.id, start);
    states.set(target.id, status ?? {
      target: target.id, label: target.label, installed: false, outdated: false, settingsPath: "", hookPath: "",
      hookReady: false, checked: false, error: "Coucou didn't answer.",
    });
    if (target.kind === "windows" && status) relayReady = status.hookReady;
    redraw();
  }

  function button(text: string, cls: string | null, onclick: () => void, disabled = false, title?: string) {
    const b = h("button", { class: cls ?? undefined, text, onclick });
    if (disabled) {
      b.disabled = true;
      if (title) b.title = title;
    }
    return b;
  }

  function targetRow(t: HookTarget): HTMLElement {
    const s = states.get(t.id);
    let color = GREY;
    let state = "Not checked yet";
    const actions: HTMLElement[] = [];
    // Writing hook commands that point at a relay which isn't there would give
    // every Claude Code session a broken hook and nothing to show for it.
    const noRelay = !relayReady;
    const install = (label: string) =>
      button(label, "primary", () => void showPreview(t, true), noRelay, "The relay isn't installed yet.");

    if (s === "checking") {
      state = t.kind === "wsl" ? "Checking… (asking the distro)" : "Checking…";
    } else if (!known(s)) {
      actions.push(button("Check", null, () => void check(t, true)));
    } else if (s.error) {
      color = AMBER;
      state = "Can't be read";
      actions.push(button("Retry", null, () => void check(t, true)));
    } else if (!s.checked) {
      state = "Not running — not checked";
      // Checking means starting the distro; only on request.
      actions.push(button("Check…", null, () => void check(t, true)));
    } else if (s.installed && s.outdated) {
      // Written by an older Coucou: updating goes through the same diff,
      // backup and click as installing — never on its own.
      color = AMBER;
      state = "Installed — update available";
      actions.push(install("Update…"), button("Uninstall…", "danger", () => void showPreview(t, false)));
    } else if (s.installed) {
      color = GREEN;
      state = "Installed";
      actions.push(install("Reinstall…"), button("Uninstall…", "danger", () => void showPreview(t, false)));
    } else {
      color = RED;
      state = "Not installed";
      actions.push(install("Install…"));
    }

    const row = h("div", { class: "target", "data-target": t.id },
      h("div", { class: "row" },
        h("i", { class: "dot", style: `background:${color}` }),
        h("span", { class: "name", text: t.label }),
        h("span", { class: "hint state", text: state }),
        h("span", { class: "spacer" }),
        ...actions,
      ),
    );
    if (known(s) && s.settingsPath) {
      row.append(h("span", { class: "path", text: s.settingsPath, title: `Runs ${s.hookPath}` }));
    }
    if (known(s) && s.error) row.append(h("div", { class: "notice err", text: s.error }));
    return row;
  }

  function draw() {
    body.append(
      h("div", {
        class: "hint",
        text: anyInstalled()
          ? "Coucou is hooked into your Claude Code sessions. Tool calls, questions and permission requests show up in the island, and you can answer them there."
          : "Install the hooks to see your Claude Code sessions in the island and approve permissions without leaving what you are doing.",
      }),
      h("div", { class: "row" },
        h("label", { text: "Relay" }),
        h("span", { class: "path", text: relayPath }),
        statusDot(relayReady),
      ),
    );
    if (!relayReady) {
      body.append(h("div", {
        class: "notice warn",
        text: "coucou-hook.exe is not in place yet. Restart Coucou; if it still fails, build it with `cargo build -p coucou-hook`.",
      }));
    }
    body.append(h("div", { class: "targets" }, ...targets.map(targetRow)));
    if (targets.some((t) => t.kind === "wsl")) {
      body.append(h("div", {
        class: "hint",
        text: "WSL sessions run the same relay through WSL interop; each distro has its own ~/.claude/settings.json.",
      }));
    }
    if ([...states.values()].some((s) => known(s) && s.installed && s.outdated)) {
      body.append(h("div", {
        class: "hint",
        text: "An older Coucou wrote some of these hooks. Update… shows exactly what changes — in WSL the command now also passes the session's process id, so ↗ can find its terminal.",
      }));
    }
    body.append(extensionRow());
  }

  // ── VS Code terminal focus ──────────────────────────────────────────────────
  // The companion extension (windows/vscode-extension): with it, ↗ brings the
  // session's own terminal tab forward, not just its window. Checking runs
  // VS Code's `code --list-extensions`, so it waits for the window to be shown;
  // installing runs `code --install-extension` and only on a click.

  async function checkExtension() {
    extension = "checking";
    redraw();
    extension = (await Bridge.vscodeExtensionStatus()) ?? {
      codePath: null, installed: null, bundled: "", vsixPath: null, upToDate: false, error: "Coucou didn't answer.",
    };
    redraw();
  }

  async function installExtension() {
    extension = "installing";
    extensionNotice = null;
    redraw();
    try {
      await Bridge.vscodeExtensionInstall();
      extensionNotice = {
        ok: true,
        text: "Installed. VS Code windows that were already open pick it up once reloaded (Developer: Reload Window).",
      };
    } catch (err) {
      extensionNotice = { ok: false, text: `Could not install: ${String(err).replace(/^Error:\s*/, "")}` };
    }
    await checkExtension();
  }

  function extensionRow(): HTMLElement {
    const e = extension;
    let color = GREY;
    let state = "Not checked yet";
    const actions: HTMLElement[] = [];
    const install = (label: string, missing: boolean) =>
      button(label, "primary", () => void installExtension(), missing, "This build of Coucou has no extension package.");

    if (e === "checking") {
      state = "Checking…";
    } else if (e === "installing") {
      state = "Installing…";
    } else if (e === null) {
      actions.push(button("Check", null, () => void checkExtension()));
    } else if (!e.codePath) {
      state = "VS Code's code command isn't on PATH";
      actions.push(button("Retry", null, () => void checkExtension()));
    } else if (e.error) {
      color = AMBER;
      state = "Can't be checked";
      actions.push(button("Retry", null, () => void checkExtension()));
    } else if (!e.installed) {
      color = RED;
      state = "Not installed";
      actions.push(install("Install", !e.vsixPath));
    } else if (!e.upToDate) {
      color = AMBER;
      state = `Installed ${e.installed} — ${e.bundled} available`;
      actions.push(install("Update", !e.vsixPath));
    } else {
      color = GREEN;
      state = `Installed ${e.installed}`;
    }

    const row = h("div", { class: "target", "data-extension": "terminal-focus" },
      h("div", { class: "row" },
        h("i", { class: "dot", style: `background:${color}` }),
        h("span", { class: "name", text: "VS Code terminal focus" }),
        h("span", { class: "hint state", text: state }),
        h("span", { class: "spacer" }),
        ...actions,
      ),
      h("div", {
        class: "hint",
        text: "A small VS Code extension that lets ↗ on a session bring its own terminal tab forward, not just its window — Windows and WSL alike. It only answers Coucou, on this machine.",
      }),
    );
    if (typeof e === "object" && e?.codePath) {
      row.append(h("span", { class: "path", text: e.codePath, title: e.vsixPath ? `Installs ${e.vsixPath}` : "" }));
    }
    if (typeof e === "object" && e?.error) row.append(h("div", { class: "notice err", text: e.error }));
    if (extensionNotice) {
      row.append(h("div", { class: `notice ${extensionNotice.ok ? "ok" : "err"}`, text: extensionNotice.text }));
    }
    return row;
  }

  function back() {
    previewing = null;
    redraw();
  }

  async function showPreview(t: HookTarget, install: boolean) {
    previewing = t.id;
    clear(body);
    // A stopped distro is started to read its settings.json: say so.
    body.append(h("div", { class: "hint", text: `Reading ${t.label}…` }));
    let preview;
    try {
      preview = await Bridge.hooksPreview(install, t.id);
    } catch (err) {
      // An unreadable or invalid settings.json stops here rather than being
      // treated as empty and written over.
      clear(body);
      body.append(
        h("div", { class: "notice err", text: String(err).replace(/^Error:\s*/, "") }),
        h("div", { class: "row" }, h("button", { text: "Back", onclick: back })),
      );
      return;
    }
    const where = t.kind === "wsl" ? `the settings.json of ${t.label}` : "your settings.json";
    clear(body);
    body.append(
      h("div", {
        class: "hint",
        text: install
          ? `This is exactly what will change in ${where}. Your own hooks are left untouched.`
          : `This removes Coucou's entries from ${where} only. Your own hooks are left untouched.`,
      }),
      h("div", { class: "row" }, h("span", { class: "path", text: preview.settingsPath })),
      renderDiff(preview.diff),
      h("div", { class: "row" },
        h("span", { class: "path", text: `Backup → ${preview.backup}` }),
      ),
    );
    const confirm = h("button", {
      class: install ? "primary" : "danger",
      text: install ? "Back up and write" : "Back up and remove",
    });
    confirm.addEventListener("click", async () => {
      confirm.disabled = true;
      try {
        const backup = await Bridge.hooksApply(install, preview.fingerprint, t.id);
        clear(body);
        const session = t.kind === "wsl" ? `Claude Code session in ${t.distro}` : "Claude Code session";
        body.append(h("div", {
          class: "notice ok",
          text: `Done. Previous settings saved as ${backup}. Open a new ${session} to pick the hooks up.`,
        }));
        window.setTimeout(() => {
          previewing = null;
          void check(t, true);
        }, 2600);
      } catch (err) {
        confirm.disabled = false;
        body.append(h("div", { class: "notice err", text: `Could not write: ${String(err)}` }));
      }
    });
    body.append(h("div", { class: "row" }, confirm, h("button", { text: "Cancel", onclick: back })));
  }

  redraw();
  return {
    el: section,
    /** The window was shown: look at every target again, WSL included, and at VS Code. */
    refresh: () => {
      for (const t of targets) void check(t, false);
      if (extension !== "installing") void checkExtension();
    },
  };
}

// ── Claude API section ────────────────────────────────────────────────────────

const MODELS: [string, string][] = [
  ["claude-opus-5", "Claude Opus 5"],
  ["claude-sonnet-5", "Claude Sonnet 5"],
  ["claude-haiku-4-5", "Claude Haiku 4.5"],
];

function apiSection(hasKey: boolean): HTMLElement {
  const dot = statusDot(hasKey);
  const state = h("span", { class: "hint", text: hasKey ? "Key saved in the Windows Credential Manager." : "No key yet — the chat needs one." });

  const field = h("input", {
    type: "password",
    placeholder: hasKey ? "••••••••••••  (stored)" : "sk-ant-...",
    style: "flex:1 1 auto;min-width:0",
    autocomplete: "off",
    spellcheck: "false",
  }) as HTMLInputElement;

  const saveBtn = h("button", { class: "primary", text: "Save key" });
  const clearBtn = h("button", { class: "danger", text: "Remove" });
  const feedback = h("div", {});

  async function refresh() {
    const present = (await Bridge.secretPresent("anthropic-api-key")) ?? false;
    dot.style.background = present ? "#22c55e" : "#f4505e";
    state.textContent = present
      ? "Key saved in the Windows Credential Manager."
      : "No key yet — the chat needs one.";
    field.placeholder = present ? "••••••••••••  (stored)" : "sk-ant-...";
    clearBtn.style.display = present ? "" : "none";
  }

  saveBtn.addEventListener("click", async () => {
    const value = field.value.trim();
    if (!value) return;
    clear(feedback);
    try {
      await Bridge.secretSet("anthropic-api-key", value);
      field.value = "";
      feedback.append(h("div", { class: "notice ok", text: "Saved. It never touches disk." }));
      await refresh();
    } catch (err) {
      feedback.append(h("div", { class: "notice err", text: `Could not save: ${String(err)}` }));
    }
  });

  clearBtn.addEventListener("click", async () => {
    clear(feedback);
    try {
      await Bridge.secretClear("anthropic-api-key");
      feedback.append(h("div", { class: "notice ok", text: "Key removed." }));
      await refresh();
    } catch (err) {
      feedback.append(h("div", { class: "notice err", text: `Could not remove: ${String(err)}` }));
    }
  });

  const model = h("select", {}) as HTMLSelectElement;
  for (const [id, label] of MODELS) model.append(h("option", { value: id, text: label }));
  if (!MODELS.some(([id]) => id === settings.model)) {
    model.append(h("option", { value: settings.model, text: settings.model }));
  }
  model.value = settings.model;
  model.addEventListener("change", () => {
    settings.model = model.value;
    void save();
  });

  clearBtn.style.display = hasKey ? "" : "none";

  return h(
    "section",
    {},
    h("h2", {}, dot, h("span", { text: "Claude" })),
    state,
    h("div", { class: "row" }, h("label", { text: "API key" }), field, saveBtn, clearBtn),
    h("div", { class: "row" }, h("label", { text: "Model" }), model),
    feedback,
  );
}

// ── Integrations section ──────────────────────────────────────────────────────

interface IntegrationDef {
  id: string;
  name: string;
  color: string;
  /** Credential Manager keys, in the order they are shown. */
  fields: { key: string; label: string; placeholder: string; secret: boolean }[];
}

const INTEGRATIONS: IntegrationDef[] = [
  { id: "integration_stripe", name: "Stripe", color: "#0570DE",
    fields: [{ key: "stripe-api-key", label: "Secret key", placeholder: "sk_live_…", secret: true }] },
  { id: "integration_github", name: "GitHub", color: "#F4505E",
    fields: [{ key: "github-token", label: "Token", placeholder: "ghp_…", secret: true }] },
  { id: "integration_vercel", name: "Vercel", color: "#7C5CFF",
    fields: [{ key: "vercel-token", label: "Token", placeholder: "…", secret: true }] },
  { id: "integration_n8n", name: "n8n", color: "#F29B38",
    fields: [
      { key: "n8n-url", label: "Instance URL", placeholder: "https://n8n.example.com", secret: false },
      { key: "n8n-api-key", label: "API key", placeholder: "…", secret: true },
    ] },
  { id: "integration_resend", name: "Resend", color: "#22C55E",
    fields: [{ key: "resend-api-key", label: "API key", placeholder: "re_…", secret: true }] },
  { id: "integration_notion", name: "Notion", color: "#8C8C8C",
    fields: [{ key: "notion-api-key", label: "Integration token", placeholder: "ntn_…", secret: true }] },
  { id: "integration_calcom", name: "Cal.com", color: "#C9956A",
    fields: [{ key: "calcom-api-key", label: "API key", placeholder: "cal_…", secret: true }] },
];

const MAX_ACTIVE = 4;

function integrationsSection(present: Record<string, boolean>): HTMLElement {
  const note = h("div", { class: "hint" });
  const list = h("div", { style: "display:flex;flex-direction:column;gap:14px" });

  function updateNote() {
    const used = settings.activeIntegrations.length;
    note.textContent = `Pick up to ${MAX_ACTIVE} pills to show next to Mochi — ${used}/${MAX_ACTIVE} in use. Keys are stored in the Windows Credential Manager, never on disk.`;
  }

  for (const def of INTEGRATIONS) {
    const active = settings.activeIntegrations.includes(def.id);
    const sw = h("button", { class: active ? "switch on" : "switch" });
    sw.addEventListener("click", () => {
      const on = settings.activeIntegrations.includes(def.id);
      if (on) {
        settings.activeIntegrations = settings.activeIntegrations.filter((x) => x !== def.id);
      } else {
        if (settings.activeIntegrations.length >= MAX_ACTIVE) return;
        settings.activeIntegrations = [...settings.activeIntegrations, def.id];
      }
      sw.classList.toggle("on", !on);
      updateNote();
      void save();
    });

    const rows = h("div", { style: "display:flex;flex-direction:column;gap:6px;flex:1 1 auto;min-width:0" });
    for (const field of def.fields) {
      const input = h("input", {
        type: field.secret ? "password" : "text",
        placeholder: present[field.key] ? "••••••••  (stored)" : field.placeholder,
        autocomplete: "off",
        spellcheck: "false",
        style: "flex:1 1 auto;min-width:0",
      }) as HTMLInputElement;
      const saveBtn = h("button", { text: "Save" });
      const dotEl = statusDot(present[field.key] ?? false);
      saveBtn.addEventListener("click", async () => {
        const value = input.value.trim();
        try {
          await Bridge.secretSet(field.key, value);
          present[field.key] = value.length > 0;
          input.value = "";
          input.placeholder = value ? "••••••••  (stored)" : field.placeholder;
          dotEl.style.background = value ? "#22c55e" : "#f4505e";
        } catch {
          dotEl.style.background = "#f5a524";
        }
      });
      rows.append(
        h("div", { class: "row" },
          h("label", { style: "min-width:104px", text: field.label }),
          input, saveBtn, dotEl,
        ),
      );
    }

    list.append(
      h("div", { style: "display:flex;gap:12px;align-items:flex-start" },
        h("div", { style: "display:flex;align-items:center;gap:8px;min-width:132px;padding-top:4px" },
          sw,
          h("i", { class: "dot", style: `background:${def.color}` }),
          h("span", { style: "font-size:12.5px", text: def.name }),
        ),
        rows,
      ),
    );
  }

  updateNote();
  return h("section", {}, h("h2", {}, h("span", { text: "Integrations" })), note, list);
}

// ── General section ───────────────────────────────────────────────────────────

function generalSection(): HTMLElement {
  const volume = h("input", {
    type: "range", min: "0", max: "0.2", step: "0.005",
    value: String(settings.soundVolume),
  }) as HTMLInputElement;
  volume.addEventListener("input", () => {
    settings.soundVolume = Number(volume.value);
    void save();
  });

  const autoClose = h("input", {
    type: "number", min: "5", max: "120", step: "1",
    value: String(Math.round(settings.autoCloseInterval)),
    style: "width:72px",
  }) as HTMLInputElement;
  autoClose.addEventListener("change", () => {
    settings.autoCloseInterval = Math.max(5, Math.min(120, Number(autoClose.value) || 15));
    autoClose.value = String(settings.autoCloseInterval);
    void save();
  });

  const screen = h("select", {}) as HTMLSelectElement;
  screen.append(
    h("option", { value: "primary", text: "Main display" }),
    h("option", { value: "cursor", text: "Display under the cursor" }),
  );
  screen.value = settings.screen;
  screen.addEventListener("change", () => {
    settings.screen = screen.value as Settings["screen"];
    void save();
  });

  return h(
    "section",
    {},
    h("h2", {}, h("span", { text: "General" })),
    h("div", { class: "row" },
      h("label", { text: "Sound" }),
      toggle(settings.soundEnabled, (v) => { settings.soundEnabled = v; void save(); }),
      volume,
    ),
    h("div", { class: "row" },
      h("label", { text: "Auto-close" }),
      autoClose,
      h("span", { class: "hint", text: "seconds after you leave the island" }),
    ),
    h("div", { class: "row" },
      h("label", { text: "Island lives on" }),
      screen,
    ),
    h("div", { class: "row" },
      h("label", { text: "Launch at startup" }),
      toggle(settings.autostart, (v) => { settings.autostart = v; void save(); }),
    ),
  );
}

// ── Boot ──────────────────────────────────────────────────────────────────────

async function main() {
  const boot = await Bridge.boot();
  if (boot) {
    settings = { ...settings, ...boot.settings };
    version = boot.version;
  }
  // Windows now, the WSL distros once the window is shown (see claudeSection).
  const targets = (await Bridge.hooksTargets()) ?? [WINDOWS_TARGET];
  const windows = await Bridge.hooksStatus();
  const claude = claudeSection(targets, windows, windows?.hookPath ?? boot?.hookPath ?? "");

  const hasKey = (await Bridge.secretPresent("anthropic-api-key")) ?? false;

  const keys = [
    "stripe-api-key", "github-token", "vercel-token",
    "n8n-url", "n8n-api-key", "resend-api-key", "notion-api-key", "calcom-api-key",
  ];
  const present: Record<string, boolean> = {};
  for (const k of keys) present[k] = (await Bridge.secretPresent(k)) ?? false;

  clear(root);
  root.append(
    h("h1", {}, h("span", { text: "Coucou" }), h("span", { class: "version", text: version })),
    claude.el,
    apiSection(hasKey),
    integrationsSection(present),
    generalSection(),
    h("div", {
      class: "hint",
      text: "No telemetry. Network requests only go to the services you configure yourself.",
    }),
  );

  void onEvent<Settings>("settings-changed", (s) => {
    settings = { ...settings, ...s };
  });
  void onEvent<null>("settings-shown", () => claude.refresh());
}

void main();
