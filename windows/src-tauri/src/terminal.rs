// "Take me to the exact terminal": when the user clicks a session's ↗, bring
// forward the terminal tab that session runs in, not just its VS Code window.
//
// VS Code has no command line for that, so a small companion extension
// (windows/vscode-extension, installed from Settings → Claude Code) serves one
// named pipe per VS Code window and answers "is the terminal whose shell has
// one of these PIDs yours?" — showing it when it is. This file is the app's
// half:
//
//   1. Remember (`Terminals`). The relay forwards, with every hook event, its
//      own Windows ancestry (`ancestor_pids`, hook/src/procs.rs) and, from
//      inside WSL, the Linux PID of Claude Code (`wsl_ppid`). pipe.rs hands
//      each event here; the latest per session is kept in memory — bounded,
//      dropped on SessionEnd — and never reaches the island.
//   2. On a click, for a WSL session, expand `wsl_ppid` into its Linux
//      ancestry by reading /proc inside the distro (`wsl_chain`). Interop
//      hides Linux processes from Windows, so the relay cannot do it, and doing
//      it at click time costs nothing on the hook's hot path.
//   3. Ask every extension pipe this user serves (`coucou-vscode-*`, named per
//      instance like the relay pipe) at once, each under its own deadline. The
//      one window whose terminal matches shows it, and says which window it is
//      (`vscode.workspace.name`, which is the title's root name), so vscode.rs
//      raises that window rather than guessing from the folder.
//
// Nothing here can make "Open" worse than before: no hint, no pipe, no answer
// or no match all mean the window step runs exactly as it always has.

use std::collections::HashMap;
use std::os::windows::io::AsRawHandle;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeClient};
use windows::Win32::Foundation::HANDLE;

use crate::{ancestry, instance, log, win, wsl};

/// Sessions remembered at once. Far more than anyone runs; the least recently
/// heard from goes first.
const MAX_SESSIONS: usize = 64;
/// PIDs kept per chain (the relay sends at most ancestry::MAX_DEPTH).
const MAX_PIDS: usize = 32;
/// One extension's whole exchange: connect, check, ask, read the answer. The
/// extension gives each terminal half a second to report its PID.
const ASK_TIMEOUT: Duration = Duration::from_millis(1_500);
/// Reading the Linux chain on a click: a running distro answers in a few
/// hundred milliseconds; past this the window step goes ahead without it.
const WSL_CHAIN_BUDGET: Duration = Duration::from_secs(3);
/// An answer is a short JSON line.
const MAX_REPLY: usize = 4_096;
/// `ERROR_PIPE_BUSY`: every instance of the pipe is serving someone right now.
const ERROR_PIPE_BUSY: i32 = 231;

// ── What the relay told us, per session ───────────────────────────────────────

/// Where a session's terminal can be found.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Hint {
    /// The relay's Windows ancestors, nearest first.
    pub windows: Vec<u32>,
    /// For a session inside WSL: its distro and Claude Code's Linux PID.
    pub wsl: Option<WslHint>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct WslHint {
    pub distro: String,
    pub ppid: u32,
}

fn session_id(payload: &Value) -> Option<&str> {
    let id = payload.get("session_id")?.as_str()?.trim();
    (!id.is_empty() && id.len() <= 256).then_some(id)
}

/// The session and the hint an event carries; `None` when it carries none (an
/// older relay, or no session id). Anything malformed is left out, never
/// trusted: PIDs must be positive 32-bit numbers, a distro a valid name, a
/// Linux PID within Linux's limit.
pub fn hint_of(payload: &Value) -> Option<(String, Hint)> {
    let id = session_id(payload)?;
    let windows: Vec<u32> = payload
        .get("ancestor_pids")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(Value::as_u64)
                .filter_map(|n| u32::try_from(n).ok())
                .filter(|n| *n > 0)
                .take(MAX_PIDS)
                .collect()
        })
        .unwrap_or_default();
    let distro = payload.get("wsl_distro").and_then(Value::as_str).filter(|d| wsl::is_valid_distro_name(d));
    let ppid = payload
        .get("wsl_ppid")
        .and_then(Value::as_u64)
        .filter(|p| (1..=ancestry::MAX_LINUX_PID as u64).contains(p));
    let wsl = match (distro, ppid) {
        (Some(distro), Some(ppid)) => Some(WslHint { distro: distro.to_string(), ppid: ppid as u32 }),
        _ => None,
    };
    if windows.is_empty() && wsl.is_none() {
        return None;
    }
    Some((id.to_string(), Hint { windows, wsl }))
}

