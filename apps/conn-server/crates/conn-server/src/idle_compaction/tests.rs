//! Cases from `IdleCompaction.test.ts` (each names the T3 case it ports), then the service on a
//! real engine and fake Claude, on a clock the test moves.

use std::sync::Arc;
use std::time::Duration;

use conn_engine::{Engine, ManualClock, SqliteEngine};
use serde_json::{Value, json};

use super::*;

const NOW_MS: i64 = 1_792_411_200_000; // 2026-10-19T12:00:00.000Z
const MINUTE_MS: i64 = 60_000;

fn at(offset: i64) -> Value {
    json!(conn_support::time::iso_from_millis(NOW_MS + offset))
}

/// `records`: an idle Claude thread whose one run completed now.
fn records(used_tokens: u64, cache_expires_in: Option<i64>) -> Value {
    let mut usage = json!({"usedTokens": used_tokens, "updatedAt": at(0)});
    if let Some(expires) = cache_expires_in {
        usage["promptCacheExpiresAt"] = at(expires);
    }
    json!({
        "thread": {
            "id": "idle-thread", "projectId": "project", "providerInstanceId": "claudeAgent",
            "activeProviderThreadId": "provider-thread",
            "lineage": {"rootThreadId": "idle-thread", "parentThreadId": null, "relationshipToParent": null},
            "archivedAt": null, "settledOverride": null, "settledAt": null, "deletedAt": null,
        },
        "runs": [{
            "id": "run-1", "ordinal": 1, "providerInstanceId": "claudeAgent",
            "providerThreadId": "provider-thread", "userMessageId": "message-1",
            "status": "completed", "startedAt": at(-MINUTE_MS), "completedAt": at(0),
        }],
        "messages": [{"id": "message-1", "runId": "run-1", "role": "user",
                      "text": "Explain this code", "attachments": []}],
        "providerThreads": [{"id": "provider-thread", "driver": "claudeAgent",
                             "providerInstanceId": "claudeAgent", "pendingBackgroundTasks": []}],
        "providerTurns": [{"id": "provider-turn-1", "providerThreadId": "provider-thread",
                           "status": "completed", "tokenUsage": usage}],
        "runtimeRequests": [],
        "contextTransfers": [],
    })
}

/// `skips small contexts, unknown expiry, other providers, switched threads, compactions, and
/// side chats`.
#[test]
fn skips_what_t3_skips() {
    let hour = Some(60 * MINUTE_MS);
    assert!(
        window(&records(199_999, hour), &[], NOW_MS).is_none(),
        "small"
    );
    assert!(
        window(&records(250_000, None), &[], NOW_MS).is_none(),
        "unknown expiry"
    );
    let eligible = window(&records(250_000, hour), &[], NOW_MS).expect("eligible");
    assert_eq!(eligible.run_id, "run-1");
    assert_eq!(eligible.end_ms - eligible.start_ms, LEAD_MS);

    let mut codex = records(250_000, hour);
    codex["providerThreads"][0]["driver"] = json!("codex");
    assert!(window(&codex, &[], NOW_MS).is_none(), "other provider");
    let mut switched = records(250_000, hour);
    switched["thread"]["providerInstanceId"] = json!("codex");
    assert!(window(&switched, &[], NOW_MS).is_none(), "switched thread");
    let mut compacted = records(250_000, hour);
    compacted["messages"][0]["text"] = json!("/compact");
    assert!(window(&compacted, &[], NOW_MS).is_none(), "a compaction");

    // A queued message that was steered leaves a cancelled run that never started.
    let mut steered = records(250_000, hour);
    let mut cancelled = steered["runs"][0].clone();
    cancelled["id"] = json!("run-2");
    cancelled["ordinal"] = json!(2);
    cancelled["status"] = json!("cancelled");
    cancelled["startedAt"] = Value::Null;
    steered["runs"].as_array_mut().unwrap().push(cancelled);
    assert_eq!(window(&steered, &[], NOW_MS).unwrap().run_id, "run-1");
    // A turn Claude itself reported as cancelled did run, so it stays the latest.
    steered["runs"][1]["startedAt"] = at(-MINUTE_MS);
    assert!(window(&steered, &[], NOW_MS).is_none());

    let mut archived = records(250_000, hour);
    archived["thread"]["archivedAt"] = at(0);
    assert!(window(&archived, &[], NOW_MS).is_none(), "archived");
    let mut side_chat = records(250_000, hour);
    side_chat["thread"]["lineage"]["relationshipToParent"] = json!("fork");
    side_chat["thread"]["lineage"]["sideChat"] = json!(true);
    assert!(window(&side_chat, &[], NOW_MS).is_none(), "side chat");
    let background = [json!({"taskId": "dev", "kind": "command"})];
    assert!(
        window(&records(250_000, hour), &background, NOW_MS).is_none(),
        "background work"
    );
}

