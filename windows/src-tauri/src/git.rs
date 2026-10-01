// The git branch a session's folder has checked out — for the approval card,
// which explains `git commit -m "fix"` as `Commit en "dev"` rather than
// `Commit en la rama actual` (src/core/explain.ts). The card never waits for
// this: it shows the explanation at once and the branch fills in when it
// comes, if it comes.
//
// Nothing goes through a shell. The folder is handed to git as an argument of
// its own (`git -C <folder> rev-parse --abbrev-ref HEAD`), on Windows and in
// WSL alike, where it runs as `wsl.exe -d <distro> --cd / --exec git -C
// <folder> …`. `--exec` runs git directly instead of through the user's login
// shell, and the folder goes to `git -C` rather than to `wsl.exe --cd`: when
// `--cd` names a folder that does not exist, WSL prints an error and runs the
// command anyway, from another folder — which could answer with some other
// repository's branch. `git -C` fails instead.

use std::io::Read;
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Keeps git and wsl.exe from flashing a console window.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Git answers in tens of milliseconds, wsl.exe in one or two hundred. Past
/// this the explanation just keeps "la rama actual".
const TIMEOUT: Duration = Duration::from_millis(2_500);

/// The branch checked out in `cwd`: a Windows folder, or a Linux folder inside
/// the WSL distro `wsl_distro`. None when it is not a repository, HEAD is
/// detached, git is missing, or it takes longer than TIMEOUT.
#[tauri::command]
pub async fn git_branch(cwd: String, wsl_distro: Option<String>) -> Option<String> {
    // wsl.exe can take a moment: never on the thread that drives the windows.
    tauri::async_runtime::spawn_blocking(move || branch(&cwd, wsl_distro.as_deref()))
        .await
        .ok()
        .flatten()
}

pub fn branch(cwd: &str, wsl_distro: Option<&str>) -> Option<String> {
    let mut command = command_for(cwd, wsl_distro)?;
    let stdout = run(&mut command, TIMEOUT)?;
    parse_branch(&stdout)
}

/// The command that asks for the branch, or None when the input cannot be
/// trusted with one.
fn command_for(cwd: &str, wsl_distro: Option<&str>) -> Option<Command> {
    const ASK: [&str; 3] = ["rev-parse", "--abbrev-ref", "HEAD"];
    match wsl_distro.map(str::trim).filter(|d| !d.is_empty()) {
        Some(distro) => {
            if !crate::wsl::is_valid_distro_name(distro) || !is_linux_folder(cwd) {
                return None;
            }
            let mut command = Command::new(wsl_exe()?);
            command.args(["-d", distro, "--cd", "/", "--exec", "git", "-C", cwd]).args(ASK);
            Some(command)
        }
        None => {
            if !is_windows_folder(cwd) {
                return None;
            }
            let mut command = Command::new(crate::find_on_path("git")?);
            command.arg("-C").arg(cwd).args(ASK);
            // rev-parse takes no lock; this says so to any git that might.
            command.env("GIT_OPTIONAL_LOCKS", "0");
            Some(command)
        }
    }
}

/// An absolute Windows folder: `C:\…` or `\\server\share\…`.
fn is_windows_folder(path: &str) -> bool {
    let b = path.as_bytes();
    let drive = b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/');
    let unc = path.starts_with(r"\\") && path.len() > 2;
    (drive || unc) && !path.contains('\0') && !path.contains('\n')
}

/// An absolute Linux folder, as WSL sessions report their `cwd`.
fn is_linux_folder(path: &str) -> bool {
    path.starts_with('/') && !path.contains('\0') && !path.contains('\n')
}

/// `%SystemRoot%\System32\wsl.exe`, never whatever `wsl` PATH turns up.
fn wsl_exe() -> Option<PathBuf> {
    let root = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    let exe = root.join("System32").join("wsl.exe");
    exe.is_file().then_some(exe)
}

