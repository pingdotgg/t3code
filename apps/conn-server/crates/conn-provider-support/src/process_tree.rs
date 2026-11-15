//! T3's `terminatePosixOwnedProcessTree` (`packages/provider-acp/src/server/AcpSessionRuntime.ts`)
//! on Linux, where an ACP agent's runtime owns its descendants' process groups
//! (`ownDescendantProcessGroups`): the agent's process tree is read from `/proc`, its
//! descendants get SIGTERM deepest first (four passes, 10 ms apart, so children forked during
//! the stop are caught), then the root, then after `grace` every one of them SIGKILL (four
//! passes). A process counts as the same one only while its start time matches, and nothing in
//! this server's own process group is signalled. T3 also skips its own session: it starts agents
//! `detached`, so each leads a session of its own. Here an agent leads a process group but stays
//! in the server's session (`setsid` would need `unsafe` code), so only the group is skipped.
//!
//! Not ported: T3's delegated cgroup lease (`makeLinuxCgroupController`), which it prefers
//! where the host delegates a writable cgroup v2 subtree.

use std::collections::HashMap;
use std::time::Duration;

use rustix::process::Signal;

/// T3's `discoveryPasses` default (clamped to 2..=8 there).
const PASSES: usize = 4;
const PASS_GAP: Duration = Duration::from_millis(10);

/// One process as `/proc/<pid>/stat` names it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Identity {
    pid: u32,
    ppid: u32,
    pgid: u32,
    start_time: u64,
}

impl Identity {
    fn same_process(&self, other: &Identity) -> bool {
        self.pid == other.pid && self.start_time == other.start_time
    }
}

/// `pid (comm) S ppid pgrp session ... starttime`: the fields after the last ')' (comm may hold
/// one), `starttime` being the 22nd field of the line.
fn parse_stat(pid: u32, stat: &str) -> Option<Identity> {
    let rest = stat.get(stat.rfind(')')? + 1..)?;
    let fields: Vec<&str> = rest.split_whitespace().collect();
    Some(Identity {
        pid,
        ppid: fields.get(1)?.parse().ok()?,
        pgid: fields.get(2)?.parse().ok()?,
        start_time: fields.get(19)?.parse().ok()?,
    })
}

fn read_identity(pid: u32) -> Option<Identity> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    parse_stat(pid, &stat)
}

/// Every live process, by pid.
fn snapshot() -> HashMap<u32, Identity> {
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return HashMap::new();
    };
    entries
        .filter_map(|entry| entry.ok()?.file_name().to_str()?.parse::<u32>().ok())
        .filter_map(|pid| read_identity(pid).map(|identity| (pid, identity)))
        .collect()
}

/// The owned processes: the root and every descendant seen so far, kept by start time so a
/// reused pid is not taken for one of them.
struct Ledger {
    root: u32,
    owned: HashMap<u32, Identity>,
}

impl Ledger {
    /// Adds the descendants of owned processes that `table` shows (`capturePosixOwnershipLedger`).
    fn discover(&mut self, table: &HashMap<u32, Identity>) {
        loop {
            let found: Vec<Identity> = table
                .values()
                .filter(|p| !self.owned.contains_key(&p.pid))
                .filter(|p| {
                    self.owned.get(&p.ppid).is_some_and(|parent| {
                        table
                            .get(&parent.pid)
                            .is_some_and(|seen| seen.same_process(parent))
                    })
                })
                .copied()
                .collect();
            if found.is_empty() {
                return;
            }
            for process in found {
                self.owned.insert(process.pid, process);
            }
        }
    }

    fn depth(&self, process: &Identity) -> usize {
        let mut depth = 0;
        let mut current = process.ppid;
        while let Some(parent) = self.owned.get(&current) {
            depth += 1;
            if parent.pid == self.root || depth > self.owned.len() {
                break;
            }
            current = parent.ppid;
        }
        depth
    }

