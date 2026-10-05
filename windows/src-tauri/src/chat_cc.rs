// The island's chat through Claude Code (D-016): the official `claude` CLI
// already installed on this PC, logged in on its own, run headless as one
// long-lived process. Each message goes to its stdin and the answer comes back
// on its stdout, both as stream-json lines. The app never sees a credential:
// Claude Code is the one talking to Anthropic.
//
// One process for the whole app. It starts with the first message (nothing is
// spent if nobody chats), stays up between messages — about 2 s an answer
// instead of 4–5 for a fresh process (measured 2026-10-01) — and goes away on a
// new conversation (`reset`) or when the app quits: Coucou holds its stdin, and
// Claude Code exits by itself once that closes, so even a crashed Coucou leaves
// nothing behind. If it dies (an update, a crash), the next message starts it
// again with `--resume` on the same conversation.
//
// Restricted and read-only. Nothing is ever approved without a click because
// nothing is ever approved:
//   --restricted              no command-running tools; file tools confined to
//                             the hub and the --add-dir folders; the user,
//                             project and local settings ignored — and with
//                             them the user's hooks, so the chat never shows
//                             up on the island as a session of its own
//   --strict-mcp-config       none of the account's MCP connectors
//   --permission-mode dontAsk, --permission-prompts none
//                             whatever would ask is refused on the spot
//   --tools Read,Glob,Grep,WebSearch,WebFetch
//                             reading and searching, nothing else
// `--restricted` does not load the hub's CLAUDE.md by itself (checked
// 2026-10-01), so it goes in with `--append-system-prompt-file`, together with
// the user's own ~/.claude/CLAUDE.md and a word on where the answer is shown.
// Claude Code records that prompt once per conversation: an edited CLAUDE.md
// takes effect on the next conversation.
//
// The chat can read whole folders of repositories, and with them their secrets
// and their clients' data — and what it reads goes to Anthropic in the
// conversation. So a `--settings` file denies reading those (`deny_rules`).

use std::collections::hash_map::RandomState;
use std::ffi::OsString;
use std::hash::{BuildHasher, Hasher};
use std::io::{BufRead, BufReader, Write};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};

use crate::claude::{ChatContext, ChatReply};
use crate::settings::Settings;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
/// A turn with a few web searches takes tens of seconds; past this, give up.
const TURN_TIMEOUT: Duration = Duration::from_secs(300);
/// What the chat may do: read the user's folders and search the web.
pub const TOOLS: &str = "Read,Glob,Grep,WebSearch,WebFetch";
/// How much of Claude Code's stderr is kept for an error message.
const STDERR_TAIL: usize = 2000;

/// What the chat may never read, as gitignore-style patterns: secrets, and
/// files that hold clients' data (database dumps and files, `datos/` and
/// `tablas/` folders). Broad on purpose: a `.env.example` blocked costs
/// nothing; a `.env` read cannot be taken back.
pub const DENY_PATTERNS: &[&str] = &[
    "**/.env",
    "**/.env.*",
    "**/*creds*",
    "**/*credential*",
    "**/*secret*",
    "**/*cookies*",
    "**/id_rsa*",
    "**/*.pem",
    "**/*.key",
    "**/*.pfx",
    "**/*.p12",
    "**/*.sql",
    "**/*.db",
    "**/*.sqlite",
    "**/*.sqlite3",
    "**/datos/**",
    "**/tablas/**",
];

/// The word on the island that opens the chat's system prompt.
const ISLAND_NOTE: &str = "You are answering in the chat box of the user's island: a small \
panel at the top of their screen that shows their Claude Code sessions. The box shows plain \
text, so no markdown — no **, #, tables or bullet dashes; short paragraphs and line breaks are \
fine. Answer in the user's language, briefly unless they ask for detail. You can read the \
folders listed below and search the web. You cannot run commands or change files: when \
something needs that, say what to do and where.";

/// Everything needed to start Claude Code for the chat.
#[derive(Clone, Debug, PartialEq)]
pub struct Setup {
    pub exe: PathBuf,
    /// The working folder: the hub, whose CLAUDE.md describes the projects.
    pub hub: PathBuf,
    /// Readable besides the hub (`--add-dir`), the inbox of dropped files included.
    pub dirs: Vec<PathBuf>,
    pub model: Option<String>,
    /// Where the system prompt is written before each launch.
    pub system_file: PathBuf,
    /// Where the deny rules are written before each launch (`--settings`).
    pub settings_file: PathBuf,
}

