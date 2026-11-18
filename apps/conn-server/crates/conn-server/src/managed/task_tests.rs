//! The task worker grant on a real managed ingress (item 6): the allowlist, the atomic owner
//! check at dispatch, exactly one accept, no replay, exact cancellation, own-run interrupts,
//! project binding, settlement-only reads, and commits that survive the caller and respect
//! the fence. The lab, the fake Gateway and the socket helpers are item 4's (`tests.rs`).

use std::{sync::Arc, time::Duration};

use conn_engine::{CommitGate, DispatchGuard, Engine, GuardRule};
use serde_json::{Value, json};

use super::super::tests::{Lab, connect, next, send};
use crate::managed::task::GRANT_FIELD;

const NODE_B: u64 = 102;
const THREAD: &str = "task-thread-1";

fn project_id() -> String {
    conn_engine::SqliteEngine::project_id_for("/tmp/p")
}

fn sha(text: &str) -> String {
    conn_support::hex::hex(&conn_support::hmac::sha256(text.as_bytes()))
}

fn create_body() -> Value {
    json!({
        "projectId": project_id(), "title": "Implement", "runtimeMode": "full-access",
        "interactionMode": "default", "createdBy": "user", "creationSource": "web",
        "modelSelection": {"instanceId": "claudeAgent", "model": "m"},
    })
}

fn grant(message_id: &str, text: &str, create: bool) -> Value {
    json!({
        "purpose": "task_worker", "task_id": 5873, "copy_id": 3709,
        "turn_id": format!("turn-{message_id}"),
        "project_id": project_id(), "thread_id": THREAD,
        "create": if create { json!({"command_id": "cmd-create", "body": create_body()}) } else { Value::Null },
        "message": {"command_id": format!("cmd-{message_id}"), "message_id": message_id,
            "text_sha256": sha(text), "interrupt_command_id": format!("stop-{message_id}"),
            "created_by": "user", "creation_source": "web"},
        "earlier": [], "questions": [],
    })
}

fn worker_token(lab: &Lab, mut grant: Value) -> String {
    // Earlier turns name their captured attribution; the tests' people send as user/web.
    if let Some(earlier) = grant["earlier"].as_array_mut() {
        for turn in earlier {
            for (key, value) in [("created_by", "user"), ("creation_source", "web")] {
                if turn.get(key).is_none() {
                    turn[key] = json!(value);
                }
            }
        }
    }
    let mut extra = serde_json::Map::new();
    extra.insert(GRANT_FIELD.into(), grant);
    lab.fake.issue_with(
        NODE_B,
        vec!["orchestration:read".into(), "orchestration:operate".into()],
        extra,
    )
}

fn create_command() -> Value {
    let mut command = json!({
        "type": "thread.create", "commandId": "cmd-create", "threadId": THREAD,
        "branch": null, "worktreePath": null,
    });
    for (key, value) in create_body().as_object().unwrap() {
        command[key] = value.clone();
    }
    command
}

fn dispatch_command(command_id: &str, message_id: &str, text: &str) -> Value {
    json!({
        "type": "message.dispatch", "commandId": command_id, "threadId": THREAD,
        "messageId": message_id, "text": text, "attachments": [],
        "createdBy": "user", "creationSource": "web",
        "dispatchMode": {"type": "start_immediately"},
    })
}

fn stop(command_id: &str, run_id: &Value) -> Value {
    json!({"type": "run.interrupt", "commandId": command_id, "threadId": THREAD, "runId": run_id})
}

type Socket = tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>;

/// One unary call; returns `Ok(value)` or `Err(failure)`.
async fn call(socket: &mut Socket, id: u32, tag: &str, payload: Value) -> Result<Value, Value> {
    send(
        socket,
        json!({"_tag": "Request", "id": id.to_string(), "tag": tag, "payload": payload, "headers": []}),
    )
    .await;
    loop {
        let frame = next(socket).await.expect("socket open");
        if frame["_tag"] == "Exit" && frame["requestId"].as_str() == Some(id.to_string().as_str()) {
            let exit = &frame["exit"];
            return if exit["_tag"] == "Success" {
                Ok(exit["value"].clone())
            } else {
                Err(exit.clone())
            };
        }
    }
}

async fn dispatch(socket: &mut Socket, id: u32, command: Value) -> Result<Value, Value> {
    call(socket, id, "orchestration.dispatchCommand", command).await
}

async fn read(socket: &mut Socket, id: u32, thread: &str) -> Result<Value, Value> {
    call(
        socket,
        id,
        "orchestration.getThreadProjection",
        json!({"threadId": thread}),
    )
    .await
}

async fn projection(socket: &mut Socket, id: u32) -> Value {
    read(socket, id, THREAD).await.expect("projection")
}

fn runs(projection: &Value) -> Vec<Value> {
    projection["runs"].as_array().cloned().unwrap_or_default()
}

fn user_messages(projection: &Value) -> Vec<Value> {
    projection["messages"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|m| m["role"] == "user")
        .cloned()
        .collect()
}

