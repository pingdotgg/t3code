//! `ThreadManagementService.awaitBackgroundTasks` (`apps/server/src/orchestration-v2/`):
//! marks background tasks the thread's agent waits on, so the thread stays Working while they
//! run. `/mcp`'s `conn_background_wait` calls it for its calling thread.
//!
//! The engine finds the thread's active provider thread and the live session that owns it,
//! asks that session ([`conn_provider::Session::await_background_tasks`]) with a 15 second
//! limit, and splits the ids into matched and unmatched. The provider marks the tasks on its
//! roster and reports the roster (`provider_thread.updated`); the engine stores nothing here.

use std::time::Duration;

use conn_contract::{ProviderThread, from_json};
use conn_provider::{AwaitBackgroundTasksInput, ProviderError};
use serde_json::Value;

use crate::engine::Inner;

/// `Effect.timeout("15 seconds")` on the provider's answer.
const PROVIDER_TIMEOUT: Duration = Duration::from_secs(15);

/// What [`crate::Engine::await_background_tasks`] answers: the ids the provider found running
/// on the thread, and the others in the order given.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BackgroundWait {
    pub matched: Vec<String>,
    pub unmatched: Vec<String>,
}

/// `ThreadManagementBackgroundWaitError`, by its `reason`. `Display` is T3's message.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BackgroundWaitError {
    /// The live session's provider has no background roster (Codex, ACP).
    Unsupported,
    /// The thread is gone, has no active provider thread, or no live session owns it.
    Unavailable,
    /// The provider failed or did not answer in 15 seconds.
    Failed,
    /// Marking (`awaited`) matched no task running on the thread.
    Unmatched,
}

impl std::fmt::Display for BackgroundWaitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Unsupported => "This provider cannot mark background work as awaited.",
            Self::Unavailable => "This thread has no live provider session.",
            Self::Failed => "Failed to update the awaited background work.",
            Self::Unmatched => {
                "None of these IDs is running background work on this thread, so this request registers no wait for them. If the task already finished, read its output now. Otherwise pass the task ID of a background command or Monitor you started. Subagent, Agent tool, and delegate_task IDs don't go here."
            }
        })
    }
}

impl std::error::Error for BackgroundWaitError {}

impl BackgroundWaitError {
    /// T3's `reason` literal.
    pub fn reason(self) -> &'static str {
        match self {
            Self::Unsupported => "unsupported",
            Self::Unavailable => "unavailable",
            Self::Failed => "failed",
            Self::Unmatched => "unmatched",
        }
    }
}

/// `unmatched`: every id the provider did not match, duplicates and order kept, as T3's
/// `input.taskIds.filter((taskId) => !matchedIds.has(taskId))`.
pub(crate) fn split(task_ids: Vec<String>, matched: Vec<String>) -> BackgroundWait {
    let unmatched = task_ids
        .into_iter()
        .filter(|id| !matched.contains(id))
        .collect();
    BackgroundWait { matched, unmatched }
}

/// The thread's active provider thread (`activeProviderThreadId`, owned by this app thread),
/// if the thread exists and the row names its provider session.
fn active_provider_thread(thread: Option<Value>, provider_threads: Vec<Value>) -> Option<Value> {
    let thread = thread.filter(|t| t["deletedAt"].is_null())?;
    let active = thread["activeProviderThreadId"].as_str()?;
    let app_thread_id = thread["id"].as_str()?;
    provider_threads.into_iter().find(|pt| {
        pt["id"] == active
            && pt["appThreadId"] == app_thread_id
            && pt["providerSessionId"].is_string()
    })
}

