//! coucou-hook — the relay Claude Code runs on every hook event.
//!
//! Reads the hook JSON on stdin, adds a little terminal context, and hands it to
//! Coucou over the named pipe `\\.\pipe\coucou-<sid>`.
//!
//! Hard rule (docs/CLAUDE.md): **never block Claude Code.**
//! * If the pipe does not exist — Coucou is closed — we exit 0 immediately with
//!   nothing on stdout, and the session carries on untouched.
//! * Every step runs under a deadline enforced by the main thread, so a pipe that
//!   accepts the connection and then stops reading cannot wedge the session
//!   either: we abandon the worker and exit.
//! * Only `PermissionRequest` waits for an answer, because approving from the
//!   island is the whole point. No answer means empty stdout, and Claude Code
//!   asks in the terminal exactly as if Coucou were not installed.
//!
//! Usage: `coucou-hook <EventName> [--wsl-distro <name>]` (the event name is
//! also read from the JSON).
//!
//! `--wsl-distro` is how a Claude Code session running *inside WSL* says so: the
//! hook command installed in a distro's `~/.claude/settings.json` ends with
//! `--wsl-distro "$WSL_DISTRO_NAME"`, which the Linux shell expands before this
//! Windows executable starts. It has to be an argument: WSL interop hands a
//! Windows process only the Linux variables listed in `WSLENV`, so the relay
//! cannot read `$WSL_DISTRO_NAME` itself. It is forwarded as `wsl_distro`;
//! Windows sessions have no such field.
//!
//! With `COUCOU_INSTANCE=<name>` in the environment the relay talks to that
//! side instance instead of the real app — see instance.rs.

use std::io::{Read, Write};
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// Budget for getting a pipe connection. Beyond this Claude Code wins, always.
const CONNECT_TIMEOUT: Duration = Duration::from_millis(300);
/// Whole-run budget for an event nobody waits on: connect and write, no more.
const FIRE_AND_FORGET_BUDGET: Duration = Duration::from_secs(2);
/// How long a permission prompt may stay on screen before the terminal takes over.
const DECISION_BUDGET: Duration = Duration::from_secs(110);

/// `ERROR_PIPE_BUSY` — every instance is serving someone else right now. This is
/// the one error worth retrying: the server exists and a slot will free up.
const ERROR_PIPE_BUSY: i32 = 231;

/// Fields that are pointless to forward and can be enormous (a whole file read,
/// a full command output). The island never shows them.
const DROPPED_FIELDS: &[&str] = &["tool_response", "transcript_path"];
/// Longest string forwarded for any single field; the island truncates to far
/// less than this anyway.
const MAX_FIELD_LEN: usize = 2_000;

mod instance;
mod win;

/// `\\.\pipe\coucou-<sid>` (or `coucou-<instance>-<sid>`, see instance.rs). The
/// SID keeps two accounts on the same machine from ever meeting on the same
/// pipe; the name falls back to the user name only if the SID cannot be read at
/// all, which should not happen.
fn pipe_path() -> String {
    let key = win::current_user_sid()
        .unwrap_or_else(|| std::env::var("USERNAME").unwrap_or_else(|_| "user".into()));
    instance::pipe_name(&key)
}

/// Opens the pipe. Retries only while the server is busy: any other error means
/// there is nothing to talk to, and waiting would only delay Claude Code.
fn connect() -> Option<std::fs::File> {
    use std::os::windows::io::AsRawHandle;
    let path = pipe_path();
    let deadline = Instant::now() + CONNECT_TIMEOUT;
    loop {
        match std::fs::OpenOptions::new().read(true).write(true).open(&path) {
            Ok(file) => {
                let handle = windows::Win32::Foundation::HANDLE(file.as_raw_handle());
                // Somebody else's server on our pipe name gets nothing from us.
                return win::pipe_server_is_same_user(handle).then_some(file);
            }
            Err(err) => {
                if err.raw_os_error() != Some(ERROR_PIPE_BUSY) || Instant::now() >= deadline {
                    return None;
                }
                std::thread::sleep(Duration::from_millis(15));
            }
        }
    }
}

