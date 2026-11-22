use std::collections::HashMap;

use conn_contract::{
    OrchestrationV2Actor as Actor, OrchestrationV2Checkpoint as Checkpoint,
    OrchestrationV2CheckpointStatus as CheckpointStatus, OrchestrationV2DomainEvent as DomainEvent,
    OrchestrationV2LinkRequestStatus as LinkStatus,
    OrchestrationV2PlanStepStatus as PlanStepStatus, OrchestrationV2Run as Run,
    OrchestrationV2RunStatus as RunStatus, OrchestrationV2SecretRequestStatus as SecretStatus,
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
    OrchestrationV2TurnItemStatus as TurnItemStatus,
    OrchestrationV2TurnItemSubagent as SubagentItem,
    OrchestrationV2TurnItemSystemNotice as SystemNoticeItem,
    OrchestrationV2TurnItemThreadCreated as ThreadCreatedItem,
    OrchestrationV2TurnItemTodoList as TodoListItem,
    OrchestrationV2TurnItemUserInputRequest as UserInputRequestItem,
    OrchestrationV2TurnItemUserMessage as UserMessageItem,
    OrchestrationV2TurnItemWebSearch as WebSearchItem,
    OrchestrationV2UserMessageInputIntent as UserMessageIntent, ProviderRequestKind,
};

const WORKSPACE_PREPARATION_INPUT: &str = "Preparing workspace";

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
    },
    /// Assistant Markdown. `streaming` is true while deltas still arrive.
    Assistant {
        id: String,
        markdown: String,
        streaming: bool,
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
    },
    /// A pending approval or question the user must answer.
    Approval {
        id: String,
        title: String,
        detail: Option<String>,
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
            | Self::Assistant { id, .. }
            | Self::Thinking { id, .. }
            | Self::Tool { id, .. }
            | Self::Approval { id, .. }
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
}

