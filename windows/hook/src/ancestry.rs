//! Walking up a process tree, for "take me to the terminal this session runs in".
//!
//! Shared verbatim by coucou-hook.exe and coucou.exe (the app pulls this file in
//! with `#[path]`, like instance.rs): the relay walks Windows processes at hook
//! time (win.rs), the app walks Linux processes inside a WSL distro when the
//! user clicks (terminal.rs). Both hand the result — nearest first — to the
//! companion VS Code extension, which looks for the one PID that is the shell
//! of one of its terminals.
//!
//! The walk itself knows nothing about either OS: it is handed a `parent_of`
//! lookup, so the rules below are tested on synthetic process tables.

// Two crates compile this file and each uses a different part of it.
#![allow(dead_code)]

/// Deepest walk, in steps. A session's terminal shell sits three to five steps
/// up (relay → Git Bash → claude → shell; inside WSL, claude → shell), and
/// everything above it is VS Code's own plumbing; this leaves room for
/// wrappers (a `claude.cmd`, a nested shell) without ever walking far.
pub const MAX_DEPTH: usize = 24;

/// Linux's PID_MAX_LIMIT on 64-bit: no Linux PID is ever larger. Both ends
/// refuse a `--wsl-ppid` above it.
pub const MAX_LINUX_PID: u32 = 4_194_304;

/// The ancestors of `start`, nearest first, `start` itself not included.
///
/// `parent_of(pid)` returns the parent of `pid`, or `None` when it is unknown —
/// the process is gone, or the caller's guard says the "parent" is a newer
/// process that merely reuses the PID (see win.rs and terminal.rs). The walk
/// stops there, at PID 0, at a PID it has already seen (a loop: Windows keeps a
/// dead parent's PID in its children, and PIDs are reused), and after `max`
/// steps. It can never run forever, and never yields a PID twice.
pub fn ancestors(start: u32, max: usize, mut parent_of: impl FnMut(u32) -> Option<u32>) -> Vec<u32> {
    let mut out: Vec<u32> = Vec::new();
    let mut current = start;
    while out.len() < max {
        let Some(parent) = parent_of(current) else { break };
        if parent == 0 || parent == start || out.contains(&parent) {
            break;
        }
        out.push(parent);
        current = parent;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn table(pairs: &[(u32, u32)]) -> HashMap<u32, u32> {
        pairs.iter().copied().collect()
    }

    fn walk(pairs: &[(u32, u32)], start: u32, max: usize) -> Vec<u32> {
        let t = table(pairs);
        ancestors(start, max, |pid| t.get(&pid).copied())
    }

    #[test]
    fn a_plain_chain_nearest_first() {
        // relay 50 → bash 40 → claude 30 → pwsh 20 → Code 10 → (gone)
        let chain = [(50, 40), (40, 30), (30, 20), (20, 10), (10, 7)];
        assert_eq!(walk(&chain, 50, MAX_DEPTH), [40, 30, 20, 10, 7]);
        // A missing entry ends the walk where it is.
        assert_eq!(walk(&chain[..3], 50, MAX_DEPTH), [40, 30, 20]);
        assert_eq!(walk(&chain, 99, MAX_DEPTH), Vec::<u32>::new());
    }

    #[test]
    fn pid_zero_ends_the_walk() {
        assert_eq!(walk(&[(5, 4), (4, 0)], 5, MAX_DEPTH), [4]);
        // Linux: init's parent is 0.
        assert_eq!(walk(&[(300, 2), (2, 1), (1, 0)], 300, MAX_DEPTH), [2, 1]);
    }

    #[test]
    fn loops_end_without_repeating_a_pid() {
        // Two processes naming each other (a reused PID), and one naming itself.
        assert_eq!(walk(&[(5, 4), (4, 3), (3, 4)], 5, MAX_DEPTH), [4, 3]);
        assert_eq!(walk(&[(5, 4), (4, 4)], 5, MAX_DEPTH), [4]);
        // Back to the start.
        assert_eq!(walk(&[(5, 4), (4, 5)], 5, MAX_DEPTH), [4]);
        assert_eq!(walk(&[(5, 5)], 5, MAX_DEPTH), Vec::<u32>::new());
    }

    #[test]
    fn depth_is_bounded() {
        let long: Vec<(u32, u32)> = (2..1000).map(|p| (p, p - 1)).collect();
        let got = walk(&long, 999, MAX_DEPTH);
        assert_eq!(got.len(), MAX_DEPTH);
        assert_eq!(got[0], 998);
        assert_eq!(walk(&long, 999, 3), [998, 997, 996]);
        assert_eq!(walk(&long, 999, 0), Vec::<u32>::new());
    }

    #[test]
    fn the_lookup_is_asked_once_per_step() {
        // The Windows guard opens a process per lookup: no wasted calls.
        let t = table(&[(5, 4), (4, 3), (3, 0)]);
        let mut asked = Vec::new();
        let got = ancestors(5, MAX_DEPTH, |pid| {
            asked.push(pid);
            t.get(&pid).copied()
        });
        assert_eq!(got, [4, 3]);
        assert_eq!(asked, [5, 4, 3]);
    }
}