fn main() {
    // A COUCOU_INSTANCE we cannot use means somebody meant a side instance; the
    // one thing we must not do is fall back to the real app. Say nothing instead.
    if instance::current().is_err() {
        std::process::exit(0);
    }
    // args_os, not args: `std::env::args` panics on an argument that is not
    // valid Unicode, and a panic here is a failed hook in Claude Code.
    let args = parse_args(std::env::args_os().skip(1).map(|a| a.to_string_lossy().into_owned()));
    let Some((payload, event)) = read_event(&args) else { std::process::exit(0) };

    let waits_for_answer = event == "PermissionRequest";
    let budget = if waits_for_answer { DECISION_BUDGET } else { FIRE_AND_FORGET_BUDGET };

    // The worker owns every blocking call. If it overruns the budget we simply
    // stop listening and exit: the process dying takes the pipe handle with it.
    // (No catch_unwind here — the release profile is panic = "abort", so it would
    // be dead code. `talk` is written to have nothing to panic on instead.)
    let (tx, rx) = mpsc::channel::<Option<String>>();
    std::thread::spawn(move || {
        let _ = tx.send(talk(&payload, waits_for_answer));
    });

    if let Ok(Some(decision)) = rx.recv_timeout(budget) {
        if let Some(json) = decision_json(&decision) {
            let mut out = std::io::stdout();
            let _ = writeln!(out, "{json}");
            let _ = out.flush();
        }
    }
    // Nothing printed: Claude Code asks in the terminal, as if we were not here.
    std::process::exit(0);
}

/// The documented PermissionRequest output. Anything we do not recognise prints
/// nothing at all rather than guessing — silence is the safe answer.
/// See https://code.claude.com/docs/en/hooks
fn decision_json(decision: &str) -> Option<String> {
    let behavior = match decision.trim() {
        // "always" still answers a plain allow; remembering it is the island's
        // business, not Claude Code's.
        "allow" | "always" => r#"{"behavior":"allow"}"#.to_string(),
        "deny" => r#"{"behavior":"deny","message":"Denied from Coucou"}"#.to_string(),
        _ => return None,
    };
    Some(format!(
        r#"{{"hookSpecificOutput":{{"hookEventName":"PermissionRequest","decision":{behavior}}}}}"#
    ))
}

/// What the hook command line says, beyond the JSON on stdin.
#[derive(Debug, Default, PartialEq)]
struct Args {
    /// The first positional argument — `argv[1]` in every command Coucou writes.
    event: String,
    /// `--wsl-distro <name>`: the session runs inside this WSL distro. `None`
    /// for a Windows session, and also when the value is empty — an unset
    /// `$WSL_DISTRO_NAME` must read as "not WSL", never as a distro called "".
    wsl_distro: Option<String>,
}

/// Parses the arguments after the program name. Never fails: a hook must not
/// break Claude Code over a command line it does not fully understand, so
/// anything unexpected is simply ignored.
///
/// The event is the first argument that is not `--wsl-distro` or its value,
/// which keeps `coucou-hook <EventName>` — the only shape written before this
/// flag existed — exactly as it was: the event is `argv[1]`, whatever it says.
fn parse_args<I: IntoIterator<Item = String>>(args: I) -> Args {
    const FLAG: &str = "--wsl-distro";
    let mut parsed = Args::default();
    let mut event: Option<String> = None;
    let mut iter = args.into_iter();
    while let Some(arg) = iter.next() {
        let value = if arg == FLAG {
            // A flag with nothing after it (an unquoted, empty variable) says nothing.
            Some(iter.next().unwrap_or_default())
        } else {
            arg.strip_prefix(FLAG).and_then(|rest| rest.strip_prefix('=')).map(str::to_string)
        };
        match value {
            Some(name) => {
                let name = name.trim();
                parsed.wsl_distro = (!name.is_empty()).then(|| name.to_string());
            }
            None => {
                if event.is_none() {
                    event = Some(arg);
                }
            }
        }
    }
    parsed.event = event.unwrap_or_default();
    parsed
}

/// Reads stdin and returns the payload to forward plus the event name.
fn read_event(args: &Args) -> Option<(String, String)> {
    let mut raw = Vec::new();
    if std::io::stdin().read_to_end(&mut raw).is_err() || raw.is_empty() {
        return None;
    }
    build_payload(
        raw,
        args,
        |var| std::env::var(var).ok(),
        || std::env::current_dir().ok().map(|cwd| cwd.to_string_lossy().to_string()),
    )
}