/// Waits until the run of `message_id` on the engine has `status`.
async fn until_run(lab: &Lab, thread: &str, message_id: &str, status: &str) -> Value {
    let engine = lab.app.engine.clone().unwrap();
    for n in 0..800 {
        let p = engine
            .get_thread_projection(thread.to_owned().into())
            .await
            .expect("projection");
        if let Some(run) = runs(&p)
            .into_iter()
            .find(|r| r["userMessageId"] == message_id && r["status"] == status)
        {
            return run;
        }
        assert!(n < 799, "run of {message_id} never reached {status}: {p}");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    unreachable!()
}

async fn until_request(lab: &Lab, request_id: &str, pending: bool) {
    let engine = lab.app.engine.clone().unwrap();
    for n in 0..800 {
        let p = engine.get_thread_projection(THREAD.into()).await.unwrap();
        let found = p["runtimeRequests"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|r| r["id"] == request_id && (r["status"] == "pending") == pending);
        if found {
            return;
        }
        assert!(
            n < 799,
            "request {request_id} never became pending={pending}: {p}"
        );
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

async fn worker(lab: &Lab, grant: Value) -> Socket {
    connect(lab.v6, "", Some(&worker_token(lab, grant)))
        .await
        .expect("worker admitted")
}

/// A person's command, sent past the managed ingress (as Conn would).
async fn person(lab: &Lab, command: Value) {
    let engine = lab.app.engine.clone().unwrap();
    engine
        .dispatch(conn_contract::from_json(command).unwrap())
        .await
        .expect("the person's command");
}

async fn person_sends(lab: &Lab, message_id: &str, text: &str) {
    person(
        lab,
        dispatch_command(&format!("person-{message_id}"), message_id, text),
    )
    .await;
}

#[tokio::test(flavor = "current_thread")]
async fn a_worker_creates_and_dispatches_its_turn_once_and_a_replay_adds_nothing() {
    let lab = Lab::start().await;
    let mut w = worker(&lab, grant("m1", "do it", true)).await;
    dispatch(&mut w, 1, create_command()).await.expect("create");
    let empty = projection(&mut w, 2).await;
    assert!(runs(&empty).is_empty() && user_messages(&empty).is_empty());
    let message = dispatch_command("cmd-m1", "m1", "do it");
    dispatch(&mut w, 3, message.clone())
        .await
        .expect("dispatch");
    until_run(&lab, THREAD, "m1", "completed").await;
    // The reply was lost; the worker must never replay, and a replay is refused anyway.
    assert!(
        dispatch(&mut w, 4, message).await.is_err(),
        "no second accept"
    );
    assert!(dispatch(&mut w, 5, create_command()).await.is_err());
    let p = projection(&mut w, 6).await;
    assert_eq!((user_messages(&p).len(), runs(&p).len()), (1, 1), "{p}");
}

#[tokio::test(flavor = "current_thread")]
async fn the_frozen_bodies_are_complete() {
    let lab = Lab::start().await;
    let mut w = worker(&lab, grant("m1", "do it", true)).await;
    // A worktree outside the admitted workspace is a field the frozen body does not hold.
    let mut moved = create_command();
    moved["worktreePath"] = json!("/tmp/elsewhere");
    assert!(dispatch(&mut w, 1, moved).await.is_err());
    dispatch(&mut w, 2, create_command()).await.expect("create");
    // Another model, a fresh context or a sender: each is a field a task message may not carry.
    for (n, (key, value)) in [
        (
            "modelSelection",
            json!({"instanceId": "claudeAgent", "model": "other"}),
        ),
        ("freshContext", json!(true)),
        ("senderThreadId", json!("t-other")),
    ]
    .into_iter()
    .enumerate()
    {
        let mut message = dispatch_command("cmd-m1", "m1", "do it");
        message[key] = value;
        let id = u32::try_from(n).unwrap() + 10;
        assert!(
            dispatch(&mut w, id, message).await.is_err(),
            "{key} was allowed"
        );
    }
    let p = projection(&mut w, 20).await;
    assert!(user_messages(&p).is_empty(), "{p}");
}

#[tokio::test(flavor = "current_thread")]
async fn concurrent_sends_to_one_thread_give_exactly_one_accept() {
    let lab = Lab::start().await;
    let mut w1 = worker(&lab, grant("m1", "do it", true)).await;
    let mut w2 = worker(&lab, grant("m1", "do it", true)).await;
    dispatch(&mut w1, 1, create_command())
        .await
        .expect("create");
    let message = dispatch_command("cmd-m1", "m1", "do it");
    let (a, b) = tokio::join!(
        dispatch(&mut w1, 2, message.clone()),
        dispatch(&mut w2, 2, message),
    );
    assert_eq!(
        [a.is_ok(), b.is_ok()].iter().filter(|ok| **ok).count(),
        1,
        "exactly one accept: {a:?} {b:?}"
    );
    until_run(&lab, THREAD, "m1", "completed").await;
    let p = projection(&mut w1, 3).await;
    assert_eq!((user_messages(&p).len(), runs(&p).len()), (1, 1), "{p}");
}

#[tokio::test(flavor = "current_thread")]
async fn a_persons_active_run_refuses_the_workers_dispatch_and_nothing_is_queued() {
    let lab = Lab::start().await;
    let mut w = worker(&lab, grant("m1", "do it", true)).await;
    dispatch(&mut w, 1, create_command()).await.expect("create");
    // A person writes between create and the first message; the run is still active.
    person_sends(&lab, "p1", "hang").await;
    let run = until_run(&lab, THREAD, "p1", "running").await;
    let refused = dispatch(&mut w, 2, dispatch_command("cmd-m1", "m1", "do it")).await;
    assert!(refused.is_err(), "the owner check refuses: {refused:?}");
    let p = projection(&mut w, 3).await;
    assert_eq!(runs(&p).len(), 1, "nothing queued or steered: {p}");
    // The worker cannot stop the person's run, with any of its stop IDs.
    assert!(
        dispatch(&mut w, 4, stop("stop-m1", &run["id"]))
            .await
            .is_err()
    );
    until_run(&lab, THREAD, "p1", "running").await;
}

#[tokio::test(flavor = "current_thread")]
async fn a_wrong_task_grant_is_refused_and_changes_nothing() {
    let lab = Lab::start().await;
    let mut admitted = worker(&lab, grant("m1", "do it", true)).await;
    dispatch(&mut admitted, 1, create_command())
        .await
        .expect("create");
    // A grant for another thread and message.
    let mut other = grant("m9", "other", true);
    other["thread_id"] = json!("another-thread");
    let mut w = worker(&lab, other).await;
    let tries = [
        (
            "orchestration.dispatchCommand",
            dispatch_command("cmd-m1", "m1", "do it"),
        ),
        (
            "orchestration.dispatchCommand",
            dispatch_command("cmd-m9", "m9", "other"),
        ),
        (
            "orchestration.getThreadProjection",
            json!({"threadId": THREAD}),
        ),
        (
            "orchestration.dispatchCommand",
            json!({"type": "thread.stop", "commandId": "s", "threadId": THREAD}),
        ),
    ];
    for (n, (tag, payload)) in tries.into_iter().enumerate() {
        let id = u32::try_from(n).unwrap() + 10;
        assert!(
            call(&mut w, id, tag, payload).await.is_err(),
            "{tag} was allowed"
        );
    }
    // A method outside the allowlist is not served at all.
    let other_method = call(&mut w, 20, "orchestration.launchThread", json!({})).await;
    assert!(
        other_method
            .unwrap_err()
            .to_string()
            .contains("ConnServerNotSupported")
    );
    // A changed body or text is refused even with the admitted IDs.
    let changed = dispatch(
        &mut admitted,
        21,
        dispatch_command("cmd-m1", "m1", "something else"),
    )
    .await;
    assert!(changed.is_err());
    let p = projection(&mut admitted, 22).await;
    assert!(runs(&p).is_empty() && user_messages(&p).is_empty(), "{p}");
    // Malformed grants are no worker tokens: an extra field, other scopes, or a stored
    // question of a thread the turn does not answer.
    let mut loose = grant("m1", "do it", true);
    loose["admin"] = json!(true);
    assert_eq!(
        connect(lab.v6, "", Some(&worker_token(&lab, loose)))
            .await
            .err(),
        Some(403)
    );
    let mut stray = grant("m1", "do it", true);
    stray["questions"] = json!([{"thread_id": "another-thread", "request_id": "q",
        "owner_run_id": "r", "cancel_command_id": "c"}]);
    assert_eq!(
        connect(lab.v6, "", Some(&worker_token(&lab, stray)))
            .await
            .err(),
        Some(403)
    );
    let mut extra = serde_json::Map::new();
    extra.insert(GRANT_FIELD.into(), grant("m1", "do it", true));
    let wide = lab.fake.issue_with(
        NODE_B,
        vec![
            "orchestration:read".into(),
            "orchestration:operate".into(),
            "terminal:operate".into(),
        ],
        extra,
    );
    assert_eq!(connect(lab.v6, "", Some(&wide)).await.err(), Some(403));
    // A worker cannot read through the reader routes.
    let token = worker_token(&lab, grant("m1", "do it", true));
    let status =
        super::super::tests::http(lab.v6, "GET", "/api/orchestration/shell", Some(&token), "")
            .await;
    assert_eq!(status, 403);
}

#[tokio::test(flavor = "current_thread")]
async fn a_thread_of_another_project_is_refused_everywhere() {
    let lab = Lab::start().await;
    // A thread with the admitted ID exists, but in another project.
    let mut foreign = create_command();
    foreign["commandId"] = json!("person-create");
    foreign["projectId"] = json!(conn_engine::SqliteEngine::project_id_for("/tmp/q"));
    person(&lab, foreign).await;
    let mut w = worker(&lab, grant("m1", "do it", false)).await;
    assert!(read(&mut w, 1, THREAD).await.is_err(), "read refused");
    assert!(
        dispatch(&mut w, 2, dispatch_command("cmd-m1", "m1", "do it"))
            .await
            .is_err()
    );
    let p = lab
        .app
        .engine
        .clone()
        .unwrap()
        .get_thread_projection(THREAD.into())
        .await
        .unwrap();
    assert!(user_messages(&p).is_empty(), "nothing written: {p}");
}

#[tokio::test(flavor = "current_thread")]
async fn an_earlier_turns_thread_shows_only_its_settlement_evidence() {
    let lab = Lab::start().await;
    // An earlier role's thread, with its frozen message and a person's later message.
    let earlier_thread = "reviewer-thread";
    let mut create = create_command();
    create["commandId"] = json!("person-create-r");
    create["threadId"] = json!(earlier_thread);
    person(&lab, create).await;
    let send = |command_id: &str, message_id: &str, text: &str| {
        let mut command = dispatch_command(command_id, message_id, text);
        command["threadId"] = json!(earlier_thread);
        command
    };
    person(&lab, send("pr1", "r1", "hang")).await;
    let r1 = until_run(&lab, earlier_thread, "r1", "running").await;
    let mut g = grant("m1", "do it", true);
    g["earlier"] = json!([{"thread_id": earlier_thread, "message_id": "r1", "text_sha256": sha("hang"),
        "run_id": r1["id"], "interrupt_command_id": "stop-r1"}]);
    let mut w = worker(&lab, g).await;
    let view = read(&mut w, 1, earlier_thread)
        .await
        .expect("settlement read");
    assert_eq!(view["messages"].as_array().unwrap().len(), 1, "{view}");
    assert_eq!(runs(&view).len(), 1, "{view}");
    assert!(view["turnItems"].as_array().unwrap().is_empty());
    assert_eq!(
        view["thread"]["title"], "Earlier turn",
        "no thread details: {view}"
    );
    // It stops exactly that run, by its admitted stop ID.
    let mut stop_it = stop("stop-r1", &r1["id"]);
    stop_it["threadId"] = json!(earlier_thread);
    dispatch(&mut w, 2, stop_it)
        .await
        .expect("stops the earlier run");
    until_run(&lab, earlier_thread, "r1", "interrupted").await;
    // A person's later run on that thread is not the earlier turn's.
    person(&lab, send("pr2", "r2", "hang")).await;
    let r2 = until_run(&lab, earlier_thread, "r2", "running").await;
    let mut stop_other = stop("stop-r1", &r2["id"]);
    stop_other["threadId"] = json!(earlier_thread);
    assert!(dispatch(&mut w, 3, stop_other).await.is_err());
    // A digest that does not match the stored text authorizes nothing.
    let mut wrong = grant("m1", "do it", true);
    wrong["earlier"] = json!([{"thread_id": earlier_thread, "message_id": "r2", "text_sha256": sha("other"),
        "interrupt_command_id": "stop-r2"}]);
    let mut w2 = worker(&lab, wrong).await;
    let mut stop_r2 = stop("stop-r2", &r2["id"]);
    stop_r2["threadId"] = json!(earlier_thread);
    assert!(dispatch(&mut w2, 1, stop_r2).await.is_err());
    until_run(&lab, earlier_thread, "r2", "running").await;
}

#[tokio::test(flavor = "current_thread")]
async fn only_the_stored_question_of_its_owner_run_is_cancelled_then_the_answer_runs() {
    let lab = Lab::start().await;
    // Turn 1 asks a question.
    let mut w1 = worker(&lab, grant("m1", "question", true)).await;
    dispatch(&mut w1, 1, create_command())
        .await
        .expect("create");
    dispatch(&mut w1, 2, dispatch_command("cmd-m1", "m1", "question"))
        .await
        .expect("dispatch");
    let run = until_run(&lab, THREAD, "m1", "running").await;
    let run_id = run["id"].as_str().unwrap().to_owned();
    let request_id = format!("question:{run_id}");
    until_request(&lab, &request_id, true).await;

    // The answer turn's grant names the stored request and its owner run.
    let mut answer = grant("m2", "the answer", false);
    answer["earlier"] = json!([{"thread_id": THREAD, "message_id": "m1", "text_sha256": sha("question"),
        "interrupt_command_id": "stop-earlier-m1"}]);
    answer["questions"] = json!([{"thread_id": THREAD, "request_id": request_id, "owner_run_id": run_id,
        "cancel_command_id": "cancel-q1"}]);
    let cancel = |request: &str, decision: Value, command_id: &str| {
        json!({"type": "runtime-request.respond", "commandId": command_id,
               "threadId": THREAD, "requestId": request, "decision": decision})
    };
    let mut w2 = worker(&lab, answer.clone()).await;
    // Not a stored request, not a cancel, or not its admitted command ID: refused.
    assert!(
        dispatch(
            &mut w2,
            1,
            cancel("question:other", json!("cancel"), "cancel-q1")
        )
        .await
        .is_err()
    );
    assert!(
        dispatch(
            &mut w2,
            2,
            cancel(&request_id, json!("accept"), "cancel-q1")
        )
        .await
        .is_err()
    );
    assert!(
        dispatch(&mut w2, 3, cancel(&request_id, json!("cancel"), "cmd-m2"))
            .await
            .is_err()
    );
    // A grant whose stored owner is another run: refused by the target's owner check.
    let mut wrong_owner = answer.clone();
    wrong_owner["questions"][0]["owner_run_id"] = json!("run:other:1");
    let mut w3 = worker(&lab, wrong_owner).await;
    assert!(
        dispatch(
            &mut w3,
            1,
            cancel(&request_id, json!("cancel"), "cancel-q1")
        )
        .await
        .is_err()
    );
    until_request(&lab, &request_id, true).await;
    // The answer cannot start while the earlier run is still active.
    assert!(
        dispatch(&mut w2, 4, dispatch_command("cmd-m2", "m2", "the answer"))
            .await
            .is_err()
    );
    // The exact cancel succeeds, once.
    dispatch(
        &mut w2,
        5,
        cancel(&request_id, json!("cancel"), "cancel-q1"),
    )
    .await
    .expect("cancel");
    until_request(&lab, &request_id, false).await;
    until_run(&lab, THREAD, "m1", "completed").await;
    // Then the answer goes out as a fresh run of its own.
    dispatch(&mut w2, 6, dispatch_command("cmd-m2", "m2", "the answer"))
        .await
        .expect("answer");
    until_run(&lab, THREAD, "m2", "completed").await;
    let p = projection(&mut w2, 7).await;
    assert_eq!(runs(&p).len(), 2, "{p}");
}

/// Question ends the turn: the first worker stops the asking run itself. A stored request
/// that the stop already settled needs no cancel, and a cancel of it changes nothing.
#[tokio::test(flavor = "current_thread")]
async fn a_question_whose_run_was_stopped_needs_no_cancel() {
    let lab = Lab::start().await;
    let mut w1 = worker(&lab, grant("m1", "question", true)).await;
    dispatch(&mut w1, 1, create_command())
        .await
        .expect("create");
    dispatch(&mut w1, 2, dispatch_command("cmd-m1", "m1", "question"))
        .await
        .expect("dispatch");
    let run = until_run(&lab, THREAD, "m1", "running").await;
    let request_id = format!("question:{}", run["id"].as_str().unwrap());
    until_request(&lab, &request_id, true).await;
    dispatch(&mut w1, 3, stop("stop-m1", &run["id"]))
        .await
        .expect("the turn ends");
    until_run(&lab, THREAD, "m1", "interrupted").await;
    until_request(&lab, &request_id, false).await;
    let mut answer = grant("m2", "the answer", false);
    answer["questions"] = json!([{"thread_id": THREAD, "request_id": request_id,
        "owner_run_id": run["id"], "cancel_command_id": "cancel-q1"}]);
    let mut w2 = worker(&lab, answer).await;
    let cancel = json!({"type": "runtime-request.respond", "commandId": "cancel-q1",
        "threadId": THREAD, "requestId": request_id, "decision": "cancel"});
    assert!(
        dispatch(&mut w2, 1, cancel).await.is_err(),
        "no longer pending"
    );
    dispatch(&mut w2, 2, dispatch_command("cmd-m2", "m2", "the answer"))
        .await
        .expect("answer");
    until_run(&lab, THREAD, "m2", "completed").await;
}

#[tokio::test(flavor = "current_thread")]
async fn a_worker_stops_only_the_run_of_its_own_message_once() {
    let lab = Lab::start().await;
    let mut w = worker(&lab, grant("m1", "hang", true)).await;
    dispatch(&mut w, 1, create_command()).await.expect("create");
    dispatch(&mut w, 2, dispatch_command("cmd-m1", "m1", "hang"))
        .await
        .expect("dispatch");
    let own = until_run(&lab, THREAD, "m1", "running").await;
    let mut held = stop("stop-m1", &own["id"]);
    held["holdQueue"] = json!(true);
    assert!(
        dispatch(&mut w, 3, held).await.is_err(),
        "never holds the queue"
    );
    assert!(
        dispatch(&mut w, 4, stop("cmd-m1", &own["id"]))
            .await
            .is_err(),
        "a stop uses only its own admitted command ID"
    );
    dispatch(&mut w, 5, stop("stop-m1", &own["id"]))
        .await
        .expect("own run stops");
    until_run(&lab, THREAD, "m1", "interrupted").await;
    assert!(
        dispatch(&mut w, 6, stop("stop-m1", &own["id"]))
            .await
            .is_err()
    );
}

/// The worker inherits item 4's fence: removing its Node edge ends its session.
#[tokio::test(flavor = "current_thread")]
async fn removing_the_workers_edge_ends_its_session() {
    let lab = Lab::start().await;
    let mut w = worker(&lab, grant("m1", "do it", true)).await;
    dispatch(&mut w, 1, create_command()).await.expect("create");
    let notice = lab.fake.remove_edge(12);
    lab.deliver(&notice);
    let ended = tokio::time::timeout(Duration::from_secs(2), async {
        while next(&mut w).await.is_some() {}
    })
    .await;
    assert!(ended.is_ok(), "the worker's socket stayed open");
}

/// A gate that is open, closed, or paused for its first `pauses` commits.
struct Gate {
    open: bool,
    pauses: std::sync::atomic::AtomicUsize,
}

impl Gate {
    fn new(open: bool) -> Self {
        Self {
            open,
            pauses: std::sync::atomic::AtomicUsize::new(0),
        }
    }
}

impl CommitGate for Gate {
    fn commit_if_open(&self, commit: &mut dyn FnMut()) -> conn_engine::CommitDecision {
        use std::sync::atomic::Ordering;
        if self.pauses.load(Ordering::SeqCst) > 0 {
            self.pauses.fetch_sub(1, Ordering::SeqCst);
            return conn_engine::CommitDecision::Paused;
        }
        if self.open {
            commit();
            conn_engine::CommitDecision::Committed
        } else {
            conn_engine::CommitDecision::Refused
        }
    }

    fn wait_until_open(&self) -> conn_provider::BoxFuture<'static, bool> {
        let open = self.open;
        Box::pin(async move { open })
    }
}

fn guard(rule: GuardRule) -> DispatchGuard {
    DispatchGuard {
        project_id: project_id(),
        rule,
    }
}

/// A revoked caller's write that reaches the commit is refused there, atomically: nothing is
/// written. A caller that disappears after its write started does not strand the run.
#[tokio::test(flavor = "current_thread")]
async fn commits_follow_the_fence_and_survive_the_caller() {
    let lab = Lab::start().await;
    let engine: Arc<dyn Engine> = lab.app.engine.clone().unwrap();
    let decode = |v: Value| conn_contract::from_json(v).unwrap();
    engine
        .dispatch_guarded(decode(create_command()), guard(GuardRule::NewThread), None)
        .await
        .expect("create");
    let closed: Arc<dyn CommitGate> = Arc::new(Gate::new(false));
    let refused = engine
        .dispatch_guarded(
            decode(dispatch_command("cmd-m1", "m1", "do it")),
            guard(GuardRule::ExclusiveStart),
            Some(closed),
        )
        .await;
    assert!(refused.is_err());
    let p = engine.get_thread_projection(THREAD.into()).await.unwrap();
    assert!(user_messages(&p).is_empty(), "nothing committed: {p}");
    // The caller drops its future after the first poll: the dispatch still commits and its
    // run still starts and completes.
    let open: Arc<dyn CommitGate> = Arc::new(Gate::new(true));
    let mut call = engine.dispatch_guarded(
        decode(dispatch_command("cmd-m1", "m1", "do it")),
        guard(GuardRule::ExclusiveStart),
        Some(open),
    );
    // Poll it once, then drop it.
    tokio::select! {
        biased;
        _ = &mut call => panic!("it should still be committing"),
        () = std::future::ready(()) => {}
    }
    drop(call);
    until_run(&lab, THREAD, "m1", "completed").await;
}

type ProjectionSuccess = conn_contract::rpc::orchestration::get_thread_projection::Success;
type ProjectionError = conn_contract::rpc::orchestration::get_thread_projection::Error;
type DispatchError = conn_contract::rpc::orchestration::dispatch_command::Error;

/// The failure inside an `Exit` the client receives.
fn typed_error(exit: &Value) -> Value {
    exit["cause"]
        .as_array()
        .and_then(|c| c.first())
        .map(|c| c["error"].clone())
        .unwrap_or_else(|| exit["cause"]["error"].clone())
}

#[tokio::test(flavor = "current_thread")]
async fn refusals_and_settlement_reads_decode_as_the_client_expects() {
    let lab = Lab::start().await;
    let earlier_thread = "reviewer-thread";
    let mut create = create_command();
    create["commandId"] = json!("person-create-r");
    create["threadId"] = json!(earlier_thread);
    person(&lab, create).await;
    let mut message = dispatch_command("pr1", "r1", "done");
    message["threadId"] = json!(earlier_thread);
    person(&lab, message).await;
    until_run(&lab, earlier_thread, "r1", "completed").await;
    let mut g = grant("m1", "do it", true);
    g["earlier"] = json!([{"thread_id": earlier_thread, "message_id": "r1", "text_sha256": sha("done"),
        "interrupt_command_id": "stop-r1"}]);
    let mut w = worker(&lab, g).await;
    let view = read(&mut w, 1, earlier_thread)
        .await
        .expect("settlement read");
    let decoded: Result<ProjectionSuccess, _> = conn_contract::from_json(view.clone());
    assert!(decoded.is_ok(), "{decoded:?}\n{view}");
    assert_eq!(view["thread"]["title"], "Earlier turn");
    assert!(view["thread"]["branch"].is_null() && view["thread"].get("tags").is_none());
    let refused = read(&mut w, 2, "another-thread").await.unwrap_err();
    let error: Result<ProjectionError, _> = conn_contract::from_json(typed_error(&refused));
    assert!(error.is_ok(), "{refused}");
    let refused = dispatch(&mut w, 3, dispatch_command("cmd-x", "x", "x"))
        .await
        .unwrap_err();
    let error: Result<DispatchError, _> = conn_contract::from_json(typed_error(&refused));
    assert!(error.is_ok(), "{refused}");
    // Another body under the frozen message ID: the read refuses instead of showing it.
    let mut wrong = grant("m1", "do it", true);
    wrong["earlier"] = json!([{"thread_id": earlier_thread, "message_id": "r1", "text_sha256": sha("other"),
        "interrupt_command_id": "stop-r1"}]);
    let mut w2 = worker(&lab, wrong).await;
    assert!(read(&mut w2, 1, earlier_thread).await.is_err());
}

#[tokio::test(flavor = "current_thread")]
async fn the_captured_attribution_is_frozen() {
    let lab = Lab::start().await;
    let mut w = worker(&lab, grant("m1", "do it", true)).await;
    dispatch(&mut w, 1, create_command()).await.expect("create");
    let mut message = dispatch_command("cmd-m1", "m1", "do it");
    message["createdBy"] = json!("system");
    message["creationSource"] = json!("server");
    assert!(dispatch(&mut w, 2, message).await.is_err());
}

#[tokio::test(flavor = "current_thread")]
async fn a_deleted_thread_id_is_never_taken_over_or_followed() {
    let lab = Lab::start().await;
    let mut w = worker(&lab, grant("m1", "do it", true)).await;
    dispatch(&mut w, 1, create_command()).await.expect("create");
    send(
        &mut w,
        json!({"_tag": "Request", "id": "9", "tag": "orchestration.subscribeThread",
               "payload": {"threadId": THREAD}, "headers": []}),
    )
    .await;
    let first = next(&mut w).await.expect("a first item");
    assert_eq!(first["_tag"], "Chunk", "{first}");
    person(
        &lab,
        json!({"type": "thread.delete", "commandId": "person-delete", "threadId": THREAD}),
    )
    .await;
    // The open subscription ends instead of following the ID.
    let ended = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let frame = next(&mut w).await.expect("socket open");
            if frame["_tag"] == "Exit" && frame["requestId"] == "9" {
                return frame;
            }
        }
    })
    .await
    .expect("the stream kept going");
    assert_ne!(ended["exit"]["_tag"], "Success", "{ended}");
    // A guarded create never takes over a used ID.
    let mut w2 = worker(&lab, grant("m1", "do it", true)).await;
    assert!(dispatch(&mut w2, 1, create_command()).await.is_err());
}

