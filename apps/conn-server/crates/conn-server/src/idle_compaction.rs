//! Compaction before Claude's prompt cache expires (`IdleCompactionService.ts`): when a run
//! completes on a Claude instance set to `beforeCacheExpires`, a timer waits until shortly
//! before the cache of the run's last request expires and sends `/compact` as a server turn.
//! At the deadline every condition is checked again; a newer completed run takes the timer
//! over. Timers live in memory, as T3's, so a restart skips the ones still waiting.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use conn_engine::{Engine, SqliteEngine};
use serde_json::{Map, Value, json};

use crate::environment::Environment;
use crate::settings::generated::{COMPACTION_MIN_TOKENS, IDLE_COMPACTION_TEXT};

/// `LEAD_MS` (`IdleCompaction.ts`, not exported): how long before the cache expires the
/// compaction starts, so the session resumes and compacts while the cache is still warm.
const LEAD_MS: i64 = 2 * 60_000;

fn ms(value: &Value) -> Option<i64> {
    value.as_str().and_then(conn_support::time::millis_from_iso)
}

/// `resolveIdleCompaction`: the instance's own `idleCompaction` unless it is `default`, else
/// the environment's mode.
pub fn mode(settings: &Map<String, Value>, instance: &str) -> String {
    let own = settings
        .get("providerInstances")
        .and_then(|instances| instances.get(instance))
        .and_then(|entry| entry["config"]["idleCompaction"].as_str())
        .filter(|mode| matches!(*mode, "off" | "onReturn" | "beforeCacheExpires"));
    own.map_or_else(
        || crate::settings::global_idle_compaction(settings),
        str::to_owned,
    )
}

/// Whether `instance` runs Claude: its configured driver, else the default instance's id.
fn is_claude(settings: &Map<String, Value>, instance: &str) -> bool {
    match settings
        .get("providerInstances")
        .and_then(|instances| instances.get(instance))
    {
        Some(entry) => entry["driver"] == "claudeAgent",
        None => instance == "claudeAgent",
    }
}

/// Whether a thread on `instance` in `project` compacts before its cache expires: a Claude
/// instance, in `beforeCacheExpires` mode, enabled for the project.
pub fn eligible(settings: &Map<String, Value>, instance: &str, project: Option<&str>) -> bool {
    is_claude(settings, instance)
        && mode(settings, instance) == "beforeCacheExpires"
        && crate::settings::provider_instance_enabled(settings, project, instance)
}

/// When an idle thread compacts: from `start_ms` until its cache expires at `end_ms`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Window {
    pub run_id: String,
    pub start_ms: i64,
    pub end_ms: i64,
}

/// `isCompactionCommandMessage`: a `/compact` prompt without attachments.
fn is_compaction(message: &Value) -> bool {
    message["text"]
        .as_str()
        .is_some_and(|text| text.trim().eq_ignore_ascii_case(IDLE_COMPACTION_TEXT))
        && message["attachments"].as_array().is_none_or(Vec::is_empty)
}

/// The thread's latest run that ran: a cancelled run that never started is passed over.
fn latest_run(projection: &Value) -> Option<&Value> {
    projection["runs"]
        .as_array()?
        .iter()
        .filter(|run| !(run["status"] == "cancelled" && run["startedAt"].is_null()))
        .max_by_key(|run| run["ordinal"].as_u64().unwrap_or(0))
}

