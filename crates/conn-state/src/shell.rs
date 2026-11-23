use std::cmp::Ordering;

use conn_contract::{
    OrchestrationProjectShell as ProjectShell,
    OrchestrationV2PendingRuntimeRequestSummaryKind as PendingRequestKind,
    OrchestrationV2ShellStreamItem as ShellStreamItem,
    OrchestrationV2ShellStreamItemThreadRemovedLocation as ThreadLocation,
    OrchestrationV2ShellThreadStatus as ShellThreadStatus,
    OrchestrationV2ThreadShell as ThreadShell,
};

/// What changed after applying one stream item, so the UI can repaint only what it must.
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct ShellChange {
    pub projects_changed: bool,
    /// Thread ids added, updated, or removed.
    pub threads_changed: Vec<String>,
    /// The server asked for a fresh snapshot (`snapshot-required`); resubscribe without
    /// `afterSequence`.
    pub snapshot_required: bool,
}

/// Coarse run state of a thread for the sidebar dot/spinner.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ThreadActivity {
    Idle,
    Working,
    NeedsAttention,
    Failed,
}

/// Projects and threads from `orchestration.subscribeShell`.
#[derive(Clone, Debug, Default)]
pub struct ShellState {
    pub projects: Vec<ProjectShell>,
    pub threads: Vec<ThreadShell>,
    pub archived_threads: Vec<ThreadShell>,
    /// Last applied sequence; pass as `afterSequence` when resubscribing.
    pub sequence: Option<i64>,
    /// True once the server sent `synchronized`.
    pub synchronized: bool,
}

impl ShellState {
    /// Applies one `subscribeShell` stream item.
    pub fn apply(&mut self, item: ShellStreamItem) -> ShellChange {
        match item {
            ShellStreamItem::Snapshot(snapshot_item) => {
                let snapshot = snapshot_item.snapshot;
                // An enrichment-only snapshot (`resolvedRepositoryIdentityRoots` present) carries
                // updated project repository identities with empty `threads` / `archivedThreads`.
                // Matching Conn's `mergeShellSnapshotProjects`, never overwrite threads or
                // sequence when we already hold an authoritative snapshot.
                if let Some(resolved_roots) = snapshot_item.resolved_repository_identity_roots
                    && self.sequence.is_some()
                {
                    let mut projects_changed = false;
                    for project in &mut self.projects {
                        let Some(candidate) = snapshot.projects.iter().find(|p| {
                            p.id == project.id && p.workspace_root == project.workspace_root
                        }) else {
                            continue;
                        };
                        let resolved = resolved_roots
                            .iter()
                            .any(|root| root == &project.workspace_root);
                        if resolved {
                            if project.repository_identity != candidate.repository_identity {
                                project.repository_identity = candidate.repository_identity.clone();
                                projects_changed = true;
                            }
                        } else if !has_repository_identity(project)
                            && has_repository_identity(candidate)
                        {
                            project.repository_identity = candidate.repository_identity.clone();
                            projects_changed = true;
                        }
                    }
                    return ShellChange {
                        projects_changed,
                        threads_changed: Vec::new(),
                        snapshot_required: false,
                    };
                }

                let prior_projects = std::mem::take(&mut self.projects);
                self.projects = snapshot
                    .projects
                    .into_iter()
                    .map(|mut project| {
                        if !has_repository_identity(&project)
                            && let Some(prior) = prior_projects.iter().find(|p| {
                                p.id == project.id && p.workspace_root == project.workspace_root
                            })
                            && has_repository_identity(prior)
                        {
                            project.repository_identity = prior.repository_identity.clone();
                        }
                        project
                    })
                    .collect();
                self.threads = snapshot.threads;
                self.archived_threads = snapshot.archived_threads;
                self.sequence = Some(snapshot.snapshot_sequence);
                sort_threads(&mut self.threads);
                sort_threads(&mut self.archived_threads);

                let mut threads_changed =
                    Vec::with_capacity(self.threads.len() + self.archived_threads.len());
                threads_changed.extend(self.threads.iter().map(|t| t.id.clone()));
                threads_changed.extend(self.archived_threads.iter().map(|t| t.id.clone()));

                ShellChange {
                    projects_changed: true,
                    threads_changed,
                    snapshot_required: false,
                }
            }
            ShellStreamItem::ProjectUpdated(updated) => {
                self.advance_sequence(updated.sequence);
                upsert_project(&mut self.projects, updated.project);
                ShellChange {
                    projects_changed: true,
                    ..ShellChange::default()
                }
            }
            ShellStreamItem::ProjectRemoved(removed) => {
                self.advance_sequence(removed.sequence);
                let before = self.projects.len();
                self.projects.retain(|p| p.id != removed.project_id);
                ShellChange {
                    projects_changed: self.projects.len() != before,
                    ..ShellChange::default()
                }
            }
            ShellStreamItem::ThreadUpdated(updated) => {
                self.advance_sequence(updated.sequence);
                let thread_id = updated.thread.id.clone();
                match updated.location {
                    ThreadLocation::Active => {
                        self.archived_threads.retain(|t| t.id != thread_id);
                        upsert_thread(&mut self.threads, updated.thread);
                        sort_threads(&mut self.threads);
                    }
                    ThreadLocation::Archive => {
                        self.threads.retain(|t| t.id != thread_id);
                        upsert_thread(&mut self.archived_threads, updated.thread);
                        sort_threads(&mut self.archived_threads);
                    }
                }
                ShellChange {
                    threads_changed: vec![thread_id],
                    ..ShellChange::default()
                }
            }
            ShellStreamItem::ThreadRemoved(removed) => {
                self.advance_sequence(removed.sequence);
                let target = match removed.location {
                    ThreadLocation::Active => &mut self.threads,
                    ThreadLocation::Archive => &mut self.archived_threads,
                };
                let before = target.len();
                target.retain(|t| t.id != removed.thread_id);
                let threads_changed = if target.len() != before {
                    vec![removed.thread_id]
                } else {
                    Vec::new()
                };
                ShellChange {
                    threads_changed,
                    ..ShellChange::default()
                }
            }
            ShellStreamItem::Synchronized(_) => {
                self.synchronized = true;
                ShellChange::default()
            }
            ShellStreamItem::SnapshotRequired(_) => {
                self.synchronized = false;
                ShellChange {
                    snapshot_required: true,
                    ..ShellChange::default()
                }
            }
        }
    }