/// `loads history only for eligible idle compaction`: the mode, the instance override, the
/// project's and the instance's enablement, and the driver decide.
#[test]
fn eligibility_follows_mode_override_driver_and_enablement() {
    let settings = |mode: &str, entry: Option<Value>, project_disabled: Option<&str>| {
        let mut settings = json!({"idleCompaction": mode, "providerInstances": {}});
        if let Some((instance, entry)) = entry
            .as_ref()
            .and_then(|e| Some((e["id"].as_str()?.to_owned(), e["entry"].clone())))
        {
            settings["providerInstances"][instance] = entry;
        }
        if let Some(instance) = project_disabled {
            settings["projectSettingsOverrides"] =
                json!({"project": {"providerInstances": {instance: {"enabled": false}}}});
        }
        settings.as_object().unwrap().clone()
    };
    let instance = |id: &str, driver: &str, enabled: bool, idle: &str| {
        Some(
            json!({"id": id, "entry": {"driver": driver, "enabled": enabled,
                                        "config": {"idleCompaction": idle}}}),
        )
    };
    let project = Some("project");
    let cases = [
        (
            settings(
                "onReturn",
                instance("claudeAgent", "claudeAgent", true, "default"),
                None,
            ),
            "claudeAgent",
            false,
        ),
        (
            settings(
                "off",
                instance("claudeAgent", "claudeAgent", true, "default"),
                None,
            ),
            "claudeAgent",
            false,
        ),
        (
            settings(
                "beforeCacheExpires",
                instance("claudeAgent", "claudeAgent", true, "default"),
                None,
            ),
            "claudeAgent",
            true,
        ),
        (
            settings(
                "beforeCacheExpires",
                instance("claudeAgent", "claudeAgent", true, "off"),
                None,
            ),
            "claudeAgent",
            false,
        ),
        (
            settings(
                "onReturn",
                instance("claudeAgent", "claudeAgent", true, "beforeCacheExpires"),
                None,
            ),
            "claudeAgent",
            true,
        ),
        (
            settings(
                "beforeCacheExpires",
                instance("claudeAgent", "claudeAgent", true, "default"),
                Some("claudeAgent"),
            ),
            "claudeAgent",
            false,
        ),
        (
            settings(
                "beforeCacheExpires",
                instance("claudeAgent", "claudeAgent", false, "default"),
                None,
            ),
            "claudeAgent",
            false,
        ),
        (
            settings(
                "beforeCacheExpires",
                instance("codex", "codex", true, "default"),
                None,
            ),
            "codex",
            false,
        ),
        (
            settings(
                "beforeCacheExpires",
                instance("custom-codex", "codex", true, "default"),
                None,
            ),
            "custom-codex",
            false,
        ),
        (
            settings(
                "beforeCacheExpires",
                instance("custom-claude", "claudeAgent", true, "default"),
                None,
            ),
            "custom-claude",
            true,
        ),
        (
            settings("beforeCacheExpires", None, None),
            "claudeAgent",
            true,
        ),
    ];
    for (index, (settings, instance, want)) in cases.iter().enumerate() {
        assert_eq!(eligible(settings, instance, project), *want, "case {index}");
    }
}

// ---- The service on a real engine, fake Claude and controlled time ----

const T0: u64 = 1_800_000_000_000;

struct Harness {
    engine: Arc<SqliteEngine>,
    clock: Arc<ManualClock>,
    environment: Arc<Environment>,
    project: String,
    dir: std::path::PathBuf,
}

