// The companion VS Code extension (windows/vscode-extension, see terminal.rs):
// whether the user's VS Code has it, and installing it — only ever when the
// user clicks Install in Settings → Claude Code.
//
// The .vsix is built with the app (scripts/build-extension.mjs) and shipped as
// a Tauri resource. VS Code is asked through its own command line, the `code`
// on PATH, exactly as a person would: `code --list-extensions --show-versions`
// to look, `code --install-extension <vsix> --force` to install or update.
// Neither opens a window. The extension runs in VS Code's local extension host
// (`extensionKind: ["ui"]`), so a local install also covers Remote-WSL windows.

use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::wsl::run_captured;

/// `<publisher>.<name>` from vscode-extension/package.json.
pub const ID: &str = "coucou.terminal-focus";
/// The resource's file name (tauri.conf.json).
pub const VSIX: &str = "coucou-terminal-focus.vsix";
/// The manifest of the extension this build ships, for its version.
const MANIFEST: &str = include_str!("../../vscode-extension/package.json");

/// Listing starts VS Code's CLI (a Node process); give it time on a cold disk.
const LIST_TIMEOUT: Duration = Duration::from_secs(30);
const INSTALL_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Serialize, Debug, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionStatus {
    /// The `code` command found on PATH, if any. Shown, and checked by the
    /// end-to-end suite before it clicks anything.
    pub code_path: Option<String>,
    /// The version installed in VS Code, if any.
    pub installed: Option<String>,
    /// The version this build ships.
    pub bundled: String,
    /// The .vsix this build ships, if it is where it should be.
    pub vsix_path: Option<String>,
    /// Installed, and at least as new as the bundled one.
    pub up_to_date: bool,
    pub error: Option<String>,
}

/// The `version` of the bundled manifest.
pub fn bundled_version() -> String {
    serde_json::from_str::<serde_json::Value>(MANIFEST)
        .ok()
        .and_then(|m| m.get("version")?.as_str().map(str::to_string))
        .unwrap_or_default()
}

/// The installed version of the extension, from `code --list-extensions
/// --show-versions` (one `publisher.name@version` per line). Extension ids
/// compare case-insensitively, as VS Code does.
pub fn installed_version(listing: &str) -> Option<String> {
    listing.lines().find_map(|line| {
        let (id, version) = line.trim().rsplit_once('@')?;
        (id.eq_ignore_ascii_case(ID) && !version.is_empty()).then(|| version.to_string())
    })
}

/// `installed >= bundled`, comparing dotted numbers (`0.10.0` > `0.9.3`). A
/// pre-release tag is ignored; a part that is not a number counts as 0.
pub fn at_least(installed: &str, bundled: &str) -> bool {
    let parts = |v: &str| -> Vec<u64> {
        let core = v.split(['-', '+']).next().unwrap_or("");
        core.split('.').map(|p| p.parse().unwrap_or(0)).collect()
    };
    let (a, b) = (parts(installed), parts(bundled));
    for i in 0..a.len().max(b.len()) {
        let (x, y) = (a.get(i).copied().unwrap_or(0), b.get(i).copied().unwrap_or(0));
        if x != y {
            return x > y;
        }
    }
    true
}

/// The bundled .vsix: in the installed app's resources, next to the dev build,
/// or where scripts/build-extension.mjs leaves it.
fn vsix_path(app: &AppHandle) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(p) = app.path().resolve(VSIX, tauri::path::BaseDirectory::Resource) {
        candidates.push(p);
    }
    if let Some(dir) = std::env::current_exe().ok().and_then(|e| e.parent().map(PathBuf::from)) {
        candidates.push(dir.join(VSIX));
        // target/debug → windows/vscode-extension/dist
        candidates.push(dir.join("../../vscode-extension/dist").join(VSIX));
    }
    candidates.into_iter().find(|p| p.is_file()).map(|p| plain_path(&p))
}

/// `\\?\C:\x` → `C:\x`, `\\?\UNC\srv\share\x` → `\\srv\share\x`. Tauri hands
/// resource paths back in the verbatim form, which is fine for Windows but not
/// something to hand another program's command line (VS Code turns paths into
/// file URIs). Anything else is returned as is.
pub fn plain_path(path: &std::path::Path) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    match text.strip_prefix(r"\\?\") {
        Some(rest) if rest.as_bytes().get(1) == Some(&b':') => PathBuf::from(rest),
        _ => path.to_path_buf(),
    }
}

/// `code` with these arguments, no window, under a deadline.
fn run_code(code: &PathBuf, args: &[&std::ffi::OsStr], timeout: Duration) -> Result<String, String> {
    // No `cmd /C`: Rust quotes the arguments for code.cmd itself (see find_on_path).
    let mut command = Command::new(code);
    command.args(args);
    let out = run_captured(command, "code", timeout)?;
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    if out.ok {
        Ok(stdout)
    } else {
        let why = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if why.is_empty() { stdout.trim().to_string() } else { why })
    }
}