/// The `claude` to run: the first on PATH (`claude.exe` from the native
/// installer, or npm's `claude.cmd`), else where the native installer puts it.
pub fn find_claude() -> Option<PathBuf> {
    crate::find_on_path("claude").or_else(|| {
        let home = std::env::var_os("USERPROFILE")?;
        let exe = PathBuf::from(home).join(".local").join("bin").join("claude.exe");
        exe.is_file().then_some(exe)
    })
}

/// The chat's setup from the settings, or why it cannot start.
pub fn setup_from(settings: &Settings) -> Result<Setup, String> {
    let exe = find_claude().ok_or_else(|| {
        "Claude Code is not installed on this PC: no `claude` on PATH or in ~\\.local\\bin.".to_string()
    })?;
    let hub = PathBuf::from(settings.chat_hub.trim());
    if !hub.is_dir() {
        return Err(format!(
            "The chat's hub folder does not exist: {}. Create it, or choose another in Settings → Chat.",
            hub.display()
        ));
    }
    // Folders that are gone are left out rather than failing the launch.
    let mut dirs: Vec<PathBuf> = settings
        .chat_dirs
        .iter()
        .map(|d| d.trim())
        .filter(|d| !d.is_empty())
        .map(PathBuf::from)
        .filter(|d| d.is_dir())
        .collect();
    // A file dropped on the island is read from the inbox it was copied to.
    let inbox = crate::files::inbox_dir();
    if std::fs::create_dir_all(&inbox).is_ok() {
        dirs.push(inbox);
    }
    let model = Some(settings.chat_model.trim().to_string()).filter(|m| !m.is_empty());
    Ok(Setup {
        exe,
        hub,
        dirs,
        model,
        system_file: crate::settings::local_dir().join("chat").join("system.md"),
        settings_file: crate::settings::local_dir().join("chat").join("settings.json"),
    })
}

/// The arguments for one launch: a new conversation (`--session-id`) or one
/// that has already answered (`--resume`).
pub fn args(setup: &Setup, session: &str, resume: bool) -> Vec<OsString> {
    let mut a: Vec<OsString> = [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--restricted",
        "--strict-mcp-config",
        "--permission-mode",
        "dontAsk",
        "--permission-prompts",
        "none",
        "--tools",
        TOOLS,
    ]
    .iter()
    .map(OsString::from)
    .collect();
    a.push(if resume { "--resume" } else { "--session-id" }.into());
    a.push(session.into());
    a.push("--append-system-prompt-file".into());
    a.push(setup.system_file.clone().into_os_string());
    a.push("--settings".into());
    a.push(setup.settings_file.clone().into_os_string());
    if !setup.dirs.is_empty() {
        a.push("--add-dir".into());
        a.extend(setup.dirs.iter().map(|d| d.clone().into_os_string()));
    }
    if let Some(model) = &setup.model {
        a.push("--model".into());
        a.push(model.into());
    }
    a
}

/// The `Read(...)` deny rules for every drive the chat can read from.
///
/// The spelling is what Claude Code 2.1.287 on Windows actually enforces —
/// checked 2026-10-05 against decoy files in an `--add-dir` folder: a bare
/// `**/.env` and an absolute `//C:/Users/…` blocked nothing; `~/**/.env` and
/// `//c/Users/…` (lower-case drive, no colon) blocked every one. Rooted at
/// the drive (`//c/**/.env`) they cover any folder the user configures. The
/// rules on Read also kept Grep from finding what is in those files. A folder
/// with no drive letter (a `\\wsl.localhost\…` share) gets no rule — see
/// panita's open question C3.
pub fn deny_rules<'a>(folders: impl IntoIterator<Item = &'a Path>) -> Vec<String> {
    let mut drives: Vec<char> = Vec::new();
    for folder in folders {
        if let Some(std::path::Component::Prefix(prefix)) = folder.components().next() {
            if let std::path::Prefix::Disk(d) | std::path::Prefix::VerbatimDisk(d) = prefix.kind() {
                let d = (d as char).to_ascii_lowercase();
                if !drives.contains(&d) {
                    drives.push(d);
                }
            }
        }
    }
    drives
        .iter()
        .flat_map(|d| DENY_PATTERNS.iter().map(move |p| format!("Read(//{d}/{p})")))
        .collect()
}

