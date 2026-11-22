use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};

use conn_contract::{
    ChatAttachment, OrchestrationV2Actor as Actor, OrchestrationV2Checkpoint as Checkpoint,
    OrchestrationV2CheckpointStatus as CheckpointStatus,
    OrchestrationV2ConversationMessage as ConversationMessage,
    OrchestrationV2DomainEvent as DomainEvent, OrchestrationV2LinkRequestStatus as LinkStatus,
    OrchestrationV2PlanStepStatus as PlanStepStatus, OrchestrationV2Run as Run,
    OrchestrationV2ThreadProjectionTurnItemsItem as ProjectionTurnItem,
    OrchestrationV2ThreadStreamItem as ThreadStreamItem, OrchestrationV2TurnItem as TurnItem,
    OrchestrationV2TurnItemApprovalRequest as ApprovalRequestItem,
    OrchestrationV2TurnItemAssistantMessage as AssistantMessageItem,
    OrchestrationV2TurnItemCommandExecution as CommandExecutionItem,
    OrchestrationV2TurnItemCompaction as CompactionItem,
    OrchestrationV2TurnItemDynamicTool as DynamicToolItem,
    OrchestrationV2TurnItemError as ErrorItem, OrchestrationV2TurnItemFileChange as FileChangeItem,
    OrchestrationV2TurnItemFileSearch as FileSearchItem, OrchestrationV2TurnItemFork as ForkItem,
    OrchestrationV2TurnItemHandoff as HandoffItem,
    OrchestrationV2TurnItemLinkRequest as LinkRequestItem,
    OrchestrationV2TurnItemNotification as NotificationItem,
    OrchestrationV2TurnItemProposedPlan as ProposedPlanItem,
    OrchestrationV2TurnItemReasoning as ReasoningItem,
    OrchestrationV2TurnItemRunInterruptRequest as RunInterruptRequestItem,
    OrchestrationV2TurnItemRunInterruptResult as RunInterruptResultItem,
    OrchestrationV2TurnItemSecretRequest as SecretRequestItem,
    OrchestrationV2TurnItemSubagent as SubagentItem,
    OrchestrationV2TurnItemSystemNotice as SystemNoticeItem,
    OrchestrationV2TurnItemThreadCreated as ThreadCreatedItem,
    OrchestrationV2TurnItemTodoList as TodoListItem,
    OrchestrationV2TurnItemUserInputRequest as UserInputRequestItem,
    OrchestrationV2TurnItemUserMessage as UserMessageItem,
    OrchestrationV2TurnItemWebSearch as WebSearchItem,
    OrchestrationV2UserMessageInputIntent as UserMessageIntent, ProviderRequestKind,
};

pub use conn_contract::{
    OrchestrationV2RunStatus as RunStatus,
    OrchestrationV2SecretRequestStatus as SecretRequestStatus,
    OrchestrationV2TurnItemStatus as TurnItemStatus,
};

use crate::timeline::{
    TurnCheckpointFile, UserInputAnswer, UserInputOption, UserInputQuestion,
    format_subagent_display_title, proposed_plan_title, subagent_detail,
};

const WORKSPACE_PREPARATION_INPUT: &str = "Preparing workspace";

/// Source of [`ThreadState::revision`] values, unique across every thread state in the process.
static NEXT_REVISION: AtomicU64 = AtomicU64::new(1);

fn next_revision() -> u64 {
    NEXT_REVISION.fetch_add(1, Ordering::Relaxed)
}

/// Status of a tool call or work item row.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ItemStatus {
    Running,
    Completed,
    Failed,
}

/// One row in the chat timeline. A flattened, render-ready model of the thread's turn items.
#[derive(Clone, Debug, PartialEq)]
pub enum TimelineEntry {
    User {
        id: String,
        text: String,
        /// True when the message was dispatched by an agent or system rather than the human user
        /// (Conn renders these as a collapsible `"Agent <preview>"` row).
        created_by_agent: bool,
        /// ISO-8601 creation time (`startedAt`, else `updatedAt`) for the hover timestamp.
        created_at: Option<String>,
        attachments: Vec<ChatAttachment>,
        /// True for `steer` and `promoted_queued_to_steer` messages (Conn's `Steer` marker).
        is_steer: bool,
        run_id: Option<String>,
    },
    /// A server-backed queued user message waiting to run after the active turn (or while the
    /// queue is held).
    QueuedUser {
        id: String,
        run_id: String,
        message_id: String,
        text: String,
        attachments: Vec<ChatAttachment>,
        created_at: String,
        created_by_agent: bool,
    },
    /// Assistant Markdown. `streaming` is true while deltas still arrive.
    Assistant {
        id: String,
        markdown: String,
        streaming: bool,
        /// ISO-8601 `updatedAt` for the hover timestamp.
        created_at: Option<String>,
        run_id: Option<String>,
        status: ItemStatus,
    },
    Thinking {
        id: String,
        text: String,
        streaming: bool,
    },
    /// A tool call / work log row (command, file edit, search, MCP call, ...).
    Tool {
        id: String,
        /// Short kind label used to pick the icon (`command`, `file_change`, `web_search`, ...).
        kind: String,
        title: String,
        detail: Option<String>,
        status: ItemStatus,
        /// True when the server compacted the output away; expand fetches it on demand
        /// (`orchestration.getTurnItem`).
        output_omitted: bool,
    },
    /// A pending approval the user must answer.
    Approval {
        id: String,
        title: String,
        detail: Option<String>,
    },
    /// A provider question (`user_input_request`): pending questions render Conn's interactive
    /// picker; answered ones render the answer history.
    UserInputRequest {
        id: String,
        request_id: String,
        title: Option<String>,
        questions: Vec<UserInputQuestion>,
        status: TurnItemStatus,
        /// True while the request still waits for an answer.
        pending: bool,
        answers: Vec<UserInputAnswer>,
        /// True for `responseMode: "message"` requests, which can be dismissed unanswered.
        dismissible: bool,
        created_at: Option<String>,
    },
    /// A secret request (`secret_request`), answered with `secrets.answerRequest` keyed by `id`.
    SecretRequest {
        id: String,
        label: String,
        reason: String,
        url: Option<String>,
        placeholder: Option<String>,
        /// True when the secret is delivered to the agent as a private file.
        file_delivery: bool,
        status: SecretRequestStatus,
        /// True while the request still waits for an answer.
        pending: bool,
        created_at: Option<String>,
    },
    /// A proposed plan (`proposed_plan`), rendered as Conn's `ProposedPlanCard`.
    ProposedPlan {
        id: String,
        run_id: Option<String>,
        /// The plan's first heading, else `"Proposed plan"`.
        title: String,
        markdown: String,
        streaming: bool,
        status: ItemStatus,
        created_at: Option<String>,
    },
    /// A delegated subagent (`subagent`), rendered as Conn's `SubagentTimelineLink`.
    Subagent {
        id: String,
        child_thread_id: Option<String>,
        title: String,
        /// Provider driver (`codex`, `claudeAgent`, ...).
        role: String,
        status: TurnItemStatus,
        /// One-line progress or result detail.
        summary: Option<String>,
        /// Linked environment label when the child runs remotely (`on <label>`).
        remote_label: Option<String>,
        created_at: Option<String>,
        started_at: Option<String>,
        completed_at: Option<String>,
    },
    /// An error or notice row.
    Notice {
        id: String,
        text: String,
        is_error: bool,
    },
}

impl TimelineEntry {
    /// Returns the stable contract item id for this timeline entry.
    #[must_use]
    pub fn id(&self) -> &str {
        match self {
            Self::User { id, .. }
            | Self::QueuedUser { id, .. }
            | Self::Assistant { id, .. }
            | Self::Thinking { id, .. }
            | Self::Tool { id, .. }
            | Self::Approval { id, .. }
            | Self::UserInputRequest { id, .. }
            | Self::SecretRequest { id, .. }
            | Self::ProposedPlan { id, .. }
            | Self::Subagent { id, .. }
            | Self::Notice { id, .. } => id,
        }
    }
}

/// Timing metadata captured for a timeline entry (`startedAt` / `completedAt` / `runId`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct EntryTiming {
    pub run_id: Option<String>,
    pub started_at_ms: Option<i64>,
    pub completed_at_ms: Option<i64>,
}

/// Start and completion timestamps (Unix ms) for one orchestration run.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RunTiming {
    pub started_at_ms: Option<i64>,
    pub completed_at_ms: Option<i64>,
}

