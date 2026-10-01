# Testing Coucou for Windows

Four layers, from cheapest to closest to the real thing. The first three are
automated and safe to run on a machine where Coucou is installed and in use;
the fourth moves the mouse and is opt-in.

| Layer | Command | What it covers | Time |
|---|---|---|---|
| Rust unit tests | `npm run test:rust` | Relay output JSON, instance names, pipe naming, the permission decision path, settings.json merging, file ingest | ~1 min cold, seconds warm |
| TypeScript unit tests | `npm run test:unit` | `hooks.ts` (step labels, approval target, every hook event → `State`), `state.ts` (pills, 4-integration cap, focus, default view); type-checks the tests | seconds |
| End to end | `npm run test:e2e` | The real `coucou-hook.exe` → named pipe → the real app → the island webview and back, driven over CDP | ~3–5 min cold, ~1 min warm |
| Real input | `npm run test:input` | Hover-to-reveal, a real click not stealing the foreground. **Moves the mouse** — see below | ~2 min |

`npm test` runs the first two.

## The side instance (`COUCOU_INSTANCE`)

A developer machine usually has the real Coucou installed, running, and wired
into `~/.claude/settings.json`. Tests — and dev builds — must never talk to it:
not answer its permission requests, not write its log, not read its API keys,
not trip its single-instance lock. So both `coucou.exe` and `coucou-hook.exe`
read one environment variable, `COUCOU_INSTANCE`, and when it is set every
shared name moves aside:

| | Real install (variable unset) | `COUCOU_INSTANCE=dev` |
|---|---|---|
| Relay pipe | `\\.\pipe\coucou-<sid>` | `\\.\pipe\coucou-dev-<sid>` |
| Log, `bin\`, `inbox\` | `%LOCALAPPDATA%\Coucou` | `%LOCALAPPDATA%\Coucou-dev` |
| `settings.json` | `%APPDATA%\Coucou` | `%APPDATA%\Coucou-dev` |
| Credential Manager service | `fr.louisraille.coucou` | `fr.louisraille.coucou.dev` |
| Tauri identifier — single-instance mutex, WebView2 profile (`%LOCALAPPDATA%\<identifier>`) | `fr.louisraille.coucou` | `fr.louisraille.coucou.dev` |
| Autostart entry | `Coucou` | `Coucou-dev` |
| Tray tooltip | `Coucou` | `Coucou (dev)` |

The rules live in one file, [`hook/src/instance.rs`](hook/src/instance.rs),
which the app includes with `#[path]`, so both ends of the relay compute the
pipe name with the same code. Unset or blank means the real install, with every
name exactly as before. A name must be 1–32 ASCII letters or digits; anything
else never falls back to the real install — the app refuses to start and the
relay exits silently.

The identifier is patched into the Tauri context at startup, not baked in at
build time, so one build serves both identities and a binary can never end up
"half dev": an old build that ignored the variable would collide with the real
app instead, which is why the end-to-end suite refuses binaries that do not
contain the string `COUCOU_INSTANCE`.

A side instance never edits `~/.claude/settings.json`: Settings → Claude Code →
Install hooks shows an error instead. Every Coucou entry in that file looks the
same, so installing from a side instance would replace the real install's hooks.

### Using it by hand

```powershell
cd windows
$env:COUCOU_INSTANCE = "dev"
npm run tauri dev        # a second Mochi, isolated from the installed one
```

Its tray icon's tooltip says `Coucou (dev)`; quit that one, not the other.

To send a real Claude Code session to it, start Claude Code with the same
variable in its environment (`$env:COUCOU_INSTANCE = "dev"; claude`). The hooks
in `settings.json` run the installed relay, `%LOCALAPPDATA%\Coucou\bin\coucou-hook.exe`,
so this works only once the installed relay is a build that knows the variable;
an older relay ignores it and the events go to the installed app.

## Rust unit tests

```powershell
npm run test:rust        # = cargo build --release -p coucou-hook && cargo test --workspace
```

