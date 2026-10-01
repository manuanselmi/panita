// "Open" for a Claude Code session: take the user to the VS Code window the
// session lives in, instead of opening yet another one.
//
// `code <folder>` alone opens a new window whenever that exact folder is not
// already some window's root — and a session often runs in a subfolder of the
// folder that is open (`…\GitHub\panita\windows` inside a window on
// `…\GitHub`). So we look at the windows VS Code already has:
//
//   1. List the top-level windows of Code.exe, on every virtual desktop
//      (windows on other desktops are *cloaked*, not hidden — they are kept).
//   2. Pick the one whose title names the session's folder, or failing that
//      its nearest parent (`pick_window`, pure and unit-tested).
//   3. Bring it to the front (`activate`). A window on another virtual
//      desktop makes Windows switch to that desktop when it is activated.
//   4. No such window: `code <cwd>` for a Windows session,
//      `code --folder-uri vscode-remote://wsl+<distro><path>` for a WSL one;
//      without `code` on PATH, Explorer on the folder.
//
// The title is all we have to go on — VS Code exposes no API for "which
// folder is this window" — and its default format is
//   `[● ]<editor> - <rootName>[ - <profile>] - Visual Studio Code`
// where rootName is the folder's name, or `<name> [WSL: <distro>]` for a
// window connected to WSL. A user-customised `window.title` simply means no
// match, and the fallback opens the folder as before.

use std::collections::HashMap;
use std::os::windows::process::CommandExt;
use std::process::Command;
use std::sync::mpsc;
use std::time::Duration;

use serde::Serialize;
use windows::core::{BOOL, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
use windows::Win32::System::Threading::{
    AttachThreadInput, GetCurrentThreadId, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, FlashWindowEx, GetForegroundWindow, GetWindow, GetWindowTextW, GetWindowThreadProcessId,
    IsIconic, IsWindowVisible, PeekMessageW, SetForegroundWindow, ShowWindowAsync, FLASHWINFO, FLASHW_ALL,
    FLASHW_TIMERNOFG, GW_OWNER, MSG, PM_NOREMOVE, SW_RESTORE,
};

use crate::{log, wsl};

/// Keeps `code.cmd` from flashing a console window.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// The executable whose windows we look at. (VS Code Insiders is
/// `Code - Insiders.exe` and titles itself differently; not covered.)
const VSCODE_EXE: &str = "Code.exe";
const APP_NAME: &str = "Visual Studio Code";
/// VS Code's `${dirty}`.
const DIRTY: &str = "\u{25cf} ";

/// What `openSession` reports back to the island.
#[derive(Serialize, Debug, Clone, Copy, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Outcome {
    /// An existing VS Code window for the session is now in the foreground.
    Focused,
    /// No window matched; `code` was asked to open the folder.
    Opened,
    /// No window matched and `code` is not on PATH; Explorer shows the folder.
    Explorer,
    /// Nothing could be done: bad input, a launch that failed, or Windows
    /// refused to bring the window forward (its taskbar button flashes).
    Failed,
}

// ── Matching titles (pure) ────────────────────────────────────────────────────

/// How sure a title match is. Ordered: `Strong` beats `Weak`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Strength {
    /// The name sits where a root sits when a profile name follows it — or
    /// where an editor name could also sit.
    Weak,
    /// The whole title, or the last part before the app name: only a root
    /// can be there (default profile).
    Strong,
}

/// The part of a VS Code title before ` - Visual Studio Code`, without the
/// dirty marker and a trailing ` [Administrator]`-style note. `None` for
/// anything that is not a main editor window title, or one with no folder.
fn workspace_part(title: &str) -> Option<&str> {
    let mut t = title.trim();
    if t.ends_with(']') {
        if let Some(i) = t.rfind(" [") {
            if t[..i].ends_with(APP_NAME) {
                t = &t[..i];
            }
        }
    }
    let rest = t.strip_suffix(APP_NAME)?.strip_suffix(" - ")?;
    let rest = rest.strip_prefix(DIRTY).unwrap_or(rest);
    (!rest.is_empty()).then_some(rest)
}

/// Does `rest` (a `workspace_part`) show `name` as its root?
fn title_match(rest: &str, name: &str) -> Option<Strength> {
    if rest == name || rest.ends_with(&format!(" - {name}")) {
        Some(Strength::Strong)
    } else if rest.starts_with(&format!("{name} - ")) || rest.contains(&format!(" - {name} - ")) {
        Some(Strength::Weak)
    } else {
        None
    }
}

/// The folders of `cwd`, deepest first, as VS Code would name them in a title.
/// `None` when `cwd` is not an absolute path of the session's kind.
///
/// Windows: `C:\a\b` → `b`, `a` (the drive is not a folder name);
/// `\\server\share\a` → `a` (neither is the share); `\\?\` prefixes are
/// understood. WSL: `/home/u/a/p` → `p [WSL: d]`, `a [WSL: d]`. Nothing at or
/// above a home folder is offered (see `below_home`).
fn root_names(cwd: &str, wsl_distro: Option<&str>) -> Option<Vec<String>> {
    let plain = |c: &&str| !c.is_empty() && *c != "." && *c != "..";
    match wsl_distro {
        Some(distro) => {
            if !cwd.starts_with('/') {
                return None;
            }
            let parts: Vec<&str> = cwd.split('/').filter(plain).collect();
            Some(below_home(parts).iter().rev().map(|p| format!("{p} [WSL: {distro}]")).collect())
        }
        None => {
            let (unc, rest) = if let Some(r) = cwd.strip_prefix(r"\\?\UNC\") {
                (true, r)
            } else if let Some(r) = cwd.strip_prefix(r"\\?\") {
                (false, r)
            } else if cwd.starts_with(r"\\") || cwd.starts_with("//") {
                (true, cwd)
            } else {
                (false, cwd)
            };
            let mut parts: Vec<&str> = rest.split(['\\', '/']).filter(|c| !c.is_empty()).collect();
            if unc {
                if parts.len() < 2 {
                    return None;
                }
                parts.drain(..2); // server, share
            } else {
                let drive = parts.first()?;
                let b = drive.as_bytes();
                if !(b.len() == 2 && b[0].is_ascii_alphabetic() && b[1] == b':') {
                    return None; // relative, or a Git Bash style /c/… path
                }
                parts.remove(0);
            }
            let parts: Vec<&str> = parts.into_iter().filter(plain).collect();
            Some(below_home(parts).into_iter().rev().map(str::to_string).collect())
        }
    }
}

