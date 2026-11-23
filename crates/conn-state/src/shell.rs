use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

use crate::thread::parse_iso8601_epoch_ms;

use conn_contract::{
    OrchestrationProjectShell as ProjectShell, OrchestrationV2AppThreadLineage as Lineage,
    OrchestrationV2AppThreadLineageRelationshipToParent as Relationship,
    OrchestrationV2AppThreadSettledOverride as SettledOverride,
    OrchestrationV2CreationSource as CreationSource,
    OrchestrationV2OlderSettledThreads as OlderSettledSnapshot,
    OrchestrationV2OlderSettledThreadsPage as OlderSettledPage,
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

/// Rows per page of older settled threads (`OLDER_SETTLED_PAGE_SIZE`).
pub const OLDER_SETTLED_PAGE_SIZE: usize = 25;

/// A place in the settled order, settle time descending and thread id ascending
/// (`OrchestrationV2OlderSettledCursor`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SettledCursor {
    pub settled_at: String,
    pub thread_id: Option<String>,
}

/// Where the last snapshot cut the Settled shelf (`omitOlderSettled`): older settled threads are
/// left out of the shell and counted per project (`OlderSettled`).
#[derive(Clone, Debug, PartialEq)]
pub struct OlderSettledCut {
    pub before: String,
    pub before_ms: i64,
    pub counts: HashMap<String, i64>,
}

/// How reading the next page of older settled threads went.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum PageStatus {
    #[default]
    Ready,
    Pending,
    Failed,
}

/// The older settled pages read below the cut (`OlderSettledPages`). Everything at or above the
/// frontier is local; a `None` frontier means no more can load.
#[derive(Clone, Debug, Default)]
struct OlderSettled {
    cut: Option<OlderSettledCut>,
    threads: Vec<ThreadShell>,
    frontier: Option<SettledCursor>,
    status: PageStatus,
    /// The projects the pages cover (`None`: all); a new scope starts over.
    scope: Option<Vec<String>>,
    /// Counts the snapshots seen, so an answer to an older read is dropped.
    generation: u64,
}

/// What a subagent, side chat or delegated task asks of the user, shown on its parent's row
/// (`PendingSubagentRequest`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PendingSubagentRequest {
    Approval,
    UserInput,
}

/// A request on its way up the chain; a user-only card keeps its mark (`RolledUpRequest`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Rolled {
    Approval,
    UserInput,
    UserOnlyInput,
}

/// `isListedThreadLineage`: subagents and side chats live inside their parent's view, never in
/// thread lists. Forks are listed.
#[must_use]
pub fn is_listed_lineage(lineage: &Lineage) -> bool {
    lineage.relationship_to_parent != Some(Relationship::Subagent)
        && lineage.side_chat != Some(true)
}

/// `isOlderSettledThreadShell`: a listed thread settled before the cut.
#[must_use]
pub fn is_older_settled(thread: &ThreadShell, before_ms: i64) -> bool {
    is_listed_lineage(&thread.lineage)
        && thread.settled_override == Some(SettledOverride::Settled)
        && thread
            .settled_at
            .as_deref()
            .and_then(parse_iso8601_epoch_ms)
            .is_some_and(|at| at < before_ms)
}

/// Whether a thread's run is live, so a question it asks still waits on the user
/// (`isChildRunLive`).
fn child_run_live(thread: &ThreadShell) -> bool {
    match &thread.activity_run_status {
        Some(status) => status.is_some(),
        None => matches!(
            thread.status,
            ShellThreadStatus::Preparing
                | ShellThreadStatus::Starting
                | ShellThreadStatus::Running
                | ShellThreadStatus::Waiting
        ),
    }
}

fn request_kind(thread: &ThreadShell) -> Option<PendingRequestKind> {
    thread
        .pending_runtime_request
        .as_ref()
        .map(|request| request.kind)
        .filter(|kind| *kind != PendingRequestKind::AuthRefresh)
}

fn as_rolled(kind: PendingRequestKind) -> Rolled {
    if kind == PendingRequestKind::UserInput {
        Rolled::UserInput
    } else {
        Rolled::Approval
    }
}

