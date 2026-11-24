//! Linked environments as `/mcp` serves them, on a stand-in for the server's peer links: what a
//! forwarded call carries, the link tools, and the fence for a peer link's own work.

use std::sync::Mutex;

use conn_engine::BoxFuture;

use super::*;
use crate::{LinkAsk, LinkInfo, PeerCall, PeerFailure, Peers};

#[derive(Default)]
struct StandIn {
    enabled: bool,
    calls: Mutex<Vec<PeerCall>>,
    /// Waits on run `first` end at `release`, and report run `second` as the thread's answer.
    overlap: bool,
    /// Every call answers `thread_not_found`; from the second call on, only after `release`.
    gone: bool,
    /// With `gone`, the first call waits at the barrier too.
    hold_first: bool,
    gone_calls: std::sync::atomic::AtomicUsize,
    /// Notified when a call reaches the barrier.
    waiting: tokio::sync::Notify,
    release: tokio::sync::Notify,
}

impl Peers for StandIn {
    fn enabled(&self) -> bool {
        self.enabled
    }

    fn list(&self) -> BoxFuture<'_, Result<Vec<Value>, String>> {
        Box::pin(async {
            Ok(vec![json!({
                "environmentId": "env-peer", "label": "Peer", "urls": ["http://127.0.0.1:1"],
                "access": "auto", "linkedAt": "2026-11-19T00:00:00.000Z",
                "expiresAt": "2026-12-19T00:00:00.000Z", "lastReachedAt": null,
                "lastError": null, "status": "reachable",
            })])
        })
    }

    fn get(&self, environment_id: &str) -> BoxFuture<'_, Result<Option<LinkInfo>, String>> {
        let known = environment_id == "env-peer";
        Box::pin(async move {
            Ok(known.then(|| LinkInfo {
                label: "Peer".into(),
                access: "auto".into(),
                expired: false,
            }))
        })
    }

    fn unlink(&self, environment_id: &str) -> BoxFuture<'_, Result<bool, String>> {
        let known = environment_id == "env-peer";
        Box::pin(async move { Ok(known) })
    }

    fn call(&self, call: PeerCall) -> BoxFuture<'_, Result<Value, PeerFailure>> {
        if self.gone {
            let call = self
                .gone_calls
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            return Box::pin(async move {
                if call > 0 || self.hold_first {
                    self.waiting.notify_one();
                    self.release.notified().await;
                }
                Err(PeerFailure {
                    code: "thread_not_found".into(),
                    message: "Thread gone".into(),
                })
            });
        }
        if self.overlap {
            return Box::pin(async move {
                match call.tool.as_str() {
                    // The wait on `first` holds at the barrier and names the newer `second`
                    // as the thread's answer; the wait on `second` ends with it.
                    "conn_thread_wait" if call.arguments["runId"] == "first" => {
                        self.waiting.notify_one();
                        self.release.notified().await;
                        Ok(
                            json!({"threadId":"shared","runId":"first","status":"completed",
                            "timedOut":false,"resultRun":{"runId":"second","status":"completed"}}),
                        )
                    }
                    "conn_thread_wait" => {
                        assert_eq!(call.arguments["runId"], "second");
                        Ok(
                            json!({"threadId":"shared","runId":"second","status":"completed",
                            "timedOut":false,"resultRun":{"runId":"second","status":"completed"}}),
                        )
                    }
                    "conn_thread_read" => Ok(json!({"recentRuns":[], "items":[
                        {"itemId":"i1","type":"assistant_message","runId":"first","text":"First report"},
                        {"itemId":"i2","type":"assistant_message","runId":"second","text":"Second report"}
                    ], "hasMore":false})),
                    tool => panic!("Unexpected peer call {tool}"),
                }
            });
        }
        crate::lock(&self.calls).push(call);
        Box::pin(async { Ok(json!({"threads": [], "total": 0})) })
    }

    fn request_link(&self, _ask: LinkAsk) -> BoxFuture<'_, Result<Value, PeerFailure>> {
        Box::pin(async { Ok(json!({"status": "pending", "turnItemId": "card"})) })
    }
}

fn linked(access: &'static str) -> Caller {
    Caller::Client(ClientCaller {
        session_id: "link-session".into(),
        max_runtime_mode: (access != "read-only").then_some(access),
        label: "T3 Code · other".into(),
        linked: true,
        narrowed: None,
        scopes: None,
    })
}