/// The relay's terminal fields are the app's business; the island never sees them.
pub fn strip(payload: &mut Value) {
    if let Some(map) = payload.as_object_mut() {
        map.remove("ancestor_pids");
        map.remove("wsl_ppid");
    }
}

/// session id → latest hint, in memory only.
#[derive(Default)]
pub struct Terminals(Mutex<Book>);

#[derive(Default)]
struct Book {
    sessions: HashMap<String, (u64, Hint)>,
    clock: u64,
}

impl Book {
    fn observe(&mut self, event: &str, payload: &Value) {
        if event == "SessionEnd" {
            if let Some(id) = session_id(payload) {
                self.sessions.remove(id);
            }
            return;
        }
        // An event without a hint (an older relay) leaves the last one alone.
        let Some((id, hint)) = hint_of(payload) else { return };
        self.clock += 1;
        if !self.sessions.contains_key(&id) && self.sessions.len() >= MAX_SESSIONS {
            let oldest = self.sessions.iter().min_by_key(|(_, (at, _))| *at).map(|(k, _)| k.clone());
            if let Some(oldest) = oldest {
                self.sessions.remove(&oldest);
            }
        }
        self.sessions.insert(id, (self.clock, hint));
    }
}

impl Terminals {
    /// Every hook event goes through here (pipe.rs).
    pub fn observe(&self, event: &str, payload: &Value) {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).observe(event, payload);
    }

    pub fn hint(&self, session_id: &str) -> Option<Hint> {
        let book = self.0.lock().unwrap_or_else(|e| e.into_inner());
        book.sessions.get(session_id.trim()).map(|(_, hint)| hint.clone())
    }
}

// ── Linux processes, from /proc ───────────────────────────────────────────────

/// One `/proc/<pid>/stat` line, as much as the walk needs.
#[derive(Debug, Clone, PartialEq)]
pub struct Stat {
    pub pid: u32,
    pub ppid: u32,
    /// Field 22, `starttime`: clock ticks after boot.
    pub start: u64,
}

/// `pid (comm) state ppid … starttime …`. The command name is the one free-form
/// field: up to 15 bytes of anything, spaces and parentheses included
/// (`(Relay(983))`, `(tmux: server)`), so it ends at the *last* `)` — nothing
/// after it can contain one. `None` for anything that does not have that shape.
pub fn parse_stat(line: &str) -> Option<Stat> {
    let open = line.find(" (")?;
    let close = line.rfind(')')?;
    if close < open + 1 {
        return None;
    }
    let pid = line[..open].trim().parse::<u32>().ok()?;
    let fields: Vec<&str> = line[close + 1..].split_whitespace().collect();
    // fields[0] is field 3 (state), so field N is fields[N - 3].
    if fields.len() < 20 {
        return None;
    }
    Some(Stat { pid, ppid: fields[1].parse().ok()?, start: fields[19].parse().ok()? })
}

/// `start` and its ancestors, nearest first, from a dump of every
/// `/proc/<pid>/stat`. Empty when `start` is not in it (Claude Code has exited).
/// Like the relay's Windows walk, a "parent" that started after its child is a
/// stranger reusing the PID, and the walk stops there.
pub fn linux_chain(dump: &str, start: u32) -> Vec<u32> {
    let table: HashMap<u32, Stat> = dump.lines().filter_map(parse_stat).map(|s| (s.pid, s)).collect();
    if !table.contains_key(&start) {
        return Vec::new();
    }
    let mut chain = vec![start];
    chain.extend(ancestry::ancestors(start, ancestry::MAX_DEPTH, |child| {
        let child = table.get(&child)?;
        let parent = table.get(&child.ppid)?;
        (parent.start <= child.start).then_some(parent.pid)
    }));
    chain
}