    /// One `signalPhase`: every owned process that still runs, deepest first.
    fn signal_phase(&mut self, signal: Signal, include_root: bool, own: &Identity) {
        let table = snapshot();
        self.discover(&table);
        let mut pending: Vec<Identity> = self
            .owned
            .values()
            .filter(|p| include_root || p.pid != self.root)
            .filter(|p| table.get(&p.pid).is_some_and(|seen| seen.same_process(p)))
            .copied()
            .collect();
        pending.sort_by_key(|p| std::cmp::Reverse(self.depth(p)));
        for candidate in pending {
            let Some(observed) = read_identity(candidate.pid) else {
                continue;
            };
            if candidate.pid <= 1
                || candidate.pid == own.pid
                || observed.pgid == own.pgid
                || !candidate.same_process(&observed)
            {
                continue;
            }
            if let Some(pid) = i32::try_from(candidate.pid)
                .ok()
                .and_then(rustix::process::Pid::from_raw)
            {
                // A read-to-kill race stays, as in T3 (Node has no pidfd_send_signal either).
                let _ = rustix::process::kill_process(pid, signal);
            }
        }
    }
}

/// Ends `root_pid` and its descendants as T3's runtime does on Linux. Returns once the last
/// SIGKILL pass is sent; the caller reaps the root.
pub async fn terminate_tree(root_pid: u32, grace: Duration) {
    let started = tokio::task::spawn_blocking(move || {
        let own = read_identity(std::process::id())?;
        let root = read_identity(root_pid)?;
        Some((
            own,
            Ledger {
                root: root_pid,
                owned: HashMap::from([(root_pid, root)]),
            },
        ))
    })
    .await;
    let Ok(Some((own, ledger))) = started else {
        return;
    };
    let ledger = std::sync::Arc::new(std::sync::Mutex::new(ledger));
    let phase = |signal: Signal, include_root: bool| {
        let ledger = ledger.clone();
        async move {
            let _ = tokio::task::spawn_blocking(move || {
                if let Ok(mut ledger) = ledger.lock() {
                    ledger.signal_phase(signal, include_root, &own);
                }
            })
            .await;
        }
    };
    for _ in 0..PASSES {
        phase(Signal::TERM, false).await;
        tokio::time::sleep(PASS_GAP).await;
    }
    phase(Signal::TERM, true).await;
    if !grace.is_zero() {
        tokio::time::sleep(grace).await;
    }
    for _ in 0..PASSES {
        phase(Signal::KILL, true).await;
        tokio::time::sleep(PASS_GAP).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_stat_fields_after_the_command_name() {
        let stat = "4242 (a) b) S 7 4242 4242 0 -1 4194560 1 0 0 0 0 0 0 0 20 0 1 0 98765 1 2";
        let identity = parse_stat(4242, stat).unwrap();
        assert_eq!(
            identity,
            Identity {
                pid: 4242,
                ppid: 7,
                pgid: 4242,
                start_time: 98765
            }
        );
        assert!(parse_stat(1, "1 (x) S 0").is_none());
    }

    #[test]
    fn finds_descendants_deepest_first_and_skips_reused_pids() {
        let p = |pid, ppid, start_time| Identity {
            pid,
            ppid,
            pgid: pid,
            start_time,
        };
        let table = HashMap::from([
            (10, p(10, 1, 100)),
            (11, p(11, 10, 101)),
            (12, p(12, 11, 102)),
            (13, p(13, 99, 103)),
        ]);
        let mut ledger = Ledger {
            root: 10,
            owned: HashMap::from([(10, p(10, 1, 100))]),
        };
        ledger.discover(&table);
        let mut owned: Vec<u32> = ledger.owned.keys().copied().collect();
        owned.sort_unstable();
        assert_eq!(owned, [10, 11, 12]);
        assert_eq!(ledger.depth(&p(12, 11, 102)), 2);
        // A root whose pid was reused (another start time) owns nothing.
        let mut stale = Ledger {
            root: 10,
            owned: HashMap::from([(10, p(10, 1, 999))]),
        };
        stale.discover(&table);
        assert_eq!(stale.owned.len(), 1);
    }
}
