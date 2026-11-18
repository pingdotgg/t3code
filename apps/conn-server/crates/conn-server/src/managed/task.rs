//! The task worker grant: Orbit's task-copy worker drives one admitted turn over the
//! orchestration RPC (Conn integration item 6, "Task-copy RPC (target)").
//!
//! It is a managed token (item 4's binding: Gateway introspection, caller-to-target peer
//! binding, the revocation fence). Its claims carry fixed scopes and one `task_grant` that
//! names the task, the copy, the turn and an allowlist fixed at capture. The target refuses
//! any thread, run, request or command outside it, even when the scopes match. Writes go
//! through [`conn_engine::Engine::dispatch_guarded`], so the ownership check and the accept
//! are one step. There is no second credential: no other bearer reaches these handlers.

use std::sync::Arc;

use conn_contract::{Command, SubscribeThreadInput, ThreadId, to_json};
use conn_engine::{CommitGate, DispatchGuard, Engine, EngineError, GuardRule, OwnedMessage};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::Claims;
use crate::table::{Failure, MethodTable};

/// The fixed scopes of a task worker token.
pub const WORKER_SCOPES: [&str; 2] = ["orchestration:operate", "orchestration:read"];
/// The only RPC methods a task worker may call.
pub const WORKER_METHODS: [&str; 3] = [
    "orchestration.dispatchCommand",
    "orchestration.getThreadProjection",
    "orchestration.subscribeThread",
];
/// The claims field that holds the grant.
pub const GRANT_FIELD: &str = "task_grant";

/// The frozen `thread.create` of a turn that creates its thread.
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct FrozenCreate {
    pub command_id: String,
    /// The complete command body apart from `type`, `commandId` and `threadId`: project,
    /// title, provider instance, model and options, runtime and interaction mode, branch,
    /// worktree path, attribution. The command must carry exactly these fields (a `null`
    /// field counts as absent) and no other.
    pub body: serde_json::Map<String, Value>,
}

/// The frozen `message.dispatch` of the turn.
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct FrozenMessage {
    pub command_id: String,
    pub message_id: String,
    /// SHA-256 of the message text, lowercase hex.
    pub text_sha256: String,
    /// The command ID of the one `run.interrupt` that may stop this message's run.
    pub interrupt_command_id: String,
    /// The captured attribution: the message carries exactly these.
    pub created_by: String,
    pub creation_source: String,
}

/// An earlier, unsettled turn this one may settle: read the evidence of its frozen message,
/// and stop only the run that message started.
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct EarlierTurn {
    pub thread_id: String,
    pub message_id: String,
    pub text_sha256: String,
    /// The run the earlier worker recorded, if it did.
    #[serde(default)]
    pub run_id: Option<String>,
    pub interrupt_command_id: String,
    /// The earlier message's captured attribution.
    pub created_by: String,
    pub creation_source: String,
}

/// A stored question of the admitted thread whose request the answer turn may cancel.
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct StoredQuestion {
    pub thread_id: String,
    pub request_id: String,
    pub owner_run_id: String,
    pub cancel_command_id: String,
}

/// The fields a task `message.dispatch` may carry. Any other field with a value (a model
/// selection, a fresh context, a sender, a steer) is refused.
const MESSAGE_FIELDS: [&str; 9] = [
    "type",
    "commandId",
    "threadId",
    "messageId",
    "text",
    "attachments",
    "createdBy",
    "creationSource",
    "dispatchMode",
];

/// `value`'s object fields without the `null` ones.
fn present(value: &Value) -> serde_json::Map<String, Value> {
    value
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(_, v)| !v.is_null())
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect()
}

