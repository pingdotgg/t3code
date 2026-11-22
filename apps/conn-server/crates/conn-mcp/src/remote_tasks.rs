//! `delegate_task` to a linked environment, as T3's `RemoteDelegation.ts` does it. The task's
//! child is an ordinary thread there, launched through the link with `delegatedFrom`; the
//! parent here records the task like a local one (`delegated_task.remote.request`), without a
//! child thread, and a follower completes it (`delegated_task.remote.complete`) when the thread
//! there ends, so the parent wakes as it does for a local child.
//!
//! A forwarded `conn_thread_send` that started or queued a run on the thread of one of the
//! caller's finished remote tasks is a follow-up: that run is a new task here, whose id the
//! send returns ([`follow_up`]). Cancelling a task, or a Stop of its parent, stops its thread
//! there; the follower carries a stop that could not be sent at once, across restarts.
//!
//! One follower runs per open task, at most [`MAX_FOLLOWERS`]. It waits on the thread there in
//! 45 s steps (the forwarder's cap) and races each step against the task ending here.

use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use conn_contract::{ThreadId, from_json};
use serde_json::{Map, Value, json};

use crate::peers::{PeerCall, PeerFailure, PeerLimits, PeerSender, scope_request};
use crate::tools::{Args, Cx, ToolError, ToolResult, fail};
use crate::{Caller, McpService};

/// T3 asks for ten minutes; the forwarder caps every wait at 45 s, so this is what is sent.
const FOLLOW_WAIT_MS: i64 = 45_000;
/// A linked environment that stops answering is retried, backing off to this.
const MAX_BACKOFF: Duration = Duration::from_secs(5 * 60);
const FIRST_BACKOFF: Duration = Duration::from_secs(2);
/// A follower that fails this many times in a row on this side gives its task up.
const MAX_DEFECTS: u32 = 3;
/// Followers that run at once. A task above it is followed after the next one ends.
const MAX_FOLLOWERS: usize = 1024;
/// Open tasks read in one scan.
const SCAN_LIMIT: usize = MAX_FOLLOWERS;
const TERMINAL: [&str; 5] = [
    "completed",
    "failed",
    "cancelled",
    "interrupted",
    "rolled_back",
];
/// The longest reply a follower keeps as a task's result.
const MAX_REPLY_BYTES: usize = 4 * 1024 * 1024;
const NO_REPLY: &str = "(The thread in the linked environment ended without a reply.)";

/// Which tasks have a follower, and whether one was asked to look again.
#[derive(Debug, Default)]
pub(crate) struct Followers {
    running: std::sync::Mutex<HashMap<String, bool>>,
    /// A task was left out because [`MAX_FOLLOWERS`] ran: scan again when one ends.
    rescan: AtomicBool,
}

/// Why one look at a task did not finish it.
enum Step {
    /// The linked environment refused or did not answer: retried, or final (`isFinal`).
    Peer(PeerFailure),
    /// This side failed (the engine): counted, and the task given up after [`MAX_DEFECTS`].
    Defect(String),
}

impl From<PeerFailure> for Step {
    fn from(failure: PeerFailure) -> Self {
        Self::Peer(failure)
    }
}

type StepResult<T> = Result<T, Step>;

/// How this environment reaches a task's thread there (`followScope`): as the parent thread,
/// under one namespace per parent, so a stop sent again is recorded there once.
struct Scope {
    namespace: String,
    limits: PeerLimits,
    sender: PeerSender,
}

fn is_mode_refusal(failure: &PeerFailure) -> bool {
    matches!(
        failure.code.as_str(),
        "runtime_mode_escalation_denied" | "interaction_mode_escalation_denied"
    )
}

/// Refusals that following again cannot change (`isFinal`).
fn is_final(failure: &PeerFailure) -> bool {
    matches!(
        failure.code.as_str(),
        "capability_denied" | "thread_not_found" | "run_not_found"
    )
}

fn terminal_status(status: &str) -> &'static str {
    match status {
        "completed" => "completed",
        "failed" => "failed",
        "interrupted" => "interrupted",
        _ => "cancelled",
    }
}

fn text(value: &Value) -> Option<&str> {
    value.as_str()
}

/// `withExecutedModelNote`.
fn with_executed_model_note(result: &str, requested: &Value, executed: &Value) -> String {
    match (text(executed), text(requested)) {
        (Some(executed), requested) if Some(executed) != requested => format!(
            "Requested model {}; the provider reported running {executed}.\n\n{result}",
            requested.unwrap_or_default()
        ),
        _ => result.to_owned(),
    }
}

impl McpService {
    fn links(&self) -> Option<&dyn crate::Peers> {
        self.config.peers.as_deref()
    }

    /// Follows every open remote task until it ends, including after a restart, and a
    /// finished one again when a Stop here owes it a stop there.
    pub fn start_remote_tasks(self: &Arc<Self>) {
        let service = self.clone();
        tokio::spawn(async move { service.scan_remote_tasks().await });
    }

    async fn scan_remote_tasks(self: &Arc<Self>) {
        match self.config.engine.open_remote_tasks(SCAN_LIMIT).await {
            Ok(open) => {
                // A full scan may have left tasks out: scan again when a follower ends.
                if open.len() >= SCAN_LIMIT {
                    self.remote.rescan.store(true, Ordering::Relaxed);
                }
                for (parent, task) in open {
                    self.follow_remote_task(&parent, &task);
                }
            }
            Err(error) => eprintln!("conn-mcp: could not read remote tasks: {error}"),
        }
    }

    /// `followOne`: a follower for the task, at most one. Asked again while it runs, it looks
    /// once more before it ends, so a Stop here is not missed.
    pub fn follow_remote_task(self: &Arc<Self>, parent: &str, task: &str) {
        {
            let mut running = crate::lock(&self.remote.running);
            if let Some(again) = running.get_mut(task) {
                *again = true;
                return;
            }
            if running.len() >= MAX_FOLLOWERS {
                self.remote.rescan.store(true, Ordering::Relaxed);
                return;
            }
            running.insert(task.to_owned(), false);
        }
        let (service, parent, task) = (self.clone(), parent.to_owned(), task.to_owned());
        tokio::spawn(async move {
            loop {
                service.follow(&parent, &task).await;
                // Checked and released under one lock, so a request between them is not lost.
                let mut running = crate::lock(&service.remote.running);
                match running.get_mut(&task) {
                    Some(again) if *again => *again = false,
                    _ => {
                        running.remove(&task);
                        break;
                    }
                }
            }
            if service.remote.rescan.swap(false, Ordering::Relaxed) {
                service.scan_remote_tasks().await;
            }
        });
    }