#[tokio::test(flavor = "current_thread")]
async fn a_queued_earlier_run_is_never_cancelled_by_a_stop() {
    let lab = Lab::start().await;
    let earlier_thread = "reviewer-thread";
    let mut create = create_command();
    create["commandId"] = json!("person-create-r");
    create["threadId"] = json!(earlier_thread);
    person(&lab, create).await;
    let on_earlier = |command_id: &str, message_id: &str, text: &str| {
        let mut command = dispatch_command(command_id, message_id, text);
        command["threadId"] = json!(earlier_thread);
        command
    };
    person(&lab, on_earlier("pr1", "r1", "hang")).await;
    until_run(&lab, earlier_thread, "r1", "running").await;
    person(&lab, on_earlier("pr2", "r2", "later")).await;
    let queued = until_run(&lab, earlier_thread, "r2", "queued").await;
    let mut g = grant("m1", "do it", true);
    g["earlier"] = json!([{"thread_id": earlier_thread, "message_id": "r2", "text_sha256": sha("later"),
        "interrupt_command_id": "stop-r2"}]);
    let mut w = worker(&lab, g).await;
    let mut stop_it = stop("stop-r2", &queued["id"]);
    stop_it["threadId"] = json!(earlier_thread);
    assert!(dispatch(&mut w, 1, stop_it).await.is_err());
    until_run(&lab, earlier_thread, "r2", "queued").await;
}