impl Inner {
    pub(crate) async fn await_background_tasks(
        &self,
        thread_id: String,
        task_ids: Vec<String>,
        awaited: bool,
    ) -> Result<BackgroundWait, BackgroundWaitError> {
        let tid = thread_id.clone();
        let row = self
            .db(move |store| -> Result<Option<Value>, String> {
                let tx = store.tx()?;
                let thread = tx.thread(&tid)?;
                let provider_threads = tx.entities(&tid, "providerThreads")?;
                tx.rollback();
                Ok(active_provider_thread(thread, provider_threads))
            })
            .await
            .map_err(|e| {
                eprintln!("conn-engine: background wait could not read the thread: {e}");
                BackgroundWaitError::Unavailable
            })?
            .ok_or(BackgroundWaitError::Unavailable)?;
        let session_id = row["providerSessionId"].as_str().unwrap_or_default();
        let live = self
            .live_thread(&thread_id)
            .filter(|live| live.session().provider_session_id().as_str() == session_id)
            .ok_or(BackgroundWaitError::Unavailable)?;
        let provider_thread: ProviderThread = from_json(row).map_err(|e| {
            eprintln!("conn-engine: a stored provider thread does not decode: {e}");
            BackgroundWaitError::Unavailable
        })?;
        let request = live
            .session()
            .await_background_tasks(AwaitBackgroundTasksInput {
                provider_thread,
                task_ids: task_ids.clone(),
                awaited,
            });
        let matched = match tokio::time::timeout(PROVIDER_TIMEOUT, request).await {
            Ok(Ok(matched)) => matched,
            Ok(Err(ProviderError::Unsupported { .. })) => {
                return Err(BackgroundWaitError::Unsupported);
            }
            Ok(Err(e)) => {
                eprintln!("conn-engine: the provider did not mark background work: {e}");
                return Err(BackgroundWaitError::Failed);
            }
            Err(_) => {
                eprintln!("conn-engine: the provider did not mark background work in 15 s");
                return Err(BackgroundWaitError::Failed);
            }
        };
        if awaited && matched.is_empty() {
            return Err(BackgroundWaitError::Unmatched);
        }
        Ok(split(task_ids, matched))
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::fake::FakeProvider;
    use crate::{Engine, EngineConfig, ProjectConfig, SqliteEngine};
    use serde_json::json;

    const ROOT: &str = "/tmp/conn-engine-background-wait";

    struct TempDir(std::path::PathBuf);

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn open(name: &str, provider: FakeProvider) -> (SqliteEngine, Arc<FakeProvider>, TempDir) {
        let dir = std::env::temp_dir().join(format!("conn-engine-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let provider = Arc::new(provider);
        let mut config = EngineConfig::new(dir.join("engine.sqlite"));
        config.projects = vec![ProjectConfig {
            title: "Project".into(),
            workspace_root: ROOT.into(),
        }];
        config.providers = vec![provider.clone()];
        (SqliteEngine::open(config).unwrap(), provider, TempDir(dir))
    }

    async fn dispatch(engine: &SqliteEngine, command: Value) {
        engine
            .dispatch(conn_contract::from_json(command).unwrap())
            .await
            .unwrap();
    }

    /// Creates `t1` and runs `text` to its end.
    async fn run(engine: &SqliteEngine, text: &str) {
        dispatch(
            engine,
            json!({
                "type": "thread.create", "commandId": "c1", "threadId": "t1",
                "projectId": SqliteEngine::project_id_for(ROOT), "title": "New thread",
                "modelSelection": {"instanceId": "claudeAgent", "model": "claude-haiku-4-5"},
                "runtimeMode": "full-access", "interactionMode": "default",
                "branch": null, "worktreePath": null, "createdBy": "user", "creationSource": "web",
            }),
        )
        .await;
        dispatch(engine, json!({
            "type": "message.dispatch", "commandId": "c2", "threadId": "t1",
            "messageId": "message:c2", "text": text, "attachments": [],
            "dispatchMode": {"type": "start_immediately"}, "createdBy": "user", "creationSource": "web",
        }))
        .await;
        for _ in 0..200 {
            let projection = engine.get_thread_projection("t1".into()).await.unwrap();
            if projection["runs"][0]["status"] == "completed" {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("the run did not complete");
    }

    async fn shell_tasks(engine: &SqliteEngine) -> Value {
        engine
            .inner()
            .db(|store| {
                let tx = store.tx()?;
                let row = crate::shell::thread_shell(&tx, "t1");
                tx.rollback();
                row
            })
            .await
            .unwrap()["pendingBackgroundTasks"]
            .clone()
    }

    /// Polls the shell row until its roster equals `want`.
    async fn until_tasks(engine: &SqliteEngine, want: &Value) {
        for _ in 0..200 {
            if &shell_tasks(engine).await == want {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("roster is {}, want {want}", shell_tasks(engine).await);
    }

    fn ids(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_owned()).collect()
    }

    /// T3's `awaitBackgroundTasks` with Claude's roster: marking shows `awaited` on the
    /// thread's roster, clearing removes it, and a mark that matches nothing is refused.
    #[tokio::test(flavor = "current_thread")]
    async fn marks_and_clears_awaited_tasks_on_the_live_session() {
        let (engine, provider, _dir) = open("bg-wait", FakeProvider::new("claudeAgent"));
        // The shell row's `derivePendingBackgroundWork` keeps `awaited`, and the task keeps the
        // run it first appeared under (`attributePendingBackgroundTasks`).
        let task = |awaited: bool| {
            let mut task = json!({"taskId": "bg-1", "kind": "command", "description": "sleep 600",
                                  "runId": "run:t1:1"});
            if awaited {
                task["awaited"] = json!(true);
            }
            json!([task])
        };
        // No thread, then a thread with no session yet: no live provider session.
        assert_eq!(
            engine
                .await_background_tasks("t1".into(), ids(&["bg-1"]), true)
                .await,
            Err(BackgroundWaitError::Unavailable)
        );
        run(&engine, "background-task").await;
        until_tasks(&engine, &task(false)).await;
        // The attribution is the projection's: the provider's roster event stays as the
        // provider sent it (`claude_background_task_wake/output.ts:74`).
        let events = engine.stored_events(0, 1000).await.unwrap();
        let roster_task = events
            .iter()
            .filter(|e| e["event"]["type"] == "provider-thread.updated")
            .flat_map(|e| {
                e["event"]["payload"]["pendingBackgroundTasks"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default()
            })
            .find(|task| task["taskId"] == "bg-1");
        assert_eq!(
            roster_task,
            Some(json!({"taskId": "bg-1", "kind": "command", "description": "sleep 600"}))
        );

        let marked = engine
            .await_background_tasks("t1".into(), ids(&["bg-1", "x", "bg-1"]), true)
            .await
            .unwrap();
        assert_eq!(marked.matched, ["bg-1"]);
        assert_eq!(marked.unmatched, ["x"]);
        until_tasks(&engine, &task(true)).await;

        // Marking only unknown ids registers nothing; clearing them is no error.
        assert_eq!(
            engine
                .await_background_tasks("t1".into(), ids(&["x"]), true)
                .await,
            Err(BackgroundWaitError::Unmatched)
        );
        let cleared = engine
            .await_background_tasks("t1".into(), ids(&["x"]), false)
            .await
            .unwrap();
        assert_eq!(
            cleared,
            BackgroundWait {
                matched: vec![],
                unmatched: ids(&["x"])
            }
        );
        let cleared = engine
            .await_background_tasks("t1".into(), ids(&["bg-1"]), false)
            .await
            .unwrap();
        assert_eq!(cleared.matched, ["bg-1"]);
        until_tasks(&engine, &task(false)).await;
        let calls = crate::lock(&provider.calls).clone();
        assert!(
            calls.contains(&"await bg-1,x,bg-1 true".to_owned()),
            "{calls:?}"
        );

        // Once the session is gone, there is nothing to mark on.
        engine.shutdown().await;
        assert_eq!(
            engine
                .await_background_tasks("t1".into(), ids(&["bg-1"]), true)
                .await,
            Err(BackgroundWaitError::Unavailable)
        );
    }

    /// A provider without `awaitBackgroundTasks` (Codex, ACP) is `unsupported`, as T3.
    #[tokio::test(flavor = "current_thread")]
    async fn a_provider_without_a_roster_is_unsupported() {
        let provider = FakeProvider::new("claudeAgent").without_background_wait();
        let (engine, _provider, _dir) = open("bg-wait-unsupported", provider);
        run(&engine, "background-task").await;
        let refused = engine
            .await_background_tasks("t1".into(), ids(&["bg-1"]), true)
            .await;
        assert_eq!(refused, Err(BackgroundWaitError::Unsupported));
        assert_eq!(
            BackgroundWaitError::Unsupported.to_string(),
            "This provider cannot mark background work as awaited."
        );
    }

    #[test]
    fn unmatched_keeps_order_and_duplicates() {
        let wait = split(
            vec!["b".into(), "a".into(), "x".into(), "x".into()],
            vec!["a".into(), "b".into()],
        );
        assert_eq!(wait.matched, ["a", "b"]);
        assert_eq!(wait.unmatched, ["x", "x"]);
    }

    #[test]
    fn only_the_active_provider_thread_of_this_app_thread_counts() {
        let thread = json!({"id": "t1", "deletedAt": null, "activeProviderThreadId": "pt1"});
        let row = |id: &str, app: &str, session: Value| json!({"id": id, "appThreadId": app, "providerSessionId": session});
        let found = active_provider_thread(
            Some(thread.clone()),
            vec![row("pt0", "t1", json!("s")), row("pt1", "t1", json!("s"))],
        );
        assert_eq!(found.map(|r| r["id"].clone()), Some(json!("pt1")));
        // Another app thread's row, a row without a session, a deleted thread: none.
        assert!(
            active_provider_thread(Some(thread.clone()), vec![row("pt1", "t2", json!("s"))])
                .is_none()
        );
        assert!(
            active_provider_thread(Some(thread.clone()), vec![row("pt1", "t1", Value::Null)])
                .is_none()
        );
        let mut deleted = thread;
        deleted["deletedAt"] = json!("2026-01-01T00:00:00.000Z");
        assert!(
            active_provider_thread(Some(deleted), vec![row("pt1", "t1", json!("s"))]).is_none()
        );
        assert!(active_provider_thread(None, vec![]).is_none());
    }
}