    /// The parent thread's projection, or `None` when it is gone.
    async fn parent_projection(&self, parent: &str) -> StepResult<Option<Value>> {
        match self
            .config
            .engine
            .get_thread_projection(ThreadId::from(parent))
            .await
        {
            Ok(projection) if projection["thread"]["deletedAt"].is_null() => Ok(Some(projection)),
            Ok(_) | Err(conn_engine::EngineError::Rejected(_)) => Ok(None),
            Err(conn_engine::EngineError::Internal(message)) => Err(Step::Defect(message)),
        }
    }

    async fn read_remote_task(
        &self,
        parent: &str,
        task: &str,
    ) -> StepResult<Option<(Value, Value)>> {
        let Some(projection) = self.parent_projection(parent).await? else {
            return Ok(None);
        };
        let row = projection["subagents"]
            .as_array()
            .and_then(|rows| rows.iter().find(|row| row["id"] == task))
            .cloned();
        Ok(row.map(|row| (projection, row)))
    }

    fn follow_scope(&self, parent: &str, thread: &Value) -> Scope {
        Scope {
            namespace: format!("remote-task:{parent}"),
            limits: PeerLimits {
                runtime_mode: thread["runtimeMode"]
                    .as_str()
                    .unwrap_or("approval-required")
                    .to_owned(),
                interaction_mode: thread["interactionMode"]
                    .as_str()
                    .unwrap_or("default")
                    .to_owned(),
            },
            sender: PeerSender {
                environment_id: self.config.environment_id.clone(),
                thread_id: parent.to_owned(),
                title: thread["title"].as_str().unwrap_or_default().to_owned(),
            },
        }
    }

    /// One tool there for a follower. Tasks already running there keep following while the
    /// beta is off (`readThread`, `waitForThread`, `interruptThread` skip `requireEnabled`).
    async fn there(
        &self,
        scope: &Scope,
        environment: &str,
        tool: &str,
        mut args: Args,
    ) -> Result<Value, PeerFailure> {
        let Some(peers) = self.links() else {
            return Err(PeerFailure {
                code: "capability_denied".into(),
                message: crate::peers::LINKED_ENVIRONMENTS_OFF.into(),
            });
        };
        scope_request(&mut args, tool, &scope.namespace);
        peers
            .call(PeerCall {
                environment_id: environment.to_owned(),
                tool: tool.to_owned(),
                arguments: args,
                limits: scope.limits.clone(),
                sender: Some(scope.sender.clone()),
            })
            .await
    }

    /// Stops the task's thread there as its Stop button does. `key` names the stop, so each is
    /// recorded there once however often it is sent.
    async fn stop_there(
        &self,
        scope: &Scope,
        remote: &Value,
        key: &str,
        reason: Option<&str>,
    ) -> Result<(), PeerFailure> {
        let thread = remote["threadId"].as_str().unwrap_or_default();
        let mut args = Map::new();
        args.insert("threadId".into(), json!(thread));
        args.insert("stop".into(), json!(true));
        if let Some(reason) = reason {
            args.insert("reason".into(), json!(reason));
        }
        args.insert("clientRequestId".into(), json!(format!("{key}:{thread}")));
        let environment = remote["environmentId"].as_str().unwrap_or_default();
        self.there(scope, environment, "conn_thread_interrupt", args)
            .await
            .map(|_| ())
    }

    /// `lastReply`: the last reply `run_id` gave there, read whole. A failed run prefers its
    /// error from the activity view. Returns the text and the model the run reported.
    async fn last_reply(
        &self,
        scope: &Scope,
        remote: &Value,
        run_id: Option<&str>,
        failed: bool,
    ) -> Result<(Option<String>, Value), PeerFailure> {
        let environment = remote["environmentId"].as_str().unwrap_or_default();
        let thread = remote["threadId"].as_str().unwrap_or_default();
        let of_run = |item: &Value| run_id.is_none_or(|id| item["runId"] == id);
        let (mut reply, mut error, mut run) = (None::<Value>, None::<Value>, None::<Value>);
        let mut after = None::<Value>;
        // Bounded: a thread's items, 100 a page.
        for _ in 0..1_000 {
            let mut args = Map::new();
            args.insert("threadId".into(), json!(thread));
            args.insert(
                "view".into(),
                json!(if failed { "activity" } else { "messages" }),
            );
            args.insert("limit".into(), json!(100));
            args.insert("runLimit".into(), json!(50));
            args.insert("maxCharsPerItem".into(), json!(20_000));
            if let Some(position) = &after {
                args.insert("afterPosition".into(), position.clone());
            }
            let read = self
                .there(scope, environment, "conn_thread_read", args)
                .await?;
            if run.is_none() {
                run = read["recentRuns"]
                    .as_array()
                    .and_then(|runs| {
                        runs.iter()
                            .find(|r| run_id.is_some_and(|id| r["runId"] == id))
                    })
                    .cloned();
            }
            let items = read["items"].as_array().cloned().unwrap_or_default();
            if let Some(found) = items
                .iter()
                .rev()
                .find(|i| i["type"] == "assistant_message" && of_run(i))
            {
                reply = Some(found.clone());
            }
            if failed
                && let Some(found) = items
                    .iter()
                    .rev()
                    .find(|i| i["type"] == "error" && of_run(i))
            {
                error = Some(found.clone());
            }
            if read["hasMore"] != true || read["nextPosition"].is_null() {
                break;
            }
            after = Some(read["nextPosition"].clone());
        }
        let executed = run
            .as_ref()
            .map_or(Value::Null, |r| r["executedModel"].clone());
        let Some(reply) = error.or(reply) else {
            return Ok((None, executed));
        };
        let mut out = reply["text"].as_str().unwrap_or_default().to_owned();
        let mut offset = (reply["textTruncated"] == true)
            .then(|| reply["nextTextOffset"].clone())
            .filter(|o| !o.is_null());
        // A peer that never ends a reply, or sends one past this, is cut off here.
        while let Some(text_offset) = offset {
            if out.len() >= MAX_REPLY_BYTES {
                out.push_str("\n\n(The reply was longer than this server keeps; read the thread there for the rest.)");
                break;
            }
            let previous = text_offset.as_u64();
            let mut args = Map::new();
            args.insert("threadId".into(), json!(thread));
            args.insert("itemId".into(), reply["itemId"].clone());
            args.insert("textOffset".into(), text_offset);
            args.insert("maxCharsPerItem".into(), json!(20_000));
            let rest = self
                .there(scope, environment, "conn_thread_read", args)
                .await?;
            let Some(part) = rest["items"].as_array().and_then(|i| i.first()) else {
                break;
            };
            out.push_str(part["text"].as_str().unwrap_or_default());
            offset = (part["textTruncated"] == true)
                .then(|| part["nextTextOffset"].clone())
                .filter(|o| !o.is_null())
                // An offset that does not move forward would read the same part forever.
                .filter(|o| o.as_u64().zip(previous).is_some_and(|(next, at)| next > at));
        }
        let out = match &run {
            Some(run) => with_executed_model_note(&out, &run["model"], &run["executedModel"]),
            None => out,
        };
        Ok((Some(out), executed))
    }

