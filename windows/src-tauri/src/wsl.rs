// WSL distros as places to install Claude Code hooks.
//
// Claude Code running inside WSL reads the *Linux* `~/.claude/settings.json`,
// so a Windows install never sees those sessions. Each distro is therefore a
// hook target of its own (hooks.rs), with the same consent flow as Windows.
// This file knows the WSL side of it:
//
//   * which distros exist — read from the registry
//     (`HKCU\Software\Microsoft\Windows\CurrentVersion\Lxss`), so listing them
//     never spawns a process and never starts a stopped distro;
//   * which of them are running — `wsl.exe -l --running -q`, which prints
//     UTF-16LE and does not start anything either;
//   * the default user's `$HOME` and the relay's Linux path, from one
//     `wsl.exe -d <distro> -e sh -c …` (this one does start the distro);
//   * how the Linux home is reached from Windows: `\\wsl.localhost\<distro>\…`
//     (`\\wsl$\<distro>\…` on Windows 10 builds that predate it);
//   * how the hook command is written for a POSIX shell.
//
// The relay stays the Windows exe staged in %LOCALAPPDATA%\Coucou\bin: WSL
// interop runs it from Linux, and it talks to the app over the same pipe as a
// Windows session. Its Linux path comes from `wslpath -u` inside the distro
// rather than being assumed to be /mnt/c/…: `automount.root` in wsl.conf can
// move drives anywhere, or turn automounting off.

use std::io::Read;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use windows::core::{HSTRING, PCWSTR, PWSTR};
use windows::Win32::Foundation::ERROR_SUCCESS;
use windows::Win32::System::Registry::{
    RegCloseKey, RegEnumKeyExW, RegGetValueW, RegOpenKeyExW, HKEY, HKEY_CURRENT_USER, KEY_READ,
    RRF_RT_REG_DWORD, RRF_RT_REG_SZ,
};

/// Keeps wsl.exe from flashing a console window.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// A cold WSL 2 start boots a VM; give it time, but never forever — a wedged
/// WSL must not leave the settings window spinning.
const PROBE_TIMEOUT: Duration = Duration::from_secs(45);
const LIST_TIMEOUT: Duration = Duration::from_secs(10);

const LXSS_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Lxss";

/// The text the relay receives after the event name. The Linux shell that
/// Claude Code runs the hook command with expands the variable; the relay
/// itself could not read it (interop only passes what WSLENV lists).
pub const DISTRO_ARG: &str = r#"--wsl-distro "$WSL_DISTRO_NAME""#;
/// And after that: the hook shell's parent, which is Claude Code itself — where
/// the app starts walking up to the session's terminal (terminal.rs). Interop
/// hides Linux processes from the relay, so the shell has to say it.
pub const PPID_ARG: &str = r#"--wsl-ppid "$PPID""#;

#[derive(Debug, Clone, PartialEq)]
pub struct Distro {
    pub name: String,
    pub is_default: bool,
}

/// What `probe` learns from inside a distro, as Linux paths.
#[derive(Debug, Clone, PartialEq)]
pub struct Probe {
    /// `$HOME` of the distro's default user — the account Claude Code runs as.
    pub home: String,
    /// The staged Windows relay, as Linux sees it (`wslpath -u`).
    pub relay: String,
}

// ── Names ─────────────────────────────────────────────────────────────────────

/// WSL's own rule for distro names: ASCII letters, digits, `.`, `_` and `-`.
/// Anything else is refused before it gets near a command line, a UNC path or
/// a URI.
pub fn is_valid_distro_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// Distros that other tools register for their own plumbing. Nobody runs
/// Claude Code in them, and Docker's sit stopped until Docker Desktop needs
/// them — offering to "install hooks" there would only be noise.
fn is_utility_distro(name: &str) -> bool {
    const UTILITY: &[&str] = &[
        "docker-desktop",
        "docker-desktop-data",
        "rancher-desktop",
        "rancher-desktop-data",
    ];
    UTILITY.iter().any(|u| u.eq_ignore_ascii_case(name))
}

// ── Which distros exist ───────────────────────────────────────────────────────