/// Ready filesystem checkpoint summary for one turn run (`N changed files +A -D`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TurnCheckpointSummary {
    pub run_id: String,
    pub app_run_ordinal: Option<i64>,
    pub file_count: usize,
    pub additions: i64,
    pub deletions: i64,
    /// Changed files with per-file stats. May be a prefix of `file_count` when the server
    /// truncated the list.
    pub files: Vec<TurnCheckpointFile>,
}

/// Run metadata tracked to derive `working`, `active_run_id`, and queued message order.
#[derive(Clone, Debug, PartialEq, Eq)]
struct TrackedRun {
    id: String,
    ordinal: i64,
    user_message_id: String,
    status: RunStatus,
    queue_position: Option<i64>,
    queue_held: bool,
    requested_at: String,
}

/// Conversation message body tracked for live queued-run presentation and edits.
#[derive(Clone, Debug, PartialEq)]
struct TrackedMessage {
    text: String,
    attachments: Vec<ChatAttachment>,
    created_at: String,
    created_by_agent: bool,
    is_automatic: bool,
}

/// One thread's timeline from `orchestration.subscribeThread`.
#[derive(Clone, Debug, Default)]
pub struct ThreadState {
    pub thread_id: String,
    pub entries: Vec<TimelineEntry>,
    /// True while a turn runs (show the working row and the Stop button).
    pub working: bool,
    pub sequence: Option<i64>,
    pub synchronized: bool,
    /// Server request id of each approval entry, by entry id, for `runtime-request.respond`.
    pub approval_requests: HashMap<String, String>,
    /// Per-entry run association and start/completion timestamps (Unix ms).
    pub entry_timings: HashMap<String, EntryTiming>,
    /// Per-run start/completion timestamps (Unix ms).
    pub run_timings: HashMap<String, RunTiming>,
    /// Ready filesystem checkpoints with changed files, keyed by `run_id`.
    pub turn_checkpoints: HashMap<String, TurnCheckpointSummary>,
    /// Changes whenever [`Self::apply`], [`Self::apply_projection`], or
    /// [`Self::prepend_history_page`] runs, and is unique across all thread states,
    /// so views can skip re-syncing a timeline that did not change.
    pub revision: u64,
    /// Opaque server cursor for fetching older history pages before `entries`.
    pub history_cursor: Option<String>,
    /// True when older history pages exist on the server before `entries`.
    pub has_more_history: bool,
    /// True while an on-demand earlier-history page request is in flight.
    pub loading_earlier: bool,
    runs: HashMap<String, TrackedRun>,
    messages: HashMap<String, TrackedMessage>,
}

impl ThreadState {
    /// Creates an empty thread state for `thread_id`.
    #[must_use]
    pub fn new(thread_id: impl Into<String>) -> Self {
        Self {
            thread_id: thread_id.into(),
            revision: next_revision(),
            ..Self::default()
        }
    }

    /// Computes the elapsed duration in milliseconds for a contiguous group of work entries.
    ///
    /// Uses the earliest `started_at_ms` to latest `completed_at_ms` across `entry_ids`, falling
    /// back to the owning run's timestamps when all entries belong to one completed run.
    #[must_use]
    pub fn work_group_duration_ms(&self, entry_ids: &[&str]) -> Option<u64> {
        let mut min_start: Option<i64> = None;
        let mut max_end: Option<i64> = None;
        let mut single_run: Option<&str> = None;
        let mut multiple_runs = false;

        for id in entry_ids {
            if let Some(timing) = self.entry_timings.get(*id) {
                if let Some(start) = timing.started_at_ms {
                    min_start = Some(min_start.map_or(start, |cur| cur.min(start)));
                }
                if let Some(end) = timing.completed_at_ms {
                    max_end = Some(max_end.map_or(end, |cur| cur.max(end)));
                }
                if let Some(run_id) = timing.run_id.as_deref() {
                    match single_run {
                        None => single_run = Some(run_id),
                        Some(existing) if existing != run_id => multiple_runs = true,
                        Some(_) => {}
                    }
                }
            }
        }

        if let (Some(start), Some(end)) = (min_start, max_end)
            && end > start
        {
            return u64::try_from(end - start).ok();
        }
        if !multiple_runs
            && let Some(run_id) = single_run
            && let Some(run) = self.run_timings.get(run_id)
            && let (Some(start), Some(end)) = (run.started_at_ms, run.completed_at_ms)
            && end > start
        {
            return u64::try_from(end - start).ok();
        }
        None
    }

    /// Returns the `run_id` associated with `entry_id`, when known.
    #[must_use]
    pub fn entry_run_id(&self, entry_id: &str) -> Option<&str> {
        self.entry_timings
            .get(entry_id)
            .and_then(|t| t.run_id.as_deref())
    }

    /// Returns the ready changed-files checkpoint for `run_id`, when non-empty.
    #[must_use]
    pub fn checkpoint_for_run(&self, run_id: &str) -> Option<&TurnCheckpointSummary> {
        self.turn_checkpoints.get(run_id)
    }

    /// Returns the id of the latest active (`preparing`/`starting`/`running`/`waiting`) run,
    /// matching Conn's `resolveActiveThreadRun`. Used to decide whether `Send now` on a queued
    /// message dispatches `queued-message.promote-to-steer` or `queued-run.start`.
    #[must_use]
    pub fn active_run_id(&self) -> Option<&str> {
        self.runs
            .values()
            .filter(|run| is_run_active(run.status))
            .max_by_key(|run| run.ordinal)
            .map(|run| run.id.as_str())
    }

    /// Returns the status of run `run_id`, when tracked.
    #[must_use]
    pub fn run_status(&self, run_id: &str) -> Option<RunStatus> {
        self.runs.get(run_id).map(|run| run.status)
    }

    /// Returns the id of the latest run by ordinal (Conn's `latestRun`).
    #[must_use]
    pub fn latest_run_id(&self) -> Option<&str> {
        self.runs
            .values()
            .max_by_key(|run| run.ordinal)
            .map(|run| run.id.as_str())
    }

    /// Replaces this thread's timeline from a full [`conn_contract::OrchestrationV2ThreadProjection`]
    /// (from `subscribeThread` snapshots or `orchestration.launchThread` responses).
    pub fn apply_projection(
        &mut self,
        projection: conn_contract::OrchestrationV2ThreadProjection,
        sequence: Option<i64>,
    ) {
        self.revision = next_revision();
        self.thread_id = projection.thread.id;
        if let Some(seq) = sequence {
            self.advance_sequence(seq);
        }

        self.runs.clear();
        self.run_timings.clear();
        for run in &projection.runs {
            self.record_run(run);
            self.record_run_timing(run);
        }
        self.working = self.runs.values().any(is_tracked_run_working);

        self.messages.clear();
        for message in &projection.messages {
            self.record_message(message);
        }

        self.turn_checkpoints.clear();
        for checkpoint in &projection.checkpoints {
            self.record_checkpoint(checkpoint);
        }

        self.approval_requests.clear();
        self.entry_timings.clear();

        // Index canonical message & subagent bodies so snapshots compacted with
        // `acceptDedupedBodies: true` (`textOmitted` / `promptOmitted` / `resultOmitted`)
        // restore their full text cleanly.
        let message_texts: HashMap<&str, &str> = projection
            .messages
            .iter()
            .map(|m| (m.id.as_str(), m.text.as_str()))
            .collect();
        let subagent_bodies: HashMap<&str, (&str, Option<&str>)> = projection
            .subagents
            .iter()
            .map(|s| (s.id.as_str(), (s.prompt.as_str(), s.result.as_deref())))
            .collect();

        let capacity = if !projection.visible_turn_items.is_empty() {
            projection.visible_turn_items.len()
        } else {
            projection.turn_items.len()
        };
        let mut entries = Vec::with_capacity(capacity);
        let mut entry_index: HashMap<String, usize> = HashMap::with_capacity(capacity);
        let mut ingest = |mut item: ProjectionTurnItem| {
            hydrate_deduped_projection_item(&mut item, &message_texts, &subagent_bodies);
            if let ProjectionTurnItem::ApprovalRequest(i) = &item {
                self.approval_requests
                    .insert(i.id.clone(), i.request_id.clone());
            }
            if let Some((id, timing)) = extract_projection_timing(&item) {
                self.entry_timings.insert(id, timing);
            }
            if let Some(entry) = map_projection_turn_item(item) {
                if let Some(&idx) = entry_index.get(entry.id()) {
                    entries[idx] = entry;
                } else {
                    let idx = entries.len();
                    entry_index.insert(entry.id().to_owned(), idx);
                    entries.push(entry);
                }
            }
        };

        if !projection.visible_turn_items.is_empty() {
            let mut rows = projection.visible_turn_items;
            rows.sort_by_key(|row| row.position);
            for row in rows {
                ingest(row.item);
            }
        } else {
            for turn_item in projection.turn_items {
                ingest(turn_item);
            }
        }
        self.entries = entries;
        self.history_cursor = None;
        self.has_more_history = false;
        self.loading_earlier = false;
        self.reconcile_queued_runs(true);
    }

