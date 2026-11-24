//! Which pull requests a thread's own agent is merging or closing (T3's `agentEnds` in
//! `PullRequestWatchReactor`). The command feed and the MCP merge tool update it the moment an
//! event arrives, apart from the watch loop's host reads, so a slow read can neither miss an
//! agent's merge nor keep counting a merge command that failed. Each command is an entry of its
//! own until the read after it ends, or until the run ends while it still runs. The reads a
//! finished command asks for wait here, one per thread, so the feed never waits on the loop.

use std::{
    collections::{BTreeMap, HashMap},
    sync::{Arc, Mutex},
};

use conn_source_control::close_commands::ClosedBy;
use tokio::sync::Notify;

struct Command {
    item_id: String,
    closed: ClosedBy,
    /// `host/repository`, lowercase, when the command names it (the MCP tool). A shell
    /// command names numbers only, as T3 reads it.
    repository: Option<String>,
    finished: bool,
}

#[derive(Default)]
struct State {
    threads: HashMap<String, Vec<Command>>,
    /// Finished commands whose read is still to come, by thread.
    reads: BTreeMap<String, Vec<String>>,
}

/// Shared by the command feed, the MCP merge tool and the watch loop.
#[derive(Clone, Default)]
pub(super) struct AgentEnds {
    state: Arc<Mutex<State>>,
    reads_ready: Arc<Notify>,
}

impl AgentEnds {
    fn with<T>(&self, f: impl FnOnce(&mut State) -> T) -> T {
        f(&mut self.state.lock().expect("agent ends lock"))
    }

    /// A close command's state: `None` while it runs, then whether it succeeded. A failed
    /// command ended nothing itself, so it drops its entry (T3's `done` before the read). An
    /// ended command asks for one read of its thread's watches.
    pub(super) fn command(
        &self,
        thread_id: &str,
        item_id: &str,
        closed: ClosedBy,
        repository: Option<String>,
        succeeded: Option<bool>,
    ) {
        self.with(|state| {
            let commands = state.threads.entry(thread_id.to_owned()).or_default();
            commands.retain(|c| c.item_id != item_id);
            if succeeded != Some(false) {
                commands.push(Command {
                    item_id: item_id.to_owned(),
                    closed,
                    repository,
                    finished: succeeded.is_some(),
                });
            }
            if commands.is_empty() {
                state.threads.remove(thread_id);
            }
            if succeeded.is_some() {
                let reads = state.reads.entry(thread_id.to_owned()).or_default();
                if !reads.iter().any(|id| id == item_id) {
                    reads.push(item_id.to_owned());
                }
            }
        });
        if succeeded.is_some() {
            self.reads_ready.notify_one();
        }
    }

    /// The run ended: commands that never reported their end are dropped; finished ones
    /// wait for their read.
    pub(super) fn run_ended(&self, thread_id: &str) {
        self.with(|state| {
            let Some(commands) = state.threads.get_mut(thread_id) else {
                return;
            };
            commands.retain(|c| c.finished);
            if commands.is_empty() {
                state.threads.remove(thread_id);
            }
        });
    }

    /// Waits until a finished command asks for a read.
    pub(super) async fn reads_ready(&self) {
        self.reads_ready.notified().await;
    }

    /// Takes the waiting reads: per thread, the finished commands one read covers.
    pub(super) fn take_reads(&self) -> Vec<(String, Vec<String>)> {
        self.with(|state| std::mem::take(&mut state.reads).into_iter().collect())
    }

    /// The read after these commands is done: each lets go of its pull requests.
    pub(super) fn read_done(&self, thread_id: &str, item_ids: &[String]) {
        self.with(|state| {
            let Some(commands) = state.threads.get_mut(thread_id) else {
                return;
            };
            commands.retain(|c| !(c.finished && item_ids.contains(&c.item_id)));
            if commands.is_empty() {
                state.threads.remove(thread_id);
            }
        });
    }