/// The JSON line forwarded to Coucou, plus the event name. Pure apart from the
/// two lookups it is handed, so it can be tested without a console or a pipe.
fn build_payload(
    mut raw: Vec<u8>,
    args: &Args,
    env: impl Fn(&str) -> Option<String>,
    current_dir: impl FnOnce() -> Option<String>,
) -> Option<(String, String)> {
    // Some shells hand us a UTF-8 BOM; serde_json would choke on it.
    if raw.starts_with(&[0xEF, 0xBB, 0xBF]) {
        raw.drain(..3);
    }

    let mut payload = serde_json::from_slice::<serde_json::Value>(&raw).ok()?;
    let map = payload.as_object_mut()?;

    // The event name is passed as argv[1] by the hook command; the JSON usually
    // carries it too. Trust argv when the JSON is missing it.
    let event = map
        .get("hook_event_name")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| args.event.clone());
    map.insert("hook_event_name".into(), serde_json::Value::String(event.clone()));

    for field in DROPPED_FIELDS {
        map.remove(*field);
    }

    let cwd_missing = map
        .get("cwd")
        .and_then(|v| v.as_str())
        .map(str::is_empty)
        .unwrap_or(true);
    if cwd_missing {
        if let Some(cwd) = current_dir() {
            map.insert("cwd".into(), serde_json::Value::String(cwd));
        }
    }

    // Which terminal the session runs in. Unlike macOS, Coucou on Windows accepts
    // events from every terminal, so this is context only — never a filter.
    for (key, var) in [
        ("term_program", "TERM_PROGRAM"),
        ("wt_session", "WT_SESSION"),
        ("term_session_id", "TERM_SESSION_ID"),
        ("vscode_pid", "VSCODE_PID"),
        ("session_pid", "CLAUDE_CODE_SSE_PORT"),
    ] {
        if !map.contains_key(key) {
            let value = env(var).unwrap_or_default();
            map.insert(key.into(), serde_json::Value::String(value));
        }
    }

    // A WSL session: the cwd above is a Linux path, and the island needs the
    // distro to find (or open) the right VS Code window. Absent otherwise.
    if let Some(distro) = &args.wsl_distro {
        map.insert("wsl_distro".into(), serde_json::Value::String(distro.clone()));
    }

    truncate_strings(&mut payload);

    let mut line = payload.to_string();
    line.push('\n');
    Some((line, event))
}

/// Caps every string in the payload. A single Write can carry a whole file.
fn truncate_strings(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::String(s) => {
            if s.len() > MAX_FIELD_LEN {
                // Cut on a char boundary; a lone byte index can split UTF-8.
                let mut end = MAX_FIELD_LEN;
                while end > 0 && !s.is_char_boundary(end) {
                    end -= 1;
                }
                s.truncate(end);
                s.push('…');
            }
        }
        serde_json::Value::Array(items) => items.iter_mut().for_each(truncate_strings),
        serde_json::Value::Object(map) => map.values_mut().for_each(truncate_strings),
        _ => {}
    }
}