/// Registered distros that could run Claude Code, default first. Reads the
/// registry only: listing is cheap and never wakes WSL up.
pub fn distros() -> Vec<Distro> {
    let mut list = registry_distros().unwrap_or_default();
    list.retain(|d| is_valid_distro_name(&d.name) && !is_utility_distro(&d.name));
    list.sort_by(|a, b| b.is_default.cmp(&a.is_default).then_with(|| a.name.cmp(&b.name)));
    list.dedup_by(|a, b| a.name.eq_ignore_ascii_case(&b.name));
    list
}

/// `None` when WSL has never registered a distro for this user (the key is
/// created with the first one).
fn registry_distros() -> Option<Vec<Distro>> {
    unsafe {
        let mut key = HKEY::default();
        if RegOpenKeyExW(HKEY_CURRENT_USER, &HSTRING::from(LXSS_KEY), None, KEY_READ, &mut key)
            != ERROR_SUCCESS
        {
            return None;
        }
        let default = reg_string(key, None, "DefaultDistribution");
        let mut out = Vec::new();
        for index in 0.. {
            let mut name = [0u16; 128];
            let mut len = name.len() as u32;
            let status = RegEnumKeyExW(
                key,
                index,
                Some(PWSTR(name.as_mut_ptr())),
                &mut len,
                None,
                None,
                None,
                None,
            );
            if status != ERROR_SUCCESS {
                break; // ERROR_NO_MORE_ITEMS, or something we cannot read anyway
            }
            let guid = String::from_utf16_lossy(&name[..len as usize]);
            let Some(distro) = reg_string(key, Some(&guid), "DistributionName") else { continue };
            // 1 = installed. Anything else is a distro being installed, converted
            // or removed, which is no place to write a settings file.
            if reg_dword(key, &guid, "State").is_some_and(|s| s != 1) {
                continue;
            }
            let is_default = default.as_deref().is_some_and(|d| d.eq_ignore_ascii_case(&guid));
            out.push(Distro { name: distro, is_default });
        }
        let _ = RegCloseKey(key);
        Some(out)
    }
}

unsafe fn reg_string(key: HKEY, subkey: Option<&str>, value: &str) -> Option<String> {
    let sub = subkey.map(HSTRING::from);
    let sub_ptr = sub.as_ref().map(|s| PCWSTR(s.as_ptr())).unwrap_or(PCWSTR::null());
    let value = HSTRING::from(value);
    let mut buf = vec![0u16; 260];
    let mut bytes = (buf.len() * 2) as u32;
    let status = RegGetValueW(
        key,
        sub_ptr,
        &value,
        RRF_RT_REG_SZ,
        None,
        Some(buf.as_mut_ptr().cast()),
        Some(&mut bytes),
    );
    if status != ERROR_SUCCESS {
        return None;
    }
    let chars = (bytes as usize / 2).min(buf.len());
    let text = String::from_utf16_lossy(&buf[..chars]);
    let text = text.trim_end_matches('\0').to_string();
    (!text.is_empty()).then_some(text)
}

unsafe fn reg_dword(key: HKEY, subkey: &str, value: &str) -> Option<u32> {
    let sub = HSTRING::from(subkey);
    let value = HSTRING::from(value);
    let mut data = 0u32;
    let mut bytes = 4u32;
    let status = RegGetValueW(
        key,
        &sub,
        &value,
        RRF_RT_REG_DWORD,
        None,
        Some((&mut data as *mut u32).cast()),
        Some(&mut bytes),
    );
    (status == ERROR_SUCCESS).then_some(data)
}

/// `wsl.exe -l -q` and friends print UTF-16LE, one name per line, sometimes
/// with a BOM and always with CRLF. Blank lines are dropped.
pub fn decode_utf16_lines(bytes: &[u8]) -> Vec<String> {
    let units: Vec<u16> = bytes.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
    let text = String::from_utf16_lossy(&units);
    text.trim_start_matches('\u{feff}')
        .lines()
        .map(|l| l.trim_matches(|c: char| c.is_whitespace() || c == '\0').to_string())
        .filter(|l| !l.is_empty())
        .collect()
}

/// The distros running right now. Asking does not start any of them.
pub fn running() -> Result<Vec<String>, String> {
    running_within(LIST_TIMEOUT)
}