    /// Replaces this thread's timeline from an [`conn_contract::OrchestrationV2ThreadDetailSnapshot`],
    /// preserving any bounded-snapshot history pagination cursor and flag.
    pub fn apply_detail_snapshot(
        &mut self,
        snapshot: conn_contract::OrchestrationV2ThreadDetailSnapshot,
    ) {
        self.apply_projection(snapshot.projection, Some(snapshot.snapshot_sequence));
        self.history_cursor = snapshot.history_cursor.flatten();
        self.has_more_history = snapshot.has_more_history.unwrap_or(false);
        self.loading_earlier = false;
    }

    /// Prepends one older history page returned by `GET /api/orchestration/threads/:id/history`
    /// ahead of existing timeline entries, deduplicating by entry ID and updating pagination
    /// metadata (`history_cursor`, `has_more_history`, `loading_earlier`).
    ///
    /// Returns the number of newly prepended [`TimelineEntry`] rows.
    pub fn prepend_history_page(
        &mut self,
        page: conn_contract::OrchestrationV2ThreadHistoryPage,
    ) -> usize {
        let existing_ids: HashSet<String> = self
            .entries
            .iter()
            .map(|entry| entry.id().to_owned())
            .collect();

        let mut rows = page.items;
        rows.sort_by_key(|row| row.position);

        let mut prepended = Vec::with_capacity(rows.len());
        let mut prepended_index: HashMap<String, usize> = HashMap::with_capacity(rows.len());

        for row in rows {
            let item = row.item;
            let approval_pair = match &item {
                ProjectionTurnItem::ApprovalRequest(i) => {
                    Some((i.id.clone(), i.request_id.clone()))
                }
                _ => None,
            };
            let timing = extract_projection_timing(&item);

            let Some(entry) = map_projection_turn_item(item) else {
                continue;
            };
            if existing_ids.contains(entry.id()) {
                continue;
            }
            if let Some((id, request_id)) = approval_pair {
                self.approval_requests.entry(id).or_insert(request_id);
            }
            if let Some((id, entry_timing)) = timing {
                self.entry_timings.entry(id).or_insert(entry_timing);
            }
            if let Some(&idx) = prepended_index.get(entry.id()) {
                prepended[idx] = entry;
            } else {
                let idx = prepended.len();
                prepended_index.insert(entry.id().to_owned(), idx);
                prepended.push(entry);
            }
        }

        let prepended_count = prepended.len();
        if prepended_count > 0 {
            prepended.append(&mut self.entries);
            self.entries = prepended;
        }

        self.history_cursor = page.next_cursor;
        self.has_more_history = page.has_more_history;
        self.loading_earlier = false;
        self.revision = next_revision();
        prepended_count
    }