/// The `--settings` file: nothing but the deny rules.
pub fn settings_json(rules: &[String]) -> String {
    serde_json::to_string_pretty(&json!({ "permissions": { "deny": rules } })).unwrap_or_default()
}

/// The chat's system prompt: the note on the island, the folders it can read,
/// the hub's CLAUDE.md and the user's own, each when there is one.
pub fn system_prompt(hub: &Path, dirs: &[PathBuf], hub_md: Option<&str>, user_md: Option<&str>) -> String {
    let mut s = String::from(ISLAND_NOTE);
    s.push_str("\n\nFolders you can read:\n");
    s.push_str(&format!("- {} (your working folder, the hub)\n", hub.display()));
    for d in dirs {
        s.push_str(&format!("- {}\n", d.display()));
    }
    if let Some(md) = hub_md.map(str::trim).filter(|m| !m.is_empty()) {
        s.push_str(&format!("\n# The hub's CLAUDE.md ({})\n\n{md}\n", hub.join("CLAUDE.md").display()));
    }
    if let Some(md) = user_md.map(str::trim).filter(|m| !m.is_empty()) {
        s.push_str(&format!("\n# The user's own CLAUDE.md (their preferences)\n\n{md}\n"));
    }
    s
}

/// The user's message, with what it is about in front: a file dropped on the
/// island or an image pasted into the chat — on the message that comes right
/// after it, which the island decides (it sends the context only then).
pub fn message_text(query: &str, context: Option<&ChatContext>) -> String {
    match context {
        Some(ChatContext::File { name, path }) => {
            format!("The user attached a file to this message: \"{name}\", at {path}. Read it to answer.\n\n{query}")
        }
        Some(ChatContext::Window { app_name, title, url }) => {
            let url = url.as_deref().map(|u| format!(", URL: {u}")).unwrap_or_default();
            format!("Context — App: {app_name}, Window: {title}{url}\n\n{query}")
        }
        None => query.to_string(),
    }
}

/// One stdin line: a user message in Claude Code's stream-json input.
pub fn user_line(text: &str) -> String {
    json!({
        "type": "user",
        "message": { "role": "user", "content": [{ "type": "text", "text": text }] }
    })
    .to_string()
}

/// What a `result` event says about the turn: the answer, or why there is
/// none. Anything else is not the end of the turn.
pub fn turn_outcome(event: &Value) -> Option<Result<String, String>> {
    if event.get("type").and_then(Value::as_str) != Some("result") {
        return None;
    }
    let text = event.get("result").and_then(Value::as_str).unwrap_or("").trim().to_string();
    let ok = event.get("subtype").and_then(Value::as_str) == Some("success")
        && !event.get("is_error").and_then(Value::as_bool).unwrap_or(false);
    Some(match (ok, text.is_empty()) {
        (true, false) => Ok(text),
        (true, true) => Err("Claude Code answered with no text.".into()),
        (false, false) => Err(text),
        (false, true) => {
            let subtype = event.get("subtype").and_then(Value::as_str).unwrap_or("error");
            Err(format!("Claude Code could not answer ({subtype})."))
        }
    })
}

/// A random version-4 UUID, from the OS-seeded keys of std's hasher — no new
/// dependency for sixteen random bytes.
pub fn new_uuid() -> String {
    let mut bytes = [0u8; 16];
    for half in bytes.chunks_mut(8) {
        let mut h = RandomState::new().build_hasher();
        h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
        half.copy_from_slice(&h.finish().to_le_bytes());
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &hex[0..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..32])
}

/// Keeps the last `max` bytes of `s`, on a character boundary.
fn keep_tail(s: &mut String, max: usize) {
    if s.len() <= max {
        return;
    }
    let mut cut = s.len() - max;
    while !s.is_char_boundary(cut) {
        cut += 1;
    }
    s.drain(..cut);
}

