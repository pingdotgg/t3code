//! Turns CLI messages into `ProviderEvent`s and CLI replies. Pure: no I/O, no async, time and
//! randomness come from [`Env`], so recorded sessions replay exactly.
//!
//! Event shapes follow `ClaudeAdapterV2.ts` (`publishAssistantArtifacts`,
//! `buildToolCallArtifacts`, `buildApprovalRequestArtifacts`, `emitContextUsage`,
//! `finalizeActiveTurn`). Known differences are listed in the crate README.

use std::collections::{HashMap, HashSet};

use conn_contract::from_json;
use conn_provider::{
    ProviderError, ProviderEvent, RuntimeRequestResponse, ThreadDisposition, TurnInput, TurnStatus,
    TurnTerminal,
};
use serde_json::{Map, Value, json};

use crate::ids::{self, DRIVER, Env};
use crate::launch;
use crate::protocol::{
    AssistantMsg, Block, CanUseTool, ControlRequest, Delta, Elicitation, Inbound, ResultMsg,
    StreamEvent, SystemMsg, Usage, UserContent, UserDialog, UserMsg, control_error,
    control_success,
};

/// What the session must do after feeding the mapper.
#[derive(Debug, Clone, PartialEq)]
pub enum Out {
    Event(ProviderEvent),
    /// One JSON line for the CLI's stdin.
    Write(String),
    /// A kind the mapper skipped; the session logs it.
    Skipped(String),
}

const MAX_CONTEXT_TOKENS: u64 = 200_000;
const RESUME_COMPACT_ANSWER: &str = "Compact and resume";
const RESUME_NEVER_ANSWER: &str = "Don't ask again";

pub struct Mapper<E: Env> {
    env: E,
    provider_session_id: String,
    turn: Option<Turn>,
    /// Keyed by runtime request id.
    pending: HashMap<String, Pending>,
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
struct ToolCall {
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
    /// Results still owed for steer messages written into this turn.
    extra_results: u32,
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
        }
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

    /// A steer message was written: its `result` belongs to the same turn.
    pub fn expect_steer_result(&mut self) -> bool {
        match &mut self.turn {
            Some(turn) => {
                turn.extra_results += 1;
                true
            }
            None => false,
        }
    }

    pub fn set_permission_mode(&mut self, mode: &str) {
        if let Some(turn) = &mut self.turn {
            turn.permission_mode = mode.to_string();
        }
    }