fn is_digest(text: &str) -> bool {
    text.len() == 64 && text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// The `task_grant` claim.
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct TaskGrant {
    pub purpose: String,
    pub task_id: Value,
    pub copy_id: Value,
    pub turn_id: Value,
    /// The copy's one admitted workspace project.
    pub project_id: String,
    /// The admitted thread.
    pub thread_id: String,
    #[serde(default)]
    pub create: Option<FrozenCreate>,
    pub message: FrozenMessage,
    #[serde(default)]
    pub earlier: Vec<EarlierTurn>,
    #[serde(default)]
    pub questions: Vec<StoredQuestion>,
}

fn non_empty(text: &str) -> bool {
    !text.trim().is_empty()
}

impl TaskGrant {
    /// Reads and checks the grant of `claims`. `None` refuses the token.
    pub fn from_claims(claims: &Claims) -> Option<Self> {
        let mut scopes: Vec<&str> = claims.scopes.iter().map(String::as_str).collect();
        scopes.sort_unstable();
        scopes.dedup();
        if scopes != WORKER_SCOPES || claims.extra.len() != 1 {
            return None;
        }
        let grant: Self = serde_json::from_value(claims.extra.get(GRANT_FIELD)?.clone()).ok()?;
        let identified = [&grant.task_id, &grant.copy_id, &grant.turn_id]
            .iter()
            .all(|id| matches!(id, Value::Number(_)) || id.as_str().is_some_and(non_empty));
        let message = &grant.message;
        let well_formed = grant.purpose == "task_worker"
            && identified
            && non_empty(&grant.project_id)
            && non_empty(&grant.thread_id)
            && non_empty(&message.command_id)
            && non_empty(&message.message_id)
            && non_empty(&message.interrupt_command_id)
            && is_digest(&message.text_sha256)
            && grant.create.as_ref().is_none_or(|create| {
                non_empty(&create.command_id)
                    && create.body.get("projectId") == Some(&json!(grant.project_id))
                    && !create.body.keys().any(|k| {
                        matches!(k.as_str(), "type" | "commandId" | "threadId" | "initialMessage")
                    })
            })
            && grant.earlier.iter().all(|e| {
                non_empty(&e.thread_id)
                    && non_empty(&e.message_id)
                    && non_empty(&e.interrupt_command_id)
                    && non_empty(&e.created_by)
                    && non_empty(&e.creation_source)
                    && is_digest(&e.text_sha256)
            })
            // A stored question belongs to the thread this turn answers.
            && grant.questions.iter().all(|q| {
                q.thread_id == grant.thread_id
                    && non_empty(&q.request_id)
                    && non_empty(&q.owner_run_id)
                    && non_empty(&q.cancel_command_id)
            });
        well_formed.then_some(grant)
    }

    /// Threads the worker may read: its own, and each earlier turn's.
    fn may_read(&self, thread_id: &str) -> bool {
        thread_id == self.thread_id || self.earlier.iter().any(|e| e.thread_id == thread_id)
    }

    fn guard(&self, rule: GuardRule) -> DispatchGuard {
        DispatchGuard {
            project_id: self.project_id.clone(),
            rule,
        }
    }

    /// The guard for one command, or why it is outside the grant.
    pub fn guard_for(&self, command: &Value) -> Result<DispatchGuard, String> {
        let text = |key: &str| command[key].as_str().unwrap_or_default();
        let thread_id = text("threadId");
        let command_id = text("commandId");
        match text("type") {
            "thread.create" => {
                let Some(create) = &self.create else {
                    return Err("this turn creates no thread".into());
                };
                if thread_id != self.thread_id || command_id != create.command_id {
                    return Err("not the admitted thread or command".into());
                }
                let mut body = present(command);
                for key in ["type", "commandId", "threadId"] {
                    body.remove(key);
                }
                if body != present(&Value::Object(create.body.clone())) {
                    return Err("the create body differs from the frozen one".into());
                }
                Ok(self.guard(GuardRule::NewThread))
            }
            "message.dispatch" => {
                let message = &self.message;
                if thread_id != self.thread_id
                    || command_id != message.command_id
                    || text("messageId") != message.message_id
                {
                    return Err("not the admitted message".into());
                }
                if present(command)
                    .keys()
                    .any(|k| !MESSAGE_FIELDS.contains(&k.as_str()))
                {
                    return Err("the message carries a field a task message may not".into());
                }
                let digest =
                    conn_support::hex::hex(&conn_support::hmac::sha256(text("text").as_bytes()));
                if digest != message.text_sha256 {
                    return Err("the message body differs from the frozen one".into());
                }
                if command["attachments"]
                    .as_array()
                    .is_none_or(|a| !a.is_empty())
                {
                    return Err("a task message carries no attachments".into());
                }
                if text("createdBy") != message.created_by
                    || text("creationSource") != message.creation_source
                {
                    return Err("the message's attribution differs from the captured one".into());
                }
                if command["dispatchMode"] != json!({"type": "start_immediately"}) {
                    return Err("a task message starts its run at once".into());
                }
                Ok(self.guard(GuardRule::ExclusiveStart))
            }
            "run.interrupt" => {
                // Each admitted stop has its own command ID, naming the one message whose
                // run it may stop.
                let own = (thread_id == self.thread_id
                    && command_id == self.message.interrupt_command_id)
                    .then(|| OwnedMessage {
                        message_id: self.message.message_id.clone(),
                        text_sha256: self.message.text_sha256.clone(),
                        run_id: None,
                        created_by: self.message.created_by.clone(),
                        creation_source: self.message.creation_source.clone(),
                        require_started: false,
                    });
                let earlier = || {
                    self.earlier
                        .iter()
                        .find(|e| e.thread_id == thread_id && e.interrupt_command_id == command_id)
                        .map(|e| OwnedMessage {
                            message_id: e.message_id.clone(),
                            text_sha256: e.text_sha256.clone(),
                            run_id: e.run_id.clone(),
                            created_by: e.created_by.clone(),
                            creation_source: e.creation_source.clone(),
                            require_started: true,
                        })
                };
                match own.or_else(earlier) {
                    Some(owned) => Ok(self.guard(GuardRule::OwnRun(vec![owned]))),
                    None => Err("not an admitted stop".into()),
                }
            }
            "runtime-request.respond" => {
                let request_id = text("requestId");
                let Some(question) = self.questions.iter().find(|q| {
                    thread_id == self.thread_id
                        && q.request_id == request_id
                        && q.cancel_command_id == command_id
                }) else {
                    return Err("not a stored question".into());
                };
                if command["decision"] != "cancel" {
                    return Err("a stored question may only be cancelled".into());
                }
                Ok(self.guard(GuardRule::PendingQuestionOf {
                    owner_run_id: question.owner_run_id.clone(),
                }))
            }
            _ => Err("the command is outside the task grant".into()),
        }
    }

    /// The part of an earlier turn's thread the worker may see: its frozen message, the run
    /// that message started, that run's nodes and requests, and a schema-valid thread with
    /// its details blanked. Evidence that fails the ownership checks (another body, several
    /// runs, another recorded run) is refused, so the earlier turn stays unsettled.
    fn settlement_view(&self, thread_id: &str, mut projection: Value) -> Result<Value, String> {
        if thread_id == self.thread_id {
            return Ok(projection);
        }
        let rows = |key: &str| projection[key].as_array().cloned().unwrap_or_default();
        let mut messages = Vec::new();
        let mut runs = Vec::new();
        for earlier in self.earlier.iter().filter(|e| e.thread_id == thread_id) {
            let found: Vec<Value> = rows("messages")
                .into_iter()
                .filter(|m| m["id"] == earlier.message_id.as_str())
                .collect();
            let Some(message) = found.first() else {
                // Missing: nothing of it is shown; with no evidence left the read is refused,
                // and the earlier turn stays unsettled.
                continue;
            };
            let attribution = Some((
                earlier.created_by.as_str(),
                earlier.creation_source.as_str(),
            ));
            if found.len() != 1
                || !conn_engine::is_frozen_message(message, &earlier.text_sha256, attribution)
            {
                return Err("the earlier message differs from the frozen one".into());
            }
            let started: Vec<Value> = rows("runs")
                .into_iter()
                .filter(|r| r["userMessageId"] == earlier.message_id.as_str())
                .collect();
            // Exactly one run, and the recorded one if there is a record: anything else
            // leaves the earlier turn unsettled, and shows nothing.
            let [run] = started.as_slice() else {
                return Err("the earlier message did not start exactly one run".into());
            };
            // A run row exists from the moment a message queues; only one that left the queue
            // and started is evidence of the turn.
            if run["startedAt"].is_null() {
                return Err("the earlier run never started".into());
            }
            if earlier
                .run_id
                .as_ref()
                .is_some_and(|recorded| run["id"] != recorded.as_str())
            {
                return Err("the earlier run is not the recorded one".into());
            }
            messages.push(earlier.message_id.clone());
            runs.extend(
                started
                    .iter()
                    .filter_map(|r| r["id"].as_str().map(str::to_owned)),
            );
        }
        if runs.is_empty() {
            return Err("no settlement evidence: the frozen message or its run is missing".into());
        }
        let has = |list: &[String], value: &Value| {
            value.as_str().is_some_and(|v| list.iter().any(|x| x == v))
        };
        let nodes: Vec<String> = rows("nodes")
            .iter()
            .filter(|n| has(&runs, &n["runId"]))
            .filter_map(|n| n["id"].as_str().map(str::to_owned))
            .collect();
        let Some(object) = projection.as_object_mut() else {
            return Err("the projection cannot be read".into());
        };
        let mut latest: Option<String> = None;
        for (key, value) in object.iter_mut() {
            let Some(list) = value.as_array_mut() else {
                continue;
            };
            match key.as_str() {
                "messages" => list.retain(|m| has(&messages, &m["id"])),
                "runs" => list.retain(|r| has(&runs, &r["id"])),
                "nodes" => list.retain(|n| has(&nodes, &n["id"])),
                "runtimeRequests" => list.retain(|q| has(&nodes, &q["nodeId"])),
                _ => list.clear(),
            }
            for row in list.iter() {
                for field in [
                    "updatedAt",
                    "completedAt",
                    "resolvedAt",
                    "createdAt",
                    "requestedAt",
                ] {
                    if let Some(time) = row[field].as_str()
                        && latest.as_deref().is_none_or(|l| time > l)
                    {
                        latest = Some(time.to_owned());
                    }
                }
            }
        }
        // The thread is rebuilt from an allowlist: a valid `OrchestrationV2AppThread` that
        // names no title, branch, worktree, tag, pin or later provider thread of the other
        // role. Its model is the evidence run's; its times come from the evidence only.
        let created = object["thread"]["createdAt"].clone();
        let latest = latest.map_or(created.clone(), Value::from);
        let source = object["thread"].clone();
        let run = object["runs"]
            .as_array()
            .and_then(|r| r.first())
            .cloned()
            .unwrap_or(Value::Null);
        object.insert(
            "thread".into(),
            json!({
                "id": source["id"],
                "projectId": source["projectId"],
                "title": "Earlier turn",
                "createdBy": source["createdBy"],
                "creationSource": source["creationSource"],
                "providerInstanceId": run["providerInstanceId"],
                "modelSelection": run["modelSelection"],
                "runtimeMode": "full-access",
                "interactionMode": "default",
                "branch": null,
                "worktreePath": null,
                "activeProviderThreadId": null,
                "lineage": {"parentThreadId": null, "relationshipToParent": null,
                    "rootThreadId": source["id"]},
                "forkedFrom": null,
                "createdAt": created,
                "updatedAt": latest,
                "archivedAt": null,
                "deletedAt": null,
            }),
        );
        object.insert("updatedAt".into(), latest);
        Ok(projection)
    }
}

/// Whether `claims` are a task worker token with a well-formed grant.
pub fn is_task_worker(claims: &Claims) -> bool {
    TaskGrant::from_claims(claims).is_some()
}

/// The typed refusal a client decodes for any of these methods: the scope check's own
/// `EnvironmentAuthorizationError`, naming the permission the call needed.
fn outside(reason: &str, permission: &str) -> Failure {
    Failure::Fail(json!({
        "_tag": "EnvironmentAuthorizationError",
        "message": format!("Outside the task grant: {reason}."),
        "requiredScope": crate::auth::legacy_parent(permission),
        "requiredPermission": permission,
    }))
}

const READ: &str = "orchestration:read";
const OPERATE: &str = "orchestration:operate";

fn failure<E: Serialize>(error: EngineError<E>) -> Failure {
    match error {
        EngineError::Rejected(error) => Failure::fail(&error),
        EngineError::Internal(message) => Failure::die(message),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadIdInput {
    thread_id: ThreadId,
}

/// `getThreadProjection` for the worker: an admitted thread of the admitted project, cut to
/// the settlement evidence when it is an earlier turn's thread.
async fn read_thread(
    engine: &Arc<dyn Engine>,
    grant: &TaskGrant,
    thread_id: ThreadId,
) -> Result<Value, Failure> {
    if !grant.may_read(thread_id.as_str()) {
        return Err(outside("not an admitted thread", READ));
    }
    // A thread ID that was deleted before may carry another thread's rows: never read it.
    if engine
        .thread_ever_deleted(thread_id.as_str())
        .await
        .unwrap_or(true)
    {
        return Err(outside("the thread ID was deleted before", READ));
    }
    let projection = engine
        .get_thread_projection(thread_id.clone())
        .await
        .map_err(failure)?;
    // Deletions are never undone: no deletion seen after the read means the projection was
    // of the one thread this ID ever named.
    if engine
        .thread_ever_deleted(thread_id.as_str())
        .await
        .unwrap_or(true)
    {
        return Err(outside("the thread ID was deleted before", READ));
    }
    if projection["thread"]["projectId"] != grant.project_id.as_str() {
        return Err(outside("the thread belongs to another project", READ));
    }
    let projection = own_rows(thread_id.as_str(), projection);
    grant
        .settlement_view(thread_id.as_str(), projection)
        .map_err(|r| outside(&r, READ))
}

/// The projection without rows of other threads: T3's projection also lists the provider
/// threads its subagents run on, which belong to the child threads.
fn own_rows(thread_id: &str, mut projection: Value) -> Value {
    let foreign = |row: &Value, key: &str| row[key].as_str().is_some_and(|t| t != thread_id);
    if let Some(object) = projection.as_object_mut() {
        for (key, value) in object.iter_mut() {
            if key == "thread" {
                continue;
            }
            if let Some(rows) = value.as_array_mut() {
                rows.retain(|row| !foreign(row, "threadId") && !foreign(row, "appThreadId"));
            }
        }
    }
    projection
}

/// Forwards a thread stream while the thread is the admitted project's. A snapshot of
/// another project, the thread's deletion, or a thread event naming another project ends the
/// stream with a refusal: a thread ID recreated elsewhere is never followed.
fn bound_to_project(
    mut items: crate::table::ItemStream,
    project_id: String,
    thread_id: String,
    engine: Arc<dyn Engine>,
) -> crate::table::ItemStream {
    let (tx, rx) = tokio::sync::mpsc::channel(16);
    tokio::spawn(async move {
        loop {
            let item = tokio::select! {
                () = tx.closed() => return,
                item = items.recv() => item,
            };
            let Some(mut item) = item else { return };
            // A snapshot carries only the admitted thread's own rows, and is shown only if
            // no deletion of this ID happened before it: a later one arrives as an event.
            if let Ok(value) = &mut item
                && value["kind"] == "snapshot"
            {
                if engine.thread_ever_deleted(&thread_id).await.unwrap_or(true) {
                    let _ = tx
                        .send(Err(outside("the thread ID was deleted before", READ)))
                        .await;
                    return;
                }
                let projection = value["projection"].take();
                value["projection"] = own_rows(&thread_id, projection);
            }
            let outside_project = item.as_ref().is_ok_and(|value| {
                let snapshot = &value["projection"]["thread"]["projectId"];
                let event = &value["event"];
                let event_type = event["type"].as_str().unwrap_or_default();
                let named = &event["payload"]["projectId"];
                (value["kind"] == "snapshot" && *snapshot != project_id.as_str())
                    || event_type == "thread.deleted"
                    || (event_type.starts_with("thread.")
                        && !named.is_null()
                        && *named != project_id.as_str())
            });
            if outside_project {
                let _ = tx
                    .send(Err(outside("the thread left the admitted project", READ)))
                    .await;
                return;
            }
            let ended = item.is_err();
            if tx.send(item).await.is_err() || ended {
                return;
            }
        }
    });
    rx
}

/// The method table of one task worker session: the allowlist, bound to its grant. Every
/// write commits only while `commit_gate` (the session's managed handler) is open.
pub fn table(
    engine: Arc<dyn Engine>,
    grant: Arc<TaskGrant>,
    commit_gate: Arc<dyn CommitGate>,
) -> MethodTable {
    let mut table = MethodTable::new();
    let (e, g) = (engine.clone(), grant.clone());
    table.unary(
        "orchestration.dispatchCommand",
        move |_, command: Command| {
            let (e, g, c) = (e.clone(), g.clone(), commit_gate.clone());
            async move {
                let guard = g
                    .guard_for(&to_json(&command))
                    .map_err(|r| outside(&r, OPERATE))?;
                e.dispatch_guarded(command, guard, Some(c))
                    .await
                    .map_err(failure)
            }
        },
    );
    let (e, g) = (engine.clone(), grant.clone());
    table.unary(
        "orchestration.getThreadProjection",
        move |_, input: ThreadIdInput| {
            let (e, g) = (e.clone(), g.clone());
            async move { read_thread(&e, &g, input.thread_id).await }
        },
    );
    let (e, g) = (engine, grant);
    table.stream(
        "orchestration.subscribeThread",
        move |_, input: SubscribeThreadInput| {
            let (e, g) = (e.clone(), g.clone());
            async move {
                if input.thread_id != g.thread_id {
                    return Err(outside("not the admitted thread", READ));
                }
                read_thread(&e, &g, ThreadId::from(input.thread_id.clone())).await?;
                let items = e.subscribe_thread(input).await.map_err(failure)?;
                // The stream's cursor is set now: a deletion before this point is in the
                // history, a later one arrives as an event and ends the stream.
                if e.thread_ever_deleted(&g.thread_id).await.unwrap_or(true) {
                    return Err(outside("the thread ID was deleted before", READ));
                }
                let items = crate::methods::orchestration::forward(items);
                Ok(bound_to_project(
                    items,
                    g.project_id.clone(),
                    g.thread_id.clone(),
                    e.clone(),
                ))
            }
        },
    );
    table
}

#[cfg(test)]
#[path = "task_tests.rs"]
mod tests;
