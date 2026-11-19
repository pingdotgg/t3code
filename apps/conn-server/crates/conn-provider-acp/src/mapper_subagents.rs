//! Native subagents of the root turn (`emitSubagent`, `emitSubagentAssistant`,
//! `projectSubagentNotification`, `projectSubagentTool`, `finishSubagentFromNotice` and the
//! child-session branch of `handleSessionUpdate` in T3's `adapter.ts`).
//!
//! A spawn tool becomes a subagent row in the parent thread and a child app thread with the
//! prompt; once the child's ACP session id is known, the child's assistant text and tools
//! show in the child thread. Bounds: subagents and their state live in the turn and go with
//! it; held child notifications are capped per child session ([`HELD_PER_SESSION`]; T3 keeps
//! all).

use std::collections::{HashMap, HashSet};

use conn_provider_support::ids::{self, Env, join_id};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::{Mapper, Out, content_display_text, set};
use crate::grok_background::{SubagentUpdate, subagent_status_is_terminal};
use crate::tools::{self, ToolState};

/// Child notifications held until the child's session id is known.
const HELD_PER_SESSION: usize = 1024;
/// `subagentThreadTitle`'s limit.
const TITLE_MAX_CHARS: usize = 72;

/// `ActiveAcpSubagent`.
#[derive(Debug, Clone)]
pub(super) struct Subagent {
    /// `OrchestrationV2Subagent`.
    pub(super) task: Value,
    child_thread_id: String,
    child_root_node_id: String,
    turn_item_id: String,
    turn_item_ordinal: u32,
    provider_turn_id: String,
    pub(super) child_session_id: Option<String>,
    assistant_text: String,
    assistant_messages: HashMap<String, String>,
    /// Messages whose latest text waits for a delayed flush (`pendingAssistantMessages`), in
    /// the order they started to wait.
    pending_assistant: Vec<String>,
    child_item_ordinals: HashMap<String, u32>,
    next_child_ordinal: u32,
    pub(super) terminal_status_projected: bool,
    tools: HashMap<String, ToolState>,
    tool_skips: HashMap<String, u32>,
    tool_started_at: HashMap<String, String>,
    interrupted_tool_ids: HashSet<String>,
}

impl Subagent {
    pub(super) fn status(&self) -> &str {
        self.task["status"].as_str().unwrap_or("")
    }

    fn native_task_id(&self) -> String {
        self.task["nativeTaskRef"]["nativeId"]
            .as_str()
            .or_else(|| self.task["id"].as_str())
            .unwrap_or("")
            .to_owned()
    }
}

/// The subagents of one turn.
#[derive(Debug, Default)]
pub(super) struct TurnSubagents {
    /// By native task id, in creation order (`subagents`).
    pub(super) list: Vec<(String, Subagent)>,
    /// Child session id → native task id (`subagentsBySessionId`).
    by_session: HashMap<String, String>,
    /// `pendingSubagentNotifications`.
    held: HashMap<String, Vec<Value>>,
}

impl TurnSubagents {
    fn get(&self, native_task_id: &str) -> Option<&Subagent> {
        self.list
            .iter()
            .find(|(id, _)| id == native_task_id)
            .map(|(_, s)| s)
    }

    fn get_mut(&mut self, native_task_id: &str) -> Option<&mut Subagent> {
        self.list
            .iter_mut()
            .find(|(id, _)| id == native_task_id)
            .map(|(_, s)| s)
    }

    pub(super) fn key_of_session(&self, session_id: &str) -> Option<String> {
        self.by_session.get(session_id).cloned()
    }

    fn put(&mut self, native_task_id: &str, subagent: Subagent) {
        match self.get_mut(native_task_id) {
            Some(existing) => *existing = subagent,
            None => self.list.push((native_task_id.to_owned(), subagent)),
        }
    }
}

/// `IdAllocator.derive.subagentThread`: `thread:subagent:` + 16 hex of a sha256 of the
/// legacy id.
fn subagent_thread_id(driver: &str, instance_id: &str, native_thread_id: &str) -> String {
    let legacy = join_id(
        "thread",
        &[
            "provider",
            driver,
            "provider-instance",
            instance_id,
            "native-thread",
            native_thread_id,
        ],
    );
    let digest = Sha256::digest(legacy.as_bytes());
    format!(
        "thread:subagent:{}",
        conn_support::hex::hex(digest.get(..8).unwrap_or(&[]))
    )
}