    /// Applies one `subscribeThread` stream item.
    ///
    /// Returns `true` when timeline entries or the `working` state changed.
    pub fn apply(&mut self, item: ThreadStreamItem) -> bool {
        self.revision = next_revision();
        match item {
            ThreadStreamItem::Synchronized(_) => {
                self.synchronized = true;
                false
            }
            ThreadStreamItem::Snapshot(snapshot) => {
                self.apply_projection(snapshot.projection, Some(snapshot.snapshot_sequence));
                self.history_cursor = snapshot.history_cursor.flatten();
                self.has_more_history = snapshot.has_more_history.unwrap_or(false);
                self.loading_earlier = false;
                true
            }
            ThreadStreamItem::Event(event_item) => {
                self.advance_sequence(event_item.sequence);
                self.apply_domain_event(event_item.event)
            }
            ThreadStreamItem::Event2(event_item) => {
                self.advance_sequence(event_item.sequence);
                self.apply_fallback_event(&event_item.event.r#type, event_item.event.payload)
            }
        }
    }

    fn advance_sequence(&mut self, seq: i64) {
        self.sequence = Some(self.sequence.map_or(seq, |prev| prev.max(seq)));
    }

    fn record_run_timing(&mut self, run: &Run) {
        let started = run
            .work_started_at
            .as_deref()
            .or(run.started_at.as_deref())
            .and_then(parse_iso8601_epoch_ms);
        let completed = run.completed_at.as_deref().and_then(parse_iso8601_epoch_ms);
        self.run_timings.insert(
            run.id.clone(),
            RunTiming {
                started_at_ms: started,
                completed_at_ms: completed,
            },
        );
    }

    fn record_checkpoint(&mut self, cp: &Checkpoint) -> bool {
        if cp.status != CheckpointStatus::Ready {
            return false;
        }
        let Some(run_id) = cp.run_id.as_ref().filter(|s| !s.is_empty()) else {
            return false;
        };
        let (file_count, additions, deletions) = if let Some(totals) = &cp.files_total {
            (
                usize::try_from(totals.count.max(0)).unwrap_or(0),
                totals.additions,
                totals.deletions,
            )
        } else {
            let adds: i64 = cp.files.iter().map(|f| f.additions).sum();
            let dels: i64 = cp.files.iter().map(|f| f.deletions).sum();
            (cp.files.len(), adds, dels)
        };
        if file_count == 0 {
            return false;
        }
        let summary = TurnCheckpointSummary {
            run_id: run_id.clone(),
            app_run_ordinal: cp.app_run_ordinal,
            file_count,
            additions,
            deletions,
            files: cp
                .files
                .iter()
                .map(|f| TurnCheckpointFile {
                    path: f.path.clone(),
                    kind: f.kind.clone(),
                    additions: f.additions,
                    deletions: f.deletions,
                })
                .collect(),
        };
        let changed = self.turn_checkpoints.get(run_id) != Some(&summary);
        self.turn_checkpoints.insert(run_id.clone(), summary);
        changed
    }

    fn record_run(&mut self, run: &Run) {
        self.runs.insert(
            run.id.clone(),
            TrackedRun {
                id: run.id.clone(),
                ordinal: run.ordinal,
                user_message_id: run.user_message_id.clone(),
                status: run.status,
                queue_position: run.queue_position.flatten(),
                queue_held: run.queue_held == Some(true),
                requested_at: run.requested_at.clone(),
            },
        );
    }

    fn record_message(&mut self, msg: &ConversationMessage) {
        let is_automatic = msg.delegated_completion.is_some() || msg.notification.is_some();
        self.messages.insert(
            msg.id.clone(),
            TrackedMessage {
                text: msg.text.clone(),
                attachments: msg.attachments.clone(),
                created_at: msg.created_at.clone(),
                created_by_agent: msg.created_by != Actor::User,
                is_automatic,
            },
        );
    }

    /// Reconciles `TimelineEntry::QueuedUser` entries at the bottom of `self.entries` against
    /// tracked `runs` and `messages`, matching Conn's `deriveThreadQueueWorkflowState`.
    fn reconcile_queued_runs(&mut self, allow_placeholder: bool) -> bool {
        let mut queued_runs: Vec<&TrackedRun> = self
            .runs
            .values()
            .filter(|run| {
                run.status == RunStatus::Queued
                    && !self
                        .messages
                        .get(&run.user_message_id)
                        .is_some_and(|m| m.is_automatic)
            })
            .collect();
        queued_runs.sort_by_key(|run| (run.queue_position.unwrap_or(run.ordinal), run.ordinal));

        let mut existing_queued: Vec<TimelineEntry> = Vec::new();
        let mut non_queued: Vec<TimelineEntry> = Vec::with_capacity(self.entries.len());
        let mut saw_queued = false;
        let mut interleaved = false;
        for entry in std::mem::take(&mut self.entries) {
            if matches!(entry, TimelineEntry::QueuedUser { .. }) {
                saw_queued = true;
                existing_queued.push(entry);
            } else {
                if saw_queued {
                    interleaved = true;
                }
                non_queued.push(entry);
            }
        }

        let old_queued = existing_queued.clone();
        let mut next_queued: Vec<TimelineEntry> = Vec::with_capacity(queued_runs.len());
        let mut consumed = vec![false; existing_queued.len()];

        for run in &queued_runs {
            let existing_idx = existing_queued.iter().enumerate().find_map(|(idx, e)| {
                if consumed[idx] {
                    return None;
                }
                match e {
                    TimelineEntry::QueuedUser {
                        run_id, message_id, ..
                    } if run_id == &run.id || message_id == &run.user_message_id => Some(idx),
                    _ => None,
                }
            });

            if let Some(msg) = self.messages.get(&run.user_message_id) {
                let id = existing_idx
                    .map(|idx| existing_queued[idx].id().to_owned())
                    .unwrap_or_else(|| format!("turn-item:{}", run.user_message_id));
                if let Some(idx) = existing_idx {
                    consumed[idx] = true;
                }
                next_queued.push(TimelineEntry::QueuedUser {
                    id,
                    run_id: run.id.clone(),
                    message_id: run.user_message_id.clone(),
                    text: msg.text.clone(),
                    attachments: msg.attachments.clone(),
                    created_at: msg.created_at.clone(),
                    created_by_agent: msg.created_by_agent,
                });
            } else if let Some(idx) = existing_idx {
                consumed[idx] = true;
                next_queued.push(existing_queued[idx].clone());
            } else if allow_placeholder {
                next_queued.push(TimelineEntry::QueuedUser {
                    id: format!("turn-item:{}", run.user_message_id),
                    run_id: run.id.clone(),
                    message_id: run.user_message_id.clone(),
                    text: "Queued message".to_owned(),
                    attachments: Vec::new(),
                    created_at: run.requested_at.clone(),
                    created_by_agent: false,
                });
            }
        }

        // Preserve standalone pending turn-item queued entries whose run_id is not tracked in
        // `self.runs` (for example, projections or streams emitting only `turn-item.updated`).
        for (idx, entry) in existing_queued.into_iter().enumerate() {
            if consumed[idx] {
                continue;
            }
            if let TimelineEntry::QueuedUser { ref run_id, .. } = entry
                && (run_id.is_empty() || !self.runs.contains_key(run_id))
            {
                next_queued.push(entry);
            }
        }

        let changed = interleaved || next_queued != old_queued;
        non_queued.extend(next_queued);
        self.entries = non_queued;
        changed
    }

    fn apply_domain_event(&mut self, event: DomainEvent) -> bool {
        match event {
            DomainEvent::RunCreated(ev) => {
                self.record_run(&ev.payload);
                self.record_run_timing(&ev.payload);
                let next_working = self.runs.values().any(is_tracked_run_working);
                let working_changed = self.working != next_working;
                self.working = next_working;
                let queue_changed = self.reconcile_queued_runs(false);
                working_changed || queue_changed
            }
            DomainEvent::RunUpdated(ev) => {
                self.record_run(&ev.payload);
                self.record_run_timing(&ev.payload);
                let next_working = self.runs.values().any(is_tracked_run_working);
                let working_changed = self.working != next_working;
                self.working = next_working;
                let queue_changed = self.reconcile_queued_runs(false);
                working_changed || queue_changed
            }
            DomainEvent::MessageUpdated(ev) => {
                self.record_message(&ev.payload);
                self.reconcile_queued_runs(false)
            }
            DomainEvent::TurnItemUpdated(ev) => {
                let item_id = turn_item_id(&ev.payload).to_owned();
                let (item_run_id, item_message_id) = match &ev.payload {
                    TurnItem::UserMessage(i) => (i.run_id.clone(), Some(i.message_id.clone())),
                    _ => (None, None),
                };
                if let TurnItem::ApprovalRequest(i) = &ev.payload {
                    self.approval_requests
                        .insert(i.id.clone(), i.request_id.clone());
                }
                let timing = extract_turn_item_timing(&ev.payload);
                self.entry_timings.insert(item_id.clone(), timing);
                if let Some(entry) = map_turn_item(ev.payload) {
                    let mut changed = false;
                    if matches!(entry, TimelineEntry::User { .. }) {
                        let before = self.entries.len();
                        self.entries.retain(|existing| match existing {
                            TimelineEntry::QueuedUser {
                                id,
                                run_id,
                                message_id,
                                ..
                            } => {
                                id != entry.id()
                                    && item_message_id
                                        .as_deref()
                                        .is_none_or(|mid| mid != message_id)
                                    && item_run_id
                                        .as_deref()
                                        .is_none_or(|rid| rid.is_empty() || rid != run_id)
                            }
                            _ => true,
                        });
                        changed |= self.entries.len() != before;
                    }
                    changed |= upsert_entry(&mut self.entries, entry);
                    changed
                } else {
                    remove_entry(&mut self.entries, &item_id)
                }
            }
            DomainEvent::CheckpointCaptured(ev) => self.record_checkpoint(&ev.payload),
            // Projection metadata events that do not directly add or alter timeline entries.
            DomainEvent::ThreadCreated(_)
            | DomainEvent::ThreadArchived(_)
            | DomainEvent::ThreadPullRequestLinkUpdated(_)
            | DomainEvent::ThreadVisitRecorded(_)
            | DomainEvent::RunBackgroundWorkCancelled(_)
            | DomainEvent::RunAttemptCreated(_)
            | DomainEvent::RunAttemptUpdated(_)
            | DomainEvent::NodeUpdated(_)
            | DomainEvent::SubagentUpdated(_)
            | DomainEvent::ProviderSessionAttached(_)
            | DomainEvent::ProviderSessionDetached(_)
            | DomainEvent::ProviderThreadUpdated(_)
            | DomainEvent::ProviderTurnUpdated(_)
            | DomainEvent::RuntimeRequestUpdated(_)
            | DomainEvent::PlanUpdated(_)
            | DomainEvent::CheckpointScopeCreated(_)
            | DomainEvent::CheckpointRollbackRequested(_)
            | DomainEvent::ContextHandoffUpdated(_)
            | DomainEvent::ContextTransferCreated(_)
            | DomainEvent::ContextTransferUpdated(_) => false,
        }
    }

    /// Handles untyped/future `Event2` frames such as incremental text delta or completion
    /// events if a server emits them outside `OrchestrationV2DomainEvent`.
    fn apply_fallback_event(
        &mut self,
        event_type: &str,
        payload: Option<Option<serde_json::Value>>,
    ) -> bool {
        let Some(Some(serde_json::Value::Object(map))) = payload else {
            return false;
        };

        let id = map
            .get("id")
            .or_else(|| map.get("itemId"))
            .and_then(serde_json::Value::as_str);

        if event_type.ends_with(".delta") {
            let Some(item_id) = id else {
                return false;
            };
            let delta = map
                .get("delta")
                .or_else(|| map.get("text"))
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default();
            if delta.is_empty() {
                return false;
            }
            if let Some(entry) = self.entries.iter_mut().find(|e| e.id() == item_id) {
                match entry {
                    TimelineEntry::Assistant {
                        markdown,
                        streaming,
                        ..
                    } => {
                        markdown.push_str(delta);
                        *streaming = true;
                        return true;
                    }
                    TimelineEntry::Thinking {
                        text, streaming, ..
                    } => {
                        text.push_str(delta);
                        *streaming = true;
                        return true;
                    }
                    _ => return false,
                }
            }
            let is_thinking = event_type.contains("reasoning") || event_type.contains("thinking");
            let new_entry = if is_thinking {
                TimelineEntry::Thinking {
                    id: item_id.to_owned(),
                    text: delta.to_owned(),
                    streaming: true,
                }
            } else {
                TimelineEntry::Assistant {
                    id: item_id.to_owned(),
                    markdown: delta.to_owned(),
                    streaming: true,
                    created_at: None,
                    run_id: None,
                    status: ItemStatus::Running,
                }
            };
            self.entries.push(new_entry);
            return true;
        }

        if event_type.ends_with(".completed")
            && let Some(item_id) = id
            && let Some(entry) = self.entries.iter_mut().find(|e| e.id() == item_id)
        {
            match entry {
                TimelineEntry::Assistant {
                    streaming, status, ..
                } if *streaming => {
                    *streaming = false;
                    *status = ItemStatus::Completed;
                    return true;
                }
                TimelineEntry::Thinking { streaming, .. } if *streaming => {
                    *streaming = false;
                    return true;
                }
                TimelineEntry::Tool { status, .. } if *status != ItemStatus::Completed => {
                    *status = ItemStatus::Completed;
                    return true;
                }
                _ => {}
            }
        }

        false
    }
}

fn hydrate_deduped_projection_item(
    item: &mut ProjectionTurnItem,
    message_texts: &HashMap<&str, &str>,
    subagent_bodies: &HashMap<&str, (&str, Option<&str>)>,
) {
    match item {
        ProjectionTurnItem::UserMessage(msg) => {
            if msg.text_omitted.is_some()
                && let Some(text) = message_texts.get(msg.message_id.as_str())
            {
                msg.text = (*text).to_owned();
                msg.text_omitted = None;
            }
        }
        ProjectionTurnItem::AssistantMessage(msg) => {
            if msg.text_omitted.is_some()
                && let Some(text) = message_texts.get(msg.message_id.as_str())
            {
                msg.text = (*text).to_owned();
                msg.text_omitted = None;
            }
        }
        ProjectionTurnItem::Subagent(sub) => {
            if let Some((prompt, result)) = subagent_bodies.get(sub.subagent_id.as_str()) {
                if sub.prompt_omitted.is_some() {
                    sub.prompt = (*prompt).to_owned();
                    sub.prompt_omitted = None;
                }
                if sub.result_omitted.is_some() {
                    sub.result = result.map(str::to_owned);
                    sub.result_omitted = None;
                }
            }
        }
        _ => {}
    }
}

fn is_run_active(status: RunStatus) -> bool {
    matches!(
        status,
        RunStatus::Preparing | RunStatus::Starting | RunStatus::Running | RunStatus::Waiting
    )
}

fn is_tracked_run_working(run: &TrackedRun) -> bool {
    is_run_active(run.status) || (run.status == RunStatus::Queued && !run.queue_held)
}

fn is_pending_item_status(status: TurnItemStatus) -> bool {
    matches!(
        status,
        TurnItemStatus::Idle
            | TurnItemStatus::Pending
            | TurnItemStatus::Running
            | TurnItemStatus::Waiting
    )
}

fn map_item_status(status: TurnItemStatus) -> ItemStatus {
    match status {
        TurnItemStatus::Idle
        | TurnItemStatus::Pending
        | TurnItemStatus::Running
        | TurnItemStatus::Waiting => ItemStatus::Running,
        TurnItemStatus::Completed => ItemStatus::Completed,
        TurnItemStatus::Failed | TurnItemStatus::Cancelled | TurnItemStatus::Interrupted => {
            ItemStatus::Failed
        }
    }
}

fn upsert_entry(entries: &mut Vec<TimelineEntry>, entry: TimelineEntry) -> bool {
    if let Some(existing) = entries.iter_mut().find(|e| e.id() == entry.id()) {
        if *existing == entry {
            return false;
        }
        *existing = entry;
        return true;
    }
    if let TimelineEntry::QueuedUser {
        ref run_id,
        ref message_id,
        ..
    } = entry
    {
        if let Some(existing) = entries.iter_mut().find(|e| match e {
            TimelineEntry::QueuedUser {
                run_id: er,
                message_id: em,
                ..
            } => {
                (!run_id.is_empty() && er == run_id) || (!message_id.is_empty() && em == message_id)
            }
            _ => false,
        }) {
            if *existing == entry {
                return false;
            }
            *existing = entry;
            return true;
        }
        entries.push(entry);
    } else {
        let insert_pos = entries
            .iter()
            .position(|e| matches!(e, TimelineEntry::QueuedUser { .. }))
            .unwrap_or(entries.len());
        entries.insert(insert_pos, entry);
    }
    true
}

fn remove_entry(entries: &mut Vec<TimelineEntry>, id: &str) -> bool {
    let before = entries.len();
    entries.retain(|e| e.id() != id);
    entries.len() != before
}

fn non_empty(value: Option<String>) -> Option<String> {
    value.filter(|s| !s.trim().is_empty())
}

fn turn_item_id(item: &TurnItem) -> &str {
    match item {
        TurnItem::Notification(i) => &i.id,
        TurnItem::UserMessage(i) => &i.id,
        TurnItem::AssistantMessage(i) => &i.id,
        TurnItem::Reasoning(i) => &i.id,
        TurnItem::ProposedPlan(i) => &i.id,
        TurnItem::TodoList(i) => &i.id,
        TurnItem::UserInputRequest(i) => &i.id,
        TurnItem::FileChange(i) => &i.id,
        TurnItem::CommandExecution(i) => &i.id,
        TurnItem::FileSearch(i) => &i.id,
        TurnItem::WebSearch(i) => &i.id,
        TurnItem::ApprovalRequest(i) => &i.id,
        TurnItem::Checkpoint(i) => &i.id,
        TurnItem::RunInterruptRequest(i) => &i.id,
        TurnItem::RunInterruptResult(i) => &i.id,
        TurnItem::SystemNotice(i) => &i.id,
        TurnItem::Error(i) => &i.id,
        TurnItem::Compaction(i) => &i.id,
        TurnItem::Handoff(i) => &i.id,
        TurnItem::Fork(i) => &i.id,
        TurnItem::ThreadCreated(i) => &i.id,
        TurnItem::SecretRequest(i) => &i.id,
        TurnItem::LinkRequest(i) => &i.id,
        TurnItem::Subagent(i) => &i.id,
        TurnItem::DynamicTool(i) => &i.id,
    }
}

/// Returns the expanded detail text for a turn item fetched on demand
/// (`orchestration.getTurnItem`) after its output was omitted from the thread snapshot.
#[must_use]
pub fn turn_item_detail(item: TurnItem) -> Option<String> {
    match map_turn_item(item)? {
        TimelineEntry::Tool { detail, .. } => detail,
        TimelineEntry::Thinking { text, .. } => non_empty(Some(text)),
        _ => None,
    }
}

fn map_projection_turn_item(item: ProjectionTurnItem) -> Option<TimelineEntry> {
    match item {
        ProjectionTurnItem::Notification(i) => map_notification(i),
        ProjectionTurnItem::UserMessage(i) => map_user_message(i),
        ProjectionTurnItem::AssistantMessage(i) => map_assistant_message(i),
        ProjectionTurnItem::Reasoning(i) => map_reasoning(i),
        ProjectionTurnItem::ProposedPlan(i) => map_proposed_plan(i),
        ProjectionTurnItem::TodoList(i) => map_todo_list(i),
        ProjectionTurnItem::UserInputRequest(i) => map_user_input_request(i),
        ProjectionTurnItem::FileChange(i) => map_file_change(i),
        ProjectionTurnItem::CommandExecution(i) => map_command_execution(i),
        ProjectionTurnItem::FileSearch(i) => map_file_search(i),
        ProjectionTurnItem::WebSearch(i) => map_web_search(i),
        ProjectionTurnItem::ApprovalRequest(i) => map_approval_request(i),
        ProjectionTurnItem::Checkpoint(_) => None,
        ProjectionTurnItem::RunInterruptRequest(i) => map_run_interrupt_request(i),
        ProjectionTurnItem::RunInterruptResult(i) => map_run_interrupt_result(i),
        ProjectionTurnItem::SystemNotice(i) => map_system_notice(i),
        ProjectionTurnItem::Error(i) => map_error(i),
        ProjectionTurnItem::Compaction(i) => map_compaction(i),
        ProjectionTurnItem::Handoff(i) => map_handoff(i),
        ProjectionTurnItem::Fork(i) => map_fork(i),
        ProjectionTurnItem::ThreadCreated(i) => map_thread_created(i),
        ProjectionTurnItem::SecretRequest(i) => map_secret_request(i),
        ProjectionTurnItem::LinkRequest(i) => map_link_request(i),
        ProjectionTurnItem::Subagent(i) => map_subagent(i),
        ProjectionTurnItem::DynamicTool(i) => map_dynamic_tool(i),
        // Unknown items carry only a `type` discriminator and no user-visible text.
        ProjectionTurnItem::Unknown(_) => None,
    }
}

fn map_turn_item(item: TurnItem) -> Option<TimelineEntry> {
    match item {
        TurnItem::Notification(i) => map_notification(i),
        TurnItem::UserMessage(i) => map_user_message(i),
        TurnItem::AssistantMessage(i) => map_assistant_message(i),
        TurnItem::Reasoning(i) => map_reasoning(i),
        TurnItem::ProposedPlan(i) => map_proposed_plan(i),
        TurnItem::TodoList(i) => map_todo_list(i),
        TurnItem::UserInputRequest(i) => map_user_input_request(i),
        TurnItem::FileChange(i) => map_file_change(i),
        TurnItem::CommandExecution(i) => map_command_execution(i),
        TurnItem::FileSearch(i) => map_file_search(i),
        TurnItem::WebSearch(i) => map_web_search(i),
        TurnItem::ApprovalRequest(i) => map_approval_request(i),
        TurnItem::Checkpoint(_) => None,
        TurnItem::RunInterruptRequest(i) => map_run_interrupt_request(i),
        TurnItem::RunInterruptResult(i) => map_run_interrupt_result(i),
        TurnItem::SystemNotice(i) => map_system_notice(i),
        TurnItem::Error(i) => map_error(i),
        TurnItem::Compaction(i) => map_compaction(i),
        TurnItem::Handoff(i) => map_handoff(i),
        TurnItem::Fork(i) => map_fork(i),
        TurnItem::ThreadCreated(i) => map_thread_created(i),
        TurnItem::SecretRequest(i) => map_secret_request(i),
        TurnItem::LinkRequest(i) => map_link_request(i),
        TurnItem::Subagent(i) => map_subagent(i),
        TurnItem::DynamicTool(i) => map_dynamic_tool(i),
    }
}

fn map_user_message(item: UserMessageItem) -> Option<TimelineEntry> {
    if item.input_intent == UserMessageIntent::QueuedTurn {
        match item.status {
            TurnItemStatus::Pending => {
                return Some(TimelineEntry::QueuedUser {
                    id: item.id,
                    run_id: item.run_id.unwrap_or_default(),
                    message_id: item.message_id,
                    text: item.text,
                    attachments: item.attachments,
                    created_at: item.started_at.unwrap_or(item.updated_at),
                    created_by_agent: item.created_by != Actor::User,
                });
            }
            TurnItemStatus::Cancelled => return None,
            _ => {}
        }
    }
    let is_steer = matches!(
        item.input_intent,
        UserMessageIntent::Steer | UserMessageIntent::PromotedQueuedToSteer
    );
    Some(TimelineEntry::User {
        id: item.id,
        text: item.text,
        created_by_agent: item.created_by != Actor::User,
        created_at: Some(item.started_at.unwrap_or(item.updated_at)),
        attachments: item.attachments,
        is_steer,
        run_id: item.run_id,
    })
}

fn map_assistant_message(item: AssistantMessageItem) -> Option<TimelineEntry> {
    Some(TimelineEntry::Assistant {
        id: item.id,
        markdown: item.text,
        streaming: item.streaming,
        created_at: Some(item.updated_at),
        run_id: item.run_id,
        status: map_item_status(item.status),
    })
}

fn map_reasoning(item: ReasoningItem) -> Option<TimelineEntry> {
    Some(TimelineEntry::Thinking {
        id: item.id,
        text: item.text,
        streaming: item.streaming,
    })
}

fn map_proposed_plan(item: ProposedPlanItem) -> Option<TimelineEntry> {
    let title = proposed_plan_title(&item.markdown)
        .or_else(|| non_empty(item.title))
        .unwrap_or_else(|| "Proposed plan".to_owned());
    Some(TimelineEntry::ProposedPlan {
        id: item.id,
        run_id: item.run_id,
        title,
        markdown: item.markdown,
        streaming: item.streaming,
        status: map_item_status(item.status),
        created_at: Some(item.updated_at),
    })
}

fn map_command_execution(item: CommandExecutionItem) -> Option<TimelineEntry> {
    if item.input == WORKSPACE_PREPARATION_INPUT && item.deferred_work.is_none() {
        return None;
    }
    let has_title = non_empty(item.title.clone()).is_some();
    let title = non_empty(item.title).unwrap_or_else(|| {
        if item.input.trim().is_empty() {
            "Command".to_owned()
        } else {
            item.input.clone()
        }
    });
    let detail = non_empty(item.output)
        .or_else(|| (has_title && !item.input.trim().is_empty()).then_some(item.input));
    let status = if item.status == TurnItemStatus::Completed
        && (item.output_indicates_failure == Some(true)
            || item.exit_code.is_some_and(|code| code != 0))
    {
        ItemStatus::Failed
    } else {
        map_item_status(item.status)
    };
    Some(TimelineEntry::Tool {
        id: item.id,
        kind: "command".to_owned(),
        title,
        detail,
        status,
        output_omitted: item.output_omitted == Some(true),
    })
}

fn map_file_change(item: FileChangeItem) -> Option<TimelineEntry> {
    let title = non_empty(item.title).unwrap_or_else(|| {
        if let Some(changes) = &item.changes
            && changes.len() > 1
        {
            format!("Changed {} files", changes.len())
        } else {
            format!("Changed {}", item.file_name)
        }
    });
    let detail = non_empty(item.diff_str).or_else(|| non_empty(Some(item.file_name)));
    Some(TimelineEntry::Tool {
        id: item.id,
        kind: "file_change".to_owned(),
        title,
        detail,
        status: map_item_status(item.status),
        output_omitted: false,
    })
}

fn map_file_search(item: FileSearchItem) -> Option<TimelineEntry> {
    let title = non_empty(item.title).unwrap_or_else(|| "Searched files".to_owned());
    Some(TimelineEntry::Tool {
        id: item.id,
        kind: "file_search".to_owned(),
        title,
        detail: non_empty(item.pattern),
        status: map_item_status(item.status),
        output_omitted: false,
    })
}

fn map_web_search(item: WebSearchItem) -> Option<TimelineEntry> {
    let title = non_empty(item.title).unwrap_or_else(|| "Searched the web".to_owned());
    let detail = item
        .patterns
        .filter(|patterns| !patterns.is_empty())
        .map(|patterns| patterns.join(", "));
    Some(TimelineEntry::Tool {
        id: item.id,
        kind: "web_search".to_owned(),
        title,
        detail,
        status: map_item_status(item.status),
        output_omitted: false,
    })
}

fn map_dynamic_tool(item: DynamicToolItem) -> Option<TimelineEntry> {
    let title = non_empty(item.title)
        .or_else(|| non_empty(item.tool_name))
        .unwrap_or_else(|| "Tool call".to_owned());
    let output_omitted = item.output_omitted == Some(true);
    let detail = non_empty(
        item.output
            .as_ref()
            .and_then(Option::as_ref)
            .and_then(json_text),
    )
    .or_else(|| non_empty(item.viewed_image_path));
    Some(TimelineEntry::Tool {
        id: item.id,
        kind: "dynamic_tool".to_owned(),
        title,
        detail,
        status: map_item_status(item.status),
        output_omitted,
    })
}

fn map_subagent(item: SubagentItem) -> Option<TimelineEntry> {
    let title =
        format_subagent_display_title(non_empty(item.title).as_deref().unwrap_or("Subagent"));
    let summary = subagent_detail(
        item.status,
        item.progress.as_deref(),
        item.result.as_deref(),
    );
    Some(TimelineEntry::Subagent {
        id: item.id,
        child_thread_id: non_empty(item.child_thread_id),
        title,
        role: item.driver,
        status: item.status,
        summary,
        remote_label: item.remote_child.map(|remote| remote.label),
        created_at: Some(item.updated_at),
        started_at: item.started_at,
        completed_at: item.completed_at,
    })
}

fn map_todo_list(item: TodoListItem) -> Option<TimelineEntry> {
    let done = item
        .steps
        .iter()
        .filter(|step| step.status == PlanStepStatus::Completed)
        .count();
    let current = item
        .steps
        .iter()
        .find(|step| step.status == PlanStepStatus::Running)
        .or_else(|| {
            item.steps
                .iter()
                .find(|step| step.status == PlanStepStatus::Pending)
        });
    let title = non_empty(item.title).unwrap_or_else(|| match current {
        Some(step) => format!("Tasks {done}/{} · {}", item.steps.len(), step.text),
        None => format!("Tasks {done}/{}", item.steps.len()),
    });
    Some(TimelineEntry::Tool {
        id: item.id,
        kind: "todo_list".to_owned(),
        title,
        detail: non_empty(item.explanation),
        status: map_item_status(item.status),
        output_omitted: false,
    })
}

fn map_approval_request(item: ApprovalRequestItem) -> Option<TimelineEntry> {
    let title = non_empty(item.title).unwrap_or_else(|| "Approval requested".to_owned());
    let detail = non_empty(item.prompt)
        .or_else(|| non_empty(item.reason))
        .or_else(|| Some(request_kind_label(item.request_kind).to_owned()));
    if is_pending_item_status(item.status) {
        Some(TimelineEntry::Approval {
            id: item.id,
            title,
            detail,
        })
    } else {
        Some(TimelineEntry::Tool {
            id: item.id,
            kind: "approval".to_owned(),
            title,
            detail,
            status: map_item_status(item.status),
            output_omitted: false,
        })
    }
}

fn map_user_input_request(item: UserInputRequestItem) -> Option<TimelineEntry> {
    let questions: Vec<UserInputQuestion> = item
        .questions
        .into_iter()
        .map(|q| UserInputQuestion {
            id: q.id,
            header: q.header,
            question: q.question,
            options: q
                .options
                .into_iter()
                .map(|o| UserInputOption {
                    label: o.label,
                    description: o.description,
                    value: o.value,
                })
                .collect(),
            multi_select: q.multi_select == Some(true),
            allow_custom_answer: q.allow_custom_answer != Some(false),
            initial_answer: q.initial_answer,
        })
        .collect();
    let answers = item
        .question_answer
        .as_ref()
        .map(|payload| {
            let texts = payload.question_text_by_id.as_ref();
            let mut out: Vec<UserInputAnswer> = Vec::new();
            // Keep question order; append answers for ids the questions list lacks.
            for q in &questions {
                if let Some(value) = payload.answers.get(&q.id) {
                    out.push(UserInputAnswer {
                        question_id: q.id.clone(),
                        question: texts
                            .and_then(|t| t.get(&q.id).cloned())
                            .unwrap_or_else(|| q.question.clone()),
                        answer: answer_text(value),
                    });
                }
            }
            for (qid, value) in &payload.answers {
                if !questions.iter().any(|q| &q.id == qid) {
                    out.push(UserInputAnswer {
                        question_id: qid.clone(),
                        question: texts.and_then(|t| t.get(qid).cloned()).unwrap_or_default(),
                        answer: answer_text(value),
                    });
                }
            }
            out
        })
        .unwrap_or_default();
    let pending = is_pending_item_status(item.status) && item.question_answer.is_none();
    Some(TimelineEntry::UserInputRequest {
        id: item.id,
        request_id: item.request_id,
        title: non_empty(item.title),
        questions,
        status: item.status,
        pending,
        answers,
        dismissible: item.response_mode.is_some(),
        created_at: Some(item.started_at.unwrap_or(item.updated_at)),
    })
}

/// Renders one provider answer value (`string`, `string[]`, or other JSON) as display text.
fn answer_text(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Array(items) => {
            items.iter().map(answer_text).collect::<Vec<_>>().join(", ")
        }
        serde_json::Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// Text of a dynamic tool's JSON output: strings as-is, `{ text }` / `{ content: [{text}] }`
/// unwrapped, other values pretty-printed.
fn json_text(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::Null => None,
        serde_json::Value::String(s) => Some(s.clone()),
        serde_json::Value::Object(map) => {
            if let Some(text) = map.get("text").and_then(serde_json::Value::as_str) {
                return Some(text.to_owned());
            }
            if let Some(serde_json::Value::Array(parts)) = map.get("content") {
                let joined: Vec<&str> = parts
                    .iter()
                    .filter_map(|p| p.get("text").and_then(serde_json::Value::as_str))
                    .collect();
                if !joined.is_empty() {
                    return Some(joined.join("\n"));
                }
            }
            serde_json::to_string_pretty(value).ok()
        }
        other => serde_json::to_string_pretty(other).ok(),
    }
}

fn map_secret_request(item: SecretRequestItem) -> Option<TimelineEntry> {
    let pending =
        item.secret_status == SecretRequestStatus::Pending && is_pending_item_status(item.status);
    Some(TimelineEntry::SecretRequest {
        id: item.id,
        label: item.label,
        reason: item.reason,
        url: non_empty(item.url),
        placeholder: non_empty(item.placeholder),
        file_delivery: item.delivery.is_some(),
        status: item.secret_status,
        pending,
        created_at: Some(item.started_at.unwrap_or(item.updated_at)),
    })
}

fn map_link_request(item: LinkRequestItem) -> Option<TimelineEntry> {
    let title = non_empty(item.title)
        .or_else(|| non_empty(item.label))
        .unwrap_or_else(|| "Link environment".to_owned());
    let detail = non_empty(Some(item.reason));
    // Peer linking is Orbit-owned (`docs/scope.md` #1): show a read-only row, never
    // Approve/Decline buttons that cannot link anything.
    let status = if item.link_status == LinkStatus::Pending && is_pending_item_status(item.status) {
        ItemStatus::Running
    } else {
        map_item_status(item.status)
    };
    Some(TimelineEntry::Tool {
        id: item.id,
        kind: "link_request".to_owned(),
        title,
        detail,
        status,
        output_omitted: false,
    })
}

fn map_error(item: ErrorItem) -> Option<TimelineEntry> {
    Some(TimelineEntry::Notice {
        id: item.id,
        text: item.failure.message,
        is_error: true,
    })
}

fn map_system_notice(item: SystemNoticeItem) -> Option<TimelineEntry> {
    Some(TimelineEntry::Notice {
        id: item.id,
        text: item.message,
        is_error: false,
    })
}

fn map_notification(item: NotificationItem) -> Option<TimelineEntry> {
    Some(TimelineEntry::Notice {
        id: item.id,
        text: item.summary,
        is_error: false,
    })
}

fn map_run_interrupt_request(item: RunInterruptRequestItem) -> Option<TimelineEntry> {
    Some(TimelineEntry::Notice {
        id: item.id,
        text: item.message,
        is_error: false,
    })
}

fn map_run_interrupt_result(item: RunInterruptResultItem) -> Option<TimelineEntry> {
    Some(TimelineEntry::Notice {
        id: item.id,
        text: item.message,
        is_error: false,
    })
}

fn map_compaction(item: CompactionItem) -> Option<TimelineEntry> {
    let text = non_empty(item.summary)
        .or_else(|| non_empty(item.title))
        .unwrap_or_else(|| "Context compacted".to_owned());
    Some(TimelineEntry::Notice {
        id: item.id,
        text,
        is_error: false,
    })
}

fn map_handoff(item: HandoffItem) -> Option<TimelineEntry> {
    let text = non_empty(item.summary)
        .or_else(|| non_empty(item.title))
        .unwrap_or_else(|| "Context handed off".to_owned());
    Some(TimelineEntry::Notice {
        id: item.id,
        text,
        is_error: false,
    })
}

fn map_fork(item: ForkItem) -> Option<TimelineEntry> {
    let text = non_empty(item.title).unwrap_or_else(|| "Forked thread".to_owned());
    Some(TimelineEntry::Notice {
        id: item.id,
        text,
        is_error: false,
    })
}

fn map_thread_created(item: ThreadCreatedItem) -> Option<TimelineEntry> {
    let title = non_empty(item.title).unwrap_or_else(|| "Created thread".to_owned());
    Some(TimelineEntry::Tool {
        id: item.id,
        kind: "thread_created".to_owned(),
        title,
        detail: Some(item.target_thread_id),
        status: map_item_status(item.status),
        output_omitted: false,
    })
}

fn request_kind_label(kind: ProviderRequestKind) -> &'static str {
    match kind {
        ProviderRequestKind::Command => "command",
        ProviderRequestKind::FileRead => "file-read",
        ProviderRequestKind::FileChange => "file-change",
        ProviderRequestKind::McpElicitation => "mcp-elicitation",
        ProviderRequestKind::Permission => "permission",
    }
}

