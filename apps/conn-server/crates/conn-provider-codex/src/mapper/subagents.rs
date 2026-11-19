//! Codex subagents: `collabAgentToolCall` (v1 `spawnAgent`, `wait`, `sendInput`, …),
//! `subAgentActivity` (v2) and the child threads they run on. Ported from `CodexAdapterV2.ts`
//! (`registerSubagentThread`, `registerSubagentThreads`, `registerSubagentActivity`,
//! `updateSubagentStates`, `emitSubagentTaskUpdate`, `emitSubagentProviderTurnStarted`,
//! `rememberSubagentTurnStarted`, `updateSubagentSelection`, `emitSubagentUserMessage`, and the
//! subagent part of `finalizeCodexTurn`), with T3's shared `makeSubagentChildThread`,
//! `subagentThreadTitle` and `makeSubagentConversationArtifacts`.
//!
//! A child's turns are ordinary [`Turn`]s with `subagent` set: the item handlers serve them as
//! they serve a root turn. Every table here is bounded (see the constants).

use std::collections::{HashMap, HashSet};

use conn_provider::{ContinuationRequest, ProviderEvent};
use conn_provider_support::ids::{self, Env};
use conn_provider_support::notification;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::{DRIVER, Mapper, Out, Turn, push_event, ref_strong, trimmed};

/// Subagents one session remembers. Past this, the oldest settled one is forgotten; when none
/// is settled, a new child is not tracked (its frames are skipped).
pub(super) const MAX_SUBAGENTS: usize = 64;
/// Native turn ids remembered per subagent (`nativeTurnIds`), so a repeated `turn/started` is
/// not taken for a new turn.
const MAX_CHILD_TURNS: usize = 64;
/// Child threads whose `turn/started` came before the child was known
/// (`pendingSubagentTurns`), and turns held for each.
const MAX_PENDING_CHILD_THREADS: usize = 16;
const MAX_PENDING_CHILD_TURNS: usize = 8;
/// `subagentThreadTitle`: titles longer than this are cut (UTF-16 units, as JS counts).
const TITLE_MAX_UNITS: usize = 72;

/// What a child keeps of the turn that spawned it (`parentContext`). A snapshot: the parent
/// turn may end before the child does. Refreshed from the parent thread's running turn when
/// the child starts a new turn, as T3 does.
#[derive(Clone, Debug)]
pub(super) struct Scope {
    thread_id: String,
    run_id: Option<String>,
    run_ordinal: u32,
    root_node_id: String,
    provider_turn_id: String,
    provider_session_id: Value,
    provider_thread_id: String,
    native_thread_id: String,
    native_turn_id: String,
    model_selection: Value,
    runtime_mode: String,
    subagent: Option<String>,
}

impl Turn {
    pub(super) fn scope(&self) -> Scope {
        Scope {
            thread_id: self.thread_id.clone(),
            run_id: self.run_id.clone(),
            run_ordinal: self.run_ordinal,
            root_node_id: self.root_node_id.clone(),
            provider_turn_id: self.provider_turn_id.clone(),
            provider_session_id: self.provider_session_id.clone(),
            provider_thread_id: self.provider_thread_id.clone(),
            native_thread_id: self.native_thread_id.clone(),
            native_turn_id: self.native_turn_id.clone(),
            model_selection: self.model_selection.clone(),
            runtime_mode: self.runtime_mode.clone(),
            subagent: self.subagent.clone(),
        }
    }
}

/// `CodexSubagentThreadContext`.
pub(super) struct Sub {
    parent: Scope,
    provider_thread: Value,
    child_thread: Value,
    node_id: String,
    child_root: String,
    child_thread_id: String,
    native_turns: Vec<String>,
    /// `nextProviderTurnOrdinals` for the child's provider thread.
    last_turn_ordinal: u32,
    started_at: String,
    item_id: String,
    item_ordinal: u32,
    /// `OrchestrationV2Subagent`.
    task: Value,
    /// Registration order, for forgetting the oldest settled subagent.
    seq: u64,
}

/// A model selection Codex reported for a native thread (`subagentSelections`): the model and
/// the options T3 derives from effort and service tier. `options` is `None` until either is
/// reported.
#[derive(Clone, Debug, Default)]
pub(super) struct Selection {
    pub(super) model: String,
    options: Option<Vec<Value>>,
}

/// `isOrchestrationV2WorkActive`.
fn active(status: &Value) -> bool {
    matches!(status.as_str(), Some("pending" | "running" | "waiting"))
}

/// `IdAllocator.derive.subagentThread`: `thread:subagent:` and 16 hex of a sha256 of the
/// legacy id.
pub(super) fn subagent_thread_id(native_thread_id: &str) -> String {
    let legacy = format!(
        "thread:provider:{DRIVER}:native-thread:{}",
        ids::encode_component(native_thread_id)
    );
    let digest = Sha256::digest(legacy.as_bytes());
    let hex = conn_support::hex::hex(digest.get(..8).unwrap_or_default());
    format!("thread:subagent:{hex}")
}

/// `subagentThreadTitle`: the title, else the prompt, else "<parent> subagent <n>"; cut to 72
/// UTF-16 units with "..." without splitting a surrogate pair.
pub(super) fn child_title(
    parent_title: &str,
    title: Option<&str>,
    prompt: &str,
    ordinal: u32,
) -> String {
    let detail = title
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| prompt.trim());
    if detail.is_empty() {
        return format!("{parent_title} subagent {ordinal}");
    }
    if detail.encode_utf16().count() <= TITLE_MAX_UNITS {
        return detail.to_owned();
    }
    let mut units = 0;
    let mut cut = String::new();
    for c in detail.chars() {
        units += c.len_utf16();
        if units > TITLE_MAX_UNITS - 3 {
            break;
        }
        cut.push(c);
    }
    format!("{cut}...")
}