/// `idleCompactionWindow` (`IdleCompaction.ts:33`): `None` when the thread should not compact.
/// `pending_background` is the shell's `pendingBackgroundTasks` (`derivePendingBackgroundWork`).
pub fn window(projection: &Value, pending_background: &[Value], now: i64) -> Option<Window> {
    let thread = &projection["thread"];
    if !thread["deletedAt"].is_null() || !thread["archivedAt"].is_null() {
        return None;
    }
    if !thread["settledAt"].is_null() || thread["settledOverride"] == "settled" {
        return None;
    }
    if ms(&thread["snoozedUntil"]).is_some_and(|until| until > now) {
        return None;
    }
    // `isListedThreadLineage`: delegates and side chats live inside their parent.
    let lineage = &thread["lineage"];
    if lineage["relationshipToParent"] == "subagent" || lineage["sideChat"] == true {
        return None;
    }
    let run = latest_run(projection)?;
    if run["status"] != "completed" || run["completedAt"].is_null() {
        return None;
    }
    let message = projection["messages"]
        .as_array()?
        .iter()
        .find(|message| message["id"] == run["userMessageId"])?;
    // Never compact a compaction, so one idle spell compacts at most once.
    if is_compaction(message) {
        return None;
    }
    let pending = |kind: &str, keep: &dyn Fn(&Value) -> bool| {
        projection[kind].as_array().is_some_and(|rows| {
            rows.iter()
                .any(|row| row["status"] == "pending" && keep(row))
        })
    };
    if pending("runtimeRequests", &|_| true)
        // A pending merge-back belongs to the user's next message.
        || pending("contextTransfers", &|transfer| {
            transfer["type"] == "merge_back" && transfer["targetThreadId"] == thread["id"]
        })
        // Background work reports into the next turn; compaction would swallow it.
        || !pending_background.is_empty()
    {
        return None;
    }
    let provider_thread = projection["providerThreads"]
        .as_array()?
        .iter()
        .find(|candidate| candidate["id"] == thread["activeProviderThreadId"])?;
    // The thread's current selection receives the `/compact`: it must still be this session.
    if provider_thread["driver"] != "claudeAgent"
        || provider_thread["id"] != run["providerThreadId"]
        || provider_thread["providerInstanceId"] != thread["providerInstanceId"]
        || run["providerInstanceId"] != thread["providerInstanceId"]
    {
        return None;
    }
    let usage = projection["providerTurns"]
        .as_array()?
        .iter()
        .filter(|turn| {
            turn["providerThreadId"] == provider_thread["id"] && turn["tokenUsage"].is_object()
        })
        .map(|turn| &turn["tokenUsage"])
        .max_by_key(|usage| ms(&usage["updatedAt"]).unwrap_or(i64::MIN))?;
    if usage["usedTokens"].as_u64().unwrap_or(0) < COMPACTION_MIN_TOKENS {
        return None;
    }
    // A request served fully from cache reports no expiry; it is unknown, so it is skipped.
    let end_ms = ms(&usage["promptCacheExpiresAt"]).filter(|end| now < *end)?;
    Some(Window {
        run_id: run["id"].as_str()?.to_owned(),
        start_ms: end_ms - LEAD_MS,
        end_ms,
    })
}

/// The timers, one per thread: a newer completed run replaces the waiting one (`FiberMap`).
/// Archiving or deleting the thread cancels its timer; after [`IdleCompaction::shutdown`] no
/// timer starts.
pub struct IdleCompaction {
    engine: Arc<SqliteEngine>,
    environment: Arc<Environment>,
    timers: Mutex<Timers>,
}

#[derive(Default)]
struct Timers {
    waiting: HashMap<String, (u64, tokio::task::JoinHandle<()>)>,
    next: u64,
    closed: bool,
}

impl std::fmt::Debug for IdleCompaction {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("IdleCompaction").finish_non_exhaustive()
    }
}

impl IdleCompaction {
    pub fn new(engine: Arc<SqliteEngine>, environment: Arc<Environment>) -> Arc<Self> {
        Arc::new(Self {
            engine,
            environment,
            timers: Mutex::default(),
        })
    }

    fn timers(&self) -> std::sync::MutexGuard<'_, Timers> {
        self.timers
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// A run completed: its thread's timer starts over from it.
    pub fn run_completed(self: &Arc<Self>, thread_id: &str, run_id: &str) {
        let (service, thread, run) = (self.clone(), thread_id.to_owned(), run_id.to_owned());
        // The task removes its own entry under this lock, so it is registered before it can.
        let mut timers = self.timers();
        if timers.closed {
            return;
        }
        let id = timers.next;
        timers.next += 1;
        let task = tokio::spawn(async move {
            service.compact_when_due(&thread, run).await;
            let mut timers = service.timers();
            if timers
                .waiting
                .get(&thread)
                .is_some_and(|(own, _)| *own == id)
            {
                timers.waiting.remove(&thread);
            }
        });
        if let Some((_, previous)) = timers.waiting.insert(thread_id.to_owned(), (id, task)) {
            previous.abort();
        }
    }