/// Drops the leading folders that are a home folder or above it: `Users\<name>`,
/// `/home/<name>`, `/root`, and WSL's view of a drive, `/mnt/<letter>`. Walking
/// up from a session's cwd is meant to find the window whose workspace
/// *contains* the project (`GitHub` for `GitHub\panita\windows`); past the home
/// folder the names are generic — the user's own name, `Users`, `home` — and a
/// window that happens to have a root called like that is someone else's.
fn below_home(mut parts: Vec<&str>) -> Vec<&str> {
    let drive = |p: &str| p.len() == 1 && p.as_bytes()[0].is_ascii_alphabetic();
    if parts.len() >= 2 && parts[0] == "mnt" && drive(parts[1]) {
        parts.drain(..2);
    }
    if parts.len() >= 2 && (parts[0].eq_ignore_ascii_case("Users") || parts[0] == "home") {
        parts.drain(..2);
    } else if parts.first() == Some(&"root") {
        parts.drain(..1);
    }
    parts
}

/// Index into `titles` of the VS Code window for a session in `cwd`.
///
/// The cwd's own folder is tried first, then each parent in turn: the first
/// folder that some window has as its root wins, so the *deepest* match is
/// preferred. Among windows matching the same folder, a strong match beats a
/// weak one, then the earlier title wins — `titles` comes from EnumWindows,
/// which in practice lists windows front to back, so that is the one used
/// most recently.
///
/// A WSL session only ever matches `<folder> [WSL: <its distro>]`, and a
/// Windows session never matches a title with a `[WSL: …]` root — the two
/// never cross. Windows names compare case-insensitively, Linux ones exactly.
pub fn pick_window(titles: &[&str], cwd: &str, wsl_distro: Option<&str>) -> Option<usize> {
    let names = root_names(cwd, wsl_distro)?;
    let fold = |s: &str| if wsl_distro.is_some() { s.to_string() } else { s.to_lowercase() };
    let parts: Vec<Option<String>> = titles
        .iter()
        .map(|title| {
            let rest = workspace_part(title)?;
            if wsl_distro.is_none() && rest.contains(" [WSL: ") {
                return None;
            }
            Some(fold(rest))
        })
        .collect();

    for name in names {
        let name = fold(&name);
        let mut best: Option<(usize, Strength)> = None;
        for (i, rest) in parts.iter().enumerate() {
            let Some(rest) = rest else { continue };
            if let Some(strength) = title_match(rest, &name) {
                if best.map_or(true, |(_, b)| strength > b) {
                    best = Some((i, strength));
                }
            }
        }
        if let Some((i, _)) = best {
            return Some(i);
        }
    }
    None
}

// ── Deciding (pure) ───────────────────────────────────────────────────────────

/// The folder Explorer would show when VS Code can't.
#[derive(Debug, Clone, PartialEq)]
pub enum Folder {
    Windows(String),
    /// A Linux path inside a distro, shown through `\\wsl.localhost\<distro>\…`.
    Wsl { distro: String, path: String },
}

#[derive(Debug, Clone, PartialEq)]
pub enum Plan {
    /// Bring `titles[i]` to the front.
    Focus(usize),
    /// No window for it: run `code` with these arguments when `code` is on
    /// PATH, otherwise (or if it fails to start) show `folder` in Explorer.
    Open { code_args: Option<Vec<String>>, folder: Option<Folder> },
    /// Refused before doing anything.
    Fail(String),
}

/// What to do for a session, given the VS Code titles on screen.
pub fn plan(titles: &[&str], cwd: Option<&str>, wsl_distro: Option<&str>, code_on_path: bool) -> Plan {
    let cwd = cwd.map(str::trim).filter(|c| !c.is_empty());
    let distro = wsl_distro.map(str::trim).filter(|d| !d.is_empty());
    if let Some(d) = distro {
        if !wsl::is_valid_distro_name(d) {
            return Plan::Fail("not a WSL distro name".into());
        }
    }
    let code = |args: Vec<String>| code_on_path.then_some(args);

    let Some(cwd) = cwd else {
        // Nothing to look for: bring VS Code up, as "Open terminal" always has.
        return Plan::Open { code_args: code(Vec::new()), folder: None };
    };
    if root_names(cwd, distro).is_none() {
        return Plan::Fail(match distro {
            Some(_) => "the WSL session's folder is not an absolute Linux path".into(),
            None => "the session's folder is not an absolute Windows path".into(),
        });
    }
    if let Some(i) = pick_window(titles, cwd, distro) {
        return Plan::Focus(i);
    }
    match distro {
        None => Plan::Open {
            code_args: code(vec![cwd.to_string()]),
            folder: Some(Folder::Windows(cwd.to_string())),
        },
        Some(d) => {
            let uri = match folder_uri(d, cwd) {
                Ok(uri) => uri,
                Err(err) => return Plan::Fail(err),
            };
            // Explorer goes through the share, which refuses what cannot map.
            let folder = wsl::unc_path_under(r"\\wsl.localhost", d, cwd)
                .ok()
                .map(|_| Folder::Wsl { distro: d.to_string(), path: cwd.to_string() });
            Plan::Open { code_args: code(vec!["--folder-uri".into(), uri]), folder }
        }
    }
}