#[tokio::test(flavor = "current_thread")]
async fn forwards_with_the_callers_limits_and_a_scoped_retry_key() {
    let peers = Arc::new(StandIn {
        enabled: true,
        ..StandIn::default()
    });
    let f = fixture_full(
        "peers-forward",
        None,
        FakeProvider::new("claudeAgent"),
        Some(peers.clone()),
    );
    let mut swamp = Client::open(&f.service, client(true)).await;
    swamp
        .request(
            "tools/call",
            json!({"name": "conn_thread_wait", "arguments": {
                "environmentId": "env-peer", "threadId": "t", "timeoutMs": 999_999,
            }}),
        )
        .await;
    swamp
        .request(
            "tools/call",
            json!({"name": "conn_thread_send", "arguments": {
                "environmentId": "env-peer", "threadId": "t", "message": "hi",
                "clientRequestId": "k",
            }}),
        )
        .await;
    let calls = crate::lock(&peers.calls).clone();
    assert_eq!(calls.len(), 2, "both calls went to the peer");
    let (wait, send) = (&calls[0], &calls[1]);
    assert_eq!(wait.environment_id, "env-peer");
    assert!(
        !wait.arguments.contains_key("environmentId"),
        "the target never reaches the peer"
    );
    assert_eq!(wait.arguments["timeoutMs"], 45_000, "a wait is cut to 45 s");
    assert_eq!(wait.limits.runtime_mode, "full-access");
    assert_eq!(wait.limits.interaction_mode, "default");
    assert!(wait.sender.is_none(), "an outside client sends no thread");
    let key = send.arguments["clientRequestId"].as_str().unwrap();
    assert!(
        key.starts_with("fwd:") && key.len() == 68,
        "the retry key is scoped to its caller: {key}"
    );
    // A mode above the link's access is refused here, with the link named.
    let (code, message) = swamp
        .failure(
            "conn_thread_launch",
            json!({"environmentId": "env-peer", "projectId": "p", "title": "x", "runtimeMode": "full-access"}),
        )
        .await;
    assert_eq!(code, "runtime_mode_escalation_denied");
    assert!(
        message.contains("\"Peer\" was linked with auto access"),
        "{message}"
    );
    assert_eq!(
        crate::lock(&peers.calls).len(),
        2,
        "the refused launch never left"
    );
    // This environment's own id stays here.
    swamp
        .ok(
            "conn_environment_read",
            json!({"environmentId": "env-test"}),
        )
        .await;
    assert_eq!(crate::lock(&peers.calls).len(), 2);
    let links = swamp.ok("conn_environment_links", json!({})).await;
    assert_eq!(links["environmentId"], "env-test");
    assert_eq!(links["links"][0]["status"], "reachable");
    let unlinked = swamp
        .ok(
            "conn_environment_unlink",
            json!({"environmentId": "env-peer"}),
        )
        .await;
    assert_eq!(
        unlinked,
        json!({"environmentId": "env-peer", "removed": true})
    );
    let (code, _) = swamp.failure("conn_environment_link", json!({})).await;
    assert_eq!(
        code, "thread_credential_required",
        "a card needs a calling thread"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn links_off_hides_the_link_tools_and_keeps_calls_here() {
    let f = fixture_full(
        "peers-off",
        None,
        FakeProvider::new("claudeAgent"),
        Some(Arc::new(StandIn::default())),
    );
    let mut swamp = Client::open(&f.service, client(true)).await;
    let list = swamp.request("tools/list", json!({})).await;
    let names: Vec<&str> = list["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|t| t["name"].as_str())
        .collect();
    assert!(!names.contains(&"conn_environment_links"));
    assert!(names.contains(&"conn_environment_preferences_update"));
    let reply = swamp
        .request(
            "tools/call",
            json!({"name": "conn_environment_links", "arguments": {}}),
        )
        .await;
    assert_eq!(reply["error"]["code"], -32602, "a hidden tool is not found");
    let (code, message) = swamp
        .failure("conn_thread_list", json!({"environmentId": "env-peer"}))
        .await;
    assert_eq!(code, "capability_denied");
    assert!(message.starts_with("Linked environments is off on this machine"));
}

#[tokio::test(flavor = "current_thread")]
async fn a_peer_links_work_stays_within_its_link() {
    let peers = Arc::new(StandIn {
        enabled: true,
        ..StandIn::default()
    });
    let f = fixture_full(
        "peers-fence",
        None,
        FakeProvider::new("claudeAgent"),
        Some(peers),
    );
    let mut swamp = Client::open(&f.service, client(true)).await;
    let own = launch_as_swamp(&mut swamp, "own", "hang", "auto", "default").await;
    let mut link = Client::open(&f.service, linked("auto")).await;
    let started = link
        .ok(
            "conn_thread_launch",
            json!({"projectId": project_id(), "title": "linked", "message": "hang",
                "modelSelection": {"instanceId": "claudeAgent", "model": "claude-haiku-5-5"}}),
        )
        .await;
    let projection = f
        .service
        .config
        .engine
        .get_thread_projection(conn_contract::ThreadId::from(
            started["threadId"].as_str().unwrap(),
        ))
        .await
        .unwrap();
    assert_eq!(
        projection["thread"]["linkOrigin"],
        json!({"sessionId": "link-session", "label": "T3 Code · other", "access": "auto"}),
        "the thread carries its link"
    );
    let (code, message) = link
        .failure(
            "conn_thread_send",
            json!({"threadId": own, "message": "x", "mode": "queue"}),
        )
        .await;
    assert_eq!(code, "capability_denied");
    assert!(message.contains("it may change only threads that link started"));
    link.ok(
        "conn_thread_send",
        json!({"threadId": started["threadId"], "message": "x", "mode": "queue"}),
    )
    .await;
    let (code, message) = link.failure("conn_environment_links", json!({})).await;
    assert_eq!(code, "capability_denied");
    assert!(
        message.contains("it cannot use this environment's links"),
        "{message}"
    );
    let (code, _) = link
        .failure(
            "conn_environment_unlink",
            json!({"environmentId": "env-peer"}),
        )
        .await;
    assert_eq!(code, "capability_denied");
    // A full-access link is not fenced.
    let mut full = Client::open(&f.service, linked("full-access")).await;
    full.ok(
        "conn_thread_send",
        json!({"threadId": own, "message": "x", "mode": "queue"}),
    )
    .await;
}

/// A native bearer session keeps its scopes on `/mcp`: `orchestration:operate` alone is not
/// enough to change settings or links.
#[tokio::test(flavor = "current_thread")]
async fn a_native_session_needs_the_scopes_settings_and_links_need() {
    let f = fixture_full(
        "peers-scopes",
        None,
        FakeProvider::new("claudeAgent"),
        Some(Arc::new(StandIn {
            enabled: true,
            ..StandIn::default()
        })),
    );
    let operate_only = Caller::Client(ClientCaller {
        session_id: "device".into(),
        max_runtime_mode: Some("full-access"),
        scopes: Some(vec![
            "orchestration:read".into(),
            "orchestration:operate".into(),
        ]),
        ..ClientCaller::default()
    });
    let mut device = Client::open(&f.service, operate_only).await;
    for (tool, args, scope) in [
        (
            "conn_environment_preferences_update",
            json!({"newWorktreesStartFromOrigin": false}),
            "settings:write",
        ),
        (
            "conn_environment_unlink",
            json!({"environmentId": "env-peer"}),
            "access:write",
        ),
        ("conn_environment_links", json!({}), "access:read"),
    ] {
        let (code, message) = device.failure(tool, args).await;
        assert_eq!(code, "capability_denied", "{tool}");
        assert!(message.contains(scope), "{tool}: {message}");
    }
    let granted = Caller::Client(ClientCaller {
        session_id: "admin".into(),
        max_runtime_mode: Some("full-access"),
        scopes: Some(
            [
                "orchestration:read",
                "orchestration:operate",
                "access:read",
                "access:write",
            ]
            .map(String::from)
            .to_vec(),
        ),
        ..ClientCaller::default()
    });
    let mut admin = Client::open(&f.service, granted).await;
    admin
        .ok(
            "conn_environment_unlink",
            json!({"environmentId": "env-peer"}),
        )
        .await;
    admin.ok("conn_environment_links", json!({})).await;
}

/// The fence fails closed: when the calling thread cannot be read, the caller is not taken for
/// one that acts for no link.
#[tokio::test(flavor = "current_thread")]
async fn a_failed_thread_read_does_not_open_the_fence() {
    let f = fixture("peers-fence-closed");
    let caller = Caller::Thread(ThreadCaller {
        thread_id: "thread:missing".into(),
        provider_session_id: "p".into(),
        provider_instance_id: "claudeAgent".into(),
        preview: false,
        device: false,
        subagent: false,
    });
    let cx = crate::tools::Cx {
        service: &f.service,
        caller: &caller,
        origin: None,
    };
    assert!(
        cx.link_origin().await.is_err(),
        "an unread thread is not \"no link\""
    );
    assert!(cx.fencing_link().await.is_err());
    assert!(cx.assert_not_linked("change this").await.is_err());
}

/// A native session without `settings:write` cannot change preferences on a linked
/// environment either: refused here, and nothing reaches the peer.
#[tokio::test(flavor = "current_thread")]
async fn a_native_sessions_scopes_hold_for_a_linked_environment() {
    let peers = Arc::new(StandIn {
        enabled: true,
        ..StandIn::default()
    });
    let f = fixture_full(
        "peers-scopes-remote",
        None,
        FakeProvider::new("claudeAgent"),
        Some(peers.clone()),
    );
    let operate_only = Caller::Client(ClientCaller {
        session_id: "device".into(),
        max_runtime_mode: Some("full-access"),
        scopes: Some(vec![
            "orchestration:read".into(),
            "orchestration:operate".into(),
        ]),
        ..ClientCaller::default()
    });
    let mut device = Client::open(&f.service, operate_only).await;
    let (code, message) = device
        .failure(
            "conn_environment_preferences_update",
            json!({"environmentId": "env-peer", "newWorktreesStartFromOrigin": false}),
        )
        .await;
    assert_eq!(code, "capability_denied");
    assert!(message.contains("settings:write"), "{message}");
    assert!(
        crate::lock(&peers.calls).is_empty(),
        "nothing went to the peer"
    );
}

/// Records a remote task of `parent` on the shared thread there, for run `run`.
async fn remote_task(f: &Fixture, parent: &str, run: &str) -> String {
    let engine = &f.service.config.engine;
    let projection = engine.get_thread_projection(parent.into()).await.unwrap();
    let owner = &projection["runs"][0];
    engine.remote_task(json!({
        "type":"delegated_task.remote.request","commandId":run,"threadId":parent,
        "parentThreadId":parent,"parentRunId":owner["id"],"parentNodeId":owner["rootNodeId"],
        "task":run,"modelSelection":owner["modelSelection"],"driver":"remote",
        "remoteChild":{"threadId":"shared","environmentId":"env-peer","label":"Peer","runId":run},
        "completionWake":"always"
    })).await.unwrap();
    format!("node:delegated-task:{run}")
}

/// What the parent store holds for `task`, read on a fresh connection: the task as last
/// recorded, how often it went from no result to a result, and the wake messages naming it.
fn stored_task(f: &Fixture, parent: &str, task: &str) -> (Value, usize, usize) {
    let db = rusqlite::Connection::open(f.dir.join("engine.sqlite")).unwrap();
    let mut rows = db
        .prepare(
            "SELECT json_extract(event, '$.payload') FROM events
             WHERE thread_id = ?1 AND type = 'subagent.updated'
               AND json_extract(event, '$.payload.id') = ?2 ORDER BY seq",
        )
        .unwrap();
    let rows: Vec<Value> = rows
        .query_map([parent, task], |row| row.get::<_, String>(0))
        .unwrap()
        .map(|row| serde_json::from_str(&row.unwrap()).unwrap())
        .collect();
    let results = rows
        .windows(2)
        .filter(|pair| pair[0]["result"].is_null() && pair[1]["result"].is_string())
        .count();
    let wakes: usize = db
        .query_row(
            "SELECT count(DISTINCT json_extract(event, '$.payload.id')) FROM events
             WHERE thread_id = ?1 AND type = 'message.updated'
               AND instr(json_extract(event, '$.payload.text'), ?2) > 0",
            [parent, &format!("Delegated task {task} ")],
            |row| row.get(0),
        )
        .unwrap();
    (rows.last().cloned().unwrap_or(Value::Null), results, wakes)
}

/// `RemoteDelegation.test.ts`, "a follow-up there ends with its own reply, not one queued
/// behind it": a follow-up recorded on the same thread there, before or during this task's
/// wait, keeps its answer from this task.
#[tokio::test(flavor = "current_thread")]
async fn a_follow_up_recorded_during_the_wait_keeps_its_reply() {
    for during in [true, false] {
        let peer = Arc::new(StandIn {
            enabled: true,
            overlap: true,
            ..Default::default()
        });
        let f = fixture_full(
            &format!("overlap-{during}"),
            None,
            FakeProvider::new("claudeAgent"),
            Some(peer.clone()),
        );
        let mut client = Client::open(&f.service, client(true)).await;
        let parent = launch_as_swamp(&mut client, "Parent", "hang", "full-access", "default").await;
        until_provider_turn(&f, &parent).await;
        let original = remote_task(&f, &parent, "original").await;
        f.service.config.engine.remote_task(json!({
            "type":"delegated_task.remote.complete","commandId":"original-ended","threadId":parent,
            "parentThreadId":parent,"taskId":original,"status":"completed","result":"Original report",
            "stoppedThere":"ran-out"
        })).await.unwrap();
        let first = remote_task(&f, &parent, "first").await;
        let second = "node:delegated-task:second".to_owned();
        if !during {
            remote_task(&f, &parent, "second").await;
        }
        let follow = f.service.follow_for_test(&parent, &first);
        let record = async {
            peer.waiting.notified().await;
            if during {
                remote_task(&f, &parent, "second").await;
            }
            peer.release.notify_one();
        };
        tokio::join!(follow, record);
        // The follow-up's own follower ends with its own run.
        f.service.follow_for_test(&parent, &second).await;
        for (task, run, report) in [
            (&first, "first", "First report"),
            (&second, "second", "Second report"),
        ] {
            let (row, results, _) = stored_task(&f, &parent, task);
            assert_eq!(row["remoteChild"]["runId"], run, "during: {during}");
            assert_eq!(row["result"], report, "{task}, during: {during}");
            assert_eq!(results, 1, "{task}, during: {during}");
        }
    }
}

/// `RemoteDelegation.test.ts`, "fifth audit retries a refused completion after a transient
/// local write failure": the follower that met a final refusal there keeps trying to record
/// it here, and records it once.
#[tokio::test(flavor = "current_thread")]
async fn a_final_refusal_is_recorded_after_a_failed_local_write() {
    let peer = Arc::new(StandIn {
        enabled: true,
        gone: true,
        ..Default::default()
    });
    let f = fixture_full(
        "refusal-write",
        None,
        FakeProvider::new("claudeAgent"),
        Some(peer.clone()),
    );
    let mut client = Client::open(&f.service, client(true)).await;
    let parent = launch_as_swamp(&mut client, "Parent", "hang", "full-access", "default").await;
    until_provider_turn(&f, &parent).await;
    let task = remote_task(&f, &parent, "first").await;
    let db = rusqlite::Connection::open(f.dir.join("engine.sqlite")).unwrap();
    db.execute_batch(
        "CREATE TRIGGER refuse_result BEFORE INSERT ON events
           WHEN NEW.type = 'subagent.updated'
           BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END;",
    )
    .unwrap();
    // The back-off between attempts runs on the paused clock.
    tokio::time::pause();
    let mut follow = std::pin::pin!(f.service.follow_for_test(&parent, &task));
    // A second call there means the first completion failed here and the follower went on.
    let retried = tokio::select! {
        () = &mut follow => false,
        () = peer.waiting.notified() => true,
    };
    db.execute_batch("DROP TRIGGER refuse_result").unwrap();
    if retried {
        peer.release.notify_one();
        follow.await;
    }
    let engine = &f.service.config.engine;
    assert!(engine.open_remote_tasks(10).await.unwrap().is_empty());
    let (row, results, wakes) = stored_task(&f, &parent, &task);
    assert_eq!(row["status"], "failed");
    assert!(
        row["result"].as_str().unwrap().contains("Thread gone"),
        "{row}"
    );
    assert_eq!(results, 1, "one result was recorded");
    assert_eq!(wakes, 1);
}

/// `RemoteDelegation.ts` `followGaveUp`: after repeated failures here the follower still
/// fails the task, retrying that last write with back-off until the store takes it.
#[tokio::test(flavor = "current_thread")]
async fn a_follower_past_its_defect_limit_still_records_the_task_once() {
    let peer = Arc::new(StandIn {
        enabled: true,
        gone: true,
        ..Default::default()
    });
    let f = fixture_full(
        "give-up-write",
        None,
        FakeProvider::new("claudeAgent"),
        Some(peer.clone()),
    );
    let mut client = Client::open(&f.service, client(true)).await;
    let parent = launch_as_swamp(&mut client, "Parent", "hang", "full-access", "default").await;
    until_provider_turn(&f, &parent).await;
    let task = remote_task(&f, &parent, "first").await;
    // Every read and write of the parent's rows fails until the table comes back.
    let db = rusqlite::Connection::open(f.dir.join("engine.sqlite")).unwrap();
    db.execute_batch("ALTER TABLE entities RENAME TO entities_away")
        .unwrap();
    tokio::time::pause();
    let mut follow = std::pin::pin!(f.service.follow_for_test(&parent, &task));
    let ended_while_broken = tokio::select! {
        () = &mut follow => true,
        () = tokio::time::sleep(std::time::Duration::from_secs(3600)) => false,
    };
    db.execute_batch("ALTER TABLE entities_away RENAME TO entities")
        .unwrap();
    if !ended_while_broken {
        follow.await;
    }
    let engine = &f.service.config.engine;
    assert!(engine.open_remote_tasks(10).await.unwrap().is_empty());
    let (row, results, wakes) = stored_task(&f, &parent, &task);
    assert_eq!(row["status"], "failed");
    assert!(
        row["result"]
            .as_str()
            .unwrap()
            .contains("failed repeatedly"),
        "{row}"
    );
    assert_eq!(results, 1);
    assert_eq!(wakes, 1);
}

/// `RemoteDelegation.ts`: followers run in a scope the server closes at shutdown. A follower
/// waiting out its back-off stops with the server and writes nothing afterwards, even once the
/// store works again; the task stays open for the next start.
#[tokio::test(flavor = "current_thread")]
async fn shutdown_stops_a_follower_in_its_back_off() {
    let peer = Arc::new(StandIn {
        enabled: true,
        gone: true,
        ..Default::default()
    });
    let f = fixture_full(
        "follower-shutdown",
        None,
        FakeProvider::new("claudeAgent"),
        Some(peer.clone()),
    );
    let mut client = Client::open(&f.service, client(true)).await;
    let parent = launch_as_swamp(&mut client, "Parent", "hang", "full-access", "default").await;
    until_provider_turn(&f, &parent).await;
    let task = remote_task(&f, &parent, "first").await;
    let db = rusqlite::Connection::open(f.dir.join("engine.sqlite")).unwrap();
    db.execute_batch("ALTER TABLE entities RENAME TO entities_away")
        .unwrap();
    tokio::time::pause();
    f.service.follow_remote_task(&parent, &task);
    // Past the defect limit, the follower waits out its back-off.
    tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
    f.service.stop_remote_tasks().await;
    db.execute_batch("ALTER TABLE entities_away RENAME TO entities")
        .unwrap();
    tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
    let (row, results, wakes) = stored_task(&f, &parent, &task);
    assert!(row["result"].is_null(), "{row}");
    assert_eq!((results, wakes), (0, 0));
    let engine = &f.service.config.engine;
    assert_eq!(
        engine.open_remote_tasks(10).await.unwrap(),
        vec![(parent.clone(), task.clone())]
    );
    // A follower asked for after the stop never starts.
    f.service.follow_remote_task(&parent, &task);
    tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
    assert_eq!(stored_task(&f, &parent, &task).1, 0);
}

/// A completion already handed to the engine when the server stops is not dropped half way:
/// the stop waits until it committed, so the task keeps its one result and its parent's wake.
#[tokio::test(flavor = "current_thread")]
async fn shutdown_drains_a_completion_already_submitted() {
    let peer = Arc::new(StandIn {
        enabled: true,
        gone: true,
        hold_first: true,
        ..Default::default()
    });
    let f = fixture_full(
        "follower-drain",
        None,
        FakeProvider::new("claudeAgent"),
        Some(peer.clone()),
    );
    let mut client = Client::open(&f.service, client(true)).await;
    let parent = launch_as_swamp(&mut client, "Parent", "hang", "full-access", "default").await;
    until_provider_turn(&f, &parent).await;
    let task = remote_task(&f, &parent, "first").await;
    let hold = Arc::new(crate::remote_tasks::WriteHold::default());
    *crate::lock(&f.service.remote.hold) = Some(hold.clone());
    f.service.follow_remote_task(&parent, &task);
    peer.waiting.notified().await;
    peer.release.notify_one();
    // The follower has handed its completion over; the engine has not taken it yet.
    hold.entered.notified().await;
    let mut stop = std::pin::pin!(f.service.stop_remote_tasks());
    let pending =
        std::future::poll_fn(|cx| std::task::Poll::Ready(stop.as_mut().poll(cx).is_pending()))
            .await;
    assert!(pending, "the stop waits for the write it was handed");
    hold.release.notify_one();
    stop.await;
    let (row, results, wakes) = stored_task(&f, &parent, &task);
    assert!(!row["result"].is_null(), "{row}");
    assert_eq!((results, wakes), (1, 1));
}
