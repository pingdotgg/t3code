//! Time-window coalescing for high-frequency shell and thread snapshots.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use crate::types::{FfiShellSnapshot, FfiThreadSnapshot};

/// Minimum interval between consecutive `on_shell` or per-thread `on_thread` callbacks.
///
/// Streaming token deltas arrive much faster than mobile UI frame budgets; coalescing to
/// 50 ms (~20 Hz) keeps SwiftUI smooth while always flushing the latest state.
pub(crate) const COALESCE_WINDOW: Duration = Duration::from_millis(50);

/// Coalesces [`FfiShellSnapshot`] and per-thread [`FfiThreadSnapshot`] updates so at most one
/// snapshot per channel is emitted every [`COALESCE_WINDOW`], always retaining the latest value.
#[derive(Debug, Default)]
pub(crate) struct SnapshotCoalescer {
    last_shell_emit: Option<Instant>,
    pending_shell: Option<FfiShellSnapshot>,
    last_thread_emit: HashMap<String, Instant>,
    pending_threads: HashMap<String, FfiThreadSnapshot>,
}

impl SnapshotCoalescer {
    /// Records a new shell snapshot. Returns `Some(snapshot)` when it can be emitted immediately,
    /// or `None` when it has been buffered to flush at the end of the current 50 ms window.
    pub(crate) fn push_shell(
        &mut self,
        snapshot: FfiShellSnapshot,
        now: Instant,
    ) -> Option<FfiShellSnapshot> {
        let ready = self
            .last_shell_emit
            .is_none_or(|last| now.saturating_duration_since(last) >= COALESCE_WINDOW);
        if ready {
            self.last_shell_emit = Some(now);
            self.pending_shell = None;
            Some(snapshot)
        } else {
            self.pending_shell = Some(snapshot);
            None
        }
    }

    /// Records a new thread snapshot. Returns `Some(snapshot)` when it can be emitted immediately,
    /// or `None` when it has been buffered to flush at the end of that thread's 50 ms window.
    pub(crate) fn push_thread(
        &mut self,
        snapshot: FfiThreadSnapshot,
        now: Instant,
    ) -> Option<FfiThreadSnapshot> {
        let ready = self
            .last_thread_emit
            .get(&snapshot.thread_id)
            .is_none_or(|last| now.saturating_duration_since(*last) >= COALESCE_WINDOW);
        if ready {
            self.last_thread_emit
                .insert(snapshot.thread_id.clone(), now);
            self.pending_threads.remove(&snapshot.thread_id);
            Some(snapshot)
        } else {
            self.pending_threads
                .insert(snapshot.thread_id.clone(), snapshot);
            None
        }
    }

    /// Drops any pending snapshot and timing history for `thread_id` (called on `close_thread`).
    pub(crate) fn cancel_thread(&mut self, thread_id: &str) {
        self.pending_threads.remove(thread_id);
        self.last_thread_emit.remove(thread_id);
    }

    /// Returns the earliest instant when any buffered snapshot becomes due to flush.
    #[must_use]
    pub(crate) fn next_deadline(&self) -> Option<Instant> {
        let mut earliest: Option<Instant> = None;
        if self.pending_shell.is_some() {
            let due = self
                .last_shell_emit
                .map_or_else(Instant::now, |last| last + COALESCE_WINDOW);
            earliest = Some(due);
        }
        for thread_id in self.pending_threads.keys() {
            let due = self
                .last_thread_emit
                .get(thread_id)
                .map_or_else(Instant::now, |last| *last + COALESCE_WINDOW);
            earliest = Some(earliest.map_or(due, |cur| cur.min(due)));
        }
        earliest
    }