/// `makeSubagentChildThread`: the parent app thread with the child's identity.
#[expect(clippy::too_many_arguments, reason = "the fields of one contract row")]
fn child_app_thread(
    parent: &Value,
    child_thread_id: &str,
    parent_node_id: &str,
    provider_thread_id: &str,
    instance_id: &Value,
    model_selection: Value,
    title: String,
    now: &str,
) -> Value {
    let mut thread = parent.clone();
    let root = parent["lineage"]["rootThreadId"].clone();
    let parent_id = parent["id"].clone();
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
            ("providerInstanceId", instance_id.clone()),
            ("modelSelection", model_selection),
            ("activeProviderThreadId", json!(provider_thread_id)),
            (
                "lineage",
                json!({"parentThreadId": parent_id, "relationshipToParent": "subagent", "rootThreadId": root}),
            ),
            (
                "forkedFrom",
                json!({"type": "node", "nodeId": parent_node_id}),
            ),
            ("createdAt", json!(now)),
            ("updatedAt", json!(now)),
            ("archivedAt", Value::Null),
            ("settledOverride", Value::Null),
            ("settledAt", Value::Null),
            ("snoozedUntil", Value::Null),
            ("snoozedAt", Value::Null),
            ("pinnedAt", Value::Null),
            ("pinOrderKey", Value::Null),
            ("autoSettleDisabledAt", Value::Null),
            ("guestShare", Value::Null),
            ("lastVisitedAt", Value::Null),
            ("deletedAt", Value::Null),
        ] {
            map.insert(key.into(), value);
        }
    }
    thread
}

/// `makeSubagentConversationArtifacts` for a user message: the message and its turn item.
#[expect(clippy::too_many_arguments, reason = "the fields of one contract row")]
fn child_user_message(
    sender: &str,
    native_item: &str,
    thread_id: &str,
    root_node: &str,
    provider_thread_id: &str,
    provider_turn_id: Option<&str>,
    text: &str,
    ordinal: u32,
    now: &str,
    out: &mut Vec<Out>,
) {
    let message_id = ids::message_from_item(DRIVER, native_item);
    push_event(
        out,
        json!({"type": "message.updated", "message": {
            "createdBy": "agent", "creationSource": "provider", "id": message_id,
            "threadId": thread_id, "runId": null, "nodeId": root_node, "role": "user",
            "senderThreadId": sender, "text": text, "attachments": [], "streaming": false,
            "createdAt": now, "updatedAt": now,
        }}),
    );
    push_event(
        out,
        json!({"type": "turn_item.updated", "turnItem": {
            "id": ids::turn_item_from_item(DRIVER, native_item), "threadId": thread_id,
            "runId": null, "nodeId": root_node, "providerThreadId": provider_thread_id,
            "providerTurnId": provider_turn_id, "nativeItemRef": ref_strong(native_item),
            "parentItemId": null, "ordinal": ordinal, "status": "completed", "title": null,
            "startedAt": now, "completedAt": now, "updatedAt": now, "messageId": message_id,
            "text": text, "createdBy": "agent", "creationSource": "provider",
            "type": "user_message", "senderThreadId": sender, "inputIntent": "turn_start",
            "attachments": [],
        }}),
    );
}

/// `modelSelectionsEqual`: instance, model and the options sorted by id.
fn selections_equal(left: &Value, right: &Value) -> bool {
    let options = |v: &Value| {
        let mut o: Vec<(String, String)> = v["options"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|o| (o["id"].to_string(), o["value"].to_string()))
            .collect();
        o.sort();
        o
    };
    left["instanceId"] == right["instanceId"]
        && left["model"] == right["model"]
        && options(left) == options(right)
}

/// `codexUserMessageText`: the text parts, joined by new lines, trimmed.
fn user_message_text(content: &Value) -> String {
    content
        .as_array()
        .into_iter()
        .flatten()
        .filter(|c| c["type"] == "text")
        .filter_map(|c| c["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_owned()
}

/// What `registerSubagentThread` takes.
struct Registration<'a> {
    context: &'a str,
    native_thread: &'a str,
    native_item: String,
    tool_call: &'a str,
    prompt: String,
    title: Option<String>,
    model: Option<String>,
    effort: Option<Value>,
    ordinal: u32,
    emit_prompt: bool,
}

/// One `emitSubagentTaskUpdate`.
#[derive(Default)]
struct TaskUpdate {
    status: &'static str,
    /// `None`: keep the task's result.
    result: Option<Value>,
    completed_at: Option<String>,
    started_at: Option<String>,
    reopen: bool,
    progress: Option<String>,
}

/// `CollabAgentStatus` → subagent status.
fn collab_status(status: &Value) -> Option<&'static str> {
    Some(match status.as_str()? {
        "pendingInit" => "pending",
        "running" => "running",
        "interrupted" => "interrupted",
        "completed" => "completed",
        "errored" | "notFound" => "failed",
        "shutdown" => "cancelled",
        _ => return None,
    })
}

impl<E: Env> Mapper<E> {
    /// `markSubagentUsage`: the turn spawned or ran a subagent.
    pub(super) fn mark_subagent_usage(&mut self, turn_id: &str) {
        let Some(thread) = self.turns.get(turn_id).map(|t| t.native_thread_id.clone()) else {
            return;
        };
        self.usage
            .entry(thread)
            .or_default()
            .acc
            .entry(turn_id.to_owned())
            .or_default()
            .has_subagents = true;
    }

