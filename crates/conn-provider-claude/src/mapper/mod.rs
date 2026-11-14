//! Turns CLI messages into `ProviderEvent`s and CLI replies. Pure: no I/O, no async, time and
//! randomness come from [`Env`], so recorded sessions replay exactly.
//!
//! Event shapes follow `ClaudeAdapterV2.ts` (`publishAssistantArtifacts`,
//! `buildToolCallArtifacts`, `buildApprovalRequestArtifacts`, `emitContextUsage`,
//! `finalizeActiveTurn`). Known differences are listed in the crate README.

mod notices;
mod subagents;

use std::collections::{HashMap, HashSet, VecDeque};

use conn_contract::{AppThread, from_json};
use conn_provider::{
    ContinuationRequest, ProviderError, ProviderEvent, RuntimeRequestResponse, SteerStatus,
    ThreadDisposition, TurnInput, TurnStatus, TurnTerminal,
};

use notices::{LimitState, RetryState, TaskEntry};
use serde_json::{Map, Value, json};
pub use subagents::subagent_thread_id;
use subagents::{ParentCtx, Subagents};

use crate::DRIVER;
use crate::ids::{self, Env};
use crate::launch;
use crate::protocol::{
    AssistantMsg, Block, CanUseTool, ControlRequest, Delta, Elicitation, Inbound, ResultMsg,
    StreamEvent, SystemMsg, Usage, UserContent, UserDialog, UserMsg, control_error,
    control_success,
};

/// What the session must do after feeding the mapper.
#[expect(
    clippy::large_enum_variant,
    reason = "each value moves straight into the event channel, so boxing buys nothing"
)]
#[derive(Debug, Clone, PartialEq)]
pub enum Out {
    Event(ProviderEvent),
    /// One JSON line for the CLI's stdin.
    Write(String),
    /// A kind the mapper skipped; the session logs it.
    Skipped(String),
}

const DEFAULT_CONTEXT_TOKENS: u64 = 200_000;
const LONG_CONTEXT_TOKENS: u64 = 1_000_000;
/// Frames held for a continuation turn the engine has not started yet.
const WAKE_FRAME_CAP: usize = 512;
/// Steers in flight in one turn.
const STEER_CAP: usize = 64;
const RESUME_COMPACT_ANSWER: &str = "Compact and resume";
const RESUME_NEVER_ANSWER: &str = "Don't ask again";

pub struct Mapper<E: Env> {
    env: E,
    provider_session_id: String,
    turn: Option<Turn>,
    /// Keyed by runtime request id.
    pending: HashMap<String, Pending>,
    subagents: Subagents,
    /// The last turn's context, for subagents and continuations after it ended.
    last_ctx: Option<ParentCtx>,
    /// Root frames that arrived with no turn running (a background subagent woke Claude).
    wake: VecDeque<Inbound>,
    continuation_requested: bool,
    /// The last todo list per kind of source, so a new list supersedes it.
    latest_todo: Option<Value>,
    plan_ids: HashMap<String, String>,
    task_list: Option<Vec<TaskEntry>>,
    /// Context window sizes the CLI reported per model (`modelUsage[model].contextWindow`).
    context_windows: HashMap<String, u64>,
    /// Set by the session from its query policy; see [`Mapper::set_policy_asks`].
    policy_asks: Option<bool>,
}

impl<E: Env> std::fmt::Debug for Mapper<E> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Mapper")
            .field("provider_session_id", &self.provider_session_id)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum StreamKind {
    Text,
    Thinking,
}

#[derive(Debug)]
struct StreamItem {
    kind: StreamKind,
    started_at: String,
    text: String,
    dirty: bool,
    done: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct ToolCall {
    name: String,
    input: Value,
    ordinal: u32,
    started_at: String,
}

struct Turn {
    thread_id: String,
    run_id: String,
    run_ordinal: u32,
    turn_ordinal: u32,
    attempt_id: String,
    root_node_id: String,
    provider_thread: Value,
    provider_thread_id: String,
    provider_turn_id: String,
    native_turn_id: String,
    started_at: String,
    permission_mode: String,
    ordinals: HashMap<String, u32>,
    message_id: Option<String>,
    next_block: HashMap<(String, bool), u32>,
    snapshot_block: HashMap<(String, bool), u32>,
    stream_blocks: HashMap<u32, String>,
    streams: HashMap<String, StreamItem>,
    stream_order: Vec<String>,
    emitted: HashSet<String>,
    tools: HashMap<String, ToolCall>,
    tool_order: Vec<String>,
    usage: Option<(String, Usage, u64)>,
    model: Option<String>,
    models: Vec<String>,
    cursor: Option<String>,
    interrupt_requested: bool,
    auth_failed: bool,
    app_thread: Value,
    instance_id: String,
    root_model: String,
    /// Steers written but not yet taken: prompt uuid → message id.
    pending_steers: Vec<(String, String)>,
    steered: bool,
    retry: Option<RetryState>,
    compaction: Option<Value>,
    limits: LimitState,
    /// Usage of segments a steer cut short.
    steered_usage: Option<Usage>,
    had_subagents: bool,
}

impl Turn {
    fn parent_ctx(&self) -> ParentCtx {
        ParentCtx {
            thread_id: self.thread_id.clone(),
            run_id: self.run_id.clone(),
            provider_thread_id: self.provider_thread_id.clone(),
            provider_turn_id: self.provider_turn_id.clone(),
            root_node_id: self.root_node_id.clone(),
            instance_id: self.instance_id.clone(),
            root_model: self.root_model.clone(),
            app_thread: self.app_thread.clone(),
        }
    }
}

enum PendingKind {
    Approval {
        tool_name: String,
        input: Value,
        tool_use_id: String,
        suggestions: Option<Value>,
    },
    Question {
        tool_use_id: String,
        input: Value,
    },
    Elicitation,
    ResumeDialog {
        question: String,
    },
}

struct Pending {
    cli_request_id: String,
    kind: PendingKind,
    request: Value,
    node: Value,
    item: Value,
    thread_id: String,
}

impl<E: Env> Mapper<E> {
    pub fn new(env: E, provider_session_id: &str) -> Self {
        Self {
            env,
            provider_session_id: provider_session_id.to_string(),
            turn: None,
            pending: HashMap::new(),
            subagents: Subagents::default(),
            last_ctx: None,
            wake: VecDeque::new(),
            continuation_requested: false,
            latest_todo: None,
            plan_ids: HashMap::new(),
            task_list: None,
            context_windows: HashMap::new(),
            policy_asks: None,
        }
    }

    /// `requiresClaudeApproval` from the query policy. Unset, the live permission mode decides
    /// (only `auto` lets a forwarded request through).
    pub fn set_policy_asks(&mut self, asks: bool) {
        self.policy_asks = Some(asks);
    }

    /// Subagents still running, or Claude output waiting for a continuation turn.
    pub fn has_pending_background_work(&self) -> bool {
        self.subagents.any_running() || self.continuation_requested
    }

    /// Sizes of every collection that outlives a turn, for the memory checks.
    #[cfg(test)]
    pub fn held_sizes(&self) -> [usize; 6] {
        [
            self.pending.len(),
            self.subagents.len(),
            self.wake.len(),
            self.plan_ids.len(),
            self.context_windows.len(),
            self.task_list.as_ref().map_or(0, Vec::len),
        ]
    }

    pub fn env(&mut self) -> &mut E {
        &mut self.env
    }

    pub fn turn_active(&self) -> bool {
        self.turn.is_some()
    }

    pub fn active_turn_id(&self) -> Option<&str> {
        self.turn.as_ref().map(|t| t.provider_turn_id.as_str())
    }

    pub fn has_dirty_streams(&self) -> bool {
        self.turn
            .as_ref()
            .is_some_and(|t| t.streams.values().any(|s| s.dirty && !s.done))
    }

    /// Marks the running turn so its `result` reports `interrupted`.
    pub fn mark_interrupted(&mut self) {
        if let Some(turn) = &mut self.turn {
            turn.interrupt_requested = true;
        }
    }

    /// A steer was written into the running turn: `steer.updated` pending until Claude
    /// takes it.
    pub fn steer_sent(&mut self, prompt_uuid: &str, message_id: &str) -> Vec<Out> {
        let Some(turn) = &mut self.turn else {
            return Vec::new();
        };
        if turn.pending_steers.len() >= STEER_CAP {
            turn.pending_steers.remove(0);
        }
        turn.pending_steers
            .push((prompt_uuid.to_string(), message_id.to_string()));
        turn.steered = true;
        vec![steer_event(turn, message_id, SteerStatus::Pending)]
    }

    /// A steer could not be written: it is dropped from the turn.
    pub fn steer_failed(&mut self, prompt_uuid: &str) -> Vec<Out> {
        let Some(turn) = &mut self.turn else {
            return Vec::new();
        };
        let Some(index) = turn
            .pending_steers
            .iter()
            .position(|(u, _)| u == prompt_uuid)
        else {
            return Vec::new();
        };
        let (_, message_id) = turn.pending_steers.remove(index);
        vec![steer_event(turn, &message_id, SteerStatus::Completed)]
    }

    pub fn set_permission_mode(&mut self, mode: &str) {
        if let Some(turn) = &mut self.turn {
            turn.permission_mode = mode.to_string();
        }
    }

    /// Opens a turn after its user message was written to the CLI.
    pub fn begin_turn(&mut self, input: &TurnInput, permission_mode: &str) -> Vec<Out> {
        let now = self.env.now();
        // A user turn retires output held for a continuation that never started.
        self.wake.clear();
        self.continuation_requested = false;
        self.subagents.prune_settled();
        self.plan_ids.clear();
        let selection = conn_contract::to_json(&input.model_selection);
        let native_turn_id = format!("turn:{}", input.attempt_id.as_str());
        let mut provider_thread = conn_contract::to_json(&input.provider_thread);
        let provider_thread_id = str_of(&provider_thread, "id");
        let turn = Turn {
            thread_id: input.thread_id.as_str().into(),
            run_id: input.run_id.as_str().into(),
            run_ordinal: input.run_ordinal,
            turn_ordinal: input.provider_turn_ordinal,
            attempt_id: input.attempt_id.as_str().into(),
            root_node_id: input.root_node_id.as_str().into(),
            provider_thread: provider_thread.clone(),
            provider_thread_id,
            provider_turn_id: ids::provider_turn_id(DRIVER, &native_turn_id),
            native_turn_id,
            started_at: now.clone(),
            permission_mode: permission_mode.into(),
            ordinals: HashMap::new(),
            message_id: None,
            next_block: HashMap::new(),
            snapshot_block: HashMap::new(),
            stream_blocks: HashMap::new(),
            streams: HashMap::new(),
            stream_order: Vec::new(),
            emitted: HashSet::new(),
            tools: HashMap::new(),
            tool_order: Vec::new(),
            usage: None,
            model: None,
            models: Vec::new(),
            cursor: None,
            interrupt_requested: false,
            auth_failed: false,
            app_thread: conn_contract::to_json(&input.app_thread),
            instance_id: selection["instanceId"]
                .as_str()
                .unwrap_or(DRIVER)
                .to_string(),
            root_model: selection["model"].as_str().unwrap_or("").to_string(),
            pending_steers: Vec::new(),
            steered: false,
            retry: None,
            compaction: None,
            limits: LimitState::default(),
            steered_usage: None,
            had_subagents: false,
        };
        let mut out = Vec::new();
        emit(
            &mut out,
            |v| ProviderEvent::ProviderTurnUpdated {
                thread_id: None,
                provider_turn: v,
            },
            provider_turn(&turn, "running", None, false),
        );
        provider_thread["status"] = json!("active");
        provider_thread["providerSessionId"] = json!(self.provider_session_id);
        provider_thread["updatedAt"] = json!(now);
        emit(
            &mut out,
            |v| ProviderEvent::ProviderThreadUpdated { provider_thread: v },
            provider_thread,
        );
        self.last_ctx = Some(turn.parent_ctx());
        self.turn = Some(turn);
        out
    }

