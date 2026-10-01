//! Which Coucou this process belongs to: the real one, or an isolated side
//! instance for development and automated tests.
//!
//! Shared verbatim by coucou-hook.exe and coucou.exe (the app pulls this file in
//! with `#[path]`), so both ends of the relay derive their names from the same
//! code and cannot drift apart.
//!
//! Why it exists: a developer machine usually has the real Coucou installed and
//! running, wired into `~/.claude/settings.json`. A dev build or a test run that
//! used the same pipe, data folders, Credential Manager entries or Tauri
//! identifier would talk to that install — read its keys, write its log, answer
//! its approvals, or make the single-instance plugin hand the launch over to it.
//! Setting `COUCOU_INSTANCE=<name>` moves every one of those somewhere else:
//!
//! | what                 | real install              | `COUCOU_INSTANCE=dev`         |
//! |----------------------|---------------------------|-------------------------------|
//! | relay pipe           | `\\.\pipe\coucou-<sid>`   | `\\.\pipe\coucou-dev-<sid>`   |
//! | log, bin/, inbox/    | `%LOCALAPPDATA%\Coucou`   | `%LOCALAPPDATA%\Coucou-dev`   |
//! | settings.json        | `%APPDATA%\Coucou`        | `%APPDATA%\Coucou-dev`        |
//! | Credential Manager   | `fr.louisraille.coucou`   | `fr.louisraille.coucou.dev`   |
//! | Tauri identifier     | `fr.louisraille.coucou`   | `fr.louisraille.coucou.dev`   |
//! | autostart entry      | `Coucou`                  | `Coucou-dev`                  |
//!
//! The identifier is what tauri-plugin-single-instance names its mutex after,
//! and where Tauri puts the WebView2 profile (`%LOCALAPPDATA%\<identifier>`).
//!
//! Unset or blank means the real install, exactly as before this existed. A
//! value that is not a usable name never falls back to the real install: both
//! executables refuse to run with it.

// Two crates compile this file and each uses a different part of it.
#![allow(dead_code)]

/// The environment variable read by both coucou.exe and coucou-hook.exe.
pub const ENV_VAR: &str = "COUCOU_INSTANCE";

/// Longest accepted instance name. It ends up in a pipe name, two folder names
/// and an identifier, so it stays short.
const MAX_LEN: usize = 32;

/// `None` for the real install, `Some(name)` for a side instance, or an error
/// when the variable holds something that cannot be used as a name.
pub fn current() -> Result<Option<String>, String> {
    match std::env::var_os(ENV_VAR) {
        None => Ok(None),
        Some(raw) => match raw.to_str() {
            Some(text) => parse(Some(text)),
            None => Err(format!("{ENV_VAR} is not valid Unicode")),
        },
    }
}

/// The rules behind `current()`: surrounding blanks ignored, case folded, then
/// 1–32 ASCII letters or digits. Nothing else is accepted, so the name is safe
/// in a pipe name, a folder name and a reverse-DNS identifier alike.
pub fn parse(raw: Option<&str>) -> Result<Option<String>, String> {
    let Some(text) = raw.map(str::trim).filter(|t| !t.is_empty()) else {
        return Ok(None);
    };
    let name = text.to_ascii_lowercase();
    if name.len() <= MAX_LEN && name.bytes().all(|b| b.is_ascii_alphanumeric()) {
        Ok(Some(name))
    } else {
        Err(format!(
            "{ENV_VAR}={text:?} is not a usable instance name (1-{MAX_LEN} ASCII letters or digits)"
        ))
    }
}

/// What every derived name is built from. An unusable value is unreachable here
/// in practice — both executables check `current()` first and refuse to start —
/// but if it ever got this far it still must not mean the real install.
fn effective() -> Option<String> {
    current().unwrap_or_else(|_| Some("invalid".into()))
}

/// `""` for the real install, `"<sep><name>"` for a side instance: `-dev` for
/// folders and the pipe, `.dev` for the identifier and the Credential Manager.
pub fn suffix(sep: char) -> String {
    suffix_for(effective().as_deref(), sep)
}

pub fn suffix_for(instance: Option<&str>, sep: char) -> String {
    match instance {
        Some(name) => format!("{sep}{name}"),
        None => String::new(),
    }
}

/// The relay pipe for this process's instance. `user` is the account SID (see
/// pipe_path() in the hook and pipe_name() in the app).
pub fn pipe_name(user: &str) -> String {
    pipe_name_for(user, effective().as_deref())
}

/// `\\.\pipe\coucou-<user>`, or `\\.\pipe\coucou-<instance>-<user>`.
pub fn pipe_name_for(user: &str, instance: Option<&str>) -> String {
    format!(r"\\.\pipe\coucou{}-{user}", suffix_for(instance, '-'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unset_or_blank_is_the_real_install() {
        assert_eq!(parse(None), Ok(None));
        assert_eq!(parse(Some("")), Ok(None));
        assert_eq!(parse(Some("   ")), Ok(None));
    }

    #[test]
    fn names_are_trimmed_and_lowercased() {
        assert_eq!(parse(Some("dev")), Ok(Some("dev".into())));
        assert_eq!(parse(Some(" E2E ")), Ok(Some("e2e".into())));
        assert_eq!(parse(Some(&"a".repeat(MAX_LEN))), Ok(Some("a".repeat(MAX_LEN))));
    }

    #[test]
    fn unusable_names_are_refused_never_mapped_to_the_real_install() {
        for bad in ["my dev", "dev-1", "dev.x", "../x", "dév", r"a\b", "x/y"] {
            assert!(parse(Some(bad)).is_err(), "{bad:?} should be refused");
        }
        assert!(parse(Some(&"a".repeat(MAX_LEN + 1))).is_err());
    }

    #[test]
    fn suffixes_use_the_separator_they_are_given() {
        assert_eq!(suffix_for(None, '-'), "");
        assert_eq!(suffix_for(None, '.'), "");
        assert_eq!(suffix_for(Some("dev"), '-'), "-dev");
        assert_eq!(suffix_for(Some("dev"), '.'), ".dev");
    }

    /// The production pipe name is a contract with every coucou-hook.exe already
    /// installed out there; it must not change by a single byte.
    #[test]
    fn pipe_names() {
        let sid = "S-1-5-21-1111-2222-3333-1001";
        assert_eq!(pipe_name_for(sid, None), r"\\.\pipe\coucou-S-1-5-21-1111-2222-3333-1001");
        assert_eq!(
            pipe_name_for(sid, Some("dev")),
            r"\\.\pipe\coucou-dev-S-1-5-21-1111-2222-3333-1001"
        );
    }
}