#[tokio::test(flavor = "current_thread")]
async fn a_thread_id_reused_after_deletion_is_never_read_or_written() {
    let lab = Lab::start().await;
    // A thread in another project, deleted, then created again with the same ID here.
    let mut foreign = create_command();
    foreign["commandId"] = json!("person-create-a");
    foreign["projectId"] = json!(conn_engine::SqliteEngine::project_id_for("/tmp/q"));
    person(&lab, foreign).await;
    person_sends(&lab, "old", "an old secret").await;
    until_run(&lab, THREAD, "old", "completed").await;
    person(
        &lab,
        json!({"type": "thread.delete", "commandId": "person-delete", "threadId": THREAD}),
    )
    .await;
    let mut again = create_command();
    again["commandId"] = json!("person-create-b");
    person(&lab, again).await;
    let mut w = worker(&lab, grant("m1", "do it", false)).await;
    assert!(
        read(&mut w, 1, THREAD).await.is_err(),
        "the old rows are never shown"
    );
    assert!(
        dispatch(&mut w, 2, dispatch_command("cmd-m1", "m1", "do it"))
            .await
            .is_err()
    );
}

/// T3's projection also lists the provider threads of the thread's subagents, which belong
/// to the child threads; a worker granted the parent never sees them.
#[test]
fn the_admitted_thread_shows_only_its_own_rows() {
    let projection = json!({
        "thread": {"id": THREAD, "projectId": "p"},
        "providerThreads": [
            {"id": "provider-thread:parent", "appThreadId": THREAD},
            {"id": "provider-thread:child", "appThreadId": "child-thread",
             "nativeThreadRef": {"nativeId": "secret"}},
        ],
        "messages": [{"id": "m1", "threadId": THREAD}],
        "subagents": [{"id": "s1", "threadId": THREAD, "childThreadId": "child-thread"}],
    });
    let view = super::own_rows(THREAD, projection);
    assert_eq!(
        view["providerThreads"].as_array().unwrap().len(),
        1,
        "{view}"
    );
    assert_eq!(view["providerThreads"][0]["appThreadId"], THREAD);
    assert_eq!(view["messages"].as_array().unwrap().len(), 1);
    assert_eq!(view["subagents"].as_array().unwrap().len(), 1);
}