    /// Opens a continuation turn and replays the output held for it.
    pub fn begin_continuation(&mut self, input: &TurnInput, permission_mode: &str) -> Vec<Out> {
        let held: Vec<Inbound> = self.wake.drain(..).collect();
        self.continuation_requested = false;
        let mut out = self.begin_turn(input, permission_mode);
        for frame in held {
            out.extend(self.handle(frame));
        }
        out
    }

    pub fn handle(&mut self, message: Inbound) -> Vec<Out> {
        let mut out = Vec::new();
        if self.turn.is_none() && is_wake_frame(&message) {
            self.hold_wake(message, &mut out);
            return out;
        }
        if let Some(turn) = &mut self.turn {
            accept_echoed_steers(turn, &message, &mut out);
        }
        match message {
            // Subagent text arrives as whole assistant frames; its stream is not shown.
            Inbound::StreamEvent(msg) if msg.parent_tool_use_id.is_some() => {}
            Inbound::StreamEvent(msg) => self.on_stream(msg.event, &mut out),
            Inbound::Assistant(msg) => match msg.parent_tool_use_id.clone() {
                Some(parent) => self.on_child_frame(Inbound::Assistant(msg), &parent, &mut out),
                None => self.on_assistant(msg, &mut out),
            },
            Inbound::User(msg) => match msg.parent_tool_use_id.clone() {
                Some(parent) if !msg.is_replay => {
                    self.on_child_frame(Inbound::User(msg), &parent, &mut out)
                }
                _ => self.on_user(msg, &mut out),
            },
            Inbound::System(msg) => self.on_system(msg, &mut out),
            Inbound::Result(msg) => self.on_result(msg, &mut out),
            Inbound::CommandLifecycle { .. } => {}
            Inbound::RateLimit(info) => self.on_rate_limit(&info, &mut out),
            Inbound::ControlRequest {
                request_id,
                request,
            } => self.on_control_request(request_id, request, &mut out),
            Inbound::ControlCancel { request_id } => self.on_cancel(&request_id, &mut out),
            // Answers to our own requests are routed by the session before the mapper.
            Inbound::ControlResponse { .. } | Inbound::Ignored(_) => {}
            Inbound::Other { kind, .. } => out.push(Out::Skipped(kind)),
        }
        out
    }

    /// Emits streaming updates for text and thinking that changed since the last flush.
    pub fn flush(&mut self) -> Vec<Out> {
        let mut out = Vec::new();
        let Some(turn) = &mut self.turn else {
            return out;
        };
        let now = self.env.now();
        for item_id in turn.stream_order.clone() {
            let Some(stream) = turn.streams.get_mut(&item_id) else {
                continue;
            };
            if !stream.dirty || stream.done || stream.text.is_empty() {
                continue;
            }
            stream.dirty = false;
            let (kind, text, started) =
                (stream.kind, stream.text.clone(), stream.started_at.clone());
            match kind {
                StreamKind::Text => {
                    turn.emitted.insert(item_id.clone());
                    assistant_artifacts(turn, &item_id, &text, "running", &started, &now, &mut out)
                }
                StreamKind::Thinking => {
                    reasoning_item(turn, &item_id, &text, false, &started, &now, &mut out)
                }
            }
        }
        out
    }

    fn on_stream(&mut self, event: StreamEvent, out: &mut Vec<Out>) {
        let now = self.env.now();
        let now_ms = self.env.now_ms();
        let Some(turn) = &mut self.turn else {
            return;
        };
        match event {
            StreamEvent::MessageStart { message } => {
                complete_retry(turn, &now, out);
                turn.message_id = Some(message.id.clone());
                turn.stream_blocks.clear();
                if let Some(usage) = message.usage {
                    turn.usage = Some((message.id, usage, now_ms));
                    let max = context_tokens(
                        &self.context_windows,
                        &turn.root_model,
                        turn.model.as_deref(),
                    );
                    emit_usage(turn, max, &now, out);
                } else {
                    turn.usage = None;
                }
            }
            StreamEvent::MessageDelta { usage: Some(delta) } => {
                if let Some((_, usage, _)) = &mut turn.usage {
                    usage.input_tokens = delta.input_tokens.unwrap_or(usage.input_tokens);
                    usage.cache_creation_input_tokens = delta
                        .cache_creation_input_tokens
                        .or(usage.cache_creation_input_tokens);
                    usage.cache_read_input_tokens = delta
                        .cache_read_input_tokens
                        .or(usage.cache_read_input_tokens);
                    usage.output_tokens = delta.output_tokens.unwrap_or(usage.output_tokens);
                    let max = context_tokens(
                        &self.context_windows,
                        &turn.root_model,
                        turn.model.as_deref(),
                    );
                    emit_usage(turn, max, &now, out);
                }
            }
            StreamEvent::ContentBlockStart {
                index,
                content_block,
            } => {
                let Some(message_id) = turn.message_id.clone() else {
                    return;
                };
                let (kind, initial) = match content_block {
                    Block::Text { text } => (StreamKind::Text, text),
                    Block::Thinking { thinking } => (StreamKind::Thinking, thinking),
                    _ => return,
                };
                let thinking = kind == StreamKind::Thinking;
                let counter = turn
                    .next_block
                    .entry((message_id.clone(), thinking))
                    .or_insert(0);
                let item_id = format!(
                    "{message_id}:{}:{counter}",
                    if thinking { "thinking" } else { "text" }
                );
                *counter += 1;
                ordinal(turn, &item_id);
                turn.stream_blocks.insert(index, item_id.clone());
                turn.stream_order.push(item_id.clone());
                turn.streams.insert(
                    item_id,
                    StreamItem {
                        kind,
                        started_at: now,
                        dirty: !initial.is_empty(),
                        text: initial,
                        done: false,
                    },
                );
            }
            StreamEvent::ContentBlockDelta { index, delta } => {
                let piece = match delta {
                    Delta::TextDelta { text } => text,
                    Delta::ThinkingDelta { thinking } => thinking,
                    Delta::Other => return,
                };
                if let Some(stream) = turn
                    .stream_blocks
                    .get(&index)
                    .and_then(|id| turn.streams.get_mut(id))
                {
                    stream.text.push_str(&piece);
                    stream.dirty |= !piece.is_empty();
                }
            }
            StreamEvent::ContentBlockStop { index } => {
                if let Some(item_id) = turn.stream_blocks.remove(&index) {
                    complete_stream(turn, &item_id, None, "completed", &now, out);
                }
            }
            StreamEvent::MessageDelta { usage: None }
            | StreamEvent::MessageStop
            | StreamEvent::Other => {}
        }
    }

    fn on_assistant(&mut self, msg: AssistantMsg, out: &mut Vec<Out>) {
        let now = self.env.now();
        let now_ms = self.env.now_ms();
        let Some(turn) = &mut self.turn else {
            out.push(Out::Skipped("assistant (no active turn)".into()));
            return;
        };
        let message_id = msg.message.id.clone();
        complete_retry(turn, &now, out);
        let mut agent_launches = Vec::new();
        let mut todos = Vec::new();
        for block in &msg.message.content {
            match block {
                Block::Text { text } => {
                    let item_id = next_snapshot_item(turn, &message_id, false);
                    if turn.streams.contains_key(&item_id) {
                        let final_text = (!text.is_empty()).then_some(text.as_str());
                        complete_stream(turn, &item_id, final_text, "completed", &now, out);
                    } else if !text.is_empty() && turn.emitted.insert(item_id.clone()) {
                        assistant_artifacts(turn, &item_id, text, "completed", &now, &now, out);
                    }
                }
                Block::Thinking { thinking } => {
                    let item_id = next_snapshot_item(turn, &message_id, true);
                    if turn.streams.contains_key(&item_id) {
                        let final_text = (!thinking.is_empty()).then_some(thinking.as_str());
                        complete_stream(turn, &item_id, final_text, "completed", &now, out);
                    } else if !thinking.trim().is_empty() {
                        reasoning_item(turn, &item_id, thinking, true, &now, &now, out);
                    }
                }
                Block::ToolUse { id, name, input } if name == "Agent" => {
                    agent_launches.push((id.clone(), input.clone()));
                }
                Block::ToolUse { id, name, input } => {
                    if name == "TodoWrite" {
                        todos.push((id.clone(), notices::todo_steps(input)));
                    }
                    start_tool(turn, id, name, input, &now, out);
                }
                Block::ToolResult { .. } | Block::Other => {}
            }
        }
        let model = msg.message.model.as_deref().unwrap_or("");
        if !model.is_empty() && model != "<synthetic>" {
            turn.model = Some(model.to_string());
            if !turn.models.iter().any(|m| m == model) {
                turn.models.push(model.to_string());
            }
        }
        turn.cursor = Some(msg.uuid.clone());
        if msg.error.as_deref() == Some("authentication_failed") {
            turn.auth_failed = true;
        }
        turn.limits.assistant = blocked_assistant_limit(&msg);
        if let Some(usage) = msg.message.usage.filter(|_| model != "<synthetic>") {
            let same = turn
                .usage
                .as_ref()
                .is_some_and(|(id, _, _)| *id == message_id);
            if !same {
                turn.usage = Some((message_id, usage, now_ms));
                let max = context_tokens(
                    &self.context_windows,
                    &turn.root_model,
                    turn.model.as_deref(),
                );
                emit_usage(turn, max, &now, out);
            }
        }
        for (id, input) in agent_launches {
            self.remember_agent_launch(&id, &input, None);
        }
        for (id, steps) in todos {
            self.emit_todo_list(&id, steps, out);
        }
    }