    /// Drains all buffered snapshots whose [`COALESCE_WINDOW`] has elapsed by `now`.
    pub(crate) fn drain_due(
        &mut self,
        now: Instant,
    ) -> (Option<FfiShellSnapshot>, Vec<FfiThreadSnapshot>) {
        let shell = if self.pending_shell.is_some()
            && self
                .last_shell_emit
                .is_none_or(|last| now.saturating_duration_since(last) >= COALESCE_WINDOW)
        {
            self.last_shell_emit = Some(now);
            self.pending_shell.take()
        } else {
            None
        };

        let mut due_ids: Vec<String> = self
            .pending_threads
            .keys()
            .filter(|id| {
                self.last_thread_emit
                    .get(*id)
                    .is_none_or(|last| now.saturating_duration_since(*last) >= COALESCE_WINDOW)
            })
            .cloned()
            .collect();
        due_ids.sort();

        let mut threads = Vec::with_capacity(due_ids.len());
        for thread_id in due_ids {
            if let Some(snap) = self.pending_threads.remove(&thread_id) {
                self.last_thread_emit.insert(thread_id, now);
                threads.push(snap);
            }
        }

        (shell, threads)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::FfiTimelineEntry;

    fn shell_snap(synchronized: bool, project_count: usize) -> FfiShellSnapshot {
        FfiShellSnapshot {
            projects: (0..project_count)
                .map(|i| crate::types::FfiProject {
                    id: format!("p-{i}"),
                    title: format!("Project {i}"),
                    workspace_root: format!("/tmp/p-{i}"),
                })
                .collect(),
            threads: Vec::new(),
            synchronized,
        }
    }

    fn thread_snap(thread_id: &str, text: &str, working: bool) -> FfiThreadSnapshot {
        FfiThreadSnapshot {
            thread_id: thread_id.to_owned(),
            title: None,
            branch: None,
            model_label: None,
            entries: vec![FfiTimelineEntry::Assistant {
                id: "a1".to_owned(),
                markdown: text.to_owned(),
                streaming: working,
                created_at: None,
                run_id: None,
                status: if working {
                    crate::types::FfiItemStatus::Running
                } else {
                    crate::types::FfiItemStatus::Completed
                },
            }],
            work_groups: Vec::new(),
            working,
            active_run_id: None,
            queued_count: 0,
            synchronized: true,
            pending_approvals: Vec::new(),
        }
    }

    #[test]
    fn coalesces_rapid_shell_updates_and_flushes_latest_state() {
        let mut coalescer = SnapshotCoalescer::default();
        let t0 = Instant::now();

        let first = coalescer.push_shell(shell_snap(false, 1), t0);
        assert_eq!(
            first.as_ref().map(|s| s.projects.len()),
            Some(1),
            "first shell update must emit immediately"
        );

        assert!(
            coalescer
                .push_shell(shell_snap(false, 2), t0 + Duration::from_millis(10))
                .is_none(),
            "update inside 50 ms window must be coalesced"
        );
        assert!(
            coalescer
                .push_shell(shell_snap(true, 3), t0 + Duration::from_millis(25))
                .is_none(),
            "subsequent update inside 50 ms window must overwrite pending snapshot"
        );
        assert_eq!(
            coalescer.next_deadline(),
            Some(t0 + COALESCE_WINDOW),
            "deadline must be 50 ms after the previous emission"
        );

        let (due_early, _) = coalescer.drain_due(t0 + Duration::from_millis(49));
        assert!(due_early.is_none(), "must not flush before 50 ms elapses");

        let (due, _) = coalescer.drain_due(t0 + COALESCE_WINDOW);
        let due = due.expect("latest shell snapshot must flush at 50 ms");
        assert!(due.synchronized, "flushed snapshot must carry latest flag");
        assert_eq!(
            due.projects.len(),
            3,
            "flushed snapshot must carry latest project list"
        );
        assert!(
            coalescer.next_deadline().is_none(),
            "no pending work should remain after flush"
        );
    }

    #[test]
    fn coalesces_per_thread_independently_and_keeps_latest_delta() {
        let mut coalescer = SnapshotCoalescer::default();
        let t0 = Instant::now();

        assert!(
            coalescer
                .push_thread(thread_snap("t1", "a", true), t0)
                .is_some(),
            "first snapshot for t1 must emit immediately"
        );
        assert!(
            coalescer
                .push_thread(
                    thread_snap("t2", "hello", true),
                    t0 + Duration::from_millis(5)
                )
                .is_some(),
            "first snapshot for t2 must emit independently of t1"
        );

        // Rapid streaming deltas for t1 within 50 ms.
        assert!(
            coalescer
                .push_thread(
                    thread_snap("t1", "ab", true),
                    t0 + Duration::from_millis(15)
                )
                .is_none(),
            "t1 delta 1 must coalesce"
        );
        assert!(
            coalescer
                .push_thread(
                    thread_snap("t1", "abc", false),
                    t0 + Duration::from_millis(30)
                )
                .is_none(),
            "t1 delta 2 must replace earlier pending snapshot"
        );

        let (_, flushed) = coalescer.drain_due(t0 + COALESCE_WINDOW);
        assert_eq!(flushed.len(), 1, "only t1 should flush");
        assert_eq!(flushed[0].thread_id, "t1");
        assert!(!flushed[0].working, "flushed t1 must carry latest working");
        assert_eq!(
            flushed[0].entries,
            vec![FfiTimelineEntry::Assistant {
                id: "a1".to_owned(),
                markdown: "abc".to_owned(),
                streaming: false,
                created_at: None,
                run_id: None,
                status: crate::types::FfiItemStatus::Completed,
            }],
            "flushed t1 must carry the final streaming text"
        );
    }

    #[test]
    fn cancel_thread_drops_buffered_snapshot() {
        let mut coalescer = SnapshotCoalescer::default();
        let t0 = Instant::now();

        assert!(
            coalescer
                .push_thread(thread_snap("t1", "v1", true), t0)
                .is_some(),
            "initial emit"
        );
        assert!(
            coalescer
                .push_thread(thread_snap("t1", "v2", true), t0 + Duration::from_millis(5))
                .is_none(),
            "buffered update"
        );
        coalescer.cancel_thread("t1");
        assert!(
            coalescer.next_deadline().is_none(),
            "cancelling thread clears deadline"
        );
        let (_, flushed) = coalescer.drain_due(t0 + Duration::from_secs(1));
        assert!(flushed.is_empty(), "cancelled thread must not flush");
    }
}
