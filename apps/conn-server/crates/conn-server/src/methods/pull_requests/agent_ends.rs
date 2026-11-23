//! Which pull requests a thread's own agent is merging or closing (T3's `agentEnds` in
//! `PullRequestWatchReactor`). The command feed and the MCP merge tool update it the moment an
//! event arrives, apart from the watch loop's host reads, so a slow read can neither miss an
//! agent's merge nor keep counting a merge command that failed. An entry stays until the read
//! after its command ends (`AgentRead`), or until the run ends while the command still runs.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use conn_source_control::close_commands::ClosedBy;

/// Close commands one thread holds by item before further ones fold into one entry.
const COMMANDS_PER_THREAD: usize = 64;
/// Pull request numbers the folded entry names before it stands for any.
const FOLDED_NUMBERS: usize = 64;

/// The read a finished close command asks the watch loop for, before its entry is released.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct AgentRead {
    pub(super) thread_id: String,
    pub(super) item_id: String,
}

#[derive(Default)]
struct ThreadEnds {
    /// `(item, closed, finished)`.
    commands: Vec<(String, ClosedBy, bool)>,
    /// Commands past [`COMMANDS_PER_THREAD`], kept as one entry until the thread's reads are
    /// done or its run ends with none of them finished.
    folded: Option<(ClosedBy, bool)>,
}

impl ThreadEnds {
    fn closes(&self, number: u64) -> bool {
        self.commands.iter().any(|(_, c, _)| c.closes(number))
            || self.folded.as_ref().is_some_and(|(c, _)| c.closes(number))
    }

    fn is_empty(&self) -> bool {
        self.commands.is_empty() && self.folded.is_none()
    }

    fn fold(&mut self, closed: ClosedBy, finished: bool) {
        let merged = match (self.folded.take(), closed) {
            (None, closed) => (closed, finished),
            (Some((ClosedBy::Numbers(mut a), was)), ClosedBy::Numbers(b)) => {
                a.extend(b);
                let closed = if a.len() > FOLDED_NUMBERS {
                    ClosedBy::Any
                } else {
                    ClosedBy::Numbers(a)
                };
                (closed, was || finished)
            }
            (Some((_, was)), _) => (ClosedBy::Any, was || finished),
        };
        self.folded = Some(merged);
    }
}

/// Shared by the command feed, the MCP merge tool and the watch loop.
#[derive(Clone, Default)]
pub(super) struct AgentEnds(Arc<Mutex<HashMap<String, ThreadEnds>>>);

impl AgentEnds {
    fn with<T>(&self, f: impl FnOnce(&mut HashMap<String, ThreadEnds>) -> T) -> T {
        f(&mut self.0.lock().expect("agent ends lock"))
    }

    /// A close command's state: `None` while it runs, then whether it succeeded. A failed
    /// command ended nothing itself, so it drops its entry (T3's `done` before the read).
    /// Returns the read to ask for once it ended.
    pub(super) fn command(
        &self,
        thread_id: &str,
        item_id: &str,
        closed: ClosedBy,
        succeeded: Option<bool>,
    ) -> Option<AgentRead> {
        self.with(|threads| {
            let ends = threads.entry(thread_id.to_owned()).or_default();
            ends.commands.retain(|(id, _, _)| id != item_id);
            if succeeded != Some(false) {
                let finished = succeeded.is_some();
                if ends.commands.len() < COMMANDS_PER_THREAD {
                    ends.commands.push((item_id.to_owned(), closed, finished));
                } else {
                    ends.fold(closed, finished);
                }
            }
            if ends.is_empty() {
                threads.remove(thread_id);
            }
        });
        succeeded.map(|_| AgentRead {
            thread_id: thread_id.to_owned(),
            item_id: item_id.to_owned(),
        })
    }

    /// The run ended: commands that never reported their end are dropped; finished ones
    /// wait for their read.
    pub(super) fn run_ended(&self, thread_id: &str) {
        self.with(|threads| {
            let Some(ends) = threads.get_mut(thread_id) else {
                return;
            };
            ends.commands.retain(|(_, _, finished)| *finished);
            if ends.folded.as_ref().is_some_and(|(_, finished)| !finished) {
                ends.folded = None;
            }
            if ends.is_empty() {
                threads.remove(thread_id);
            }
        });
    }

    /// The read after a finished command is done: its entry ends, and the folded entry with
    /// the thread's last command.
    pub(super) fn read_done(&self, read: &AgentRead) {
        self.with(|threads| {
            let Some(ends) = threads.get_mut(&read.thread_id) else {
                return;
            };
            ends.commands.retain(|(id, _, _)| *id != read.item_id);
            if ends.commands.is_empty() {
                ends.folded = None;
            }
            if ends.is_empty() {
                threads.remove(&read.thread_id);
            }
        });
    }

    /// `endedByAgent`.
    pub(super) fn ends(&self, thread_id: &str, number: u64) -> bool {
        self.with(|threads| threads.get(thread_id).is_some_and(|e| e.closes(number)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn numbers(list: &[u64]) -> ClosedBy {
        ClosedBy::Numbers(list.iter().copied().collect())
    }

    #[test]
    fn a_command_owns_its_pull_requests_until_its_read() {
        let ends = AgentEnds::default();
        assert_eq!(ends.command("t1", "c1", numbers(&[7]), None), None);
        assert!(ends.ends("t1", 7) && !ends.ends("t1", 8) && !ends.ends("t2", 7));
        let read = ends
            .command("t1", "c1", numbers(&[7]), Some(true))
            .expect("read");
        ends.run_ended("t1");
        assert!(ends.ends("t1", 7), "a finished command waits for its read");
        ends.read_done(&read);
        assert!(!ends.ends("t1", 7));
    }

    #[test]
    fn a_failed_command_or_a_run_end_drops_ownership() {
        let ends = AgentEnds::default();
        ends.command("t1", "c1", numbers(&[7]), None);
        assert!(
            ends.command("t1", "c1", numbers(&[7]), Some(false))
                .is_some()
        );
        assert!(!ends.ends("t1", 7));
        ends.command("t1", "c2", ClosedBy::Any, None);
        ends.run_ended("t1");
        assert!(!ends.ends("t1", 9));
    }

    /// Gate finding 6: the 65th close command keeps its ownership.
    #[test]
    fn commands_past_the_limit_keep_ownership() {
        let ends = AgentEnds::default();
        for i in 0..COMMANDS_PER_THREAD as u64 {
            ends.command("t1", &format!("c{i}"), numbers(&[i + 1000]), None);
        }
        ends.command("t1", "late", numbers(&[7]), None);
        assert!(ends.ends("t1", 7), "the 65th command still owns #7");
        let read = ends
            .command("t1", "late", numbers(&[7]), Some(true))
            .expect("read");
        ends.read_done(&read);
        assert!(
            ends.ends("t1", 7),
            "folded: held while the thread has commands"
        );
        for i in 0..COMMANDS_PER_THREAD as u64 {
            let r = ends.command("t1", &format!("c{i}"), numbers(&[i + 1000]), Some(true));
            ends.read_done(&r.expect("read"));
        }
        assert!(!ends.ends("t1", 7), "released with the thread's last read");
    }
}