    /// The thread was archived or deleted: its waiting timer ends.
    pub fn cancel(&self, thread_id: &str) {
        if let Some((_, task)) = self.timers().waiting.remove(thread_id) {
            task.abort();
        }
    }

    /// Ends every waiting timer and starts no new one; returns once they have stopped.
    pub async fn shutdown(&self) {
        let tasks: Vec<_> = {
            let mut timers = self.timers();
            timers.closed = true;
            timers.waiting.drain().map(|(_, (_, task))| task).collect()
        };
        for task in tasks {
            task.abort();
            let _ = task.await;
        }
    }

    /// Whether `thread_id` has a timer waiting.
    pub fn waiting(&self, thread_id: &str) -> bool {
        self.timers().waiting.contains_key(thread_id)
    }

    /// `compactWhenDue`: loops after each wait, as the thread may have moved on. The thread's
    /// own record decides eligibility first; only then are the few records the window reads.
    async fn compact_when_due(&self, thread_id: &str, mut run_id: String) {
        loop {
            let settings = self.environment.settings.raw();
            let eligible_now = |thread: &Value| {
                eligible(
                    &settings,
                    thread["providerInstanceId"].as_str().unwrap_or_default(),
                    thread["projectId"].as_str(),
                )
            };
            match self.engine.thread_record(thread_id.to_owned()).await {
                Ok(Some(thread)) if eligible_now(&thread) => {}
                _ => return,
            }
            let Ok(Some(records)) = self
                .engine
                .idle_compaction_records(thread_id.to_owned())
                .await
            else {
                return;
            };
            if !eligible_now(&records["thread"]) {
                return;
            }
            // A late end of an earlier run replaced the latest run's timer: it takes over.
            if let Some(latest) = latest_run(&records)
                && latest["status"] == "completed"
                && latest["id"] != run_id.as_str()
            {
                run_id = latest["id"].as_str().unwrap_or_default().to_owned();
                continue;
            }
            // The shell adds the thread's pull request watches; T3's window passes no links
            // to `derivePendingBackgroundWork` (`IdleCompaction.ts:75`), so they do not count.
            let pending: Vec<Value> = match self.engine.thread_shell(thread_id.to_owned()).await {
                Ok(Some(shell)) => shell["pendingBackgroundTasks"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|task| {
                        !task["taskId"].as_str().is_some_and(|id| {
                            id.starts_with(crate::settlement::PULL_REQUEST_WATCH_TASK_ID)
                        })
                    })
                    .cloned()
                    .collect(),
                _ => return,
            };
            let now = i64::try_from(self.engine.now_millis()).unwrap_or(i64::MAX);
            let Some(window) = window(&records, &pending, now) else {
                return;
            };
            if window.run_id != run_id {
                return;
            }
            if now < window.start_ms {
                let wait = u64::try_from(window.start_ms - now).unwrap_or(0);
                tokio::time::sleep(Duration::from_millis(wait)).await;
                continue;
            }
            let command = json!({
                "type": "message.dispatch",
                // One compaction per completed run, even across duplicate events.
                "commandId": format!("server:idle-compact:{thread_id}:{run_id}"),
                "messageId": format!("idle-compact:{thread_id}:{run_id}"),
                "threadId": thread_id,
                "text": IDLE_COMPACTION_TEXT,
                "attachments": [],
                "createdBy": "agent",
                "creationSource": "server",
                "idleCompaction": "beforeCacheExpires",
                "dispatchMode": {"type": "start_immediately"},
            });
            match conn_contract::from_json(command) {
                Ok(command) => {
                    if let Err(conn_engine::EngineError::Internal(error)) =
                        self.engine.dispatch(command).await
                    {
                        eprintln!("idle compaction skipped for {thread_id}: {error}");
                    }
                }
                Err(error) => eprintln!("idle compaction skipped for {thread_id}: {error}"),
            }
            return;
        }
    }
}

#[cfg(test)]
mod tests;