    fn on_user(&mut self, msg: UserMsg, out: &mut Vec<Out>) {
        let now = self.env.now();
        if msg.is_replay || self.turn.is_none() {
            return;
        }
        let UserContent::Blocks(blocks) = &msg.message.content else {
            return;
        };
        let results: Vec<(String, Value, bool)> = blocks
            .iter()
            .filter_map(|b| match b {
                Block::ToolResult {
                    tool_use_id,
                    content,
                    is_error,
                } => Some((tool_use_id.clone(), content.clone(), *is_error)),
                _ => None,
            })
            .collect();
        let single = results.len() == 1;
        let mut task_updates = Vec::new();
        for (tool_use_id, content, is_error) in results {
            let structured = if single {
                msg.tool_use_result.as_ref()
            } else {
                None
            };
            if self.settle_agent_result(&tool_use_id, &content, is_error, structured, out) {
                continue;
            }
            let Some(turn) = self.turn.as_mut() else {
                return;
            };
            let Some(call) = turn.tools.remove(&tool_use_id) else {
                continue;
            };
            turn.tool_order.retain(|id| *id != tool_use_id);
            let kind = msg
                .tool_result_meta
                .iter()
                .flatten()
                .find(|m| m.id == tool_use_id)
                .and_then(|m| m.non_execution_kind.clone());
            let status = match kind.as_deref() {
                Some("cancelled") => "cancelled",
                Some("interrupted") => "interrupted",
                _ if is_error => "failed",
                _ => "completed",
            };
            if kind.is_none()
                && !is_error
                && matches!(call.name.as_str(), "TaskCreate" | "TaskUpdate" | "TaskList")
            {
                let result = structured.cloned().unwrap_or_else(|| match &content {
                    Value::Array(parts) => json!(
                        parts
                            .iter()
                            .filter_map(|p| p.get("text").and_then(Value::as_str))
                            .collect::<Vec<_>>()
                            .join("\n")
                    ),
                    other => other.clone(),
                });
                task_updates.push((call.name.clone(), call.input.clone(), result));
            }
            let output = tool_output(&call.name, structured, &content);
            tool_artifacts(
                &turn.scope(),
                &tool_use_id,
                &call,
                status,
                output,
                kind.as_deref(),
                &now,
                out,
            );
        }
        for (tool, input, result) in task_updates {
            self.apply_task_tool(&tool, &input, &result, out);
        }
    }

    fn on_system(&mut self, msg: SystemMsg, out: &mut Vec<Out>) {
        match msg.subtype.as_str() {
            "task_started" => return self.on_task_started(&msg, out),
            "task_progress" => return self.on_task_progress(&msg, out),
            "task_notification" => {
                self.on_task_notification(&msg, out);
                return;
            }
            _ => {}
        }
        let now = self.env.now();
        let max_tokens = |turn: &Turn, windows: &HashMap<String, u64>| {
            context_tokens(windows, &turn.root_model, turn.model.as_deref())
        };
        let Some(turn) = &mut self.turn else {
            return;
        };
        match msg.subtype.as_str() {
            "init" => {
                if let Some(mode) = msg.permission_mode {
                    turn.permission_mode = mode;
                }
            }
            "status" if msg.status.as_ref().and_then(Value::as_str) == Some("compacting") => {
                if turn
                    .compaction
                    .as_ref()
                    .is_some_and(|c| c["status"] == "running")
                {
                    return;
                }
                let id = msg.uuid.unwrap_or_default();
                let mut item = notice_base(turn, &id, &now, "running");
                item["type"] = json!("compaction");
                item["driver"] = json!(DRIVER);
                item["title"] = json!("Compacting context");
                item["completedAt"] = Value::Null;
                turn.compaction = Some(item.clone());
                out.push(turn_item(item));
            }
            "status"
                if msg.compact_result.is_some()
                    || (msg.status.as_ref().is_none_or(Value::is_null)
                        && msg.permission_mode.is_none()) =>
            {
                let Some(mut item) = turn.compaction.take() else {
                    return;
                };
                let (status, title) = match msg.compact_result.as_deref() {
                    Some("success") => ("completed", "Context compacted"),
                    Some("failed") if !turn.interrupt_requested => {
                        ("failed", "Context compaction failed")
                    }
                    _ => ("interrupted", "Context compaction stopped"),
                };
                item["status"] = json!(status);
                item["title"] = json!(title);
                if status == "failed"
                    && let Some(error) = &msg.compact_error
                {
                    item["summary"] = json!(error);
                }
                item["completedAt"] = json!(now);
                item["updatedAt"] = json!(now);
                if status == "completed" {
                    turn.compaction = Some(item.clone());
                }
                out.push(turn_item(item));
            }
            "compact_boundary" => {
                let id = msg.uuid.unwrap_or_default();
                let meta = msg.compact_metadata.unwrap_or(Value::Null);
                let mut item = match turn.compaction.take() {
                    Some(running) if running["status"] == "running" => running,
                    _ => {
                        let mut item = notice_base(turn, &id, &now, "completed");
                        item["type"] = json!("compaction");
                        item["driver"] = json!(DRIVER);
                        item
                    }
                };
                item["status"] = json!("completed");
                item["title"] = json!("Context compacted");
                if item["completedAt"].is_null() {
                    item["completedAt"] = json!(now);
                }
                item["updatedAt"] = json!(now);
                if let Some(pre) = meta.get("pre_tokens").filter(|v| v.is_number()) {
                    item["beforeTokenCount"] = pre.clone();
                }
                if let Some(post) = meta.get("post_tokens").and_then(Value::as_f64)
                    && post > 0.0
                {
                    let after = post.round() as u64;
                    item["afterTokenCount"] = json!(after);
                    let mut provider_turn = provider_turn(turn, "running", None, false);
                    provider_turn["tokenUsage"] = json!({
                        "usedTokens": after,
                        "maxTokens": max_tokens(turn, &self.context_windows),
                        "updatedAt": now,
                    });
                    emit(
                        out,
                        |v| ProviderEvent::ProviderTurnUpdated {
                            thread_id: Some(turn.thread_id.as_str().into()),
                            provider_turn: v,
                        },
                        provider_turn,
                    );
                }
                turn.usage = None;
                out.push(turn_item(item));
            }
            "informational" | "model_refusal_fallback" if msg.level.as_deref() != Some("info") => {
                let text = msg
                    .content
                    .as_ref()
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                if text.starts_with("Stop says: ") || text.is_empty() {
                    return;
                }
                let id = msg.uuid.unwrap_or_default();
                let mut item = notice_base(turn, &id, &now, "completed");
                item["type"] = json!("system_notice");
                item["title"] = json!(text);
                item["message"] = json!(text);
                out.push(turn_item(item));
            }
            "api_retry" => {
                let retry = json!({
                    "attempt": msg.attempt.map_or(1, |a| (a.trunc() as i64).max(1)),
                    "maxAttempts": msg.max_retries.map_or(1, |a| (a.trunc() as i64).max(1)),
                    "retryDelayMs": msg.retry_delay_ms.map_or(0, |a| (a.trunc() as i64).max(0)),
                });
                let native = format!("terminal-failure:{}", turn.provider_turn_id);
                let ordinal = match &turn.retry {
                    Some(previous) => previous.ordinal,
                    None => ordinal(turn, &native),
                };
                let state = RetryState {
                    retry,
                    failure: notices::api_retry_failure(&msg),
                    started_at: turn
                        .retry
                        .as_ref()
                        .map_or(now.clone(), |r| r.started_at.clone()),
                    ordinal,
                };
                out.push(turn_item(notices::retry_item(
                    turn, &state, "running", &now,
                )));
                turn.retry = Some(state);
            }
            _ => {}
        }
    }

    fn on_result(&mut self, msg: ResultMsg, out: &mut Vec<Out>) {
        // A result that reports a context window not seen before refreshes the usage row.
        let mut new_window = false;
        if let Some(Value::Object(models)) = &msg.model_usage {
            for (model, usage) in models.iter().take(16) {
                if let Some(window) = usage.get("contextWindow").and_then(Value::as_u64)
                    && window > 0
                    && (self.context_windows.len() < 16 || self.context_windows.contains_key(model))
                {
                    new_window |=
                        self.context_windows.insert(model.clone(), window) != Some(window);
                }
            }
        }
        let now = self.env.now();
        let Some(turn) = &mut self.turn else {
            out.push(Out::Skipped("result (no active turn)".into()));
            return;
        };
        if new_window && turn.usage.is_some() {
            let max = context_tokens(
                &self.context_windows,
                &turn.root_model,
                turn.model.as_deref(),
            );
            emit_usage(turn, max, &now, out);
        }
        let steer_abort = matches!(
            msg.terminal_reason.as_deref(),
            Some("aborted_streaming" | "aborted_tools")
        );
        if turn.steered && !turn.interrupt_requested && steer_abort {
            if let Some(usage) = &msg.usage {
                turn.steered_usage = Some(match turn.steered_usage.take() {
                    Some(sum) => sum.plus(usage),
                    None => usage.clone(),
                });
            }
            // A steer cut this segment short; the turn goes on with the steer.
            for item_id in turn.stream_order.clone() {
                complete_stream(turn, &item_id, None, "interrupted", &now, out);
            }
            return;
        }
        let auth_hint = turn.auth_failed.then_some(AUTH_FAILED_TEXT);
        let usage_limited = auth_hint.is_none()
            && (!turn.limits.rejected.is_empty() || turn.limits.assistant.is_some())
            && (msg.subtype != "success" || matches!(msg.api_error_status, None | Some(429)))
            && matches!(
                msg.terminal_reason.as_deref(),
                None | Some("api_error" | "blocking_limit")
            );
        let hint = if msg.api_error_status == Some(403) {
            msg.result.clone()
        } else {
            auth_hint.map(str::to_string).or_else(|| {
                usage_limited.then(|| {
                    "Claude usage limit reached. Send the message again once the limit resets."
                        .to_string()
                })
            })
        };
        let (status, failure) = if turn.interrupt_requested {
            (TurnStatus::Interrupted, None)
        } else {
            let status = notices::result_status(&msg, hint.as_deref());
            let failure = (status == TurnStatus::Failed).then(|| {
                let mut failure = notices::result_failure(&msg, hint.as_deref(), usage_limited)
                    .unwrap_or_else(|| notices::failure("provider_error", "", None, None));
                if failure["class"] == "usage_limit" {
                    failure["resetAt"] = json!(usage_reset_at(&turn.limits));
                }
                failure
            });
            (status, failure)
        };
        self.finalize(status, failure, Some(&msg), out);
    }

    /// The CLI exited. Ends a running turn as failed (or interrupted when we stopped it).
    pub fn on_exit(&mut self, expected: bool, detail: &str) -> Vec<Out> {
        let mut out = Vec::new();
        self.cancel_all_pending(&mut out);
        let stopped = expected || self.turn.as_ref().is_some_and(|t| t.interrupt_requested);
        self.end_running_subagents(if stopped { "cancelled" } else { "failed" }, &mut out);
        self.wake.clear();
        self.continuation_requested = false;
        let Some(turn) = &self.turn else {
            return out;
        };
        if expected || turn.interrupt_requested {
            self.finalize(TurnStatus::Interrupted, None, None, &mut out);
        } else {
            let failure = json!({
                "class": "transport_error",
                "message": detail,
                "code": "claude_process_exited",
                "retryable": true,
            });
            self.finalize(TurnStatus::Failed, Some(failure), None, &mut out);
        }
        out
    }