Cargo has to be on `PATH` (`%USERPROFILE%\.cargo\bin`). The release relay is
built first because the app's build script checks that the bundled resource
`target/release/coucou-hook.exe` exists.

No unit test touches the real install: the ingest test copies into a temporary
inbox, the hooks test points `USERPROFILE` at a temporary folder, and
`log::line` is a no-op under `cfg(test)`.

## TypeScript unit tests

```powershell
npm run test:unit        # = tsc -p tests && vitest run
npx vitest               # watch mode
```

They run in plain Node. `src/core/bridge.ts` (the Tauri bridge) and
`src/core/sound.ts` (Web Audio) are mocked with `vi.mock`; `State` is the real
singleton, reloaded for every test. `hooks.ts` is driven exactly as in the app —
through the `hook` listener it registers — with payloads shaped like the ones
the relay forwards. No production code was changed to make it testable.

Vitest 5 needs Node 22.12 or later (Node 20 is end-of-life).

## End-to-end suite

```powershell
npm run test:e2e
```

What it does, in order:

1. **Builds** `target/debug/coucou.exe` with the front end embedded
   (`tauri build --debug --no-bundle`, so no Vite server) and
   `target/release/coucou-hook.exe`. Incremental after the first run. It
   shares `target/debug` with `npm run tauri dev`, so switching between the two
   costs a re-link of the app crate.
2. **Launches the side instance `e2e`** (`COUCOU_INSTANCE=e2e`) with muted
   settings, and `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<free port>`
   in that process's environment only. WebView2 appends this to the island's own
   `additionalBrowserArgs` from `tauri.conf.json` rather than replacing them —
   the suite checks the browser process's command line for all three flags, and
   checks the real install's WebView2 has no debugging port.
3. **Connects over CDP** to the island page with a small client on Node's
   built-in `WebSocket` (`tests/e2e/cdp.ts`) — no Playwright, no browser download.