/// `vscode-remote://wsl+<distro><path>` — the folder URI VS Code's WSL
/// extension opens. Each path segment is percent-encoded the way VS Code's own
/// URI class does it: everything but `A–Z a–z 0–9 - . _ ~` becomes `%XX` of
/// its UTF-8 bytes, so spaces, `#`, `?`, `%` and non-ASCII names all survive.
/// The distro needs no encoding: its name is already restricted to safe bytes.
pub fn folder_uri(distro: &str, linux_path: &str) -> Result<String, String> {
    if !wsl::is_valid_distro_name(distro) {
        return Err("not a WSL distro name".into());
    }
    if !linux_path.starts_with('/') || linux_path.chars().any(|c| c.is_control()) {
        return Err("not an absolute Linux path".into());
    }
    let mut path = String::new();
    for segment in linux_path.split('/').filter(|s| !s.is_empty()) {
        path.push('/');
        for byte in segment.bytes() {
            if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
                path.push(byte as char);
            } else {
                path.push_str(&format!("%{byte:02X}"));
            }
        }
    }
    if path.is_empty() {
        path.push('/');
    }
    Ok(format!("vscode-remote://wsl+{distro}{path}"))
}

// ── Windows on screen ─────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct Window {
    pub hwnd: isize,
    pub title: String,
    /// On another virtual desktop (cloaked by the shell), or otherwise cloaked.
    pub cloaked: bool,
    pub minimized: bool,
}

/// Visible, unowned top-level windows with a title, whose process image name
/// passes `accept` (e.g. `Code.exe`), in EnumWindows order — front to back in
/// practice.
///
/// "Visible" is the WS_VISIBLE style: windows on other virtual desktops and
/// minimized windows keep it, so both are listed. Cloaking is reported, never
/// filtered. Owned windows (dialogs, tooltips) and hidden helper windows are
/// left out. Only the title of a window from an accepted process is read, and
/// GetWindowText never waits on another process (it reads the caption the
/// system keeps), so a hung VS Code cannot hang us.
pub fn top_level_windows(accept: &dyn Fn(&str) -> bool) -> Vec<Window> {
    struct Ctx<'a> {
        accept: &'a dyn Fn(&str) -> bool,
        images: HashMap<u32, Option<String>>,
        out: Vec<Window>,
    }

    unsafe extern "system" fn each(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let ctx = unsafe { &mut *(lparam.0 as *mut Ctx) };
        unsafe {
            if !IsWindowVisible(hwnd).as_bool() {
                return true.into();
            }
            if matches!(GetWindow(hwnd, GW_OWNER), Ok(owner) if !owner.is_invalid()) {
                return true.into();
            }
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            let image = ctx.images.entry(pid).or_insert_with(|| image_name(pid));
            if !image.as_deref().is_some_and(|name| (ctx.accept)(name)) {
                return true.into();
            }
            let mut buf = [0u16; 1024];
            let len = GetWindowTextW(hwnd, &mut buf).max(0) as usize;
            if len == 0 {
                return true.into();
            }
            let mut cloaked = 0u32;
            let is_cloaked = DwmGetWindowAttribute(
                hwnd,
                DWMWA_CLOAKED,
                (&mut cloaked as *mut u32).cast(),
                std::mem::size_of::<u32>() as u32,
            )
            .is_ok()
                && cloaked != 0;
            ctx.out.push(Window {
                hwnd: hwnd.0 as isize,
                title: String::from_utf16_lossy(&buf[..len.min(buf.len())]),
                cloaked: is_cloaked,
                minimized: IsIconic(hwnd).as_bool(),
            });
        }
        true.into()
    }

    let mut ctx = Ctx { accept, images: HashMap::new(), out: Vec::new() };
    unsafe {
        let _ = EnumWindows(Some(each), LPARAM(&mut ctx as *mut Ctx as isize));
    }
    ctx.out
}

/// The file name of a process's executable, e.g. `Code.exe`.
fn image_name(pid: u32) -> Option<String> {
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).is_ok();
        let _ = CloseHandle(process);
        if !ok {
            return None;
        }
        let path = String::from_utf16_lossy(&buf[..len as usize]);
        path.rsplit('\\').next().map(str::to_string)
    }
}

// ── Bringing a window forward ─────────────────────────────────────────────────

