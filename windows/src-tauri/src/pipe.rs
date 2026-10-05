// Named-pipe server for coucou-hook.
//
// `\\.\pipe\coucou-<sid>` — one instance per connection. Every hook event is
// forwarded to the island as a `hook` event. `PermissionRequest` is the only one
// that keeps its connection open: it waits for the island's decision and writes
// it back on the same pipe, which is how approving from the island works.
//
// Claude Code is never blocked by us. Three things guarantee it:
//   * coucou-hook gives the connection 300 ms and exits cleanly if we are closed;
//   * we only wait for a human once the island has *confirmed* the card is on
//     screen, so a paused island or a webview that is not listening costs a few
//     hundred milliseconds, not two minutes;
//   * whatever happens we drop the connection after the decision timeout, and
//     the terminal takes over.
//
// What we write back is the bare word `allow` or `deny`. Turning that into the
// documented hookSpecificOutput JSON is coucou-hook's job, so the wire format
// Claude Code expects lives in exactly one place.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};
use tokio::sync::mpsc;

use crate::island::WINDOW_LABEL;
use crate::log;

/// Slightly under coucou-hook's own 110 s wait, so we always answer first.
const DECISION_TIMEOUT: Duration = Duration::from_secs(108);
/// How long the island gets to say "the card is up". This is the whole of B4:
/// without it, an island that is paused, hidden behind a crashed webview or
/// simply not listening would leave Claude Code staring at a prompt nobody can
/// see for nearly two minutes.
const ACK_TIMEOUT: Duration = Duration::from_millis(800);
const MAX_PAYLOAD: usize = 1 << 20;

/// What the island can say about a permission request.
pub enum Reply {
    /// The card is on screen and a human can act on it.
    Ack,
    /// A human clicked: `allow` or `deny`.
    Decision(String),
    /// Nobody can act on it — paused, or another request already holds the card.
    Decline,
}

/// Permission requests the island has been told about.
#[derive(Default)]
pub struct Pending(pub Mutex<HashMap<String, mpsc::Sender<Reply>>>);

static COUNTER: AtomicU64 = AtomicU64::new(1);

/// `\\.\pipe\coucou-<sid>` — must match coucou-hook's `pipe_path()` exactly, which
/// is why both build it with `instance::pipe_name` from the same source file.
pub fn pipe_name() -> String {
    let key = crate::win::current_user_sid()
        .unwrap_or_else(|| std::env::var("USERNAME").unwrap_or_else(|_| "user".into()));
    crate::instance::pipe_name(&key)
}

pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let name = pipe_name();
        // first_pipe_instance also means we refuse to join a pipe somebody else
        // already owns under our name, rather than serving on top of it.
        let mut server = match ServerOptions::new().first_pipe_instance(true).create(&name) {
            Ok(s) => s,
            Err(err) => {
                log::line(format!("cannot open the relay pipe: {err}"));
                return;
            }
        };
        loop {
            if server.connect().await.is_err() {
                tokio::time::sleep(Duration::from_millis(200)).await;
                continue;
            }
            // Hand the connected instance to a task and listen on a fresh one.
            let next = match ServerOptions::new().create(&name) {
                Ok(s) => s,
                Err(err) => {
                    log::line(format!("cannot reopen the relay pipe: {err}"));
                    return;
                }
            };
            let connected = std::mem::replace(&mut server, next);
            let app = app.clone();
            tauri::async_runtime::spawn(async move { handle(app, connected).await });
        }
    });
}

async fn handle(app: AppHandle, mut pipe: NamedPipeServer) {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        match pipe.read(&mut chunk).await {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.contains(&b'\n') || buf.len() > MAX_PAYLOAD {
                    break;
                }
            }
            Err(_) => return,
        }
    }
    let line = match buf.iter().position(|b| *b == b'\n') {
        Some(i) => &buf[..i],
        None => &buf[..],
    };
    let Ok(mut payload) = serde_json::from_slice::<Value>(line) else { return };
    if !payload.is_object() {
        return;
    }

    let event = payload
        .get("hook_event_name")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    // Sessions running inside WSL say so (coucou-hook --wsl-distro). Logged so
    // "is my WSL session reaching Coucou?" has an answer; only a well-formed
    // distro name ever reaches the log line.
    let origin = match payload.get("wsl_distro").and_then(Value::as_str) {
        Some(d) if crate::wsl::is_valid_distro_name(d) => format!(" wsl={d}"),
        Some(_) => " wsl=?".to_string(),
        None => String::new(),
    };

    // Claude Code's status line (installed with the hooks): only the
    // subscription's usage goes on, to the island's usage bar. It refreshes
    // every few seconds while a session works, so it is not logged, and it is
    // not a session event — no session is created or touched by it.
    if event == STATUS_LINE {
        if let Some(usage) = usage_of(&payload) {
            let _ = app.emit_to(WINDOW_LABEL, "usage", usage);
        }
        let _ = pipe.disconnect();
        return;
    }

    // Which terminal the session runs in (ancestor_pids, wsl_ppid): kept here
    // for "Open", never shown to the island. See terminal.rs.
    app.state::<crate::terminal::Terminals>().observe(&event, &payload);
    crate::terminal::strip(&mut payload);

    if event != "PermissionRequest" {
        log::line(format!("hook {event}{origin}"));
        let _ = app.emit_to(WINDOW_LABEL, "hook", payload);
        let _ = pipe.disconnect();
        return;
    }

    let id = format!("{}-{}", std::process::id(), COUNTER.fetch_add(1, Ordering::Relaxed));
    let (tx, mut rx) = mpsc::channel::<Reply>(4);
    {
        let pending = app.state::<Pending>();
        pending.0.lock().unwrap().insert(id.clone(), tx);
    }
    payload["request_id"] = json!(id);
    log::line(format!("hook PermissionRequest id={id}{origin}"));
    let _ = app.emit_to(WINDOW_LABEL, "hook", payload);

    let decision = wait_for_decision(&id, &mut rx).await;
    app.state::<Pending>().0.lock().unwrap().remove(&id);

    // No decision: say nothing at all. coucou-hook then writes nothing to stdout
    // and Claude Code asks in the terminal, exactly as if Coucou were closed.
    if let Some(d) = decision {
        let _ = pipe.write_all(format!("{d}\n").as_bytes()).await;
        let _ = pipe.flush().await;
    }
    let _ = pipe.disconnect();
}