/// Connect, send, and — for a permission request — wait for the island's word.
fn talk(payload: &str, waits_for_answer: bool) -> Option<String> {
    let mut pipe = connect()?;

    if pipe.write_all(payload.as_bytes()).is_err() {
        return None;
    }
    let _ = pipe.flush();

    if !waits_for_answer {
        return None;
    }

    let mut buf = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        match pipe.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.contains(&b'\n') {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let answer = String::from_utf8_lossy(&buf).trim().to_string();
    (!answer.is_empty()).then_some(answer)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decision_json_matches_the_documented_shape() {
        assert_eq!(
            decision_json("allow").unwrap(),
            r#"{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}"#
        );
        assert_eq!(
            decision_json("deny").unwrap(),
            r#"{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Denied from Coucou"}}}"#
        );
        // "always" is an island concept; Claude Code just gets an allow.
        assert!(decision_json("always").unwrap().contains(r#""behavior":"allow""#));
    }

    #[test]
    fn anything_unrecognised_prints_nothing() {
        assert!(decision_json("").is_none());
        assert!(decision_json("maybe").is_none());
        // The shape the app used to send must not be mistaken for a decision.
        assert!(decision_json(r#"{"permissionDecision":"allow"}"#).is_none());
    }

    fn args(list: &[&str]) -> Args {
        parse_args(list.iter().map(|s| s.to_string()))
    }

    #[test]
    fn the_event_is_still_the_first_argument() {
        // The only shape written before --wsl-distro existed.
        assert_eq!(args(&["PreToolUse"]), Args { event: "PreToolUse".into(), wsl_distro: None });
        assert_eq!(args(&[]), Args::default());
        // argv[1] is the event whatever it says, exactly as before.
        assert_eq!(args(&["--something", "PreToolUse"]).event, "--something");
        assert_eq!(args(&["PreToolUse", "extra"]).event, "PreToolUse");
    }

    #[test]
    fn wsl_distro_is_read_in_both_spellings_and_anywhere() {
        let want = Args { event: "PreToolUse".into(), wsl_distro: Some("Ubuntu-24.04".into()) };
        // What Coucou writes into a distro's settings.json, once the shell has expanded it.
        assert_eq!(args(&["PreToolUse", "--wsl-distro", "Ubuntu-24.04"]), want);
        assert_eq!(args(&["PreToolUse", "--wsl-distro=Ubuntu-24.04"]), want);
        assert_eq!(args(&["--wsl-distro", "Ubuntu-24.04", "PreToolUse"]), want);
        assert_eq!(args(&["PreToolUse", "--wsl-distro", "  Ubuntu-24.04 "]), want);
    }

    #[test]
    fn an_empty_or_missing_distro_means_a_windows_session() {
        for list in [
            &["PreToolUse", "--wsl-distro", ""][..],   // "$WSL_DISTRO_NAME" unset, quoted
            &["PreToolUse", "--wsl-distro"][..],       // unset and unquoted: the flag alone
            &["PreToolUse", "--wsl-distro="][..],
            &["PreToolUse", "--wsl-distro", "   "][..],
        ] {
            assert_eq!(args(list), Args { event: "PreToolUse".into(), wsl_distro: None }, "{list:?}");
        }
        // A look-alike flag is not the flag.
        assert_eq!(args(&["PreToolUse", "--wsl-distroX"]).wsl_distro, None);
    }

    fn payload(json: &str, a: &Args) -> serde_json::Value {
        let env = |var: &str| (var == "TERM_PROGRAM").then(|| "vscode".to_string());
        let (line, _) = build_payload(json.as_bytes().to_vec(), a, env, || Some(r"C:\fallback".into())).unwrap();
        assert!(line.ends_with('\n'));
        serde_json::from_str(&line).unwrap()
    }

    #[test]
    fn a_wsl_session_forwards_its_distro_and_a_windows_session_does_not() {
        let json = r#"{"hook_event_name":"PreToolUse","cwd":"/home/u/proj","tool_response":"big"}"#;
        let wsl = payload(json, &args(&["PreToolUse", "--wsl-distro", "Ubuntu-24.04"]));
        assert_eq!(wsl["wsl_distro"], "Ubuntu-24.04");
        assert_eq!(wsl["cwd"], "/home/u/proj");

        let windows = payload(json, &args(&["PreToolUse"]));
        assert!(windows.get("wsl_distro").is_none(), "a Windows session must not carry wsl_distro");
        // Everything else is as before, for both.
        for v in [&wsl, &windows] {
            assert_eq!(v["hook_event_name"], "PreToolUse");
            assert!(v.get("tool_response").is_none());
            assert_eq!(v["term_program"], "vscode");
            assert_eq!(v["vscode_pid"], "");
        }
    }

    #[test]
    fn payload_building_keeps_its_old_rules() {
        // The event comes from the JSON when it has one, from argv otherwise.
        let from_json = payload(r#"{"hook_event_name":"Stop"}"#, &args(&["PreToolUse"]));
        assert_eq!(from_json["hook_event_name"], "Stop");
        let from_argv = payload(r#"{"hook_event_name":""}"#, &args(&["PreToolUse"]));
        assert_eq!(from_argv["hook_event_name"], "PreToolUse");
        // A missing cwd falls back to the process's own.
        assert_eq!(from_argv["cwd"], r"C:\fallback");
        // A BOM is not an error; anything that is not an object is dropped.
        let mut bom = vec![0xEF, 0xBB, 0xBF];
        bom.extend_from_slice(br#"{"cwd":"C:\\x"}"#);
        assert!(build_payload(bom, &args(&["Stop"]), |_| None, || None).is_some());
        assert!(build_payload(b"[1]".to_vec(), &args(&["Stop"]), |_| None, || None).is_none());
        assert!(build_payload(b"not json".to_vec(), &args(&["Stop"]), |_| None, || None).is_none());
    }

    #[test]
    fn long_strings_are_cut_on_a_char_boundary() {
        let mut v = serde_json::json!({ "tool_input": { "content": "é".repeat(4000) } });
        truncate_strings(&mut v);
        let s = v["tool_input"]["content"].as_str().unwrap();
        assert!(s.len() <= MAX_FIELD_LEN + 4);
        assert!(s.ends_with('…'));
    }
}