    /// Active threads of `project_id`, newest activity first.
    pub fn threads_for_project<'a>(
        &'a self,
        project_id: &'a str,
    ) -> impl Iterator<Item = &'a ThreadShell> + 'a {
        self.threads
            .iter()
            .filter(move |t| t.project_id == project_id)
    }

    /// Finds an active thread by id.
    #[must_use]
    pub fn thread(&self, thread_id: &str) -> Option<&ThreadShell> {
        self.threads.iter().find(|t| t.id == thread_id)
    }

    /// Finds any thread by id across both active and archived thread lists.
    #[must_use]
    pub fn find_thread(&self, thread_id: &str) -> Option<&ThreadShell> {
        self.threads
            .iter()
            .chain(self.archived_threads.iter())
            .find(|t| t.id == thread_id)
    }

    /// Returns `true` when `thread` is a delegated subagent child rather than a top-level thread.
    #[must_use]
    pub fn is_subagent(thread: &ThreadShell) -> bool {
        thread.lineage.parent_thread_id.is_some()
    }

    /// The thread whose sidebar row stands for `thread_id` (`resolveListedAncestorThreadRef`):
    /// itself when the sidebar lists it, else its nearest ancestor it lists, so a subagent that
    /// is open keeps its parent's row current. A parent the shell does not know ends the climb.
    #[must_use]
    pub fn listed_ancestor<'a>(&'a self, thread_id: &str) -> Option<&'a str> {
        let mut thread = self.find_thread(thread_id)?;
        // A lineage is a chain; the bound only ends one that loops.
        for _ in 0..64 {
            let Some(parent) = thread
                .lineage
                .parent_thread_id
                .as_deref()
                .and_then(|id| self.find_thread(id))
            else {
                break;
            };
            thread = parent;
        }
        Some(thread.id.as_str())
    }

    /// Returns `true` when `thread` belongs in the Settled shelf (`settledAt` or `archivedAt` set).
    #[must_use]
    pub fn is_settled(thread: &ThreadShell) -> bool {
        thread
            .settled_at
            .as_deref()
            .is_some_and(|s| !s.trim().is_empty())
            || thread
                .archived_at
                .as_deref()
                .is_some_and(|s| !s.trim().is_empty())
    }

    /// Top-level active (unsettled, non-archived, non-deleted, non-subagent) threads, newest first.
    pub fn top_level_active_threads(&self) -> impl Iterator<Item = &ThreadShell> {
        self.threads
            .iter()
            .filter(|t| t.deleted_at.is_none() && !Self::is_subagent(t) && !Self::is_settled(t))
    }

    /// Top-level settled threads (both settled entries inside `threads` and `archived_threads`),
    /// newest activity first.
    #[must_use]
    pub fn top_level_settled_threads(&self) -> Vec<&ThreadShell> {
        let mut out: Vec<&ThreadShell> = self
            .threads
            .iter()
            .filter(|t| t.deleted_at.is_none() && !Self::is_subagent(t) && Self::is_settled(t))
            .chain(
                self.archived_threads
                    .iter()
                    .filter(|t| t.deleted_at.is_none() && !Self::is_subagent(t)),
            )
            .collect();
        out.sort_by(|left, right| compare_threads(left, right));
        out
    }

    /// Finds a project by id.
    #[must_use]
    pub fn project(&self, project_id: &str) -> Option<&ProjectShell> {
        self.projects.iter().find(|p| p.id == project_id)
    }

    /// Run state for the sidebar indicator.
    ///
    /// Mirrors Conn's `resolveSidebarThreadStatus` (`Sidebar.logic.ts`):
    /// pending approval/user-input/guest requests take precedence as `NeedsAttention`,
    /// followed by active run statuses (`Working`), then `Failed`, else `Idle`.
    #[must_use]
    pub fn activity(&self, thread_id: &str) -> ThreadActivity {
        let Some(thread) = self.find_thread(thread_id) else {
            return ThreadActivity::Idle;
        };
        thread_activity(thread)
    }

    fn advance_sequence(&mut self, seq: i64) {
        self.sequence = Some(self.sequence.map_or(seq, |prev| prev.max(seq)));
    }
}