/// Two waits: a short one for "the card is up", then the long one for a human.
async fn wait_for_decision(id: &str, rx: &mut mpsc::Receiver<Reply>) -> Option<String> {
    match tokio::time::timeout(ACK_TIMEOUT, rx.recv()).await {
        Ok(Some(Reply::Ack)) => {}
        // A click that beats the ack is still a click.
        Ok(Some(Reply::Decision(d))) => {
            log::line(format!("hook id={id} answered {d}"));
            return Some(d);
        }
        Ok(Some(Reply::Decline)) => {
            log::line(format!("hook id={id} not shown — terminal takes over"));
            return None;
        }
        Ok(None) => return None,
        Err(_) => {
            log::line(format!("hook id={id} island never acknowledged — terminal takes over"));
            return None;
        }
    }

    match tokio::time::timeout(DECISION_TIMEOUT, rx.recv()).await {
        Ok(Some(Reply::Decision(d))) => {
            log::line(format!("hook id={id} answered {d}"));
            Some(d)
        }
        Ok(Some(Reply::Decline)) => {
            log::line(format!("hook id={id} released without a decision"));
            None
        }
        _ => {
            log::line(format!("hook id={id} timed out — terminal takes over"));
            None
        }
    }
}

fn send(app: &AppHandle, request_id: &str, reply: Reply, keep: bool) {
    let sender = {
        let pending = app.state::<Pending>();
        let mut map = pending.0.lock().unwrap();
        if keep { map.get(request_id).cloned() } else { map.remove(request_id) }
    };
    match sender {
        Some(tx) => {
            let _ = tx.try_send(reply);
        }
        None => log::line(format!("reply for id={request_id} — no pending request")),
    }
}

/// The island has the card on screen; the long wait may begin.
pub fn acknowledge(app: &AppHandle, request_id: &str) {
    send(app, request_id, Reply::Ack, true);
}

/// Nobody can act on this one — paused, or another card already holds the view.
pub fn decline(app: &AppHandle, request_id: &str) {
    log::line(format!("decline id={request_id}"));
    send(app, request_id, Reply::Decline, false);
}

/// The event name the relay gives Claude Code's status line (hooks.rs writes
/// `coucou-hook StatusLine` as the `statusLine` command).
pub const STATUS_LINE: &str = "StatusLine";

/// What the island's usage bar needs from a status line's JSON: the 5-hour
/// and 7-day windows of `rate_limits`, each `{ usedPercentage, resetsAt }`
/// (percent 0–100, Unix seconds), or null when Claude Code did not send it.
/// Claude Code sends `rate_limits` only to subscribers, after the first API
/// response, and drops a window once its `resets_at` has passed. `None` when
/// neither window is there: nothing to say, the bar keeps what it had.
pub fn usage_of(status: &Value) -> Option<Value> {
    let limits = status.get("rate_limits")?;
    let window = |name: &str| -> Value {
        let w = limits.get(name);
        let pct = w.and_then(|w| w.get("used_percentage")).and_then(Value::as_f64);
        let resets = w.and_then(|w| w.get("resets_at")).and_then(Value::as_f64);
        match (pct, resets) {
            (Some(p), Some(r)) if p.is_finite() && r.is_finite() && r > 0.0 => {
                json!({ "usedPercentage": p.clamp(0.0, 100.0), "resetsAt": r.floor() as i64 })
            }
            _ => Value::Null,
        }
    };
    let five = window("five_hour");
    let seven = window("seven_day");
    if five.is_null() && seven.is_null() {
        return None;
    }
    Some(json!({ "fiveHour": five, "sevenDay": seven }))
}