/// A subagent's own live request. Provider-native subagents ask on their parent, so they are
/// skipped (`subagentRequest`).
fn subagent_request(thread: &ThreadShell) -> Option<Rolled> {
    let kind = request_kind(thread)?;
    let is_subagent = thread.lineage.relationship_to_parent == Some(Relationship::Subagent);
    if (!is_subagent && thread.delegated_from.is_none())
        || (is_subagent && thread.creation_source == CreationSource::Provider)
        || !child_run_live(thread)
    {
        return None;
    }
    let rolled = as_rolled(kind);
    let user_only = thread
        .pending_runtime_request
        .as_ref()
        .is_some_and(|request| request.user_only == Some(true));
    Some(if rolled == Rolled::UserInput && user_only {
        Rolled::UserOnlyInput
    } else {
        rolled
    })
}

/// A side chat asks its user directly, so its questions roll up as well as its approvals.
fn side_chat_request(thread: &ThreadShell) -> Option<Rolled> {
    if thread.lineage.side_chat != Some(true) {
        return None;
    }
    request_kind(thread).map(as_rolled)
}

/// `pendingSubagentRequestsByThread`: the threads to flag for a subagent's live request, up its
/// subagent chain and through a side chat to its parent.
fn rolled_up_requests(threads: &[ThreadShell]) -> HashMap<String, PendingSubagentRequest> {
    let mut requests: HashMap<String, Rolled> = HashMap::new();
    let by_id: HashMap<&str, &ThreadShell> = threads.iter().map(|t| (t.id.as_str(), t)).collect();
    for child in threads {
        let parent_id = child.lineage.parent_thread_id.as_deref();
        if child.lineage.side_chat == Some(true) {
            if let (Some(parent), Some(request)) = (parent_id, side_chat_request(child))
                && requests.get(parent) != Some(&Rolled::Approval)
            {
                requests.insert(parent.to_owned(), request);
            }
            continue;
        }
        if child.lineage.relationship_to_parent != Some(Relationship::Subagent) {
            continue;
        }
        let Some(request) = subagent_request(child) else {
            continue;
        };
        // The coordinator answers a child's questions; approvals and user-only cards need the user.
        if request == Rolled::UserInput {
            continue;
        }
        let mut seen: HashSet<&str> = HashSet::from([child.id.as_str()]);
        let mut next = parent_id;
        while let Some(id) = next
            && seen.insert(id)
        {
            if requests.get(id) != Some(&Rolled::Approval) {
                requests.insert(id.to_owned(), request);
            }
            next = by_id.get(id).and_then(|parent| {
                (parent.lineage.relationship_to_parent == Some(Relationship::Subagent)
                    || parent.lineage.side_chat == Some(true))
                .then_some(parent.lineage.parent_thread_id.as_deref())
                .flatten()
            });
        }
    }
    requests
        .into_iter()
        .map(|(id, request)| {
            let shown = match request {
                Rolled::Approval => PendingSubagentRequest::Approval,
                Rolled::UserInput | Rolled::UserOnlyInput => PendingSubagentRequest::UserInput,
            };
            (id, shown)
        })
        .collect()
}

/// A thread whose change can move another thread's row or request.
fn moves_others(thread: &ThreadShell) -> bool {
    !is_listed_lineage(&thread.lineage)
        || thread.delegated_from.is_some()
        || thread.pending_runtime_request.is_some()
}

/// A read of the next page of older settled threads (`orchestration.getOlderSettledThreads`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OlderPageRequest {
    generation: u64,
    pub before: SettledCursor,
    /// `None`: every project.
    pub project_ids: Option<Vec<String>>,
}

/// What the Settled shelf can tell about the older threads left out of the shell.
#[derive(Clone, Copy, Debug)]
pub struct OlderSettledView<'a> {
    /// The cut of the last snapshot; none when the shell keeps every settled thread.
    pub cut: Option<&'a OlderSettledCut>,
    /// Where listing stops until the next page is read; none when no more can load.
    pub frontier: Option<&'a SettledCursor>,
    pub status: PageStatus,
    /// Older threads read so far.
    pub loaded: usize,
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
    /// Where the snapshot cut the Settled shelf, and the older settled threads read since.
    older: OlderSettled,
    /// Threads that sit under another thread's row, from the last change that could move them.
    delegated: HashSet<String>,
    requests: HashMap<String, PendingSubagentRequest>,
}

