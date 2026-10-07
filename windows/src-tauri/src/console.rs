// "Open" for a session typed into a plain console — cmd or PowerShell in
// Windows Terminal, or in the classic console host — rather than in a VS Code
// terminal: bring that console's window to the front.
//
// The relay forwards its Windows ancestry with every hook event (terminal.rs).
// Somewhere up that chain is the `claude` process the user started, attached to
// the console they typed it in. Windows has no call for "which window shows the
// console of process N", but a process without a console of its own can
// AttachConsole to another process's console and ask GetConsoleWindow:
//
//   - classic console host (conhost): that *is* the window on screen;
//   - Windows Terminal (pseudoconsole): it is a hidden stand-in window whose
//     owner is the Terminal window showing the tab. Windows Terminal sets that
//     owner precisely so callers like this one can find it — including for a
//     console handed over to it by "default terminal" (cmd opened from Start).
//
// So: for each ancestor, nearest first, attach, read the console window,
// detach; resolve it to its root owner; the first *visible* window wins. Hidden
// consoles are skipped on the way: Claude Code runs hooks in a console of
// their own that nobody sees, and VS Code's terminals have hidden ones too.
// A VS Code window is never picked here — vscode.rs knows those better.
//
// Only the window: which Windows Terminal *tab* holds the session is not
// something Windows Terminal exposes, so the window comes forward on whatever
// tab it shows.
//
// AttachConsole is process-wide. It is held for the one call that needs it,
// under a lock, with Ctrl+C/Ctrl+Break ignored meanwhile (a Ctrl+C typed in
// that console at that instant would otherwise reach us too) and our standard
// handles put back afterwards. It needs us to have no console of our own: the
// release build has none (windows_subsystem); a debug build started from a
// terminal does, and then this step simply finds nothing.

use std::sync::Mutex;

use windows::Win32::Foundation::HWND;
use windows::Win32::System::Console::{
    AttachConsole, FreeConsole, GetConsoleWindow, GetStdHandle, SetConsoleCtrlHandler, SetStdHandle,
    STD_ERROR_HANDLE, STD_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
};
use windows::Win32::UI::WindowsAndMessaging::{GetAncestor, IsWindowVisible, GA_ROOTOWNER};

use crate::log;
use crate::vscode::{self, Outcome};

/// Ancestors looked at. The session's own console sits a few links up (relay,
/// the hook's shell, claude, the user's shell); past this it is not there.
const MAX_PROBES: usize = 12;

/// One AttachConsole at a time: it changes the whole process's console.
static ATTACH: Mutex<()> = Mutex::new(());

/// What probing one ancestor found.
#[derive(Debug, Clone, PartialEq)]
pub struct Found {
    pub hwnd: isize,
    /// Executable of the window's process, e.g. `WindowsTerminal.exe`.
    pub image: Option<String>,
}

/// The first ancestor whose console shows on screen, from `probe`'s answers
/// (pure: `probe` does the Win32 part). When that console is VS Code's, the
/// session lives in VS Code and is left to vscode.rs.
pub fn pick(ancestors: &[u32], mut probe: impl FnMut(u32) -> Option<Found>) -> Option<(u32, Found)> {
    for &pid in ancestors.iter().take(MAX_PROBES) {
        if let Some(found) = probe(pid) {
            let is_vscode = found.image.as_deref().is_some_and(|i| i.eq_ignore_ascii_case("Code.exe"));
            return (!is_vscode).then_some((pid, found));
        }
    }
    None
}

/// The visible window showing `pid`'s console, if it has one.
fn probe(pid: u32) -> Option<Found> {
    let console = console_window_of(pid)?;
    unsafe {
        let owner = GetAncestor(console, GA_ROOTOWNER);
        let window = if owner.is_invalid() { console } else { owner };
        if !IsWindowVisible(window).as_bool() {
            return None;
        }
        Some(Found { hwnd: window.0 as isize, image: vscode::window_image(window) })
    }
}

/// GetConsoleWindow as seen from `pid`'s console.
fn console_window_of(pid: u32) -> Option<HWND> {
    let _guard = ATTACH.lock().unwrap_or_else(|e| e.into_inner());
    unsafe {
        // We have a console of our own (a debug build run from a terminal):
        // attaching would fail, and freeing ours is not ours to do.
        if !GetConsoleWindow().is_invalid() {
            return None;
        }
        let saved: Vec<(STD_HANDLE, _)> = [STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE]
            .into_iter()
            .filter_map(|which| GetStdHandle(which).ok().map(|h| (which, h)))
            .collect();
        let _ = SetConsoleCtrlHandler(None, true);
        let window = if AttachConsole(pid).is_ok() {
            let window = GetConsoleWindow();
            let _ = FreeConsole();
            (!window.is_invalid()).then_some(window)
        } else {
            None
        };
        let _ = SetConsoleCtrlHandler(None, false);
        for (which, handle) in saved {
            let _ = SetStdHandle(which, handle);
        }
        window
    }
}

/// Brings the session's console window forward. `None`: no console of the
/// session is on screen, and the VS Code step should run as before.
/// Blocking: call it off the main thread.
pub fn open_session(ancestors: &[u32], kind: &str) -> Option<Outcome> {
    let (pid, found) = pick(ancestors, probe)?;
    let what = found.image.as_deref().unwrap_or("a console window");
    Some(match vscode::activate(found.hwnd) {
        Ok(how) => {
            log::line(format!("open session ({kind}): focused its console ({what}, process {pid}) — {how}"));
            Outcome::Focused
        }
        Err(why) => {
            log::line(format!("open session ({kind}): found its console ({what}, process {pid}) but {why}"));
            Outcome::Failed
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn found(hwnd: isize, image: &str) -> Option<Found> {
        Some(Found { hwnd, image: Some(image.to_string()) })
    }

    #[test]
    fn the_nearest_visible_console_wins() {
        // relay → hook shell (hidden console) → claude → cmd → explorer
        let chain = [10, 20, 30, 40];
        let got = pick(&chain, |pid| match pid {
            30 | 40 => found(7, "WindowsTerminal.exe"),
            _ => None,
        });
        assert_eq!(got, Some((30, Found { hwnd: 7, image: Some("WindowsTerminal.exe".into()) })));
    }

    #[test]
    fn nothing_on_screen_means_nothing() {
        assert_eq!(pick(&[1, 2, 3], |_| None), None);
        assert_eq!(pick(&[], |_| found(1, "conhost.exe")), None);
    }

    #[test]
    fn vs_code_windows_are_left_to_the_vs_code_step() {
        assert_eq!(pick(&[1, 2], |_| found(5, "Code.exe")), None);
        assert_eq!(pick(&[1, 2], |p| if p == 1 { found(5, "code.EXE") } else { found(6, "conhost.exe") }), None);
    }

    #[test]
    fn only_a_bounded_number_of_ancestors_is_probed() {
        let chain: Vec<u32> = (1..=50).collect();
        let mut asked = 0;
        assert_eq!(pick(&chain, |_| { asked += 1; None }), None);
        assert_eq!(asked, MAX_PROBES);
    }
}