// ── The process ─────────────────────────────────────────────────────────────

struct Running {
    /// Shared so a reset can kill it while a turn is waiting on it.
    child: Arc<Mutex<Child>>,
    stdin: ChildStdin,
    /// Parsed stdout lines; None once stdout has closed.
    lines: Receiver<Option<Value>>,
    stderr: Arc<Mutex<String>>,
}

impl Running {
    fn start(setup: &Setup, session: &str, resume: bool) -> Result<Self, String> {
        let mut child = Command::new(&setup.exe)
            .args(args(setup, session, resume))
            .current_dir(&setup.hub)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| format!("Could not start Claude Code ({}): {e}", setup.exe.display()))?;
        let stdin = child.stdin.take().ok_or("Claude Code has no stdin")?;
        let stdout = child.stdout.take().ok_or("Claude Code has no stdout")?;
        let stderr_pipe = child.stderr.take().ok_or("Claude Code has no stderr")?;

        let (tx, lines) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                // Anything that is not JSON (a stray warning) is not an event.
                if let Ok(event) = serde_json::from_str::<Value>(&line) {
                    if tx.send(Some(event)).is_err() {
                        return;
                    }
                }
            }
            let _ = tx.send(None);
        });
        let stderr = Arc::new(Mutex::new(String::new()));
        let tail = stderr.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr_pipe).lines().map_while(Result::ok) {
                let mut t = tail.lock().unwrap();
                t.push_str(&line);
                t.push('\n');
                keep_tail(&mut t, STDERR_TAIL);
            }
        });
        Ok(Self { child: Arc::new(Mutex::new(child)), stdin, lines, stderr })
    }

    fn pid(&self) -> u32 {
        self.child.lock().unwrap().id()
    }

    fn alive(&self) -> bool {
        matches!(self.child.lock().unwrap().try_wait(), Ok(None))
    }

    fn stderr_tail(&self) -> String {
        self.stderr.lock().unwrap().trim().to_string()
    }

    /// Sends one message and waits for the turn to end.
    fn turn(&mut self, line: &str) -> Result<String, TurnError> {
        let wrote = self
            .stdin
            .write_all(line.as_bytes())
            .and_then(|_| self.stdin.write_all(b"\n"))
            .and_then(|_| self.stdin.flush());
        if wrote.is_err() {
            return Err(TurnError::NotListening);
        }
        let deadline = Instant::now() + TURN_TIMEOUT;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            match self.lines.recv_timeout(left) {
                Ok(Some(event)) => {
                    if let Some(outcome) = turn_outcome(&event) {
                        return outcome.map_err(TurnError::Failed);
                    }
                }
                Ok(None) | Err(RecvTimeoutError::Disconnected) => return Err(TurnError::Died),
                Err(RecvTimeoutError::Timeout) => return Err(TurnError::Timeout),
            }
        }
    }
}

fn kill(child: &Arc<Mutex<Child>>) {
    let mut child = child.lock().unwrap();
    let _ = child.kill();
    let _ = child.wait();
}

enum TurnError {
    /// Its stdin was closed: it had already gone.
    NotListening,
    /// It went away mid-turn.
    Died,
    Timeout,
    /// It answered that it could not answer.
    Failed(String),
}

#[derive(Default)]
struct Conversation {
    /// Chosen by us, so a relaunch can resume it.
    session: Option<String>,
    /// Turns answered; from the first one on, a relaunch is a `--resume`.
    answered: u32,
    /// Bumped by every reset, so a turn that outlives one is not kept.
    generation: u64,
    proc: Option<Running>,
    /// The process a turn is waiting on, for a reset to kill.
    busy: Option<Arc<Mutex<Child>>>,
}