impl ShellState {
    /// A shell holding `threads`, as a snapshot at `sequence` would leave it, for fixtures.
    #[must_use]
    pub fn from_parts(
        projects: Vec<ProjectShell>,
        threads: Vec<ThreadShell>,
        archived_threads: Vec<ThreadShell>,
        sequence: Option<i64>,
    ) -> Self {
        let mut state = Self {
            projects,
            threads,
            archived_threads,
            sequence,
            synchronized: true,
            ..Self::default()
        };
        state.refresh_derived();
        state
    }

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
                self.reset_older(snapshot.older_settled.as_ref());
                self.refresh_derived();

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
                let moves = moves_others(&updated.thread)
                    || self.find_thread(&thread_id).is_some_and(moves_others);
                // The live copy takes over from a page read earlier.
                self.older.threads.retain(|t| t.id != thread_id);
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
                if moves {
                    self.refresh_derived();
                }
                ShellChange {
                    threads_changed: vec![thread_id],
                    ..ShellChange::default()
                }
            }
            ShellStreamItem::ThreadRemoved(removed) => {
                self.advance_sequence(removed.sequence);
                let moves = self
                    .find_thread(&removed.thread_id)
                    .is_some_and(moves_others);
                let was_older = self.older.threads.iter().any(|t| t.id == removed.thread_id);
                self.older.threads.retain(|t| t.id != removed.thread_id);
                let target = match removed.location {
                    ThreadLocation::Active => &mut self.threads,
                    ThreadLocation::Archive => &mut self.archived_threads,
                };
                let before = target.len();
                target.retain(|t| t.id != removed.thread_id);
                let threads_changed = if target.len() != before || was_older {
                    vec![removed.thread_id]
                } else {
                    Vec::new()
                };
                if moves {
                    self.refresh_derived();
                }
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
            .chain(self.older.threads.iter())
            .find(|t| t.id == thread_id)
    }

    /// Returns `true` when `thread` is a delegated subagent child rather than a top-level thread.
    #[must_use]
    pub fn is_subagent(thread: &ThreadShell) -> bool {
        thread.lineage.parent_thread_id.is_some()
    }

    /// The thread whose sidebar row stands for `thread_id` (`resolveListedAncestorThreadRef`):
    /// itself when the sidebar lists it, else its nearest ancestor it lists, so a subagent, a side
    /// chat or a delegated task that is open keeps its parent's row current. A chain that breaks
    /// (a parent the shell does not know or has archived, or a loop) stands for the thread itself.
    #[must_use]
    pub fn listed_ancestor<'a>(&'a self, thread_id: &str) -> Option<&'a str> {
        let start = self.find_thread(thread_id)?;
        let mut thread = start;
        let mut visited: HashSet<&str> = HashSet::new();
        // The bound only ends a chain that loops without revisiting.
        for _ in 0..64 {
            let parent_id = if is_listed_lineage(&thread.lineage) {
                // A delegated task whose parent is not listed keeps its own row.
                match thread.delegated_from.as_ref() {
                    Some(from) if self.delegated.contains(&thread.id) => from.thread_id.as_str(),
                    _ => return Some(thread.id.as_str()),
                }
            } else {
                match thread.lineage.parent_thread_id.as_deref() {
                    Some(parent) => parent,
                    None => return Some(start.id.as_str()),
                }
            };
            if !visited.insert(thread.id.as_str()) {
                return Some(start.id.as_str());
            }
            match self.find_thread(parent_id) {
                Some(parent) => thread = parent,
                None => return Some(start.id.as_str()),
            }
        }
        Some(start.id.as_str())
    }

    /// Whether the sidebar lists a row for `thread`: not a subagent or side chat, and not a task
    /// shown under the thread that delegated it (`isShownUnderParent`).
    #[must_use]
    pub fn is_listed(&self, thread: &ThreadShell) -> bool {
        is_listed_lineage(&thread.lineage) && !self.delegated.contains(&thread.id)
    }

    /// What `thread_id`'s subagents, side chats and delegated tasks ask of the user
    /// (`pendingSubagentRequest`).
    #[must_use]
    pub fn subagent_request(&self, thread_id: &str) -> Option<PendingSubagentRequest> {
        self.requests.get(thread_id).copied()
    }

    /// Recomputes what depends on other threads: tasks shown under their parent
    /// (`delegatedUnderParentAtom`) and the requests rolled up to a parent.
    fn refresh_derived(&mut self) {
        self.requests = rolled_up_requests(&self.threads);
        self.delegated = self
            .threads
            .iter()
            .filter(|thread| thread.delegated_from.is_some() && is_listed_lineage(&thread.lineage))
            .filter(|thread| {
                // An archived parent leaves navigation, and a subagent or side-chat parent has no
                // row of its own; either way its task stays listed on its own.
                thread
                    .delegated_from
                    .as_ref()
                    .and_then(|from| self.thread(&from.thread_id))
                    .is_some_and(|parent| {
                        parent.archived_at.is_none() && is_listed_lineage(&parent.lineage)
                    })
            })
            .map(|thread| thread.id.clone())
            .collect();
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

    /// Top-level active (unsettled, non-archived, non-deleted, listed) threads, newest first.
    pub fn top_level_active_threads(&self) -> impl Iterator<Item = &ThreadShell> {
        self.threads
            .iter()
            .filter(|t| t.deleted_at.is_none() && self.is_listed(t) && !Self::is_settled(t))
    }

    /// Top-level settled threads the client holds, whether the shelf lists them yet or not: the
    /// settled rows of `threads`, the archived ones and the older settled pages read so far,
    /// newest settle first (`sortSettledThreads`).
    #[must_use]
    pub fn all_settled_threads(&self) -> Vec<&ThreadShell> {
        let mut out: Vec<&ThreadShell> = self
            .threads
            .iter()
            .filter(|t| t.deleted_at.is_none() && self.is_listed(t) && Self::is_settled(t))
            .chain(
                self.archived_threads
                    .iter()
                    .filter(|t| t.deleted_at.is_none() && self.is_listed(t)),
            )
            .chain(
                self.older
                    .threads
                    .iter()
                    .filter(|t| t.deleted_at.is_none() && self.is_listed(t)),
            )
            .collect();
        out.sort_by(|left, right| compare_settled(left, right));
        out
    }

    /// The settled threads the shelf may list: those at or above its frontier
    /// (`isListedSettledThread`).
    #[must_use]
    pub fn top_level_settled_threads(&self) -> Vec<&ThreadShell> {
        let mut out = self.all_settled_threads();
        out.retain(|t| self.is_listed_settled(t));
        out
    }

    /// `isListedSettledThread`: the shelf lists a row at or above its frontier, so a row that
    /// turns older mid-session waits for the range that holds it.
    #[must_use]
    pub fn is_listed_settled(&self, thread: &ThreadShell) -> bool {
        let Some(frontier) = &self.older.frontier else {
            return true;
        };
        let Some(settled_at) = thread.settled_at.as_deref() else {
            return true;
        };
        let (at, cursor) = (
            parse_iso8601_epoch_ms(settled_at),
            parse_iso8601_epoch_ms(&frontier.settled_at),
        );
        match (at, cursor) {
            (Some(at), Some(cursor)) => {
                !(at < cursor
                    || (at == cursor
                        && frontier
                            .thread_id
                            .as_deref()
                            .is_some_and(|id| thread.id.as_str() > id)))
            }
            _ => true,
        }
    }

    /// Where the shelf stands on older settled threads, for its count and its "Show more".
    #[must_use]
    pub fn older_settled(&self) -> OlderSettledView<'_> {
        OlderSettledView {
            cut: self.older.cut.as_ref(),
            frontier: self.older.frontier.as_ref(),
            status: self.older.status,
            loaded: self.older.threads.len(),
        }
    }

    /// Older settled threads of the projects in `scope` (`None`: all) that this client does not
    /// hold: the server's counts minus the older rows it has (`unloadedOlderSettledCount`).
    #[must_use]
    pub fn unloaded_older_settled(&self, scope: Option<&HashSet<String>>) -> usize {
        let Some(cut) = &self.older.cut else {
            return 0;
        };
        let in_scope = |project: &str| scope.is_none_or(|ids| ids.contains(project));
        let counted: i64 = cut
            .counts
            .iter()
            .filter(|(project, _)| in_scope(project))
            .map(|(_, count)| *count)
            .sum();
        let held = self
            .threads
            .iter()
            .chain(&self.archived_threads)
            .chain(&self.older.threads)
            .filter(|t| in_scope(&t.project_id) && is_older_settled(t, cut.before_ms))
            .count();
        usize::try_from(counted - i64::try_from(held).unwrap_or(i64::MAX)).unwrap_or(0)
    }

    /// The projects the older pages are read for (`None`: all). A new scope drops the pages read
    /// for the old one and starts again at the cut.
    pub fn set_older_scope(&mut self, scope: Option<Vec<String>>) {
        let scope = scope.map(|mut ids| {
            ids.sort();
            ids
        });
        if self.older.scope == scope {
            return;
        }
        self.older.scope = scope;
        self.older.threads.clear();
        self.older.frontier = self.older.cut.as_ref().map(|cut| SettledCursor {
            settled_at: cut.before.clone(),
            thread_id: None,
        });
        self.older.status = PageStatus::Ready;
        self.older.generation += 1;
    }

    /// The next page to read when the shelf lists fewer rows than it shows
    /// (`wantedOlderSettledPages`): the cursor below the rows read, once the one before it has
    /// answered. Mark it with [`Self::older_page_started`].
    #[must_use]
    pub fn next_older_page(&self, listed: usize, visible: usize) -> Option<OlderPageRequest> {
        if listed >= visible || self.older.status != PageStatus::Ready {
            return None;
        }
        Some(OlderPageRequest {
            generation: self.older.generation,
            before: self.older.frontier.clone()?,
            project_ids: self.older.scope.clone(),
        })
    }

    /// A read of `request` is on its way.
    pub fn older_page_started(&mut self, request: &OlderPageRequest) {
        if request.generation == self.older.generation {
            self.older.status = PageStatus::Pending;
        }
    }

    /// The page for `request` arrived. A short page ends the chain.
    pub fn apply_older_page(&mut self, request: &OlderPageRequest, page: OlderSettledPage) {
        if request.generation != self.older.generation {
            return;
        }
        let last = page.threads.last().and_then(|thread| {
            thread.settled_at.clone().map(|settled_at| SettledCursor {
                settled_at,
                thread_id: Some(thread.id.clone()),
            })
        });
        let full = page.threads.len() >= OLDER_SETTLED_PAGE_SIZE;
        for thread in page.threads {
            if self.threads.iter().any(|t| t.id == thread.id) {
                continue;
            }
            match self.older.threads.iter_mut().find(|t| t.id == thread.id) {
                Some(existing) => *existing = thread,
                None => self.older.threads.push(thread),
            }
        }
        self.older.frontier = if full { last } else { None };
        self.older.status = PageStatus::Ready;
    }

    /// The read for `request` failed; `Show more` offers a retry.
    pub fn older_page_failed(&mut self, request: &OlderPageRequest) {
        if request.generation == self.older.generation {
            self.older.status = PageStatus::Failed;
        }
    }

    /// `retry` on a failed page: the next read goes again.
    pub fn retry_older_page(&mut self) {
        if self.older.status == PageStatus::Failed {
            self.older.status = PageStatus::Ready;
        }
    }

    fn reset_older(&mut self, cut: Option<&OlderSettledSnapshot>) {
        self.older.cut = cut.map(|cut| OlderSettledCut {
            before: cut.before.clone(),
            before_ms: parse_iso8601_epoch_ms(&cut.before).unwrap_or(i64::MIN),
            counts: cut
                .counts
                .iter()
                .map(|count| (count.project_id.clone(), count.count))
                .collect(),
        });
        self.older.threads.clear();
        self.older.frontier = self.older.cut.as_ref().map(|cut| SettledCursor {
            settled_at: cut.before.clone(),
            thread_id: None,
        });
        self.older.status = PageStatus::Ready;
        self.older.generation += 1;
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
        // A subagent's or side chat's request needs the user whatever the parent itself is doing.
        if self.requests.contains_key(thread_id) {
            return ThreadActivity::NeedsAttention;
        }
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

/// `sortSettledThreads`: settle time, else the thread's activity, newest first; ties by id in
/// plain order, as the server pages them.
fn compare_settled(left: &ThreadShell, right: &ThreadShell) -> Ordering {
    let time = |thread: &ThreadShell| {
        thread
            .settled_at
            .as_deref()
            .and_then(parse_iso8601_epoch_ms)
            .or_else(|| parse_iso8601_epoch_ms(activity_timestamp(thread)))
            .unwrap_or(0)
    };
    time(right)
        .cmp(&time(left))
        .then_with(|| left.id.cmp(&right.id))
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

#[cfg(test)]
mod tests {
    use conn_contract::{OrchestrationV2ShellStreamItem, from_json};
    use serde_json::{Value, json};

    use super::*;
    use crate::test_threads::thread_json;

    fn snapshot(threads: Vec<Value>, older: Option<Value>) -> ShellState {
        let mut snapshot = json!({
            "schemaVersion": 1,
            "snapshotSequence": 7,
            "projects": [],
            "threads": threads,
            "archivedThreads": []
        });
        if let Some(older) = older {
            snapshot["olderSettled"] = older;
        }
        let item: OrchestrationV2ShellStreamItem =
            from_json(json!({"kind": "snapshot", "snapshot": snapshot})).expect("snapshot decodes");
        let mut state = ShellState::default();
        state.apply(item);
        state
    }

    fn child_of(parent: &str, edit: impl FnOnce(&mut Value)) -> impl FnOnce(&mut Value) {
        let parent = parent.to_owned();
        move |t| {
            t["lineage"]["parentThreadId"] = json!(parent);
            t["lineage"]["relationshipToParent"] = json!("subagent");
            t["status"] = json!("running");
            t["pendingRuntimeRequest"] =
                json!({"id": "r", "kind": "command", "createdAt": "2026-11-13T09:00:00.000Z"});
            edit(t);
        }
    }

    fn ids(threads: &[&ThreadShell]) -> Vec<String> {
        threads.iter().map(|t| t.id.clone()).collect()
    }

    #[test]
    fn a_subagents_approval_rolls_up_its_chain_and_its_questions_stay_with_it() {
        let state = snapshot(
            vec![
                thread_json("root", "p", |_| {}),
                thread_json("mid", "p", child_of("root", |_| {})),
                thread_json(
                    "leaf",
                    "p",
                    child_of("mid", |t| {
                        t["pendingRuntimeRequest"]["kind"] = json!("command");
                    }),
                ),
                thread_json(
                    "asker",
                    "p",
                    child_of("root", |t| {
                        t["pendingRuntimeRequest"]["kind"] = json!("user_input");
                    }),
                ),
            ],
            None,
        );
        assert_eq!(
            state.subagent_request("root"),
            Some(PendingSubagentRequest::Approval)
        );
        assert_eq!(
            state.subagent_request("mid"),
            Some(PendingSubagentRequest::Approval)
        );
        assert_eq!(state.subagent_request("leaf"), None);
        // A request one of its subagents makes needs the user whatever the parent itself is doing.
        assert_eq!(state.activity("root"), ThreadActivity::NeedsAttention);
        assert_eq!(state.activity("mid"), ThreadActivity::NeedsAttention);
    }

    #[test]
    fn a_question_alone_does_not_roll_up_but_a_side_chat_question_does() {
        let asker = snapshot(
            vec![
                thread_json("root", "p", |_| {}),
                thread_json(
                    "asker",
                    "p",
                    child_of("root", |t| {
                        t["pendingRuntimeRequest"]["kind"] = json!("user_input");
                    }),
                ),
            ],
            None,
        );
        assert_eq!(asker.subagent_request("root"), None);
        let chat = snapshot(
            vec![
                thread_json("root", "p", |_| {}),
                thread_json("chat", "p", |t| {
                    t["lineage"]["parentThreadId"] = json!("root");
                    t["lineage"]["relationshipToParent"] = json!("fork");
                    t["lineage"]["sideChat"] = json!(true);
                    t["pendingRuntimeRequest"] = json!({"id": "r", "kind": "user_input", "createdAt": "2026-11-13T09:00:00.000Z"});
                }),
            ],
            None,
        );
        assert_eq!(
            chat.subagent_request("root"),
            Some(PendingSubagentRequest::UserInput)
        );
    }

    #[test]
    fn a_subagent_that_is_not_running_or_is_provider_native_asks_nothing_of_the_parent() {
        let state = snapshot(
            vec![
                thread_json("root", "p", |_| {}),
                thread_json(
                    "done",
                    "p",
                    child_of("root", |t| t["status"] = json!("completed")),
                ),
                thread_json(
                    "native",
                    "p",
                    child_of("root", |t| t["creationSource"] = json!("provider")),
                ),
                thread_json(
                    "auth",
                    "p",
                    child_of("root", |t| {
                        t["pendingRuntimeRequest"]["kind"] = json!("auth_refresh");
                    }),
                ),
            ],
            None,
        );
        assert_eq!(state.subagent_request("root"), None);
    }

    #[test]
    fn a_delegated_task_shows_under_its_listed_parent_and_a_fork_is_listed() {
        let delegated = |t: &mut Value| {
            t["delegatedFrom"] =
                json!({"environmentId": "env-b", "threadId": "parent", "title": "Parent"});
        };
        let state = snapshot(
            vec![
                thread_json("parent", "p", |_| {}),
                thread_json("task", "p", delegated),
                thread_json("fork", "p", |t| {
                    t["lineage"]["parentThreadId"] = json!("parent");
                    t["lineage"]["relationshipToParent"] = json!("fork");
                }),
            ],
            None,
        );
        let mut listed: Vec<String> = state
            .top_level_active_threads()
            .map(|t| t.id.clone())
            .collect();
        listed.sort();
        assert_eq!(listed, ["fork", "parent"]);
        assert_eq!(state.listed_ancestor("task"), Some("parent"));
        assert_eq!(state.listed_ancestor("fork"), Some("fork"));
    }

    #[test]
    fn a_delegated_task_whose_parent_is_archived_or_unknown_keeps_its_own_row() {
        let delegated = |parent: &'static str| {
            move |t: &mut Value| {
                t["delegatedFrom"] =
                    json!({"environmentId": "env-b", "threadId": parent, "title": "P"});
            }
        };
        let state = snapshot(
            vec![
                thread_json("archived-parent", "p", |t| {
                    t["archivedAt"] = json!("2026-11-14T09:00:00.000Z")
                }),
                thread_json("orphan", "p", delegated("elsewhere")),
                thread_json("task", "p", delegated("archived-parent")),
            ],
            None,
        );
        let mut listed: Vec<String> = state
            .top_level_active_threads()
            .map(|t| t.id.clone())
            .collect();
        listed.sort();
        assert_eq!(listed, ["orphan", "task"]);
        assert_eq!(state.listed_ancestor("task"), Some("task"));
    }

    fn settled(id: &str, at: &str) -> Value {
        thread_json(id, "p", |t| {
            t["settledOverride"] = json!("settled");
            t["settledAt"] = json!(at);
        })
    }

    fn cut() -> Value {
        json!({"before": "2026-11-10T00:00:00.000Z", "asOfSequence": 7, "counts": [{"projectId": "p", "count": 30}, {"projectId": "q", "count": 4}]})
    }

    fn older_page(first: usize, count: usize) -> OlderSettledPage {
        let threads: Vec<Value> = (first..first + count)
            .map(|n| {
                settled(
                    &format!("old-{n:03}"),
                    &format!("2026-11-09T00:{:02}:00.000Z", 59 - n),
                )
            })
            .collect();
        from_json(json!({"snapshotSequence": 7, "threads": threads, "counts": []}))
            .expect("page decodes")
    }

    #[test]
    fn the_shelf_counts_what_the_snapshot_left_out_minus_what_it_holds() {
        let state = snapshot(
            vec![
                settled("new", "2026-11-12T00:00:00.000Z"),
                settled("old-held", "2026-11-09T00:00:00.000Z"),
            ],
            Some(cut()),
        );
        // 30 older in `p`, one of them held; `q` has 4 and holds none.
        assert_eq!(state.unloaded_older_settled(None), 33);
        assert_eq!(
            state.unloaded_older_settled(Some(&HashSet::from(["p".to_owned()]))),
            29
        );
        assert_eq!(state.unloaded_older_settled(Some(&HashSet::new())), 0);
        assert_eq!(snapshot(vec![], None).unloaded_older_settled(None), 0);
    }

    #[test]
    fn pages_read_below_the_cut_until_the_shelf_lists_enough_and_a_short_page_ends_it() {
        let mut state = snapshot(
            vec![settled("new", "2026-11-12T00:00:00.000Z")],
            Some(cut()),
        );
        assert!(
            state.next_older_page(1, 1).is_none(),
            "nothing is wanted yet"
        );
        let first = state.next_older_page(1, 10).expect("a page is wanted");
        assert_eq!(first.before.settled_at, "2026-11-10T00:00:00.000Z");
        assert_eq!(first.before.thread_id, None);
        state.older_page_started(&first);
        assert!(state.next_older_page(1, 10).is_none(), "one read at a time");
        state.apply_older_page(&first, older_page(0, OLDER_SETTLED_PAGE_SIZE));
        assert_eq!(state.older_settled().loaded, OLDER_SETTLED_PAGE_SIZE);
        let second = state.next_older_page(26, 36).expect("the chain goes on");
        assert_eq!(second.before.thread_id.as_deref(), Some("old-024"));
        state.older_page_started(&second);
        state.apply_older_page(&second, older_page(25, 3));
        assert!(
            state.next_older_page(29, 36).is_none(),
            "a short page ends the chain"
        );
        assert!(state.older_settled().frontier.is_none());
        assert_eq!(state.top_level_settled_threads().len(), 29);
    }

    #[test]
    fn rows_below_the_frontier_wait_and_the_list_is_newest_settle_first() {
        let mut state = snapshot(
            vec![
                settled("a", "2026-11-12T00:00:00.000Z"),
                settled("b", "2026-11-12T00:00:00.000Z"),
                settled("c", "2026-11-13T00:00:00.000Z"),
            ],
            Some(cut()),
        );
        assert_eq!(ids(&state.top_level_settled_threads()), ["c", "a", "b"]);
        // A thread that settles below the cut mid-session is not listed before its range loads.
        let late = thread_json("late", "p", |t| {
            t["settledOverride"] = json!("settled");
            t["settledAt"] = json!("2026-11-01T00:00:00.000Z");
        });
        let item: OrchestrationV2ShellStreamItem = from_json(json!({
            "kind": "thread.updated", "sequence": 8, "location": "active", "thread": late
        }))
        .expect("update decodes");
        state.apply(item);
        assert_eq!(state.top_level_settled_threads().len(), 3);
        assert_eq!(state.unloaded_older_settled(None), 33, "it counts as held");
    }

    #[test]
    fn a_new_snapshot_or_scope_drops_the_pages_and_an_old_answer_is_ignored() {
        let mut state = snapshot(vec![], Some(cut()));
        let request = state.next_older_page(0, 10).expect("wanted");
        state.older_page_started(&request);
        state.set_older_scope(Some(vec!["q".to_owned(), "p".to_owned()]));
        state.apply_older_page(&request, older_page(0, 3));
        assert_eq!(
            state.older_settled().loaded,
            0,
            "the answer was for the old scope"
        );
        let scoped = state.next_older_page(0, 10).expect("wanted again");
        assert_eq!(
            scoped.project_ids,
            Some(vec!["p".to_owned(), "q".to_owned()])
        );
        state.older_page_failed(&scoped);
        assert_eq!(state.older_settled().status, PageStatus::Failed);
        assert!(state.next_older_page(0, 10).is_none());
        state.retry_older_page();
        assert!(state.next_older_page(0, 10).is_some());
    }
}