/// Brings `hwnd` to the foreground; `Ok` names the step that worked.
///
/// Windows only lets a process move the foreground in a few situations
/// (SetForegroundWindow, "Remarks"): it is the foreground process, or it
/// received the last input event, or there is no foreground window, among
/// others. The click that asks for this lands on the island, a no-activate
/// window — and its content belongs to WebView2's own browser process
/// (msedgewebview2.exe owns the Chrome_RenderWidgetHostHWND inside our
/// window), so coucou.exe is usually *not* the process that received that
/// input. Hence a chain, each step only tried if the previous one did not
/// leave the window in front:
///
///   1. Restore it if minimized (ShowWindowAsync, so a hung window cannot
///      stall us), then SetForegroundWindow. Works whenever Windows considers
///      us entitled; costs nothing to try.
///   2. AttachThreadInput to the thread owning the current foreground window,
///      SetForegroundWindow again, detach. With the input queues joined, the
///      call comes from the foreground queue and is allowed. Documented API,
///      used here only in direct answer to the user's click on "Open", on a
///      thread of its own that is always detached and then ends.
///   3. Give up and FlashWindowEx the window — what Windows itself does when
///      it refuses a foreground change — so the user sees where it is.
///
/// Virtual desktops: the documented IVirtualDesktopManager can only *move* a
/// process's own windows, and the undocumented internal interface is off the
/// table. None is needed: activating a window that lives on another desktop
/// makes the shell switch to that desktop, which is exactly what the user
/// asked for.
///
/// No input is ever synthesised (no SendInput "Alt" trick).
fn activate(hwnd: isize) -> Result<&'static str, String> {
    let (tx, rx) = mpsc::channel();
    // Its own thread: AttachThreadInput ties *this* thread's input to another
    // one's. A short-lived thread that does nothing else cannot be wedged by a
    // hung foreground app in a way that matters, and the join below is bounded.
    std::thread::spawn(move || {
        let _ = tx.send(unsafe { activate_here(HWND(hwnd as *mut _)) });
    });
    rx.recv_timeout(Duration::from_secs(3))
        .unwrap_or_else(|_| Err("timed out bringing the window forward".into()))
}

unsafe fn activate_here(target: HWND) -> Result<&'static str, String> {
    unsafe {
        // AttachThreadInput needs both threads to have a message queue; this is
        // the documented way to make sure ours exists.
        let mut msg = MSG::default();
        let _ = PeekMessageW(&mut msg, None, 0, 0, PM_NOREMOVE);

        // 1.
        if IsIconic(target).as_bool() {
            let _ = ShowWindowAsync(target, SW_RESTORE);
        }
        if SetForegroundWindow(target).as_bool() && became_foreground(target) {
            return Ok("set directly");
        }

        // 2.
        let foreground = GetForegroundWindow();
        let theirs = if foreground.is_invalid() { 0 } else { GetWindowThreadProcessId(foreground, None) };
        let ours = GetCurrentThreadId();
        if theirs != 0 && theirs != ours && AttachThreadInput(ours, theirs, true).as_bool() {
            let set = SetForegroundWindow(target).as_bool();
            let _ = AttachThreadInput(ours, theirs, false);
            if set && became_foreground(target) {
                return Ok("set with the foreground thread's input attached");
            }
        }

        // 3.
        let flash = FLASHWINFO {
            cbSize: std::mem::size_of::<FLASHWINFO>() as u32,
            hwnd: target,
            dwFlags: FLASHW_ALL | FLASHW_TIMERNOFG,
            uCount: 0,
            dwTimeout: 0,
        };
        let _ = FlashWindowEx(&flash);
        Err("Windows kept the foreground where it was; the window's taskbar button flashes instead".into())
    }
}