    fn finalize(
        &mut self,
        status: TurnStatus,
        failure: Option<Value>,
        result: Option<&ResultMsg>,
        out: &mut Vec<Out>,
    ) {
        // Requests the CLI never resolved end with their turn.
        self.cancel_all_pending(out);
        let now = self.env.now();
        let Some(mut turn) = self.turn.take() else {
            return;
        };
        let completed = status == TurnStatus::Completed;
        let status_text = turn_status_text(status);
        for item_id in turn.stream_order.clone() {
            let item_status = if completed {
                "completed"
            } else {
                "interrupted"
            };
            complete_stream(&mut turn, &item_id, None, item_status, &now, out);
        }
        let tool_status = if completed { "failed" } else { status_text };
        for id in std::mem::take(&mut turn.tool_order) {
            if let Some(call) = turn.tools.remove(&id) {
                tool_artifacts(
                    &turn.scope(),
                    &id,
                    &call,
                    tool_status,
                    None,
                    None,
                    &now,
                    out,
                );
            }
        }
        for (_, message_id) in std::mem::take(&mut turn.pending_steers) {
            let steer = if completed {
                SteerStatus::Completed
            } else {
                SteerStatus::Cancelled
            };
            out.push(steer_event(&turn, &message_id, steer));
        }
        let mut retry = None;
        if let Some(state) = turn.retry.take() {
            if status == TurnStatus::Failed {
                retry = from_json(state.retry).ok();
            } else {
                out.push(turn_item(notices::retry_item(
                    &turn,
                    &state,
                    status_text,
                    &now,
                )));
            }
        }
        if let Some(compaction) = turn.compaction.take()
            && compaction["status"] == "running"
        {
            let mut item = compaction;
            item["status"] = json!("interrupted");
            item["title"] = json!("Context compaction stopped");
            item["completedAt"] = json!(now);
            item["updatedAt"] = json!(now);
            out.push(turn_item(item));
        }
        let mut provider_turn = provider_turn(&turn, status_text, Some(&now), true);
        // A steer's cut-off segment counts towards the turn.
        let usage = match (
            turn.steered_usage.take(),
            result.and_then(|r| r.usage.clone()),
        ) {
            (Some(steered), Some(last)) => Some(steered.plus(&last)),
            (steered, last) => last.or(steered),
        };
        provider_turn["turnTokenUsage"] = turn_token_usage(
            &turn.models,
            result,
            usage.as_ref(),
            completed,
            turn.had_subagents || self.subagents.any_running(),
        );
        emit(
            out,
            |v| ProviderEvent::ProviderTurnUpdated {
                thread_id: None,
                provider_turn: v,
            },
            provider_turn,
        );
        let mut thread = turn.provider_thread.clone();
        thread["providerSessionId"] = json!(self.provider_session_id);
        if thread.get("firstRunOrdinal").is_none_or(Value::is_null) {
            thread["firstRunOrdinal"] = json!(turn.run_ordinal);
        }
        thread["lastRunOrdinal"] = json!(turn.run_ordinal);
        thread["pendingBackgroundTasks"] = json!([]);
        // A turn that wrote to the transcript moved past a rollback's pinned head.
        if completed || turn.cursor.is_some() {
            thread["nativeConversationHeadRef"] = Value::Null;
        }
        thread["status"] = json!(if completed { "active" } else { "idle" });
        thread["updatedAt"] = json!(now);
        emit(
            out,
            |v| ProviderEvent::ProviderThreadUpdated { provider_thread: v },
            thread,
        );
        out.push(event(ProviderEvent::TurnTerminal(TurnTerminal {
            provider_thread_id: turn.provider_thread_id.as_str().into(),
            provider_turn_id: turn.provider_turn_id.as_str().into(),
            run_ordinal: turn.run_ordinal,
            status,
            failure: failure.and_then(|f| from_json(f).ok()),
            retry,
            thread_disposition: ThreadDisposition::Reusable,
        })));
    }

    // ---- Requests from the CLI ----

    fn on_control_request(&mut self, cli_id: String, request: ControlRequest, out: &mut Vec<Out>) {
        match request {
            ControlRequest::CanUseTool(req) => self.on_can_use_tool(cli_id, req, out),
            // T3 registers no hooks without device tools; answer like an empty hook.
            ControlRequest::HookCallback { .. } => {
                out.push(Out::Write(control_success(&cli_id, json!({}))))
            }
            ControlRequest::Elicitation(req) => self.on_elicitation(cli_id, req, out),
            ControlRequest::UserDialog(req) => self.on_user_dialog(cli_id, req, out),
            ControlRequest::Other { subtype } => {
                out.push(Out::Write(control_error(
                    &cli_id,
                    &format!("Unsupported control request subtype: {subtype}"),
                )));
                out.push(Out::Skipped(format!("control_request/{subtype}")));
            }
        }
    }

    fn on_can_use_tool(&mut self, cli_id: String, req: CanUseTool, out: &mut Vec<Out>) {
        let now = self.env.now();
        let tool_use_id = req.tool_use_id.clone();
        let Some(turn) = &mut self.turn else {
            let deny = json!({
                "behavior": "deny",
                "message": "Claude V2 adapter has no active turn for this tool request.",
                "toolUseID": tool_use_id,
            });
            out.push(Out::Write(control_success(&cli_id, deny)));
            return;
        };
        if req.tool_name != "Agent"
            && req.tool_name != "AskUserQuestion"
            && !self.subagents.owns_tool(&tool_use_id)
        {
            start_tool(turn, &tool_use_id, &req.tool_name, &req.input, &now, out);
        }
        if req.tool_name == "AskUserQuestion" {
            let questions = user_input_questions(&req.input);
            let thread_id = turn.thread_id.clone();
            let root = turn.root_node_id.clone();
            let artifacts = self.request_artifacts(
                &tool_use_id,
                &tool_use_id,
                "user_input",
                Some(root),
                RequestBody::Questions(questions),
                &now,
            );
            self.open_request(
                cli_id,
                PendingKind::Question {
                    tool_use_id,
                    input: req.input,
                },
                artifacts,
                thread_id,
                out,
            );
            return;
        }
        if req.tool_name == "ExitPlanMode" {
            if let Some(plan) = req
                .input
                .get("plan")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|p| !p.is_empty())
            {
                let plan = plan.to_string();
                self.proposed_plan(&tool_use_id, &plan, &now, out);
            }
            let deny = json!({
                "behavior": "deny",
                "message": "The client captured your proposed plan. Stop here and wait for the user's feedback or implementation request in a later turn.",
                "toolUseID": tool_use_id,
            });
            out.push(Out::Write(control_success(&cli_id, deny)));
            return;
        }
        let asks = self
            .policy_asks
            .unwrap_or_else(|| launch::asks_user_mode(&turn.permission_mode));
        if !asks {
            let allow =
                json!({"behavior": "allow", "updatedInput": req.input, "toolUseID": tool_use_id});
            out.push(Out::Write(control_success(&cli_id, allow)));
            return;
        }
        let command = req
            .input
            .get("command")
            .and_then(Value::as_str)
            .filter(|c| !c.trim().is_empty());
        let prompt = command
            .map(str::to_string)
            .or(req.title.clone())
            .or(req.description.clone())
            .or(req.decision_reason.clone())
            .unwrap_or_else(|| req.tool_name.clone());
        let kind = classify_tool(&req.tool_name).1;
        let thread_id = turn.thread_id.clone();
        let artifacts = self.request_artifacts(
            &tool_use_id,
            &tool_use_id,
            kind,
            None,
            RequestBody::Approval {
                prompt,
                options: None,
                app_name: None,
            },
            &now,
        );
        self.open_request(
            cli_id,
            PendingKind::Approval {
                tool_name: req.tool_name,
                input: req.input,
                tool_use_id,
                suggestions: req.permission_suggestions,
            },
            artifacts,
            thread_id,
            out,
        );
    }

    fn on_elicitation(&mut self, cli_id: String, req: Elicitation, out: &mut Vec<Out>) {
        let now = self.env.now();
        if self.turn.is_none() || elicitation_acceptance(&req).is_none() {
            out.push(Out::Write(control_success(
                &cli_id,
                json!({"action": "decline"}),
            )));
            return;
        }
        let native_id = format!("mcp-elicitation:{cli_id}");
        let Some(thread_id) = self.turn.as_ref().map(|t| t.thread_id.clone()) else {
            return;
        };
        let options = json!([
            {"decision": "cancel", "label": "Cancel"},
            {"decision": "decline", "label": "Decline"},
            {"decision": "acceptForSession", "label": "Always allow this session"},
            {"decision": "accept", "label": "Approve"},
        ]);
        let app_name = req
            .display_name
            .clone()
            .or(req.title.clone())
            .unwrap_or(req.mcp_server_name.clone());
        let artifacts = self.request_artifacts(
            &native_id,
            &native_id,
            "mcp-elicitation",
            None,
            RequestBody::Approval {
                prompt: req.message,
                options: Some(options),
                app_name: Some(app_name),
            },
            &now,
        );
        self.open_request(cli_id, PendingKind::Elicitation, artifacts, thread_id, out);
    }

    fn on_user_dialog(&mut self, cli_id: String, req: UserDialog, out: &mut Vec<Out>) {
        let now = self.env.now();
        let Some(turn) = &self.turn else {
            out.push(Out::Write(control_success(
                &cli_id,
                json!({"behavior": "cancelled"}),
            )));
            return;
        };
        if req.dialog_kind != "resume_return" {
            out.push(Out::Write(control_success(
                &cli_id,
                json!({"behavior": "cancelled"}),
            )));
            return;
        }
        let minutes = req
            .payload
            .get("sessionAgeMinutes")
            .and_then(Value::as_f64)
            .unwrap_or(0.0)
            .max(0.0) as u64;
        let tokens = req
            .payload
            .get("estimatedTokens")
            .and_then(Value::as_f64)
            .unwrap_or(0.0)
            .max(0.0) as u64;
        // `formatClaudeResumeCompactionQuestion` lives in TS; this is a plain-language stand-in.
        let question = format!(
            "This session has been idle for {minutes} minutes and holds about {tokens} tokens. Compact it before resuming?"
        );
        let questions = json!([{
            "id": question,
            "header": "Resume session",
            "question": question,
            "options": [
                {"label": RESUME_COMPACT_ANSWER, "description": "Resume with a summary and use fewer tokens."},
                {"label": "Keep full history", "description": "Resume without changing the conversation."},
                {"label": RESUME_NEVER_ANSWER, "description": "Keep full history and skip future resume prompts."},
            ],
            "multiSelect": false,
        }]);
        let native_id = req.tool_use_id.unwrap_or(cli_id.clone());
        let root = turn.root_node_id.clone();
        let thread_id = turn.thread_id.clone();
        let artifacts = self.request_artifacts(
            &native_id,
            &native_id,
            "user_input",
            Some(root),
            RequestBody::Questions(questions),
            &now,
        );
        self.open_request(
            cli_id,
            PendingKind::ResumeDialog { question },
            artifacts,
            thread_id,
            out,
        );
    }