fn build_timing(
    run_id: &Option<String>,
    started_at: &Option<String>,
    completed_at: &Option<String>,
    updated_at: &str,
) -> EntryTiming {
    let started_at_ms = started_at.as_deref().and_then(parse_iso8601_epoch_ms);
    let completed_at_ms = completed_at
        .as_deref()
        .and_then(parse_iso8601_epoch_ms)
        .or_else(|| parse_iso8601_epoch_ms(updated_at));
    EntryTiming {
        run_id: run_id.clone(),
        started_at_ms,
        completed_at_ms,
    }
}

fn extract_turn_item_timing(item: &TurnItem) -> EntryTiming {
    macro_rules! timing_of {
        ($i:expr) => {
            build_timing(&$i.run_id, &$i.started_at, &$i.completed_at, &$i.updated_at)
        };
    }
    match item {
        TurnItem::Notification(i) => timing_of!(i),
        TurnItem::UserMessage(i) => timing_of!(i),
        TurnItem::AssistantMessage(i) => timing_of!(i),
        TurnItem::Reasoning(i) => timing_of!(i),
        TurnItem::ProposedPlan(i) => timing_of!(i),
        TurnItem::TodoList(i) => timing_of!(i),
        TurnItem::UserInputRequest(i) => timing_of!(i),
        TurnItem::FileChange(i) => timing_of!(i),
        TurnItem::CommandExecution(i) => timing_of!(i),
        TurnItem::FileSearch(i) => timing_of!(i),
        TurnItem::WebSearch(i) => timing_of!(i),
        TurnItem::ApprovalRequest(i) => timing_of!(i),
        TurnItem::Checkpoint(i) => timing_of!(i),
        TurnItem::RunInterruptRequest(i) => timing_of!(i),
        TurnItem::RunInterruptResult(i) => timing_of!(i),
        TurnItem::SystemNotice(i) => timing_of!(i),
        TurnItem::Error(i) => timing_of!(i),
        TurnItem::Compaction(i) => timing_of!(i),
        TurnItem::Handoff(i) => timing_of!(i),
        TurnItem::Fork(i) => timing_of!(i),
        TurnItem::ThreadCreated(i) => timing_of!(i),
        TurnItem::SecretRequest(i) => timing_of!(i),
        TurnItem::LinkRequest(i) => timing_of!(i),
        TurnItem::Subagent(i) => timing_of!(i),
        TurnItem::DynamicTool(i) => timing_of!(i),
    }
}