/// Runs `command` with a deadline; its standard output if it succeeded.
/// (wsl.rs has its own runner for wsl.exe; this one is git's, kept apart.)
fn run(command: &mut Command, timeout: Duration) -> Option<Vec<u8>> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .ok()?;
    // A branch name is a few bytes: it fits in the pipe, so reading after the
    // exit cannot deadlock.
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    };
    if !status.success() {
        return None;
    }
    let mut stdout = Vec::new();
    child.stdout.take()?.read_to_end(&mut stdout).ok()?;
    Some(stdout)
}

/// git's answer → the branch. `HEAD` means detached: there is no branch to name.
fn parse_branch(stdout: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(stdout);
    let name = text.trim();
    let ok = !name.is_empty()
        && name != "HEAD"
        && name.len() <= 255
        && !name.chars().any(|c| c.is_control() || c.is_whitespace());
    ok.then(|| name.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_branch_and_refuses_a_detached_head() {
        assert_eq!(parse_branch(b"dev\n"), Some("dev".into()));
        assert_eq!(parse_branch(b"feature/islas-2\r\n"), Some("feature/islas-2".into()));
        assert_eq!(parse_branch(b"HEAD\n"), None);
        assert_eq!(parse_branch(b""), None);
        assert_eq!(parse_branch(b"two words\n"), None);
    }

    #[test]
    fn only_absolute_folders_are_asked_about() {
        assert!(is_windows_folder(r"C:\Users\me\repo"));
        assert!(is_windows_folder("D:/work/repo"));
        assert!(is_windows_folder(r"\\wsl.localhost\Ubuntu\home\me"));
        assert!(!is_windows_folder(r"repo\sub"));
        assert!(!is_windows_folder("/home/me/repo"));
        assert!(!is_windows_folder("C:"));
        assert!(is_linux_folder("/home/me/repo"));
        assert!(!is_linux_folder("home/me"));
        assert!(!is_linux_folder(r"C:\x"));
        assert!(command_for("relative", None).is_none());
        assert!(command_for("/home/me", Some("not a distro!")).is_none());
        assert!(command_for(r"C:\x", Some("Ubuntu")).is_none());
    }

    #[test]
    fn the_folder_is_an_argument_of_its_own() {
        let Some(command) = command_for(r"C:\a b\& calc", None) else { return }; // no git on PATH
        let args: Vec<_> = command.get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        assert_eq!(args, ["-C", r"C:\a b\& calc", "rev-parse", "--abbrev-ref", "HEAD"]);
        if let Some(wsl) = command_for("/home/me/my repo", Some("Ubuntu-24.04")) {
            let args: Vec<_> = wsl.get_args().map(|a| a.to_string_lossy().into_owned()).collect();
            assert_eq!(
                args,
                ["-d", "Ubuntu-24.04", "--cd", "/", "--exec", "git", "-C", "/home/me/my repo", "rev-parse", "--abbrev-ref", "HEAD"]
            );
        }
    }

    #[test]
    fn this_checkout_has_a_branch_and_a_plain_folder_has_none() {
        if crate::find_on_path("git").is_none() {
            return;
        }
        let here = env!("CARGO_MANIFEST_DIR");
        // The same question asked directly: CI checkouts are often detached.
        let expected = Command::new(crate::find_on_path("git").unwrap())
            .args(["-C", here, "rev-parse", "--abbrev-ref", "HEAD"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .ok()
            .and_then(|o| parse_branch(&o.stdout));
        assert_eq!(branch(here, None), expected);

        let plain = std::env::temp_dir().join(format!("coucou-git-test-{}", std::process::id()));
        std::fs::create_dir_all(&plain).unwrap();
        // Not a repository — unless the temp folder itself lives inside one.
        let inside_repo = Command::new(crate::find_on_path("git").unwrap())
            .arg("-C")
            .arg(&plain)
            .args(["rev-parse", "--is-inside-work-tree"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if !inside_repo {
            assert_eq!(branch(plain.to_str().unwrap(), None), None);
        }
        let _ = std::fs::remove_dir(&plain);
        assert_eq!(branch(r"C:\this\folder\does\not\exist\coucou", None), None);
    }
}
