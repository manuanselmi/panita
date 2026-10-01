//! The relay's own ancestry on Windows: which processes it runs under.
//!
//! Claude Code runs a hook through a shell (Git Bash on Windows) under its own
//! `claude` process, which runs under the shell of the terminal the user typed
//! `claude` in. VS Code's `Terminal.processId` is that shell's PID, so the
//! chain of parent PIDs from here up identifies the terminal tab. The relay
//! forwards it as `ancestor_pids`; the app keeps the latest per session and,
//! when the user clicks a session's ↗, hands it to the companion VS Code
//! extension (see the app's terminal.rs).
//!
//! How the parent is read. A Toolhelp snapshot was the first version and is
//! kept below for the tests to compare against, but it copies the whole
//! process and thread list: ~12 ms with ~450 processes on the machine this was
//! written on, on every hook event. Walking up one process at a time costs one
//! OpenProcess per step instead — NtQueryInformationProcess(ProcessBasicInformation)
//! for the parent PID and GetProcessTimes for the creation time on the same
//! handle — ~16 µs for the whole chain of eight there (see `ancestry_cost`),
//! cheap enough to run on every event, inline.
//! NtQueryInformationProcess is ntdll's, documented with the usual "may change"
//! caveat; ProcessBasicInformation's InheritedFromUniqueProcessId is what
//! Toolhelp itself reports as th32ParentProcessID.
//!
//! Windows keeps a parent's PID in its children after the parent exits, and
//! reuses PIDs, so a "parent" created *after* its child is a stranger that
//! inherited the number: the walk stops there (a process is always created
//! before the processes it creates). Everything from the relay up to VS Code is
//! alive while the hook runs, so the guard only trims the stale tail past the
//! first dead link.
//!
//! Every failure means an empty or shorter list, never an error: this is
//! context, and the hook must go on without it.

use std::collections::HashMap;

use windows::Wdk::System::Threading::{NtQueryInformationProcess, ProcessBasicInformation};
use windows::Win32::Foundation::{CloseHandle, FILETIME, HANDLE};
use windows::Win32::System::Threading::{
    GetCurrentProcess, GetProcessTimes, OpenProcess, PROCESS_BASIC_INFORMATION, PROCESS_QUERY_LIMITED_INFORMATION,
};

use crate::ancestry;

/// What the walk needs to know about one process.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Facts {
    parent: u32,
    /// Creation time, in FILETIME units.
    created: u64,
}

/// The relay's ancestors, nearest first (its own PID not included).
pub fn ancestor_pids() -> Vec<u32> {
    let me = std::process::id();
    // The pseudo-handle needs no closing.
    let Some(mine) = (unsafe { facts_of(GetCurrentProcess()) }) else { return Vec::new() };
    let mut known: HashMap<u32, Option<Facts>> = HashMap::from([(me, Some(mine))]);
    let mut facts = |pid: u32| *known.entry(pid).or_insert_with(|| open_facts(pid));

    ancestry::ancestors(me, ancestry::MAX_DEPTH, |child| {
        let child = facts(child)?;
        // A process we cannot open (another account's, or a protected one) is
        // past anything that can be a terminal of ours.
        let parent = facts(child.parent)?;
        (parent.created <= child.created).then_some(child.parent)
    })
}

/// Parent PID and creation time of `pid`; `None` if it cannot be opened.
fn open_facts(pid: u32) -> Option<Facts> {
    if pid == 0 {
        return None;
    }
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let facts = facts_of(process);
        let _ = CloseHandle(process);
        facts
    }
}

/// `process` is borrowed, never closed.
unsafe fn facts_of(process: HANDLE) -> Option<Facts> {
    let mut basic = PROCESS_BASIC_INFORMATION::default();
    let mut len = 0u32;
    let status = unsafe {
        NtQueryInformationProcess(
            process,
            ProcessBasicInformation,
            (&mut basic as *mut PROCESS_BASIC_INFORMATION).cast(),
            std::mem::size_of::<PROCESS_BASIC_INFORMATION>() as u32,
            &mut len,
        )
    };
    if status.is_err() {
        return None;
    }
    let (mut created, mut exited, mut kernel, mut user) =
        (FILETIME::default(), FILETIME::default(), FILETIME::default(), FILETIME::default());
    unsafe { GetProcessTimes(process, &mut created, &mut exited, &mut kernel, &mut user) }.ok()?;
    Some(Facts {
        parent: u32::try_from(basic.InheritedFromUniqueProcessId).ok()?,
        created: ((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };

    /// PID → parent PID for every process, from one Toolhelp snapshot: the
    /// reference the walk above is checked against.
    fn toolhelp_parents() -> HashMap<u32, u32> {
        let mut table = HashMap::new();
        unsafe {
            let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return table };
            let mut entry =
                PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
            if Process32FirstW(snapshot, &mut entry).is_ok() {
                loop {
                    table.insert(entry.th32ProcessID, entry.th32ParentProcessID);
                    if Process32NextW(snapshot, &mut entry).is_err() {
                        break;
                    }
                }
            }
            let _ = CloseHandle(snapshot);
        }
        table
    }

    /// The real thing, on this machine: the test binary's ancestry is cargo and
    /// whatever started it. Every step is what Toolhelp says the parent is, and
    /// every PID is a live process created no later than the one below it.
    #[test]
    fn the_test_process_has_a_live_ancestry_that_matches_toolhelp() {
        let chain = ancestor_pids();
        assert!(!chain.is_empty(), "the test process has a parent");
        assert!(!chain.contains(&std::process::id()));
        let table = toolhelp_parents();
        let mut child = std::process::id();
        let mut below = unsafe { facts_of(GetCurrentProcess()) }.unwrap().created;
        for pid in &chain {
            assert_eq!(table.get(&child), Some(pid), "the parent of {child}");
            let at = open_facts(*pid).expect("every listed ancestor is alive and ours").created;
            assert!(at <= below, "pid {pid} was created after its child");
            (child, below) = (*pid, at);
        }
    }

    #[test]
    fn processes_that_cannot_be_opened_have_no_facts() {
        assert_eq!(open_facts(0), None);
        // PID 4 is the System process: not ours to open with these rights.
        assert_eq!(open_facts(4).map(|_| ()), None);
        // Odd PIDs are never handed out on Windows.
        assert_eq!(open_facts(u32::MAX - 2), None);
    }

    /// How long one walk takes here, against a Toolhelp snapshot. Prints;
    /// asserts only that the walk is the cheaper of the two by far.
    /// `cargo test -p coucou-hook --release -- --nocapture ancestry_cost`
    #[test]
    fn ancestry_cost() {
        let runs = 200;
        let started = std::time::Instant::now();
        let mut depth = 0;
        for _ in 0..runs {
            depth = ancestor_pids().len();
        }
        let walk = started.elapsed() / runs;
        let started = std::time::Instant::now();
        let mut processes = 0;
        for _ in 0..runs {
            processes = toolhelp_parents().len();
        }
        let snapshot = started.elapsed() / runs;
        eprintln!("ancestor_pids: {walk:?} per walk ({depth} ancestors); one Toolhelp snapshot: {snapshot:?} ({processes} processes)");
        assert!(walk < std::time::Duration::from_millis(5), "{walk:?} per walk");
    }
}
