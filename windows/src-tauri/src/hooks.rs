// Claude Code hook installation.
//
// The rule from CLAUDE.md is strict and is followed to the letter:
// read ~/.claude/settings.json, take a dated backup, merge without touching
// anybody else's hooks, show the diff, and write only after an explicit click.
// Uninstall removes Coucou's entries and nothing else.
//
// There is one such file per place Claude Code runs — a *target*:
//   * Windows: %USERPROFILE%\.claude\settings.json. The command is only the
//     quoted exe path in forward slashes plus the event name: on Windows Claude
//     Code runs hook commands through Git Bash, and anything with PowerShell or
//     cmd in it breaks.
//   * each WSL distro (wsl.rs): the default user's ~/.claude/settings.json,
//     reached through \\wsl.localhost\<distro>\…. The command is the same
//     Windows relay, run through WSL interop by its Linux path, followed by
//     `--wsl-distro "$WSL_DISTRO_NAME"` so the island knows where the session
//     lives, and `--wsl-ppid "$PPID"` so "Open" can find its terminal
//     (terminal.rs).
//
// Everything that reads, merges, diffs and writes works on a `Location` — a
// settings path plus how the command reads — so it is tested against temporary
// folders and never against a real home.
//
// A command Coucou wrote earlier can differ from the one it would write now —
// the WSL command gained `--wsl-ppid`, the relay can move. Such an install is
// *outdated*: the settings window says so and offers the same preview →
// backup → write-on-click flow to update it. Nothing is ever rewritten on its
// own.

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager};
use windows::Win32::System::SystemInformation::GetLocalTime;

use crate::{instance, settings, wsl};

/// Every event the island reacts to, with the hook timeout written to settings.json.
/// PermissionRequest waits for a human, so it gets the decision timeout + 10 s.
pub const HOOK_EVENTS: &[(&str, u64)] = &[
    ("SessionStart", 10),
    ("SessionEnd", 10),
    ("UserPromptSubmit", 10),
    ("PreToolUse", 10),
    ("PostToolUse", 10),
    ("PostToolUseFailure", 10),
    ("PermissionRequest", 120),
    ("Notification", 10),
    ("Stop", 10),
    ("StopFailure", 10),
    ("SubagentStart", 10),
    ("SubagentStop", 10),
];

/// Marker that identifies a Coucou entry inside settings.json — the relay's
/// file name, which appears in the Windows and the WSL command alike.
const MARKER: &str = "coucou-hook";