impl ThreadState {
    /// Creates an empty thread state for `thread_id`.
    #[must_use]
    pub fn new(thread_id: impl Into<String>) -> Self {
        Self {
            thread_id: thread_id.into(),
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

    /// Replaces this thread's timeline from a full [`conn_contract::OrchestrationV2ThreadProjection`]
    /// (from `subscribeThread` snapshots or `orchestration.launchThread` responses).
    pub fn apply_projection(
        &mut self,
        projection: conn_contract::OrchestrationV2ThreadProjection,
        sequence: Option<i64>,
    ) {
        self.thread_id = projection.thread.id;
        if let Some(seq) = sequence {
            self.advance_sequence(seq);
        }
        self.working = runs_are_working(&projection.runs);

        self.run_timings.clear();
        for run in &projection.runs {
            self.record_run_timing(run);
        }

        self.turn_checkpoints.clear();
        for checkpoint in &projection.checkpoints {
            self.record_checkpoint(checkpoint);
        }

        self.approval_requests.clear();
        self.entry_timings.clear();
        let mut entries = Vec::new();
        if !projection.visible_turn_items.is_empty() {
            let mut rows = projection.visible_turn_items;
            rows.sort_by_key(|row| row.position);
            for row in rows {
                if let ProjectionTurnItem::ApprovalRequest(i) = &row.item {
                    self.approval_requests
                        .insert(i.id.clone(), i.request_id.clone());
                }
                if let Some((id, timing)) = extract_projection_timing(&row.item) {
                    self.entry_timings.insert(id, timing);
                }
                if let Some(entry) = map_projection_turn_item(row.item) {
                    upsert_entry(&mut entries, entry);
                }
            }
        } else {
            for turn_item in projection.turn_items {
                if let ProjectionTurnItem::ApprovalRequest(i) = &turn_item {
                    self.approval_requests
                        .insert(i.id.clone(), i.request_id.clone());
                }
                if let Some((id, timing)) = extract_projection_timing(&turn_item) {
                    self.entry_timings.insert(id, timing);
                }
                if let Some(entry) = map_projection_turn_item(turn_item) {
                    upsert_entry(&mut entries, entry);
                }
            }
        }
        self.entries = entries;
    }

    /// Applies one `subscribeThread` stream item.
    ///
    /// Returns `true` when timeline entries or the `working` state changed.
    pub fn apply(&mut self, item: ThreadStreamItem) -> bool {
        match item {
            ThreadStreamItem::Synchronized(_) => {
                self.synchronized = true;
                false
            }
            ThreadStreamItem::Snapshot(snapshot) => {
                self.apply_projection(snapshot.projection, Some(snapshot.snapshot_sequence));
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
        };
        let changed = self.turn_checkpoints.get(run_id) != Some(&summary);
        self.turn_checkpoints.insert(run_id.clone(), summary);
        changed
    }

    fn apply_domain_event(&mut self, event: DomainEvent) -> bool {
        match event {
            DomainEvent::RunCreated(ev) => {
                self.record_run_timing(&ev.payload);
                let next_working = is_run_working(ev.payload.status);
                let changed = self.working != next_working;
                self.working = next_working;
                changed
            }
            DomainEvent::RunUpdated(ev) => {
                self.record_run_timing(&ev.payload);
                let next_working = is_run_working(ev.payload.status);
                let changed = self.working != next_working;
                self.working = next_working;
                changed
            }
            DomainEvent::TurnItemUpdated(ev) => {
                let item_id = turn_item_id(&ev.payload).to_owned();
                if let TurnItem::ApprovalRequest(i) = &ev.payload {
                    self.approval_requests
                        .insert(i.id.clone(), i.request_id.clone());
                }
                let timing = extract_turn_item_timing(&ev.payload);
                self.entry_timings.insert(item_id.clone(), timing);
                if let Some(entry) = map_turn_item(ev.payload) {
                    upsert_entry(&mut self.entries, entry)
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
            | DomainEvent::MessageUpdated(_)
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
                TimelineEntry::Assistant { streaming, .. }
                | TimelineEntry::Thinking { streaming, .. }
                    if *streaming =>
                {
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

fn runs_are_working(runs: &[Run]) -> bool {
    runs.iter().any(|run| is_run_working(run.status))
}

fn is_run_working(status: RunStatus) -> bool {
    matches!(
        status,
        RunStatus::Preparing
            | RunStatus::Queued
            | RunStatus::Starting
            | RunStatus::Running
            | RunStatus::Waiting
    )
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
        true
    } else {
        entries.push(entry);
        true
    }
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
    if item.input_intent == UserMessageIntent::QueuedTurn && item.status == TurnItemStatus::Pending
    {
        return None;
    }
    Some(TimelineEntry::User {
        id: item.id,
        text: item.text,
        created_by_agent: item.created_by != Actor::User,
    })
}

fn map_assistant_message(item: AssistantMessageItem) -> Option<TimelineEntry> {
    Some(TimelineEntry::Assistant {
        id: item.id,
        markdown: item.text,
        streaming: item.streaming,
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
    Some(TimelineEntry::Assistant {
        id: item.id,
        markdown: item.markdown,
        streaming: item.streaming,
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
    })
}

fn map_dynamic_tool(item: DynamicToolItem) -> Option<TimelineEntry> {
    let title = non_empty(item.title)
        .or_else(|| non_empty(item.tool_name))
        .unwrap_or_else(|| "Tool call".to_owned());
    Some(TimelineEntry::Tool {
        id: item.id,
        kind: "dynamic_tool".to_owned(),
        title,
        detail: non_empty(item.viewed_image_path),
        status: map_item_status(item.status),
    })
}

fn map_subagent(item: SubagentItem) -> Option<TimelineEntry> {
    let title = non_empty(item.title).unwrap_or_else(|| "Subagent".to_owned());
    let detail = non_empty(item.progress)
        .or_else(|| non_empty(item.result))
        .or_else(|| non_empty(Some(item.prompt)));
    Some(TimelineEntry::Tool {
        id: item.id,
        kind: "subagent".to_owned(),
        title,
        detail,
        status: map_item_status(item.status),
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
        })
    }
}

fn map_user_input_request(item: UserInputRequestItem) -> Option<TimelineEntry> {
    let answered = item.question_answer.is_some();
    let title = non_empty(item.title).unwrap_or_else(|| {
        if answered {
            "Answered questions".to_owned()
        } else {
            "Input requested".to_owned()
        }
    });
    let detail = item.questions.first().map(|q| q.question.clone());
    if is_pending_item_status(item.status) && !answered {
        Some(TimelineEntry::Approval {
            id: item.id,
            title,
            detail,
        })
    } else {
        Some(TimelineEntry::Tool {
            id: item.id,
            kind: "user_input".to_owned(),
            title,
            detail,
            status: map_item_status(item.status),
        })
    }
}

fn map_secret_request(item: SecretRequestItem) -> Option<TimelineEntry> {
    let title = non_empty(item.title)
        .or_else(|| non_empty(Some(item.label)))
        .unwrap_or_else(|| "Secret requested".to_owned());
    let detail = non_empty(Some(item.reason));
    if item.secret_status == SecretStatus::Pending && is_pending_item_status(item.status) {
        Some(TimelineEntry::Approval {
            id: item.id,
            title,
            detail,
        })
    } else {
        Some(TimelineEntry::Tool {
            id: item.id,
            kind: "secret_request".to_owned(),
            title,
            detail,
            status: map_item_status(item.status),
        })
    }
}

fn map_link_request(item: LinkRequestItem) -> Option<TimelineEntry> {
    let title = non_empty(item.title)
        .or_else(|| non_empty(item.label))
        .unwrap_or_else(|| "Link environment".to_owned());
    let detail = non_empty(Some(item.reason));
    if item.link_status == LinkStatus::Pending && is_pending_item_status(item.status) {
        Some(TimelineEntry::Approval {
            id: item.id,
            title,
            detail,
        })
    } else {
        Some(TimelineEntry::Tool {
            id: item.id,
            kind: "link_request".to_owned(),
            title,
            detail,
            status: map_item_status(item.status),
        })
    }
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

fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
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