#[derive(Default)]
pub struct CcChat {
    state: Mutex<Conversation>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatStatus {
    /// "claude-code" or "api".
    pub engine: String,
    /// The `claude` the chat would run.
    pub exe: Option<String>,
    pub hub_exists: bool,
}

pub fn status(settings: &Settings) -> ChatStatus {
    ChatStatus {
        engine: settings.chat_engine.clone(),
        exe: find_claude().map(|p| p.to_string_lossy().into_owned()),
        hub_exists: Path::new(settings.chat_hub.trim()).is_dir(),
    }
}

impl CcChat {
    /// One chat turn. Blocking: run it off the main thread.
    pub fn send(&self, setup: &Setup, query: &str, context: Option<&ChatContext>) -> Result<ChatReply, String> {
        let started = Instant::now();
        // The first launch may find Claude Code already gone; one more try
        // starts it again before giving up.
        for attempt in 0..2 {
            let (mut run, generation) = self.take_running(setup)?;
            let text = message_text(query, context);
            let outcome = run.turn(&user_line(&text));
            let mut st = self.state.lock().unwrap();
            st.busy = None;
            let current = st.generation == generation;
            match outcome {
                Ok(answer) => {
                    if current {
                        st.answered += 1;
                        st.proc = Some(run);
                    } else {
                        kill(&run.child);
                    }
                    crate::log::line(format!("chat: answered in {} ms", started.elapsed().as_millis()));
                    return Ok(ChatReply { text: answer });
                }
                Err(TurnError::Failed(why)) => {
                    if current {
                        st.proc = Some(run);
                    }
                    crate::log::line("chat: Claude Code could not answer".to_string());
                    return Err(why);
                }
                Err(TurnError::NotListening) if attempt == 0 && current => {
                    crate::log::line(format!("chat: Claude Code had exited ({}) — starting it again", run.stderr_tail()));
                    continue;
                }
                Err(TurnError::NotListening) | Err(TurnError::Died) => {
                    let tail = run.stderr_tail();
                    crate::log::line(format!("chat: Claude Code exited mid-answer: {tail}"));
                    if !current {
                        return Err("A new conversation was started.".into());
                    }
                    return Err(if tail.is_empty() {
                        "Claude Code stopped before answering. Send it again to pick the conversation up.".into()
                    } else {
                        format!("Claude Code stopped before answering: {tail}")
                    });
                }
                Err(TurnError::Timeout) => {
                    kill(&run.child);
                    crate::log::line("chat: no answer within the time limit — stopped it".to_string());
                    return Err("No answer from Claude Code after 5 minutes. Send it again to pick the conversation up.".into());
                }
            }
        }
        Err("Claude Code would not start.".into())
    }

    /// The running process, started if there is none, taken out of the state
    /// for the turn (so a reset can still get in), with the generation it
    /// belongs to.
    fn take_running(&self, setup: &Setup) -> Result<(Running, u64), String> {
        let mut st = self.state.lock().unwrap();
        if let Some(run) = st.proc.take() {
            if run.alive() {
                st.busy = Some(run.child.clone());
                return Ok((run, st.generation));
            }
            crate::log::line(format!("chat: Claude Code had exited ({})", run.stderr_tail()));
        }
        let session = st.session.get_or_insert_with(new_uuid).clone();
        let resume = st.answered > 0;
        write_system_file(setup)?;
        let run = Running::start(setup, &session, resume)?;
        crate::log::line(format!(
            "chat: started Claude Code, pid {} ({} {session})",
            run.pid(),
            if resume { "resuming" } else { "new conversation" }
        ));
        st.busy = Some(run.child.clone());
        Ok((run, st.generation))
    }