    fn on_cancel(&mut self, cli_id: &str, out: &mut Vec<Out>) {
        let Some(request_id) = self
            .pending
            .iter()
            .find(|(_, p)| p.cli_request_id == cli_id)
            .map(|(id, _)| id.clone())
        else {
            return;
        };
        let Some(pending) = self.pending.remove(&request_id) else {
            return;
        };
        self.emit_cancelled(&pending, out);
        // The SDK still answers a withdrawn request, as if the user cancelled it.
        out.push(Out::Write(control_success(
            cli_id,
            cancel_answer(&pending.kind),
        )));
    }

    fn cancel_all_pending(&mut self, out: &mut Vec<Out>) {
        let mut pending: Vec<_> = self.pending.drain().collect();
        pending.sort_by(|a, b| a.0.cmp(&b.0));
        for (_, p) in pending {
            self.emit_cancelled(&p, out);
        }
    }

    fn emit_cancelled(&mut self, pending: &Pending, out: &mut Vec<Out>) {
        let now = self.env.now();
        let mut request = pending.request.clone();
        request["status"] = json!("cancelled");
        request["resolvedAt"] = json!(now);
        emit(
            out,
            |v| ProviderEvent::RuntimeRequestUpdated {
                thread_id: Some(pending.thread_id.as_str().into()),
                runtime_request: v,
            },
            request,
        );
        let mut node = pending.node.clone();
        node["status"] = json!("cancelled");
        node["completedAt"] = json!(now);
        emit(out, |v| ProviderEvent::NodeUpdated { node: v }, node);
        let mut item = pending.item.clone();
        item["status"] = json!("cancelled");
        item["completedAt"] = json!(now);
        item["updatedAt"] = json!(now);
        out.push(turn_item(item));
    }

    /// Answers a runtime request the user resolved. Returns the CLI reply.
    pub fn respond(
        &mut self,
        response: &RuntimeRequestResponse,
    ) -> Result<Vec<Out>, ProviderError> {
        let request_id = response.request_id.as_str().to_string();
        let Some(pending) = self.pending.remove(&request_id) else {
            return Err(ProviderError::Protocol {
                detail: format!("No pending Claude runtime request {request_id}."),
            });
        };
        let decision = response
            .decision
            .as_ref()
            .map(conn_contract::to_json)
            .and_then(|v| v.as_str().map(str::to_string));
        let answers = response
            .answers
            .as_ref()
            .map(conn_contract::to_json)
            .unwrap_or_else(|| json!({}));
        let reply = match &pending.kind {
            PendingKind::Approval {
                tool_name,
                input,
                tool_use_id,
                suggestions,
            } => {
                let Some(decision) = decision else {
                    self.pending.insert(request_id.clone(), pending);
                    return Err(ProviderError::Protocol {
                        detail: format!(
                            "Claude request {request_id} requires an approval decision."
                        ),
                    });
                };
                permission_result(
                    tool_name,
                    &decision,
                    input,
                    tool_use_id,
                    suggestions.as_ref(),
                    response.feedback.as_deref(),
                )
            }
            PendingKind::Question { tool_use_id, input } => json!({
                "behavior": "allow",
                "updatedInput": {
                    "questions": input.get("questions").cloned().unwrap_or(Value::Null),
                    "answers": sdk_answers(&answers),
                },
                "toolUseID": tool_use_id,
            }),
            PendingKind::Elicitation => match decision.as_deref() {
                Some("accept" | "acceptForSession" | "acceptAlways") => {
                    json!({"action": "accept", "content": {}})
                }
                Some("cancel") => json!({"action": "cancel"}),
                _ => json!({"action": "decline"}),
            },
            PendingKind::ResumeDialog { question } => {
                let picked = sdk_answers(&answers)
                    .get(question)
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let result = match picked.as_str() {
                    RESUME_COMPACT_ANSWER => "compact",
                    RESUME_NEVER_ANSWER => "never",
                    _ => "continue",
                };
                json!({"behavior": "completed", "result": result})
            }
        };
        Ok(vec![Out::Write(control_success(
            &pending.cli_request_id,
            reply,
        ))])
    }

    fn open_request(
        &mut self,
        cli_request_id: String,
        kind: PendingKind,
        artifacts: Option<(Value, Value, Value)>,
        thread_id: String,
        out: &mut Vec<Out>,
    ) {
        let Some((node, request, item)) = artifacts else {
            out.push(Out::Write(control_error(
                &cli_request_id,
                "Claude asked with no turn running.",
            )));
            return;
        };
        emit(
            out,
            |v| ProviderEvent::NodeUpdated { node: v },
            node.clone(),
        );
        emit(
            out,
            |v| ProviderEvent::RuntimeRequestUpdated {
                thread_id: None,
                runtime_request: v,
            },
            request.clone(),
        );
        out.push(turn_item(item.clone()));
        let id = str_of(&request, "id");
        self.pending.insert(
            id,
            Pending {
                cli_request_id,
                kind,
                request,
                node,
                item,
                thread_id,
            },
        );
    }

    fn request_artifacts(
        &mut self,
        native_item_id: &str,
        native_request_id: &str,
        request_kind: &str,
        parent_node_id: Option<String>,
        body: RequestBody,
        now: &str,
    ) -> Option<(Value, Value, Value)> {
        let uuid = self.env.uuid();
        let turn = self.turn.as_mut()?;
        let request_id =
            ids::runtime_request_id(DRIVER, &turn.provider_turn_id, native_request_id, &uuid);
        let node_id = ids::approval_node(&request_id);
        let item_ordinal = ordinal(
            turn,
            &format!("{native_item_id}:approval:{native_request_id}"),
        );
        let native_ref =
            json!({"driver": DRIVER, "nativeId": native_request_id, "strength": "strong"});
        let questions = matches!(body, RequestBody::Questions(_));
        let node = json!({
            "id": node_id,
            "threadId": turn.thread_id,
            "runId": turn.run_id,
            "parentNodeId": parent_node_id.unwrap_or_else(|| ids::node_from_item(DRIVER, native_item_id)),
            "rootNodeId": turn.root_node_id,
            "kind": if questions { "user_input_request" } else { "approval_request" },
            "status": "waiting",
            "countsForRun": false,
            "providerThreadId": turn.provider_thread_id,
            "providerTurnId": turn.provider_turn_id,
            "nativeItemRef": native_ref,
            "runtimeRequestId": request_id,
            "checkpointScopeId": null,
            "startedAt": now,
            "completedAt": null,
        });
        let mut capability = json!({"type": "live", "providerSessionId": self.provider_session_id});
        if !questions && request_kind != "mcp-elicitation" {
            capability["supportsFeedback"] = json!(true);
        }
        let request = json!({
            "id": request_id,
            "nodeId": node_id,
            "providerTurnId": turn.provider_turn_id,
            "nativeRequestRef": native_ref,
            "kind": request_kind,
            "status": "pending",
            "responseCapability": capability,
            "createdAt": now,
            "resolvedAt": null,
        });
        let mut item = json!({
            "id": ids::approval_turn_item(&request_id),
            "threadId": turn.thread_id,
            "runId": turn.run_id,
            "nodeId": node_id,
            "providerThreadId": turn.provider_thread_id,
            "providerTurnId": turn.provider_turn_id,
            "nativeItemRef": native_ref,
            "parentItemId": null,
            "ordinal": item_ordinal,
            "status": "waiting",
            "title": null,
            "startedAt": now,
            "completedAt": null,
            "updatedAt": now,
        });
        match body {
            RequestBody::Questions(questions) => {
                item["type"] = json!("user_input_request");
                item["requestId"] = json!(request_id);
                item["questions"] = questions;
            }
            RequestBody::Approval {
                prompt,
                options,
                app_name,
            } => {
                item["type"] = json!("approval_request");
                item["requestId"] = json!(request_id);
                item["requestKind"] = json!(request_kind);
                item["prompt"] = json!(prompt);
                if let Some(app_name) = app_name {
                    item["appName"] = json!(app_name);
                }
                if let Some(options) = options {
                    item["options"] = options;
                }
            }
        }
        Some((node, request, item))
    }

    fn proposed_plan(&mut self, tool_use_id: &str, markdown: &str, now: &str, out: &mut Vec<Out>) {
        let uuid = self.env.uuid();
        let Some(turn) = self.turn.as_mut() else {
            return;
        };
        let native = format!("proposed_plan:{tool_use_id}");
        let plan_id = ids::plan_id(&turn.thread_id, Some(&turn.run_id), DRIVER, &uuid);
        let node_id = ids::node_from_item(DRIVER, &native);
        let native_ref = json!({"driver": DRIVER, "nativeId": tool_use_id, "strength": "strong"});
        let item_ordinal = ordinal(turn, &native);
        let node = json!({
            "id": node_id, "threadId": turn.thread_id, "runId": turn.run_id,
            "parentNodeId": turn.root_node_id, "rootNodeId": turn.root_node_id,
            "kind": "plan", "status": "completed", "countsForRun": false,
            "providerThreadId": turn.provider_thread_id, "providerTurnId": turn.provider_turn_id,
            "nativeItemRef": native_ref, "runtimeRequestId": null, "checkpointScopeId": null,
            "startedAt": now, "completedAt": now,
        });
        let plan = json!({
            "id": plan_id, "threadId": turn.thread_id, "runId": turn.run_id, "nodeId": node_id,
            "kind": "proposed_plan", "status": "active", "markdown": markdown,
        });
        let item = json!({
            "id": ids::turn_item_from_item(DRIVER, &native), "threadId": turn.thread_id,
            "runId": turn.run_id, "nodeId": node_id,
            "providerThreadId": turn.provider_thread_id, "providerTurnId": turn.provider_turn_id,
            "nativeItemRef": native_ref, "parentItemId": null, "ordinal": item_ordinal,
            "status": "completed", "title": null, "startedAt": now, "completedAt": now,
            "updatedAt": now, "type": "proposed_plan", "planId": plan_id, "markdown": markdown,
            "streaming": false,
        });
        emit(out, |v| ProviderEvent::NodeUpdated { node: v }, node);
        emit(out, |v| ProviderEvent::PlanUpdated { plan: v }, plan);
        out.push(turn_item(item));
    }
}

enum RequestBody {
    Questions(Value),
    Approval {
        prompt: String,
        options: Option<Value>,
        app_name: Option<String>,
    },
}