    /// Completes the task here (`delegated_task.remote.complete`). Each attempt is its own
    /// command; one refused because the task already has its result is done.
    #[expect(
        clippy::too_many_arguments,
        reason = "the fields of one engine command"
    )]
    async fn complete_remote(
        &self,
        parent: &str,
        task: &str,
        status: &str,
        result: &str,
        stopped_there: Option<&str>,
        stop_count: Option<u64>,
        executed_model: Option<&str>,
    ) -> StepResult<()> {
        let mut command = json!({
            "type": "delegated_task.remote.complete",
            "commandId": format!("command:remote-task-complete:{task}:{}", conn_support::uuid_v4()),
            "threadId": parent,
            "parentThreadId": parent,
            "taskId": task,
            "status": status,
            "result": result,
        });
        if let Some(stopped) = stopped_there {
            command["stoppedThere"] = json!(stopped);
        }
        if let Some(count) = stop_count {
            command["stopCount"] = json!(count);
        }
        if let Some(model) = executed_model {
            command["executedModel"] = json!(model);
        }
        match self.config.engine.remote_task(command).await {
            Ok(()) => Ok(()),
            Err(error) => match self.read_remote_task(parent, task).await? {
                Some((_, row)) if row["result"].is_string() => Ok(()),
                _ => Err(Step::Defect(error)),
            },
        }
    }

    /// Whether the task is done here: nothing is left to stop there.
    async fn remote_settled(&self, parent: &str, task: &str) -> StepResult<bool> {
        Ok(self
            .read_remote_task(parent, task)
            .await?
            .is_none_or(|(_, row)| row["remoteChild"]["stoppedThere"] == true))
    }

    /// `finalReason`: why following can never succeed, if that is what `failure` means. A
    /// link forgotten here only reads as a bad request, so it is named.
    async fn final_reason(&self, environment: &str, failure: &PeerFailure) -> Option<String> {
        if is_final(failure) {
            return Some(failure.message.clone());
        }
        if failure.code != "invalid_request" {
            return None;
        }
        match self.links()?.get(environment).await {
            Ok(None) => Some(failure.message.clone()),
            _ => None,
        }
    }

    /// `follow`: waits for the task's run there to end and completes it here; a final refusal
    /// fails the task with nothing left to stop; anything else is retried with back-off.
    async fn follow(self: &Arc<Self>, parent: &str, task: &str) {
        let mut defects = 0;
        let mut backoff = FIRST_BACKOFF;
        loop {
            let failure = match self.follow_once(parent, task).await {
                Ok(true) => return,
                Ok(false) => {
                    defects = 0;
                    backoff = FIRST_BACKOFF;
                    continue;
                }
                Err(step) => step,
            };
            match failure {
                Step::Peer(failure) => {
                    defects = 0;
                    let environment = match self.read_remote_task(parent, task).await {
                        Ok(Some((_, row))) => row["remoteChild"]["environmentId"]
                            .as_str()
                            .unwrap_or_default()
                            .to_owned(),
                        Ok(None) => return,
                        Err(_) => String::new(),
                    };
                    if let Some(reason) = self.final_reason(&environment, &failure).await {
                        let count = match self.read_remote_task(parent, task).await {
                            Ok(Some((_, row))) => row["remoteChild"]["stopCount"].as_u64(),
                            _ => None,
                        };
                        let _ = self
                            .complete_remote(
                                parent,
                                task,
                                "failed",
                                &reason,
                                Some("stopped"),
                                count,
                                None,
                            )
                            .await;
                        return;
                    }
                }
                Step::Defect(message) => {
                    defects += 1;
                    eprintln!("conn-mcp: following remote task {task} failed: {message}");
                    if defects >= MAX_DEFECTS {
                        self.give_up(parent, task).await;
                        return;
                    }
                }
            }
            tokio::time::sleep(backoff).await;
            backoff = (backoff * 2).min(MAX_BACKOFF);
        }
    }

    /// `followGaveUp`: a task with its result keeps it; one without fails, naming the thread.
    async fn give_up(&self, parent: &str, task: &str) {
        let Ok(Some((_, row))) = self.read_remote_task(parent, task).await else {
            return;
        };
        let remote = &row["remoteChild"];
        if !remote.is_object() || !row["result"].is_null() {
            return;
        }
        let result = format!(
            "Following the thread {} in {} failed repeatedly, so it may still run there (task_cancel stops it).",
            remote["threadId"].as_str().unwrap_or_default(),
            remote["label"].as_str().unwrap_or_default()
        );
        let _ = self
            .complete_remote(parent, task, "failed", &result, None, None, None)
            .await;
    }

    /// `followOnce`: one wait on the task's thread there; true once the task here is done. A
    /// task completed here first (cancelled, or its parent stopped) is stopped there.
    async fn follow_once(self: &Arc<Self>, parent: &str, task: &str) -> StepResult<bool> {
        // Subscribed before the read, so an end here after the read is seen.
        let mut stream = self.parent_stream(parent).await?;
        let Some((projection, row)) = self.read_remote_task(parent, task).await? else {
            return Ok(true);
        };
        let remote = row["remoteChild"].clone();
        if !remote.is_object() {
            return Ok(true);
        }
        let scope = self.follow_scope(parent, &projection["thread"]);
        let status = row["status"].as_str().unwrap_or_default();
        if let Some(result) = row["result"].as_str() {
            let owes = remote["stoppedThere"] == false
                || (matches!(status, "cancelled" | "interrupted")
                    && remote["stoppedThere"] != true);
            if !owes {
                return Ok(true);
            }
            let count = remote["stopCount"]
                .as_u64()
                .map_or_else(|| "stop".to_owned(), |n| format!("stop-{n}"));
            // Named for its run too: a follow-up task shares the thread there.
            let key = match remote["runId"].as_str() {
                Some(run) => format!("{count}:{run}"),
                None => count,
            };
            match self.stop_there(&scope, &remote, &key, None).await {
                Ok(()) => {}
                // Its thread there runs above what this side may touch; no retry changes that.
                Err(failure) if is_mode_refusal(&failure) => eprintln!(
                    "conn-mcp: a linked environment refused to stop delegated task {task}: {}",
                    failure.message
                ),
                Err(failure) => return Err(failure.into()),
            }
            self.complete_remote(
                parent,
                task,
                terminal_status(status),
                result,
                Some("stopped"),
                remote["stopCount"].as_u64(),
                None,
            )
            .await?;
            return self.remote_settled(parent, task).await;
        }
        let environment = remote["environmentId"].as_str().unwrap_or_default();
        let mut args = Map::new();
        args.insert("threadId".into(), remote["threadId"].clone());
        if remote["runId"].is_string() {
            args.insert("runId".into(), remote["runId"].clone());
        }
        args.insert("timeoutMs".into(), json!(FOLLOW_WAIT_MS));
        // A thread there whose run ended may still wait on its own tasks.
        args.insert("untilDelegatedWorkSettled".into(), json!(true));
        let waited = tokio::select! {
            waited = self.there(&scope, environment, "conn_thread_wait", args) => waited?,
            () = ended_here(&mut stream, task) => return Ok(false),
        };
        if waited["timedOut"] == true {
            return Ok(false);
        }
        // A task recorded without its run waits on the thread's latest; a thread there with
        // none has nothing left to wait for.
        let Some(run_id) = waited["runId"].as_str() else {
            let (reply, _) = self.last_reply(&scope, &remote, None, false).await?;
            let (status, text) = match &reply {
                Some(text) => ("completed", text.as_str()),
                None => (
                    "failed",
                    "The thread in the linked environment has no run to follow.",
                ),
            };
            self.complete_remote(parent, task, status, text, Some("ran-out"), None, None)
                .await?;
            return self.remote_settled(parent, task).await;
        };
        let status = waited["status"].as_str().unwrap_or_default();
        if !TERMINAL.contains(&status) {
            return Ok(false);
        }
        // A later run's answer there may be another open follow-up's: then this task's answer
        // is its own run's.
        let result_run = &waited["resultRun"];
        let shared = result_run.is_object()
            && result_run["runId"] != run_id
            && projection["subagents"].as_array().is_some_and(|rows| {
                let recorded = row["startedAt"].as_str();
                rows.iter().any(|other| {
                    other["id"] != task
                        && other["remoteChild"]["environmentId"] == remote["environmentId"]
                        && other["remoteChild"]["threadId"] == remote["threadId"]
                        && (recorded.is_none()
                            || other["completedAt"].is_null()
                            || other["completedAt"].as_str() > recorded)
                })
            });
        let (answer_run, answer_status) = if result_run.is_object() && !shared {
            (
                result_run["runId"].as_str().map(str::to_owned),
                result_run["status"].as_str().unwrap_or_default().to_owned(),
            )
        } else {
            (Some(run_id.to_owned()), status.to_owned())
        };
        let (reply, executed) = self
            .last_reply(
                &scope,
                &remote,
                answer_run.as_deref(),
                answer_status == "failed",
            )
            .await?;
        self.complete_remote(
            parent,
            task,
            terminal_status(&answer_status),
            reply.as_deref().unwrap_or(NO_REPLY),
            Some("ran-out"),
            None,
            executed.as_str(),
        )
        .await?;
        self.remote_settled(parent, task).await
    }

    async fn parent_stream(&self, parent: &str) -> StepResult<Option<ParentStream>> {
        let input = from_json(json!({"threadId": parent}))
            .map_err(|e| Step::Defect(format!("subscribe: {e}")))?;
        match self.config.engine.subscribe_thread(input).await {
            Ok(stream) => Ok(Some(stream)),
            Err(conn_engine::EngineError::Rejected(_)) => Ok(None),
            Err(conn_engine::EngineError::Internal(message)) => Err(Step::Defect(message)),
        }
    }
}