4. **Sends hook events through the real relay**, as Claude Code does (event name
   as argument, JSON on stdin), and checks both the side instance's log and the
   island's DOM:
   - `UserPromptSubmit`, `PreToolUse`, `PostToolUse` — logged in order, the
     overview names the session after its folder, the ticker shows
     `Exécute · echo hello-e2e`; each relay run exits 0 with empty stdout;
   - `PermissionRequest` → **Allow** (an `element.click()` on the button, not a
     mouse click) → the relay's stdout is exactly the documented
     `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}`;
   - the same with **Deny** and its documented deny JSON;
   - a second request while a card is up → handed straight back (empty stdout,
     `decline` logged), and the first card still answers;
   - an unresponsive island (its main thread kept busy for three seconds) →
     empty stdout after the 800 ms ack window, not two minutes; the stale card
     that appears once it recovers answers nobody;
   - a paused island (the tray's Pause, sent as the same `tray` event) →
     declined at once;
   - `Stop` → the finished card; `SessionEnd` → the session resets;
   - no uncaught exception in the island.
5. **Quits the app** the way the tray's Quit does (so its tray icon goes away),
   force-kills only if that fails, waits for its WebView2 processes, and
   deletes `%LOCALAPPDATA%\Coucou-e2e`, `%APPDATA%\Coucou-e2e` and
   `%LOCALAPPDATA%\fr.louisraille.coucou.e2e`.
6. **Checks afterwards** that the side instance is gone, that the relay with
   nobody listening exits at once with empty stdout, and that the real install
   was not touched: same `coucou.exe` processes, same pipe, no new
   `--- started ---` line in its log, no inbox created.

The suite uses its own instance name, `e2e`, rather than `dev`, because it wipes
its instance's folders before and after every run; a hand-run `dev` instance and
its settings are never touched. (`COUCOU_E2E_INSTANCE` overrides the name.)

Output lands in `test-results/e2e/` (git-ignored): screenshots of the island at
each step (transparent PNGs of the 720×320 window), `app-output.log`,
`side-instance.log` (the side instance's `coucou.log`), `island-console.log`,
`build.log`, and `real-install.json` (the before/after snapshot of the real
install, with any lines its log gained during the run — those come from Claude
Code sessions on the machine, including the one running the suite).

| Variable | Effect |
|---|---|
| `COUCOU_E2E_SKIP_BUILD=1` | Reuse the existing binaries (still refused if they predate `COUCOU_INSTANCE`) |
| `COUCOU_E2E_SLOW=1` | Also run the unanswered-card case: the app gives up after 108 s, the relay prints nothing. Adds ~2 min |
| `COUCOU_E2E_INSTANCE=<name>` | Run as another side instance (default `e2e`) |

### Guards

The suite enforces, rather than trusts, that it stays away from the real install
(`tests/e2e/harness.ts`):

- it only stops a process it started, after re-checking that its executable is
  `target/debug/coucou.exe` — never by name — and only deletes folders named
  exactly `Coucou-<instance>` / `fr.louisraille.coucou.<instance>` under
  `%LOCALAPPDATA%` / `%APPDATA%` — and never while any app still serves that
  instance's pipe. Two checkouts running the suite at once under the same name
  (two worktrees, say) would otherwise wipe each other's log and settings
  mid-run; give each its own `COUCOU_E2E_INSTANCE`;
- it refuses binaries without side-instance support;
- it only ever *lists* named pipes: `stat`/`existsSync` on a pipe path opens a
  connection to whoever serves it;
- it sends no `PermissionRequest` before work events sent with the side
  instance's name have shown up in the side instance's own log, and runs the
  relay with nobody listening only after that;
- a crashed run's app is stopped by the next run (PID file, path re-checked).

### While it runs

The side instance is a real app on your desktop for about a minute: its island
appears at the top centre of the primary display, over the real one, and opens
on its own for the approval and finished cards. It never takes focus, and it
plays no sound. Its cursor poll reads the real pointer, so parking the mouse on
the island during a run can change what the island does (hover effects, the
auto-close timer). A CDP debugging port is open on `127.0.0.1` for the side
instance only, for the duration of the run.

## What is deliberately not automated

CDP can click DOM elements and read the page; it cannot produce real input or
judge looks. These stay manual (or in the opt-in real-input scaffold):

- **Hover-to-reveal** at the top edge: the wake strip only reacts to the real
  pointer entering the window.
- **Which window ends up in the foreground** after a real click on the island
  (`WS_EX_NOACTIVATE`), and keyboard focus for the chat field.
- **Click-through** outside the island shape (decided in Rust from the real
  cursor position).
- **Drag and drop from Explorer** — `dev/upload-preview.html` replays the drop
  choreography in a browser instead.
- **The tray menu** (a native menu; the suite sends its `pause` event directly).
- **Multi-monitor placement** and DPI changes.
- **Look and feel**: Mochi's animations, the island's springs, sounds, and the
  match with `design/captures/`. The screenshots in `test-results/e2e/` are for
  a human to look at; nothing compares pixels.
- **Anything needing real accounts**: the chat (Anthropic API) and the
  integration pollers. A side instance has its own, empty, Credential Manager
  service, so it can neither use nor overwrite the real keys.

### Real input (opt-in, moves the mouse)

```powershell
$env:COUCOU_ALLOW_REAL_INPUT = "1"; npm run test:input
```

**Moves the mouse and clicks — run it only on an idle desktop.** Without
`COUCOU_ALLOW_REAL_INPUT=1` every test in it is skipped. It launches the same
`e2e` side instance, waits for the island to hide, touches the top-centre
strip (expects the compact island), then clicks the island (expects it to open
without changing the foreground window). Before clicking it checks that the
window under the pointer belongs to the side instance's process, and it puts the
pointer back at the end.

It is a **scaffold**: written with the end-to-end suite but not yet run, since
it was built on a machine someone was using. Expect to adjust it on first use.
