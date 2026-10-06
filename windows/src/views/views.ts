// Island views — DOM ports of IslandViewContent.swift. Paddings, font sizes,
// colours and wording are copied from the Swift views so both platforms read
// identically.

import { h, svg, clear, dot } from "./dom";
import { ICONS } from "./icons";
import { Ticker } from "./ticker";
import { State, isSession, type AgentTask, type PillBadge } from "../core/state";
import { CARD_TEXT_W, EXPLAIN_LINE_H, panitaGrid, washRGBA, type IslandViewName, type Wash } from "../core/layout";
import { displayName, labelParts } from "../core/sessions";
import { explanationText } from "../core/explain";
import { createMiniBot, pruneMiniBots } from "../mochi/minibots";
import { buildPrompt } from "./chat";
import { buildChoose, buildUpload, buildUploading } from "./upload";
import { buildContextMeter, buildUsageMeter } from "./usage";
import { renderIntegrationCard, type IntegrationCardHooks } from "./integrations";

export interface ViewActions {
  setView(v: IslandViewName): void;
  collapse(): void;
  /** A panita was clicked: it takes the left card. */
  select(id: string): void;
  /** "Open terminal" on the finished card: the session that finished. */
  openTerminal(): void;
  /** ↗ on the left card: the session there, or the integration's page. */
  openTarget(): void;
  openUrl(url: string): void;
  decide(d: "allow" | "deny"): void;
  toggleSound(): void;
  setVolume(v: number): void;
  setAutoClose(seconds: number): void;
  openSettingsWindow(): void;
  blip(): void;
}

export interface ViewHost {
  el: HTMLElement;
  sync(): void;
  /** Called when the view becomes active, for views with a text field. */
  focus?(): void;
  /** Called every frame while the view is on screen. */
  tick?(nowMs: number): void;
  /** True while tick() still has something to animate: keeps the frame loop alive. */
  busy?(): boolean;
}

// ── Shared pieces ─────────────────────────────────────────────────────────────

function card(wash: Wash, ...children: (Node | string)[]): HTMLElement {
  const el = h("div", { class: wash ? "card wash" : "card" }, ...children);
  if (wash) el.style.setProperty("--wash", washRGBA(wash));
  return el;
}

function btn(
  label: string,
  kind: "primary" | "secondary",
  onClick: () => void,
  kbd?: string,
): HTMLElement {
  return h(
    "button",
    { class: `btn ${kind}`, onclick: onClick },
    h("span", { text: label }),
    kbd ? h("span", { class: "kbd", text: kbd }) : null,
  );
}

/** AgentWho — coloured dot + task name + grey label. */
function agentWho(task: AgentTask | null, label: string): HTMLElement {
  const row = h("div", { class: "who-row" });
  if (task) row.append(dot(task.color, 8), nameEl(task, "n"));
  row.append(h("span", { class: "who-label", text: label }));
  return row;
}

/**
 * A task's name as every card shows it: "struxto-especificador 2". Two spans,
 * so that when the name is too long only the name part ends in "…" and the
 * number that tells same-name sessions apart stays readable.
 */
function nameEl(task: AgentTask, cls: string): HTMLElement {
  const { name, suffix } = labelParts(task);
  const el = h("span", { class: `${cls} label`, title: taskTooltip(task) });
  el.append(h("span", { class: "label-name", text: name }));
  if (suffix) el.append(h("span", { class: "label-nr", text: suffix }));
  return el;
}

/** Where a session runs, so two "api" folders can be told apart. */
function whereTitle(task: AgentTask): string | undefined {
  if (!isSession(task)) return undefined;
  if (!task.cwd) return task.wslDistro ? `WSL · ${task.wslDistro}` : undefined;
  return task.wslDistro ? `${task.cwd} (WSL · ${task.wslDistro})` : task.cwd;
}

/**
 * The tooltip on a session's name and panita: its full label, where it runs,
 * and the first prompt it was given — what tells three sessions of one
 * project apart.
 */
