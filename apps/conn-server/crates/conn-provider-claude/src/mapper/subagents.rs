//! Subagents (`Agent` tool): a `subagent` row in the parent turn and a child app thread that
//! holds the subagent's prompt, replies, reasoning and tool calls.
//!
//! Follows `updateClaudeSubagentNode` and the subagent branches of `handleSdkMessageFrame` in
//! `ClaudeAdapterV2.ts`. The `Agent` tool_use itself emits nothing; it records a launch (model,
//! effort, owner). `task_started` opens the row, `task_progress` updates it, and
//! `task_notification` (background) or the Agent `tool_result` (foreground) settles it. Child
//! frames that arrive before `task_started` are held, with caps, and replayed after it.
//! Resume recovery from Claude's files is not ported.

use std::collections::{HashMap, VecDeque};

use sha2::{Digest, Sha256};

use super::{
    AppThread, AssistantMsg, Block, DRIVER, Env, Inbound, Mapper, Out, ProviderEvent, Scope,
    SystemMsg, ToolCall, UserContent, UserMsg, Value, emit, event, from_json, ids, json, ordinal,
    tool_artifacts, tool_output, turn_item,
};

const PENDING_LAUNCH_CAP: usize = 64;
const PENDING_FRAME_IDS_CAP: usize = 64;
const PENDING_FRAMES_PER_ID: usize = 256;
const TITLE_MAX_CHARS: usize = 72;
/// Subagents kept after they settled, for a later resume.
const SETTLED_CAP: usize = 64;

/// What a subagent row needs from the turn that launched it. Kept with the subagent, since a
/// background subagent keeps reporting after its turn ended.
#[derive(Clone, Debug)]
pub(crate) struct ParentCtx {
    pub thread_id: String,
    pub run_id: String,
    pub provider_thread_id: String,
    pub provider_turn_id: String,
    pub root_node_id: String,
    pub instance_id: String,
    pub root_model: String,
    pub app_thread: Value,
}

struct Launch {
    model: Option<String>,
    effort: Option<String>,
    owner_tool_use_id: Option<String>,
}

pub(crate) struct Sub {
    tool_use_id: String,
    node_id: String,
    child_root: String,
    item_id: String,
    child_thread_id: String,
    item_ordinal: u32,
    next_child: u32,
    result_ordinal: Option<u32>,
    task: Value,
    parent: ParentCtx,
    child_thread_created: bool,
    last_text: Option<String>,
    last_message_id: Option<String>,
    tools: HashMap<String, ToolCall>,
    tool_order: Vec<String>,
    /// Effort from the launch; fixed for the subagent's life.
    effort: Option<String>,
    members: HashMap<u64, Value>,
    stop_requested: bool,
    process_generation: u64,
}

impl Sub {
    pub(super) fn running(&self) -> bool {
        self.task["status"] == "running"
    }

    fn child_scope(&self) -> Scope {
        Scope {
            thread_id: self.child_thread_id.clone(),
            run_id: Value::Null,
            parent_node_id: self.child_root.clone(),
            provider_thread_id: Value::Null,
            provider_turn_id: Value::Null,
        }
    }

    fn next_ordinal(&mut self) -> u32 {
        self.next_child += 1;
        self.next_child
    }
}

#[derive(Default)]
pub(crate) struct Subagents {
    by_task: HashMap<String, Sub>,
    by_tool: HashMap<String, String>,
    launches: HashMap<String, Launch>,
    launch_order: VecDeque<String>,
    frames: HashMap<String, Vec<Inbound>>,
    frame_order: VecDeque<String>,
    /// Subagents this session opened, for the child thread's fallback title.
    opened: u32,
}

impl Subagents {
    /// Subagents, launches and held frames, for the memory checks.
    #[cfg(test)]
    pub(super) fn len(&self) -> usize {
        self.by_task.len() + self.by_tool.len() + self.launches.len() + self.frames.len()
    }

    pub(super) fn any_running(&self) -> bool {
        self.by_task.values().any(Sub::running)
    }

    /// The tool_use id belongs to a tool a subagent runs.
    pub(super) fn owns_tool(&self, tool_use_id: &str) -> bool {
        self.by_task
            .values()
            .any(|s| s.tools.contains_key(tool_use_id))
    }

    /// A running subagent's title and child thread, for the wake that its end reports.
    pub(super) fn running_report(&self, task_id: &str) -> Option<(Option<String>, String)> {
        self.by_task.get(task_id).filter(|s| s.running())?;
        self.report(task_id)
    }

    /// A subagent's title and child thread.
    pub(super) fn report(&self, task_id: &str) -> Option<(Option<String>, String)> {
        let sub = self.by_task.get(task_id)?;
        let title = sub.task["title"].as_str().map(str::to_string);
        Some((title, sub.child_thread_id.clone()))
    }

    pub(super) fn is_subagent_tool(&self, tool_use_id: &str) -> bool {
        self.by_tool.contains_key(tool_use_id)
    }

    /// Forgets settled subagents once more than [`SETTLED_CAP`] are known; called when a new
    /// user turn starts. Settled ones stay until then, since Claude can resume a subagent
    /// (`SendMessage`) in a later turn (`sessionSubagentsByTaskId` keeps them).
    pub(super) fn prune_settled(&mut self) {
        if self.by_task.len() <= SETTLED_CAP {
            return;
        }
        let settled: Vec<String> = self
            .by_task
            .iter()
            .filter(|(_, s)| !s.running())
            .map(|(id, _)| id.clone())
            .collect();
        for task_id in settled {
            if let Some(sub) = self.by_task.remove(&task_id) {
                self.by_tool.retain(|_, t| t != &task_id);
                let _ = sub;
            }
        }
    }