/// Claude Code's Linux ancestry inside `distro`. Never starts a distro: one
/// that is not running has no session left to find.
fn wsl_chain(distro: &str, ppid: u32) -> Result<Vec<u32>, String> {
    if !wsl::is_valid_distro_name(distro) {
        return Err("not a WSL distro name".into());
    }
    if !wsl::running_within(WSL_CHAIN_BUDGET)?.iter().any(|d| d.eq_ignore_ascii_case(distro)) {
        return Err(format!("{distro} is not running"));
    }
    let chain = linux_chain(&wsl::proc_stats(distro, WSL_CHAIN_BUDGET)?, ppid);
    if chain.is_empty() {
        return Err(format!("process {ppid} is gone from {distro}"));
    }
    Ok(chain)
}

// ── The extension's pipes ─────────────────────────────────────────────────────

/// `coucou-vscode-`, or `coucou-<instance>-vscode-` for a side instance — the
/// same rule as the extension's server.ts, so a side instance only ever talks
/// to VS Code windows started with its own COUCOU_INSTANCE.
pub fn pipe_prefix_for(instance: Option<&str>) -> String {
    format!("coucou{}-vscode-", instance::suffix_for(instance, '-'))
}

/// `<prefix><pid>-<token>`: the extension host's PID and 8–64 lowercase hex
/// digits. Strict, so no other pipe — the relay's `coucou-<sid>`, another
/// instance's extension pipes — can ever be mistaken for one.
pub fn is_extension_pipe(name: &str, prefix: &str) -> bool {
    let Some(rest) = name.strip_prefix(prefix) else { return false };
    let Some((pid, token)) = rest.split_once('-') else { return false };
    (1..=10).contains(&pid.len())
        && pid.bytes().all(|b| b.is_ascii_digit())
        && (8..=64).contains(&token.len())
        && token.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Every extension pipe that exists right now, as full paths. Listing the pipe
/// namespace never connects to anything.
fn extension_pipes() -> Vec<String> {
    let prefix = pipe_prefix_for(instance::current().ok().flatten().as_deref());
    let Ok(entries) = std::fs::read_dir(r"\\.\pipe\") else { return Vec::new() };
    let mut pipes: Vec<String> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|name| is_extension_pipe(name, &prefix))
        .map(|name| format!(r"\\.\pipe\{name}"))
        .collect();
    pipes.sort();
    pipes.dedup();
    pipes
}

/// The request line (see server.ts), or `None` when there is nothing to ask.
pub fn request_line(windows: &[u32], linux: Option<(&str, &[u32])>) -> Option<String> {
    let linux = linux.filter(|(_, pids)| !pids.is_empty());
    if windows.is_empty() && linux.is_none() {
        return None;
    }
    let wsl = linux.map(|(distro, pids)| json!({ "distro": distro, "pids": pids }));
    Some(format!("{}\n", json!({ "v": 1, "pids": windows, "wsl": wsl })))
}

/// What one extension said.
#[derive(Debug, Clone, PartialEq)]
pub enum Reply {
    Matched { terminal: String, window: Option<String> },
    NoMatch,
}

/// Text from another process: printable, and short.
fn clean(text: &str) -> String {
    text.chars().filter(|c| !c.is_control()).take(200).collect()
}

/// The first line of an answer. Anything that is not `{"matched": …}` is not one.
pub fn parse_reply(text: &str) -> Option<Reply> {
    let line = text.split('\n').next()?.trim();
    let value: Value = serde_json::from_str(line).ok()?;
    match value.get("matched")?.as_bool()? {
        false => Some(Reply::NoMatch),
        true => Some(Reply::Matched {
            terminal: clean(value.get("terminal").and_then(Value::as_str).unwrap_or("")),
            window: value.get("window").and_then(Value::as_str).map(clean).filter(|w| !w.is_empty()),
        }),
    }
}

async fn connect(pipe: &str) -> Result<NamedPipeClient, String> {
    loop {
        match ClientOptions::new().open(pipe) {
            Ok(client) => return Ok(client),
            // Busy is the one error worth waiting out; the caller's deadline bounds it.
            Err(err) if err.raw_os_error() == Some(ERROR_PIPE_BUSY) => {
                tokio::time::sleep(Duration::from_millis(20)).await
            }
            Err(err) => return Err(err.to_string()),
        }
    }
}

/// One extension, one question.
async fn ask(pipe: &str, line: &str) -> Result<Reply, String> {
    let mut client = connect(pipe).await?;
    // Anyone can create a pipe with this name; only one of ours gets the PIDs.
    if !win::pipe_server_is_same_user(HANDLE(client.as_raw_handle())) {
        return Err("served by another account".into());
    }
    client.write_all(line.as_bytes()).await.map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        let n = client.read(&mut chunk).await.map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
        if buf.contains(&b'\n') || buf.len() > MAX_REPLY {
            break;
        }
    }
    parse_reply(&String::from_utf8_lossy(&buf)).ok_or_else(|| "not an answer".into())
}