/// Is it installed, and up to date? Blocking (it runs VS Code's CLI): call it
/// off the main thread.
pub fn status(app: &AppHandle) -> ExtensionStatus {
    let code = crate::find_on_path("code");
    let mut status = ExtensionStatus {
        code_path: code.as_ref().map(|p| p.to_string_lossy().to_string()),
        bundled: bundled_version(),
        vsix_path: vsix_path(app).map(|p| p.to_string_lossy().to_string()),
        ..ExtensionStatus::default()
    };
    let Some(code) = code else { return status };
    match run_code(&code, &["--list-extensions".as_ref(), "--show-versions".as_ref()], LIST_TIMEOUT) {
        Ok(listing) => {
            status.installed = installed_version(&listing);
            status.up_to_date = status.installed.as_deref().is_some_and(|v| at_least(v, &status.bundled));
        }
        Err(err) => status.error = Some(format!("VS Code's `code` command failed: {err}")),
    }
    status
}

/// Installs (or updates) the bundled extension into the user's VS Code. Only
/// ever called from the Install / Update button. Blocking.
pub fn install(app: &AppHandle) -> Result<String, String> {
    let code = crate::find_on_path("code").ok_or("VS Code's `code` command is not on PATH.")?;
    let vsix = vsix_path(app).ok_or("This build of Coucou has no extension package to install.")?;
    crate::log::line(format!("installing the VS Code extension {} from {}", bundled_version(), vsix.display()));
    let out = run_code(
        &code,
        &["--install-extension".as_ref(), vsix.as_os_str(), "--force".as_ref()],
        INSTALL_TIMEOUT,
    )
    .map_err(|err| format!("VS Code could not install it: {err}"))?;
    crate::log::line("VS Code extension installed");
    Ok(out.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_manifest_is_the_extension_this_file_talks_about() {
        let m: serde_json::Value = serde_json::from_str(MANIFEST).unwrap();
        assert_eq!(format!("{}.{}", m["publisher"].as_str().unwrap(), m["name"].as_str().unwrap()), ID);
        assert_eq!(m["extensionKind"], serde_json::json!(["ui"]), "the pipe is a Windows one: local host only");
        assert!(!bundled_version().is_empty());
        assert!(at_least(&bundled_version(), &bundled_version()));
    }

    #[test]
    fn the_installed_version_is_read_from_the_listing() {
        let listing = "ms-python.python@2026.1.0\r\nCoucou.Terminal-Focus@0.1.0\nms-vscode-remote.remote-wsl@0.104.3\n";
        assert_eq!(installed_version(listing).as_deref(), Some("0.1.0"));
        assert_eq!(installed_version("ms-python.python@1.0.0\n"), None);
        assert_eq!(installed_version(""), None);
        // Without --show-versions there is no version: not something to trust.
        assert_eq!(installed_version("coucou.terminal-focus\n"), None);
        assert_eq!(installed_version("coucou.terminal-focus@\n"), None);
        // A look-alike id is another extension.
        assert_eq!(installed_version("coucou.terminal-focus-fork@9.9.9\n"), None);
    }

    #[test]
    fn verbatim_paths_are_made_plain_for_vs_code() {
        use std::path::Path;
        assert_eq!(plain_path(Path::new(r"\\?\C:\Program Files\Coucou\x.vsix")), Path::new(r"C:\Program Files\Coucou\x.vsix"));
        assert_eq!(plain_path(Path::new(r"\\?\UNC\srv\share\x.vsix")), Path::new(r"\\srv\share\x.vsix"));
        assert_eq!(plain_path(Path::new(r"C:\a\x.vsix")), Path::new(r"C:\a\x.vsix"));
        // A verbatim path that is not a drive path is left alone.
        assert_eq!(plain_path(Path::new(r"\\?\Volume{1234}\x.vsix")), Path::new(r"\\?\Volume{1234}\x.vsix"));
    }

    #[test]
    fn versions_compare_by_number() {
        assert!(at_least("0.1.0", "0.1.0"));
        assert!(at_least("0.2.0", "0.1.9"));
        assert!(at_least("0.10.0", "0.9.3"));
        assert!(at_least("1.0", "0.9.9"));
        assert!(at_least("0.1.0", "0.1"));
        assert!(!at_least("0.1.0", "0.1.1"));
        assert!(!at_least("0.9.3", "0.10.0"));
        assert!(!at_least("0.1", "0.1.1"));
        assert!(at_least("0.2.0-beta", "0.2.0"));
        assert!(!at_least("garbage", "0.0.1"));
    }
}