fn extract_projection_timing(item: &ProjectionTurnItem) -> Option<(String, EntryTiming)> {
    macro_rules! timing_of {
        ($i:expr) => {
            Some((
                $i.id.clone(),
                build_timing(&$i.run_id, &$i.started_at, &$i.completed_at, &$i.updated_at),
            ))
        };
    }
    match item {
        ProjectionTurnItem::Notification(i) => timing_of!(i),
        ProjectionTurnItem::UserMessage(i) => timing_of!(i),
        ProjectionTurnItem::AssistantMessage(i) => timing_of!(i),
        ProjectionTurnItem::Reasoning(i) => timing_of!(i),
        ProjectionTurnItem::ProposedPlan(i) => timing_of!(i),
        ProjectionTurnItem::TodoList(i) => timing_of!(i),
        ProjectionTurnItem::UserInputRequest(i) => timing_of!(i),
        ProjectionTurnItem::FileChange(i) => timing_of!(i),
        ProjectionTurnItem::CommandExecution(i) => timing_of!(i),
        ProjectionTurnItem::FileSearch(i) => timing_of!(i),
        ProjectionTurnItem::WebSearch(i) => timing_of!(i),
        ProjectionTurnItem::ApprovalRequest(i) => timing_of!(i),
        ProjectionTurnItem::Checkpoint(i) => timing_of!(i),
        ProjectionTurnItem::RunInterruptRequest(i) => timing_of!(i),
        ProjectionTurnItem::RunInterruptResult(i) => timing_of!(i),
        ProjectionTurnItem::SystemNotice(i) => timing_of!(i),
        ProjectionTurnItem::Error(i) => timing_of!(i),
        ProjectionTurnItem::Compaction(i) => timing_of!(i),
        ProjectionTurnItem::Handoff(i) => timing_of!(i),
        ProjectionTurnItem::Fork(i) => timing_of!(i),
        ProjectionTurnItem::ThreadCreated(i) => timing_of!(i),
        ProjectionTurnItem::SecretRequest(i) => timing_of!(i),
        ProjectionTurnItem::LinkRequest(i) => timing_of!(i),
        ProjectionTurnItem::Subagent(i) => timing_of!(i),
        ProjectionTurnItem::DynamicTool(i) => timing_of!(i),
        ProjectionTurnItem::Unknown(_) => None,
    }
}