    /// A new conversation: the process goes, and the next message starts
    /// another one with a new id.
    pub fn reset(&self) {
        let mut st = self.state.lock().unwrap();
        st.generation += 1;
        st.session = None;
        st.answered = 0;
        if let Some(run) = st.proc.take() {
            kill(&run.child);
        }
        if let Some(child) = st.busy.take() {
            kill(&child);
        }
    }
}

fn write_system_file(setup: &Setup) -> Result<(), String> {
    let read = |p: PathBuf| std::fs::read_to_string(p).ok();
    let hub_md = read(setup.hub.join("CLAUDE.md"));
    let user_md = std::env::var_os("USERPROFILE")
        .and_then(|home| read(PathBuf::from(home).join(".claude").join("CLAUDE.md")));
    let prompt = system_prompt(&setup.hub, &setup.dirs, hub_md.as_deref(), user_md.as_deref());
    let rules = deny_rules(std::iter::once(setup.hub.as_path()).chain(setup.dirs.iter().map(PathBuf::as_path)));
    let fail = |e: std::io::Error| format!("Could not prepare the chat: {e}");
    for file in [&setup.system_file, &setup.settings_file] {
        if let Some(dir) = file.parent() {
            std::fs::create_dir_all(dir).map_err(fail)?;
        }
    }
    std::fs::write(&setup.system_file, prompt).map_err(fail)?;
    std::fs::write(&setup.settings_file, settings_json(&rules)).map_err(fail)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> Setup {
        Setup {
            exe: PathBuf::from(r"C:\bin\claude.exe"),
            hub: PathBuf::from(r"C:\GitHub\hub"),
            dirs: vec![PathBuf::from(r"C:\GitHub"), PathBuf::from(r"C:\inbox")],
            model: None,
            system_file: PathBuf::from(r"C:\local\chat\system.md"),
            settings_file: PathBuf::from(r"C:\local\chat\settings.json"),
        }
    }

    fn strings(a: Vec<OsString>) -> Vec<String> {
        a.into_iter().map(|s| s.to_string_lossy().into_owned()).collect()
    }

    #[test]
    fn a_new_conversation_is_restricted_read_only_and_names_its_session() {
        let a = strings(args(&setup(), "11111111-2222-4333-8444-555555555555", false));
        let joined = a.join(" ");
        for flag in [
            "-p",
            "--input-format stream-json",
            "--output-format stream-json",
            "--verbose",
            "--restricted",
            "--strict-mcp-config",
            "--permission-mode dontAsk",
            "--permission-prompts none",
            "--tools Read,Glob,Grep,WebSearch,WebFetch",
            "--session-id 11111111-2222-4333-8444-555555555555",
            r"--append-system-prompt-file C:\local\chat\system.md",
            r"--settings C:\local\chat\settings.json",
            r"--add-dir C:\GitHub C:\inbox",
        ] {
            assert!(joined.contains(flag), "missing {flag:?} in {joined}");
        }
        assert!(!joined.contains("--resume"));
        assert!(!joined.contains("--model"));
        // Never anything that would approve on the user's behalf.
        for never in ["bypassPermissions", "acceptEdits", "--dangerously", "Bash", "Edit", "Write"] {
            assert!(!joined.contains(never), "{never} in {joined}");
        }
    }

    #[test]
    fn secrets_and_client_data_are_denied_on_every_drive_it_reads() {
        let folders = [
            PathBuf::from(r"C:\Users\m\Documents\GitHub\hub"),
            PathBuf::from(r"C:\Users\m\Documents\GitHub"),
            PathBuf::from(r"D:\work"),
            PathBuf::from(r"\\?\E:\verbatim"),
            PathBuf::from(r"\\wsl.localhost\Ubuntu-24.04\home\m"),
        ];
        let rules = deny_rules(folders.iter().map(PathBuf::as_path));
        // Lower-case drive, no colon, rooted at the drive: the spelling Claude
        // Code enforces (see deny_rules).
        for rule in ["Read(//c/**/.env)", "Read(//c/**/.env.*)", "Read(//c/**/*creds*)", "Read(//c/**/*.sql)", "Read(//c/**/datos/**)", "Read(//d/**/.env)", "Read(//e/**/*.pem)"] {
            assert!(rules.contains(&rule.to_string()), "missing {rule}");
        }
        // One set per drive, C: once although two folders are on it; the WSL
        // share has no drive and gets none.
        assert_eq!(rules.len(), 3 * DENY_PATTERNS.len());
        assert!(rules.iter().all(|r| !r.contains(':') && !r.contains("wsl")));
        let json: Value = serde_json::from_str(&settings_json(&rules)).unwrap();
        assert_eq!(json["permissions"]["deny"].as_array().unwrap().len(), rules.len());
        assert!(deny_rules(std::iter::empty()).is_empty());
    }

    #[test]
    fn a_relaunch_resumes_the_same_conversation() {
        let a = strings(args(&setup(), "abc", true));
        let i = a.iter().position(|s| s == "--resume").expect("--resume");
        assert_eq!(a[i + 1], "abc");
        assert!(!a.contains(&"--session-id".to_string()));
    }

    #[test]
    fn a_model_is_passed_only_when_chosen() {
        let mut s = setup();
        s.model = Some("sonnet".into());
        let a = strings(args(&s, "abc", false));
        let i = a.iter().position(|x| x == "--model").expect("--model");
        assert_eq!(a[i + 1], "sonnet");
        s.dirs.clear();
        assert!(!strings(args(&s, "abc", false)).contains(&"--add-dir".to_string()));
    }

    #[test]
    fn the_system_prompt_carries_the_folders_and_both_claude_mds() {
        let s = setup();
        let p = system_prompt(&s.hub, &s.dirs, Some("La palabra es MANZANA-7."), Some("Hablá corto."));
        assert!(p.starts_with(ISLAND_NOTE));
        assert!(p.contains(r"- C:\GitHub\hub (your working folder, the hub)"));
        assert!(p.contains(r"- C:\inbox"));
        assert!(p.contains(r"# The hub's CLAUDE.md (C:\GitHub\hub\CLAUDE.md)"));
        assert!(p.contains("MANZANA-7"));
        assert!(p.contains("Hablá corto."));
        let bare = system_prompt(&s.hub, &[], None, Some("  "));
        assert!(!bare.contains("CLAUDE.md ("));
        assert!(!bare.contains("their preferences"));
    }

    #[test]
    fn a_message_with_a_file_says_what_it_is_about() {
        let file = ChatContext::File { name: "plan.pdf".into(), path: r"C:\inbox\plan.pdf".into() };
        let m = message_text("¿qué dice?", Some(&file));
        assert!(m.starts_with("The user attached a file to this message: \"plan.pdf\", at C:\\inbox\\plan.pdf."));
        assert!(m.ends_with("\n\n¿qué dice?"));
        assert_eq!(message_text("hola", None), "hola");
    }

    #[test]
    fn a_message_is_one_stream_json_line() {
        let line = user_line("dos\nlíneas \"citadas\"");
        assert!(!line.contains('\n'));
        let v: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(v["type"], "user");
        assert_eq!(v["message"]["role"], "user");
        assert_eq!(v["message"]["content"][0]["text"], "dos\nlíneas \"citadas\"");
    }

    #[test]
    fn only_a_result_event_ends_a_turn() {
        let assistant = json!({"type": "assistant", "message": {"content": [{"type": "text", "text": "hola"}]}});
        assert_eq!(turn_outcome(&assistant), None);
        assert_eq!(turn_outcome(&json!({"type": "system", "subtype": "init"})), None);
        let ok = json!({"type": "result", "subtype": "success", "is_error": false, "result": " MANZANA-7 \n"});
        assert_eq!(turn_outcome(&ok), Some(Ok("MANZANA-7".into())));
        let empty = json!({"type": "result", "subtype": "success", "is_error": false, "result": ""});
        assert!(matches!(turn_outcome(&empty), Some(Err(_))));
        let refused = json!({"type": "result", "subtype": "success", "is_error": true, "result": "Credit balance too low"});
        assert_eq!(turn_outcome(&refused), Some(Err("Credit balance too low".into())));
        let maxed = json!({"type": "result", "subtype": "error_max_turns", "is_error": true});
        assert_eq!(turn_outcome(&maxed), Some(Err("Claude Code could not answer (error_max_turns).".into())));
    }

    #[test]
    fn session_ids_are_distinct_v4_uuids() {
        let a = new_uuid();
        let b = new_uuid();
        assert_ne!(a, b);
        for id in [&a, &b] {
            let parts: Vec<&str> = id.split('-').collect();
            assert_eq!(parts.iter().map(|p| p.len()).collect::<Vec<_>>(), vec![8, 4, 4, 4, 12], "{id}");
            assert!(id.chars().all(|c| c == '-' || c.is_ascii_hexdigit()));
            assert_eq!(&parts[2][..1], "4");
            assert!(matches!(&parts[3][..1], "8" | "9" | "a" | "b"), "{id}");
        }
    }

    #[test]
    fn the_stderr_tail_is_cut_on_a_character_boundary() {
        let mut s = "ñandú ".repeat(10);
        keep_tail(&mut s, 7);
        assert!(s.len() <= 7);
        assert!(s.ends_with("ú "));
    }
}