/// A terminal some window showed, and the window it is in.
#[derive(Debug, Clone, PartialEq)]
pub struct Shown {
    pub terminal: String,
    /// `vscode.workspace.name` — the title's root name; `None` for a window
    /// without a folder.
    pub window: Option<String>,
}

/// Steps 2 and 3 of the header: finds the session's terminal and has its window
/// show it. Logs what happened; `None` means the window step carries on as
/// before. Never blocks the caller's thread, and every wait is bounded.
pub async fn show_terminal(hint: Option<Hint>, kind: &str) -> Option<Shown> {
    let started = Instant::now();
    let Some(hint) = hint else {
        log::line(format!("open session ({kind}): no terminal recorded for it"));
        return None;
    };

    let mut linux: Option<(String, Vec<u32>)> = None;
    if let Some(WslHint { distro, ppid }) = hint.wsl.clone() {
        let lookup = tauri::async_runtime::spawn_blocking({
            let distro = distro.clone();
            move || wsl_chain(&distro, ppid)
        });
        match tokio::time::timeout(WSL_CHAIN_BUDGET, lookup).await {
            Ok(Ok(Ok(chain))) => linux = Some((distro, chain)),
            Ok(Ok(Err(why))) => log::line(format!("open session ({kind}): no Linux ancestry — {why}")),
            Ok(Err(err)) => log::line(format!("open session ({kind}): no Linux ancestry — {err}")),
            Err(_) => log::line(format!("open session ({kind}): no Linux ancestry — WSL did not answer in time")),
        }
    }

    let Some(line) = request_line(&hint.windows, linux.as_ref().map(|(d, p)| (d.as_str(), p.as_slice()))) else {
        log::line(format!("open session ({kind}): nothing to ask the extension"));
        return None;
    };
    let pipes = extension_pipes();
    if pipes.is_empty() {
        log::line(format!("open session ({kind}): no extension answered — no VS Code window serves one"));
        return None;
    }

    let mut asks = tokio::task::JoinSet::new();
    for pipe in pipes.iter().cloned() {
        let line = line.clone();
        asks.spawn(async move {
            tokio::time::timeout(ASK_TIMEOUT, ask(&pipe, &line))
                .await
                .unwrap_or_else(|_| Err("timed out".into()))
        });
    }
    let (mut answered, mut shown, mut errors) = (0usize, Vec::<Shown>::new(), Vec::<String>::new());
    while let Some(result) = asks.join_next().await {
        match result {
            Ok(Ok(reply)) => {
                answered += 1;
                if let Reply::Matched { terminal, window } = reply {
                    shown.push(Shown { terminal, window });
                }
            }
            Ok(Err(why)) => errors.push(why),
            Err(err) => errors.push(err.to_string()),
        }
    }
    errors.sort();
    errors.dedup();

    let took = started.elapsed().as_millis();
    let asked = pipes.len();
    let Some(first) = shown.first().cloned() else {
        log::line(if answered == 0 {
            format!("open session ({kind}): no extension answered ({asked} asked: {}; {took} ms)", errors.join("; "))
        } else {
            format!("open session ({kind}): {answered} of {asked} VS Code window(s) answered; none has its terminal ({took} ms)")
        });
        return None;
    };
    let window = first.window.as_deref().map(|w| format!(" in \"{w}\"")).unwrap_or_default();
    log::line(format!("open session ({kind}): terminal \"{}\" focused{window} ({took} ms)", first.terminal));
    if shown.len() > 1 {
        // A PID shared by two live terminals cannot happen; say so if it does.
        log::line(format!("open session ({kind}): {} windows claimed the terminal; raising the first", shown.len()));
    }
    Some(first)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hints_are_read_from_what_the_relay_forwards() {
        let windows = json!({ "session_id": " s1 ", "ancestor_pids": [40, 30, 20] });
        assert_eq!(hint_of(&windows), Some(("s1".into(), Hint { windows: vec![40, 30, 20], wsl: None })));

        let wsl = json!({
            "session_id": "s2", "ancestor_pids": [43468], "wsl_distro": "Ubuntu-24.04", "wsl_ppid": 79609
        });
        assert_eq!(
            hint_of(&wsl),
            Some((
                "s2".into(),
                Hint { windows: vec![43468], wsl: Some(WslHint { distro: "Ubuntu-24.04".into(), ppid: 79609 }) }
            ))
        );
        // A WSL session from an older install (no --wsl-ppid) still has its Windows chain.
        let old = json!({ "session_id": "s3", "ancestor_pids": [1], "wsl_distro": "Ubuntu-24.04" });
        assert_eq!(hint_of(&old).unwrap().1.wsl, None);
    }

    #[test]
    fn malformed_hints_are_dropped_not_trusted() {
        // No session, or nothing measured: nothing to remember.
        assert_eq!(hint_of(&json!({ "ancestor_pids": [1, 2] })), None);
        assert_eq!(hint_of(&json!({ "session_id": "", "ancestor_pids": [1] })), None);
        assert_eq!(hint_of(&json!({ "session_id": "s" })), None);
        assert_eq!(hint_of(&json!({ "session_id": "s", "ancestor_pids": [] })), None);
        // Non-numbers, negatives, zero and anything past 32 bits are left out.
        let mixed = json!({ "session_id": "s", "ancestor_pids": [5, "6", -7, 0, 4294967296u64, 1.5, null, 8] });
        assert_eq!(hint_of(&mixed).unwrap().1.windows, [5, 8]);
        assert_eq!(hint_of(&json!({ "session_id": "s", "ancestor_pids": "1,2" })), None);
        // At most MAX_PIDS of them.
        let long: Vec<u32> = (1..=100).collect();
        assert_eq!(hint_of(&json!({ "session_id": "s", "ancestor_pids": long })).unwrap().1.windows.len(), MAX_PIDS);
        // A WSL hint needs a real distro name and a Linux PID.
        for (distro, ppid) in [
            (json!("bad name"), json!(5)),
            (json!("x;rm -rf ~"), json!(5)),
            (json!("Ubuntu"), json!(0)),
            (json!("Ubuntu"), json!(4_194_305)),
            (json!("Ubuntu"), json!("5")),
            (json!(null), json!(5)),
        ] {
            let p = json!({ "session_id": "s", "wsl_distro": distro, "wsl_ppid": ppid });
            assert_eq!(hint_of(&p), None, "{p}");
        }
    }

    #[test]
    fn the_island_never_sees_the_terminal_fields() {
        let mut p = json!({ "session_id": "s", "cwd": "C:\\p", "ancestor_pids": [1], "wsl_ppid": 2, "wsl_distro": "U" });
        strip(&mut p);
        assert_eq!(p, json!({ "session_id": "s", "cwd": "C:\\p", "wsl_distro": "U" }));
    }

    #[test]
    fn the_book_keeps_the_latest_hint_and_forgets_on_session_end() {
        let book = Terminals::default();
        book.observe("PreToolUse", &json!({ "session_id": "a", "ancestor_pids": [1, 2] }));
        book.observe("PreToolUse", &json!({ "session_id": "a", "ancestor_pids": [3, 4] }));
        assert_eq!(book.hint("a").unwrap().windows, [3, 4]);
        // An event without a hint (an older relay) leaves it alone.
        book.observe("Stop", &json!({ "session_id": "a" }));
        assert_eq!(book.hint("a").unwrap().windows, [3, 4]);
        // SessionEnd drops it, with or without a hint of its own.
        book.observe("SessionEnd", &json!({ "session_id": "a", "ancestor_pids": [9] }));
        assert_eq!(book.hint("a"), None);
        assert_eq!(book.hint("never-seen"), None);
    }

    #[test]
    fn the_book_is_bounded_and_drops_the_least_recently_heard_from() {
        let book = Terminals::default();
        for i in 0..MAX_SESSIONS {
            book.observe("PreToolUse", &json!({ "session_id": format!("s{i}"), "ancestor_pids": [i + 1] }));
        }
        // s0 speaks again, so s1 is now the oldest.
        book.observe("PreToolUse", &json!({ "session_id": "s0", "ancestor_pids": [100] }));
        book.observe("PreToolUse", &json!({ "session_id": "new", "ancestor_pids": [7] }));
        assert_eq!(book.0.lock().unwrap().sessions.len(), MAX_SESSIONS);
        assert!(book.hint("s1").is_none());
        assert_eq!(book.hint("s0").unwrap().windows, [100]);
        assert_eq!(book.hint("new").unwrap().windows, [7]);
    }

    #[test]
    fn proc_stat_lines_are_parsed_whatever_the_command_name() {
        // As read on the machine this was written on, Ubuntu-24.04 under WSL 2.
        let sh = "50132 (sh) S 50128 50132 50132 34827 50132 4194560 210 0 0 0 0 0 0 0 20 0 1 0 1644035 2871296 432 18446744073709551615 97908439678976 97908439762973 140734227392384 0 0 0 0 0 65538 1 0 0 17 16 0 0 0 0 0 97908439789008 97908439794208 97909465460736 140734227400270 140734227400405 140734227400405 140734227402736 0";
        assert_eq!(parse_stat(sh), Some(Stat { pid: 50132, ppid: 50128, start: 1644035 }));
        let relay = "50128 (Relay(50132)) S 50126 50126 50126 0 -1 4194624 33 0 0 0 0 0 0 0 20 0 1 0 1644034 3219456 240 18446744073709551615 1 1 0 0 0 0 65536 2147024638 65536 0 0 0 17 18 0 0 0 0 0 0 0 0 0 0 0 0 0";
        assert_eq!(parse_stat(relay), Some(Stat { pid: 50128, ppid: 50126, start: 1644034 }));
        // Spaces, a closing parenthesis and digits inside the name.
        let tail = "S 7 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 999 0 0";
        for comm in ["tmux: server", "a) S 1 2 3", "((x))", ") (", "node 1 2", ""] {
            let line = format!("42 ({comm}) {tail}");
            assert_eq!(parse_stat(&line), Some(Stat { pid: 42, ppid: 7, start: 999 }), "{line}");
        }
        // Not stat lines.
        for bad in [
            "",
            "42",
            "42 (x)",
            "x (sh) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 5",
            "42 (sh) S x 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 5",
            "42 (sh) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0",
            "42 (sh) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 -5",
            "42 sh) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 5",
        ] {
            assert_eq!(parse_stat(bad), None, "{bad:?}");
        }
    }

    fn stat(pid: u32, comm: &str, ppid: u32, start: u64) -> String {
        format!("{pid} ({comm}) S {ppid} 0 0 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 {start} 0 0\n")
    }

    #[test]
    fn the_linux_chain_runs_from_claude_up_to_init() {
        // The shape of a Remote-WSL terminal: claude → bash (the terminal's
        // shell) → VS Code server's pty host → server → … → init.
        let dump = [
            stat(1, "systemd", 0, 1),
            stat(2, "init-systemd(Ub", 1, 2),
            stat(982, "SessionLeader", 2, 100),
            stat(983, "Relay(984)", 982, 100),
            stat(995, "MainThread", 983, 110),
            stat(1371, "MainThread", 995, 120),
            stat(2057, "bash", 1371, 200),
            stat(79609, "claude", 2057, 300),
            stat(5000, "unrelated", 1, 50),
            "garbage line\n".into(),
        ]
        .concat();
        assert_eq!(linux_chain(&dump, 79609), [79609, 2057, 1371, 995, 983, 982, 2, 1]);
        // Claude Code gone: nothing, rather than a guess.
        assert_eq!(linux_chain(&dump, 4242), Vec::<u32>::new());
        assert_eq!(linux_chain("", 1), Vec::<u32>::new());
    }

    #[test]
    fn the_linux_chain_stops_at_a_reused_pid_or_a_loop() {
        // 2057 exited and its PID went to a newer process: its start is later.
        let reused = [stat(79609, "claude", 2057, 300), stat(2057, "newcomer", 1, 400), stat(1, "init", 0, 1)].concat();
        assert_eq!(linux_chain(&reused, 79609), [79609]);
        // A loop in a corrupt dump ends.
        let looped = [stat(10, "a", 11, 5), stat(11, "b", 10, 5)].concat();
        assert_eq!(linux_chain(&looped, 10), [10, 11]);
    }

    #[test]
    fn extension_pipes_are_named_per_instance_and_nothing_else_matches() {
        let real = pipe_prefix_for(None);
        let side = pipe_prefix_for(Some("ext"));
        assert_eq!(real, "coucou-vscode-");
        assert_eq!(side, "coucou-ext-vscode-");
        let token = "0123456789abcdef";
        assert!(is_extension_pipe(&format!("coucou-vscode-1234-{token}"), &real));
        assert!(is_extension_pipe(&format!("coucou-ext-vscode-1234-{token}"), &side));
        // Never each other's.
        assert!(!is_extension_pipe(&format!("coucou-ext-vscode-1234-{token}"), &real));
        assert!(!is_extension_pipe(&format!("coucou-vscode-1234-{token}"), &side));
        // An instance called "vscode" cannot pass for the real one either way.
        let odd = pipe_prefix_for(Some("vscode"));
        assert!(!is_extension_pipe(&format!("coucou-vscode-vscode-1234-{token}"), &real));
        assert!(!is_extension_pipe(&format!("coucou-vscode-1234-{token}"), &odd));
        // The relay's own pipe, and look-alikes.
        for name in [
            "coucou-S-1-5-21-1111-2222-3333-1001",
            "coucou-vscode-S-1-5-21-1111-2222-3333-1001",
            "coucou-vscode-",
            "coucou-vscode-1234",
            "coucou-vscode-1234-",
            "coucou-vscode--0123456789abcdef",
            "coucou-vscode-12a4-0123456789abcdef",
            "coucou-vscode-1234-0123456789ABCDEF",
            "coucou-vscode-1234-0123456",
            "coucou-vscode-1234-0123456789abcdef-x",
            "coucou-vscode-12345678901-0123456789abcdef",
            "xcoucou-vscode-1234-0123456789abcdef",
        ] {
            assert!(!is_extension_pipe(name, &real), "{name}");
        }
    }

    #[test]
    fn the_request_carries_both_chains_and_nothing_when_empty() {
        assert_eq!(request_line(&[], None), None);
        assert_eq!(request_line(&[], Some(("Ubuntu", &[]))), None);
        let windows = request_line(&[40, 30], None).unwrap();
        assert!(windows.ends_with('\n') && windows.matches('\n').count() == 1);
        assert_eq!(serde_json::from_str::<Value>(&windows).unwrap(), json!({ "v": 1, "pids": [40, 30], "wsl": null }));
        let both = request_line(&[43468], Some(("Ubuntu-24.04", &[79609, 2057]))).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&both).unwrap(),
            json!({ "v": 1, "pids": [43468], "wsl": { "distro": "Ubuntu-24.04", "pids": [79609, 2057] } })
        );
        let linux_only = request_line(&[], Some(("Ubuntu-24.04", &[5]))).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&linux_only).unwrap()["pids"], json!([]));
    }

    #[test]
    fn replies_are_parsed_strictly_and_cleaned() {
        assert_eq!(
            parse_reply("{\"matched\":true,\"terminal\":\"pwsh\",\"window\":\"panita\"}\n"),
            Some(Reply::Matched { terminal: "pwsh".into(), window: Some("panita".into()) })
        );
        assert_eq!(
            parse_reply(r#"{"matched":true,"terminal":"bash","window":null}"#),
            Some(Reply::Matched { terminal: "bash".into(), window: None })
        );
        assert_eq!(parse_reply(r#"{"matched":false}"#), Some(Reply::NoMatch));
        assert_eq!(parse_reply(r#"{"matched":false,"error":"not JSON"}"#), Some(Reply::NoMatch));
        // Control characters never reach the log or the title match.
        assert_eq!(
            parse_reply("{\"matched\":true,\"terminal\":\"a\\u001b[2Jb\\nc\",\"window\":\"\\u0007\"}"),
            Some(Reply::Matched { terminal: "a[2Jbc".into(), window: None })
        );
        for bad in ["", "null", "[]", "{}", r#"{"matched":"yes"}"#, "not json", "{\"matched\":tru"] {
            assert_eq!(parse_reply(bad), None, "{bad:?}");
        }
    }
}