/// Parses an RFC 3339 / ISO 8601 timestamp (e.g. `2026-11-21T10:15:30.250Z`) into Unix
/// milliseconds.
#[must_use]
pub fn parse_iso8601_epoch_ms(raw: &str) -> Option<i64> {
    let s = raw.trim();
    if s.len() < 19 {
        return None;
    }
    let bytes = s.as_bytes();
    if bytes.get(4) != Some(&b'-')
        || bytes.get(7) != Some(&b'-')
        || !matches!(bytes.get(10), Some(b'T' | b't' | b' '))
        || bytes.get(13) != Some(&b':')
        || bytes.get(16) != Some(&b':')
    {
        return None;
    }
    let year: i64 = s.get(0..4)?.parse().ok()?;
    let month: u32 = s.get(5..7)?.parse().ok()?;
    let day: u32 = s.get(8..10)?.parse().ok()?;
    let hour: i64 = s.get(11..13)?.parse().ok()?;
    let minute: i64 = s.get(14..16)?.parse().ok()?;
    let second: i64 = s.get(17..19)?.parse().ok()?;
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || !(0..=23).contains(&hour)
        || !(0..=59).contains(&minute)
        || !(0..=60).contains(&second)
    {
        return None;
    }

    let mut rest = &s[19..];
    let mut millis: i64 = 0;
    if let Some(after_dot) = rest.strip_prefix('.') {
        let digits_end = after_dot
            .find(|c: char| !c.is_ascii_digit())
            .unwrap_or(after_dot.len());
        let frac = &after_dot[..digits_end];
        if !frac.is_empty() {
            let mut scaled = 0i64;
            for (idx, b) in frac.bytes().take(3).enumerate() {
                let d = i64::from(b - b'0');
                let mult = match idx {
                    0 => 100,
                    1 => 10,
                    _ => 1,
                };
                scaled += d * mult;
            }
            millis = scaled;
        }
        rest = &after_dot[digits_end..];
    }

    let tz_offset_secs: i64 = if rest.is_empty() || rest == "Z" || rest == "z" {
        0
    } else {
        let sign = rest.bytes().next().filter(|&b| b == b'+' || b == b'-')?;
        let off = &rest[1..];
        let (hh_str, mm_str) = if let Some((h, m)) = off.split_once(':') {
            (h, m)
        } else if off.len() == 4 {
            (&off[0..2], &off[2..4])
        } else {
            return None;
        };
        let hh: i64 = hh_str.parse().ok()?;
        let mm: i64 = mm_str.parse().ok()?;
        let secs = hh * 3600 + mm * 60;
        if sign == b'+' { secs } else { -secs }
    };

    let days = days_from_civil(year, month, day);
    let secs = days * 86_400 + hour * 3600 + minute * 60 + second - tz_offset_secs;
    Some(secs * 1000 + millis)
}