#[tokio::test(flavor = "current_thread")]
async fn a_settlement_read_without_evidence_is_a_typed_refusal_and_modes_are_fixed() {
    let lab = Lab::start().await;
    let earlier_thread = "reviewer-thread";
    let mut create = create_command();
    create["commandId"] = json!("person-create-r");
    create["threadId"] = json!(earlier_thread);
    create["runtimeMode"] = json!("approval-required");
    person(&lab, create).await;
    let mut missing = grant("m1", "do it", true);
    missing["earlier"] = json!([{"thread_id": earlier_thread, "message_id": "absent",
        "text_sha256": sha("x"), "interrupt_command_id": "stop-x"}]);
    let mut w = worker(&lab, missing).await;
    let refused = read(&mut w, 1, earlier_thread).await.unwrap_err();
    let error: Result<ProjectionError, _> = conn_contract::from_json(typed_error(&refused));
    assert!(error.is_ok(), "{refused}");
    let mut message = dispatch_command("pr1", "r1", "done");
    message["threadId"] = json!(earlier_thread);
    person(&lab, message).await;
    until_run(&lab, earlier_thread, "r1", "completed").await;
    let mut g = grant("m1", "do it", true);
    g["earlier"] = json!([{"thread_id": earlier_thread, "message_id": "r1", "text_sha256": sha("done"),
        "interrupt_command_id": "stop-r1"}]);
    let mut w2 = worker(&lab, g).await;
    let view = read(&mut w2, 1, earlier_thread)
        .await
        .expect("settlement read");
    assert_eq!(
        view["thread"]["runtimeMode"], "full-access",
        "not the thread's own setting"
    );
    assert_eq!(view["thread"]["interactionMode"], "default");
}