impl Drop for Harness {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn harness(name: &str) -> Harness {
    let dir = std::env::temp_dir().join(format!("conn-idle-{name}-{}", conn_support::uuid_v4()));
    std::fs::create_dir_all(dir.join("project")).unwrap();
    let root = dir.join("project").to_string_lossy().into_owned();
    let clock = Arc::new(ManualClock::at(T0));
    let mut config = conn_engine::EngineConfig::new(dir.join("engine.sqlite"));
    config.projects = vec![conn_engine::ProjectConfig {
        title: "Project".into(),
        workspace_root: root.clone(),
    }];
    config.providers = vec![Arc::new(conn_engine::fake::FakeProvider::new(
        "claudeAgent",
    ))];
    config.clock = clock.clone();
    let engine = Arc::new(SqliteEngine::open(config).unwrap());
    let environment =
        Arc::new(Environment::load(&dir, None, dir.clone(), Default::default()).unwrap());
    environment
        .settings
        .update(json!({"idleCompaction": "beforeCacheExpires"}), None)
        .unwrap();
    Harness {
        engine,
        clock,
        environment,
        project: SqliteEngine::project_id_for(&root),
        dir,
    }
}

impl Harness {
    async fn projection(&self, id: &str) -> Value {
        self.engine.get_thread_projection(id.into()).await.unwrap()
    }

    /// Sends `text` and waits for its run to end. Returns the run's id.
    async fn send(&self, id: &str, text: &str) -> String {
        let n = conn_support::uuid_v4();
        if self.projection_exists(id).await.is_none() {
            self.engine
                .dispatch(conn_contract::from_json(json!({"type": "thread.create",
                    "commandId": format!("create-{id}"), "threadId": id, "projectId": self.project,
                    "title": id, "modelSelection": {"instanceId": "claudeAgent", "model": "claude-haiku-5-5"},
                    "runtimeMode": "auto", "interactionMode": "default", "branch": null,
                    "worktreePath": null, "createdBy": "user", "creationSource": "web"})).unwrap())
                .await
                .unwrap();
        }
        self.engine
            .dispatch(conn_contract::from_json(json!({"type": "message.dispatch",
                "commandId": format!("send-{n}"), "threadId": id, "messageId": format!("message-{n}"),
                "text": text, "attachments": [], "dispatchMode": {"type": "start_immediately"},
                "createdBy": "user", "creationSource": "web"})).unwrap())
            .await
            .unwrap();
        self.until_completed(id, &format!("message-{n}")).await
    }

    async fn projection_exists(&self, id: &str) -> Option<Value> {
        self.engine.get_thread_projection(id.into()).await.ok()
    }