pub(crate) fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let y = year - i64::from(month <= 2);
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let m = i64::from(month);
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + i64::from(day) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod timing_tests {
    use super::*;

    #[test]
    fn parses_iso8601_milliseconds_and_offsets() {
        let base = parse_iso8601_epoch_ms("2026-11-21T10:00:00.000Z");
        let later = parse_iso8601_epoch_ms("2026-11-21T10:00:07.500Z");
        let offset = parse_iso8601_epoch_ms("2026-11-21T11:00:07.5Z+01:00");
        assert!(base.is_some(), "base timestamp should parse");
        assert_eq!(
            later.zip(base).map(|(a, b)| a - b),
            Some(7_500),
            "elapsed should be 7500ms"
        );
        assert_eq!(offset, None, "malformed trailing Z+offset should reject");
        let valid_offset = parse_iso8601_epoch_ms("2026-11-21T11:00:07.5+01:00");
        assert_eq!(valid_offset, later, "+01:00 offset should match UTC time");
    }

    #[test]
    fn computes_work_group_duration_from_entries_and_run_fallback() {
        let mut state = ThreadState::new("t1");
        state.entry_timings.insert(
            "e1".to_owned(),
            EntryTiming {
                run_id: Some("r1".to_owned()),
                started_at_ms: Some(1_000),
                completed_at_ms: Some(3_200),
            },
        );
        state.entry_timings.insert(
            "e2".to_owned(),
            EntryTiming {
                run_id: Some("r1".to_owned()),
                started_at_ms: Some(3_200),
                completed_at_ms: Some(8_500),
            },
        );
        assert_eq!(
            state.work_group_duration_ms(&["e1", "e2"]),
            Some(7_500),
            "duration spans earliest start to latest end"
        );

        // Fallback to run timing when entries lack started_at_ms.
        state.entry_timings.insert(
            "e3".to_owned(),
            EntryTiming {
                run_id: Some("r2".to_owned()),
                started_at_ms: None,
                completed_at_ms: None,
            },
        );
        state.run_timings.insert(
            "r2".to_owned(),
            RunTiming {
                started_at_ms: Some(10_000),
                completed_at_ms: Some(22_400),
            },
        );
        assert_eq!(
            state.work_group_duration_ms(&["e3"]),
            Some(12_400),
            "falls back to owning run elapsed duration"
        );
    }
}