function taskTooltip(task: AgentTask): string {
  const lines = [displayName(task)];
  const where = whereTitle(task);
  if (where) lines.push(where);
  if (isSession(task) && task.firstPrompt) lines.push(`“${task.firstPrompt}”`);
  return lines.join("\n");
}

const BADGE_COLORS: Record<PillBadge, string> = { approval: "#F5A524", finished: "#22C55E", error: "#F4505E" };
const BADGE_ICONS: Record<PillBadge, string> = { approval: ICONS.bang, finished: ICONS.check, error: ICONS.xmark };

/** The little status disc on a panita. */
function badgeEl(kind: PillBadge): HTMLElement {
  const color = BADGE_COLORS[kind];
  const inner = h("i", { style: `background:${color}` }, svg(BADGE_ICONS[kind], 6, { stroke: kind === "finished" ? 3 : 0 }));
  const badge = h("div", { class: "pill-badge", "data-badge": kind }, inner);
  badge.style.boxShadow = `0 0 4px ${color}99`;
  return badge;
}

function stack(padLeft: number, padRight: number, ...children: Node[]): HTMLElement {
  const el = h("div", { class: "stack" }, ...children);
  el.style.padding = `4px ${padRight}px 4px ${padLeft}px`;
  return el;
}

// ── Header ────────────────────────────────────────────────────────────────────

export function buildHeader(actions: ViewActions): ViewHost {
  const tabHome = h("button", { class: "tab", title: "Overview", onclick: () => go("overview") }, svg(ICONS.house, 13));
  const tabChat = h("button", { class: "tab", title: "Ask", onclick: () => go("prompt") }, svg(ICONS.bubble, 13));
  const tabDrop = h("button", { class: "tab", title: "Drop", onclick: () => go("upload") }, svg(ICONS.plus, 13));

  const gearBtn = h("button", { title: "Settings", onclick: () => go("settings") }, svg(ICONS.gear, 14));
  const soundBtn = h("button", { title: "Mute", onclick: () => actions.toggleSound() }, svg(ICONS.speakerOn, 14));

  function go(v: IslandViewName) {
    actions.blip();
    actions.setView(v);
  }

  // The subscription's 5-hour usage, centred in the strip (usage.ts).
  const usage = buildUsageMeter("header");

  const el = h(
    "div",
    { id: "header" },
    h("div", { class: "tabs" }, tabHome, tabChat, tabDrop),
    usage.el,
    h("div", { class: "header-actions" }, gearBtn, soundBtn),
  );

  return {
    el,
    sync() {
      usage.sync(Date.now(), State.mode === "expanded");
      const v = State.view;
      tabHome.classList.toggle("on", v === "overview" || v === "empty");
      tabChat.classList.toggle("on", v === "prompt");
      tabDrop.classList.toggle("on", v === "upload");
      gearBtn.classList.toggle("on", v === "settings");
      clear(gearBtn);
      gearBtn.append(svg(v === "settings" ? ICONS.gearFill : ICONS.gear, 14));
      clear(soundBtn);
      soundBtn.append(svg(State.settings.soundEnabled ? ICONS.speakerOn : ICONS.speakerOff, 14));
      el.style.opacity = v === "confused" ? "0" : "1";
    },
  };
}

// ── Overview ──────────────────────────────────────────────────────────────────
//
// Left card: the primary — a Claude Code session with its ticker, or the card
// of an integration the user clicked. Right card: everyone else as panitas
// (buildOthers). Who goes where is State's business (focusTask, panitas); this
// only draws it.