/// `subagentThreadTitle`.
fn child_title(parent_title: &str, title: Option<&str>, prompt: &str, ordinal: usize) -> String {
    let detail = title
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .unwrap_or(prompt.trim());
    if detail.is_empty() {
        return format!("{parent_title} subagent {ordinal}");
    }
    if detail.chars().count() <= TITLE_MAX_CHARS {
        return detail.to_owned();
    }
    let cut: String = detail.chars().take(TITLE_MAX_CHARS - 3).collect();
    format!("{cut}...")
}

/// `makeSubagentChildThread`: the parent app thread with the child's identity.
fn child_app_thread(
    parent: &Value,
    child_thread_id: &str,
    parent_node_id: &str,
    instance_id: &str,
    model_selection: Value,
    title: String,
    now: &str,
) -> Value {
    let mut thread = parent.clone();
    let root = parent["lineage"]["rootThreadId"].clone();
    let parent_thread_id = parent["id"].clone();
    if let Some(map) = thread.as_object_mut() {
        map.remove("historyOrigin");
        for (key, value) in [
            ("createdBy", json!("agent")),
            ("creationSource", json!("provider")),
            ("id", json!(child_thread_id)),
            ("title", json!(title)),
            ("titleRegeneration", Value::Null),
            ("titleRenamed", json!(false)),
            ("linkedPullRequest", Value::Null),
            ("pullRequests", json!([])),
            ("providerInstanceId", json!(instance_id)),
            ("modelSelection", model_selection),
            ("activeProviderThreadId", Value::Null),
            (
                "lineage",
                json!({"parentThreadId": parent_thread_id, "relationshipToParent": "subagent", "rootThreadId": root}),
            ),
            (
                "forkedFrom",
                json!({"type": "node", "nodeId": parent_node_id}),
            ),
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
    }
    thread
}

impl<E: Env> Mapper<E> {
    /// `providerMessageId` and peers for an unscoped native id (item identity version 2
    /// scopes it by the instance).
    fn child_message_id(&self, native_id: &str) -> String {
        ids::message_from_item(self.driver(), &self.scoped(native_id))
    }

    /// `makeSubagentConversationArtifacts`: a message and its turn item in the child thread.
    #[expect(clippy::too_many_arguments, reason = "the fields of one contract row")]
    fn child_message(
        &mut self,
        subagent_thread: &str,
        root_node: &str,
        provider_thread_id: Value,
        native_id: &str,
        role: &str,
        text: &str,
        ordinal: u32,
        sender: Option<&str>,
        now: &str,
        out: &mut Vec<Out>,
    ) {
        let message_id = self.child_message_id(native_id);
        let mut message = json!({
            "createdBy": "agent", "creationSource": "provider", "id": message_id,
            "threadId": subagent_thread, "runId": null, "nodeId": root_node, "role": role,
            "text": text, "attachments": [], "streaming": false, "createdAt": now, "updatedAt": now,
        });
        let mut item = json!({
            "id": self.turn_item_id(native_id), "threadId": subagent_thread, "runId": null,
            "nodeId": root_node, "providerThreadId": provider_thread_id, "providerTurnId": null,
            "nativeItemRef": {"driver": self.driver(), "nativeId": native_id, "strength": "weak"},
            "parentItemId": null, "ordinal": ordinal, "status": "completed", "title": null,
            "startedAt": now, "completedAt": now, "updatedAt": now, "messageId": message_id,
            "text": text,
        });
        if role == "user" {
            if let Some(sender) = sender {
                set(&mut message, "senderThreadId", json!(sender));
                set(&mut item, "senderThreadId", json!(sender));
            }
            set(&mut item, "createdBy", json!("agent"));
            set(&mut item, "creationSource", json!("provider"));
            set(&mut item, "type", json!("user_message"));
            set(&mut item, "inputIntent", json!("turn_start"));
            set(&mut item, "attachments", json!([]));
        } else {
            set(&mut item, "type", json!("assistant_message"));
            set(&mut item, "streaming", json!(false));
        }
        self.event(json!({"type": "message.updated", "message": message}), out);
        self.event(json!({"type": "turn_item.updated", "turnItem": item}), out);
    }

    /// `resolveSubagentChildOrdinal`.
    fn child_ordinal(subagent: &mut Subagent, key: &str) -> u32 {
        if let Some(ordinal) = subagent.child_item_ordinals.get(key) {
            return *ordinal;
        }
        let ordinal = subagent.next_child_ordinal;
        subagent.next_child_ordinal = subagent.next_child_ordinal.saturating_add(1);
        subagent.child_item_ordinals.insert(key.to_owned(), ordinal);
        ordinal
    }

    /// `emitSubagent`.
    pub(super) fn emit_subagent(&mut self, reported: SubagentUpdate, out: &mut Vec<Out>) {
        let Some(turn) = self.turn.as_ref() else {
            return;
        };
        // After Stop a failed subagent was interrupted.
        let mut update = reported;
        if turn.interrupted && update.status == "failed" {
            update.status = "interrupted".into();
        }
        let existing_key = turn
            .subagents
            .get(&update.native_task_id)
            .map(|_| update.native_task_id.clone())
            .or_else(|| {
                update
                    .child_session_id
                    .as_deref()
                    .and_then(|s| turn.subagents.key_of_session(s))
            });
        let existing = existing_key
            .as_deref()
            .and_then(|key| turn.subagents.get(key))
            .cloned();
        let terminal = subagent_status_is_terminal(&update.status);
        if let Some(existing) = &existing {
            if subagent_status_is_terminal(existing.status()) && !terminal {
                return;
            }
            if existing.status() == update.status && terminal && existing.terminal_status_projected
            {
                return;
            }
        } else {
            // Empty-prompt hydration must match existing lineage; only spawn ACKs create it.
            let hydration_only = update.prompt.is_empty() && update.title.is_none();
            if hydration_only || !update.suppress_normal_tool {
                return;
            }
        }
        let now = self.env.now();
        let driver = self.driver();
        let instance_id = self.instance_id.clone();
        let Some(turn) = self.turn.as_mut() else {
            return;
        };
        let native_task_id = existing
            .as_ref()
            .map(Subagent::native_task_id)
            .unwrap_or_else(|| update.native_task_id.clone());
        let native_ref =
            json!({"driver": driver, "nativeId": native_task_id, "strength": "strong"});
        let scoped = |id: &str| {
            format!(
                "provider-instance:{}:{id}",
                ids::encode_component(&instance_id)
            )
        };
        let node_id = existing
            .as_ref()
            .and_then(|e| e.task["id"].as_str().map(str::to_owned))
            .unwrap_or_else(|| ids::node_from_item(driver, &scoped(&native_task_id)));
        let child_thread_id = existing
            .as_ref()
            .map(|e| e.child_thread_id.clone())
            .unwrap_or_else(|| {
                subagent_thread_id(
                    driver,
                    &instance_id,
                    &format!("{}:task:{native_task_id}", turn.native_thread_id),
                )
            });
        let child_root_node_id = existing
            .as_ref()
            .map(|e| e.child_root_node_id.clone())
            .unwrap_or_else(|| {
                ids::node_from_item(driver, &scoped(&format!("{native_task_id}:child-root")))
            });
        let turn_item_id = existing
            .as_ref()
            .map(|e| e.turn_item_id.clone())
            .unwrap_or_else(|| ids::turn_item_from_item(driver, &scoped(&native_task_id)));
        let turn_item_ordinal = match &existing {
            Some(e) => e.turn_item_ordinal,
            None => Self::resolve_ordinal(turn, &native_task_id),
        };
        let model_selection = super::to_json(&turn.model_selection);
        let mut task = match &existing {
            Some(e) => e.task.clone(),
            None => json!({
                "id": node_id,
                "threadId": turn.thread_id,
                "runId": turn.run_id,
                "parentNodeId": turn.root_node_id,
                "origin": "provider_native",
                "createdBy": "agent",
                "driver": driver,
                "providerInstanceId": model_selection["instanceId"],
                "providerThreadId": null,
                "childThreadId": child_thread_id,
                "nativeTaskRef": native_ref,
                "prompt": update.prompt,
                "title": update.title,
                "result": null,
                "startedAt": now,
            }),
        };
        let model = update
            .model
            .as_deref()
            .map(str::trim)
            .filter(|m| !m.is_empty())
            .map(str::to_owned)
            .or_else(|| task["model"].as_str().map(str::to_owned));
        set(&mut task, "model", json!(model));
        set(&mut task, "status", json!(update.status));
        let result = update
            .result
            .clone()
            .map(Value::String)
            .unwrap_or_else(|| task["result"].clone());
        set(&mut task, "result", result);
        set(
            &mut task,
            "completedAt",
            if terminal { json!(now) } else { Value::Null },
        );
        set(&mut task, "updatedAt", json!(now));
        let mut subagent = existing.clone().unwrap_or_else(|| Subagent {
            task: Value::Null,
            child_thread_id: child_thread_id.clone(),
            child_root_node_id: child_root_node_id.clone(),
            turn_item_id: turn_item_id.clone(),
            turn_item_ordinal,
            provider_turn_id: turn.provider_turn_id.clone(),
            child_session_id: None,
            assistant_text: String::new(),
            assistant_messages: HashMap::new(),
            pending_assistant: Vec::new(),
            child_item_ordinals: HashMap::new(),
            next_child_ordinal: 101,
            terminal_status_projected: false,
            tools: HashMap::new(),
            tool_skips: HashMap::new(),
            tool_started_at: HashMap::new(),
            interrupted_tool_ids: HashSet::new(),
        });
        subagent.task = task;
        turn.subagents.put(&native_task_id, subagent.clone());
        let parent_thread_id = turn.thread_id.clone();
        let parent_provider_thread = turn.provider_thread["id"].clone();
        let parent_provider_turn = turn.provider_turn_id.clone();
        let count = turn.subagents.list.len();
        let app_thread = turn.app_thread.clone();

        if existing.is_none() {
            let mut selection = model_selection.clone();
            if let Some(model) = subagent.task["model"].as_str() {
                set(&mut selection, "model", json!(model));
            }
            let title = child_title(
                app_thread["title"].as_str().unwrap_or(""),
                update.title.as_deref(),
                &update.prompt,
                count,
            );
            let selection_instance = selection["instanceId"].as_str().unwrap_or("").to_owned();
            let thread = child_app_thread(
                &app_thread,
                &child_thread_id,
                &node_id,
                &selection_instance,
                selection,
                title,
                &now,
            );
            self.event(
                json!({"type": "app_thread.created", "appThread": thread}),
                out,
            );
            let prompt_id = format!("{native_task_id}:prompt");
            self.child_message(
                &child_thread_id,
                &child_root_node_id,
                Value::Null,
                &prompt_id,
                "user",
                &update.prompt,
                100,
                Some(&parent_thread_id),
                &now,
                out,
            );
        }

        if let Some(child_session) = update.child_session_id.clone()
            && subagent.child_session_id.is_none()
        {
            let provider_thread_id = join_id(
                "provider-thread",
                &[
                    "provider",
                    driver,
                    "provider-instance",
                    &instance_id,
                    "native-thread",
                    &child_session,
                ],
            );
            let provider_thread = json!({
                "id": provider_thread_id,
                "driver": driver,
                "providerInstanceId": instance_id,
                "providerSessionId": self.provider_session_id,
                "appThreadId": child_thread_id,
                "ownerNodeId": null,
                "nativeThreadRef": {"driver": driver, "nativeId": child_session, "strength": "strong"},
                "nativeConversationHeadRef": null,
                "status": "idle",
                "firstRunOrdinal": null,
                "lastRunOrdinal": null,
                "handoffIds": [],
                "forkedFrom": {"providerThreadId": parent_provider_thread, "providerTurnId": parent_provider_turn},
                "contextUsage": null,
                "nativeMetadata": {"itemIdentityVersion": 2},
                "createdAt": now,
                "updatedAt": now,
            });
            let held = self.turn.as_mut().map(|turn| {
                if let Some(sub) = turn.subagents.get_mut(&native_task_id) {
                    sub.child_session_id = Some(child_session.clone());
                    set(&mut sub.task, "providerThreadId", json!(provider_thread_id));
                }
                turn.subagents
                    .by_session
                    .insert(child_session.clone(), native_task_id.clone());
                turn.subagents
                    .held
                    .remove(&child_session)
                    .unwrap_or_default()
            });
            self.event(
                json!({"type": "provider_thread.updated", "providerThread": provider_thread}),
                out,
            );
            for notification in held.unwrap_or_default() {
                self.project_subagent_notification(&native_task_id, &notification, out);
            }
        }
        self.flush_subagent_assistant(&native_task_id, out);

        let Some(mut subagent) = self
            .turn
            .as_ref()
            .and_then(|t| t.subagents.get(&native_task_id))
            .cloned()
        else {
            return;
        };
        if update.status != "running"
            && subagent.assistant_text.is_empty()
            && let Some(result) = &update.result
        {
            self.emit_subagent_assistant(&native_task_id, result, false, None, out);
            if let Some(fresh) = self
                .turn
                .as_ref()
                .and_then(|t| t.subagents.get(&native_task_id))
                .cloned()
            {
                subagent = fresh;
            }
        }
        let result = update
            .result
            .clone()
            .map(Value::String)
            .or_else(|| subagent.task["result"].as_str().map(|r| json!(r)))
            .unwrap_or_else(|| {
                if subagent.assistant_text.is_empty() {
                    Value::Null
                } else {
                    json!(subagent.assistant_text)
                }
            });
        set(&mut subagent.task, "status", json!(update.status));
        set(&mut subagent.task, "result", result.clone());
        set(
            &mut subagent.task,
            "completedAt",
            if terminal { json!(now) } else { Value::Null },
        );
        set(&mut subagent.task, "updatedAt", json!(now));
        if terminal {
            subagent.terminal_status_projected = true;
        }
        let task = subagent.task.clone();
        let provider_thread_id = task["providerThreadId"].clone();
        if let Some(turn) = self.turn.as_mut() {
            turn.subagents.put(&native_task_id, subagent.clone());
        }
        self.event(
            json!({"type": "node.updated", "node": {
                "id": node_id,
                "threadId": parent_thread_id,
                "runId": task["runId"],
                "parentNodeId": task["parentNodeId"],
                "rootNodeId": task["parentNodeId"],
                "kind": "subagent",
                "status": update.status,
                "countsForRun": false,
                "providerThreadId": parent_provider_thread,
                "providerTurnId": subagent.provider_turn_id,
                "nativeItemRef": native_ref,
                "runtimeRequestId": null,
                "checkpointScopeId": null,
                "startedAt": task["startedAt"],
                "completedAt": task["completedAt"],
            }}),
            out,
        );
        self.event(
            json!({"type": "node.updated", "node": {
                "id": child_root_node_id,
                "threadId": child_thread_id,
                "runId": null,
                "parentNodeId": null,
                "rootNodeId": child_root_node_id,
                "kind": "root_turn",
                "status": update.status,
                "countsForRun": false,
                "providerThreadId": provider_thread_id,
                "providerTurnId": null,
                "nativeItemRef": native_ref,
                "runtimeRequestId": null,
                "checkpointScopeId": null,
                "startedAt": task["startedAt"],
                "completedAt": task["completedAt"],
            }}),
            out,
        );
        self.event(json!({"type": "subagent.updated", "subagent": task}), out);
        self.event(
            json!({"type": "turn_item.updated", "turnItem": {
                "id": turn_item_id,
                "threadId": parent_thread_id,
                "runId": task["runId"],
                "nodeId": node_id,
                "providerThreadId": parent_provider_thread,
                "providerTurnId": subagent.provider_turn_id,
                "nativeItemRef": native_ref,
                "parentItemId": null,
                "ordinal": subagent.turn_item_ordinal,
                "status": update.status,
                "title": task["title"],
                "startedAt": task["startedAt"],
                "completedAt": task["completedAt"],
                "updatedAt": now,
                "type": "subagent",
                "subagentId": task["id"],
                "origin": "provider_native",
                "driver": driver,
                "providerInstanceId": model_selection["instanceId"],
                "childThreadId": child_thread_id,
                "prompt": task["prompt"],
                "result": result,
            }}),
            out,
        );
    }

    /// `emitSubagentAssistant`. `replace` sets the text; otherwise it is appended. A message's
    /// first text goes out at once; later appends wait for the next subagent flush (T3 #29422,
    /// `ACP_SUBAGENT_TEXT_FLUSH_INTERVAL`), each message once per flush.
    fn emit_subagent_assistant(
        &mut self,
        native_task_id: &str,
        text: &str,
        replace: bool,
        message_id: Option<&str>,
        out: &mut Vec<Out>,
    ) {
        if text.is_empty() && !replace {
            return;
        }
        let Some(subagent) = self
            .turn
            .as_mut()
            .and_then(|t| t.subagents.get_mut(native_task_id))
        else {
            return;
        };
        let native_item_id = format!(
            "{}:message:{}",
            subagent.native_task_id(),
            message_id.unwrap_or("result")
        );
        let previous = subagent.assistant_messages.get(&native_item_id).cloned();
        let message_text = if replace {
            text.to_owned()
        } else {
            format!("{}{text}", previous.as_deref().unwrap_or_default())
        };
        subagent
            .assistant_messages
            .insert(native_item_id.clone(), message_text.clone());
        subagent.assistant_text = message_text;
        if !replace && previous.is_some() {
            // Bounded by the subagent's messages; emptied by each flush.
            if !subagent.pending_assistant.contains(&native_item_id) {
                subagent.pending_assistant.push(native_item_id);
                out.push(Out::ScheduleSubagentFlush);
            }
            return;
        }
        subagent
            .pending_assistant
            .retain(|id| *id != native_item_id);
        self.write_subagent_assistant(native_task_id, &native_item_id, out);
    }

    /// `writeSubagentAssistantUnlocked`: the message's current text.
    fn write_subagent_assistant(
        &mut self,
        native_task_id: &str,
        native_item_id: &str,
        out: &mut Vec<Out>,
    ) {
        let now = self.env.now();
        let Some(subagent) = self
            .turn
            .as_mut()
            .and_then(|t| t.subagents.get_mut(native_task_id))
        else {
            return;
        };
        let Some(text) = subagent.assistant_messages.get(native_item_id).cloned() else {
            return;
        };
        let ordinal = Self::child_ordinal(subagent, native_item_id);
        let thread = subagent.child_thread_id.clone();
        let root = subagent.child_root_node_id.clone();
        let provider_thread = subagent.task["providerThreadId"].clone();
        self.child_message(
            &thread,
            &root,
            provider_thread,
            native_item_id,
            "assistant",
            &text,
            ordinal,
            None,
            &now,
            out,
        );
    }

    /// `flushPendingSubagentAssistant`: writes the subagent's messages that wait for a flush.
    fn flush_subagent_assistant(&mut self, native_task_id: &str, out: &mut Vec<Out>) {
        let pending = match self
            .turn
            .as_mut()
            .and_then(|t| t.subagents.get_mut(native_task_id))
        {
            Some(subagent) => std::mem::take(&mut subagent.pending_assistant),
            None => return,
        };
        for native_item_id in pending {
            self.write_subagent_assistant(native_task_id, &native_item_id, out);
        }
    }

    /// The delayed subagent flush (the session's 400 ms timer, or T3's test clock advancing):
    /// every subagent's waiting messages.
    pub(crate) fn flush_subagent_text(&mut self) -> Vec<Out> {
        let mut out = Vec::new();
        let ids: Vec<String> = self
            .turn
            .as_ref()
            .map(|t| t.subagents.list.iter().map(|(id, _)| id.clone()).collect())
            .unwrap_or_default();
        for native_task_id in ids {
            self.flush_subagent_assistant(&native_task_id, &mut out);
        }
        out
    }

    /// `projectSubagentNotification`.
    fn project_subagent_notification(
        &mut self,
        native_task_id: &str,
        params: &Value,
        out: &mut Vec<Out>,
    ) {
        let update = &params["update"];
        let session_id = params["sessionId"].as_str().unwrap_or("");
        match update["sessionUpdate"].as_str().unwrap_or("") {
            "agent_message_chunk" => {
                if let Some(text) = content_display_text(&update["content"]) {
                    let message_id = update["messageId"].as_str();
                    self.emit_subagent_assistant(native_task_id, &text, false, message_id, out);
                }
            }
            "tool_call_content_chunk" => {
                self.project_subagent_tool(native_task_id, session_id, update, None, out);
            }
            "agent_message" => {
                let Some(content) = update["content"].as_array() else {
                    return;
                };
                let text = content
                    .iter()
                    .filter_map(content_display_text)
                    .collect::<Vec<_>>()
                    .join("\n");
                let message_id = update["messageId"].as_str();
                self.emit_subagent_assistant(native_task_id, &text, true, message_id, out);
            }
            _ => {}
        }
    }

    /// `projectSubagentTool` for a child tool update (normalized by the flavor) or, with
    /// `tool` `None`, a `tool_call_content_chunk`.
    fn project_subagent_tool(
        &mut self,
        native_task_id: &str,
        session_id: &str,
        update: &Value,
        tool: Option<ToolState>,
        out: &mut Vec<Out>,
    ) {
        let now = self.env.now();
        let interrupted = self.turn.as_ref().is_some_and(|t| t.interrupted);
        let tool_call_id = update["toolCallId"].as_str().unwrap_or("").to_owned();
        let Some((task_key, own_session)) = self
            .turn
            .as_ref()
            .and_then(|t| t.subagents.get(native_task_id))
            .map(|s| {
                (
                    s.native_task_id(),
                    s.child_session_id.as_deref() == Some(session_id),
                )
            })
        else {
            return;
        };
        let key = if own_session {
            format!("{task_key}:tool:{tool_call_id}")
        } else {
            format!("{task_key}:session:{session_id}:tool:{tool_call_id}")
        };
        let item_id = self.turn_item_id(&key);
        let driver = self.flavor.driver;
        let Some(subagent) = self
            .turn
            .as_mut()
            .and_then(|t| t.subagents.get_mut(native_task_id))
        else {
            return;
        };
        let previous = subagent.tools.get(&key).cloned();
        let incoming = if let Some(tool) = tool {
            tool
        } else {
            if update["content"]["type"] != "content" {
                return;
            }
            let Some(text) =
                content_display_text(&update["content"]["content"]).filter(|t| !t.is_empty())
            else {
                return;
            };
            let mut data = serde_json::Map::new();
            data.insert(
                "content".into(),
                tools::append_content_text(
                    previous.as_ref().and_then(|p| p.data.get("content")),
                    &text,
                ),
            );
            ToolState {
                tool_call_id,
                kind: None,
                title: None,
                status: None,
                command: None,
                detail: None,
                data,
            }
        };
        let mut merged = tools::merge(previous.as_ref(), incoming);
        merged.tool_call_id = key.clone();
        // `stoppedToolStatus`: after Stop a failure shows as the interruption it was.
        let mut projected =
            (interrupted && merged.status.as_deref() == Some("failed")).then_some("interrupted");
        if merged.status.as_deref() != Some("failed") {
            subagent.interrupted_tool_ids.remove(&key);
        }
        if projected == Some("interrupted") {
            subagent.interrupted_tool_ids.insert(key.clone());
        }
        if merged.status.as_deref() == Some("failed")
            && subagent.interrupted_tool_ids.contains(&key)
        {
            projected = Some("interrupted");
        }
        subagent.tools.insert(key.clone(), merged.clone());
        if projected.is_none() {
            let skipped = subagent.tool_skips.get(&key).copied().unwrap_or(0);
            let persist = matches!(merged.status.as_deref(), Some("completed" | "failed"))
                || previous.as_ref().is_none_or(|p| {
                    p.status != merged.status
                        || p.title != merged.title
                        || tools::visible_output_changed(p, &merged)
                })
                || skipped + 1 >= 10;
            subagent
                .tool_skips
                .insert(key.clone(), if persist { 0 } else { skipped + 1 });
            if !persist {
                return;
            }
        }
        let status = projected
            .map(str::to_owned)
            .unwrap_or_else(|| tools::item_status(merged.status.as_deref()).to_owned());
        let started_at = subagent
            .tool_started_at
            .entry(key.clone())
            .or_insert_with(|| now.clone())
            .clone();
        let ordinal = Self::child_ordinal(subagent, &key);
        let title = merged
            .title
            .clone()
            .or_else(|| merged.kind.clone())
            .unwrap_or_else(|| "Tool".into());
        let item = json!({
            "id": item_id,
            "threadId": subagent.child_thread_id,
            "runId": null,
            "nodeId": subagent.child_root_node_id,
            "providerThreadId": subagent.task["providerThreadId"],
            "providerTurnId": null,
            "nativeItemRef": {"driver": driver, "nativeId": key, "strength": "strong"},
            "parentItemId": null,
            "ordinal": ordinal,
            "status": status,
            "title": title,
            "startedAt": started_at,
            "completedAt": tools::completed_at(&status, &now),
            "updatedAt": now,
            "type": "dynamic_tool",
            "toolName": title,
            "input": merged.data.get("rawInput").cloned().unwrap_or(Value::Null),
            "output": merged.data.get("rawOutput").or_else(|| merged.data.get("content")).cloned().unwrap_or(Value::Null),
        });
        self.event(json!({"type": "turn_item.updated", "turnItem": item}), out);
    }

    /// The child-session branch of `handleSessionUpdate` while the root turn runs.
    pub(super) fn child_session_update(&mut self, params: &Value, out: &mut Vec<Out>) {
        let Some(hooks) = self.flavor.background else {
            return;
        };
        let session_id = params["sessionId"].as_str().unwrap_or("").to_owned();
        let update = &params["update"];
        let kind = update["sessionUpdate"].as_str().unwrap_or("");
        let key = self
            .turn
            .as_ref()
            .and_then(|t| t.subagents.key_of_session(&session_id));
        if kind == "tool_call" || kind == "tool_call_update" {
            let Some(key) = key else { return };
            let fallback = (kind == "tool_call").then_some("pending");
            let Some(tool) = tools::parse_tool_call(update, fallback).map(|t| {
                match self.flavor.normalize_tool {
                    Some(normalize) => normalize(t),
                    None => t,
                }
            }) else {
                return;
            };
            if let Some(sub_update) = (hooks.subagent)(&tool) {
                let native = self
                    .turn
                    .as_ref()
                    .and_then(|t| t.subagents.get(&key))
                    .map(Subagent::native_task_id)
                    .unwrap_or_default();
                if sub_update.native_task_id == native
                    || sub_update.child_session_id.as_deref() == Some(session_id.as_str())
                {
                    self.emit_subagent(sub_update, out);
                }
                return;
            }
            self.project_subagent_tool(&key, &session_id, update, Some(tool), out);
            return;
        }
        if kind == "tool_call_content_chunk" {
            if let Some(key) = key {
                self.project_subagent_tool(&key, &session_id, update, None, out);
            }
            return;
        }
        let displayable = (kind == "agent_message_chunk"
            && content_display_text(&update["content"]).is_some())
            || (kind == "agent_message" && update["content"].is_array());
        if !displayable {
            return;
        }
        if let Some(key) = key {
            self.project_subagent_notification(&key, params, out);
            return;
        }
        let Some(turn) = self.turn.as_mut() else {
            return;
        };
        let held = turn.subagents.held.entry(session_id).or_default();
        if held.len() < HELD_PER_SESSION {
            held.push(params.clone());
        }
    }

    /// `finishSubagentFromNotice` while the turn runs: Grok's `subagent_finished`.
    pub(crate) fn finish_subagent(
        &mut self,
        session_id: &str,
        child_session_id: &str,
        status: &str,
        result: Option<String>,
    ) -> Vec<Out> {
        let mut out = Vec::new();
        if self.flavor.background.is_none() || self.bg.quarantined || !self.is_root(session_id) {
            return out;
        }
        let known = self.turn.as_ref().and_then(|t| {
            t.subagents
                .key_of_session(child_session_id)
                .and_then(|key| t.subagents.get(&key).cloned())
        });
        if let Some(subagent) = known {
            if !crate::grok_background::subagent_status_blocks_settlement(subagent.status()) {
                return out;
            }
            let update = SubagentUpdate {
                native_task_id: subagent.native_task_id(),
                prompt: subagent.task["prompt"].as_str().unwrap_or("").to_owned(),
                title: subagent.task["title"].as_str().map(str::to_owned),
                model: subagent.task["model"].as_str().map(str::to_owned),
                status: status.to_owned(),
                child_session_id: Some(child_session_id.to_owned()),
                result,
                suppress_normal_tool: true,
            };
            self.emit_subagent(update, &mut out);
            self.rearm_deferred_finalize(&mut out);
            return out;
        }
        // A subagent of an earlier turn (T3's carryover subagents) is not built: its end is
        // dropped here.
        out
    }

    /// `extractSubagentEndNotice` in a `user_message_chunk`: an agent may answer without
    /// hydrating the output, so the notice finishes the subagent and the turn can settle.
    pub(super) fn subagent_end_notice(&mut self, text: &str, out: &mut Vec<Out>) {
        if self.flavor.background.is_none() {
            return;
        }
        let Some((child, status)) = crate::grok_background::subagent_end_notice(text) else {
            return;
        };
        let Some(subagent) = self.turn.as_ref().and_then(|t| {
            t.subagents
                .key_of_session(&child)
                .and_then(|key| t.subagents.get(&key).cloned())
        }) else {
            return;
        };
        if !matches!(subagent.status(), "running" | "pending") {
            return;
        }
        let update = SubagentUpdate {
            native_task_id: subagent.native_task_id(),
            prompt: subagent.task["prompt"].as_str().unwrap_or("").to_owned(),
            title: subagent.task["title"].as_str().map(str::to_owned),
            model: subagent.task["model"].as_str().map(str::to_owned),
            status: status.to_owned(),
            child_session_id: Some(child),
            result: None,
            suppress_normal_tool: true,
        };
        self.emit_subagent(update, out);
    }

    /// Subagents whose status blocks the turn's settle (`hasDeferredBackgroundWork`).
    pub(super) fn subagents_block_settlement(&self) -> bool {
        self.turn.as_ref().is_some_and(|t| {
            t.subagents
                .list
                .iter()
                .any(|(_, s)| crate::grok_background::subagent_status_blocks_settlement(s.status()))
        })
    }
}