/// Test-only: see `test_home`.
const TEST_HOME_VAR: &str = "COUCOU_TEST_HOME";

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct HookStatus {
    /// `"windows"` or `"wsl:<distro>"`.
    pub target: String,
    /// `"Windows"` or `"WSL · <distro>"`.
    pub label: String,
    pub installed: bool,
    /// Installed, but not with the commands this version would write (see
    /// `is_current`): an Install… would change them.
    pub outdated: bool,
    pub settings_path: String,
    /// The relay as this target runs it: a Windows path, or its Linux path.
    pub hook_path: String,
    pub hook_ready: bool,
    /// False when a WSL distro is stopped and was deliberately not started to
    /// find out: `installed` then means "unknown", not "no".
    pub checked: bool,
    /// Why this target cannot be read or used right now.
    pub error: Option<String>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HookPreview {
    pub diff: String,
    pub backup: String,
    pub settings_path: String,
    /// Identifies the file, the bytes this diff was computed from and the result
    /// it shows; handed back to `write` so we only ever apply what the user
    /// actually looked at.
    pub fingerprint: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TargetInfo {
    pub id: String,
    pub label: String,
    /// `"windows"` or `"wsl"`.
    pub kind: String,
    pub distro: Option<String>,
}

// ── Targets ───────────────────────────────────────────────────────────────────

#[derive(Clone, Debug, PartialEq)]
pub enum Target {
    Windows,
    Wsl(String),
}

impl Target {
    /// `None` and `"windows"` mean Windows, `"wsl:<distro>"` a distro. The
    /// distro name is checked here, before it can reach a command line or a
    /// path.
    pub fn parse(id: Option<&str>) -> Result<Target, String> {
        match id.map(str::trim) {
            None | Some("") | Some("windows") => Ok(Target::Windows),
            Some(other) => match other.strip_prefix("wsl:") {
                Some(name) if wsl::is_valid_distro_name(name) => Ok(Target::Wsl(name.to_string())),
                _ => Err(format!("Unknown hook target \"{other}\".")),
            },
        }
    }

    pub fn id(&self) -> String {
        match self {
            Target::Windows => "windows".into(),
            Target::Wsl(d) => format!("wsl:{d}"),
        }
    }

    pub fn label(&self) -> String {
        match self {
            Target::Windows => "Windows".into(),
            Target::Wsl(d) => format!("WSL · {d}"),
        }
    }

    fn info(&self) -> TargetInfo {
        TargetInfo {
            id: self.id(),
            label: self.label(),
            kind: match self {
                Target::Windows => "windows".into(),
                Target::Wsl(_) => "wsl".into(),
            },
            distro: match self {
                Target::Windows => None,
                Target::Wsl(d) => Some(d.clone()),
            },
        }
    }
}

/// Windows first, then every distro that could run Claude Code. Cheap: the
/// distros come from the registry and nothing is started.
pub fn targets() -> Vec<TargetInfo> {
    std::iter::once(Target::Windows)
        .chain(wsl::distros().into_iter().map(|d| Target::Wsl(d.name)))
        .map(|t| t.info())
        .collect()
}

/// Test-only sandbox. A *side instance* (COUCOU_INSTANCE, see instance.rs)
/// started with `COUCOU_TEST_HOME=<absolute folder>` reads and writes every
/// target's settings.json inside that folder instead of the real homes:
/// `<folder>\windows\.claude\settings.json` and
/// `<folder>\wsl\<distro>\.claude\settings.json`. The relay's Linux path is
/// still asked of the real distro (read-only). The real install ignores the
/// variable entirely, so it can never be pointed anywhere by it.
pub fn test_home() -> Option<PathBuf> {
    let instance = instance::current().ok().flatten();
    test_home_for(instance.as_deref(), std::env::var_os(TEST_HOME_VAR))
}

fn test_home_for(instance: Option<&str>, value: Option<std::ffi::OsString>) -> Option<PathBuf> {
    instance?;
    let dir = PathBuf::from(value?);
    dir.is_absolute().then_some(dir)
}

fn windows_home() -> PathBuf {
    if let Some(sandbox) = test_home() {
        return sandbox.join("windows");
    }
    std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

/// Where a target's hooks go, and how its commands read. For a WSL distro this
/// asks the distro (wsl.rs), which starts it if it is stopped.
fn locate(target: &Target) -> Result<Location, String> {
    let relay = settings::hook_exe_path();
    match target {
        Target::Windows => Ok(Location::windows(&windows_home(), &relay)),
        Target::Wsl(distro) => {
            let probe = wsl::probe(distro, &relay)?;
            let settings = match test_home() {
                Some(sandbox) => sandbox.join("wsl").join(distro).join(".claude").join("settings.json"),
                None => wsl::unc_path(distro, &probe.home)?.join(".claude").join("settings.json"),
            };
            Ok(Location::wsl(settings, &probe.relay))
        }
    }
}

// ── A settings file and its commands ──────────────────────────────────────────

/// One settings.json and the hook command that goes into it.
#[derive(Clone, Debug)]
pub struct Location {
    pub settings: PathBuf,
    /// The relay's path as the target sees it (Windows or Linux), unquoted.
    pub relay_path: String,
    /// The relay as the command spells it, quoted for the shell that runs it.
    relay: String,
    /// What follows the event name: nothing on Windows, the distro on WSL.
    tail: String,
    /// A distro's file, reached through the WSL share (see `refuse_links`).
    via_wsl: bool,
}

impl Location {
    /// `"C:/…/coucou-hook.exe" <Event>` — byte for byte what earlier versions
    /// wrote, so an existing install shows no spurious diff.
    pub fn windows(home: &Path, relay_exe: &Path) -> Self {
        let exe = relay_exe.to_string_lossy().replace('\\', "/");
        Location {
            settings: home.join(".claude").join("settings.json"),
            relay_path: relay_exe.to_string_lossy().to_string(),
            relay: format!("\"{exe}\""),
            tail: String::new(),
            via_wsl: false,
        }
    }

    /// `'/mnt/c/…/coucou-hook.exe' <Event> --wsl-distro "$WSL_DISTRO_NAME" --wsl-ppid "$PPID"`.
    pub fn wsl(settings: PathBuf, relay_linux: &str) -> Self {
        Location {
            settings,
            relay_path: relay_linux.to_string(),
            relay: wsl::sh_quote(relay_linux),
            tail: format!(" {} {}", wsl::DISTRO_ARG, wsl::PPID_ARG),
            via_wsl: true,
        }
    }

    fn command(&self, event: &str) -> String {
        format!("{} {event}{}", self.relay, self.tail)
    }

    /// The entry Coucou writes for `event` — exactly one per event.
    fn entry(&self, event: &str, timeout: u64) -> Value {
        json!({
            "hooks": [{
                "type": "command",
                "command": self.command(event),
                "timeout": timeout,
            }]
        })
    }

    fn backup_path(&self) -> PathBuf {
        self.settings.with_file_name(format!("settings.json.bak-{}", stamp()))
    }
}

/// Reads a settings.json.
///
/// The only error that means "start from nothing" is the file not being there.
/// Everything else — a lock held by another process, a permission problem, JSON
/// we cannot parse — is reported, because the alternative is treating somebody's
/// unreadable settings as an empty object and then writing that back over them.
fn read_settings(path: &Path) -> Result<Value, String> {
    match std::fs::read(path) {
        Ok(bytes) => parse_settings(&bytes, &path.display().to_string()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        // A lock, a permission problem, a bad drive: all of them mean we do not
        // know what is in there, and not knowing is not the same as empty.
        Err(err) => Err(format!("Can't read {}: {err}", path.display())),
    }
}

/// The parsing half of `read_settings`, split out so it can be tested without a
/// home directory.
fn parse_settings(bytes: &[u8], path: &str) -> Result<Value, String> {
    // PowerShell writes a UTF-8 BOM with `Set-Content -Encoding utf8`, and
    // serde_json refuses it. Stripping it is safe and well defined; guessing at
    // anything else is not.
    let text = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    if text.iter().all(u8::is_ascii_whitespace) {
        return Ok(json!({}));
    }
    match serde_json::from_slice::<Value>(text) {
        Ok(v) if v.is_object() => Ok(v),
        Ok(_) => Err(format!("{path} isn't a JSON object — Coucou won't touch it.")),
        Err(err) => Err(format!(
            "{path} isn't valid JSON ({err}). Fix or move it, then try again — Coucou won't overwrite it."
        )),
    }
}

fn entry_is_ours(entry: &Value) -> bool {
    entry
        .get("hooks")
        .and_then(Value::as_array)
        .map(|hooks| {
            hooks.iter().any(|h| {
                h.get("command")
                    .and_then(Value::as_str)
                    .map(|c| c.contains(MARKER))
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

fn is_installed(settings: &Value) -> bool {
    settings
        .get("hooks")
        .and_then(Value::as_object)
        .map(|hooks| hooks.values().filter_map(Value::as_array).flatten().any(entry_is_ours))
        .unwrap_or(false)
}

/// Every event Coucou listens to has exactly one entry of ours, and it is the
/// one `merged` would write now. Where in an event's list it sits, and what
/// else is there, does not matter — so a current install never reads as
/// outdated just because another tool added a hook after ours.
fn is_current(settings: &Value, at: &Location) -> bool {
    HOOK_EVENTS.iter().all(|(event, timeout)| {
        let ours: Vec<&Value> = settings
            .get("hooks")
            .and_then(|h| h.get(*event))
            .and_then(Value::as_array)
            .map(|list| list.iter().filter(|e| entry_is_ours(e)).collect())
            .unwrap_or_default();
        ours.len() == 1 && *ours[0] == at.entry(event, *timeout)
    })
}

/// Settings with Coucou's hooks added; everything else is left untouched.
fn merged(existing: &Value, at: &Location) -> Value {
    let mut root = existing.as_object().cloned().unwrap_or_default();
    let mut hooks = root
        .get("hooks")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_else(Map::new);

    for (event, timeout) in HOOK_EVENTS {
        let mut list = hooks
            .get(*event)
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        list.retain(|entry| !entry_is_ours(entry));
        list.push(at.entry(event, *timeout));
        hooks.insert((*event).to_string(), Value::Array(list));
    }

    root.insert("hooks".into(), Value::Object(hooks));
    Value::Object(root)
}

/// Settings with every Coucou entry removed, and nothing else changed.
fn without_ours(existing: &Value) -> Value {
    let mut root = existing.as_object().cloned().unwrap_or_default();
    let Some(hooks) = root.get("hooks").and_then(Value::as_object).cloned() else {
        return Value::Object(root);
    };
    let mut out = Map::new();
    for (event, value) in hooks {
        match value.as_array() {
            Some(list) => {
                let kept: Vec<Value> =
                    list.iter().filter(|e| !entry_is_ours(e)).cloned().collect();
                if !kept.is_empty() {
                    out.insert(event, Value::Array(kept));
                }
            }
            None => {
                out.insert(event, value);
            }
        }
    }
    if out.is_empty() {
        root.remove("hooks");
    } else {
        root.insert("hooks".into(), Value::Object(out));
    }
    Value::Object(root)
}

fn next_settings(current: &Value, at: &Location, install: bool) -> Value {
    if install { merged(current, at) } else { without_ours(current) }
}

fn pretty(v: &Value) -> String {
    serde_json::to_string_pretty(v).unwrap_or_default()
}

/// What gets written: pretty JSON with a final newline.
fn file_text(v: &Value) -> String {
    let mut text = pretty(v);
    text.push('\n');
    text
}

/// Down to the second: installing then uninstalling in the same minute must not
/// quietly overwrite the first backup.
fn stamp() -> String {
    let t = unsafe { GetLocalTime() };
    format!(
        "{:04}{:02}{:02}-{:02}{:02}{:02}",
        t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond
    )
}

/// Identifies exact bytes. FNV-1a is plenty: the question is only "is this
/// still what I showed the user?".
fn fingerprint(bytes: &[u8]) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x1000_0000_01b3);
    }
    format!("{hash:016x}")
}

/// The file, its current bytes and the text that would replace them. If any of
/// the three moved since the preview — another tool edited the file, the
/// distro's home changed, the relay moved — the write is refused.
fn plan_fingerprint(path: &Path, current: &[u8], next: &str) -> String {
    let mut all = path.to_string_lossy().as_bytes().to_vec();
    all.push(0);
    all.extend_from_slice(current);
    all.push(0);
    all.extend_from_slice(next.as_bytes());
    fingerprint(&all)
}

fn current_bytes(path: &Path) -> Vec<u8> {
    std::fs::read(path).unwrap_or_default()
}

/// `FILE_ATTRIBUTE_REPARSE_POINT`.
const REPARSE_POINT: u32 = 0x400;

/// A settings.json that is a symbolic link (a dotfiles repo, typically) would
/// be replaced by a plain file by the write-and-rename below, silently cutting
/// it loose from wherever it points. Refused instead.
///
/// Through `\\wsl.localhost` it is worse: Windows cannot follow a Linux
/// symlink at all, so reading one fails as "not found" — which would read as
/// "no settings yet", and the write would put a file holding nothing but
/// Coucou's hooks where the link was. Over the WSL share every reparse point
/// (that is how Linux links and special files show up) is refused, for the
/// file and for the `.claude` folder above it. On Windows only real links are:
/// OneDrive placeholders are reparse points too, and perfectly writable.
fn refuse_links(at: &Location) -> Result<(), String> {
    use std::os::windows::fs::MetadataExt;
    let check = |path: &Path| match std::fs::symlink_metadata(path) {
        Ok(meta)
            if meta.file_type().is_symlink()
                || (at.via_wsl && meta.file_attributes() & REPARSE_POINT != 0) =>
        {
            Err(format!(
                "{} is a symbolic link. Coucou won't replace it with a plain file — add the hooks to the file it points to by hand, or replace the link first.",
                path.display()
            ))
        }
        _ => Ok(()),
    };
    check(&at.settings)?;
    if at.via_wsl {
        if let Some(dir) = at.settings.parent() {
            check(dir)?;
        }
    }
    Ok(())
}

/// What a target's settings.json says about Coucou.
#[derive(Debug, Clone, PartialEq)]
pub struct InstallState {
    pub installed: bool,
    /// Installed with commands other than the ones this version writes.
    pub outdated: bool,
    pub error: Option<String>,
}

pub fn status_at(at: &Location) -> InstallState {
    let failed = |err| InstallState { installed: false, outdated: false, error: Some(err) };
    if let Err(err) = refuse_links(at) {
        return failed(err);
    }
    match read_settings(&at.settings) {
        Ok(v) => {
            let installed = is_installed(&v);
            InstallState { installed, outdated: installed && !is_current(&v, at), error: None }
        }
        Err(err) => failed(err),
    }
}

pub fn preview_at(at: &Location, install: bool) -> Result<HookPreview, String> {
    refuse_links(at)?;
    let current = read_settings(&at.settings)?;
    let next = next_settings(&current, at, install);
    Ok(HookPreview {
        diff: unified_diff(&pretty(&current), &pretty(&next)),
        backup: at.backup_path().to_string_lossy().to_string(),
        settings_path: at.settings.to_string_lossy().to_string(),
        fingerprint: plan_fingerprint(&at.settings, &current_bytes(&at.settings), &file_text(&next)),
    })
}

/// Writes the merged (or cleaned) settings after taking a dated backup.
///
/// `fingerprint` is the one the preview was computed from. If the file changed
/// in between — another tool, another window, the user's own editor — we stop
/// and make them look at a fresh diff, because the only thing worse than not
/// installing the hooks is silently reverting somebody else's edit.
pub fn write_at(at: &Location, install: bool, fingerprint: &str) -> Result<String, String> {
    let path = &at.settings;
    refuse_links(at)?;

    // Read before the backup: an unreadable file must abort before we touch
    // anything at all.
    let current = read_settings(path)?;
    let next = file_text(&next_settings(&current, at, install));
    if plan_fingerprint(path, &current_bytes(path), &next) != fingerprint {
        return Err(format!(
            "{} changed since the preview. Nothing was written — review the new diff.",
            path.display()
        ));
    }

    let dir = path.parent().unwrap_or(Path::new("."));
    std::fs::create_dir_all(dir).map_err(|e| format!("Can't create {}: {e}", dir.display()))?;

    let backup = at.backup_path();
    if path.exists() {
        std::fs::copy(path, &backup).map_err(|e| format!("backup failed: {e}"))?;
    }

    // Write beside the target and rename over it: a crash or a full disk leaves
    // the original settings.json intact rather than half a file.
    let temp = path.with_extension(format!("json.coucou-{}", std::process::id()));
    std::fs::write(&temp, next.as_bytes()).map_err(|e| format!("write failed: {e}"))?;
    if let Err(err) = std::fs::rename(&temp, path) {
        let _ = std::fs::remove_file(&temp);
        return Err(format!("write failed: {err}"));
    }
    Ok(backup.to_string_lossy().to_string())
}

// ── Public API, by target ─────────────────────────────────────────────────────

/// The Windows target, synchronously — cheap, and what `boot` reports.
pub fn status() -> HookStatus {
    status_of(&Target::Windows, false)
}

/// `start`: whether a stopped WSL distro may be started to find out. Without
/// it a stopped distro comes back `checked: false`, so opening the settings
/// window never boots a WSL VM behind the user's back.
pub fn status_of(target: &Target, start: bool) -> HookStatus {
    let mut status = HookStatus {
        target: target.id(),
        label: target.label(),
        checked: true,
        ..HookStatus::default()
    };
    if let Target::Wsl(distro) = target {
        if !start {
            match wsl::running() {
                Ok(list) if list.iter().any(|d| d.eq_ignore_ascii_case(distro)) => {}
                Ok(_) => {
                    status.checked = false;
                    return status;
                }
                Err(err) => {
                    status.error = Some(err);
                    return status;
                }
            }
        }
    }
    let at = match locate(target) {
        Ok(at) => at,
        Err(err) => {
            status.error = Some(err);
            return status;
        }
    };
    let state = status_at(&at);
    status.installed = state.installed;
    status.outdated = state.outdated;
    status.error = state.error;
    status.settings_path = at.settings.to_string_lossy().to_string();
    status.hook_ready = settings::hook_exe_path().exists();
    status.hook_path = at.relay_path;
    status
}

pub fn preview(target: &Target, install: bool) -> Result<HookPreview, String> {
    preview_at(&locate(target)?, install)
}

pub fn write(target: &Target, install: bool, fingerprint: &str) -> Result<String, String> {
    if install && !settings::hook_exe_path().exists() {
        // Hook commands pointing at a relay that isn't there would give every
        // Claude Code session a broken hook.
        return Err("coucou-hook.exe is not in place yet — restart Coucou and try again.".into());
    }
    write_at(&locate(target)?, install, fingerprint)
}

/// Copies coucou-hook.exe into %LOCALAPPDATA%\Coucou\bin on launch.
/// In a bundled install it comes from the app resources; in `tauri dev` it sits
/// next to coucou.exe in the workspace target directory.
///
/// Every candidate is tried rather than just the first, because getting this
/// wrong is silent and fatal: `resources` used to be a glob, which made NSIS
/// mirror the source path into `_up_\target\release\`, no candidate matched, and
/// the relay was simply never installed. It only looked healthy on a developer
/// machine, where a leftover copy from `tauri dev` was already sitting in bin/.
pub fn ensure_hook_exe(app: &AppHandle) {
    let dest = settings::hook_exe_path();
    let Some(dir) = dest.parent() else { return };
    if std::fs::create_dir_all(dir).is_err() {
        return;
    }

    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(p) = app.path().resolve("coucou-hook.exe", tauri::path::BaseDirectory::Resource) {
        candidates.push(p);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            // Installed build, then `tauri dev` (target/debug) next to the
            // release hook the pre-build step produces.
            candidates.push(parent.join("coucou-hook.exe"));
            candidates.push(parent.join("../release/coucou-hook.exe"));
            // Belt and braces: where the old glob form used to land it.
            candidates.push(parent.join("_up_/target/release/coucou-hook.exe"));
        }
    }

    let tried: Vec<String> = candidates.iter().map(|p| p.display().to_string()).collect();
    let Some(src) = candidates.into_iter().find(|p| p.exists()) else {
        crate::log::line(format!(
            "coucou-hook.exe not found — Claude Code hooks cannot work. Looked in: {}",
            tried.join(", ")
        ));
        return;
    };

    let same = match (std::fs::metadata(&src), std::fs::metadata(&dest)) {
        (Ok(a), Ok(b)) => a.len() == b.len() && a.modified().ok() == b.modified().ok(),
        _ => false,
    };
    if same {
        return;
    }
    // A hook may be running right now and hold the file open; keeping the old
    // copy is fine, it is the same relay.
    if let Err(err) = std::fs::copy(&src, &dest) {
        if !dest.exists() {
            crate::log::line(format!("could not install coucou-hook.exe: {err}"));
        }
    }
}

// ── Minimal unified diff (LCS) ────────────────────────────────────────────────

/// settings.json is short, so a plain O(n·m) LCS is the simplest honest diff.
fn unified_diff(before: &str, after: &str) -> String {
    let a: Vec<&str> = before.lines().collect();
    let b: Vec<&str> = after.lines().collect();
    let (n, m) = (a.len(), b.len());

    let mut lcs = vec![vec![0usize; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            lcs[i][j] = if a[i] == b[j] {
                lcs[i + 1][j + 1] + 1
            } else {
                lcs[i + 1][j].max(lcs[i][j + 1])
            };
        }
    }

    let mut out: Vec<String> = Vec::new();
    let (mut i, mut j) = (0usize, 0usize);
    while i < n && j < m {
        if a[i] == b[j] {
            out.push(format!("  {}", a[i]));
            i += 1;
            j += 1;
        } else if lcs[i + 1][j] >= lcs[i][j + 1] {
            out.push(format!("- {}", a[i]));
            i += 1;
        } else {
            out.push(format!("+ {}", b[j]));
            j += 1;
        }
    }
    while i < n {
        out.push(format!("- {}", a[i]));
        i += 1;
    }
    while j < m {
        out.push(format!("+ {}", b[j]));
        j += 1;
    }

    // Keep three lines of context around each change so the panel stays readable.
    let changed: Vec<usize> = out
        .iter()
        .enumerate()
        .filter(|(_, l)| l.starts_with('+') || l.starts_with('-'))
        .map(|(i, _)| i)
        .collect();
    if changed.is_empty() {
        return "No change.".into();
    }
    let mut keep = vec![false; out.len()];
    for idx in changed {
        let lo = idx.saturating_sub(3);
        let hi = (idx + 4).min(out.len());
        for k in lo..hi {
            keep[k] = true;
        }
    }
    let mut result = String::new();
    let mut gap = false;
    for (idx, line) in out.iter().enumerate() {
        if keep[idx] {
            result.push_str(line);
            result.push('\n');
            gap = false;
        } else if !gap {
            result.push_str("  …\n");
            gap = true;
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    const WHERE: &str = "settings.json";

    /// A fresh, empty folder under %TEMP% for one test. Never a real home.
    fn sandbox(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("coucou-hooks-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".claude")).unwrap();
        dir
    }

    fn windows_at(home: &Path) -> Location {
        Location::windows(home, Path::new(r"C:\Users\Test User\AppData\Local\Coucou\bin\coucou-hook.exe"))
    }

    fn wsl_at(home: &Path) -> Location {
        Location::wsl(
            home.join(".claude").join("settings.json"),
            "/mnt/c/Users/Test User/AppData/Local/Coucou/bin/coucou-hook.exe",
        )
    }

    #[test]
    fn a_utf8_bom_is_stripped_not_treated_as_corruption() {
        // PowerShell 5's `Set-Content -Encoding utf8` produces exactly this.
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice(br#"{"model":"opus","hooks":{}}"#);
        let parsed = parse_settings(&bytes, WHERE).expect("a BOM must not defeat the parser");
        assert_eq!(parsed["model"], "opus");
    }

    #[test]
    fn unreadable_content_is_an_error_never_an_empty_object() {
        // This is the whole bug: returning {} here meant `merged()` produced a
        // file containing nothing but Coucou's hooks, and the write replaced
        // everything the user had.
        for bad in [&b"{ not json"[..], &b"[1,2,3]"[..], &b"\"a string\""[..]] {
            assert!(
                parse_settings(bad, WHERE).is_err(),
                "content we cannot use must refuse, not come back empty"
            );
        }
    }

    #[test]
    fn empty_and_whitespace_files_start_from_nothing() {
        assert_eq!(parse_settings(b"", WHERE).unwrap(), json!({}));
        assert_eq!(parse_settings(b"  \n\t ", WHERE).unwrap(), json!({}));
    }

    #[test]
    fn merging_keeps_every_other_setting_and_every_foreign_hook() {
        let existing = serde_json::json!({
            "model": "claude-opus-5",
            "theme": "dark",
            "enabledPlugins": ["a", "b"],
            "hooks": {
                "PreToolUse": [
                    { "hooks": [{ "type": "command", "command": "someone-elses-tool.exe" }] }
                ],
                "SomeEventWeDoNotTouch": [
                    { "hooks": [{ "type": "command", "command": "keep-me.exe" }] }
                ]
            }
        });

        for at in [windows_at(Path::new(r"C:\h")), wsl_at(Path::new(r"C:\h"))] {
            let after = merged(&existing, &at);
            assert_eq!(after["model"], "claude-opus-5");
            assert_eq!(after["theme"], "dark");
            assert_eq!(after["enabledPlugins"], serde_json::json!(["a", "b"]));

            let pre = after["hooks"]["PreToolUse"].as_array().unwrap();
            assert!(
                pre.iter().any(|e| serde_json::to_string(e).unwrap().contains("someone-elses-tool.exe")),
                "another tool's hook was dropped"
            );
            assert!(pre.iter().any(entry_is_ours), "our own hook was not added");
            assert!(after["hooks"]["SomeEventWeDoNotTouch"].is_array());
            assert!(is_installed(&after));

            // And removing ours puts it back exactly as it was.
            let cleaned = without_ours(&after);
            assert_eq!(cleaned, existing);
            assert!(!is_installed(&cleaned));
        }
    }

    #[test]
    fn the_windows_command_is_unchanged_byte_for_byte() {
        // An install made by an earlier version must not show up as a change.
        assert_eq!(
            windows_at(Path::new(r"C:\h")).command("PreToolUse"),
            r#""C:/Users/Test User/AppData/Local/Coucou/bin/coucou-hook.exe" PreToolUse"#
        );
    }

    #[test]
    fn the_wsl_command_runs_the_windows_relay_by_its_linux_path() {
        let at = wsl_at(Path::new(r"C:\h"));
        assert_eq!(
            at.command("PermissionRequest"),
            r#"'/mnt/c/Users/Test User/AppData/Local/Coucou/bin/coucou-hook.exe' PermissionRequest --wsl-distro "$WSL_DISTRO_NAME" --wsl-ppid "$PPID""#
        );
        let after = merged(&json!({}), &at);
        let entry = &after["hooks"]["PermissionRequest"][0]["hooks"][0];
        assert_eq!(entry["timeout"], 120);
        assert_eq!(entry["type"], "command");
        // Every event is there, each pointing at the relay with the distro.
        for (event, _) in HOOK_EVENTS {
            let cmd = after["hooks"][*event][0]["hooks"][0]["command"].as_str().unwrap();
            assert!(cmd.contains(&format!(" {event} --wsl-distro ")), "{cmd}");
            assert!(cmd.ends_with(r#" --wsl-ppid "$PPID""#), "{cmd}");
        }
    }

    /// The WSL command as Coucou wrote it before `--wsl-ppid` existed.
    fn old_wsl_entry(event: &str, timeout: u64) -> Value {
        json!({ "hooks": [{
            "type": "command",
            "command": format!(
                r#"'/mnt/c/Users/Test User/AppData/Local/Coucou/bin/coucou-hook.exe' {event} --wsl-distro "$WSL_DISTRO_NAME""#
            ),
            "timeout": timeout,
        }]})
    }

    fn old_wsl_install() -> Value {
        let mut hooks = Map::new();
        for (event, timeout) in HOOK_EVENTS {
            hooks.insert((*event).into(), json!([old_wsl_entry(event, *timeout)]));
        }
        json!({ "model": "opus", "hooks": hooks })
    }

    #[test]
    fn an_install_from_before_wsl_ppid_is_outdated_and_only_in_wsl() {
        let wsl = wsl_at(Path::new(r"C:\h"));
        let old = old_wsl_install();
        assert!(is_installed(&old));
        assert!(!is_current(&old, &wsl), "the WSL command changed: outdated");
        // Updating is an ordinary install: it replaces our entries, and only ours.
        let updated = merged(&old, &wsl);
        assert!(is_current(&updated, &wsl));
        assert_eq!(updated["model"], "opus");
        assert_eq!(updated["hooks"]["Stop"].as_array().unwrap().len(), 1);

        // The Windows command never changed: an earlier Windows install is current.
        let win = windows_at(Path::new(r"C:\h"));
        let earlier = json!({ "hooks": {
            "PreToolUse": [{ "hooks": [{ "type": "command",
                "command": r#""C:/Users/Test User/AppData/Local/Coucou/bin/coucou-hook.exe" PreToolUse"#,
                "timeout": 10 }] }]
        }});
        let mut full = merged(&json!({}), &win);
        full["hooks"]["PreToolUse"] = earlier["hooks"]["PreToolUse"].clone();
        assert!(is_current(&full, &win));
    }

    #[test]
    fn current_means_exactly_one_entry_of_ours_per_event_wherever_it_sits() {
        let at = wsl_at(Path::new(r"C:\h"));
        let fresh = merged(&json!({}), &at);
        assert!(is_current(&fresh, &at));

        // Another tool's hook before or after ours changes nothing.
        let mut shuffled = fresh.clone();
        let other = json!({ "hooks": [{ "type": "command", "command": "other-tool" }] });
        shuffled["hooks"]["Stop"].as_array_mut().unwrap().push(other.clone());
        shuffled["hooks"]["PreToolUse"].as_array_mut().unwrap().insert(0, other);
        assert!(is_current(&shuffled, &at));

        // A missing event, a duplicate, a different timeout or an edited
        // command: an Install… would change it, so it is outdated.
        let mut missing = fresh.clone();
        missing["hooks"].as_object_mut().unwrap().remove("SubagentStop");
        let mut twice = fresh.clone();
        let stop = twice["hooks"]["Stop"][0].clone();
        twice["hooks"]["Stop"].as_array_mut().unwrap().push(stop);
        let mut timeout = fresh.clone();
        timeout["hooks"]["PermissionRequest"][0]["hooks"][0]["timeout"] = json!(60);
        let mut edited = fresh.clone();
        edited["hooks"]["Stop"][0]["hooks"][0]["async"] = json!(true);
        for (name, v) in [("missing", &missing), ("twice", &twice), ("timeout", &timeout), ("edited", &edited)] {
            assert!(is_installed(v), "{name}");
            assert!(!is_current(v, &at), "{name}");
            assert!(is_current(&merged(v, &at), &at), "{name}: reinstalling fixes it");
        }
        // Nothing installed is not "outdated" (status_at only asks when installed).
        assert!(!is_current(&json!({}), &at));
    }

    #[test]
    fn an_outdated_wsl_install_is_updated_through_the_same_consent_flow() {
        let home = sandbox("outdated");
        let at = wsl_at(&home);
        let original = serde_json::to_vec_pretty(&old_wsl_install()).unwrap();
        std::fs::write(&at.settings, &original).unwrap();
        assert_eq!(status_at(&at), InstallState { installed: true, outdated: true, error: None });

        let plan = preview_at(&at, true).unwrap();
        // The diff shows exactly the change: old command out, new one in.
        assert!(plan.diff.lines().any(|l| l.starts_with("- ") && l.ends_with(r#"--wsl-distro \"$WSL_DISTRO_NAME\"","#)));
        assert!(plan.diff.lines().any(|l| l.starts_with("+ ") && l.contains(r#"--wsl-ppid \"$PPID\""#)));
        let backup = write_at(&at, true, &plan.fingerprint).unwrap();
        assert_eq!(std::fs::read(&backup).unwrap(), original, "the backup holds the old install");
        assert_eq!(status_at(&at), InstallState { installed: true, outdated: false, error: None });
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn reinstalling_replaces_our_entries_instead_of_stacking_them() {
        let at = wsl_at(Path::new(r"C:\h"));
        let once = merged(&json!({}), &at);
        let twice = merged(&once, &at);
        assert_eq!(once, twice);
        // A Windows-style entry left in a distro's file is ours too, and replaced.
        let mixed = merged(&merged(&json!({}), &windows_at(Path::new(r"C:\h"))), &at);
        assert_eq!(mixed["hooks"]["Stop"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn foreign_hooks_that_call_windows_tools_from_wsl_are_kept() {
        // Shaped like the real thing: a WSL settings.json whose own hooks call
        // powershell.exe through interop.
        let existing = json!({
            "hooks": {
                "Notification": [{ "hooks": [{ "type": "command",
                    "command": "powershell.exe -NoProfile -File \"C:\\\\Users\\\\u\\\\.claude\\\\notify.ps1\"", "async": true }] }],
                "Stop": [{ "hooks": [{ "type": "command", "command": "powershell.exe -File x.ps1", "async": true }] }]
            }
        });
        let at = wsl_at(Path::new(r"C:\h"));
        let after = merged(&existing, &at);
        assert_eq!(after["hooks"]["Stop"].as_array().unwrap().len(), 2);
        assert_eq!(after["hooks"]["Stop"][0], existing["hooks"]["Stop"][0]);
        assert_eq!(without_ours(&after), existing);
    }

    #[test]
    fn a_fingerprint_notices_any_change() {
        assert_eq!(fingerprint(b"{}"), fingerprint(b"{}"));
        assert_ne!(fingerprint(b"{}"), fingerprint(b"{ }"));
        assert_ne!(fingerprint(b""), fingerprint(b"{}"));
        // The plan covers the file, its bytes and the result.
        let p = Path::new(r"C:\a\settings.json");
        let base = plan_fingerprint(p, b"{}", "x");
        assert_ne!(base, plan_fingerprint(Path::new(r"C:\b\settings.json"), b"{}", "x"));
        assert_ne!(base, plan_fingerprint(p, b"{ }", "x"));
        assert_ne!(base, plan_fingerprint(p, b"{}", "y"));
    }

    #[test]
    fn targets_parse_and_refuse_strange_distros() {
        assert_eq!(Target::parse(None), Ok(Target::Windows));
        assert_eq!(Target::parse(Some("windows")), Ok(Target::Windows));
        assert_eq!(Target::parse(Some("wsl:Ubuntu-24.04")), Ok(Target::Wsl("Ubuntu-24.04".into())));
        assert_eq!(Target::Wsl("Ubuntu-24.04".into()).label(), "WSL · Ubuntu-24.04");
        assert_eq!(Target::Wsl("Debian".into()).id(), "wsl:Debian");
        for bad in ["wsl:", "wsl:a b", "wsl:../x", r"wsl:a\b", "linux", "wsl:$(id)"] {
            assert!(Target::parse(Some(bad)).is_err(), "{bad}");
        }
    }

    #[test]
    fn the_test_home_is_for_side_instances_only() {
        let dir = || Some(std::ffi::OsString::from(r"C:\sandbox"));
        // The real install never honours it, whatever the variable says.
        assert_eq!(test_home_for(None, dir()), None);
        assert_eq!(test_home_for(Some("e2e"), dir()), Some(PathBuf::from(r"C:\sandbox")));
        assert_eq!(test_home_for(Some("e2e"), None), None);
        // A relative folder would land wherever the app happens to run.
        assert_eq!(test_home_for(Some("e2e"), Some("sandbox".into())), None);
    }

    /// The whole consent flow on disk, for both kinds of target, in temp folders.
    #[test]
    fn writing_backs_up_preserves_and_refuses_a_changed_file() {
        for (name, at) in [("win", windows_at as fn(&Path) -> Location), ("wsl", wsl_at)] {
            let home = sandbox(name);
            let at = at(&home);
            let path = at.settings.clone();
            assert!(path.starts_with(&home), "the test must not touch a real home");

            // A real-shaped file, written the way PowerShell 5 would: UTF-8 with BOM.
            let original = r#"{"model":"claude-opus-5","theme":"dark","tui":{"x":1},"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"other-tool.exe"}]}]}}"#;
            let mut bytes = vec![0xEF, 0xBB, 0xBF];
            bytes.extend_from_slice(original.as_bytes());
            std::fs::write(&path, &bytes).unwrap();

            // Install.
            let plan = preview_at(&at, true).expect("a BOM must not stop the preview");
            assert!(plan.diff.contains("coucou-hook"), "the diff must show what changes");
            assert_eq!(plan.settings_path, path.to_string_lossy());
            let backup = write_at(&at, true, &plan.fingerprint).expect("install should succeed");

            // The backup holds the original bytes, BOM and all, next to the file.
            assert_eq!(std::fs::read(&backup).unwrap(), bytes);
            assert_eq!(Path::new(&backup).parent(), path.parent());

            // Everything else survived, and so did the other tool's hook.
            let after: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            assert_eq!(after["model"], "claude-opus-5");
            assert_eq!(after["theme"], "dark");
            assert_eq!(after["tui"]["x"], 1);
            let pre = after["hooks"]["PreToolUse"].as_array().unwrap();
            assert!(pre.iter().any(|e| serde_json::to_string(e).unwrap().contains("other-tool.exe")));
            assert_eq!(status_at(&at), InstallState { installed: true, outdated: false, error: None });
            // What was written is exactly the text the preview promised.
            assert_eq!(after["hooks"]["Stop"][0]["hooks"][0]["command"], at.command("Stop"));

            // A file that moved since the preview is refused, and left alone.
            let stale = preview_at(&at, false).unwrap();
            std::fs::write(&path, br#"{"model":"someone-else-edited-this"}"#).unwrap();
            let err = write_at(&at, false, &stale.fingerprint).unwrap_err();
            assert!(err.contains("changed since the preview"), "got: {err}");
            let untouched: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            assert_eq!(untouched["model"], "someone-else-edited-this");

            // Uninstall from a fresh preview removes ours and only ours.
            std::fs::write(&path, &bytes).unwrap();
            let plan = preview_at(&at, true).unwrap();
            write_at(&at, true, &plan.fingerprint).unwrap();
            let plan = preview_at(&at, false).unwrap();
            write_at(&at, false, &plan.fingerprint).unwrap();
            let cleaned: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            assert_eq!(cleaned, serde_json::from_str::<Value>(original).unwrap());

            // Content we cannot parse is refused before anything is written.
            std::fs::write(&path, b"{ broken").unwrap();
            assert!(preview_at(&at, true).is_err());
            assert!(write_at(&at, true, "whatever").is_err());
            assert_eq!(std::fs::read(&path).unwrap(), b"{ broken");

            // No settings.json yet (Claude Code never ran there): created, no backup.
            let _ = std::fs::remove_dir_all(home.join(".claude"));
            let plan = preview_at(&at, true).unwrap();
            let backup = write_at(&at, true, &plan.fingerprint).unwrap();
            assert!(!Path::new(&backup).exists());
            assert!(status_at(&at).installed);

            // No temp file is ever left behind.
            let leftovers: Vec<_> = std::fs::read_dir(home.join(".claude"))
                .unwrap()
                .filter_map(|e| e.ok())
                .filter(|e| e.file_name().to_string_lossy().contains(".coucou-"))
                .collect();
            assert!(leftovers.is_empty());

            let _ = std::fs::remove_dir_all(&home);
        }
    }

    /// The real targets on this machine, read-only: lists them and reads each
    /// one's status — including a running distro's real settings.json through
    /// `\\wsl.localhost`. Nothing is written. Ignored by default (needs a real
    /// home, and WSL for the distro rows):
    /// `cargo test -p coucou --lib -- --ignored --nocapture live_status`.
    #[test]
    #[ignore]
    fn live_status_of_every_target_read_only() {
        for info in targets() {
            let target = Target::parse(Some(&info.id)).unwrap();
            let status = status_of(&target, false);
            eprintln!("{status:?}");
            assert!(status.error.is_none(), "{}: {:?}", info.id, status.error);
        }
    }

    /// Through the WSL share a link cannot be followed, so a `.claude` folder
    /// that is any kind of reparse point is refused there; on Windows a
    /// junctioned `.claude` is an ordinary place to write. A junction needs no
    /// privilege to create, unlike a symlink.
    #[test]
    fn a_linked_claude_folder_is_refused_through_wsl_only() {
        let home = sandbox("junction");
        let _ = std::fs::remove_dir_all(home.join(".claude"));
        let real = home.join("real-claude");
        std::fs::create_dir_all(&real).unwrap();
        let made = Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(home.join(".claude"))
            .arg(&real)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if !made {
            eprintln!("could not create a junction here — link check not exercised");
            let _ = std::fs::remove_dir_all(&home);
            return;
        }

        let wsl = wsl_at(&home);
        assert!(preview_at(&wsl, true).unwrap_err().contains("symbolic link"));
        assert!(write_at(&wsl, true, "x").unwrap_err().contains("symbolic link"));
        assert!(status_at(&wsl).error.unwrap().contains("symbolic link"));

        let win = windows_at(&home);
        let plan = preview_at(&win, true).expect("a junctioned .claude is fine on Windows");
        write_at(&win, true, &plan.fingerprint).unwrap();
        assert!(real.join("settings.json").is_file(), "written through the junction");

        // Remove the junction itself, never what it points to.
        let _ = std::fs::remove_dir(home.join(".claude"));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn a_symlinked_settings_file_is_refused_not_replaced() {
        let home = sandbox("link");
        let real = home.join("dotfiles-settings.json");
        std::fs::write(&real, b"{}").unwrap();
        let at = windows_at(&home);
        // Creating a symlink needs Developer Mode or elevation; skip quietly
        // where the OS refuses — the check itself is a one-liner.
        if std::os::windows::fs::symlink_file(&real, &at.settings).is_ok() {
            assert!(preview_at(&at, true).unwrap_err().contains("symbolic link"));
            assert!(write_at(&at, true, "x").unwrap_err().contains("symbolic link"));
            assert_eq!(std::fs::read(&real).unwrap(), b"{}");
        } else {
            eprintln!("symlinks need Developer Mode or elevation here — symlink check not exercised");
        }
        let _ = std::fs::remove_dir_all(&home);
    }
}