fn event(event: ProviderEvent) -> Out {
    Out::Event(event)
}

fn turn_item(item: Value) -> Out {
    match from_json(item) {
        Ok(turn_item) => event(ProviderEvent::TurnItemUpdated { turn_item }),
        Err(error) => Out::Skipped(format!("invalid turn item: {error}")),
    }
}

/// Builds an event from a JSON row. Rows carry CLI values, so a row the contract rejects is
/// skipped and logged rather than allowed to stop the server.
fn emit<T: serde::de::DeserializeOwned>(
    out: &mut Vec<Out>,
    make: impl FnOnce(T) -> ProviderEvent,
    value: Value,
) {
    match from_json(value) {
        Ok(typed) => out.push(event(make(typed))),
        Err(error) => out.push(Out::Skipped(format!("invalid event row: {error}"))),
    }
}

fn str_of(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn turn_status_text(status: TurnStatus) -> &'static str {
    match status {
        TurnStatus::Completed => "completed",
        TurnStatus::Interrupted => "interrupted",
        TurnStatus::Cancelled => "cancelled",
        TurnStatus::Failed => "failed",
    }
}

/// `resolveItemOrdinal`: turn ordinal × 100 + first-seen order.
fn ordinal(turn: &mut Turn, native_item_id: &str) -> u32 {
    let next = turn.turn_ordinal * 100 + turn.ordinals.len() as u32 + 1;
    *turn
        .ordinals
        .entry(native_item_id.to_string())
        .or_insert(next)
}

fn next_snapshot_item(turn: &mut Turn, message_id: &str, thinking: bool) -> String {
    let counter = turn
        .snapshot_block
        .entry((message_id.to_string(), thinking))
        .or_insert(0);
    let id = format!(
        "{message_id}:{}:{counter}",
        if thinking { "thinking" } else { "text" }
    );
    *counter += 1;
    id
}

fn provider_turn(turn: &Turn, status: &str, completed_at: Option<&str>, settled: bool) -> Value {
    let native_id = if settled {
        turn.cursor.clone().unwrap_or(turn.native_turn_id.clone())
    } else {
        turn.native_turn_id.clone()
    };
    let mut value = json!({
        "id": turn.provider_turn_id,
        "providerThreadId": turn.provider_thread_id,
        "nodeId": turn.root_node_id,
        "runAttemptId": turn.attempt_id,
        "nativeTurnRef": {"driver": DRIVER, "nativeId": native_id, "strength": "weak"},
        "ordinal": turn.turn_ordinal,
        "status": status,
        "startedAt": turn.started_at,
        "completedAt": completed_at,
    });
    if let Some(model) = &turn.model {
        value["model"] = json!(model);
    }
    value
}

/// `emitContextUsage` → `provider_turn.updated` with `tokenUsage`.
fn emit_usage(turn: &Turn, max_tokens: u64, now: &str, out: &mut Vec<Out>) {
    let Some((_, usage, requested_ms)) = &turn.usage else {
        return;
    };
    let input = usage.input_total();
    if input == 0 {
        return;
    }
    let mut token_usage = json!({
        "usedTokens": input + usage.output_tokens,
        "maxTokens": max_tokens,
        "inputTokens": input,
        "cachedInputTokens": usage.cache_read_input_tokens.unwrap_or(0),
        "outputTokens": usage.output_tokens,
        "reasoningOutputTokens": 0,
    });
    let ttl = usage.cache_creation.as_ref().and_then(|c| {
        if c.ephemeral_1h_input_tokens > 0 {
            Some(3_600_000)
        } else if c.ephemeral_5m_input_tokens > 0 {
            Some(300_000)
        } else {
            None
        }
    });
    if let Some(ttl) = ttl {
        token_usage["promptCacheTtlMs"] = json!(ttl);
        token_usage["promptCacheExpiresAt"] = json!(ids::iso_from_ms(requested_ms + ttl));
    }
    token_usage["updatedAt"] = json!(now);
    let mut provider_turn = provider_turn(turn, "running", None, false);
    provider_turn["nativeTurnRef"]["strength"] = json!("strong");
    provider_turn["tokenUsage"] = token_usage;
    emit(
        out,
        |v| ProviderEvent::ProviderTurnUpdated {
            thread_id: Some(turn.thread_id.as_str().into()),
            provider_turn: v,
        },
        provider_turn,
    );
}

fn complete_stream(
    turn: &mut Turn,
    item_id: &str,
    final_text: Option<&str>,
    status: &str,
    now: &str,
    out: &mut Vec<Out>,
) {
    let Some(stream) = turn.streams.get_mut(item_id) else {
        return;
    };
    if stream.done {
        return;
    }
    stream.done = true;
    if let Some(text) = final_text {
        stream.text = text.to_string();
    }
    let (kind, text, started) = (stream.kind, stream.text.clone(), stream.started_at.clone());
    if text.trim().is_empty() {
        return;
    }
    match kind {
        StreamKind::Text => {
            turn.emitted.insert(item_id.to_string());
            assistant_artifacts(turn, item_id, &text, status, &started, now, out);
        }
        StreamKind::Thinking => reasoning_item(turn, item_id, &text, true, &started, now, out),
    }
}

/// `publishAssistantArtifacts`: node, message, turn item.
fn assistant_artifacts(
    turn: &mut Turn,
    item_id: &str,
    text: &str,
    status: &str,
    started_at: &str,
    now: &str,
    out: &mut Vec<Out>,
) {
    let item_ordinal = ordinal(turn, item_id);
    let running = status == "running";
    let completed_at = if running { Value::Null } else { json!(now) };
    let node_id = ids::node_from_item(DRIVER, item_id);
    let message_id = ids::message_from_item(DRIVER, item_id);
    let native_ref = json!({"driver": DRIVER, "nativeId": item_id, "strength": "strong"});
    emit(
        out,
        |v| ProviderEvent::NodeUpdated { node: v },
        json!({
            "id": node_id, "threadId": turn.thread_id, "runId": turn.run_id,
            "parentNodeId": turn.root_node_id, "rootNodeId": turn.root_node_id,
            "kind": "assistant_message", "status": status, "countsForRun": false,
            "providerThreadId": turn.provider_thread_id, "providerTurnId": turn.provider_turn_id,
            "nativeItemRef": native_ref, "runtimeRequestId": null, "checkpointScopeId": null,
            "startedAt": started_at, "completedAt": completed_at,
        }),
    );
    emit(
        out,
        |v| ProviderEvent::MessageUpdated { message: v },
        json!({
            "createdBy": "agent", "creationSource": "provider", "id": message_id,
            "threadId": turn.thread_id, "runId": turn.run_id, "nodeId": node_id,
            "role": "assistant", "text": text, "attachments": [], "streaming": running,
            "createdAt": started_at, "updatedAt": now,
        }),
    );
    out.push(turn_item(json!({
        "id": ids::turn_item_from_item(DRIVER, item_id), "threadId": turn.thread_id,
        "runId": turn.run_id, "nodeId": node_id,
        "providerThreadId": turn.provider_thread_id, "providerTurnId": turn.provider_turn_id,
        "nativeItemRef": native_ref, "parentItemId": null, "ordinal": item_ordinal,
        "status": status, "title": null, "startedAt": started_at, "completedAt": completed_at,
        "updatedAt": now, "type": "assistant_message", "messageId": message_id,
        "text": text, "streaming": running,
    })));
}

fn reasoning_item(
    turn: &mut Turn,
    item_id: &str,
    text: &str,
    completed: bool,
    started_at: &str,
    now: &str,
    out: &mut Vec<Out>,
) {
    let item_ordinal = ordinal(turn, item_id);
    out.push(turn_item(json!({
        "id": ids::turn_item_from_item(DRIVER, item_id), "threadId": turn.thread_id,
        "runId": turn.run_id, "nodeId": turn.root_node_id,
        "providerThreadId": turn.provider_thread_id, "providerTurnId": turn.provider_turn_id,
        "nativeItemRef": {"driver": DRIVER, "nativeId": item_id, "strength": "strong"},
        "parentItemId": null, "ordinal": item_ordinal, "type": "reasoning", "title": "Thinking",
        "text": text, "streaming": !completed,
        "status": if completed { "completed" } else { "running" },
        "startedAt": started_at, "completedAt": if completed { json!(now) } else { Value::Null },
        "updatedAt": now,
    })));
}

fn notice_base(turn: &mut Turn, native_id: &str, now: &str, status: &str) -> Value {
    let item_ordinal = ordinal(turn, native_id);
    json!({
        "id": ids::turn_item_from_item(DRIVER, native_id), "threadId": turn.thread_id,
        "runId": turn.run_id, "nodeId": turn.root_node_id,
        "providerThreadId": turn.provider_thread_id, "providerTurnId": turn.provider_turn_id,
        "nativeItemRef": {"driver": DRIVER, "nativeId": native_id, "strength": "strong"},
        "parentItemId": null, "ordinal": item_ordinal, "status": status,
        "startedAt": now, "completedAt": now, "updatedAt": now,
    })
}

/// `CLAUDE_KNOWN_TOOL_CLASSIFICATIONS`: turn item type and approval request kind.
pub fn classify_tool(name: &str) -> (&'static str, &'static str) {
    let normalized: String = name
        .to_lowercase()
        .chars()
        .filter(|c| !matches!(c, ' ' | '_' | '-'))
        .collect();
    match normalized.as_str() {
        "bash" => ("command_execution", "command"),
        "edit" | "multiedit" | "notebookedit" | "write" => ("file_change", "file-change"),
        "glob" | "grep" | "ls" | "read" => ("dynamic_tool", "file-read"),
        "webfetch" | "websearch" => ("web_search", "command"),
        _ => ("dynamic_tool", "command"),
    }
}

fn start_tool(turn: &mut Turn, id: &str, name: &str, input: &Value, now: &str, out: &mut Vec<Out>) {
    if turn.tools.contains_key(id) || name == "Agent" {
        return;
    }
    let call = ToolCall {
        name: name.to_string(),
        input: input.clone(),
        ordinal: ordinal(turn, id),
        started_at: now.to_string(),
    };
    turn.tools.insert(id.to_string(), call.clone());
    turn.tool_order.push(id.to_string());
    tool_artifacts(&turn.scope(), id, &call, "running", None, None, now, out);
}

/// Where a row lands: the root turn, or a subagent's child thread (no run, no provider ids).
#[derive(Clone, Debug)]
pub(crate) struct Scope {
    pub thread_id: String,
    pub run_id: Value,
    pub parent_node_id: String,
    pub provider_thread_id: Value,
    pub provider_turn_id: Value,
}

impl Turn {
    fn scope(&self) -> Scope {
        Scope {
            thread_id: self.thread_id.clone(),
            run_id: json!(self.run_id),
            parent_node_id: self.root_node_id.clone(),
            provider_thread_id: json!(self.provider_thread_id),
            provider_turn_id: json!(self.provider_turn_id),
        }
    }
}