    /// Waits for the run of `message_id` to complete.
    async fn until_completed(&self, id: &str, message_id: &str) -> String {
        for _ in 0..500 {
            let p = self.projection(id).await;
            if let Some(run) = p["runs"]
                .as_array()
                .and_then(|runs| runs.iter().find(|r| r["userMessageId"] == message_id))
                && run["status"] == "completed"
            {
                return run["id"].as_str().unwrap().to_owned();
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("{id}: {message_id} did not complete");
    }

    /// Moves the engine's clock and tokio's together.
    async fn advance(&self, by: Duration) {
        self.clock.advance(by);
        tokio::time::advance(by).await;
    }
}

fn expires_at(minutes: u64) -> String {
    conn_support::time::iso_from_millis(i64::try_from(T0 + minutes * 60_000).unwrap())
}

/// `compactWhenDue` on controlled time: two minutes before the cache expires the server sends
/// `/compact` as its own turn, and the fake Claude runs it; before that nothing is sent.
#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn an_idle_large_context_compacts_before_its_cache_expires() {
    let h = harness("compacts");
    // A pull request watch is not work the next turn waits for: T3's window passes no links to
    // `derivePendingBackgroundWork` (`IdleCompaction.ts:75`), so this thread compacts too.
    h.send("watched", "hello").await;
    h.engine
        .dispatch(
            conn_contract::from_json(json!({"type": "thread.pull-request.watch",
                "commandId": "watch", "threadId": "watched", "host": "github.com",
                "repository": "o/r", "number": 7, "watching": true,
                "link": {"url": "https://github.com/o/r/pull/7", "source": "manual"}}))
            .unwrap(),
        )
        .await
        .unwrap();
    let watched = h
        .send("watched", &format!("large-context:{}", expires_at(10)))
        .await;
    let shell = h
        .engine
        .thread_shell("watched".into())
        .await
        .unwrap()
        .unwrap();
    let tasks = shell["pendingBackgroundTasks"].as_array().unwrap();
    assert!(
        tasks.len() == 1
            && tasks[0]["taskId"]
                .as_str()
                .unwrap()
                .starts_with("pull-request-watch:"),
        "the watch is the thread's only background task: {tasks:?}"
    );
    let run = h
        .send("thread", &format!("large-context:{}", expires_at(10)))
        .await;
    let service = IdleCompaction::new(h.engine.clone(), h.environment.clone());
    service.run_completed("thread", &run);
    service.run_completed("watched", &watched);

    h.advance(Duration::from_secs(7 * 60)).await;
    assert!(service.waiting("thread"), "still before the window");
    let p = h.projection("thread").await;
    assert_eq!(p["runs"].as_array().unwrap().len(), 1);

    h.advance(Duration::from_secs(60 + 1)).await;
    let message = format!("idle-compact:thread:{run}");
    let compaction = h.until_completed("thread", &message).await;
    let p = h.projection("thread").await;
    let sent = p["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["id"] == message.as_str())
        .unwrap();
    assert_eq!(sent["text"], "/compact");
    assert_eq!(sent["idleCompaction"], "beforeCacheExpires");
    h.until_completed("watched", &format!("idle-compact:watched:{watched}"))
        .await;
    assert!(
        p["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["runId"] == compaction.as_str() && m["text"] == "echo: /compact"),
        "the provider ran the compaction"
    );
    // `isSilentRunForShell`: lists and notifications keep the user's last turn.
    let shell = h
        .engine
        .thread_shell("thread".into())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(shell["latestRunId"], run.as_str(), "{shell}");
    // Automatic settlement does not count the compaction as activity.
    let user_message = p["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["role"] == "user" && m["runId"] == run.as_str())
        .unwrap()["updatedAt"]
        .clone();
    let candidate = &h
        .engine
        .settlement_candidates(Some("thread".into()))
        .await
        .unwrap()[0];
    assert_eq!(candidate["latestUserMessageAt"], user_message);
    assert_eq!(candidate["latestUserAuthoredMessageAt"], user_message);
    assert_eq!(candidate["latestRunId"], run.as_str());
    // The sidebar's times skip the compaction too (`idleCompactionOf` in `buildThreadShell`).
    assert_eq!(shell["latestUserMessageAt"], user_message, "{shell}");
    assert_eq!(
        shell["latestUserAuthoredMessageAt"], user_message,
        "{shell}"
    );
}

/// The final check at the deadline: a user turn in between takes the timer over, and that turn
/// (a small context) does not compact. A restart forgets waiting timers, as T3's.
#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn user_activity_or_a_restart_before_the_deadline_sends_nothing() {
    let h = harness("activity");
    let run = h
        .send("thread", &format!("large-context:{}", expires_at(10)))
        .await;
    let service = IdleCompaction::new(h.engine.clone(), h.environment.clone());
    service.run_completed("thread", &run);
    h.advance(Duration::from_secs(60)).await;
    let later = h.send("thread", "I'm back").await;
    h.advance(Duration::from_secs(10 * 60)).await;
    while service.waiting("thread") {
        tokio::task::yield_now().await;
    }
    let p = h.projection("thread").await;
    assert_eq!(p["runs"].as_array().unwrap().len(), 2, "no compaction run");
    assert_eq!(p["runs"][1]["id"], later.as_str());

    // A restart: the new service has no timer for a run that completed before it started.
    let h = harness("restart");
    let run = h
        .send("thread", &format!("large-context:{}", expires_at(10)))
        .await;
    let restarted = IdleCompaction::new(h.engine.clone(), h.environment.clone());
    let _ = run;
    h.advance(Duration::from_secs(9 * 60)).await;
    assert!(!restarted.waiting("thread"));
    assert_eq!(
        h.projection("thread").await["runs"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

/// `Orchestrator.ts:7027`: a run that started since the service looked makes the thread busy,
/// so the compaction it sends is a no-op.
#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn a_compaction_into_a_busy_thread_is_a_no_op() {
    let h = harness("busy");
    h.send("thread", "baseline").await;
    let n = conn_support::uuid_v4();
    h.engine
        .dispatch(
            conn_contract::from_json(json!({"type": "message.dispatch",
            "commandId": format!("send-{n}"), "threadId": "thread", "messageId": "busy",
            "text": "hang", "attachments": [], "dispatchMode": {"type": "start_immediately"},
            "createdBy": "user", "creationSource": "web"}))
            .unwrap(),
        )
        .await
        .unwrap();
    let before = h.projection("thread").await["messages"]
        .as_array()
        .unwrap()
        .len();
    h.engine
        .dispatch(conn_contract::from_json(json!({"type": "message.dispatch",
            "commandId": "server:idle-compact:thread:late", "threadId": "thread",
            "messageId": "idle-compact:thread:late", "text": "/compact", "attachments": [],
            "createdBy": "agent", "creationSource": "server", "idleCompaction": "beforeCacheExpires",
            "dispatchMode": {"type": "start_immediately"}})).unwrap())
        .await
        .unwrap();
    let after = h.projection("thread").await["messages"]
        .as_array()
        .unwrap()
        .len();
    assert_eq!(after, before, "no compaction message while a turn runs");
}

/// Cancellation on the controlled clock, still before the deadline: a cancelled timer, and
/// every timer at shutdown, sends nothing; after shutdown no timer starts.
#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn a_cancelled_timer_and_shutdown_send_nothing() {
    let h = harness("cancel");
    let run = h
        .send("thread", &format!("large-context:{}", expires_at(10)))
        .await;
    let service = IdleCompaction::new(h.engine.clone(), h.environment.clone());
    service.run_completed("thread", &run);
    h.advance(Duration::from_secs(60)).await;
    assert!(service.waiting("thread"));
    service.cancel("thread");
    assert!(!service.waiting("thread"));

    service.run_completed("thread", &run);
    h.advance(Duration::from_secs(60)).await;
    assert!(service.waiting("thread"));
    service.shutdown().await;
    assert!(!service.waiting("thread"));
    service.run_completed("thread", &run);
    assert!(!service.waiting("thread"), "no timer starts after shutdown");

    h.advance(Duration::from_secs(10 * 60)).await;
    let p = h.projection("thread").await;
    assert_eq!(p["runs"].as_array().unwrap().len(), 1, "no compaction run");
}

/// `getThreadRecords` with only what the window reads (`IdleCompactionService.ts:56`): the
/// latest run that ran and its message, the active provider thread and its latest usage.
#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn the_window_reads_only_its_records() {
    let h = harness("records");
    h.send("thread", "baseline").await;
    let run = h
        .send("thread", &format!("large-context:{}", expires_at(10)))
        .await;
    let records = h
        .engine
        .idle_compaction_records("thread".into())
        .await
        .unwrap()
        .unwrap();
    let ids = |kind: &str| -> Vec<Value> {
        records[kind]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| row["id"].clone())
            .collect()
    };
    assert_eq!(ids("runs"), [json!(run)]);
    let p = h.projection("thread").await;
    let run_row = p["runs"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["id"] == run.as_str())
        .unwrap();
    assert_eq!(ids("messages"), [run_row["userMessageId"].clone()]);
    assert_eq!(
        ids("providerThreads"),
        [p["thread"]["activeProviderThreadId"].clone()]
    );
    assert_eq!(records["providerTurns"].as_array().unwrap().len(), 1);
    assert_eq!(records["thread"]["id"], "thread");
    // The same window as from the whole projection.
    let now = i64::try_from(h.engine.now_millis()).unwrap();
    assert_eq!(window(&records, &[], now), window(&p, &[], now));
    assert!(window(&records, &[], now).is_some());
    assert!(
        h.engine
            .idle_compaction_records("missing".into())
            .await
            .unwrap()
            .is_none()
    );
}