function buildOverview(actions: ViewActions): ViewHost {
  const ticker = new Ticker();
  const who = h("div", { class: "who" });
  const tickerBody = h("div", { class: "card-body" }, who, ticker.el);
  const leftBody = h("div", { class: "left-body" });
  const jump = h(
    "button",
    { class: "icon-btn jump", title: "Open", onclick: () => actions.openTarget() },
    svg(ICONS.arrowUpRight, 8),
  );
  // How full the left session's context window is, at the foot of its card (usage.ts).
  const context = buildContextMeter();
  const left = card(null, leftBody, context.el, jump);
  const others = buildOthers(actions);
  const right = card(null, others.el);

  const el = h("div", { class: "view overview" },
    h("div", { class: "left" }, left),
    h("div", { class: "right" }, right),
  );

  let detailOpen = false;
  let lastFocus: string | null = null;
  let mode: "ticker" | "card" | null = null;
  let cardKey = "";
  let whoKey = "";

  const hooks: IntegrationCardHooks = {
    get detailOpen() {
      return detailOpen;
    },
    openDetail() {
      detailOpen = true;
      cardKey = "";
      State.notify();
    },
    closeDetail() {
      detailOpen = false;
      cardKey = "";
      State.notify();
    },
    openSettings: () => actions.openSettingsWindow(),
  };

  return {
    el,
    tick(nowMs: number) {
      if (mode === "ticker") ticker.tick(nowMs);
    },
    busy: () => mode === "ticker" && ticker.animating,
    sync() {
      const task = State.focusTask;
      if (task?.id !== lastFocus) {
        lastFocus = task?.id ?? null;
        detailOpen = false;
        cardKey = "";
        whoKey = "";
        mode = null;
        // Another session on the left: show its own steps, without scrolling
        // through the previous one's.
        ticker.reset();
      }

      if (isSession(task)) {
        if (mode !== "ticker") {
          clear(leftBody);
          leftBody.append(tickerBody);
          mode = "ticker";
          cardKey = "";
        }
        const count = task.steps.length > 1
          ? `${Math.min(task.stepIndex + 1, task.steps.length)}/${task.steps.length}`
          : "";
        const key = [task.id, task.name, task.ordinal, task.color, count, task.cwd, task.wslDistro, task.firstPrompt].join("~");
        if (key !== whoKey) {
          whoKey = key;
          clear(who);
          who.append(
            dot(task.color, 7),
            nameEl(task, "name"),
            // "Claude Code" shows whole or not at all (style.css, .tool-slot).
            h("span", { class: "tool-slot" }, h("i", { class: "tool-spacer" }), h("span", { class: "tool", text: "Claude Code" })),
          );
          if (count) who.append(h("span", { class: "count", text: count }));
        }
        ticker.sync(task);
      } else if (task) {
        // An integration's own card, exactly like IntegrationCardView.
        const info = State.integrations[task.id];
        const key = [
          task.id, detailOpen, task.state, task.steps.join("|"),
          info?.loaded, info?.error, info?.configured,
          JSON.stringify(info?.data ?? {}),
        ].join("~");
        if (key !== cardKey) {
          cardKey = key;
          mode = "card";
          clear(leftBody);
          leftBody.append(renderIntegrationCard(task, hooks));
        }
      } else if (mode !== null) {
        // Nothing left at all; the island turns this view into `empty`.
        clear(leftBody);
        mode = null;
      }

      jump.style.display = detailOpen || !task ? "none" : "";
      context.sync(isSession(task) ? task : null, State.mode === "expanded");
      others.sync();
    },
  };
}

/**
 * The right card: everyone but the left card, as panitas — the user's word for
 * a session's mini Mochi — each in its own colour with its name underneath,
 * sessions first (most recently active first) and then any integrations. The
 * grid depends on how many there are (panitaGrid in layout.ts): one centred
 * row of larger Mochis up to three, then two rows of smaller ones, at most six
 * slots — past six, the last slot is a "+N". With nobody else, a quiet line.
 * Clicking a panita puts it on the left card.
 */
