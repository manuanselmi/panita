<div align="center">

<img src="src-tauri/icons/128x128.png" width="96" alt="Coucou icon">

# Coucou for Windows

**Mochi doesn't get a notch on a PC — so it lives at the top of your screen instead.**

Approve Claude Code permissions, watch your session work, drop a file, chat with Claude, keep an eye on your services — without leaving what you're doing.

![Windows 10/11](https://img.shields.io/badge/Windows-10%2F11-0078D4?logo=windows)
![Tauri 2](https://img.shields.io/badge/Tauri-2-FFC131?logo=tauri&logoColor=black)
![Rust](https://img.shields.io/badge/Rust-backend-000?logo=rust)
![License: MIT](https://img.shields.io/badge/license-MIT-green)

</div>

<img src="screenshots/greeting.png" width="640" alt="Mochi waving hello at launch">

---

## Install

The downloadable installer is **temporarily unavailable**. Microsoft Defender
wrongly flags the unsigned installer as malware (`Trojan:Win32/Wacatac.H!ml`, a
machine-learning false positive). A report is under review at Microsoft, and the
installer will be published again once it is cleared and code-signed.

Until then, [build it yourself](#build-it-yourself): it takes a few minutes and
installs for the current user only — no admin prompt.

## Using it

<img src="screenshots/compact.png" width="292" alt="The compact island, with the integration pills as mini Mochis">
<img src="screenshots/overview.png" width="640" alt="The overview: the focused integration on the left, the other pills on the right">
<img src="screenshots/approval.png" width="640" alt="A Claude Code permission request, with Deny and Allow">
<img src="screenshots/chat.png" width="640" alt="Chatting with Claude from the island">
<img src="screenshots/drop.png" width="640" alt="Mochi turned into a box, waiting for a file">

| What you do | What happens |
|---|---|
| Move the mouse to the very top of the screen, where the island lives (top-centre until you move it) | Mochi peeks out |
| Click the small island | It opens |
| Drag the small island — or the open island by the empty strip of its header — sideways | It slides along the top edge and stays where you leave it, across restarts. Against an edge, it opens towards the middle; dragged back near the middle, it snaps to the centre |
| Click the empty strip of the open island's header — up to the very top of the screen, the usage meter included | It folds back to the small island — whatever it shows. Over a permission card, the request goes back to the terminal, which has been asking too; that session's panita keeps an amber badge until it moves on |
| Click Mochi | It gets annoyed. Three times in a row and it goes dizzy |
| Rest the pointer on Mochi for two seconds | Hearts |
| Drag a file onto the island | Mochi turns into a box, swallows it, then offers to answer questions about it |
| `Esc` | Closes the island, like a click on the header strip |
| Tray icon | Open, Settings…, Pause, Quit |

Everything else happens on its own: a Claude Code permission request opens the
island with **Deny / Allow**, says which session is asking, and explains under
the command what it will do (see below), with a ↗ to that session's terminal;
a question Claude Code asks (`AskUserQuestion`) shows the question and its
options, with **Open terminal** to go and answer it (see below); a finished
session shows what it did; and every Claude Code session running — Windows or WSL — gets its own colour:
the most recently active on the left with its steps, every other one as a
small coloured Mochi — a *panita* — on the right, up to six (past six, the
last one is a "+N"); click one to bring it to the left. Sessions in the same
project are numbered in the order they started — `struxto-especificador`,
`struxto-especificador 2`, `… 3` — and keep their number while they live;
hovering a panita shows its folder and the first thing it was asked.
Integrations are off by default; switched on in Settings, they join the
panitas after the sessions.

### What a command does

Under the command on the approval card, a few words of Spanish say what it
does — `Push de "main" a "dev"`, `Moverse a "x" → Commit en "dev": "fix"`,
`Eliminar "build" y todo su contenido` — with destructive actions in red and a
⚠. The branch of a commit or push is asked of git (`git rev-parse --abbrev-ref
HEAD` in the session's folder, or inside its WSL distro) once the card is up,
and fills in when it arrives; until then, or if git has no answer, it says
"la rama actual". A command it does not know gets no line rather than a guess.
A long chain wraps over up to three lines, the card growing to fit, and ends
in "…" past that; the whole of it is in the line's tooltip.

The dictionary lives in [`src/core/explain.ts`](src/core/explain.ts): an
ordered list of rules (git, files and folders, npm/pnpm/yarn/pip/cargo/docker,
curl/wget, processes; chains of them with `&&`, `;`, `|`), plus one line for
the other tools (`Write`, `Edit`, `WebFetch`…). How to add a rule is written at
the top of that file; each rule has its row in `tests/unit/explain.test.ts`.

### Questions

When a session asks with `AskUserQuestion`, Claude Code puts the question up in
the terminal straight away, while it asks the hook, and a bare "allow" from a
hook is not an answer to it (as read in Claude Code 2.1.289: only an allow
carrying the user's choices is). So Coucou does not hold it:
the request goes back to Claude Code at once, and the island shows a question
card instead — the first question, its options, how many more follow — with
**Open terminal** to go and answer it. The card goes once the question is
answered (or the turn ends).

### Usage

How much of the subscription's **5-hour limit** is used shows as the time left
until it resets (`2h 14m`), a hairline bar and a percentage — centred in the
open island's header, and in the middle of the small island — amber from 80 %,
red from 95 %; its tooltip says at what time the window resets and how much of
the weekly limit is used. Each time a meter comes into view its bar fills from
empty and the percentage counts up with it; a reading that went up eases the
bar along and sends a glint down it. The countdown moves once a minute, and
only while it is on screen. Claude Code hands those
numbers to its *status line*, not to hooks, so the install below also sets a
`statusLine`: the same relay, which passes them to Coucou and prints nothing —
the terminal's status line stays empty. No credential is involved: Coucou never
asks anybody for them. They arrive once a session gets its first answer and
refresh while sessions work; the meter is hidden until then, and once its
window has reset. A `statusLine` of your own is never replaced — the meter then
stays empty.

The same status line, which every session runs for itself, also says how full
that session's **context window** is. The left card shows it for the session it
is showing, as the same kind of bar along the foot of the card (amber from 80 %,
red from 95 %; the tooltip gives the tokens, `Context: 614k of 1M tokens
(61%)`). Every session's is kept, so clicking another panita brings its own up at
once. It appears with a session's first status line after a message — Claude
Code sends none before — and a session the island has not seen a hook event from
yet is skipped until it has.

## Claude Code

<img src="screenshots/settings.png" width="562" alt="The settings window">

Open **Settings… → Claude Code** and click **Install…** on the **Windows** row.
You get the exact diff of what will change in
`%USERPROFILE%\.claude\settings.json`, the path of the dated backup that will be
taken, and nothing is written until you click. Your own hooks are never touched,
and uninstalling removes only Coucou's entries. Besides the hooks, it sets the
`statusLine` the usage meter reads (see **Usage** above) unless you have one;
an install from before the meter shows **Update…**.

The relay is a tiny executable, `coucou-hook.exe`, copied to
`%LOCALAPPDATA%\Coucou\bin\` at launch. It is given 300 ms to reach Coucou and
exits cleanly if the app is closed, slow or crashed — **a Claude Code session is
never blocked or slowed down by Coucou.** If nobody answers a permission request
in time, Coucou stays quiet and Claude Code asks in the terminal as usual.

It works from any terminal — Windows Terminal, PowerShell, VS Code, Git Bash.

### Claude Code inside WSL

Claude Code running inside WSL reads the distro's own `~/.claude/settings.json`,
so **Settings… → Claude Code** has one row per place it runs: **Windows**, then
**WSL · *distro*** for each of your distros, each with its own status and its own
Install / Uninstall — the same diff, dated backup and explicit click before
anything is written, and the same rule about leaving your own hooks alone.

The hooks installed in a distro run the same Windows relay through WSL interop,
by its Linux path (asked of the distro with `wslpath`, so a custom
`automount.root` is fine), followed by `--wsl-distro "$WSL_DISTRO_NAME"` so the
island knows the session lives in WSL, and `--wsl-ppid "$PPID"` so ↗ can find
its terminal (below). Interop has to be enabled in that distro (it is by
default).

A distro whose hooks an older Coucou installed — before `--wsl-ppid` — shows
**Installed — update available**: **Update…** goes through the same diff, dated
backup and click. Nothing is rewritten on its own.

Listing the distros reads the registry and starts nothing. A distro that is not
running is not started just to show its status: its row offers **Check…**, and
Install / Uninstall start it when you click them. Docker Desktop's and Rancher
Desktop's own distros are not listed.

### Straight to the session's terminal

The ↗ on a session brings its VS Code window to the front — on whichever
virtual desktop it is. With the small companion extension installed, it first
brings forward the exact terminal tab the session runs in, which matters as
soon as a window has several terminals or several sessions. VS Code has no
command line for that, hence the extension.

**Settings… → Claude Code → VS Code terminal focus → Install** runs
`code --install-extension` with the extension packaged inside Coucou — only when
you click — and the row then shows the installed version. Reload the VS Code
windows that were already open (Developer: Reload Window).

How it finds the tab: with every hook event the relay sends the PIDs of the
processes it runs under; the terminal's shell is one of them (inside WSL, the
distro's own process tree is read when you click). Each VS Code window's
extension serves a named pipe that only answers "is the terminal with one of
these shell PIDs mine?", shows it when it is, and names its window so Coucou
raises the right one. It works for Windows terminals, Remote-WSL windows and
`wsl` tabs in local windows. Nothing leaves the machine; without the extension,
or for a session it does not know, ↗ does what it always did.

## Chat and keys

In this fork the island's chat is answered by **Claude Code** — the `claude`
already installed on your PC, with its own login — rather than by the API
(**Settings… → Chat → Answered by**). Coucou never sees a credential: it starts
`claude` headless in a **hub folder** (by default `Documents\GitHub\hub`), whose
`CLAUDE.md` tells it about your projects, and lets it read the folders you list
(by default all of `Documents\GitHub`) and search the web — no commands, no file
edits, nothing to approve, and none of the files that hold secrets or clients'
data (`.env`, credentials, keys, database dumps, `datos/` folders), which Claude
Code itself refuses to read. One process serves the whole chat: it starts with
your first message, answers the next ones in about two seconds, and goes away
with **+** (a new conversation) or when Coucou quits. Details and the reasons in
`src-tauri/src/chat_cc.rs`.

**Ctrl+V** of an image in the chat's field — a screenshot, an image copied from a
page or from Explorer — saves it into the inbox (`%LOCALAPPDATA%\Coucou\inbox`,
as `pegada-<date>-<time>.png`), shows it as the chat's chip, and sends it with
your next message, mid-conversation or not; Claude Code reads it like a file
dropped on the island. PNG, JPEG, GIF and WebP, up to 25 MB; anything else pastes
as text. One image per message: a second paste before sending replaces the first.

With **Anthropic API key** instead, **Settings… → Chat** takes your key. Keys
live in the **Windows Credential Manager**, never on disk and never in the
interface — the island can only ask whether a key exists. Same for every
integration key.

No telemetry. The only network requests Coucou makes are to the services you
configure yourself.

## Build it yourself

You need [Rust](https://rustup.rs), [Node 20+](https://nodejs.org), and the
**MSVC build tools** (Visual Studio Build Tools with "Desktop development with
C++"). WebView2 ships with Windows 10/11.

```powershell
cd windows
npm install
npm run tauri dev      # live-reloading development build
npm run pack           # builds the installer and drops it in windows/release/
```

`npm run dev` alone serves the front end in an ordinary browser, which is enough
to work on the island's looks. It also serves `dev/upload-preview.html`, which
replays the whole file-drop choreography on a loop — the one part of the UI that
otherwise needs a real drag from Explorer to see. Neither page ships in the app.

`npm run pack` leaves two files in `windows/release/`, the same names the release
workflow publishes:

```
Coucou-Windows-X.Y.Z-setup.exe    the versioned installer
Coucou-Windows-setup.exe          the same file under the rolling name
```

Installing is optional — `target/release/coucou.exe` runs on its own. There is no
window in the taskbar and no console: the island at the top of the screen and the
Mochi in the notification area are the whole app, and Quit lives in its menu.

The 28 sounds are the macOS app's own files; they are never duplicated in this
folder. The path is declared once, in `SOUNDS_DIR` at the top of
`vite.config.ts` — when they move to `shared/sounds/`, change that one line.

The app icon and the tray icon are drawn in code, like Mochi itself:

```powershell
npm run icons          # regenerates src-tauri/icons from scripts/gen-icons.mjs
```

### Tests

```powershell
npm test               # Rust and TypeScript unit tests
npm run test:e2e       # the real relay, app and island, driven over CDP
```

Both are safe to run with Coucou installed and running: the end-to-end suite
runs its own isolated instance (`COUCOU_INSTANCE`). See [TESTING.md](TESTING.md).

### Layout

```
windows/
  src/                 island front end (TypeScript, no framework)
    mochi/             Mochi and the launch greeting, in Canvas 2D
    island/            state machine, hooks, integrations
    views/             every island view
    settings/          the settings window
  src-tauri/           Rust backend: window, named pipe, Claude API, pollers
  hook/                coucou-hook.exe, the Claude Code relay
  vscode-extension/    the companion VS Code extension (terminal focus),
                       packaged into the app by scripts/build-extension.mjs
  tests/               unit, end-to-end and real-input tests (TESTING.md)
  scripts/             icon generator, extension packaging, installer copy
```

### Log

`%LOCALAPPDATA%\Coucou\coucou.log` — hook events (tagged `wsl=<distro>` for
sessions inside WSL), permission decisions, what each ↗ did (`terminal "<tab>"
focused`, `no extension answered`, which window came forward), poller
problems, and every time the island's page goes hidden or visible for WebView2
(`ui  visibility hidden` / `ui  visibility visible` — a diagnostic for an
island that stops being drawn). It stays on your machine.

## What's different from the Mac version

- No notch, so the island lives at the top of the screen — centred until you
  drag it along the top edge — and retracts into the edge instead of hiding in
  a notch.
- Permission approval works from **any** terminal; the Mac build only listens to
  VS Code sessions.
- Jumping to a session's terminal goes through VS Code only (its window, and
  with the companion extension its exact tab); sessions in other terminals are
  shown and approved like any other, but ↗ opens their folder in VS Code.
- Not in this version: sending a file by email, and dragging Mochi onto a
  window to attach it as context.
- Cal.com shows the next bookings as a list rather than the Mac's calendar.