    /// Whether the turn ended other than completed (`terminalizedNonCompletedNativeTurns`).
    pub(super) fn stopped(&self, native_turn: &str) -> bool {
        self.stopped.iter().any(|t| t == native_turn)
    }

    /// `updateSubagentSelection`. `effort` and `tier`: `None` when the frame leaves them out
    /// (the previous value stays), `Some(null)` when it clears them.
    pub(super) fn update_selection(
        &mut self,
        native_thread: &str,
        model: &Value,
        effort: Option<&Value>,
        tier: Option<&Value>,
        out: &mut Vec<Out>,
    ) {
        let Some(model) = trimmed(model) else {
            return;
        };
        let previous = self
            .selections
            .get(native_thread)
            .and_then(|s| s.options.clone());
        let options = if effort.is_none() && tier.is_none() {
            previous
        } else {
            let mut options: Vec<Value> = previous
                .unwrap_or_default()
                .into_iter()
                .filter(|o| match o["id"].as_str() {
                    Some("reasoningEffort") => effort.is_none(),
                    Some("serviceTier") => tier.is_none(),
                    _ => false,
                })
                .collect();
            for (id, value) in [("reasoningEffort", effort), ("serviceTier", tier)] {
                if let Some(value) = value.and_then(trimmed) {
                    options.push(json!({"id": id, "value": value}));
                }
            }
            Some(options)
        };
        self.selections.insert(
            native_thread.to_owned(),
            Selection {
                model: model.clone(),
                options: options.clone(),
            },
        );
        let now = self.env.now();
        let Some(sub) = self.subagents.get_mut(native_thread) else {
            return;
        };
        let mut selection = json!({"instanceId": sub.task["providerInstanceId"], "model": model});
        if let Some(options) = options {
            selection["options"] = Value::Array(options);
        }
        if sub
            .task
            .get("modelSelection")
            .is_some_and(|current| selections_equal(current, &selection))
        {
            return;
        }
        sub.task["model"] = json!(model);
        sub.task["modelSelection"] = selection;
        sub.task["updatedAt"] = json!(now);
        push_event(
            out,
            json!({"type": "subagent.updated", "subagent": sub.task}),
        );
    }

    /// The answer to the child metadata read (`thread/read`, else `thread/resume`, as
    /// `{thread, model, reasoningEffort?, serviceTier?}`): the child's model and effort,
    /// unless Codex reported a selection meanwhile.
    pub fn child_metadata(&mut self, native_thread: &str, response: &Value) -> Vec<Out> {
        let mut out = Vec::new();
        if response["thread"]["id"] == native_thread && !self.selections.contains_key(native_thread)
        {
            self.update_selection(
                native_thread,
                &response["model"],
                response.get("reasoningEffort"),
                response.get("serviceTier"),
                &mut out,
            );
        }
        out
    }