function buildOthers(actions: ViewActions): { el: HTMLElement; sync(): void } {
  const grid = h("div", { class: "panitas" });
  const quiet = h("div", { class: "quiet" });
  const el = h("div", { class: "others" }, grid, quiet);

  let gridKey = "";
  return {
    el,
    sync() {
      const all = State.panitas;
      const layout = panitaGrid(all.length);
      const shown = all.slice(0, layout.shown);
      grid.style.display = shown.length > 0 ? "" : "none";
      quiet.style.display = shown.length === 0 ? "" : "none";
      quiet.textContent = State.sessions.length === 0 ? "No Claude Code sessions" : "No other sessions";

      const key =
        shown
          .map((t) =>
            [t.id, t.name, isSession(t) ? t.ordinal : "", t.color, t.pillBadge ?? "", isSession(t) ? (t.firstPrompt ?? "") : ""].join(":"),
          )
          .join("|") + `|+${layout.more}`;
      if (key === gridKey) return;
      gridKey = key;
      clear(grid);
      grid.style.setProperty("--cols", String(layout.cols));
      grid.dataset.rows = String(layout.rows.length);
      const slots: HTMLElement[] = shown.map((t) => buildPanita(t, layout.size, actions));
      if (layout.more > 0) {
        const hidden = all.slice(layout.shown).map(displayName);
        slots.push(
          h(
            "div",
            { class: "panita more", title: hidden.join("\n") },
            h("span", { class: "more-disc", text: `+${layout.more}` }),
            // Keeps the disc level with the Mochis beside it.
            h("span", { class: "lbl", text: "más" }),
          ),
        );
      }
      let next = 0;
      for (const count of layout.rows) {
        grid.append(h("div", { class: "panita-row" }, ...slots.slice(next, next + count)));
        next += count;
      }
      pruneMiniBots();
    },
  };
}

function buildPanita(task: AgentTask, size: number, actions: ViewActions): HTMLElement {
  const label = nameEl(task, "lbl");
  // The panita carries the tooltip; the label's own would only repeat it.
  label.removeAttribute("title");
  const panita = h(
    "div",
    {
      class: "panita",
      "data-id": task.id,
      "data-color": task.color,
      title: taskTooltip(task),
      onclick: () => actions.select(task.id),
    },
    createMiniBot(task, size),
    label,
  );
  panita.style.setProperty("--c", task.color);
  if (task.pillBadge) panita.append(badgeEl(task.pillBadge));
  return panita;
}

// ── Empty ─────────────────────────────────────────────────────────────────────

function buildEmpty(actions: ViewActions): ViewHost {
  const body = h(
    "div",
    { class: "stack", style: "padding:0 18px 0 118px;flex-direction:row;align-items:center;gap:16px" },
    h(
      "div",
      { style: "display:flex;flex-direction:column;gap:5px" },
      h("div", { class: "title", text: "Nothing running right now." }),
      h("div", { class: "sub", text: "Drop a file or window, or ask me anything." }),
    ),
    h("div", { class: "grow" }),
    btn("Ask Claude", "primary", () => actions.setView("prompt")),
  );
  return { el: h("div", { class: "view" }, card(null, body)), sync() {} };
}

// ── Growing cards ─────────────────────────────────────────────────────────────
//
// The approval and question cards wrap their text over a few lines instead of
// cutting it at one, and the island grows to fit (State.cardGrowth, islandSize).
// How many lines a text takes is measured on a hidden copy at the open island's
// width (CARD_TEXT_W): the row on screen is narrower while the island springs
// open, and would ask for too many.

/** A hidden copy of a text row, at the open island's width, to count its lines on. */
function sizer(): HTMLElement {
  const el = h("div", { class: "sizer", "aria-hidden": "true" });
  el.style.width = `${CARD_TEXT_W}px`;
  return el;
}

/** Lines `row` takes at CARD_TEXT_W, 1 to `max`; 0 when it is not shown. */
function linesOf(row: HTMLElement, copy: HTMLElement, lineH: number, max: number): number {
  if (row.style.display === "none" || !row.textContent) return 0;
  copy.className = `${row.className} sizer`;
  copy.replaceChildren(...[...row.childNodes].map((n) => n.cloneNode(true)));
  return Math.min(max, Math.max(1, Math.round(copy.scrollHeight / lineH)));
}

/** Sets how much `view`'s card grows, and has the island follow when that changed. */
function grow(view: IslandViewName, px: number, onHeightChange: () => void) {
  if ((State.cardGrowth[view] ?? 0) === px) return;
  State.cardGrowth[view] = px;
  onHeightChange();
}