/// Called by the island's Allow / Deny buttons. Only ever a bare word: turning
/// it into Claude Code's JSON is coucou-hook's job.
pub fn answer(app: &AppHandle, request_id: &str, decision: &str) {
    let word = decision_word(decision);
    log::line(format!("decision id={request_id} {word}"));
    send(app, request_id, Reply::Decision(word.to_string()), false);
}

/// What goes back down the pipe. Anything that is not an explicit allow is a
/// deny: a typo or a new button must never turn into a permission.
fn decision_word(decision: &str) -> &'static str {
    match decision {
        "allow" | "always" => "allow",
        _ => "deny",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_usage_bar_gets_the_two_windows_and_nothing_else() {
        // The shape Claude Code 2.1.289 documents for a status line command.
        let status = json!({
            "session_id": "s", "cwd": "C:\\x", "model": { "display_name": "Opus" },
            "cost": { "total_cost_usd": 1.2 },
            "rate_limits": {
                "five_hour": { "used_percentage": 42.5, "resets_at": 1_791_234_567 },
                "seven_day": { "used_percentage": 18, "resets_at": 1_791_600_000.9 }
            }
        });
        assert_eq!(
            usage_of(&status).unwrap(),
            json!({
                "fiveHour": { "usedPercentage": 42.5, "resetsAt": 1_791_234_567 },
                "sevenDay": { "usedPercentage": 18.0, "resetsAt": 1_791_600_000 }
            })
        );
    }

    #[test]
    fn a_missing_or_odd_window_is_null_and_no_window_is_nothing() {
        let only_week = json!({ "rate_limits": { "seven_day": { "used_percentage": 3, "resets_at": 5 } } });
        assert_eq!(usage_of(&only_week).unwrap()["fiveHour"], Value::Null);
        // Out of range is held to 0–100; a window without its reset time is no window.
        let odd = json!({ "rate_limits": {
            "five_hour": { "used_percentage": 140, "resets_at": 9 },
            "seven_day": { "used_percentage": 10 }
        } });
        assert_eq!(usage_of(&odd).unwrap(), json!({ "fiveHour": { "usedPercentage": 100.0, "resetsAt": 9 }, "sevenDay": null }));
        let text = json!({ "rate_limits": { "five_hour": { "used_percentage": "42", "resets_at": 9 } } });
        assert_eq!(usage_of(&text), None);
        // Not a subscriber, or before the first answer: no rate_limits at all.
        assert_eq!(usage_of(&json!({ "session_id": "s" })), None);
        assert_eq!(usage_of(&json!({ "rate_limits": {} })), None);
    }

    #[test]
    fn only_an_explicit_allow_allows() {
        assert_eq!(decision_word("allow"), "allow");
        assert_eq!(decision_word("always"), "allow");
        for other in ["deny", "", "Allow", "ALLOW", " allow", "yes", "allow\n"] {
            assert_eq!(decision_word(other), "deny", "{other:?} must deny");
        }
    }

    /// `wait_for_decision` on a current-thread runtime, with the replies queued
    /// up front (as many as the channel holds) and the sender then dropped.
    fn decide(replies: Vec<Reply>) -> Option<String> {
        let (tx, mut rx) = mpsc::channel::<Reply>(4);
        for reply in replies {
            tx.try_send(reply).ok().expect("channel full");
        }
        drop(tx);
        tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap()
            .block_on(wait_for_decision("test", &mut rx))
    }

    #[test]
    fn an_acknowledged_card_returns_the_click() {
        assert_eq!(decide(vec![Reply::Ack, Reply::Decision("allow".into())]).as_deref(), Some("allow"));
        assert_eq!(decide(vec![Reply::Ack, Reply::Decision("deny".into())]).as_deref(), Some("deny"));
    }

    #[test]
    fn a_click_that_beats_the_ack_still_counts() {
        assert_eq!(decide(vec![Reply::Decision("allow".into())]).as_deref(), Some("allow"));
    }

    #[test]
    fn a_decline_or_a_vanished_island_means_no_answer() {
        assert_eq!(decide(vec![Reply::Decline]), None);
        assert_eq!(decide(vec![Reply::Ack, Reply::Decline]), None);
        // Island acked, then the sender went away without a decision.
        assert_eq!(decide(vec![Reply::Ack]), None);
        // Nothing at all.
        assert_eq!(decide(vec![]), None);
    }

    #[test]
    fn an_island_that_never_acks_releases_the_relay_quickly() {
        // Keep the sender alive so only the ack timeout can end the wait.
        let (_tx, mut rx) = mpsc::channel::<Reply>(4);
        let started = std::time::Instant::now();
        let answer = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap()
            .block_on(wait_for_decision("test", &mut rx));
        assert_eq!(answer, None);
        let waited = started.elapsed();
        assert!(waited >= ACK_TIMEOUT, "gave up before the ack window closed: {waited:?}");
        assert!(waited < ACK_TIMEOUT + Duration::from_secs(2), "held the relay for {waited:?}");
    }
}