/// `buildToolCallArtifacts`: the tool's node and turn item.
#[expect(clippy::too_many_arguments, reason = "the fields of one contract row")]
pub(crate) fn tool_artifacts(
    scope: &Scope,
    id: &str,
    call: &ToolCall,
    status: &str,
    output: Option<Value>,
    non_execution_kind: Option<&str>,
    now: &str,
    out: &mut Vec<Out>,
) {
    let completed_at = if status == "running" {
        Value::Null
    } else {
        json!(now)
    };
    let node_id = ids::node_from_item(DRIVER, id);
    let native_ref = json!({"driver": DRIVER, "nativeId": id, "strength": "strong"});
    emit(
        out,
        |v| ProviderEvent::NodeUpdated { node: v },
        json!({
            "id": node_id, "threadId": scope.thread_id, "runId": scope.run_id,
            "parentNodeId": scope.parent_node_id, "rootNodeId": scope.parent_node_id,
            "kind": "tool_call", "status": status, "countsForRun": false,
            "providerThreadId": scope.provider_thread_id, "providerTurnId": scope.provider_turn_id,
            "nativeItemRef": native_ref, "runtimeRequestId": null, "checkpointScopeId": null,
            "startedAt": call.started_at, "completedAt": completed_at,
        }),
    );
    let mut item = Map::new();
    if let Some(kind) = non_execution_kind {
        item.insert("toolNonExecutionKind".into(), json!(kind));
    }
    let base = json!({
        "id": ids::turn_item_from_item(DRIVER, id), "threadId": scope.thread_id, "runId": scope.run_id,
        "nodeId": node_id, "providerThreadId": scope.provider_thread_id,
        "providerTurnId": scope.provider_turn_id, "nativeItemRef": native_ref,
        "parentItemId": null, "ordinal": call.ordinal, "status": status, "title": null,
        "startedAt": call.started_at, "completedAt": completed_at, "updatedAt": now,
    });
    item.extend(base.as_object().cloned().unwrap_or_default());
    let text_output = output.as_ref().map(|o| match o {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    });
    match classify_tool(&call.name).0 {
        "command_execution" => {
            item.insert("type".into(), json!("command_execution"));
            let command = call
                .input
                .get("command")
                .or(call.input.get("cmd"))
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| format!("{}: {}", call.name, call.input));
            item.insert("input".into(), json!(command));
            if let Some(text) = text_output.filter(|t| !t.is_empty()) {
                item.insert("output".into(), json!(text));
            }
        }
        "file_change" => {
            item.insert("type".into(), json!("file_change"));
            let file = ["file_path", "notebook_path", "path"]
                .iter()
                .find_map(|k| call.input.get(*k).and_then(Value::as_str))
                .map(str::to_string)
                .unwrap_or_else(|| format!("{} result", call.name));
            item.insert("fileName".into(), json!(file));
            if let Some(text) = text_output.filter(|t| !t.is_empty()) {
                item.insert("diffStr".into(), json!(text));
            }
        }
        "web_search" => {
            item.insert("type".into(), json!("web_search"));
        }
        _ => {
            item.insert("type".into(), json!("dynamic_tool"));
            item.insert("toolName".into(), json!(call.name));
            item.insert("input".into(), call.input.clone());
            if let Some(output) = output {
                item.insert("output".into(), output);
            }
        }
    }
    out.push(turn_item(Value::Object(item)));
}

/// The tool's output for its row: the structured `tool_use_result` when it says something,
/// else the text of the `tool_result` block (`claudeCommandOutputText` and friends).
fn tool_output(tool_name: &str, structured: Option<&Value>, content: &Value) -> Option<Value> {
    let content_text = match content {
        Value::String(s) => Some(s.clone()),
        Value::Array(parts) => Some(
            parts
                .iter()
                .filter_map(|p| p.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n"),
        ),
        Value::Null => None,
        other => Some(other.to_string()),
    };
    match structured {
        Some(Value::String(s)) if !s.is_empty() => Some(json!(s)),
        Some(value @ Value::Object(obj)) => {
            if classify_tool(tool_name).0 == "command_execution" {
                let field = |k: &str| {
                    obj.get(k)
                        .and_then(Value::as_str)
                        .filter(|s| !s.trim().is_empty())
                        .unwrap_or("")
                        .to_string()
                };
                let (stdout, stderr) = (field("stdout"), field("stderr"));
                let joined = if !stdout.is_empty() && !stderr.is_empty() && !stdout.ends_with('\n')
                {
                    format!("{stdout}\n{stderr}")
                } else {
                    format!("{stdout}{stderr}")
                };
                if !joined.is_empty() {
                    return Some(json!(joined));
                }
                content_text.map(Value::String)
            } else {
                Some(value.clone())
            }
        }
        _ => content_text.map(Value::String),
    }
}

/// `permissionResultFromDecision`.
fn permission_result(
    tool_name: &str,
    decision: &str,
    input: &Value,
    tool_use_id: &str,
    suggestions: Option<&Value>,
    feedback: Option<&str>,
) -> Value {
    if matches!(decision, "accept" | "acceptForSession" | "acceptAlways") {
        let session = decision != "accept";
        let mut result = json!({
            "behavior": "allow",
            "updatedInput": input,
            "toolUseID": tool_use_id,
            "decisionClassification": if session { "user_permanent" } else { "user_temporary" },
        });
        if session {
            let updates: Vec<Value> = suggestions
                .and_then(Value::as_array)
                .map(|list| {
                    list.iter()
                        .map(|s| {
                            let mut s = s.clone();
                            s["destination"] = json!("session");
                            s
                        })
                        .collect()
                })
                .unwrap_or_default();
            result["updatedPermissions"] = if updates.is_empty() {
                json!([{"type": "addRules", "rules": [{"toolName": tool_name}], "behavior": "allow", "destination": "session"}])
            } else {
                json!(updates)
            };
        }
        return result;
    }
    let cancel = decision == "cancel";
    let message = feedback
        .map(str::trim)
        .filter(|f| !f.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| {
            if cancel {
                "User cancelled tool execution.".into()
            } else {
                "User declined tool execution.".into()
            }
        });
    let mut result = json!({
        "behavior": "deny",
        "message": message,
        "toolUseID": tool_use_id,
        "decisionClassification": "user_reject",
    });
    if cancel {
        result["interrupt"] = json!(true);
    }
    result
}

fn cancel_answer(kind: &PendingKind) -> Value {
    match kind {
        PendingKind::Approval { tool_use_id, .. } | PendingKind::Question { tool_use_id, .. } => {
            json!({
                "behavior": "deny",
                "message": "User cancelled tool execution.",
                "toolUseID": tool_use_id,
                "decisionClassification": "user_reject",
                "interrupt": true,
            })
        }
        PendingKind::Elicitation => json!({"action": "cancel"}),
        PendingKind::ResumeDialog { .. } => json!({"behavior": "cancelled"}),
    }
}

/// `claudeUserInputQuestions`.
fn user_input_questions(input: &Value) -> Value {
    let list = input
        .get("questions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let questions: Vec<Value> = list
        .iter()
        .enumerate()
        .filter_map(|(index, q)| {
            let question = q.get("question")?.as_str()?.trim();
            if question.is_empty() {
                return None;
            }
            let header = q
                .get("header")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|h| !h.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| format!("Question {}", index + 1));
            let options: Vec<Value> = q
                .get("options")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|o| {
                    let label = o.get("label")?.as_str()?.trim();
                    if label.is_empty() {
                        return None;
                    }
                    let description = o
                        .get("description")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|d| !d.is_empty())
                        .unwrap_or(label);
                    let mut option = json!({"label": label, "description": description});
                    if let Some(preview) = o.get("preview").and_then(Value::as_str) {
                        option["preview"] = json!(preview);
                    }
                    Some(option)
                })
                .collect();
            Some(json!({
                "id": question, "header": header, "question": question, "options": options,
                "multiSelect": q.get("multiSelect") == Some(&json!(true)),
            }))
        })
        .collect();
    json!(questions)
}

/// `claudeSdkUserInputAnswers`: every answer becomes a string; lists join with ", ".
fn sdk_answers(answers: &Value) -> Map<String, Value> {
    answers
        .as_object()
        .into_iter()
        .flatten()
        .map(|(question, answer)| {
            let text = match answer {
                Value::Array(items) => items
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(", "),
                Value::String(s) => s.clone(),
                Value::Null => String::new(),
                other => other.to_string(),
            };
            (question.clone(), json!(text))
        })
        .collect()
}

/// `claudeMcpElicitationAcceptance`, reduced: only a form with no fields can be accepted
/// from the approval card; anything else is declined.
fn elicitation_acceptance(req: &Elicitation) -> Option<Value> {
    if req.mode.as_deref() == Some("url") {
        return None;
    }
    let schema = req.requested_schema.as_ref()?;
    let empty = schema
        .get("properties")
        .and_then(Value::as_object)
        .is_none_or(Map::is_empty);
    empty.then(|| json!({"action": "accept", "content": {}}))
}

/// `normalizeClaudeTurnTokenUsage` (`provider/ClaudeTurnTokenUsage.ts`) without the
/// process-wide ledger (`otherUsage`) and steered segments.
fn turn_token_usage(
    models: &[String],
    result: Option<&ResultMsg>,
    usage_total: Option<&Usage>,
    completed: bool,
    has_subagents: bool,
) -> Value {
    let mut usage = json!({"usageScope": "main_agent", "hasSubagents": has_subagents});
    if !models.is_empty() {
        usage["models"] = json!(models);
    }
    let success = result.is_some_and(|r| r.subtype == "success");
    let Some(u) = usage_total.filter(|_| result.is_some()) else {
        usage["usageStatus"] = json!("unavailable");
        return usage;
    };
    if !success && u.input_total() + u.output_tokens == 0 {
        usage["usageStatus"] = json!("unavailable");
        return usage;
    }
    usage["cachedInputTokens"] = json!(u.cache_read_input_tokens.unwrap_or(0));
    usage["cacheCreationTokens"] = json!(u.cache_creation_input_tokens.unwrap_or(0));
    if let Some(thinking) = u
        .output_tokens_details
        .as_ref()
        .and_then(|d| d.thinking_tokens)
    {
        usage["reasoningTokens"] = json!(thinking.min(u.output_tokens));
    }
    usage["inputTokens"] = json!(u.input_total());
    usage["outputTokens"] = json!(u.output_tokens);
    usage["usageStatus"] = json!(if completed && success {
        "complete"
    } else {
        "partial"
    });
    usage
}

const AUTH_FAILED_TEXT: &str = "Claude could not authenticate. For subscription login, run `claude auth login` on this environment's machine, then start a new thread. For API-key authentication, check this instance's configured credentials.";