/** The approval card's explanation shows up to this many lines, then ends in "…". */
const EXPLAIN_MAX_LINES = 3;

// ── Approval ──────────────────────────────────────────────────────────────────

function buildApproval(actions: ViewActions, onHeightChange: () => void): ViewHost {
  const who = h("div");
  const code = h("div", { class: "code" });
  const explain = h("div", { class: "explain" });
  const explainCopy = sizer();
  const row = h("div", { class: "actions" });
  // ↗ to the session asking — its terminal, where the same request is also
  // waiting — as on the overview's left card.
  const jump = h(
    "button",
    { class: "icon-btn jump", title: "Open", onclick: () => actions.openTerminal() },
    svg(ICONS.arrowUpRight, 8),
  );
  const box = card("amber", stack(116, 16, who, code, explain, row, explainCopy), jump);
  const el = h("div", { class: "view approval" }, box);
  let rowKey = "";
  let explainKey = "";
  return {
    el,
    sync() {
      clear(who);
      // The session asking, in its colour — not whichever leads the overview.
      who.append(agentWho(State.subjectTask, "needs permission"));
      // The whole point of approving here rather than in the terminal: this line
      // is the command, the file path or the URL being authorised, not just the
      // name of the tool asking.
      code.textContent = State.pendingApproval?.command || State.pendingApproval?.tool || "…";
      // Under it, what that does, in Spanish (src/core/explain.ts) — no line at
      // all for a command nothing in the dictionary knows. Up to three lines,
      // the card growing to fit; past that it ends in "…". A ⚠ up front when
      // any part is destructive, so it shows even if that part is cut off;
      // those parts in red. The whole line is in the tooltip.
      const e = State.pendingApproval?.explanation ?? null;
      const key = e ? JSON.stringify(e.parts) : "";
      if (key !== explainKey) {
        explainKey = key;
        clear(explain);
        explain.style.display = e ? "" : "none";
        explain.classList.toggle("danger", !!e?.danger);
        explain.title = e ? explanationText(e) : "";
        if (e) {
          if (e.danger) explain.append(h("span", { class: "warn", text: "⚠" }));
          e.parts.forEach((p, i) => {
            if (i > 0) explain.append(h("span", { class: "sep", text: " → " }));
            explain.append(h("span", { class: p.danger ? "part danger" : "part", text: p.text }));
          });
        }
        const lines = linesOf(explain, explainCopy, EXPLAIN_LINE_H, EXPLAIN_MAX_LINES);
        grow("approval", Math.max(0, lines - 1) * EXPLAIN_LINE_H, onHeightChange);
      }
      // Two buttons, built once. Rebuilding them between a mouse-down and a
      // mouse-up would swallow the click, and there is nothing left to vary:
      // "Always" is gone until the remembered-rules list exists to back it.
      if (rowKey === "built") return;
      rowKey = "built";
      clear(row);
      row.append(
        btn("Deny", "secondary", () => actions.decide("deny"), "N"),
        btn("Allow", "primary", () => actions.decide("allow"), "Y"),
      );
    },
  };
}

// ── Question ──────────────────────────────────────────────────────────────────
//
// A session asking with AskUserQuestion. Claude Code shows the question in the
// terminal at the same time and takes no answer from the island, so the card
// only says what is being asked and takes the user there (hooks.ts).

/** The question card's question shows up to this many lines, its options as many. */
const QUESTION_MAX_LINES = 2;
const OPTIONS_MAX_LINES = 2;
/** Line height, px, of the question (style.css `.question .title`). */
const QUESTION_LINE_H = 19;