#[tokio::test(flavor = "current_thread")]
async fn settlement_evidence_needs_the_plain_frozen_message_and_a_started_run() {
    let lab = Lab::start().await;
    let earlier_thread = "reviewer-thread";
    let mut create = create_command();
    create["commandId"] = json!("person-create-r");
    create["threadId"] = json!(earlier_thread);
    person(&lab, create).await;
    let on_earlier = |command_id: &str, message_id: &str, text: &str| {
        let mut command = dispatch_command(command_id, message_id, text);
        command["threadId"] = json!(earlier_thread);
        command
    };
    // The frozen ID and text, but sent with a sender: not the frozen message.
    let mut extra = on_earlier("pr1", "r1", "hang");
    extra["senderThreadId"] = json!("t-other");
    person(&lab, extra).await;
    let r1 = until_run(&lab, earlier_thread, "r1", "running").await;
    // A queued run, then the same cancelled while still queued.
    person(&lab, on_earlier("pr2", "r2", "later")).await;
    let r2 = until_run(&lab, earlier_thread, "r2", "queued").await;
    let mut g = grant("m1", "do it", true);
    g["earlier"] = json!([
        {"thread_id": earlier_thread, "message_id": "r1", "text_sha256": sha("hang"),
         "interrupt_command_id": "stop-r1"},
    ]);
    let mut w = worker(&lab, g).await;
    assert!(
        read(&mut w, 1, earlier_thread).await.is_err(),
        "not the frozen message"
    );
    let mut stop_r1 = stop("stop-r1", &r1["id"]);
    stop_r1["threadId"] = json!(earlier_thread);
    assert!(dispatch(&mut w, 2, stop_r1).await.is_err());
    until_run(&lab, earlier_thread, "r1", "running").await;
    let mut queued = grant("m1", "do it", true);
    queued["earlier"] = json!([
        {"thread_id": earlier_thread, "message_id": "r2", "text_sha256": sha("later"),
         "interrupt_command_id": "stop-r2"},
    ]);
    let mut w2 = worker(&lab, queued).await;
    assert!(
        read(&mut w2, 1, earlier_thread).await.is_err(),
        "a queued run is no evidence"
    );
    person(
        &lab,
        json!({"type": "run.interrupt", "commandId": "person-cancel-r2",
        "threadId": earlier_thread, "runId": r2["id"]}),
    )
    .await;
    until_run(&lab, earlier_thread, "r2", "cancelled").await;
    assert!(
        read(&mut w2, 2, earlier_thread).await.is_err(),
        "cancelled in the queue: no evidence"
    );
}