/// `claudeContextWindow`: the selected model's window from the catalog (the bundled
/// `model-manifest.json` profiles, copied for the current models), else what the CLI reported
/// for the model it ran, else 1M for `[1m]` slugs, else 200k.
fn context_tokens(windows: &HashMap<String, u64>, selected: &str, ran: Option<&str>) -> u64 {
    let catalog = match selected.trim_end_matches("[1m]") {
        "claude-opus-5-5" | "claude-opus-5" | "claude-sonnet-5-5" | "claude-sonnet-5"
        | "claude-haiku-5-5" => Some(LONG_CONTEXT_TOKENS),
        "claude-haiku-4-5" => Some(DEFAULT_CONTEXT_TOKENS),
        "claude-sonnet-4-6" | "claude-opus-4-6" => Some(if selected.ends_with("[1m]") {
            LONG_CONTEXT_TOKENS
        } else {
            DEFAULT_CONTEXT_TOKENS
        }),
        _ => None,
    };
    catalog
        .or_else(|| ran.and_then(|m| windows.get(m).copied()))
        .unwrap_or(if selected.ends_with("[1m]") {
            LONG_CONTEXT_TOKENS
        } else {
            DEFAULT_CONTEXT_TOKENS
        })
}

/// The latest reset among the blocked windows, or null if any is unknown.
fn usage_reset_at(limits: &LimitState) -> Value {
    let mut resets: Vec<&Option<String>> = limits.rejected.iter().map(|(_, r)| r).collect();
    if let Some((kind, reset)) = &limits.assistant
        && !limits.rejected.iter().any(|(k, _)| k == kind)
    {
        resets.push(reset);
    }
    if resets.is_empty() || resets.iter().any(|r| r.is_none()) {
        return Value::Null;
    }
    json!(resets.iter().filter_map(|r| r.as_deref()).max())
}

fn steer_event(turn: &Turn, message_id: &str, status: SteerStatus) -> Out {
    event(ProviderEvent::SteerUpdated {
        thread_id: turn.thread_id.as_str().into(),
        run_id: turn.run_id.as_str().into(),
        message_id: message_id.into(),
        status,
    })
}

/// `markSteersAccepted`: a steer counts as taken once its command starts or a frame echoes it.
fn accept_echoed_steers(turn: &mut Turn, message: &Inbound, out: &mut Vec<Out>) {
    if turn.pending_steers.is_empty() {
        return;
    }
    let echoed: Vec<&str> = match message {
        Inbound::CommandLifecycle {
            command_uuid,
            state,
        } if state == "started" => vec![command_uuid.as_str()],
        Inbound::Assistant(m) => m
            .user_message_uuids
            .iter()
            .flatten()
            .map(String::as_str)
            .collect(),
        Inbound::Result(m) => m
            .user_message_uuids
            .iter()
            .flatten()
            .map(String::as_str)
            .collect(),
        _ => return,
    };
    for uuid in echoed {
        if let Some(index) = turn.pending_steers.iter().position(|(u, _)| u == uuid) {
            let (_, message_id) = turn.pending_steers.remove(index);
            out.push(steer_event(turn, &message_id, SteerStatus::Completed));
        }
    }
}

/// `completeProviderRetry`: a response arrived after a retry.
fn complete_retry(turn: &mut Turn, now: &str, out: &mut Vec<Out>) {
    if let Some(state) = turn.retry.take() {
        out.push(turn_item(notices::retry_item(
            turn,
            &state,
            "completed",
            now,
        )));
    }
}

/// `isClaudeBlockedAssistantRateLimit`.
fn blocked_assistant_limit(msg: &AssistantMsg) -> Option<(String, Option<String>)> {
    if msg.parent_tool_use_id.is_some() {
        return None;
    }
    let info = msg
        .api_error_params
        .as_ref()
        .and_then(|p| p.get("rate_limit_info"));
    if let Some(info) = info
        && info.get("status") == Some(&json!("rejected"))
        && !overage_allowed(info)
    {
        let kind = info
            .get("rateLimitType")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        return Some((kind.to_string(), notices::reset_at(info.get("resetsAt"))));
    }
    (msg.error.as_deref() == Some("rate_limit")).then(|| ("unknown".to_string(), None))
}

fn overage_allowed(info: &Value) -> bool {
    matches!(
        info.get("overageStatus").and_then(Value::as_str),
        Some("allowed" | "allowed_warning")
    ) || info.get("isUsingOverage") == Some(&json!(true))
        || info.get("overageInUse") == Some(&json!(true))
}

/// Root frames that mean Claude is working with no turn open.
fn is_wake_frame(message: &Inbound) -> bool {
    match message {
        Inbound::Assistant(m) => m.parent_tool_use_id.is_none(),
        Inbound::User(m) => m.parent_tool_use_id.is_none() && !m.is_replay,
        Inbound::StreamEvent(m) => m.parent_tool_use_id.is_none(),
        Inbound::Result(_) => true,
        _ => false,
    }
}

impl<E: Env> Mapper<E> {
    /// Holds a frame for a continuation turn and asks the engine for one, once.
    fn hold_wake(&mut self, message: Inbound, out: &mut Vec<Out>) {
        let starts_work = matches!(message, Inbound::Assistant(_) | Inbound::StreamEvent(_));
        if !starts_work && self.wake.is_empty() {
            // Output that belongs to no work we saw start, such as the one `result` of an
            // unknown `--resume` id.
            if matches!(message, Inbound::Result(_)) {
                out.push(Out::Skipped("result (no active turn)".into()));
            }
            return;
        }
        if let Inbound::Result(r) = &message
            && r.num_turns == Some(0)
        {
            return;
        }
        if self.wake.len() >= WAKE_FRAME_CAP {
            self.wake.pop_front();
        }
        self.wake.push_back(message);
        if !starts_work || self.continuation_requested {
            return;
        }
        let Some(ctx) = &self.last_ctx else {
            return;
        };
        self.continuation_requested = true;
        out.push(event(ProviderEvent::ContinuationRequested(
            ContinuationRequest {
                thread_id: ctx.thread_id.as_str().into(),
                provider_thread_id: ctx.provider_thread_id.as_str().into(),
                detail: None,
            },
        )));
    }

    fn on_rate_limit(&mut self, info: &Value, out: &mut Vec<Out>) {
        let now = self.env.now();
        let now_ms = self.env.now_ms();
        let Some(turn) = &mut self.turn else {
            return;
        };
        let status = info.get("status").and_then(Value::as_str).unwrap_or("");
        let overage = overage_allowed(info);
        let blocked = status == "rejected" && !overage;
        let kind = info
            .get("rateLimitType")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string();
        turn.limits.rejected.retain(|(k, _)| *k != kind);
        if !blocked {
            return;
        }
        let resets = info.get("resetsAt");
        turn.limits
            .rejected
            .push((kind.clone(), notices::reset_at(resets)));
        let resets_num = resets.and_then(Value::as_f64);
        let key = format!(
            "{kind}:{}",
            resets.map_or("unknown".to_string(), |r| r.to_string())
        );
        if !turn.limits.announced.insert(key.clone()) {
            return;
        }
        let text = notices::usage_limit_notice(&kind, resets_num, now_ms);
        let native = format!("usage-limit:{}:{key}", turn.provider_turn_id);
        let mut item = notice_base(turn, &native, &now, "completed");
        item["nativeItemRef"]["strength"] = json!("weak");
        item["type"] = json!("system_notice");
        item["title"] = json!(text);
        item["message"] = json!(text);
        out.push(turn_item(item));
    }

    /// `emitClaudePlanProjection` for a `todo_list`.
    fn emit_todo_list(&mut self, native_item_id: &str, steps: Vec<Value>, out: &mut Vec<Out>) {
        let now = self.env.now();
        let uuid = self.env.uuid();
        let Some(turn) = &mut self.turn else {
            return;
        };
        let projection = format!("todo_list:{native_item_id}");
        let plan_id = self
            .plan_ids
            .entry(projection.clone())
            .or_insert_with(|| ids::plan_id(&turn.thread_id, Some(&turn.run_id), DRIVER, &uuid))
            .clone();
        if let Some(previous) = self.latest_todo.take()
            && previous["id"] != json!(plan_id)
        {
            let mut superseded = previous;
            superseded["status"] = json!("superseded");
            emit(out, |v| ProviderEvent::PlanUpdated { plan: v }, superseded);
        }
        let node_id = ids::node_from_item(DRIVER, &projection);
        let native_ref =
            json!({"driver": DRIVER, "nativeId": native_item_id, "strength": "strong"});
        let item_ordinal = ordinal(turn, &projection);
        let done = steps.iter().all(|s| s["status"] == "completed");
        let plan = json!({
            "id": plan_id, "threadId": turn.thread_id, "runId": turn.run_id, "nodeId": node_id,
            "kind": "todo_list", "status": if done { "completed" } else { "active" },
            "steps": steps,
        });
        emit(
            out,
            |v| ProviderEvent::NodeUpdated { node: v },
            json!({
                "id": node_id, "threadId": turn.thread_id, "runId": turn.run_id,
                "parentNodeId": turn.root_node_id, "rootNodeId": turn.root_node_id,
                "kind": "todo_list", "status": "completed", "countsForRun": false,
                "providerThreadId": turn.provider_thread_id,
                "providerTurnId": turn.provider_turn_id, "nativeItemRef": native_ref,
                "runtimeRequestId": null, "checkpointScopeId": null,
                "startedAt": now, "completedAt": now,
            }),
        );
        emit(
            out,
            |v| ProviderEvent::PlanUpdated { plan: v },
            plan.clone(),
        );
        out.push(turn_item(json!({
            "id": ids::turn_item_from_item(DRIVER, &projection), "threadId": turn.thread_id,
            "runId": turn.run_id, "nodeId": node_id,
            "providerThreadId": turn.provider_thread_id, "providerTurnId": turn.provider_turn_id,
            "nativeItemRef": native_ref, "parentItemId": null, "ordinal": item_ordinal,
            "status": "completed", "title": null, "startedAt": now, "completedAt": now,
            "updatedAt": now, "type": "todo_list", "planId": plan_id, "steps": plan["steps"],
        })));
        self.latest_todo = Some(plan);
    }

    /// `TaskCreate`, `TaskUpdate`, `TaskList` results update the session's task list. T3
    /// first reads the list Claude saved on disk; this mapper starts from the tools it saw.
    fn apply_task_tool(&mut self, tool: &str, input: &Value, result: &Value, out: &mut Vec<Out>) {
        let current = self.task_list.clone().unwrap_or_default();
        let Some(next) = notices::apply_task_tool(&current, tool, input, result) else {
            return;
        };
        let steps = next
            .iter()
            .map(|(id, text, status)| json!({"id": format!("task-{id}"), "text": text, "status": status}))
            .collect();
        self.task_list = Some(next);
        let Some(turn) = &self.turn else {
            return;
        };
        let native = format!("claude-tasks:{}", turn.provider_turn_id);
        self.emit_todo_list(&native, steps, out);
    }
}