    fn remember_launch(&mut self, tool_use_id: &str, launch: Launch) {
        if self.by_tool.contains_key(tool_use_id) || self.launches.contains_key(tool_use_id) {
            return;
        }
        if self.launch_order.len() >= PENDING_LAUNCH_CAP
            && let Some(oldest) = self.launch_order.pop_front()
        {
            self.launches.remove(&oldest);
        }
        self.launch_order.push_back(tool_use_id.to_string());
        self.launches.insert(tool_use_id.to_string(), launch);
    }

    fn hold_frame(&mut self, tool_use_id: &str, frame: Inbound) {
        if !self.frames.contains_key(tool_use_id) {
            if self.frame_order.len() >= PENDING_FRAME_IDS_CAP
                && let Some(oldest) = self.frame_order.pop_front()
            {
                self.frames.remove(&oldest);
            }
            self.frame_order.push_back(tool_use_id.to_string());
        }
        let held = self.frames.entry(tool_use_id.to_string()).or_default();
        if held.len() < PENDING_FRAMES_PER_ID {
            held.push(frame);
        }
    }

    fn take_frames(&mut self, tool_use_id: &str) -> Vec<Inbound> {
        self.frame_order.retain(|id| id != tool_use_id);
        self.frames.remove(tool_use_id).unwrap_or_default()
    }
}

/// `IdAllocator.derive.subagentThread`: `thread:subagent:` + 16 hex of a sha256.
pub fn subagent_thread_id(native_thread_id: &str) -> String {
    let legacy = format!(
        "thread:provider:{DRIVER}:native-thread:{}",
        ids::encode_component(native_thread_id)
    );
    let digest = Sha256::digest(legacy.as_bytes());
    let hex = conn_support::hex::hex(&digest[..8]);
    format!("thread:subagent:{hex}")
}

/// `subagentThreadTitle`.
fn child_title(parent_title: &str, title: Option<&str>, prompt: &str, ordinal: u32) -> String {
    let detail = title
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .unwrap_or(prompt.trim());
    if detail.is_empty() {
        return format!("{parent_title} subagent {ordinal}");
    }
    if detail.chars().count() <= TITLE_MAX_CHARS {
        return detail.to_string();
    }
    let cut: String = detail.chars().take(TITLE_MAX_CHARS - 3).collect();
    format!("{cut}...")
}

/// `claudeSubagentResultText`: the text parts, without the tools-used note.
fn result_text(content: &Value) -> String {
    let text = match content {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|p| p.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    };
    let trimmed = text.trim_start();
    if let Some(rest) = trimmed.strip_prefix("<tools-used-before-summary>")
        && let Some(end) = rest.find("</tools-used-before-summary>")
    {
        return rest[end + "</tools-used-before-summary>".len()..]
            .trim()
            .to_string();
    }
    text.trim().to_string()
}

fn is_async_ack(structured: Option<&Value>, content: &Value) -> bool {
    if let Some(s) = structured
        && (s.get("isAsync") == Some(&json!(true))
            || s.get("status") == Some(&json!("async_launched")))
    {
        return true;
    }
    result_text(content).starts_with("Async agent launched successfully.")
}

fn normalize(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// One change to a subagent row.
#[derive(Default)]
pub(crate) struct Update<'a> {
    pub task_id: &'a str,
    pub tool_use_id: &'a str,
    pub status: &'a str,
    pub prompt: Option<String>,
    pub title: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub owner_task_id: Option<String>,
    pub progress: Option<String>,
    pub result: Option<String>,
    pub reopen: bool,
    pub skip_parent_turn: bool,
    pub workflow_name: Option<String>,
    pub workflow_frame: Value,
    pub workflow_handles: Option<Value>,
}

impl<E: Env> Mapper<E> {
    fn parent_ctx(&self) -> Option<ParentCtx> {
        match &self.turn {
            Some(turn) => Some(turn.parent_ctx()),
            None => self.last_ctx.clone(),
        }
    }

    /// The root assistant's `Agent` tool_use: remember model, effort and owner for
    /// `task_started`.
    pub(super) fn remember_agent_launch(
        &mut self,
        tool_use_id: &str,
        input: &Value,
        owner: Option<&str>,
    ) {
        let root_model = self.parent_ctx().map(|c| c.root_model).unwrap_or_default();
        let model = match input.get("model").and_then(Value::as_str) {
            Some("inherit") if owner.is_none() => Some(root_model),
            Some("inherit") | None => None,
            Some(m) if m.trim().is_empty() => None,
            Some(m) => Some(crate::catalog::resolve_slug(m)),
        };
        let effort = input
            .get("effort")
            .and_then(Value::as_str)
            .map(str::to_string);
        self.subagents.remember_launch(
            tool_use_id,
            Launch {
                model,
                effort,
                owner_tool_use_id: owner.map(str::to_string),
            },
        );
    }

    pub(crate) fn workflow_stop(&mut self, thread: &Value, task_id: &str, requested: bool) -> bool {
        let Some(sub) = self.subagents.by_task.get_mut(task_id) else {
            return false;
        };
        if !sub.running()
            || sub.process_generation != self.process_generation
            || !sub.task["workflow"].is_object()
            || sub.parent.thread_id != thread["appThreadId"].as_str().unwrap_or_default()
            || sub.parent.provider_thread_id != thread["id"].as_str().unwrap_or_default()
        {
            return false;
        }
        sub.stop_requested = requested;
        true
    }