/// `running`, with a deadline of the caller's choosing (a click cannot wait 10 s).
pub fn running_within(timeout: Duration) -> Result<Vec<String>, String> {
    let out = run_wsl(&["-l", "--running", "-q"], timeout)?;
    // With nothing running, wsl.exe prints a sentence and exits non-zero; that
    // is an answer ("none"), not a failure.
    if !out.ok {
        return Ok(Vec::new());
    }
    Ok(decode_utf16_lines(&out.stdout))
}

// ── Inside a distro ───────────────────────────────────────────────────────────

/// `$HOME` of the default user and the relay's Linux path, in one call. This
/// starts the distro if it is stopped.
///
/// The Windows path goes in as a positional argument (`$1`), never spliced
/// into the script: wsl.exe hands `-e` arguments to Linux one by one, so a
/// user name with spaces or quotes stays one argument.
pub fn probe(distro: &str, relay_windows: &Path) -> Result<Probe, String> {
    if !is_valid_distro_name(distro) {
        return Err(format!("\"{distro}\" is not a WSL distro name."));
    }
    let relay = relay_windows.to_string_lossy().to_string();
    let out = run_wsl(
        &[
            "-d",
            distro,
            "-e",
            "sh",
            "-c",
            r#"printf '%s\n' "$HOME" && wslpath -u "$1""#,
            "coucou",
            &relay,
        ],
        PROBE_TIMEOUT,
    )?;
    if !out.ok {
        let why = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(format!(
            "Couldn't reach the relay from inside {distro}{}",
            if why.is_empty() { ".".to_string() } else { format!(": {why}") }
        ));
    }
    parse_probe(&String::from_utf8_lossy(&out.stdout))
        .map_err(|e| format!("Unexpected answer from {distro}: {e}"))
}