function buildQuestion(actions: ViewActions, onHeightChange: () => void): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title" });
  const options = h("div", { class: "explain options" });
  const titleCopy = sizer();
  const optionsCopy = sizer();
  const row = h("div", { class: "actions" },
    btn("Open terminal", "primary", () => actions.openTerminal()),
    btn("OK", "secondary", () => actions.collapse()),
  );
  const el = h("div", { class: "view question" },
    card("cyan", stack(116, 16, who, title, options, row, titleCopy, optionsCopy)));
  let key = "";
  return {
    el,
    sync() {
      // The session asking, held by the card even if another one leads by now.
      const task = State.subjectTask;
      const q = isSession(task) ? task.question ?? null : null;
      const next = JSON.stringify([task?.id, task?.name, task?.color, q]);
      if (next === key) return;
      key = next;
      clear(who);
      who.append(agentWho(task, "has a question"));
      title.textContent = q?.text ?? task?.steps.at(-1) ?? "Claude needs an answer.";
      title.title = q?.text ?? "";
      clear(options);
      const parts = [...(q?.options ?? [])];
      if (q && q.more > 0) parts.push(`+${q.more} more ${q.more === 1 ? "question" : "questions"}`);
      parts.forEach((text, i) => {
        if (i > 0) options.append(h("span", { class: "sep", text: " · " }));
        options.append(h("span", { class: "part", text }));
      });
      options.style.display = parts.length > 0 ? "" : "none";
      options.title = parts.join(" · ");
      const titleLines = linesOf(title, titleCopy, QUESTION_LINE_H, QUESTION_MAX_LINES);
      const optionLines = linesOf(options, optionsCopy, EXPLAIN_LINE_H, OPTIONS_MAX_LINES);
      grow(
        "question",
        Math.max(0, titleLines - 1) * QUESTION_LINE_H + Math.max(0, optionLines - 1) * EXPLAIN_LINE_H,
        onHeightChange,
      );
    },
  };
}

// ── Error ─────────────────────────────────────────────────────────────────────

function buildError(actions: ViewActions): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title", text: "Workflow stopped." });
  const detail = h("div", { class: "detail" });
  const row = h("div", { class: "actions" },
    btn("Retry", "primary", () => actions.setView(State.defaultView())),
    btn("Open in n8n", "secondary", () => actions.openUrl("")),
  );
  const el = h("div", { class: "view" }, card("red", stack(116, 16, who, title, detail, row)));
  return {
    el,
    sync() {
      const task = State.subjectTask;
      clear(who);
      who.append(agentWho(task, task?.source === "n8n" ? "n8n" : "Claude Code"));
      title.textContent = task?.source === "n8n" ? "Workflow stopped." : "Session stopped on an error.";
      detail.textContent = task?.steps.at(-1) ?? "No detail available.";
    },
  };
}

// ── Finished ──────────────────────────────────────────────────────────────────

function buildFinished(actions: ViewActions): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title" });
  const row = h("div", { class: "actions" },
    btn("Open terminal", "primary", () => actions.openTerminal()),
    btn("OK", "secondary", () => actions.collapse()),
  );
  const el = h("div", { class: "view" }, card("green", stack(116, 16, who, title, row)));
  return {
    el,
    sync() {
      // The session that finished, even if another one leads by now.
      const task = State.subjectTask;
      clear(who);
      who.append(agentWho(task, "Claude Code finished"));
      title.textContent = task?.steps.at(-1) ?? "Session finished";
    },
  };
}

// ── Confused ──────────────────────────────────────────────────────────────────

function buildConfused(): ViewHost {
  const body = h(
    "div",
    { class: "stack", style: "padding:0 18px 0 128px" },
    h("div", { class: "title", text: "Too many hits at once." }),
    h("div", { class: "sub", text: "Give me a sec — back to work in three seconds." }),
  );
  return { el: h("div", { class: "view" }, card("pink", body)), sync() {} };
}

// ── Note ──────────────────────────────────────────────────────────────────────

function buildNote(): ViewHost {
  const title = h("div", { class: "title" });
  const el = h("div", { class: "view" }, card(null, h("div", { class: "stack", style: "padding:0 18px 0 98px" }, title)));
  return {
    el,
    sync() {
      title.textContent = State.noteMessage ?? "";
    },
  };
}

// ── In-island settings ────────────────────────────────────────────────────────