/// A pause at the commit is not a refusal: the engine waits, checks again, then commits.
#[tokio::test(flavor = "current_thread")]
async fn a_paused_commit_waits_and_then_commits() {
    let lab = Lab::start().await;
    let engine: Arc<dyn Engine> = lab.app.engine.clone().unwrap();
    let decode = |v: Value| conn_contract::from_json(v).unwrap();
    engine
        .dispatch_guarded(decode(create_command()), guard(GuardRule::NewThread), None)
        .await
        .expect("create");
    let gate = Gate::new(true);
    gate.pauses.store(2, std::sync::atomic::Ordering::SeqCst);
    let gate: Arc<dyn CommitGate> = Arc::new(gate);
    engine
        .dispatch_guarded(
            decode(dispatch_command("cmd-m1", "m1", "do it")),
            guard(GuardRule::ExclusiveStart),
            Some(gate),
        )
        .await
        .expect("committed after the pause");
    until_run(&lab, THREAD, "m1", "completed").await;
}

#[tokio::test(flavor = "current_thread")]
async fn a_stop_needs_the_captured_attribution() {
    let lab = Lab::start().await;
    let earlier_thread = "reviewer-thread";
    let mut create = create_command();
    create["commandId"] = json!("person-create-r");
    create["threadId"] = json!(earlier_thread);
    person(&lab, create).await;
    // Same ID and text, other attribution.
    let mut message = dispatch_command("pr1", "r1", "hang");
    message["threadId"] = json!(earlier_thread);
    message["createdBy"] = json!("system");
    message["creationSource"] = json!("server");
    person(&lab, message).await;
    let r1 = until_run(&lab, earlier_thread, "r1", "running").await;
    let mut g = grant("m1", "do it", true);
    g["earlier"] = json!([{"thread_id": earlier_thread, "message_id": "r1", "text_sha256": sha("hang"),
        "interrupt_command_id": "stop-r1"}]);
    let mut w = worker(&lab, g).await;
    let mut stop_r1 = stop("stop-r1", &r1["id"]);
    stop_r1["threadId"] = json!(earlier_thread);
    assert!(
        dispatch(&mut w, 1, stop_r1).await.is_err(),
        "another attribution"
    );
    assert!(read(&mut w, 2, earlier_thread).await.is_err());
    until_run(&lab, earlier_thread, "r1", "running").await;
}