/// Every process's `/proc/<pid>/stat` line inside `distro`, for terminal.rs to
/// walk up from Claude Code to its terminal's shell. Read-only, and nothing
/// from the caller reaches the command line but the (validated) distro name.
/// Starts the distro if it is stopped: check `running` first.
pub fn proc_stats(distro: &str, timeout: Duration) -> Result<String, String> {
    if !is_valid_distro_name(distro) {
        return Err(format!("\"{distro}\" is not a WSL distro name."));
    }
    // A process can exit between the glob and its read; that line is just missing.
    let out = run_wsl(&["-d", distro, "-e", "sh", "-c", "cat /proc/[0-9]*/stat 2>/dev/null; exit 0"], timeout)?;
    if !out.ok {
        return Err(format!("Couldn't list the processes in {distro}."));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Two lines: `$HOME`, then the relay's Linux path. Both must be absolute,
/// single-line Linux paths.
pub fn parse_probe(stdout: &str) -> Result<Probe, String> {
    let mut lines = stdout.lines().map(|l| l.trim_end_matches('\r'));
    let home = lines.next().unwrap_or_default().to_string();
    let relay = lines.next().unwrap_or_default().to_string();
    for (what, path) in [("$HOME", &home), ("relay path", &relay)] {
        if !path.starts_with('/') || path.chars().any(|c| c.is_control()) {
            return Err(format!("{what} is {path:?}, not an absolute Linux path"));
        }
    }
    Ok(Probe { home, relay })
}

// ── From Windows ──────────────────────────────────────────────────────────────

/// A Linux path inside `distro`, as Windows reaches it: `\\wsl.localhost\…`,
/// or `\\wsl$\…` when this Windows predates the former.
pub fn unc_path(distro: &str, linux: &str) -> Result<PathBuf, String> {
    if !is_valid_distro_name(distro) {
        return Err(format!("\"{distro}\" is not a WSL distro name."));
    }
    let root = [r"\\wsl.localhost", r"\\wsl$"]
        .into_iter()
        .find(|root| Path::new(&format!(r"{root}\{distro}\")).is_dir())
        .unwrap_or(r"\\wsl.localhost");
    unc_path_under(root, distro, linux)
}

/// The pure half of `unc_path`. Refuses anything that would not map one to
/// one: relative paths, `.`/`..`, and backslashes (legal in a Linux name, but a
/// separator once on the Windows side).
pub fn unc_path_under(root: &str, distro: &str, linux: &str) -> Result<PathBuf, String> {
    if !is_valid_distro_name(distro) {
        return Err(format!("\"{distro}\" is not a WSL distro name."));
    }
    if !linux.starts_with('/') || linux.contains('\\') || linux.chars().any(|c| c.is_control()) {
        return Err(format!("{linux:?} is not an absolute Linux path Coucou can use."));
    }
    let parts: Vec<&str> = linux.split('/').filter(|p| !p.is_empty()).collect();
    if parts.iter().any(|p| *p == "." || *p == "..") {
        return Err(format!("{linux:?} is not a plain absolute path."));
    }
    let mut path = format!(r"{root}\{distro}");
    for part in parts {
        path.push('\\');
        path.push_str(part);
    }
    Ok(PathBuf::from(path))
}

/// Single-quotes `text` for a POSIX shell: inside single quotes nothing is
/// special, and a quote itself is closed, escaped and reopened (`'\''`).
pub fn sh_quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', r"'\''"))
}

// ── Running wsl.exe ───────────────────────────────────────────────────────────

/// `%SystemRoot%\System32\wsl.exe`, never whatever `wsl` PATH turns up.
fn wsl_exe() -> Result<PathBuf, String> {
    let root = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    let exe = root.join("System32").join("wsl.exe");
    if exe.is_file() { Ok(exe) } else { Err("WSL is not installed (no wsl.exe).".into()) }
}

/// Runs wsl.exe with a deadline. Killing it on timeout only ends our own
/// wsl.exe client; the distro and anything else running in it carry on.
fn run_wsl(args: &[&str], timeout: Duration) -> Result<Captured, String> {
    let mut command = Command::new(wsl_exe()?);
    command.args(args);
    run_captured(command, "wsl.exe", timeout)
}

/// What a helper process printed, and whether it exited successfully.
pub struct Captured {
    pub ok: bool,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

/// Runs a helper (wsl.exe, VS Code's `code` command) to completion with a
/// deadline, without a console window and with nothing on its stdin. Killing it
/// on timeout ends that process only, never anything it started. `what` names
/// it in errors.
pub fn run_captured(mut command: Command, what: &str, timeout: Duration) -> Result<Captured, String> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| format!("Couldn't run {what}: {e}"))?;

    // Drain both pipes on their own threads so a chatty child cannot block on
    // a full pipe while we wait for it.
    let mut out_pipe = child.stdout.take();
    let mut err_pipe = child.stderr.take();
    let out_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(p) = out_pipe.as_mut() {
            let _ = p.read_to_end(&mut buf);
        }
        buf
    });
    let err_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(p) = err_pipe.as_mut() {
            let _ = p.read_to_end(&mut buf);
        }
        buf
    });

    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(25)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("{what} did not answer within {} s.", timeout.as_secs()));
            }
            Err(e) => return Err(format!("{what}: {e}")),
        }
    };
    Ok(Captured {
        ok: status.success(),
        stdout: out_reader.join().unwrap_or_default(),
        stderr: err_reader.join().unwrap_or_default(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn distro_names_follow_wsl_rules() {
        for good in ["Ubuntu-24.04", "Ubuntu", "kali-linux", "OracleLinux_9_1", "openSUSE-Tumbleweed"] {
            assert!(is_valid_distro_name(good), "{good}");
        }
        for bad in ["", "my distro", "a/b", r"a\b", "x;rm", "ü", "$(id)", "a\"b", &"x".repeat(65)] {
            assert!(!is_valid_distro_name(bad), "{bad:?}");
        }
    }

    #[test]
    fn tool_distros_are_not_targets() {
        assert!(is_utility_distro("docker-desktop"));
        assert!(is_utility_distro("Docker-Desktop-Data"));
        assert!(is_utility_distro("rancher-desktop"));
        assert!(!is_utility_distro("Ubuntu-24.04"));
        assert!(!is_utility_distro("docker"));
    }

    #[test]
    fn wsl_list_output_is_utf16le() {
        // Exactly what `wsl.exe -l -q` printed on the machine this was written on.
        let raw: Vec<u8> = "Ubuntu-24.04\r\ndocker-desktop\r\n\r\n"
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect();
        assert_eq!(decode_utf16_lines(&raw), ["Ubuntu-24.04", "docker-desktop"]);

        let mut with_bom = vec![0xFF, 0xFE];
        with_bom.extend("Debian\r\n".encode_utf16().flat_map(u16::to_le_bytes));
        assert_eq!(decode_utf16_lines(&with_bom), ["Debian"]);
        assert!(decode_utf16_lines(&[]).is_empty());
        // An odd trailing byte is ignored rather than turned into garbage.
        let mut odd: Vec<u8> = "Arch\r\n".encode_utf16().flat_map(u16::to_le_bytes).collect();
        odd.push(0x41);
        assert_eq!(decode_utf16_lines(&odd), ["Arch"]);
    }

    #[test]
    fn the_probe_answer_is_two_absolute_paths() {
        let p = parse_probe("/home/manua\n/mnt/c/Users/manua/AppData/Local/Coucou/bin/coucou-hook.exe\n").unwrap();
        assert_eq!(p.home, "/home/manua");
        assert_eq!(p.relay, "/mnt/c/Users/manua/AppData/Local/Coucou/bin/coucou-hook.exe");
        // A custom automount root, and a user name with a space.
        let p = parse_probe("/home/john smith\r\n/c/Users/John Smith/AppData/Local/Coucou/bin/coucou-hook.exe").unwrap();
        assert_eq!(p.relay, "/c/Users/John Smith/AppData/Local/Coucou/bin/coucou-hook.exe");

        assert!(parse_probe("").is_err());
        assert!(parse_probe("/home/u\n").is_err(), "no relay line");
        assert!(parse_probe("relative\n/mnt/c/x.exe").is_err());
        assert!(parse_probe("/home/u\nC:\\x.exe").is_err());
    }

    #[test]
    fn linux_paths_map_onto_the_wsl_share() {
        assert_eq!(
            unc_path_under(r"\\wsl.localhost", "Ubuntu-24.04", "/home/manua/.claude/settings.json").unwrap(),
            PathBuf::from(r"\\wsl.localhost\Ubuntu-24.04\home\manua\.claude\settings.json")
        );
        assert_eq!(
            unc_path_under(r"\\wsl$", "Debian", "/home/a b//c/").unwrap(),
            PathBuf::from(r"\\wsl$\Debian\home\a b\c")
        );
        assert_eq!(unc_path_under(r"\\wsl.localhost", "Debian", "/").unwrap(), PathBuf::from(r"\\wsl.localhost\Debian"));
        for bad in ["home/u", "/home/../etc", "/home/./u", r"/home/a\b", "/home/u\n"] {
            assert!(unc_path_under(r"\\wsl.localhost", "Debian", bad).is_err(), "{bad:?}");
        }
        assert!(unc_path_under(r"\\wsl.localhost", "bad name", "/home/u").is_err());
    }

    #[test]
    fn shell_quoting_survives_anything_in_a_path() {
        assert_eq!(sh_quote("/mnt/c/Users/manua/x.exe"), "'/mnt/c/Users/manua/x.exe'");
        assert_eq!(sh_quote("/mnt/c/Users/O'Brien/x.exe"), r"'/mnt/c/Users/O'\''Brien/x.exe'");
        assert_eq!(sh_quote(r#"/a "$HOME" `id` $(id) \ ;&|"#), r#"'/a "$HOME" `id` $(id) \ ;&|'"#);
    }

    /// Against the real WSL on this machine, read-only: lists the distros from
    /// the registry, asks which run, and probes the default one for `$HOME` and
    /// a relay path (`printf` and `wslpath` — nothing is written). Ignored by
    /// default because it needs WSL and may start a stopped distro:
    /// `cargo test -p coucou --lib -- --ignored --nocapture live_wsl`.
    #[test]
    #[ignore]
    fn live_wsl_read_only() {
        let list = distros();
        eprintln!("distros: {list:?}");
        eprintln!("running: {:?}", running());
        let Some(first) = list.first() else { return };
        let relay = Path::new(r"C:\Users\John O'Brien\AppData\Local\Coucou\bin\coucou-hook.exe");
        let probe = probe(&first.name, relay);
        eprintln!("probe {}: {probe:?}", first.name);
        let probe = probe.unwrap();
        assert!(probe.relay.ends_with("/Users/John O'Brien/AppData/Local/Coucou/bin/coucou-hook.exe"));
        let home = unc_path(&first.name, &probe.home).unwrap();
        eprintln!("home from Windows: {} (exists: {})", home.display(), home.is_dir());
        assert!(home.is_dir());
    }
}