function buildSettings(actions: ViewActions): ViewHost {
  const soundSwitch = h("button", { class: "switch", onclick: () => actions.toggleSound() });
  const volume = h("input", {
    type: "range", min: "0", max: "0.2", step: "0.005",
    oninput: (e: Event) => actions.setVolume(Number((e.target as HTMLInputElement).value)),
  }) as HTMLInputElement;
  const autoLabel = h("span", {});
  const segButtons = [10, 15, 30].map((s) =>
    h("button", { onclick: () => actions.setAutoClose(s) }, `${s}s`),
  );
  const claudeBadge = h("span", { class: "status-badge" });
  const apiBadge = h("span", { class: "status-badge" });

  const rows = h(
    "div",
    { class: "settings-rows" },
    h("div", { class: "settings-row" }, soundSwitch, h("span", { text: "Sound" }), volume),
    h(
      "div",
      { class: "settings-row" },
      svg(ICONS.timer, 12),
      autoLabel,
      h("div", { class: "seg" }, ...segButtons),
    ),
    h(
      "div",
      { class: "settings-row", style: "gap:14px" },
      claudeBadge,
      apiBadge,
      h("div", { class: "grow" }),
      h("button", {
        class: "link-btn",
        style: "color:#8e939c;font-size:11.5px",
        text: "Settings…",
        onclick: () => actions.openSettingsWindow(),
      }),
    ),
  );

  const el = h("div", { class: "view" },
    card(null, h("div", { class: "stack", style: "padding:14px 16px 14px 84px" }, rows)));

  return {
    el,
    sync() {
      const s = State.settings;
      soundSwitch.classList.toggle("on", s.soundEnabled);
      volume.value = String(s.soundVolume);
      volume.style.opacity = s.soundEnabled ? "1" : "0.4";
      autoLabel.textContent = `Auto-close · ${Math.round(s.autoCloseInterval)}s`;
      segButtons.forEach((b, i) => b.classList.toggle("on", s.autoCloseInterval === [10, 15, 30][i]));
      clear(claudeBadge);
      claudeBadge.append(
        dot(s.hooksInstalled ? "#22C55E" : "#F4505E", 6),
        h("span", { text: "Claude Code" }),
      );
      clear(apiBadge);
      apiBadge.append(dot("#F4505E", 6), h("span", { text: "API" }));
    },
  };
}

// ── Placeholders filled in later stages ───────────────────────────────────────

function buildPlaceholder(title: string, sub: string): ViewHost {
  const body = h(
    "div",
    { class: "stack", style: "padding:0 18px 0 118px" },
    h("div", { class: "title", text: title }),
    h("div", { class: "sub", text: sub }),
  );
  return { el: h("div", { class: "view" }, card(null, body)), sync() {} };
}

// ── Registry ──────────────────────────────────────────────────────────────────

/**
 * `onHeightChange`: a view's height changed without the view changing — the
 * chat growing with its messages, a card growing with its text.
 */
export function buildViews(
  actions: ViewActions,
  onHeightChange: () => void,
): Map<IslandViewName, ViewHost> {
  const map = new Map<IslandViewName, ViewHost>();
  map.set("overview", buildOverview(actions));
  map.set("empty", buildEmpty(actions));
  map.set("approval", buildApproval(actions, onHeightChange));
  map.set("question", buildQuestion(actions, onHeightChange));
  map.set("error", buildError(actions));
  map.set("finished", buildFinished(actions));
  map.set("confused", buildConfused());
  map.set("note", buildNote());
  map.set("settings", buildSettings(actions));
  map.set("prompt", buildPrompt(onHeightChange));
  map.set("upload", buildUpload());
  map.set("uploading", buildUploading());
  map.set("choose", buildChoose(actions));
  // Not in the Windows v1: sending a file by email, window attach + web result.
  map.set("mail", buildPlaceholder("Sending by email isn't in this version.", ""));
  map.set("searching", buildPlaceholder("Claude is searching…", ""));
  map.set("result", buildPlaceholder("Result", ""));
  return map;
}