/// The foreground changes synchronously, but give a desktop switch a moment.
fn became_foreground(target: HWND) -> bool {
    for _ in 0..20 {
        if unsafe { GetForegroundWindow() } == target {
            return true;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    false
}

// ── Doing it ──────────────────────────────────────────────────────────────────

/// Takes the user to the session's VS Code window, or opens its folder.
/// Blocking (enumeration, a short wait for the foreground): call it off the
/// main thread.
pub fn open_session(cwd: Option<String>, wsl_distro: Option<String>) -> Outcome {
    let windows = top_level_windows(&|image| image.eq_ignore_ascii_case(VSCODE_EXE));
    let titles: Vec<&str> = windows.iter().map(|w| w.title.as_str()).collect();
    let code = crate::find_on_path("code");
    let kind = if wsl_distro.as_deref().is_some_and(|d| !d.trim().is_empty()) { "WSL" } else { "Windows" };

    match plan(&titles, cwd.as_deref(), wsl_distro.as_deref(), code.is_some()) {
        Plan::Focus(i) => {
            let w = &windows[i];
            let where_ = match (w.cloaked, w.minimized) {
                (true, _) => " (cloaked: another virtual desktop)",
                (false, true) => " (minimized)",
                _ => "",
            };
            match activate(w.hwnd) {
                Ok(how) => {
                    log::line(format!("open session ({kind}): focused its VS Code window{where_} — {how}"));
                    Outcome::Focused
                }
                Err(why) => {
                    log::line(format!("open session ({kind}): found its VS Code window{where_} but {why}"));
                    Outcome::Failed
                }
            }
        }
        Plan::Open { code_args, folder } => {
            // No `cmd /C` anywhere near this: the folder name is the user's, and
            // cmd would read `&`, `^` and `%` in it as syntax. Rust quotes the
            // arguments for code.cmd itself (see find_on_path).
            if let (Some(args), Some(code)) = (code_args, code.as_ref()) {
                match Command::new(code).args(&args).creation_flags(CREATE_NO_WINDOW).spawn() {
                    Ok(_) => {
                        log::line(format!("open session ({kind}): no VS Code window for it — asked `code` to open it"));
                        return Outcome::Opened;
                    }
                    Err(err) => log::line(format!("open session ({kind}): `code` failed to start: {err}")),
                }
            }
            let path = match folder {
                Some(Folder::Windows(path)) => Some(path),
                Some(Folder::Wsl { distro, path }) => {
                    wsl::unc_path(&distro, &path).ok().map(|p| p.to_string_lossy().to_string())
                }
                None => None,
            };
            if let Some(path) = path {
                if Command::new("explorer").arg(&path).spawn().is_ok() {
                    log::line(format!("open session ({kind}): no `code` on PATH — opened the folder in Explorer"));
                    return Outcome::Explorer;
                }
            }
            log::line(format!("open session ({kind}): nothing to open"));
            Outcome::Failed
        }
        Plan::Fail(why) => {
            log::line(format!("open session ({kind}): refused — {why}"));
            Outcome::Failed
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const U: Option<&str> = Some("Ubuntu-24.04");

    fn pick(titles: &[&str], cwd: &str, distro: Option<&str>) -> Option<usize> {
        pick_window(titles, cwd, distro)
    }

    #[test]
    fn titles_are_read_the_way_vs_code_writes_them() {
        assert_eq!(workspace_part("main.rs - panita - Visual Studio Code"), Some("main.rs - panita"));
        assert_eq!(workspace_part("panita - Visual Studio Code"), Some("panita"));
        assert_eq!(workspace_part("● main.rs - panita - Visual Studio Code"), Some("main.rs - panita"));
        assert_eq!(workspace_part("main.rs - panita - Visual Studio Code [Administrator]"), Some("main.rs - panita"));
        assert_eq!(workspace_part("x - p [WSL: Ubuntu] - Visual Studio Code [Unsupported]"), Some("x - p [WSL: Ubuntu]"));
        // Not main windows, or no folder at all.
        assert_eq!(workspace_part("Visual Studio Code"), None);
        assert_eq!(workspace_part("Process Explorer"), None);
        assert_eq!(workspace_part("DevTools - vscode-file://vscode-app/x"), None);
        assert_eq!(workspace_part("panita - Visual Studio Code - Insiders"), None);
    }

    #[test]
    fn the_real_titles_from_this_machine() {
        // As listed on the machine this was written on (VS Code 1.140).
        let titles = [
            "Release Notes: 1.140.0 - struxto-especificador [WSL: Ubuntu-24.04] - Visual Studio Code",
            "Welcome - GitHub - Visual Studio Code",
        ];
        assert_eq!(pick(&titles, "/home/manua/struxto-especificador", U), Some(0));
        assert_eq!(pick(&titles, "/home/manua/struxto-especificador/src/app", U), Some(0));
        assert_eq!(pick(&titles, r"C:\Users\manua\Documents\GitHub\panita\windows", None), Some(1));
        assert_eq!(pick(&titles, r"C:\Users\manua\Documents\GitHub", None), Some(1));
        // A Windows session in a folder named like the WSL one: no.
        assert_eq!(pick(&titles, r"C:\work\struxto-especificador", None), None);
    }

    #[test]
    fn a_subfolder_session_finds_the_window_on_its_parent() {
        let titles = ["lib.rs - GitHub - Visual Studio Code"];
        assert_eq!(pick(&titles, r"C:\Users\manua\Documents\GitHub\panita\windows", None), Some(0));
        assert_eq!(pick(&titles, r"C:\Users\manua\Documents\GitHub\panita\windows\", None), Some(0));
        assert_eq!(pick(&titles, "C:/Users/manua/Documents/GitHub/panita", None), Some(0));
        assert_eq!(pick(&titles, r"C:\Users\manua\Documents", None), None, "a parent of the root is not inside it");
    }

    #[test]
    fn the_deepest_folder_with_a_window_wins() {
        let titles = [
            "a.rs - GitHub - Visual Studio Code",
            "b.rs - panita - Visual Studio Code",
            "c.rs - windows - Visual Studio Code",
        ];
        assert_eq!(pick(&titles, r"C:\x\GitHub\panita\windows\src", None), Some(2));
        assert_eq!(pick(&titles, r"C:\x\GitHub\panita\docs", None), Some(1));
        assert_eq!(pick(&titles, r"C:\x\GitHub\other", None), Some(0));
        // Deepest is decided by folder, whatever the window order.
        let reversed = [titles[2], titles[1], titles[0]];
        assert_eq!(pick(&reversed, r"C:\x\GitHub\panita\docs", None), Some(1));
    }

    #[test]
    fn a_wsl_session_never_gets_a_windows_window_and_vice_versa() {
        let titles = [
            "main.rs - proj - Visual Studio Code",
            "main.rs - proj [WSL: Ubuntu-24.04] - Visual Studio Code",
        ];
        assert_eq!(pick(&titles, "/home/u/proj", U), Some(1));
        assert_eq!(pick(&titles, r"C:\code\proj", None), Some(0));
        // Only the Windows window is open: a WSL session finds nothing…
        assert_eq!(pick(&titles[..1], "/home/u/proj", U), None);
        // …and only the WSL window: a Windows session finds nothing, even
        // through a weak (profile-shaped) match or an editor named like the folder.
        assert_eq!(pick(&titles[1..], r"C:\code\proj", None), None);
        assert_eq!(pick(&["proj - other [WSL: Ubuntu-24.04] - Visual Studio Code"], r"C:\code\proj", None), None);
        assert_eq!(pick(&["x - proj [WSL: Ubuntu-24.04] - Work - Visual Studio Code"], r"C:\code\proj", None), None);
    }

    #[test]
    fn a_wsl_session_needs_its_own_distro() {
        let titles = ["x - proj [WSL: Debian] - Visual Studio Code"];
        assert_eq!(pick(&titles, "/home/u/proj", U), None);
        assert_eq!(pick(&titles, "/home/u/proj", Some("Debian")), Some(0));
        // Other remotes are other machines.
        let ssh = ["x - proj [SSH: build-box] - Visual Studio Code"];
        assert_eq!(pick(&ssh, "/home/u/proj", U), None);
        assert_eq!(pick(&ssh, r"C:\proj", None), None);
    }

    #[test]
    fn windows_names_ignore_case_and_linux_names_do_not() {
        assert_eq!(pick(&["x - Panita - Visual Studio Code"], r"c:\github\PANITA", None), Some(0));
        assert_eq!(pick(&["x - Ünïcode - Visual Studio Code"], r"C:\ÜNÏCODE", None), Some(0));
        assert_eq!(pick(&["x - Proj [WSL: Ubuntu-24.04] - Visual Studio Code"], "/home/u/proj", U), None);
        assert_eq!(pick(&["x - proj [WSL: Ubuntu-24.04] - Visual Studio Code"], "/home/u/proj", U), Some(0));
    }

    #[test]
    fn folder_names_with_dashes_and_brackets_still_match() {
        let titles = ["notes.md - my - project - Visual Studio Code"];
        assert_eq!(pick(&titles, r"C:\work\my - project", None), Some(0));
        assert_eq!(pick(&["my - project [WSL: Ubuntu-24.04] - Visual Studio Code"], "/srv/my - project", U), Some(0));
        assert_eq!(pick(&["a [old] - Visual Studio Code"], r"C:\x\a [old]", None), Some(0));
    }

    #[test]
    fn no_editor_dirty_editors_profiles_and_admin_windows() {
        assert_eq!(pick(&["panita - Visual Studio Code"], r"C:\x\panita", None), Some(0));
        assert_eq!(pick(&["● lib.rs - panita - Visual Studio Code"], r"C:\x\panita", None), Some(0));
        assert_eq!(pick(&["lib.rs - panita - Work - Visual Studio Code"], r"C:\x\panita", None), Some(0));
        assert_eq!(pick(&["panita - Work - Visual Studio Code"], r"C:\x\panita", None), Some(0));
        assert_eq!(pick(&["lib.rs - panita - Visual Studio Code [Administrator]"], r"C:\x\panita", None), Some(0));
        assert_eq!(pick(&["proj [WSL: Ubuntu-24.04] - Visual Studio Code"], "/home/u/proj", U), Some(0));
    }

    #[test]
    fn ties_go_to_the_strongest_then_the_frontmost() {
        // Two windows on folders called `windows` (different parents): the one
        // EnumWindows lists first — the frontmost — wins.
        let same = ["a - windows - Visual Studio Code", "b - windows - Visual Studio Code"];
        assert_eq!(pick(&same, r"C:\x\panita\windows", None), Some(0));
        // A root match beats a profile-shaped one at the same depth…
        let mixed = ["panita - Work - Visual Studio Code", "x.rs - panita - Visual Studio Code"];
        assert_eq!(pick(&mixed, r"C:\x\panita", None), Some(1));
        // …but depth comes first: a weak match on the cwd itself beats a strong
        // one on its parent.
        let depth = ["x.rs - GitHub - Visual Studio Code", "panita - Work - Visual Studio Code"];
        assert_eq!(pick(&depth, r"C:\GitHub\panita", None), Some(1));
    }

    #[test]
    fn titles_that_are_not_vs_code_windows_or_have_no_folder_never_match() {
        let titles = ["Visual Studio Code", "panita", "Welcome - Visual Studio Code", "panita - Notepad"];
        assert_eq!(pick(&titles, r"C:\x\panita", None), None);
        // "Welcome" is the only thing in front of the app name; it only
        // matches a folder literally called Welcome.
        assert_eq!(pick(&titles, r"C:\x\Welcome", None), Some(2));
        assert_eq!(pick(&[], r"C:\x\panita", None), None);
    }

    #[test]
    fn paths_of_every_windows_shape() {
        let titles = ["x - proj - Visual Studio Code"];
        assert_eq!(pick(&titles, r"\\?\C:\work\proj", None), Some(0));
        assert_eq!(pick(&titles, r"\\server\share\proj", None), Some(0));
        assert_eq!(pick(&titles, r"\\?\UNC\server\share\proj\sub", None), Some(0));
        assert_eq!(pick(&titles, r"\\wsl.localhost\Ubuntu-24.04\home\u\proj", None), Some(0));
        // The share and the drive are not folders.
        assert_eq!(pick(&["x - share - Visual Studio Code"], r"\\server\share\proj", None), None);
        assert_eq!(pick(&["x - C: - Visual Studio Code"], r"C:\proj", None), None);
        // Relative or Git Bash paths are not Windows paths.
        assert_eq!(root_names("proj", None), None);
        assert_eq!(root_names("/c/Users/proj", None), None);
        assert_eq!(root_names(r"C:\", None), Some(vec![]));
        assert_eq!(root_names("relative/proj", U), None);
        assert_eq!(
            root_names("/home/u/./work/proj/", U),
            Some(vec!["proj [WSL: Ubuntu-24.04]".into(), "work [WSL: Ubuntu-24.04]".into()])
        );
    }

    #[test]
    fn walking_up_stops_below_the_home_folder() {
        let cwd = r"C:\Users\manua\Documents\GitHub\panita\windows";
        assert_eq!(
            root_names(cwd, None),
            Some(vec!["windows".into(), "panita".into(), "GitHub".into(), "Documents".into()])
        );
        // The workspace that contains the project is still found...
        assert_eq!(pick(&["x - GitHub - Visual Studio Code"], cwd, None), Some(0));
        // ...but never a window that merely shares a name with the user folder or above.
        assert_eq!(pick(&["x - manua - Visual Studio Code", "y - Users - Visual Studio Code"], cwd, None), None);
        assert_eq!(pick(&["x - u [WSL: Ubuntu-24.04] - Visual Studio Code"], "/home/u/proj", U), None);
        assert_eq!(pick(&["x - home [WSL: Ubuntu-24.04] - Visual Studio Code"], "/home/u/proj", U), None);
        assert_eq!(root_names("/root/proj", U), Some(vec!["proj [WSL: Ubuntu-24.04]".into()]));
        assert_eq!(root_names("/mnt/c/Users/manua/proj", U), Some(vec!["proj [WSL: Ubuntu-24.04]".into()]));
        assert_eq!(root_names(r"C:\Users\manua", None), Some(vec![]));
        // Outside a home folder nothing is dropped.
        assert_eq!(root_names(r"D:\work\proj", None), Some(vec!["proj".into(), "work".into()]));
    }

    #[test]
    fn the_plan_focuses_opens_or_refuses() {
        let titles = ["x - GitHub - Visual Studio Code", "y - proj [WSL: Ubuntu-24.04] - Visual Studio Code"];
        assert_eq!(plan(&titles, Some(r"C:\a\GitHub\panita"), None, true), Plan::Focus(0));
        assert_eq!(plan(&titles, Some("/home/u/proj"), U, true), Plan::Focus(1));
        // Matching happens whether or not `code` is on PATH.
        assert_eq!(plan(&titles, Some("/home/u/proj"), U, false), Plan::Focus(1));

        // No window: `code <cwd>` — exactly as "Open terminal" does today.
        assert_eq!(
            plan(&titles, Some(r"C:\work\other app"), None, true),
            Plan::Open {
                code_args: Some(vec![r"C:\work\other app".into()]),
                folder: Some(Folder::Windows(r"C:\work\other app".into())),
            }
        );
        // No window, WSL: the remote folder URI.
        assert_eq!(
            plan(&titles, Some("/home/u/my app"), U, true),
            Plan::Open {
                code_args: Some(vec!["--folder-uri".into(), "vscode-remote://wsl+Ubuntu-24.04/home/u/my%20app".into()]),
                folder: Some(Folder::Wsl { distro: "Ubuntu-24.04".into(), path: "/home/u/my app".into() }),
            }
        );
        // No `code`: Explorer only.
        assert_eq!(
            plan(&[], Some("/home/u/p"), U, false),
            Plan::Open { code_args: None, folder: Some(Folder::Wsl { distro: "Ubuntu-24.04".into(), path: "/home/u/p".into() }) }
        );
        assert_eq!(
            plan(&[], Some(r"C:\p"), None, false),
            Plan::Open { code_args: None, folder: Some(Folder::Windows(r"C:\p".into())) }
        );
        // No folder at all: just VS Code, or nothing.
        assert_eq!(plan(&titles, None, None, true), Plan::Open { code_args: Some(vec![]), folder: None });
        assert_eq!(plan(&titles, Some("  "), U, false), Plan::Open { code_args: None, folder: None });
        // An empty distro is a Windows session.
        assert_eq!(plan(&titles, Some(r"C:\a\GitHub"), Some(""), true), Plan::Focus(0));

        // Refused before anything runs.
        assert!(matches!(plan(&titles, Some("/home/u/proj"), Some("bad name"), true), Plan::Fail(_)));
        assert!(matches!(plan(&titles, Some("/home/u/proj"), Some("x;rm -rf ~"), true), Plan::Fail(_)));
        assert!(matches!(plan(&titles, Some(r"C:\a"), U, true), Plan::Fail(_)), "a WSL session needs a Linux path");
        assert!(matches!(plan(&titles, Some("relative"), None, true), Plan::Fail(_)));
        assert!(matches!(plan(&titles, Some("/home/u"), None, true), Plan::Fail(_)), "a Windows session needs a Windows path");
    }

    #[test]
    fn folder_uris_are_percent_encoded_like_vs_code_does() {
        let uri = |p: &str| folder_uri("Ubuntu-24.04", p).unwrap();
        assert_eq!(uri("/home/manua/struxto-especificador"), "vscode-remote://wsl+Ubuntu-24.04/home/manua/struxto-especificador");
        assert_eq!(uri("/home/u/my app"), "vscode-remote://wsl+Ubuntu-24.04/home/u/my%20app");
        assert_eq!(uri("/home/u/a#b?c%d"), "vscode-remote://wsl+Ubuntu-24.04/home/u/a%23b%3Fc%25d");
        assert_eq!(uri("/home/u/café"), "vscode-remote://wsl+Ubuntu-24.04/home/u/caf%C3%A9");
        assert_eq!(uri("/home/u/a+b&c'd(e)[f]"), "vscode-remote://wsl+Ubuntu-24.04/home/u/a%2Bb%26c%27d%28e%29%5Bf%5D");
        assert_eq!(uri("/home/u/v1.2_x~y"), "vscode-remote://wsl+Ubuntu-24.04/home/u/v1.2_x~y");
        assert_eq!(uri("/home//u/"), "vscode-remote://wsl+Ubuntu-24.04/home/u");
        assert_eq!(uri("/"), "vscode-remote://wsl+Ubuntu-24.04/");
        assert!(folder_uri("Ubuntu-24.04", "home/u").is_err());
        assert!(folder_uri("Ubuntu-24.04", "/home/u\n").is_err());
        assert!(folder_uri("Ubuntu 24.04", "/home/u").is_err());
    }

    /// The URI goes through code.cmd, a batch file, where `%` is syntax. Rust
    /// escapes arguments for batch files; this checks a percent-encoded URI
    /// reaches the batch file's `%*` — which is what code.cmd forwards to VS
    /// Code — intact.
    #[test]
    fn a_percent_encoded_uri_survives_a_batch_file() {
        let dir = std::env::temp_dir().join(format!("coucou-bat-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let bat = dir.join("echoargs.cmd");
        std::fs::write(&bat, "@echo off\r\necho %*> \"%~dp0out.txt\"\r\n").unwrap();
        let uri = folder_uri("Ubuntu-24.04", "/home/u/100% my app/%PATH%").unwrap();
        let status = Command::new(&bat)
            .args(["--folder-uri", &uri])
            .creation_flags(CREATE_NO_WINDOW)
            .status()
            .unwrap();
        assert!(status.success());
        let out = std::fs::read_to_string(dir.join("out.txt")).unwrap();
        eprintln!("batch file saw: {}", out.trim());
        assert!(out.contains(&uri), "batch file saw {out:?}, expected {uri}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Enumeration against throwaway windows this test creates: tool windows
    /// shown without activation, off screen — never focused, never on the
    /// taskbar, never in the user's way. Checks what is listed and what is not.
    #[test]
    fn enumeration_lists_visible_unowned_titled_windows_cloaked_included() {
        use windows::core::w;
        use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_CLOAK};
        use windows::Win32::UI::WindowsAndMessaging::{
            CreateWindowExW, DestroyWindow, ShowWindow, SW_SHOWMINNOACTIVE, SW_SHOWNOACTIVATE, WS_EX_NOACTIVATE,
            WS_EX_TOOLWINDOW, WS_POPUP,
        };

        let tag = format!("coucou-enum-test-{}", std::process::id());
        let make = |title: &str, owner: Option<HWND>| unsafe {
            let wide: Vec<u16> = title.encode_utf16().chain(Some(0)).collect();
            CreateWindowExW(
                WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
                w!("STATIC"),
                windows::core::PCWSTR(wide.as_ptr()),
                WS_POPUP,
                -32000,
                -32000,
                8,
                8,
                owner,
                None,
                None,
                None,
            )
            .unwrap()
        };
        let foreground_before = unsafe { GetForegroundWindow() };

        let shown = make(&format!("shown - {tag} - Visual Studio Code"), None);
        let cloaked = make(&format!("cloaked - {tag} - Visual Studio Code"), None);
        let minimized = make(&format!("minimized - {tag} - Visual Studio Code"), None);
        let hidden = make(&format!("hidden - {tag} - Visual Studio Code"), None);
        let owned = make(&format!("owned - {tag} - Visual Studio Code"), Some(shown));
        let untitled = make("", None);
        unsafe {
            let _ = ShowWindow(shown, SW_SHOWNOACTIVATE);
            let _ = ShowWindow(cloaked, SW_SHOWNOACTIVATE);
            let _ = ShowWindow(owned, SW_SHOWNOACTIVATE);
            let _ = ShowWindow(untitled, SW_SHOWNOACTIVATE);
            let _ = ShowWindow(minimized, SW_SHOWMINNOACTIVE);
        }
        let on: BOOL = true.into();
        let cloak_ok = unsafe {
            DwmSetWindowAttribute(cloaked, DWMWA_CLOAK, (&on as *const BOOL).cast(), std::mem::size_of::<BOOL>() as u32)
        }
        .is_ok();

        let me = std::env::current_exe().unwrap();
        let me = me.file_name().unwrap().to_string_lossy().to_string();
        let found = top_level_windows(&|image| image.eq_ignore_ascii_case(&me));
        let ours: Vec<&Window> = found.iter().filter(|w| w.title.contains(&tag)).collect();
        let titles: Vec<String> = ours.iter().map(|w| w.title.split(" - ").next().unwrap().to_string()).collect();

        // Nothing here may have taken the foreground from the user.
        assert_eq!(unsafe { GetForegroundWindow() }, foreground_before);
        unsafe {
            for hwnd in [owned, shown, cloaked, minimized, hidden, untitled] {
                let _ = DestroyWindow(hwnd);
            }
        }

        let mut sorted = titles.clone();
        sorted.sort();
        assert_eq!(sorted, ["cloaked", "minimized", "shown"], "listed: {titles:?}");
        let get = |name: &str| ours.iter().find(|w| w.title.starts_with(name)).unwrap();
        assert!(!get("shown").cloaked && !get("shown").minimized);
        assert!(get("minimized").minimized);
        if cloak_ok {
            assert!(get("cloaked").cloaked, "cloaked windows are listed and reported as such");
        } else {
            eprintln!("DWMWA_CLOAK refused here — cloaked flag not exercised");
        }
        // And a window from any other process is never listed for this filter.
        assert!(found.iter().all(|w| !w.title.is_empty()));
        // The matcher finds the right one among them.
        let only: Vec<&str> = ours.iter().map(|w| w.title.as_str()).collect();
        let i = pick_window(&only, &format!(r"C:\x\{tag}\sub"), None).unwrap();
        assert!(only[i].contains(&tag));
    }
}
