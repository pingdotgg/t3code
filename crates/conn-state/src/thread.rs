use conn_contract::{
    OrchestrationV2DomainEvent as DomainEvent, OrchestrationV2LinkRequestStatus as LinkStatus,
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
    pub approval_requests: std::collections::HashMap<String, String>,
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
                let projection = snapshot.projection;
                self.thread_id = projection.thread.id;
                self.sequence = Some(snapshot.snapshot_sequence);
                self.working = runs_are_working(&projection.runs);

                let mut entries = Vec::new();
                if !projection.visible_turn_items.is_empty() {
                    let mut rows = projection.visible_turn_items;
                    rows.sort_by_key(|row| row.position);
                    for row in rows {
                        if let ProjectionTurnItem::ApprovalRequest(i) = &row.item {
                            self.approval_requests
                                .insert(i.id.clone(), i.request_id.clone());
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
                        if let Some(entry) = map_projection_turn_item(turn_item) {
                            upsert_entry(&mut entries, entry);
                        }
                    }
                }
                self.entries = entries;
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

    fn apply_domain_event(&mut self, event: DomainEvent) -> bool {
        match event {
            DomainEvent::RunCreated(ev) => {
                let next_working = is_run_working(ev.payload.status);
                let changed = self.working != next_working;
                self.working = next_working;
                changed
            }
            DomainEvent::RunUpdated(ev) => {
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
                if let Some(entry) = map_turn_item(ev.payload) {
                    upsert_entry(&mut self.entries, entry)
                } else {
                    remove_entry(&mut self.entries, &item_id)
                }
            }
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
            | DomainEvent::CheckpointCaptured(_)
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