fn thread_activity(thread: &ThreadShell) -> ThreadActivity {
    if let Some(req) = &thread.pending_runtime_request
        && req.kind != PendingRequestKind::AuthRefresh
    {
        return ThreadActivity::NeedsAttention;
    }

    if thread.pending_guest_message_count.unwrap_or(0) > 0 {
        return ThreadActivity::NeedsAttention;
    }

    if matches!(thread.activity_run_status, Some(Some(_))) {
        return ThreadActivity::Working;
    }

    match thread.status {
        ShellThreadStatus::Preparing
        | ShellThreadStatus::Queued
        | ShellThreadStatus::Starting
        | ShellThreadStatus::Running
        | ShellThreadStatus::Waiting => ThreadActivity::Working,
        ShellThreadStatus::Failed => ThreadActivity::Failed,
        ShellThreadStatus::Idle
        | ShellThreadStatus::Completed
        | ShellThreadStatus::Interrupted
        | ShellThreadStatus::Cancelled
        | ShellThreadStatus::RolledBack => ThreadActivity::Idle,
    }
}

fn has_repository_identity(project: &ProjectShell) -> bool {
    matches!(project.repository_identity, Some(Some(_)))
}

fn upsert_project(projects: &mut Vec<ProjectShell>, mut project: ProjectShell) {
    if let Some(existing) = projects.iter_mut().find(|p| p.id == project.id) {
        if !has_repository_identity(&project)
            && existing.workspace_root == project.workspace_root
            && has_repository_identity(existing)
        {
            project.repository_identity = existing.repository_identity.clone();
        }
        *existing = project;
    } else {
        projects.push(project);
    }
}

fn upsert_thread(threads: &mut Vec<ThreadShell>, thread: ThreadShell) {
    if let Some(existing) = threads.iter_mut().find(|t| t.id == thread.id) {
        *existing = thread;
    } else {
        threads.push(thread);
    }
}

/// Sorts threads by most-recent activity (`updated_at`, then `created_at`) descending,
/// with deterministic `id` ascending tie-break.
fn sort_threads(threads: &mut [ThreadShell]) {
    threads.sort_by(compare_threads);
}

fn compare_threads(left: &ThreadShell, right: &ThreadShell) -> Ordering {
    let left_ts = activity_timestamp(left);
    let right_ts = activity_timestamp(right);
    right_ts
        .cmp(left_ts)
        .then_with(|| right.created_at.cmp(&left.created_at))
        .then_with(|| left.id.cmp(&right.id))
}

/// Conn orders the sidebar by the latest user message, then by update time.
fn activity_timestamp(thread: &ThreadShell) -> &str {
    if let Some(ts) = thread.latest_user_message_at.as_deref()
        && !ts.is_empty()
    {
        ts
    } else if !thread.updated_at.is_empty() {
        &thread.updated_at
    } else {
        &thread.created_at
    }
}