    /// `endedByAgent`, for the pull request `number` in `repository` (`host/repository`).
    pub(super) fn ends(&self, thread_id: &str, repository: &str, number: u64) -> bool {
        self.with(|state| {
            state.threads.get(thread_id).is_some_and(|commands| {
                commands.iter().any(|c| {
                    c.closed.closes(number)
                        && c.repository.as_deref().is_none_or(|r| r == repository)
                })
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn numbers(list: &[u64]) -> ClosedBy {
        ClosedBy::Numbers(list.iter().copied().collect())
    }

    const REPO: &str = "github.com/a/b";

    #[test]
    fn a_command_owns_its_pull_requests_until_its_read() {
        let ends = AgentEnds::default();
        ends.command("t1", "c1", numbers(&[7]), None, None);
        assert!(ends.ends("t1", REPO, 7) && !ends.ends("t1", REPO, 8) && !ends.ends("t2", REPO, 7));
        ends.command("t1", "c1", numbers(&[7]), None, Some(true));
        ends.run_ended("t1");
        assert!(
            ends.ends("t1", REPO, 7),
            "a finished command waits for its read"
        );
        let reads = ends.take_reads();
        assert_eq!(reads, [("t1".to_owned(), vec!["c1".to_owned()])]);
        ends.read_done("t1", &reads[0].1);
        assert!(!ends.ends("t1", REPO, 7));
    }

    #[test]
    fn a_failed_command_or_a_run_end_drops_ownership() {
        let ends = AgentEnds::default();
        ends.command("t1", "c1", numbers(&[7]), None, None);
        ends.command("t1", "c1", numbers(&[7]), None, Some(false));
        assert!(!ends.ends("t1", REPO, 7));
        ends.command("t1", "c2", ClosedBy::Any, None, None);
        ends.run_ended("t1");
        assert!(!ends.ends("t1", REPO, 9));
    }

    /// Round-2 gate finding 8: past 1,024 commands, each is still released on its own: a
    /// failed one at once, a finished one with its read, and the others keep theirs.
    #[test]
    fn many_commands_keep_their_own_lifetimes() {
        let ends = AgentEnds::default();
        for i in 0..1025u64 {
            ends.command("t1", &format!("c{i}"), numbers(&[i]), None, None);
        }
        ends.command("t1", "c70", numbers(&[70]), None, Some(false));
        assert!(
            !ends.ends("t1", REPO, 70),
            "a failed command lets go at once"
        );
        assert!(ends.ends("t1", REPO, 80), "the others still hold");
        ends.command("t1", "c90", numbers(&[90]), None, Some(true));
        let reads = ends.take_reads();
        ends.read_done("t1", &reads[0].1);
        assert!(!ends.ends("t1", REPO, 90), "released with its read");
        assert!(ends.ends("t1", REPO, 1024) && ends.ends("t1", REPO, 0));
    }

    /// Round-2 gate finding 7: finished commands ask for reads without waiting on the loop;
    /// one thread's reads coalesce.
    #[test]
    fn reads_coalesce_per_thread() {
        let ends = AgentEnds::default();
        for i in 0..500u64 {
            ends.command("t1", &format!("c{i}"), numbers(&[i]), None, Some(true));
        }
        ends.command("t2", "d", numbers(&[1]), None, Some(true));
        let reads = ends.take_reads();
        assert_eq!(reads.len(), 2);
        assert_eq!(reads[0].1.len(), 500);
        assert!(ends.take_reads().is_empty());
    }

    /// Round-2 gate finding 9: a command that names its repository owns only its pull
    /// requests there.
    #[test]
    fn a_named_repository_limits_ownership() {
        let ends = AgentEnds::default();
        ends.command("t1", "m", numbers(&[7, 8]), Some(REPO.into()), None);
        assert!(ends.ends("t1", REPO, 7) && ends.ends("t1", REPO, 8));
        assert!(!ends.ends("t1", "github.com/other/repo", 7));
        assert!(!ends.ends("t1", REPO, 9));
    }
}