type ParentStream = conn_engine::Subscription<
    conn_contract::ThreadStreamItem,
    conn_contract::GetThreadProjectionError,
>;

/// Resolves when the parent's stream reports a result for `task` (`endedHere`). A stream that
/// ends never resolves: the wait there ends the step instead.
async fn ended_here(stream: &mut Option<ParentStream>, task: &str) {
    let Some(stream) = stream else {
        return std::future::pending().await;
    };
    loop {
        match stream.recv().await {
            Some(Ok(item)) => {
                let item = conn_contract::to_json(&item);
                let event = &item["event"];
                if event["type"] == "subagent.updated"
                    && event["payload"]["id"] == task
                    && !event["payload"]["result"].is_null()
                {
                    return;
                }
            }
            Some(Err(_)) => {}
            None => return std::future::pending().await,
        }
    }
}

/// The task's thread there: its environment, thread and run.
fn remote_child(row: &Value) -> Option<&Value> {
    row.get("remoteChild").filter(|r| r.is_object())
}

pub(crate) fn is_remote(row: &Value) -> bool {
    remote_child(row).is_some()
}

/// `options` as the launch takes them.
fn options_array(options: Option<&Value>) -> Option<Value> {
    match options? {
        Value::Array(items) => Some(Value::Array(items.clone())),
        Value::Object(map) => Some(Value::Array(
            map.iter()
                .map(|(id, value)| json!({"id": id, "value": value}))
                .collect(),
        )),
        _ => None,
    }
}

