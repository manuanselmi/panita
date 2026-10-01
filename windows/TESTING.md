# Testing Coucou for Windows

Four layers, from cheapest to closest to the real thing. The first three are
automated and safe to run on a machine where Coucou is installed and in use;
the fourth moves the mouse and is opt-in.

| Layer | Command | What it covers | Time |
|---|---|---|---|
| Rust unit tests | `npm run test:rust` | Relay output JSON and arguments (`--wsl-distro`, `--wsl-ppid`), the relay's ancestry walk (synthetic process tables, and the real one against a Toolhelp snapshot), instance names, pipe naming, the permission decision path, settings.json merging and writing for Windows and WSL targets — including an install that predates `--wsl-ppid` reading as outdated and its update —, WSL helpers (distro names, `wsl -l` decoding, probe parsing, `/proc/<pid>/stat` parsing and the Linux chain, `\wsl.localhost` paths, shell quoting), terminal focus (what is remembered per session, the extension's pipe names, request and reply), the VS Code window matcher and "open" plan (with and without a terminal the extension showed), folder-URI encoding, the extension's status (`code --list-extensions` parsing, versions), window enumeration, file ingest | ~1 min cold, seconds warm |
| TypeScript unit tests | `npm run test:unit` | `hooks.ts` (step labels, approval target, every hook event → its session, several sessions at once, where each "Open" goes), `state.ts` + `sessions.ts` (session creation, order and its dwell, approval and click promotion, `SessionEnd` and expiry, colours, panitas and "+N", integrations after the sessions, default view), `bridge.ts` (`openSession`, hook-target and extension command names and arguments), the companion VS Code extension (its pipe protocol, terminal matching, malformed input, and its `vscode` glue against a stand-in `vscode` module); type-checks the tests | seconds |
| End to end | `npm run test:e2e` | The real `coucou-hook.exe` → named pipe → the real app → the island webview and back, driven over CDP — from Windows and from inside WSL — plus the settings window's hook install flow in a sandbox home, and the island's ↗ asking a fake VS Code window for the session's terminal | ~3–5 min cold, ~1–2 min warm |
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

A side instance never edits a `~/.claude/settings.json` — the Windows one or a
WSL distro's: Settings → Claude Code → Install… shows an error instead. Every
Coucou entry in those files looks the same, so installing from a side instance
would replace the real install's hooks.

The one exception is for tests: a side instance started with
`COUCOU_TEST_HOME=<absolute folder>` keeps every hook target's settings.json in
that folder — `<folder>\windows\.claude\settings.json` and
`<folder>\wsl\<distro>\.claude\settings.json` — and may install there. The real
install ignores the variable entirely (`hooks::test_home`). The relay's Linux
path is still asked of the real distro (`wslpath`, read-only).

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

From a Claude Code session **inside WSL**, the relay is a Windows process
started through WSL interop, and interop only hands it the Linux variables
listed in `WSLENV` — with the `/w` flag (Linux → Windows) or no flag. `/u` means
Windows → Linux only, so a value set inside Linux with `WSLENV=COUCOU_INSTANCE/u`
never reaches the relay, and the events go to the *installed* app:

```sh
# inside the distro, before starting claude
export COUCOU_INSTANCE=dev
export WSLENV="${WSLENV:+$WSLENV:}COUCOU_INSTANCE/w"
```

A variable set on the Windows side of the `wsl.exe` that started the shell also
reaches every Windows process started from it, whatever `WSLENV` says.

## Rust unit tests

```powershell
npm run test:rust        # = cargo build --release -p coucou-hook && npm run build:extension && cargo test --workspace
```

Cargo has to be on `PATH` (`%USERPROFILE%\.cargo\bin`). The release relay and
the companion VS Code extension's package are built first because the app's
build script checks that the bundled resources —
`target/release/coucou-hook.exe` and
`vscode-extension/dist/coucou-terminal-focus.vsix` — exist.

How much the relay's ancestry walk costs on this machine (it runs on every
hook event), against a Toolhelp snapshot of every process:

```powershell
cargo test -p coucou-hook --release -- --nocapture ancestry_cost
```

No unit test touches the real install: the ingest test copies into a temporary
inbox, the hooks tests read and write settings files in temporary folders
(everything in `hooks.rs` works on a `Location`, a settings path plus how the
command reads, for Windows and WSL alike), and `log::line` is a no-op under
`cfg(test)`.

The terminal-focus tests never look at real processes beyond their own: the
walks run on made-up process tables (Windows PIDs and `/proc/<pid>/stat` lines,
including command names with spaces and parentheses), and the relay's real
walk is only checked on the test binary's own ancestry.

Two tests touch the desktop, harmlessly. The window-enumeration test creates a
handful of throwaway windows of its own — tool windows, off screen, shown
without activation, one cloaked, one minimized — checks which are listed, and
asserts the foreground window did not change. The batch-file test writes a
small `.cmd` to `%TEMP%` and runs it, to check a percent-encoded URI survives
`%*` the way `code.cmd` forwards it.

Two read-only tests are ignored by default because they look at this machine's
real setup: `live_wsl` lists the distros, asks which run, and probes the default
one for `$HOME` and a relay path (`printf` and `wslpath` only); `live_status`
reads every hook target's status — the real `%USERPROFILE%\.claude\settings.json`
and each running distro's through `\\wsl.localhost`. Neither writes anything;
`live_wsl` may start a stopped distro.

```powershell
cargo test -p coucou --lib -- --ignored --nocapture live_
```

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