    /// `emitSubagentTaskUpdate`.
    fn task_update(&mut self, child: &str, update: TaskUpdate, out: &mut Vec<Out>) {
        let now = self.env.now();
        let Some(sub) = self.subagents.get_mut(child) else {
            return;
        };
        let mut task = sub.task.clone();
        if update.reopen
            && let Some(map) = task.as_object_mut()
        {
            map.remove("progress");
        }
        let settled = !active(&task["status"]);
        let wanted = json!(update.status);
        // Late snapshots must not reopen completed children; only new turns may.
        if settled && active(&wanted) && !update.reopen {
            return;
        }
        let status = if settled && !update.reopen {
            task["status"].clone()
        } else {
            wanted
        };
        let completed_at = if active(&status) {
            Value::Null
        } else if !task["completedAt"].is_null() {
            task["completedAt"].clone()
        } else {
            json!(update.completed_at.unwrap_or_else(|| now.clone()))
        };
        if update.reopen {
            task["runId"] = json!(sub.parent.run_id);
            task["parentNodeId"] = json!(sub.parent.root_node_id);
        }
        task["status"] = status;
        if let Some(started) = &update.started_at {
            task["startedAt"] = json!(started);
            sub.started_at = started.clone();
        }
        if let Some(progress) = update.progress {
            task["progress"] = json!(progress);
        }
        if let Some(result) = update.result {
            task["result"] = result;
        }
        task["completedAt"] = completed_at;
        task["updatedAt"] = json!(now);
        sub.task = task;
        let task = &sub.task;
        push_event(out, json!({"type": "subagent.updated", "subagent": task}));
        let mut item = json!({
            "id": sub.item_id, "threadId": task["threadId"], "runId": task["runId"],
            "nodeId": task["id"], "providerThreadId": task["providerThreadId"],
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
        push_event(out, json!({"type": "turn_item.updated", "turnItem": item}));
    }

    /// `reportSubagentProgress`: a child's running item is the line its parent's row shows.
    pub(super) fn report_progress(
        &mut self,
        turn_id: &str,
        line: Option<&str>,
        out: &mut Vec<Out>,
    ) {
        let Some(child) = self.turns.get(turn_id).and_then(|t| t.subagent.clone()) else {
            return;
        };
        let Some(line) = line.map(str::trim).filter(|l| !l.is_empty()) else {
            return;
        };
        let Some(sub) = self.subagents.get(&child) else {
            return;
        };
        if !active(&sub.task["status"]) || sub.task["progress"] == line {
            return;
        }
        let status = status_str(&sub.task["status"]);
        self.task_update(
            &child,
            TaskUpdate {
                status,
                progress: Some(line.to_owned()),
                ..TaskUpdate::default()
            },
            out,
        );
    }

    /// `registerSubagentThread`.
    fn register_subagent(&mut self, r: Registration<'_>, out: &mut Vec<Out>) {
        if r.model.is_some() && !self.selections.contains_key(r.native_thread) {
            let model = json!(r.model);
            let effort = r.effort.clone().unwrap_or(Value::Null);
            self.update_selection(r.native_thread, &model, Some(&effort), None, out);
        }
        if self.subagents.contains_key(r.native_thread) {
            return;
        }
        if self.subagents.len() >= MAX_SUBAGENTS && !self.forget_settled_subagent() {
            out.push(Out::Skipped(format!(
                "subagent {}: more than {MAX_SUBAGENTS} running",
                r.native_thread
            )));
            return;
        }
        let now = self.env.now();
        let Some(context) = self.turns.get_mut(r.context) else {
            return;
        };
        let node_id = ids::node_from_item(DRIVER, &r.native_item);
        let child_root = ids::node_from_item(DRIVER, &format!("{}:thread-root", r.native_item));
        let child_thread_id = subagent_thread_id(r.native_thread);
        let (item_ordinal, _) = context.position(&r.native_item, now.clone());
        let instance_id = context.model_selection["instanceId"].clone();
        let provider_thread_id = ids::provider_thread_id(DRIVER, r.native_thread);
        let provider_thread = json!({
            "id": provider_thread_id, "driver": DRIVER, "providerInstanceId": instance_id,
            "providerSessionId": context.provider_session_id, "appThreadId": child_thread_id,
            "ownerNodeId": null, "nativeThreadRef": ref_strong(r.native_thread),
            "nativeConversationHeadRef": null, "status": "idle", "firstRunOrdinal": null,
            "lastRunOrdinal": null, "handoffIds": [],
            "forkedFrom": {"providerThreadId": context.provider_thread_id, "providerTurnId": context.provider_turn_id},
            "createdAt": now, "updatedAt": now,
        });
        let reported = self.selections.get(r.native_thread);
        let mut task = json!({
            "id": node_id, "threadId": context.thread_id, "runId": context.run_id,
            "parentNodeId": context.root_node_id, "origin": "provider_native",
            "createdBy": "agent", "driver": DRIVER, "providerInstanceId": instance_id,
            "providerThreadId": provider_thread_id, "childThreadId": child_thread_id,
            "nativeTaskRef": ref_strong(&r.native_item), "prompt": r.prompt, "title": r.title,
            "model": reported.map(|s| s.model.clone()).or(r.model.clone()),
            "status": "running", "result": null, "startedAt": now, "completedAt": null,
            "updatedAt": now,
        });
        if let Some(selection) = reported {
            let mut value = json!({"instanceId": instance_id, "model": selection.model});
            if let Some(options) = &selection.options {
                value["options"] = Value::Array(options.clone());
            }
            task["modelSelection"] = value;
        }
        // A child's effort can differ from the parent's. Until Codex reports it, show none.
        let child_selection = task.get("modelSelection").cloned().unwrap_or_else(|| {
            let mut selection = context.model_selection.clone();
            if !task["model"].is_null() {
                selection["model"] = task["model"].clone();
            }
            let options: Vec<Value> = selection["options"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|o| o["id"] != "reasoningEffort")
                .cloned()
                .collect();
            selection["options"] = Value::Array(options);
            selection
        });
        let title = child_title(
            context.app_thread["title"].as_str().unwrap_or_default(),
            r.title.as_deref(),
            &r.prompt,
            r.ordinal,
        );
        let child_thread = child_app_thread(
            &context.app_thread,
            &child_thread_id,
            &node_id,
            &provider_thread_id,
            &instance_id,
            child_selection,
            title,
            &now,
        );
        let scope = context.scope();
        self.subagent_seq += 1;
        let sub = Sub {
            parent: scope.clone(),
            provider_thread: provider_thread.clone(),
            child_thread: child_thread.clone(),
            node_id: node_id.clone(),
            child_root: child_root.clone(),
            child_thread_id: child_thread_id.clone(),
            native_turns: Vec::new(),
            last_turn_ordinal: 0,
            started_at: now.clone(),
            item_id: ids::turn_item_from_item(DRIVER, &r.native_item),
            item_ordinal,
            task,
            seq: self.subagent_seq,
        };
        self.subagents.insert(r.native_thread.to_owned(), sub);
        push_event(
            out,
            json!({"type": "app_thread.created", "appThread": child_thread}),
        );
        push_event(
            out,
            json!({"type": "node.updated", "node": {
                "id": node_id, "threadId": scope.thread_id, "runId": scope.run_id,
                "parentNodeId": scope.root_node_id, "rootNodeId": scope.root_node_id,
                "kind": "subagent", "status": "running", "countsForRun": false,
                "providerThreadId": provider_thread_id, "providerTurnId": scope.provider_turn_id,
                "nativeItemRef": ref_strong(r.tool_call), "runtimeRequestId": null,
                "checkpointScopeId": null, "startedAt": now, "completedAt": null,
            }}),
        );
        push_event(
            out,
            json!({"type": "node.updated", "node": {
                "id": child_root, "threadId": child_thread_id, "runId": null,
                "parentNodeId": null, "rootNodeId": child_root, "kind": "root_turn",
                "status": "running", "countsForRun": false,
                "providerThreadId": provider_thread_id, "providerTurnId": null,
                "nativeItemRef": ref_strong(&r.native_item), "runtimeRequestId": null,
                "checkpointScopeId": null, "startedAt": now, "completedAt": null,
            }}),
        );
        push_event(
            out,
            json!({"type": "provider_thread.updated", "providerThread": provider_thread}),
        );
        if r.emit_prompt && !r.prompt.is_empty() {
            let native = format!("{}:prompt", r.native_item);
            child_user_message(
                &scope.thread_id,
                &native,
                &child_thread_id,
                &child_root,
                &provider_thread_id,
                None,
                &r.prompt,
                100,
                &now,
                out,
            );
        }
        self.task_update(
            r.native_thread,
            TaskUpdate {
                status: "running",
                ..TaskUpdate::default()
            },
            out,
        );
        for (turn, started_at) in self
            .pending_child_turns
            .remove(r.native_thread)
            .unwrap_or_default()
        {
            self.child_turn_started(r.native_thread, &turn, started_at, out);
        }
        let unknown_model = self
            .subagents
            .get(r.native_thread)
            .is_some_and(|s| s.task["model"].is_null());
        if unknown_model {
            out.push(Out::ChildMetadata(r.native_thread.to_owned()));
        }
    }

    /// Forgets the oldest subagent that is settled and runs no turn. Returns whether one was.
    fn forget_settled_subagent(&mut self) -> bool {
        let running: HashSet<&str> = self
            .turns
            .values()
            .filter_map(|t| t.subagent.as_deref())
            .collect();
        let oldest = self
            .subagents
            .iter()
            .filter(|(k, s)| !active(&s.task["status"]) && !running.contains(k.as_str()))
            .min_by_key(|(_, s)| s.seq)
            .map(|(k, _)| k.clone());
        let Some(key) = oldest else {
            return false;
        };
        self.subagents.remove(&key);
        self.selections.remove(&key);
        self.usage.remove(&key);
        self.allowances.remove(&key);
        true
    }

    /// `registerSubagentThreads`: a completed `spawnAgent` call names its children.
    fn register_spawned(&mut self, turn_id: &str, item: &Value, out: &mut Vec<Out>) {
        if item["tool"] != "spawnAgent" {
            return;
        }
        let id = item["id"].as_str().unwrap_or_default();
        let receivers: Vec<String> = item["receiverThreadIds"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|t| t.as_str().map(str::to_owned))
            .collect();
        for (index, native_thread) in receivers.iter().enumerate() {
            let model = item["model"]
                .as_str()
                .filter(|m| !m.is_empty())
                .map(str::to_owned);
            self.register_subagent(
                Registration {
                    context: turn_id,
                    native_thread,
                    native_item: format!("{id}:{native_thread}"),
                    tool_call: id,
                    prompt: item["prompt"].as_str().unwrap_or_default().to_owned(),
                    title: None,
                    model,
                    effort: item.get("reasoningEffort").cloned(),
                    ordinal: u32::try_from(index + 1).unwrap_or(u32::MAX),
                    emit_prompt: true,
                },
                out,
            );
        }
    }

    /// `registerSubagentActivity`.
    fn subagent_activity(&mut self, turn_id: Option<&str>, item: &Value, out: &mut Vec<Out>) {
        let native_thread = item["agentThreadId"].as_str().unwrap_or_default();
        if item["kind"] == "started" {
            let Some(context) = turn_id.and_then(|t| self.turns.get(t)) else {
                return;
            };
            let root = context.root_node_id.clone();
            let ordinal = self
                .subagents
                .values()
                .filter(|s| s.parent.root_node_id == root)
                .count()
                + 1;
            let id = item["id"].as_str().unwrap_or_default();
            self.register_subagent(
                Registration {
                    context: turn_id.unwrap_or_default(),
                    native_thread,
                    native_item: format!("{id}:{native_thread}"),
                    tool_call: id,
                    prompt: String::new(),
                    title: item["agentPath"].as_str().map(str::to_owned),
                    model: None,
                    effort: None,
                    ordinal: u32::try_from(ordinal).unwrap_or(u32::MAX),
                    emit_prompt: false,
                },
                out,
            );
            return;
        }
        let status = match item["kind"].as_str() {
            Some("interrupted") => "interrupted",
            Some("completed") => "completed",
            _ => return,
        };
        self.task_update(
            native_thread,
            TaskUpdate {
                status,
                ..TaskUpdate::default()
            },
            out,
        );
    }

    /// `updateSubagentStates`: the children's states a collab call reports.
    fn update_states(&mut self, item: &Value, out: &mut Vec<Out>) {
        let Some(states) = item["agentsStates"].as_object() else {
            return;
        };
        for (native_thread, state) in states {
            if !self.subagents.contains_key(native_thread) {
                continue;
            }
            let Some(status) = collab_status(&state["status"]) else {
                continue;
            };
            let result = (!state["message"].is_null()).then(|| state["message"].clone());
            self.task_update(
                native_thread,
                TaskUpdate {
                    status,
                    result,
                    ..TaskUpdate::default()
                },
                out,
            );
        }
    }

    /// `item/started` of a subagent item. `collabAgentToolCall` only takes its position.
    pub(super) fn subagent_item_started(
        &mut self,
        turn_id: &str,
        item: &Value,
        out: &mut Vec<Out>,
    ) {
        if item["type"] == "subAgentActivity" {
            self.mark_subagent_usage(turn_id);
            self.subagent_activity(Some(turn_id), item, out);
        }
    }

    /// `item/completed` of a subagent item.
    pub(super) fn subagent_item_completed(
        &mut self,
        turn_id: &str,
        item: &Value,
        out: &mut Vec<Out>,
    ) {
        if self.stopped(turn_id) {
            return;
        }
        let kind = item["type"].as_str().unwrap_or_default();
        // Child lifecycle notifications outlive the parent's turn context.
        if kind == "subAgentActivity" && item["kind"] != "started" {
            self.subagent_activity(None, item, out);
            return;
        }
        if kind == "collabAgentToolCall" && item["tool"] != "spawnAgent" {
            self.update_states(item, out);
            return;
        }
        if !self.turns.contains_key(turn_id) {
            return;
        }
        self.mark_subagent_usage(turn_id);
        if kind == "collabAgentToolCall" {
            self.register_spawned(turn_id, item, out);
            self.update_states(item, out);
        } else {
            self.subagent_activity(Some(turn_id), item, out);
        }
    }

    /// `rememberSubagentTurnStarted`: a `turn/started` no root turn claims.
    pub(super) fn child_turn_seen(
        &mut self,
        native_thread: &str,
        native_turn: &str,
        started_at: String,
        out: &mut Vec<Out>,
    ) {
        if self.subagents.contains_key(native_thread) {
            self.child_turn_started(native_thread, native_turn, started_at, out);
            return;
        }
        if !self.pending_child_turns.contains_key(native_thread)
            && self.pending_child_turns.len() >= MAX_PENDING_CHILD_THREADS
        {
            return;
        }
        let pending = self
            .pending_child_turns
            .entry(native_thread.to_owned())
            .or_default();
        if pending.len() < MAX_PENDING_CHILD_TURNS {
            pending.push((native_turn.to_owned(), started_at));
        }
    }

    /// `emitSubagentProviderTurnStarted`.
    fn child_turn_started(
        &mut self,
        child: &str,
        native_turn: &str,
        started_at: String,
        out: &mut Vec<Out>,
    ) {
        let Some(sub) = self.subagents.get(child) else {
            return;
        };
        if sub.native_turns.iter().any(|t| t == native_turn) {
            return;
        }
        let parent_thread = sub.parent.native_thread_id.clone();
        let current_parent = self
            .turns
            .values()
            .find(|t| t.native_thread_id == parent_thread)
            .map(Turn::scope);
        // A child of a stopped turn that starts late is stopped too.
        let mut ancestor = Some(current_parent.clone().unwrap_or_else(|| sub.parent.clone()));
        while let Some(scope) = ancestor {
            if self.stopped(&scope.native_turn_id) {
                if let Some(sub) = self.subagents.get_mut(child) {
                    remember_turn(&mut sub.native_turns, native_turn);
                }
                out.push(Out::InterruptChild {
                    thread: child.to_owned(),
                    turn: native_turn.to_owned(),
                });
                return;
            }
            ancestor = scope
                .subagent
                .as_ref()
                .and_then(|k| self.subagents.get(k))
                .map(|s| s.parent.clone());
        }
        let Some(sub) = self.subagents.get_mut(child) else {
            return;
        };
        remember_turn(&mut sub.native_turns, native_turn);
        if let Some(parent) = current_parent {
            sub.parent = parent;
        }
        let ordinal = sub.last_turn_ordinal.saturating_add(1).max(1);
        sub.last_turn_ordinal = ordinal;
        let provider_turn_id = ids::provider_turn_id(DRIVER, native_turn);
        let node_id = if ordinal == 1 {
            sub.child_root.clone()
        } else {
            ids::node_from_item(DRIVER, &format!("{native_turn}:thread-root"))
        };
        let parent = sub.parent.clone();
        let turn = Turn {
            thread_id: sub.child_thread_id.clone(),
            run_id: None,
            run_ordinal: parent.run_ordinal,
            turn_ordinal: ordinal,
            attempt_id: None,
            root_node_id: node_id.clone(),
            node_started_at: Some(started_at.clone()),
            app_thread: sub.child_thread.clone(),
            model_selection: parent.model_selection.clone(),
            runtime_mode: parent.runtime_mode.clone(),
            subagent: Some(child.to_owned()),
            provider_thread_id: sub.provider_thread["id"]
                .as_str()
                .unwrap_or_default()
                .to_owned(),
            provider_session_id: parent.provider_session_id.clone(),
            native_thread_id: child.to_owned(),
            native_turn_id: native_turn.to_owned(),
            provider_turn_id: provider_turn_id.clone(),
            started_at: started_at.clone(),
            positions: HashMap::new(),
            file_change_kinds: HashMap::new(),
            message_phases: HashMap::new(),
            final_answer_ids: Vec::new(),
            completed_final_texts: HashSet::new(),
            running_commands: Vec::new(),
            running_tools: Vec::new(),
            running_compactions: Vec::new(),
            latest_failure: None,
        };
        let task_ref = sub.task["nativeTaskRef"].clone();
        let mut provider_thread = sub.provider_thread.clone();
        let child_thread_id = sub.child_thread_id.clone();
        self.begin_usage(child, native_turn);
        self.end_allowances_on_mode_change(child, &parent.runtime_mode);
        self.turns.insert(native_turn.to_owned(), turn);
        self.task_update(
            child,
            TaskUpdate {
                status: "running",
                started_at: Some(started_at.clone()),
                reopen: ordinal > 1,
                result: (ordinal > 1).then_some(Value::Null),
                ..TaskUpdate::default()
            },
            out,
        );
        let now = self.env.now();
        provider_thread["status"] = json!("active");
        provider_thread["updatedAt"] = json!(now);
        push_event(
            out,
            json!({"type": "provider_thread.updated", "providerThread": provider_thread}),
        );
        push_event(
            out,
            json!({"type": "provider_turn.updated", "threadId": child_thread_id, "providerTurn": {
                "id": provider_turn_id, "providerThreadId": provider_thread["id"], "nodeId": node_id,
                "runAttemptId": null, "nativeTurnRef": ref_strong(native_turn), "ordinal": ordinal,
                "status": "running", "startedAt": started_at, "completedAt": null,
            }}),
        );
        push_event(
            out,
            json!({"type": "node.updated", "node": {
                "id": node_id, "threadId": child_thread_id, "runId": null, "parentNodeId": null,
                "rootNodeId": node_id, "kind": "root_turn", "status": "running",
                "countsForRun": false, "providerThreadId": provider_thread["id"],
                "providerTurnId": provider_turn_id, "nativeItemRef": task_ref,
                "runtimeRequestId": null, "checkpointScopeId": null, "startedAt": started_at,
                "completedAt": null,
            }}),
        );
    }

    /// `emitSubagentUserMessage`: a child's later turns show what the parent sent it.
    pub(super) fn child_message(
        &mut self,
        turn_id: &str,
        item: &Value,
        started_at: Option<String>,
        out: &mut Vec<Out>,
    ) {
        let now = self.env.now();
        let Some(turn) = self.turns.get_mut(turn_id) else {
            return;
        };
        let Some(child) = turn.subagent.clone() else {
            return;
        };
        if turn.turn_ordinal == 1 {
            return;
        }
        let text = user_message_text(&item["content"]);
        if text.is_empty() {
            return;
        }
        let id = item["id"].as_str().unwrap_or_default();
        let (ordinal, at) = turn.position(id, started_at.unwrap_or(now));
        let Some(sender) = self
            .subagents
            .get(&child)
            .map(|s| s.parent.thread_id.clone())
        else {
            return;
        };
        child_user_message(
            &sender,
            id,
            &turn.thread_id,
            &turn.root_node_id,
            &turn.provider_thread_id,
            Some(&turn.provider_turn_id),
            &text,
            ordinal,
            &at,
            out,
        );
    }

    /// The final answer of a child's turn is its result (`item/completed` `agentMessage`).
    pub(super) fn child_result(&mut self, turn_id: &str, text: &str, out: &mut Vec<Out>) {
        let Some(child) = self.turns.get(turn_id).and_then(|t| t.subagent.clone()) else {
            return;
        };
        let Some(status) = self
            .subagents
            .get(&child)
            .map(|s| status_str(&s.task["status"]))
        else {
            return;
        };
        self.task_update(
            &child,
            TaskUpdate {
                status,
                result: Some(json!(text)),
                ..TaskUpdate::default()
            },
            out,
        );
    }

    /// The subagent part of `finalizeCodexTurn`: the child's root node, its provider thread
    /// back to idle, the parent's subagent node and the task.
    pub(super) fn finish_child(
        &mut self,
        turn: &Turn,
        child: &str,
        status: &str,
        completed_at: &str,
        out: &mut Vec<Out>,
    ) {
        let Some(sub) = self.subagents.get(child) else {
            return;
        };
        push_event(
            out,
            json!({"type": "node.updated", "node": {
                "id": turn.root_node_id, "threadId": turn.thread_id, "runId": null,
                "parentNodeId": null, "rootNodeId": turn.root_node_id, "kind": "root_turn",
                "status": status, "countsForRun": false, "providerThreadId": turn.provider_thread_id,
                "providerTurnId": turn.provider_turn_id, "nativeItemRef": sub.task["nativeTaskRef"],
                "runtimeRequestId": null, "checkpointScopeId": null,
                "startedAt": turn.node_started_at, "completedAt": completed_at,
            }}),
        );
        let mut provider_thread = sub.provider_thread.clone();
        provider_thread["status"] = json!("idle");
        provider_thread["updatedAt"] = json!(completed_at);
        push_event(
            out,
            json!({"type": "provider_thread.updated", "providerThread": provider_thread}),
        );
        push_event(
            out,
            json!({"type": "node.updated", "node": {
                "id": sub.node_id, "threadId": sub.parent.thread_id, "runId": sub.parent.run_id,
                "parentNodeId": sub.parent.root_node_id, "rootNodeId": sub.parent.root_node_id,
                "kind": "subagent", "status": status, "countsForRun": false,
                "providerThreadId": turn.provider_thread_id,
                "providerTurnId": sub.parent.provider_turn_id,
                "nativeItemRef": sub.task["nativeTaskRef"], "runtimeRequestId": null,
                "checkpointScopeId": null, "startedAt": sub.started_at,
                "completedAt": completed_at,
            }}),
        );
        let status = match status {
            "completed" => "completed",
            "interrupted" => "interrupted",
            "cancelled" => "cancelled",
            _ => "failed",
        };
        self.task_update(
            child,
            TaskUpdate {
                status,
                completed_at: Some(completed_at.to_owned()),
                ..TaskUpdate::default()
            },
            out,
        );
        self.wake_parent(child, status, out);
    }

    /// Codex does not wake a completed parent turn, so a child's result would stay unread: a
    /// direct child that completes or fails after its root turn ended asks for a continuation
    /// turn (`finalizeCodexTurn`, `codexNativeSubagentDetail`). Not when the root turn was
    /// stopped or failed, nor while a root turn runs on the parent thread (it gets the result
    /// itself); a grandchild reports to its own parent.
    fn wake_parent(&mut self, child: &str, status: &str, out: &mut Vec<Out>) {
        let Some(sub) = self.subagents.get(child) else {
            return;
        };
        let parent = &sub.parent;
        if parent.subagent.is_some()
            || !(status == "completed" || status == "failed")
            || self.stopped(&parent.native_turn_id)
            || self
                .turns
                .values()
                .any(|t| t.subagent.is_none() && t.provider_thread_id == parent.provider_thread_id)
        {
            return;
        }
        let task = &sub.task;
        let label = subagent_label(task);
        let header = format!(
            "Subagent {}: {}",
            task["status"].as_str().unwrap_or_default(),
            label
                .clone()
                .unwrap_or_else(|| task["id"].as_str().unwrap_or_default().to_owned())
        );
        let detail = match task["result"].as_str().filter(|r| !r.is_empty()) {
            Some(result) => format!("{header}\n\nResult:\n{result}"),
            None => header,
        };
        let notice = notification::background_work_notification(&[notification::Work {
            kind: notification::WorkKind::Subagent,
            label,
            outcome: if status == "completed" {
                "completed"
            } else {
                "failed"
            },
            child_thread_id: Some(sub.child_thread_id.clone()),
            exit_code: None,
        }]);
        out.push(Out::Event(ProviderEvent::ContinuationRequested(
            ContinuationRequest {
                thread_id: parent.thread_id.as_str().into(),
                provider_thread_id: parent.provider_thread_id.as_str().into(),
                detail: Some(detail),
                notification: notice,
                delivery: Some("message_text".into()),
            },
        )));
    }

    /// `approvalOwnerCodexTurn`: an approval a child raises shows on the root turn, under the
    /// top-level subagent's node. Returns the owner's native turn and that node.
    pub(super) fn approval_owner(&self, turn_id: &str) -> (String, Option<String>) {
        let Some(turn) = self.turns.get(turn_id) else {
            return (turn_id.to_owned(), None);
        };
        let mut owner = turn.scope();
        let mut node = None;
        let mut hops = 0;
        while let Some(sub) = owner.subagent.as_ref().and_then(|k| self.subagents.get(k)) {
            node = Some(sub.node_id.clone());
            owner = sub.parent.clone();
            hops += 1;
            if hops > MAX_SUBAGENTS {
                break;
            }
        }
        (owner.native_turn_id, node)
    }

    /// The running turns that belong to a turn's lineage: the turn and every running
    /// descendant (`isDescendantCodexTurn`), the turn first.
    pub fn lineage(&self, native_turn: &str) -> Vec<(String, String)> {
        let mut out = Vec::new();
        if let Some(turn) = self.turns.get(native_turn) {
            out.push((turn.native_thread_id.clone(), native_turn.to_owned()));
        }
        for turn in self.turns.values() {
            if turn.native_turn_id == native_turn {
                continue;
            }
            let mut hops = 0;
            let mut parent = turn
                .subagent
                .as_ref()
                .and_then(|k| self.subagents.get(k))
                .map(|s| s.parent.clone());
            while let Some(scope) = parent {
                if scope.native_turn_id == native_turn {
                    out.push((turn.native_thread_id.clone(), turn.native_turn_id.clone()));
                    break;
                }
                hops += 1;
                if hops > MAX_SUBAGENTS {
                    break;
                }
                parent = scope
                    .subagent
                    .as_ref()
                    .and_then(|k| self.subagents.get(k))
                    .map(|s| s.parent.clone());
            }
        }
        out
    }

    /// Ends a running turn as interrupted without Codex's word, as T3's
    /// `finalizeRemainingInterruptLineage` does for a Stop's lineage.
    pub fn end_interrupted(&mut self, native_turn: &str) -> Vec<Out> {
        let mut out = Vec::new();
        let now = self.env.now();
        self.finalize(native_turn, "interrupted", now, None, None, &mut out);
        out
    }
}

/// `codexNativeSubagentLabel`: the title, else the prompt, trimmed; `None` when both are empty.
fn subagent_label(task: &Value) -> Option<String> {
    [&task["title"], &task["prompt"]]
        .into_iter()
        .filter_map(Value::as_str)
        .map(str::trim)
        .find(|s| !s.is_empty())
        .map(str::to_owned)
}

fn status_str(status: &Value) -> &'static str {
    match status.as_str() {
        Some("pending") => "pending",
        Some("waiting") => "waiting",
        Some("completed") => "completed",
        Some("interrupted") => "interrupted",
        Some("cancelled") => "cancelled",
        Some("failed") => "failed",
        _ => "running",
    }
}

fn remember_turn(turns: &mut Vec<String>, native_turn: &str) {
    if turns.len() >= MAX_CHILD_TURNS {
        turns.remove(0);
    }
    turns.push(native_turn.to_owned());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titles_follow_subagent_thread_title() {
        assert_eq!(child_title("Parent", Some(" Audit "), "p", 1), "Audit");
        assert_eq!(child_title("Parent", None, "  ", 3), "Parent subagent 3");
        let long = "x".repeat(80);
        assert_eq!(
            child_title("P", Some(&long), "", 0).encode_utf16().count(),
            72
        );
        // A surrogate pair at the cut is not split.
        let emoji = format!("{}{}", "x".repeat(68), "😀".repeat(4));
        let cut = child_title("P", Some(&emoji), "", 0);
        assert!(cut.ends_with("x..."), "{cut}");
    }

    #[test]
    fn child_thread_ids_match_t3() {
        // From T3's capture of `subagent_v2`.
        assert_eq!(
            subagent_thread_id("01a0d5ff-5f36-77f1-afa9-cc3dd93018dc"),
            "thread:subagent:c7e538cd63191064"
        );
    }
}