/// The instance there of `driver`, preferring the one this thread runs on
/// (`resolveRemoteInstance`).
async fn resolve_instance(
    cx: &Cx<'_>,
    environment: &str,
    driver: &str,
    requested: Option<&str>,
    inherited: &str,
) -> Result<String, ToolError> {
    let capabilities = cx
        .forward(
            "orchestrator_capabilities",
            Map::new(),
            environment.to_owned(),
        )
        .await?;
    let providers = capabilities["providers"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    if let Some(requested) = requested {
        if let Some(named) = providers
            .iter()
            .find(|p| p["providerInstanceId"] == requested)
            && named["driverKind"] != driver
        {
            return Err(fail(
                "invalid_request",
                format!(
                    "Provider instance {requested} there uses driver {}, not {driver}.",
                    named["driverKind"].as_str().unwrap_or_default()
                ),
            ));
        }
        return Ok(requested.to_owned());
    }
    let candidates: Vec<&Value> = providers
        .iter()
        .filter(|p| p["driverKind"] == driver && p["canRunChildTask"] == true)
        .collect();
    candidates
        .iter()
        .find(|p| p["providerInstanceId"] == inherited)
        .or(candidates.first())
        .and_then(|p| p["providerInstanceId"].as_str().map(str::to_owned))
        .ok_or_else(|| {
            fail(
                "provider_unavailable",
                format!(
                    "No instance of driver {driver} there can run a child task. orchestrator_capabilities with this environmentId lists its providers."
                ),
            )
        })
}

/// The peer's project with this thread's repository, or the one the caller named
/// (`resolveRemoteProject`).
async fn resolve_project(
    cx: &Cx<'_>,
    environment: &str,
    parent_project: &Value,
    requested: Option<&str>,
) -> Result<String, ToolError> {
    if let Some(requested) = requested {
        return Ok(requested.to_owned());
    }
    let shell = cx.shell().await.ok();
    let key = shell
        .as_ref()
        .and_then(|s| s["projects"].as_array())
        .and_then(|projects| projects.iter().find(|p| p["id"] == *parent_project))
        .and_then(|p| p["repositoryIdentity"]["canonicalKey"].as_str())
        .map(str::to_owned);
    let Some(key) = key else {
        return Err(fail(
            "target_required",
            "Pass target.projectId: this thread's project has no repository to match there.",
        ));
    };
    let mut matches: Vec<(String, String)> = vec![];
    let mut cursor = json!(0);
    // Bounded: 100 projects a page.
    for _ in 0..1_000 {
        let mut args = Map::new();
        args.insert("cursor".into(), cursor.clone());
        args.insert("limit".into(), json!(100));
        let listed = cx
            .forward("conn_project_list", args, environment.to_owned())
            .await?;
        for project in listed["projects"].as_array().into_iter().flatten() {
            if project["repositoryIdentity"]["canonicalKey"] == key.as_str() {
                matches.push((
                    project["id"].as_str().unwrap_or_default().to_owned(),
                    project["title"].as_str().unwrap_or_default().to_owned(),
                ));
            }
        }
        cursor = listed["nextCursor"].clone();
        if cursor.is_null() {
            break;
        }
    }
    match matches.as_slice() {
        [(id, _)] => Ok(id.clone()),
        [] => Err(fail(
            "invalid_request",
            format!(
                "No project there has this repository ({key}). Pass target.projectId; conn_project_list with this environmentId lists them. To bring the repository there, use conn_project_clone and then conn_project_create with this environmentId."
            ),
        )),
        many => Err(fail(
            "invalid_request",
            format!(
                "Several projects there have this repository: {}. Pass target.projectId.",
                many.iter()
                    .map(|(id, title)| format!("{title} ({id})"))
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        )),
    }
}

/// `RemoteDelegation.delegate`: launches the child there and records the task here. Returns
/// the task id.
pub(crate) async fn delegate(
    cx: &Cx<'_>,
    args: &Args,
    environment: &str,
    prompt: &str,
) -> Result<String, ToolError> {
    let caller = cx.require_thread("delegate_task")?.clone();
    let parent = match cx.projection(&caller.thread_id).await {
        Ok(parent) => parent,
        Err(_) => {
            return Err(fail(
                "thread_not_found",
                "The calling thread was not found.",
            ));
        }
    };
    let thread = &parent["thread"];
    let parent_run = crate::view::active_run(&parent)
        .filter(|run| {
            run["providerInstanceId"] == caller.provider_instance_id.as_str()
                && !run["rootNodeId"].is_null()
        })
        .cloned()
        .ok_or_else(|| {
            fail(
                "parent_not_active",
                "Delegated tasks require an active run owned by this MCP provider session.",
            )
        })?;
    let target = args.get("target").cloned().unwrap_or(Value::Null);
    // A worktree there would branch from a commit this checkout has and the other may not.
    if args.get("isolation").and_then(Value::as_str) == Some("worktree") {
        return Err(fail(
            "invalid_request",
            "A task in a linked environment runs in that project's checkout; isolation \"worktree\" is not supported there. Omit isolation, or use conn_thread_launch with environmentId and a worktree workspaceStrategy.",
        ));
    }
    // The provider and model inherit as for a task here. Another provider there has no model
    // to inherit, so the caller names one.
    let inherited = &thread["modelSelection"];
    let inherited_instance = inherited["instanceId"].as_str().unwrap_or_default();
    let instance = match target["driverKind"].as_str() {
        None => target["providerInstanceId"]
            .as_str()
            .unwrap_or(inherited_instance)
            .to_owned(),
        Some(driver) => {
            resolve_instance(
                cx,
                environment,
                driver,
                target["providerInstanceId"].as_str(),
                inherited_instance,
            )
            .await?
        }
    };
    let same_instance = instance == inherited_instance;
    let model = target["model"]
        .as_str()
        .map(str::to_owned)
        .or_else(|| {
            same_instance
                .then(|| inherited["model"].as_str().map(str::to_owned))
                .flatten()
        })
        .ok_or_else(|| {
            fail(
                "target_required",
                "Pass target.model from orchestrator_capabilities with this environmentId.",
            )
        })?;
    let options = options_array(target.get("options")).or_else(|| {
        (same_instance && inherited["model"] == model.as_str() && inherited["options"].is_array())
            .then(|| inherited["options"].clone())
    });
    // Modes asked for are checked against this thread; omitted ones are left to the other
    // side, which inherits this thread's modes capped by the link's access.
    let runtime_mode = match args.get("runtimeMode").and_then(Value::as_str) {
        None | Some("inherit") => None,
        requested => Some(crate::tools::resolve_runtime_mode(
            thread["runtimeMode"]
                .as_str()
                .unwrap_or("approval-required"),
            requested,
        )?),
    };
    let interaction_mode = match args.get("interactionMode").and_then(Value::as_str) {
        None | Some("inherit") => None,
        requested => Some(crate::tools::resolve_interaction_mode(
            thread["interactionMode"].as_str().unwrap_or("default"),
            requested,
        )?),
    };
    let project = resolve_project(
        cx,
        environment,
        &thread["projectId"],
        target["projectId"].as_str(),
    )
    .await?;
    // One key for the launch there and the record here, so a retry finds both.
    let key = args
        .get("clientRequestId")
        .and_then(Value::as_str)
        .map_or_else(conn_support::uuid_v4, str::to_owned);
    let title = args
        .get("title")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| thread["title"].as_str().unwrap_or_default().to_owned());
    let mut selection = json!({"instanceId": instance, "model": model});
    if let Some(options) = options {
        selection["options"] = options;
    }
    let mut launch = Map::new();
    launch.insert("projectId".into(), json!(project));
    launch.insert("title".into(), json!(title));
    launch.insert("modelSelection".into(), selection);
    if let Some(mode) = runtime_mode {
        launch.insert("runtimeMode".into(), json!(mode));
    }
    if let Some(mode) = interaction_mode {
        launch.insert("interactionMode".into(), json!(mode));
    }
    launch.insert("message".into(), json!(prompt));
    launch.insert(
        "clientRequestId".into(),
        json!(format!("delegate:{}:{key}", caller.thread_id)),
    );
    // The thread there shows it is this thread's subagent, with a way back.
    launch.insert(
        "delegatedFrom".into(),
        json!({
            "environmentId": cx.config().environment_id,
            "threadId": caller.thread_id,
            "title": thread["title"],
        }),
    );
    let launched = cx
        .forward("conn_thread_launch", launch, environment.to_owned())
        .await?;
    let label = match cx.config().peers.as_deref() {
        Some(peers) => peers
            .get(environment)
            .await
            .ok()
            .flatten()
            .map(|link| link.label),
        None => None,
    }
    .unwrap_or_else(|| environment.to_owned());
    let child_thread = launched["threadId"].as_str().unwrap_or_default().to_owned();
    let mut remote = json!({
        "environmentId": environment,
        "threadId": child_thread,
        "label": label,
        "title": title,
    });
    if let Some(run) = launched["runId"].as_str() {
        remote["runId"] = json!(run);
    }
    let command_id = format!(
        "command:mcp:{}:remote-delegate:{}",
        conn_support::ids::encode_component(&caller.provider_session_id),
        conn_support::ids::encode_component(&key)
    );
    let mut command = json!({
        "type": "delegated_task.remote.request",
        "commandId": command_id,
        "threadId": caller.thread_id,
        "parentThreadId": caller.thread_id,
        "parentRunId": parent_run["id"],
        "parentNodeId": parent_run["rootNodeId"],
        "task": prompt,
        // The driver runs there; this side only labels the task with it.
        "driver": "remote",
        "modelSelection": launched["modelSelection"],
        "remoteChild": remote,
        "completionWake": if args.get("mode").and_then(Value::as_str) == Some("wait") {
            "settled_only"
        } else {
            "always"
        },
    });
    if let Some(title) = args.get("title").and_then(Value::as_str) {
        command["title"] = json!(title);
    }
    let service = cx.service;
    if let Err(error) = service.config.engine.remote_task(command).await {
        // A replayed request recorded the task the first time.
        let replayed = cx.projection(&caller.thread_id).await.ok().and_then(|p| {
            p["subagents"].as_array().and_then(|rows| {
                rows.iter()
                    .find(|row| row["remoteChild"]["threadId"] == child_thread.as_str())
                    .and_then(|row| row["id"].as_str().map(str::to_owned))
            })
        });
        let Some(task) = replayed else {
            eprintln!("conn-mcp: could not record a remote task: {error}");
            // Nothing here follows a thread the task was never recorded for, so stop it there.
            let scope = service.follow_scope(&caller.thread_id, thread);
            let _ = service.stop_there(&scope, &remote, "stop", None).await;
            return Err(fail(
                "orchestration_error",
                "Unable to record the delegated task.",
            ));
        };
        service.follow_remote_task(&caller.thread_id, &task);
        return Ok(task);
    }
    let task = format!("node:delegated-task:{command_id}");
    service.follow_remote_task(&caller.thread_id, &task);
    Ok(task)
}

/// `RemoteDelegation.followUp`: a forwarded send that started or queued a run on the thread of
/// one of this thread's finished tasks there is a new task. Any other send returns as it came.
pub(crate) async fn follow_up(
    cx: &Cx<'_>,
    environment: &str,
    request: &Args,
    sent: Value,
) -> ToolResult {
    let Caller::Thread(caller) = cx.caller else {
        return Ok(sent);
    };
    if !matches!(sent["delivery"].as_str(), Some("started" | "queued")) {
        return Ok(sent);
    }
    let Ok(parent) = cx.projection(&caller.thread_id).await else {
        return Ok(sent);
    };
    let there = |row: &Value| {
        row["remoteChild"]["environmentId"] == environment
            && row["remoteChild"]["threadId"] == sent["threadId"]
    };
    let Some(finished) = parent["subagents"]
        .as_array()
        .and_then(|rows| {
            rows.iter()
                .find(|row| there(row) && !row["result"].is_null())
        })
        .cloned()
    else {
        return Ok(sent);
    };
    // Bound as a follow-up here is: a background caller's foreground run may have ended.
    let owner = follow_up_owner_run(&parent);
    let (Some(owner), false) = (owner, finished["model"].is_null()) else {
        return Ok(sent);
    };
    if owner["rootNodeId"].is_null() {
        return Ok(sent);
    }
    let command_id = format!(
        "command:remote-followup:{}:{}:{}",
        conn_support::ids::encode_component(&caller.thread_id),
        conn_support::ids::encode_component(environment),
        conn_support::ids::encode_component(sent["messageId"].as_str().unwrap_or_default())
    );
    let mut command = json!({
        "type": "delegated_task.remote.request",
        "commandId": command_id,
        "threadId": caller.thread_id,
        "parentThreadId": caller.thread_id,
        "parentRunId": owner["id"],
        "parentNodeId": owner["rootNodeId"],
        "task": request.get("message").cloned().unwrap_or(Value::Null),
        "driver": finished["driver"],
        "modelSelection": {
            "instanceId": finished["providerInstanceId"],
            "model": finished["model"],
        },
        "remoteChild": {
            "environmentId": environment,
            "threadId": sent["threadId"],
            "label": finished["remoteChild"]["label"],
            "runId": sent["runId"],
        },
        "completionWake": "always",
    });
    if finished["title"].is_string() {
        command["title"] = finished["title"].clone();
    }
    let service = cx.service;
    let recorded = service.config.engine.remote_task(command).await;
    let task = match recorded {
        Ok(()) => Some(format!("node:delegated-task:{command_id}")),
        Err(error) => {
            // A replayed request recorded the task the first time.
            let replayed = cx.projection(&caller.thread_id).await.ok().and_then(|p| {
                p["subagents"].as_array().and_then(|rows| {
                    rows.iter()
                        .find(|row| there(row) && row["remoteChild"]["runId"] == sent["runId"])
                        .and_then(|row| row["id"].as_str().map(str::to_owned))
                })
            });
            if replayed.is_none() {
                eprintln!("conn-mcp: could not record a follow-up task: {error}");
                return Err(fail(
                    "orchestration_error",
                    if request.contains_key("clientRequestId") {
                        "The message was sent, but its task was not recorded; send it again with the same clientRequestId to record it."
                    } else {
                        "The message was sent, but its task was not recorded; read the thread for its answer instead of sending it again."
                    },
                ));
            }
            replayed
        }
    };
    let Some(task) = task else {
        return Ok(sent);
    };
    service.follow_remote_task(&caller.thread_id, &task);
    let mut out = sent;
    out["taskId"] = json!(task);
    Ok(out)
}

/// `followUpOwnerRun`: the newest active run, else the newest that ran.
fn follow_up_owner_run(projection: &Value) -> Option<Value> {
    let runs = projection["runs"].as_array()?;
    let ordinal = |run: &&Value| run["ordinal"].as_u64().unwrap_or(0);
    runs.iter()
        .filter(|run| crate::view::is_live(run) && run["status"] != "queued")
        .max_by_key(ordinal)
        .or_else(|| {
            runs.iter()
                .filter(|run| {
                    run["status"] != "queued"
                        && !(run["status"] == "cancelled" && run["startedAt"].is_null())
                })
                .max_by_key(ordinal)
        })
        .cloned()
}

/// `RemoteDelegation.cancel`: stops the task's thread there, then completes it here as
/// cancelled. A task that already has its result keeps it.
pub(crate) async fn cancel(cx: &Cx<'_>, parent: &str, row: &Value, args: &Args) -> ToolResult {
    let service = cx.service;
    let remote = remote_child(row).cloned().unwrap_or(Value::Null);
    let task = row["id"].as_str().unwrap_or_default();
    let reason = args.get("reason").and_then(Value::as_str);
    let thread = match cx.projection(parent).await {
        Ok(p) => p["thread"].clone(),
        Err(_) => Value::Null,
    };
    let scope = service.follow_scope(parent, &thread);
    // A later cancel stops what started there since; a retry of this one, nothing new.
    let key = format!(
        "cancel:{}:{}",
        conn_support::ids::encode_component(&cx.caller.namespace()),
        args.get("clientRequestId")
            .and_then(Value::as_str)
            .map_or_else(conn_support::uuid_v4, str::to_owned)
    );
    let status = row["status"].as_str().unwrap_or_default();
    let count = remote["stopCount"].as_u64();
    if let Some(result) = row["result"].as_str() {
        // Best effort: the result stands whether or not the stop gets there.
        if service
            .stop_there(&scope, &remote, &key, reason)
            .await
            .is_ok()
        {
            let _ = service
                .complete_remote(
                    parent,
                    task,
                    terminal_status(status),
                    result,
                    Some("stopped"),
                    count,
                    None,
                )
                .await;
        }
        let status = match status {
            "completed" | "failed" | "interrupted" => status,
            _ => "cancelled",
        };
        return Ok(json!({"taskId": task, "status": status}));
    }
    // A link that is gone or a machine that is down still cancels the task here; its
    // follower keeps trying to stop it there, across restarts.
    let unstopped = service
        .stop_there(&scope, &remote, &key, reason)
        .await
        .err()
        .map(|failure| failure.message);
    let cancelled = reason.map_or_else(|| "Cancelled.".to_owned(), |r| format!("Cancelled: {r}"));
    let result = match &unstopped {
        None => cancelled,
        Some(why) => format!(
            "{cancelled} It could not be stopped in {} and may still run there: {why}",
            remote["label"].as_str().unwrap_or_default()
        ),
    };
    let stopped = unstopped.is_none().then_some("stopped");
    if service
        .complete_remote(parent, task, "cancelled", &result, stopped, count, None)
        .await
        .is_err()
    {
        return Err(fail(
            "orchestration_error",
            "Unable to record the cancellation.",
        ));
    }
    service.follow_remote_task(parent, task);
    Ok(json!({"taskId": task, "status": "cancel_requested"}))
}

/// `RemoteDelegation.runStatus`: the status of the task's run there, or `None` when it cannot
/// be read.
async fn run_status(cx: &Cx<'_>, parent: &Value, row: &Value) -> Option<String> {
    let remote = remote_child(row)?;
    let run = remote["runId"].as_str()?;
    let scope = cx.service.follow_scope(
        parent["thread"]["id"].as_str().unwrap_or_default(),
        &parent["thread"],
    );
    let mut args = Map::new();
    args.insert("threadId".into(), remote["threadId"].clone());
    args.insert("limit".into(), json!(1));
    args.insert("runLimit".into(), json!(50));
    let read = cx
        .service
        .there(
            &scope,
            remote["environmentId"].as_str().unwrap_or_default(),
            "conn_thread_read",
            args,
        )
        .await
        .ok()?;
    read["recentRuns"]
        .as_array()?
        .iter()
        .find(|r| r["runId"] == run)
        .and_then(|r| r["status"].as_str().map(str::to_owned))
}

/// `readRemoteTask`: a task that runs in a linked environment, answered from its row here.
pub(crate) async fn read_task(
    cx: &Cx<'_>,
    parent: &Value,
    row: &Value,
    wait_timed_out: bool,
    acknowledge: bool,
) -> ToolResult {
    let status = if row["result"].is_null() {
        if run_status(cx, parent, row).await.as_deref() == Some("starting") {
            "starting".to_owned()
        } else {
            "running".to_owned()
        }
    } else {
        match row["status"].as_str() {
            Some(s @ ("completed" | "failed" | "cancelled" | "interrupted")) => s.to_owned(),
            _ => "completed".to_owned(),
        }
    };
    let terminal = matches!(
        status.as_str(),
        "completed" | "failed" | "cancelled" | "interrupted"
    );
    let delivery = row["completionDelivery"]["state"].as_str();
    if acknowledge
        && terminal
        && !matches!(delivery, Some("acknowledged" | "disposed"))
        && let Caller::Thread(caller) = cx.caller
    {
        let observing = parent["runs"].as_array().and_then(|runs| {
            runs.iter()
                .filter(|run| {
                    crate::view::is_live(run)
                        && run["providerInstanceId"] == caller.provider_instance_id.as_str()
                })
                .max_by_key(|run| run["ordinal"].as_u64().unwrap_or(0))
                .map(|run| run["id"].clone())
        });
        let command = json!({
            "type": "delegated_task.completion-delivery.acknowledge",
            "commandId": cx.stable_id("command", "task-status-acknowledge", &conn_support::uuid_v4()),
            "parentThreadId": caller.thread_id,
            "taskId": row["id"],
            "observedByRunId": observing.unwrap_or(Value::Null),
        });
        if let Err(error) = cx.dispatch(command).await {
            let ToolError::Failure { message, .. } = &error else {
                return Err(error);
            };
            return Err(fail(
                "orchestration_error",
                format!(
                    "Unable to acknowledge delegated task {}: {message}",
                    row["id"].as_str().unwrap_or_default()
                ),
            ));
        }
    }
    let mut out = json!({
        "taskId": row["id"],
        "childThreadId": null,
        "childRunId": null,
        "childNodeId": row["id"],
        "status": status,
        "workState": if terminal { "result_available" } else { "working" },
        "hasPendingChildRuns": false,
        "providerInstanceId": row["providerInstanceId"],
        "model": row["model"],
        "executedModel": row.get("executedModel").cloned().unwrap_or(Value::Null),
        "summary": row["result"],
        "resultContextTransferId": null,
        "latestTerminalRunId": null,
        "latestTerminalStatus": if terminal { json!(status) } else { Value::Null },
        "latestTerminalSummary": if terminal { row["result"].clone() } else { Value::Null },
        "latestTerminalResultContextTransferId": null,
        // Its questions and approvals are answered in the environment it runs in.
        "hasPendingQuestion": false,
        "pendingApproval": null,
        "waitTimedOut": wait_timed_out,
    });
    if let Some(remote) = remote_child(row) {
        // The result's `remoteChild` is the contract's three fields; the row keeps more.
        out["remoteChild"] = json!({
            "environmentId": remote["environmentId"],
            "threadId": remote["threadId"],
            "label": remote["label"],
        });
        out["link"] = json!(crate::links::chip(
            remote["environmentId"].as_str().unwrap_or_default(),
            remote["threadId"].as_str().unwrap_or_default(),
            remote["title"].as_str().unwrap_or_default(),
        ));
    }
    Ok(out)
}

/// `awaitTask` for a remote task: waits until its row here has a result, at most `timeout`.
/// Returns whether the wait timed out.
pub(crate) async fn wait_for_result(
    cx: &Cx<'_>,
    parent: &str,
    task: &str,
    timeout: Duration,
) -> Result<bool, ToolError> {
    let deadline = tokio::time::Instant::now() + timeout;
    let mut stream = cx
        .service
        .parent_stream(parent)
        .await
        .map_err(|step| match step {
            Step::Defect(message) | Step::Peer(PeerFailure { message, .. }) => {
                fail("orchestration_error", message)
            }
        })?;
    let done = |projection: &Value| {
        projection["subagents"]
            .as_array()
            .and_then(|rows| rows.iter().find(|row| row["id"] == task))
            .is_none_or(|row| !row["result"].is_null())
    };
    if done(&cx.projection(parent).await?) {
        return Ok(false);
    }
    match tokio::time::timeout_at(deadline, ended_here(&mut stream, task)).await {
        Ok(()) => Ok(false),
        Err(_) => Ok(true),
    }
}