`bridge.test.ts` tests the bridge itself, with `@tauri-apps/api/core`'s
`invoke` mocked: the command names and argument keys the Rust side expects
(`openSession` → `open_session { cwd, wslDistro, sessionId }`, the optional
hook `target`, the extension's status and install), and that a failed
`openSession` resolves to `"failed"` rather than throwing.

`extension.test.ts` tests the companion VS Code extension
(`vscode-extension/`). Its pipe server, `server.ts`, imports nothing from
VS Code, so it runs as is: requests and their refusals, which PIDs a local, a
Remote-WSL or another remote window looks at, the nearest ancestor winning,
terminals that never report a PID, and the protocol over real named pipes
(chunked and malformed input, an oversized request, a silent connection).
`extension.ts`, the `vscode` glue, runs against `vscode-mock.ts`, which
`vitest.config.ts` aliases `vscode` to: a local window, a Remote-WSL window and
its distro, another remote, an unusable `COUCOU_INSTANCE`, and that
deactivating closes the pipe. Those pipes are named for the instance
`unittest` (`\\.\pipe\coucou-unittest-vscode-*`), which no Coucou looks at.

Vitest 5 needs Node 22.12 or later (Node 20 is end-of-life).

## End-to-end suite

```powershell
npm run test:e2e
```

What it does, in order:

1. **Builds** `target/debug/coucou.exe` with the front end embedded
   (`tauri build --debug --no-bundle`, so no Vite server),
   `target/release/coucou-hook.exe` and the companion VS Code extension's
   `vscode-extension/dist/coucou-terminal-focus.vsix`. Incremental after the
   first run. It
   shares `target/debug` with `npm run tauri dev`, so switching between the two
   costs a re-link of the app crate.
2. **Launches the side instance `e2e`** (`COUCOU_INSTANCE=e2e`) with muted
   settings, a sandbox home for hook installs (`COUCOU_TEST_HOME=test-results\e2e\sandbox-home`),
   a fake VS Code `code` command first on its `PATH` (`test-results\e2e\fake-code\code.cmd`,
   which records its arguments and opens nothing),
   and `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<free port>`
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
     `Ejecuta · echo hello-e2e`; each relay run exits 0 with empty stdout;
   - the ticker's visible rows never overlap, and it keeps up past twenty steps;
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
   - `Stop` → the finished card; `SessionEnd` → the session is gone;
   - **several sessions at once** (six, one of them in WSL): who is on the left
     card, the second session on the right, the panitas and their "+1", in
     order of activity; each session's colour never changes and no two are
     alike; `wsl_distro` survives the relay; a click on a panita takes the left
     card at once; each ↗ and "Open terminal" opens the session it belongs to;
     the approval card names the session asking (and its colour) and Allow /
     Deny still answer exactly; another session's request meanwhile is
     declined and that session badged; the compact island's minis; `SessionEnd`
     one by one down to the empty card;
   - `openSession` with input it must refuse (an invalid distro, a Windows path
     for a WSL session, a relative path) → `"failed"` and the matching
     `open session … refused` log line. That proves the command and its
     argument names end to end without focusing or opening anything;
   - **terminal focus**, against a fake VS Code window (`fake-vscode.ts`: the
     companion extension's own pipe server, run in the suite's process with
     made-up terminals, on the side instance's pipe name). First, that the
     side instance's `code` is the fake (`vscode_extension_status`). Then a
     session in a folder that exists nowhere, sent through the real relay;
     the island's ↗ clicked with nothing intercepted → the fake window is
     asked with the relay's ancestry (nearest first: the suite's own process,
     then its parent), shows the matching terminal with `show(false)`, and the
     log says `terminal "e2e-terminal" focused in "<window>"` and
     `terminal shown, window not raised` (no window on screen has that name,
     and none is opened since the session is known to live in VS Code).
     With a window that has no matching terminal, a wedged one (it takes the
     connection and never answers: given up on after 1.5 s), then with no
     window at all, ↗ is what it was before the extension: no VS Code window
     for the folder → `code <cwd>`, answered by the fake. After `SessionEnd`
     the terminal is forgotten (`no terminal recorded for it`);
   - **Settings → Claude Code, Windows row** (the settings window's page, over
     CDP, still hidden): the row points into the sandbox, **Install…** shows the
     diff, **Back up and write** writes the unchanged Windows command for every
     event, **Uninstall…** takes it out again;
   - **Settings → Claude Code, VS Code terminal focus row**: it shows the fake
     `code` (checked before clicking), "Not installed"; **Install** runs
     `code --install-extension <the bundled .vsix> --force` — the fake records
     it, and the .vsix is the real package this build made — and the row
     turns "Installed <version>";
   - a Windows session's payload, as the island receives it, has no
     `wsl_distro` — and no `ancestor_pids` or `wsl_ppid`, which the app keeps;
   - **from inside WSL** (skipped when WSL is missing or the distro is not
     running): the side instance's staged relay, run by a Linux `sh -c` with
     `--wsl-distro "$WSL_DISTRO_NAME"` exactly as installed → logged as
     `hook PreToolUse wsl=<distro>`, and the island's payload carries
     `wsl_distro` and the Linux cwd; a `PermissionRequest` from WSL →
     **Allow** → the documented allow JSON comes out on the Linux side;
   - **terminal focus from WSL**: the installed command run by a child of a
     Linux shell that then sleeps, so its `$PPID` is that shell and it is still
     alive when ↗ is clicked. A fake Remote-WSL window, whose terminal's PID is
     that shell's, is asked with the Linux chain the app read from `/proc` in
     the distro (that shell first, then up) and the relay's Windows ancestry —
     which, through interop, runs via the `wsl.exe` the suite started back to
     the suite's own process — and shows the terminal;
   - **Settings → Claude Code, WSL row**, on a seeded settings.json with another
     tool's hook: **Install…** → diff with the relay's Linux path (from
     `wslpath`) and the distro and parent-PID arguments → **Back up and write**;
     the dated backup holds the original bytes, the other hook and settings are
     intact; then the installed `PreToolUse` command, read back from the file,
     is run by a Linux shell and reaches the island; **Uninstall…** restores the
     original;
   - **an outdated WSL install**: a settings.json with every command as the
     previous version wrote it (no `--wsl-ppid`) → the row says "Installed —
     update available" → **Update…** shows the old and the new command in the
     diff → **Back up and write** → every command is the current one, the
     backup holds the old file, the row says "Installed";
   - no uncaught exception in the island.

   Two things the multi-session tests do to the page, both DOM-level: they
   record and swallow every `open_*` command the page sends, so clicking "Open"
   opens no VS Code or Explorer window. Tauri's `invoke` is read-only, so this
   patches `fetch`, its IPC transport, and a probe command proves the patch
   right before every such click — if it does not hold, the click is refused.
   And they send the island one `cursor` event far off-screen,
   because the session order holds still while the pointer is on the open
   island. The Rust cursor poll only speaks when the real mouse moves, so that
   holds unless someone moves the mouse over the island during the run.

   The terminal-focus tests are the one place a ↗ reaches Rust for real
   (`clickOpenUnintercepted`). Three things keep that harmless: the sessions'
   folders exist nowhere, so no window on the desktop matches them and nothing
   is activated; the side instance's `code` is the fake, proven by the first
   of those tests before any click; and the only extension pipes a side
   instance looks for are `coucou-<instance>-vscode-*` — the fake window's.
   Real VS Code windows serve `coucou-vscode-*` (or their own instance's), and
   the suite never connects to any pipe itself.
5. **Quits the app** the way the tray's Quit does (so its tray icon goes away),
   force-kills only if that fails, waits for its WebView2 processes, and
   deletes `%LOCALAPPDATA%\Coucou-e2e`, `%APPDATA%\Coucou-e2e` and
   `%LOCALAPPDATA%\fr.louisraille.coucou.e2e`.
6. **Checks afterwards** that the side instance is gone, that the relay with
   nobody listening exits at once with empty stdout, and that the real install
   was not touched: same `coucou.exe` processes (debug builds — side instances,
   possibly another checkout's — aside), same pipe, no new
   `--- started ---` line in its log, no inbox created, and the real
   `~/.claude/settings.json` files — Windows, and the running distro's, read
   through `\\wsl.localhost` — byte for byte as they were (SHA-256).

The suite uses its own instance name, `e2e`, rather than `dev`, because it wipes
its instance's folders before and after every run; a hand-run `dev` instance and
its settings are never touched. (`COUCOU_E2E_INSTANCE` overrides the name.) Its
settings are muted, with no integration switched on — the shipped default.

Output lands in `test-results/e2e/` (git-ignored): screenshots of the island at
each step (transparent PNGs of the 720×320 window), `app-output.log`,
`side-instance.log` (the side instance's `coucou.log`), `island-console.log`,
`build.log`, `sandbox-home/` (the settings files the install cases wrote, with
their backups), `fake-code/` (the fake `code` and every call it got), and
`real-install.json` (the before/after snapshot of the real
install, with any lines its log gained during the run — those come from Claude
Code sessions on the machine, including the one running the suite).

| Variable | Effect |
|---|---|
| `COUCOU_E2E_SKIP_BUILD=1` | Reuse the existing binaries (still refused if they predate `COUCOU_INSTANCE`) |
| `COUCOU_E2E_SLOW=1` | Also run the unanswered-card case: the app gives up after 108 s, the relay prints nothing. Adds ~2 min |
| `COUCOU_E2E_INSTANCE=<name>` | Run as another side instance (default `e2e`) |
| `COUCOU_E2E_WSL_DISTRO=<name>` | The distro for the WSL cases (default: the default distro). It must be running |

### The WSL cases

They run the relay from inside your distro, through WSL interop, as a Claude
Code session there would. Inside the distro only `sh`, `printf`, `wslpath`,
`cmd.exe /c echo` and the relay itself run; nothing is written there, and the
suite never starts a stopped distro — it skips instead.

The side instance's name has to reach the relay, a Windows process started from
Linux. The suite sets `COUCOU_INSTANCE` in `wsl.exe`'s own environment (WSL
interop hands that environment to every Windows process started in the session)
and lists it in `WSLENV` without a flag. Before sending anything from WSL, the
same shell runs `cmd.exe /c echo %COUCOU_INSTANCE%`; unless that prints the side
instance's name the run stops (exit 97), since the relay would otherwise talk to
the real install.

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
  relay with nobody listening only after that — from Windows and, separately,
  from WSL, where the `cmd.exe` echo above comes first;
- it checks that a settings row points into the sandbox home before clicking
  Install or Uninstall, and that the real settings files are unchanged at the
  end;
- it leaves the side instance's folders alone while an instance of that name is
  serving its pipe — another checkout's run of the suite (a second git
  worktree, say) uses the same name and the same folders. Two suites at once
  need different `COUCOU_E2E_INSTANCE` names; with the same name the second one
  refuses to start;
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
- **`openSession` actually moving the foreground** — it would take the
  foreground from whoever runs the suite. Check by hand, with the island calling
  `Bridge.openSession(cwd, wslDistro)` (or from the island's devtools):
  - a session in a subfolder of an open window's root (e.g. cwd
    `…\GitHub\panita\windows`, window on `…\GitHub`) → that window comes to the
    front, returns `"focused"`, and no new window opens;
  - the same window minimized → restored and in front;
  - the window on **another virtual desktop** → Windows switches to that
    desktop and the window is in front;
  - a WSL session (`wsl_distro` set) → its `[WSL: <distro>]` window, never a
    Windows window on a folder of the same name;
  - no matching window → `code <cwd>` (Windows) or
    `code --folder-uri vscode-remote://wsl+<distro>/…` (WSL) opens it,
    `"opened"`; without `code` on PATH → Explorer, `"explorer"`;
  - Coucou's log says which step worked: `focused its VS Code window — set
    directly` or `— set with the foreground thread's input attached`. If it
    says Windows kept the foreground, the window's taskbar button should flash.
- **Terminal focus with the real extension in the real VS Code** — installing
  it changes the user's VS Code, and focusing a tab takes the foreground. By
  hand, once:
  - Settings → Claude Code → **VS Code terminal focus** → **Install**; the row
    turns "Installed <version>"; reload the open VS Code windows (Developer:
    Reload Window). In each, View → Output → "Coucou terminal focus" says
    `serving \\.\pipe\coucou-vscode-<pid>-<hex>`.
  - **A Windows terminal**: two terminal tabs in one window, `claude` in the
    second, the first one in front; ↗ on that session → the second tab comes
    forward, focused, and the window comes to the front. The log says
    `terminal "<tab name>" focused in "<window>"`, then `focused its VS Code
    window`.
  - **Several terminals and several sessions in one window**, and a session
    in a subfolder of a window on its parent (`…\GitHub\panita\windows` in a
    window on `…\GitHub`) while another window is open on `panita`: each ↗
    reaches its own tab, in the window that really has it.
  - **A WSL terminal** in a Remote-WSL window (after **Update…** on the
    `WSL · <distro>` row, so the installed command passes `--wsl-ppid`, and a
    new `claude` in the distro): same as above. The log line names the
    `[WSL: <distro>]` window.
  - **A `wsl` profile tab in a local window** running `claude` inside the
    distro: found through the relay's Windows ancestry (the tab's `wsl.exe`).
  - Without the extension (uninstall it, or a window not yet reloaded): ↗ does
    exactly what it did before (`no extension answered`).
- **A real WSL Claude Code session end to end**: Settings → Claude Code → the
  `WSL · <distro>` row → Install… (or Update…, for an install from before
  `--wsl-ppid`) on the distro's real `~/.claude/settings.json`,
  then `claude` inside the distro — events, an approval answered from the island,
  `hook … wsl=<distro>` in the log. This is also the first write through
  `\\wsl.localhost` (the suite's sandbox is a Windows folder): check the dated
  backup sits next to the file, and that the file's owner and mode in Linux are
  still sensible (`ls -l ~/.claude/settings.json`).
- **A stopped distro**: its row says "Not running — not checked"; **Check…**
  starts it and shows the real status.

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