    pub(super) fn on_task_started(&mut self, msg: &SystemMsg, out: &mut Vec<Out>) {
        let Some(task_id) = &msg.task_id else {
            return;
        };
        let tool_use_id = msg.tool_use_id.as_deref().unwrap_or_default();
        if matches!(msg.task_type.as_deref(), Some("local_bash")) {
            self.tail_bash_task(msg, out);
            return;
        }
        let launch = self.subagents.launches.remove(tool_use_id);
        self.subagents.launch_order.retain(|id| id != tool_use_id);
        let owner = launch
            .as_ref()
            .and_then(|l| l.owner_tool_use_id.as_ref())
            .and_then(|tool| self.subagents.by_tool.get(tool))
            .cloned();
        let owner_model = owner
            .as_ref()
            .and_then(|t| self.subagents.by_task.get(t))
            .and_then(|s| s.task["model"].as_str())
            .map(str::to_string);
        let (model, effort) = match launch {
            Some(l) => (l.model.or(owner_model), l.effort),
            None => (owner_model, None),
        };
        self.update_subagent(
            Update {
                task_id,
                tool_use_id,
                status: "running",
                workflow_name: msg
                    .workflow_name
                    .as_deref()
                    .filter(|_| msg.task_type.as_deref() == Some("local_workflow"))
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned),
                workflow_frame: if msg.task_type.as_deref() == Some("local_workflow") {
                    json!({"workflow_progress":msg.workflow_progress,"usage":msg.usage})
                } else {
                    Value::Null
                },
                prompt: msg.prompt.clone(),
                title: msg.description.clone(),
                model,
                effort,
                owner_task_id: owner,
                reopen: true,
                ..Update::default()
            },
            out,
        );
        for frame in self.subagents.take_frames(tool_use_id) {
            self.on_child_frame(frame, tool_use_id, out);
        }
    }

    pub(super) fn on_task_progress(&mut self, msg: &SystemMsg, out: &mut Vec<Out>) {
        let Some(task_id) = &msg.task_id else {
            return;
        };
        let tool_use_id = msg
            .tool_use_id
            .clone()
            .or_else(|| {
                self.subagents
                    .by_task
                    .get(task_id)
                    .map(|s| s.tool_use_id.clone())
            })
            .unwrap_or_default();
        let tool_use_id = tool_use_id.as_str();
        let progress = msg.description.as_deref().map(str::trim).unwrap_or("");
        let running = self
            .subagents
            .by_task
            .get(task_id)
            .is_some_and(Sub::running);
        let frame = json!({"workflow_progress":msg.workflow_progress,"usage":msg.usage});
        let coordinator = self
            .subagents
            .by_task
            .get(task_id)
            .is_some_and(|s| s.task["workflow"].is_object());
        if !running
            || (!super::workflows::has_snapshot(&frame) && (progress.is_empty() || coordinator))
        {
            return;
        }
        let skip_parent_turn = self.turn.is_none()
            && self.last_ctx.as_ref().is_none_or(|ctx| {
                self.subagents
                    .by_task
                    .get(task_id)
                    .is_some_and(|sub| sub.parent.run_id != ctx.run_id)
            });
        if skip_parent_turn && (!coordinator || !super::workflows::has_snapshot(&frame)) {
            return;
        }
        self.update_subagent(
            Update {
                task_id,
                tool_use_id,
                status: "running",
                progress: (!progress.is_empty()).then(|| progress.to_string()),
                workflow_frame: frame,
                skip_parent_turn,
                ..Update::default()
            },
            out,
        );
    }

    pub(super) fn on_task_notification(&mut self, msg: &SystemMsg, out: &mut Vec<Out>) {
        let Some(task_id) = &msg.task_id else {
            return;
        };
        let Some(sub) = self.subagents.by_task.get(task_id) else {
            return;
        };
        let tool_use_id = msg.tool_use_id.clone().unwrap_or(sub.tool_use_id.clone());
        let status = match msg.status.as_ref().and_then(Value::as_str) {
            Some("completed") => "completed",
            Some("stopped") => "cancelled",
            _ => "failed",
        };
        self.update_subagent(
            Update {
                task_id,
                tool_use_id: &tool_use_id,
                status,
                result: msg.summary.clone(),
                workflow_frame: json!({"workflow_progress":msg.workflow_progress,"usage":msg.usage}),
                ..Update::default()
            },
            out,
        );
    }

    /// A root `tool_result` for an `Agent` tool_use settles a foreground subagent. Returns
    /// whether the result belonged to a subagent.
    pub(super) fn settle_agent_result(
        &mut self,
        tool_use_id: &str,
        content: &Value,
        is_error: bool,
        structured: Option<&Value>,
        out: &mut Vec<Out>,
    ) -> bool {
        let Some(task_id) = self.subagents.by_tool.get(tool_use_id).cloned() else {
            return false;
        };
        if let Some(handles) = structured.and_then(super::workflows::handles) {
            self.update_subagent(
                Update {
                    task_id: &task_id,
                    tool_use_id,
                    status: "running",
                    workflow_handles: Some(handles),
                    ..Update::default()
                },
                out,
            );
            return false;
        }
        if !is_error && is_async_ack(structured, content) {
            return true;
        }
        if self
            .subagents
            .by_task
            .get(&task_id)
            .is_some_and(|s| s.task["workflow"].is_object())
        {
            return false;
        }
        // The structured result holds the subagent's own text; the tool_result wraps it.
        let text = structured
            .and_then(|s| s.get("content"))
            .map(result_text)
            .filter(|t| !t.is_empty())
            .unwrap_or_else(|| result_text(content));
        self.update_subagent(
            Update {
                task_id: &task_id,
                tool_use_id,
                status: if is_error { "failed" } else { "completed" },
                result: (!text.is_empty()).then_some(text),
                ..Update::default()
            },
            out,
        );
        true
    }

    /// A retired query must leave the replacement query's tasks and turn alone.
    pub(crate) fn end_process_subagents(&mut self, generation: u64, stopped: bool) -> Vec<Out> {
        let mut out = Vec::new();
        let running: Vec<(String, String)> = self
            .subagents
            .by_task
            .iter()
            .filter(|(_, sub)| sub.running() && sub.process_generation == generation)
            .map(|(id, sub)| (id.clone(), sub.tool_use_id.clone()))
            .collect();
        for (task_id, tool_use_id) in running {
            self.update_subagent(
                Update {
                    task_id: &task_id,
                    tool_use_id: &tool_use_id,
                    status: if stopped { "cancelled" } else { "failed" },
                    ..Update::default()
                },
                &mut out,
            );
        }
        out
    }

    /// The session ended: every running subagent ends with it.
    pub(super) fn end_running_subagents(&mut self, status: &str, out: &mut Vec<Out>) {
        let running: Vec<(String, String)> = self
            .subagents
            .by_task
            .iter()
            .filter(|(_, s)| s.running())
            .map(|(id, s)| (id.clone(), s.tool_use_id.clone()))
            .collect();
        for (task_id, tool_use_id) in running {
            self.update_subagent(
                Update {
                    task_id: &task_id,
                    tool_use_id: &tool_use_id,
                    status,
                    ..Update::default()
                },
                out,
            );
        }
    }

    /// A frame with `parent_tool_use_id`: the subagent's own conversation.
    pub(super) fn on_child_frame(&mut self, frame: Inbound, parent: &str, out: &mut Vec<Out>) {
        let Some(task_id) = self.subagents.by_tool.get(parent).cloned() else {
            if let Inbound::Assistant(msg) = &frame {
                let model = msg.message.model.as_deref().unwrap_or("").trim();
                if !model.is_empty()
                    && model != "<synthetic>"
                    && !self.subagents.launches.contains_key(parent)
                {
                    self.subagents.remember_launch(
                        parent,
                        Launch {
                            model: Some(crate::catalog::resolve_slug(model)),
                            effort: None,
                            owner_tool_use_id: None,
                        },
                    );
                }
            }
            if matches!(frame, Inbound::Assistant(_) | Inbound::User(_)) {
                self.subagents.hold_frame(parent, frame);
            }
            return;
        };
        match frame {
            Inbound::Assistant(msg) => self.on_child_assistant(&task_id, parent, msg, out),
            Inbound::User(msg) => self.on_child_user(&task_id, msg, out),
            _ => {}
        }
    }

    fn on_child_assistant(
        &mut self,
        task_id: &str,
        parent: &str,
        msg: AssistantMsg,
        out: &mut Vec<Out>,
    ) {
        let now = self.env.now();
        let raw = msg.message.model.as_deref().unwrap_or_default().trim();
        let model = if raw.is_empty() || raw == "<synthetic>" {
            raw.to_string()
        } else {
            crate::catalog::resolve_slug(raw)
        };
        let Some(sub) = self.subagents.by_task.get(task_id) else {
            return;
        };
        let model_changed = {
            !model.is_empty()
                && model != "<synthetic>"
                && sub.running()
                && sub.task["model"].as_str() != Some(model.as_str())
        };
        if model_changed {
            self.update_subagent(
                Update {
                    task_id,
                    tool_use_id: parent,
                    status: "running",
                    model: Some(model),
                    ..Update::default()
                },
                out,
            );
        }
        let mut texts = Vec::new();
        for (index, block) in msg.message.content.iter().enumerate() {
            match block {
                Block::Thinking { thinking } if !thinking.trim().is_empty() => {
                    let Some(sub) = self.subagents.by_task.get_mut(task_id) else {
                        return;
                    };
                    let native = format!("{}:thinking:{index}", msg.uuid);
                    let ordinal = sub.next_ordinal();
                    out.push(turn_item(json!({
                        "id": ids::turn_item_from_item(DRIVER, &native), "threadId": sub.child_thread_id,
                        "runId": null, "nodeId": sub.child_root, "providerThreadId": null,
                        "providerTurnId": null,
                        "nativeItemRef": {"driver": DRIVER, "nativeId": native, "strength": "strong"},
                        "parentItemId": null, "ordinal": ordinal, "type": "reasoning",
                        "title": "Thinking", "text": thinking, "streaming": false,
                        "status": "completed", "startedAt": now, "completedAt": now, "updatedAt": now,
                    })));
                }
                Block::Text { text } if !text.trim().is_empty() => texts.push(text.clone()),
                Block::ToolUse { id, name, input } if name == "Agent" => {
                    self.remember_agent_launch(id, input, Some(parent));
                }
                Block::ToolUse { id, name, input } => {
                    let Some(sub) = self.subagents.by_task.get_mut(task_id) else {
                        return;
                    };
                    if sub.tools.contains_key(id) {
                        continue;
                    }
                    let call = ToolCall {
                        name: name.clone(),
                        input: input.clone(),
                        ordinal: sub.next_ordinal(),
                        started_at: now.clone(),
                        presentation: super::presentation::for_tool_use(
                            name,
                            id,
                            msg.tool_use_meta.as_ref(),
                        ),
                    };
                    sub.tools.insert(id.clone(), call.clone());
                    sub.tool_order.push(id.clone());
                    tool_artifacts(
                        &sub.child_scope(),
                        id,
                        &call,
                        "running",
                        None,
                        None,
                        &now,
                        out,
                    );
                }
                _ => {}
            }
        }
        if texts.is_empty() {
            return;
        }
        let text = texts.join("\n\n");
        let Some(sub) = self.subagents.by_task.get_mut(task_id) else {
            return;
        };
        let same = sub.last_message_id.as_deref() == Some(msg.message.id.as_str());
        sub.last_text = Some(match (&sub.last_text, same) {
            (Some(prev), true) => format!("{prev}\n{text}"),
            _ => text.clone(),
        });
        sub.last_message_id = Some(msg.message.id.clone());
        let ordinal = sub.next_ordinal();
        let (thread, root) = (sub.child_thread_id.clone(), sub.child_root.clone());
        child_message(
            &thread,
            &root,
            &msg.uuid,
            "assistant",
            &text,
            ordinal,
            None,
            None,
            &now,
            out,
        );
    }

    fn on_child_user(&mut self, task_id: &str, msg: UserMsg, out: &mut Vec<Out>) {
        let now = self.env.now();
        let UserContent::Blocks(blocks) = &msg.message.content else {
            return;
        };
        for block in blocks {
            let Block::ToolResult {
                tool_use_id,
                content,
                is_error,
            } = block
            else {
                continue;
            };
            if self.subagents.is_subagent_tool(tool_use_id) {
                self.settle_agent_result(tool_use_id, content, *is_error, None, out);
                continue;
            }
            let Some(sub) = self.subagents.by_task.get_mut(task_id) else {
                return;
            };
            let Some(call) = sub.tools.remove(tool_use_id) else {
                continue;
            };
            sub.tool_order.retain(|id| id != tool_use_id);
            let kind = msg
                .tool_result_meta
                .iter()
                .flatten()
                .find(|m| m.id == *tool_use_id)
                .and_then(|m| m.non_execution_kind.clone());
            let status = match kind.as_deref() {
                Some("cancelled") => "cancelled",
                Some("interrupted") => "interrupted",
                _ if *is_error => "failed",
                _ => "completed",
            };
            let output = tool_output(&call.name, None, content);
            tool_artifacts(
                &sub.child_scope(),
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

    /// `updateClaudeSubagentNode`.
    pub(super) fn update_subagent(&mut self, input: Update<'_>, out: &mut Vec<Out>) {
        let now = self.env.now();
        let existing = self.subagents.by_task.contains_key(input.task_id);
        if !existing && input.status != "running" {
            return;
        }
        let mut is_reopen = false;
        let mut prior_status = String::new();
        let current_parent = self.parent_ctx();
        if let Some(sub) = self.subagents.by_task.get_mut(input.task_id) {
            prior_status = sub.task["status"].as_str().unwrap_or("").to_string();
            let terminal = prior_status != "running";
            if terminal && input.status == "running" && !input.reopen {
                return;
            }
            is_reopen = terminal && input.reopen && input.status == "running";
            // A resumed subagent (SendMessage) runs in the turn that resumed it.
            if is_reopen && let Some(parent) = current_parent {
                sub.parent = parent;
                sub.process_generation = self.process_generation;
            }
        } else {
            let Some(parent) = self.parent_ctx() else {
                return;
            };
            let item_native = format!("task:{}:subagent", input.task_id);
            let item_ordinal = match &mut self.turn {
                Some(turn) => ordinal(turn, &item_native),
                None => 0,
            };
            let parent_node = input
                .owner_task_id
                .as_ref()
                .and_then(|t| self.subagents.by_task.get(t))
                .map(|s| s.node_id.clone())
                .unwrap_or(parent.root_node_id.clone());
            let node_id = ids::node_from_item(DRIVER, &format!("task:{}", input.task_id));
            let child_thread_id =
                subagent_thread_id(&format!("{}:{}", parent.provider_thread_id, input.task_id));
            let task = json!({
                "id": node_id, "threadId": parent.thread_id, "runId": parent.run_id,
                "parentNodeId": parent_node, "origin": "provider_native", "createdBy": "agent",
                "driver": DRIVER, "providerInstanceId": parent.instance_id,
                "providerThreadId": null, "childThreadId": child_thread_id,
                "nativeTaskRef": {"driver": DRIVER, "nativeId": input.task_id, "strength": "strong"},
                "prompt": input.prompt.clone().unwrap_or_default(), "title": input.title,
                "model": null, "status": "running", "result": null, "startedAt": now,
                "completedAt": null, "updatedAt": now,
            });
            if let Some(turn) = &mut self.turn {
                turn.had_subagents = true;
            }
            self.subagents
                .by_tool
                .insert(input.tool_use_id.to_string(), input.task_id.to_string());
            self.subagents.by_task.insert(
                input.task_id.to_string(),
                Sub {
                    tool_use_id: input.tool_use_id.to_string(),
                    node_id,
                    child_root: ids::node_from_item(
                        DRIVER,
                        &format!("task:{}:thread-root", input.task_id),
                    ),
                    item_id: ids::turn_item_from_item(DRIVER, &item_native),
                    child_thread_id,
                    item_ordinal,
                    next_child: 100,
                    result_ordinal: None,
                    task,
                    parent,
                    child_thread_created: false,
                    last_text: None,
                    last_message_id: None,
                    tools: HashMap::new(),
                    tool_order: Vec::new(),
                    effort: input.effort.clone(),
                    members: HashMap::new(),
                    stop_requested: false,
                    process_generation: self.process_generation,
                },
            );
        }
        let lifecycle_changed = !existing
            || prior_status != input.status
            || (input.reopen && input.status == "running");
        let ordinal_for_title = self.subagents.opened;
        if !existing {
            self.subagents.opened += 1;
        }
        let Some(sub) = self.subagents.by_task.get_mut(input.task_id) else {
            return;
        };

        // The task row.
        if let Some(workflow) = super::workflows::merge(
            sub.task.get("workflow"),
            input.workflow_name.as_deref(),
            input.workflow_handles.as_ref(),
            &input.workflow_frame,
            &sub.child_thread_id,
        ) {
            sub.task["workflow"] = workflow;
        }
        let task = &mut sub.task;
        task["status"] = json!(input.status);
        if is_reopen {
            sub.stop_requested = false;
            task["runId"] = json!(sub.parent.run_id);
            task["startedAt"] = json!(now);
            task["result"] = Value::Null;
            if let Some(map) = task.as_object_mut() {
                map.remove("progress");
            }
        }
        if let Some(prompt) = &input.prompt {
            task["prompt"] = json!(prompt);
        }
        if let Some(title) = &input.title {
            task["title"] = json!(title);
        }
        if let Some(model) = &input.model {
            task["model"] = json!(model);
        }
        let model = task["model"]
            .as_str()
            .filter(|m| !m.is_empty())
            .unwrap_or(&sub.parent.root_model)
            .to_string();
        let mut selection = json!({"instanceId": sub.parent.instance_id, "model": model});
        if let Some(effort) = &sub.effort {
            selection["options"] = json!([{"id": "effort", "value": effort}]);
        }
        task["modelSelection"] = selection;
        if let Some(progress) = input.progress.as_ref().filter(|_| !is_reopen) {
            task["progress"] = json!(progress);
        }
        if let Some(result) = &input.result {
            task["result"] = json!(result);
        }
        task["completedAt"] = if input.status == "running" {
            Value::Null
        } else if task["completedAt"].is_null() {
            json!(now)
        } else {
            task["completedAt"].clone()
        };
        task["updatedAt"] = json!(now);
        let task = task.clone();

        // 1. The child thread.
        if !sub.child_thread_created {
            sub.child_thread_created = true;
            if let Some(thread) = child_app_thread(sub, &task, ordinal_for_title, &now) {
                out.push(event(ProviderEvent::AppThreadCreated {
                    app_thread: thread,
                    create_only: existing.then_some(true),
                }));
            }
        }
        // 2. The subagent's node in the parent turn.
        if lifecycle_changed {
            emit(
                out,
                |v| ProviderEvent::NodeUpdated { node: v },
                json!({
                    "id": sub.node_id, "threadId": task["threadId"], "runId": task["runId"],
                    "parentNodeId": task["parentNodeId"], "rootNodeId": sub.parent.root_node_id,
                    "kind": "subagent", "status": input.status, "countsForRun": false,
                    "providerThreadId": sub.parent.provider_thread_id,
                    "providerTurnId": sub.parent.provider_turn_id,
                    "nativeItemRef": task["nativeTaskRef"], "runtimeRequestId": null,
                    "checkpointScopeId": null, "startedAt": task["startedAt"],
                    "completedAt": task["completedAt"],
                }),
            );
        }
        // 3. The subagent.
        if let Ok(subagent) = from_json(task.clone()) {
            out.push(event(ProviderEvent::SubagentUpdated { subagent }));
        }
        // 4. The child thread's root node.
        if lifecycle_changed {
            emit(
                out,
                |v| ProviderEvent::NodeUpdated { node: v },
                json!({
                    "id": sub.child_root, "threadId": sub.child_thread_id, "runId": null,
                    "parentNodeId": null, "rootNodeId": sub.child_root, "kind": "root_turn",
                    "status": input.status, "countsForRun": false, "providerThreadId": null,
                    "providerTurnId": null, "nativeItemRef": task["nativeTaskRef"],
                    "runtimeRequestId": null, "checkpointScopeId": null,
                    "startedAt": task["startedAt"], "completedAt": task["completedAt"],
                }),
            );
        }
        // 5. The prompt, as the child thread's first message. A resume (`SendMessage`) names
        // its own call and brings the sent message as the prompt: another user message.
        let resume_tool = (existing
            && is_reopen
            && input.tool_use_id != sub.tool_use_id
            && input.prompt.is_some())
        .then(|| input.tool_use_id.to_string());
        if let Some(resume_tool) = resume_tool {
            let prompt = task["prompt"].as_str().unwrap_or("").to_string();
            let native = format!("task:{}:prompt:{resume_tool}", input.task_id);
            let sender = sub.parent.thread_id.clone();
            let ordinal = sub.next_ordinal();
            child_message(
                &sub.child_thread_id,
                &sub.child_root,
                &native,
                "user",
                &prompt,
                ordinal,
                Some(&sender),
                Some(false),
                &now,
                out,
            );
        }
        if !existing {
            let prompt = task["prompt"].as_str().unwrap_or("").to_string();
            let native = format!("task:{}:prompt", input.task_id);
            let sender = sub.parent.thread_id.clone();
            child_message(
                &sub.child_thread_id,
                &sub.child_root,
                &native,
                "user",
                &prompt,
                100,
                Some(&sender),
                Some(task["workflow"].is_object()),
                &now,
                out,
            );
        }
        project_workflow_members(sub, &task, &now, out);
        // 6. The subagent row in the parent turn.
        if !input.skip_parent_turn {
            let mut item = json!({
                "id": sub.item_id, "threadId": task["threadId"], "runId": task["runId"],
                "nodeId": task["id"], "providerThreadId": sub.parent.provider_thread_id,
                "providerTurnId": sub.parent.provider_turn_id, "nativeItemRef": task["nativeTaskRef"],
                "parentItemId": null, "ordinal": sub.item_ordinal, "status": task["status"],
                "title": task["title"], "startedAt": task["startedAt"],
                "completedAt": task["completedAt"], "updatedAt": task["updatedAt"],
                "type": "subagent", "subagentId": task["id"], "origin": task["origin"],
                "driver": task["driver"], "providerInstanceId": task["providerInstanceId"],
                "childThreadId": task["childThreadId"], "prompt": task["prompt"],
                "result": task["result"],
            });
            if let Some(progress) = task.get("progress") {
                item["progress"] = progress.clone();
            }
            out.push(turn_item(item));
        }
        // 7. The result, as the child thread's last message, unless the last reply said it.
        let result = input.result.as_deref().map(str::trim).unwrap_or("");
        let shown = input.status == "completed"
            && sub
                .last_text
                .as_deref()
                .is_some_and(|t| normalize(t) == normalize(result));
        if !result.is_empty() && input.status != "running" && !shown {
            let ordinal = match sub.result_ordinal {
                Some(o) => o,
                None => {
                    let o = sub.next_ordinal();
                    sub.result_ordinal = Some(o);
                    o
                }
            };
            let native = format!("task:{}:result", input.task_id);
            let (thread, root) = (sub.child_thread_id.clone(), sub.child_root.clone());
            child_message(
                &thread,
                &root,
                &native,
                "assistant",
                result,
                ordinal,
                None,
                None,
                &now,
                out,
            );
        }
        // A settled subagent ends its open tool calls.
        if input.status != "running" {
            let status = if input.status == "cancelled" {
                "interrupted"
            } else {
                "failed"
            };
            let scope = sub.child_scope();
            for id in std::mem::take(&mut sub.tool_order) {
                if let Some(call) = sub.tools.remove(&id) {
                    tool_artifacts(&scope, &id, &call, status, None, None, &now, out);
                }
            }
        }
    }
}

/// `makeSubagentChildThread`: the parent app thread with the child's identity.
fn child_app_thread(sub: &Sub, task: &Value, ordinal: u32, now: &str) -> Option<AppThread> {
    let mut thread = sub.parent.app_thread.clone();
    let parent_title = thread["title"].as_str().unwrap_or("").to_string();
    let map = thread.as_object_mut()?;
    map.remove("historyOrigin");
    let workflow_title = task.get("workflow").map(|w| {
        format!(
            "Workflow · {}",
            w["name"]
                .as_str()
                .or_else(|| task["title"].as_str())
                .unwrap_or("Untitled")
        )
    });
    let title = child_title(
        &parent_title,
        workflow_title.as_deref().or_else(|| task["title"].as_str()),
        task["prompt"].as_str().unwrap_or(""),
        ordinal,
    );
    let root = sub.parent.app_thread["lineage"]["rootThreadId"].clone();
    for (key, value) in [
        ("createdBy", json!("agent")),
        ("creationSource", json!("provider")),
        ("id", json!(sub.child_thread_id)),
        ("title", json!(title)),
        ("titleRegeneration", Value::Null),
        ("titleRenamed", json!(false)),
        ("linkedPullRequest", Value::Null),
        ("pullRequests", json!([])),
        ("providerInstanceId", json!(sub.parent.instance_id)),
        ("modelSelection", task["modelSelection"].clone()),
        ("activeProviderThreadId", Value::Null),
        (
            "lineage",
            json!({"parentThreadId": sub.parent.thread_id, "relationshipToParent": "subagent", "rootThreadId": root}),
        ),
        ("forkedFrom", json!({"type": "node", "nodeId": sub.node_id})),
        ("createdAt", json!(now)),
        ("updatedAt", json!(now)),
    ] {
        map.insert(key.into(), value);
    }
    for key in [
        "archivedAt",
        "settledOverride",
        "settledAt",
        "snoozedUntil",
        "snoozedAt",
        "pinnedAt",
        "pinOrderKey",
        "autoSettleDisabledAt",
        "guestShare",
        "lastVisitedAt",
        "deletedAt",
    ] {
        map.insert(key.into(), Value::Null);
    }
    from_json(thread).ok()
}

/// `makeSubagentConversationArtifacts`: a message and its turn item in the child thread.
#[expect(clippy::too_many_arguments, reason = "the fields of one contract row")]
fn child_message(
    thread_id: &str,
    root: &str,
    native_id: &str,
    role: &str,
    text: &str,
    ordinal: u32,
    sender: Option<&str>,
    workflow_script: Option<bool>,
    now: &str,
    out: &mut Vec<Out>,
) {
    let message_id = ids::message_from_item(DRIVER, native_id);
    let mut message = json!({
        "createdBy": "agent", "creationSource": "provider", "id": message_id,
        "threadId": thread_id, "runId": null, "nodeId": root, "role": role, "text": text,
        "attachments": [], "streaming": false, "createdAt": now, "updatedAt": now,
    });
    let mut item = json!({
        "id": ids::turn_item_from_item(DRIVER, native_id), "threadId": thread_id, "runId": null,
        "nodeId": root, "providerThreadId": null, "providerTurnId": null,
        "nativeItemRef": {"driver": DRIVER, "nativeId": native_id, "strength": "strong"},
        "parentItemId": null, "ordinal": ordinal, "status": "completed", "title": null,
        "startedAt": now, "completedAt": now, "updatedAt": now, "messageId": message_id,
        "text": text,
    });
    if role == "user" {
        if let Some(sender) = sender {
            message["senderThreadId"] = json!(sender);
            item["senderThreadId"] = json!(sender);
        }
        if let Some(script) = workflow_script {
            message["workflowScript"] = json!(script);
            item["workflowScript"] = json!(script);
        }
        item["createdBy"] = json!("agent");
        item["creationSource"] = json!("provider");
        item["type"] = json!("user_message");
        item["inputIntent"] = json!("turn_start");
        item["attachments"] = json!([]);
    } else {
        item["type"] = json!("assistant_message");
        item["streaming"] = json!(false);
    }
    if let Ok(message) = from_json(message) {
        out.push(event(ProviderEvent::MessageUpdated { message }));
    }
    if let Ok(item) = from_json(item) {
        out.push(event(ProviderEvent::TurnItemUpdated { turn_item: item }));
    }
}

fn project_workflow_members(sub: &mut Sub, coordinator: &Value, now: &str, out: &mut Vec<Out>) {
    let Some(agents) = coordinator["workflow"]["agents"].as_array() else {
        return;
    };
    let Some(parent) = child_app_thread(sub, coordinator, 0, now)
        .map(|t| serde_json::to_value(t).unwrap_or(Value::Null))
    else {
        return;
    };
    for agent in agents {
        let Some(index) = agent["index"].as_u64() else {
            continue;
        };
        let previous = sub.members.get(&index);
        let key = format!("{}:agent:{index}", sub.child_thread_id);
        let child = agent["childThreadId"].as_str().unwrap_or_default();
        let root = ids::node_from_item(DRIVER, &format!("{key}:thread-root"));
        let node = ids::node_from_item(DRIVER, &key);
        let reported = agent["state"].as_str().unwrap_or("running");
        let status =
            if matches!(reported, "queued" | "running") && coordinator["status"] != "running" {
                coordinator["status"].as_str().unwrap_or("cancelled")
            } else if reported == "queued" {
                "pending"
            } else if reported == "failed"
                && sub.stop_requested
                && previous.is_none_or(|p| p["status"] != "failed")
            {
                "cancelled"
            } else {
                reported
            };
        let settled = !matches!(status, "pending" | "running");
        let attempt = agent["attempt"]
            .as_u64()
            .or_else(|| previous.and_then(|p| p["attempt"].as_u64()))
            .unwrap_or(1);
        let restarted = previous.is_some_and(|p| attempt > p["attempt"].as_u64().unwrap_or(1));
        let prompt = agent["prompt"]
            .as_str()
            .or_else(|| agent["label"].as_str())
            .unwrap_or_default();
        let model = agent["model"]
            .as_str()
            .or_else(|| parent["modelSelection"]["model"].as_str())
            .unwrap_or_default();
        let created = previous
            .and_then(|p| p["createdAt"].as_str())
            .unwrap_or(now);
        let date = |field: &str| {
            agent[field]
                .as_i64()
                .map(|n| json!(conn_support::time::iso_from_millis(n)))
        };
        let started = if status == "pending" {
            Value::Null
        } else {
            date("startedAt")
                .or_else(|| {
                    (!restarted)
                        .then(|| previous.map(|p| p["startedAt"].clone()))
                        .flatten()
                        .filter(|v| !v.is_null())
                })
                .unwrap_or_else(|| {
                    if status == "running" {
                        json!(now)
                    } else {
                        Value::Null
                    }
                })
        };
        let completed = if settled {
            date("completedAt")
                .or_else(|| {
                    (!restarted)
                        .then(|| previous.map(|p| p["completedAt"].clone()))
                        .flatten()
                        .filter(|v| !v.is_null())
                })
                .unwrap_or_else(|| json!(now))
        } else {
            Value::Null
        };
        let mut next_ordinal = previous
            .and_then(|p| p["nextOrdinal"].as_u64())
            .and_then(|n| u32::try_from(n).ok())
            .unwrap_or(100);
        let mut state = json!({"status":status,"attempt":attempt,"prompt":prompt,"label":agent["label"],"model":model,"result":agent["result"],"startedAt":started,"completedAt":completed,"createdAt":created,"nextOrdinal":next_ordinal});
        if previous == Some(&state) {
            continue;
        }
        if previous.is_none_or(|p| p["label"] != agent["label"] || p["model"] != model) {
            let mut thread = parent.clone();
            thread["id"] = json!(child);
            thread["title"] = agent["label"].clone();
            thread["lineage"]["parentThreadId"] = json!(sub.child_thread_id);
            thread["forkedFrom"] = json!({"type":"node","nodeId":node});
            thread["modelSelection"] = json!({"instanceId":sub.parent.instance_id,"model":model});
            thread["createdAt"] = json!(created);
            emit(
                out,
                |app_thread| ProviderEvent::AppThreadCreated {
                    app_thread,
                    create_only: None,
                },
                thread,
            );
        }
        if previous.is_none_or(|p| p["prompt"] != prompt) {
            child_message(
                child,
                &root,
                &format!("{key}:prompt"),
                "user",
                prompt,
                100,
                None,
                None,
                now,
                out,
            );
        }
        let task = json!({"id":node,"threadId":sub.child_thread_id,"runId":null,"parentNodeId":sub.child_root,"origin":"provider_native","createdBy":"agent","driver":DRIVER,"providerInstanceId":sub.parent.instance_id,"providerThreadId":null,"childThreadId":child,"nativeTaskRef":{"driver":DRIVER,"nativeId":key,"strength":"strong"},"prompt":prompt,"title":agent["label"],"model":model,"status":status,"result":agent["result"],"startedAt":started,"completedAt":completed,"updatedAt":now});
        for (id, thread, parent, kind) in [
            (
                &node,
                sub.child_thread_id.as_str(),
                json!(sub.child_root),
                "subagent",
            ),
            (&root, child, Value::Null, "root_turn"),
        ] {
            emit(
                out,
                |node| ProviderEvent::NodeUpdated { node },
                json!({"id":id,"threadId":thread,"runId":null,"parentNodeId":parent,"rootNodeId":if kind=="subagent" {&sub.child_root} else {&root},"kind":kind,"status":status,"countsForRun":false,"providerThreadId":null,"providerTurnId":null,"nativeItemRef":task["nativeTaskRef"],"runtimeRequestId":null,"checkpointScopeId":null,"startedAt":started,"completedAt":completed}),
            );
        }
        emit(
            out,
            |subagent| ProviderEvent::SubagentUpdated { subagent },
            task,
        );
        if settled
            && let Some(result) = agent["result"].as_str()
            && previous.is_none_or(|p| p["result"].is_null() || restarted)
        {
            next_ordinal = next_ordinal.saturating_add(1);
            child_message(
                child,
                &root,
                &format!("{key}:result:{attempt}"),
                "assistant",
                &format!("Partial answer from workflow progress:\n\n{result}"),
                next_ordinal,
                None,
                None,
                now,
                out,
            );
        }
        state["nextOrdinal"] = json!(next_ordinal);
        sub.members.insert(index, state);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titles_follow_subagent_thread_title() {
        assert_eq!(child_title("Parent", Some(" Audit "), "p", 1), "Audit");
        assert_eq!(child_title("Parent", None, "  ", 3), "Parent subagent 3");
        let long = "x".repeat(80);
        assert_eq!(child_title("P", Some(&long), "", 0).chars().count(), 72);
    }

    #[test]
    fn result_text_drops_the_tools_note() {
        let content = json!([{"type": "text", "text": "<tools-used-before-summary>Bash</tools-used-before-summary>\nDone."}]);
        assert_eq!(result_text(&content), "Done.");
    }
}