    /// Opens a turn after its user message was written to the CLI.
    pub fn begin_turn(&mut self, input: &TurnInput, permission_mode: &str) -> Vec<Out> {
        let now = self.env.now();
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
            provider_turn_id: ids::provider_turn_id(&native_turn_id),
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
            extra_results: 0,
        };
        let mut out = vec![event(ProviderEvent::ProviderTurnUpdated {
            thread_id: None,
            provider_turn: from_json(provider_turn(&turn, "running", None, false)).unwrap(),
        })];
        provider_thread["status"] = json!("active");
        provider_thread["providerSessionId"] = json!(self.provider_session_id);
        provider_thread["updatedAt"] = json!(now);
        out.push(event(ProviderEvent::ProviderThreadUpdated {
            provider_thread: from_json(provider_thread).unwrap(),
        }));
        self.turn = Some(turn);
        out
    }

    pub fn handle(&mut self, message: Inbound) -> Vec<Out> {
        let mut out = Vec::new();
        match message {
            Inbound::StreamEvent(msg) if msg.parent_tool_use_id.is_none() => {
                self.on_stream(msg.event, &mut out)
            }
            // Subagent streams: decoded, not projected yet.
            Inbound::StreamEvent(_) => {}
            Inbound::Assistant(msg) if msg.parent_tool_use_id.is_none() => {
                self.on_assistant(msg, &mut out)
            }
            Inbound::Assistant(_) => out.push(Out::Skipped("assistant (subagent)".into())),
            Inbound::User(msg) => self.on_user(msg, &mut out),
            Inbound::System(msg) => self.on_system(msg, &mut out),
            Inbound::Result(msg) => self.on_result(msg, &mut out),
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
                turn.message_id = Some(message.id.clone());
                turn.stream_blocks.clear();
                if let Some(usage) = message.usage {
                    turn.usage = Some((message.id, usage, now_ms));
                    emit_usage(turn, &now, out);
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
                    emit_usage(turn, &now, out);
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
                Block::ToolUse { id, name, input } => {
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
        if let Some(usage) = msg.message.usage.filter(|_| model != "<synthetic>") {
            let same = turn
                .usage
                .as_ref()
                .is_some_and(|(id, _, _)| *id == message_id);
            if !same {
                turn.usage = Some((message_id, usage, now_ms));
                emit_usage(turn, &now, out);
            }
        }
    }

    fn on_user(&mut self, msg: UserMsg, out: &mut Vec<Out>) {
        let now = self.env.now();
        let Some(turn) = &mut self.turn else {
            return;
        };
        if msg.is_replay || msg.parent_tool_use_id.is_some() {
            return;
        }
        let UserContent::Blocks(blocks) = &msg.message.content else {
            return;
        };
        let results: Vec<_> = blocks
            .iter()
            .filter_map(|b| match b {
                Block::ToolResult {
                    tool_use_id,
                    content,
                    is_error,
                } => Some((tool_use_id, content, *is_error)),
                _ => None,
            })
            .collect();
        let single = results.len() == 1;
        for (tool_use_id, content, is_error) in results {
            let Some(call) = turn.tools.remove(tool_use_id) else {
                continue;
            };
            turn.tool_order.retain(|id| id != tool_use_id);
            let kind = msg
                .tool_result_meta
                .iter()
                .flatten()
                .find(|m| m.id == *tool_use_id)
                .and_then(|m| m.non_execution_kind.clone());
            let status = match kind.as_deref() {
                Some("cancelled") => "cancelled",
                Some("interrupted") => "interrupted",
                _ if is_error => "failed",
                _ => "completed",
            };
            let structured = if single {
                msg.tool_use_result.as_ref()
            } else {
                None
            };
            let output = tool_output(&call.name, structured, content);
            tool_artifacts(
                turn,
                tool_use_id,
                &call,
                status,
                output,
                kind.as_deref(),
                &now,
                out,
            );
        }
    }

    fn on_system(&mut self, msg: SystemMsg, out: &mut Vec<Out>) {
        let now = self.env.now();
        let Some(turn) = &mut self.turn else {
            return;
        };
        match msg.subtype.as_str() {
            "init" => {
                if let Some(mode) = msg.permission_mode {
                    turn.permission_mode = mode;
                }
            }
            "compact_boundary" => {
                let id = msg.uuid.unwrap_or_default();
                let meta = msg.compact_metadata.unwrap_or(Value::Null);
                let mut item = notice_base(turn, &id, &now, "completed");
                item["type"] = json!("compaction");
                item["driver"] = json!(DRIVER);
                item["title"] = json!("Context compacted");
                if let Some(pre) = meta.get("pre_tokens").filter(|v| v.is_number()) {
                    item["beforeTokenCount"] = pre.clone();
                }
                if let Some(post) = meta.get("post_tokens").and_then(Value::as_f64)
                    && post > 0.0
                {
                    item["afterTokenCount"] = json!(post.round() as u64);
                }
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
            // Decoded; T3 shows a retry row here (`makeProviderRetryTurnItem`). Not projected yet.
            "api_retry" => out.push(Out::Skipped("system/api_retry".into())),
            _ => {}
        }
    }

    fn on_result(&mut self, msg: ResultMsg, out: &mut Vec<Out>) {
        let Some(turn) = &mut self.turn else {
            out.push(Out::Skipped("result (no active turn)".into()));
            return;
        };
        if turn.extra_results > 0 {
            turn.extra_results -= 1;
            return;
        }
        let (status, failure) = if turn.interrupt_requested {
            (TurnStatus::Interrupted, None)
        } else if msg.is_error || msg.subtype != "success" {
            (
                TurnStatus::Failed,
                Some(result_failure(&msg, turn.auth_failed)),
            )
        } else {
            (TurnStatus::Completed, None)
        };
        self.finalize(status, failure, Some(&msg), out);
    }

    /// The CLI exited. Ends a running turn as failed (or interrupted when we stopped it).
    pub fn on_exit(&mut self, expected: bool, detail: &str) -> Vec<Out> {
        let mut out = Vec::new();
        self.cancel_all_pending(&mut out);
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
                tool_artifacts(&mut turn, &id, &call, tool_status, None, None, &now, out);
            }
        }
        let mut provider_turn = provider_turn(&turn, status_text, Some(&now), true);
        provider_turn["turnTokenUsage"] = turn_token_usage(&turn.models, result, completed);
        out.push(event(ProviderEvent::ProviderTurnUpdated {
            thread_id: None,
            provider_turn: from_json(provider_turn).unwrap(),
        }));
        let mut thread = turn.provider_thread.clone();
        thread["providerSessionId"] = json!(self.provider_session_id);
        if thread.get("firstRunOrdinal").is_none_or(Value::is_null) {
            thread["firstRunOrdinal"] = json!(turn.run_ordinal);
        }
        thread["lastRunOrdinal"] = json!(turn.run_ordinal);
        thread["pendingBackgroundTasks"] = json!([]);
        thread["status"] = json!(if completed { "active" } else { "idle" });
        thread["updatedAt"] = json!(now);
        out.push(event(ProviderEvent::ProviderThreadUpdated {
            provider_thread: from_json(thread).unwrap(),
        }));
        out.push(event(ProviderEvent::TurnTerminal(TurnTerminal {
            provider_thread_id: turn.provider_thread_id.as_str().into(),
            provider_turn_id: turn.provider_turn_id.as_str().into(),
            run_ordinal: turn.run_ordinal,
            status,
            failure: failure.map(|f| from_json(f).unwrap()),
            retry: None,
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
        if req.tool_name != "Agent" && req.tool_name != "AskUserQuestion" {
            start_tool(turn, &tool_use_id, &req.tool_name, &req.input, &now, out);
        }
        if req.tool_name == "AskUserQuestion" {
            let questions = user_input_questions(&req.input);
            let thread_id = turn.thread_id.clone();
            let root = turn.root_node_id.clone();
            let (node, request, item) = self.request_artifacts(
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
                (node, request, item),
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
        if !launch::asks_user(&turn.permission_mode) {
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
        let thread_id = self.turn.as_ref().unwrap().thread_id.clone();
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
                prompt: req.message.clone(),
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
        let native_id = req.tool_use_id.clone().unwrap_or(cli_id.clone());
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
        let pending = self.pending.remove(&request_id).unwrap();
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
        out.push(event(ProviderEvent::RuntimeRequestUpdated {
            thread_id: Some(pending.thread_id.as_str().into()),
            runtime_request: from_json(request).unwrap(),
        }));
        let mut node = pending.node.clone();
        node["status"] = json!("cancelled");
        node["completedAt"] = json!(now);
        out.push(event(ProviderEvent::NodeUpdated {
            node: from_json(node).unwrap(),
        }));
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
        (node, request, item): (Value, Value, Value),
        thread_id: String,
        out: &mut Vec<Out>,
    ) {
        out.push(event(ProviderEvent::NodeUpdated {
            node: from_json(node.clone()).unwrap(),
        }));
        out.push(event(ProviderEvent::RuntimeRequestUpdated {
            thread_id: None,
            runtime_request: from_json(request.clone()).unwrap(),
        }));
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
    ) -> (Value, Value, Value) {
        let uuid = self.env.uuid();
        let turn = self.turn.as_mut().expect("active turn");
        let request_id = ids::join_id(
            "runtime-request",
            &[
                "provider",
                DRIVER,
                "provider-turn",
                &turn.provider_turn_id,
                "native-request",
                native_request_id,
                &uuid,
            ],
        );
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
            "parentNodeId": parent_node_id.unwrap_or_else(|| ids::node_from_item(native_item_id)),
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
        (node, request, item)
    }

    fn proposed_plan(&mut self, tool_use_id: &str, markdown: &str, now: &str, out: &mut Vec<Out>) {
        let uuid = self.env.uuid();
        let turn = self.turn.as_mut().expect("active turn");
        let native = format!("proposed_plan:{tool_use_id}");
        let plan_id = ids::join_id(
            "plan",
            &[
                "thread",
                &turn.thread_id,
                "provider",
                DRIVER,
                "run",
                &turn.run_id,
                &uuid,
            ],
        );
        let node_id = ids::node_from_item(&native);
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
            "id": ids::turn_item_from_item(&native), "threadId": turn.thread_id,
            "runId": turn.run_id, "nodeId": node_id,
            "providerThreadId": turn.provider_thread_id, "providerTurnId": turn.provider_turn_id,
            "nativeItemRef": native_ref, "parentItemId": null, "ordinal": item_ordinal,
            "status": "completed", "title": null, "startedAt": now, "completedAt": now,
            "updatedAt": now, "type": "proposed_plan", "planId": plan_id, "markdown": markdown,
            "streaming": false,
        });
        out.push(event(ProviderEvent::NodeUpdated {
            node: from_json(node).unwrap(),
        }));
        out.push(event(ProviderEvent::PlanUpdated {
            plan: from_json(plan).unwrap(),
        }));
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
    event(ProviderEvent::TurnItemUpdated {
        turn_item: from_json(item).unwrap(),
    })
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
fn emit_usage(turn: &Turn, now: &str, out: &mut Vec<Out>) {
    let Some((_, usage, requested_ms)) = &turn.usage else {
        return;
    };
    let input = usage.input_total();
    if input == 0 {
        return;
    }
    let mut token_usage = json!({
        "usedTokens": input + usage.output_tokens,
        "maxTokens": MAX_CONTEXT_TOKENS,
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
    out.push(event(ProviderEvent::ProviderTurnUpdated {
        thread_id: Some(turn.thread_id.as_str().into()),
        provider_turn: from_json(provider_turn).unwrap(),
    }));
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
    let node_id = ids::node_from_item(item_id);
    let message_id = ids::message_from_item(item_id);
    let native_ref = json!({"driver": DRIVER, "nativeId": item_id, "strength": "strong"});
    out.push(event(ProviderEvent::NodeUpdated {
        node: from_json(json!({
            "id": node_id, "threadId": turn.thread_id, "runId": turn.run_id,
            "parentNodeId": turn.root_node_id, "rootNodeId": turn.root_node_id,
            "kind": "assistant_message", "status": status, "countsForRun": false,
            "providerThreadId": turn.provider_thread_id, "providerTurnId": turn.provider_turn_id,
            "nativeItemRef": native_ref, "runtimeRequestId": null, "checkpointScopeId": null,
            "startedAt": started_at, "completedAt": completed_at,
        }))
        .unwrap(),
    }));
    out.push(event(ProviderEvent::MessageUpdated {
        message: from_json(json!({
            "createdBy": "agent", "creationSource": "provider", "id": message_id,
            "threadId": turn.thread_id, "runId": turn.run_id, "nodeId": node_id,
            "role": "assistant", "text": text, "attachments": [], "streaming": running,
            "createdAt": started_at, "updatedAt": now,
        }))
        .unwrap(),
    }));
    out.push(turn_item(json!({
        "id": ids::turn_item_from_item(item_id), "threadId": turn.thread_id,
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
        "id": ids::turn_item_from_item(item_id), "threadId": turn.thread_id,
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
        "id": ids::turn_item_from_item(native_id), "threadId": turn.thread_id,
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
    tool_artifacts(turn, id, &call, "running", None, None, now, out);
}

#[allow(clippy::too_many_arguments)]
fn tool_artifacts(
    turn: &mut Turn,
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
    let node_id = ids::node_from_item(id);
    let native_ref = json!({"driver": DRIVER, "nativeId": id, "strength": "strong"});
    out.push(event(ProviderEvent::NodeUpdated {
        node: from_json(json!({
            "id": node_id, "threadId": turn.thread_id, "runId": turn.run_id,
            "parentNodeId": turn.root_node_id, "rootNodeId": turn.root_node_id,
            "kind": "tool_call", "status": status, "countsForRun": false,
            "providerThreadId": turn.provider_thread_id, "providerTurnId": turn.provider_turn_id,
            "nativeItemRef": native_ref, "runtimeRequestId": null, "checkpointScopeId": null,
            "startedAt": call.started_at, "completedAt": completed_at,
        }))
        .unwrap(),
    }));
    let mut item = Map::new();
    if let Some(kind) = non_execution_kind {
        item.insert("toolNonExecutionKind".into(), json!(kind));
    }
    let base = json!({
        "id": ids::turn_item_from_item(id), "threadId": turn.thread_id, "runId": turn.run_id,
        "nodeId": node_id, "providerThreadId": turn.provider_thread_id,
        "providerTurnId": turn.provider_turn_id, "nativeItemRef": native_ref,
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
                    stdout + &stderr
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
fn turn_token_usage(models: &[String], result: Option<&ResultMsg>, completed: bool) -> Value {
    let mut usage = json!({"usageScope": "main_agent", "hasSubagents": false});
    if !models.is_empty() {
        usage["models"] = json!(models);
    }
    let success = result.is_some_and(|r| r.subtype == "success");
    let Some(u) = result.and_then(|r| r.usage.as_ref()) else {
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

fn result_failure(msg: &ResultMsg, auth_failed: bool) -> Value {
    let text = if auth_failed {
        "Claude could not authenticate. For subscription login, run `claude auth login` on this environment's machine, then start a new thread. For API-key authentication, check this instance's configured credentials.".to_string()
    } else if msg.subtype == "success" {
        msg.result
            .clone()
            .filter(|t| !t.trim().is_empty())
            .unwrap_or_else(|| "Provider turn failed.".into())
    } else {
        msg.errors
            .as_ref()
            .map(|e| {
                e.iter()
                    .map(|s| s.trim())
                    .filter(|s| !s.is_empty())
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .filter(|t| !t.is_empty())
            .unwrap_or_else(|| "Provider turn failed.".into())
    };
    json!({
        "class": "provider_error",
        "message": crate::protocol::truncate(&text, 4096),
        "code": msg.api_error_status.map(|s| format!("api_error_{s}")),
        "retryable": null,
    })
}
