//! Live tests against the installed `codex` CLI and the user's own Codex sign-in. They spend
//! real model calls on the cheapest model, so they are `#[ignore]`:
//!
//! ```sh
//! cargo test -p conn-provider-codex live_ -- --ignored --test-threads=1 --nocapture
//! ```
//!
//! Each test works in a fresh temporary folder and deletes it afterwards. Codex keeps its
//! usual session log under `$CODEX_HOME/sessions`; no setting or credential is changed.

use std::time::Duration;

use conn_contract::{ProviderThread, from_json, to_json};
use conn_provider::{
    EnsureThreadInput, InterruptInput, OpenSessionInput, OpenedSession, Provider, ProviderEvent,
    RuntimePolicy, RuntimeRequestResponse, Session, TurnInput, TurnMessage,
};
use serde_json::{Value, json};
use tokio::sync::mpsc;

use crate::{CodexConfig, CodexProvider};

const MODEL: &str = "gpt-6-luna";
const TURN_TIMEOUT: Duration = Duration::from_secs(180);

struct Workspace(std::path::PathBuf);

impl Workspace {
    fn new(name: &str) -> Self {
        let path =
            std::env::temp_dir().join(format!("conn-codex-live-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&path).expect("create the test folder");
        Self(path)
    }
    fn cwd(&self) -> String {
        self.0.to_string_lossy().into_owned()
    }
}

impl Drop for Workspace {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn policy(mode: &str, cwd: &str) -> RuntimePolicy {
    from_json(json!({"runtimeMode": mode, "interactionMode": "default", "cwd": cwd}))
        .expect("policy decodes")
}

fn selection() -> conn_contract::ModelSelection {
    from_json(json!({"instanceId": "codex", "model": MODEL})).expect("selection decodes")
}

fn turn(thread: &ProviderThread, n: u32, mode: &str, cwd: &str, text: &str) -> TurnInput {
    TurnInput {
        native_thread_has_turns: None,
        restart_continuation_of_run_id: None,
        app_context: vec![],
        app_thread: from_json(json!({
            "createdBy": "user", "creationSource": "web", "id": "live-thread", "projectId": "p",
            "title": "live", "providerInstanceId": "codex", "modelSelection": to_json(&selection()),
            "runtimeMode": mode, "interactionMode": "default", "branch": null, "worktreePath": null,
            "activeProviderThreadId": null,
            "lineage": {"parentThreadId": null, "relationshipToParent": null, "rootThreadId": "live-thread"},
            "forkedFrom": null, "createdAt": "x", "updatedAt": "x", "archivedAt": null,
        }))
        .expect("app thread decodes"),
        thread_id: "live-thread".into(),
        run_id: format!("run-{n}").as_str().into(),
        run_ordinal: n,
        provider_turn_ordinal: n,
        attempt_id: format!("attempt-{n}").as_str().into(),
        root_node_id: format!("node-{n}").as_str().into(),
        provider_thread: thread.clone(),
        message: TurnMessage {
            created_by: conn_contract::OrchestrationV2Actor::User,
            creation_source: conn_contract::OrchestrationV2CreationSource::Web,
            scheduled_task_id: None,
            sender_thread_id: None,
            message_id: format!("message-{n}").as_str().into(),
            text: text.into(),
            attachments: vec![],
        },
        model_selection: selection(),
        runtime_policy: policy(mode, cwd),
    }
}

async fn open(
    mode: &str,
    cwd: &str,
) -> (
    CodexProvider,
    Box<dyn Session>,
    mpsc::Receiver<ProviderEvent>,
    ProviderThread,
) {
    let provider = CodexProvider::detect("codex".into(), CodexConfig::default())
        .expect("the codex CLI is installed");
    let OpenedSession {
        session, events, ..
    } = provider
        .open_session(OpenSessionInput {
            thread_id: "live-thread".into(),
            provider_session_id: "live-session".into(),
            model_selection: selection(),
            runtime_policy: policy(mode, cwd),
            resume_from_session: None,
            mcp_servers: vec![],
            host: None,
        })
        .await
        .expect("session opens");
    let thread = session
        .ensure_thread(EnsureThreadInput {
            thread_id: "live-thread".into(),
            title: None,
            model_selection: selection(),
            runtime_policy: policy(mode, cwd),
            existing_provider_thread: None,
        })
        .await
        .expect("thread/start succeeds");
    (provider, session, events, thread)
}

/// Events until `stop` returns true, or the turn timeout.
async fn until(
    events: &mut mpsc::Receiver<ProviderEvent>,
    stop: impl Fn(&Value) -> bool,
) -> Vec<Value> {
    let mut seen = Vec::new();
    let read = async {
        while let Some(event) = events.recv().await {
            let value = serde_json::to_value(event).expect("events serialize");
            let done = stop(&value);
            seen.push(value);
            if done {
                return;
            }
        }
    };
    let finished = tokio::time::timeout(TURN_TIMEOUT, read).await.is_ok();
    assert!(
        finished,
        "no matching event within {TURN_TIMEOUT:?}; saw {} events",
        seen.len()
    );
    seen
}

fn terminal(seen: &[Value]) -> &Value {
    seen.last().expect("at least the terminal event")
}

fn rss_kib(pid: u32) -> Option<u64> {
    let out = std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &pid.to_string()])
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout).trim().parse().ok()
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "spends a real Codex turn"]
async fn live_codex_turn() {
    let dir = Workspace::new("turn");
    let (provider, session, mut events, thread) = open("full-access", &dir.cwd()).await;
    session
        .start_turn(turn(
            &thread,
            1,
            "full-access",
            &dir.cwd(),
            "Reply with exactly: pong",
        ))
        .await
        .expect("turn/start succeeds");
    let seen = until(&mut events, |e| e["type"] == "turn.terminal").await;
    let text: Vec<&str> = seen
        .iter()
        .filter(|e| e["type"] == "message.updated")
        .filter_map(|e| e["message"]["text"].as_str())
        .collect();
    eprintln!("terminal: {}\nassistant: {text:?}", terminal(&seen));
    if let Some(pid) = provider.app_server_pid() {
        eprintln!(
            "idle codex app-server pid {pid}: rss {:?} KiB",
            rss_kib(pid)
        );
    }
    assert_eq!(
        terminal(&seen)["status"],
        "completed",
        "{}",
        terminal(&seen)
    );
    assert!(text.iter().any(|t| t.contains("pong")), "{text:?}");
    session.close().await;
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "spends real Codex turns"]
async fn live_codex_approval_then_interrupt() {
    let dir = Workspace::new("approval");
    let mode = "approval-required";
    let (_provider, session, mut events, thread) = open(mode, &dir.cwd()).await;

    session
        .start_turn(turn(
            &thread,
            1,
            mode,
            &dir.cwd(),
            "Run this shell command and nothing else: touch approved.txt",
        ))
        .await
        .expect("turn/start succeeds");
    let seen = until(&mut events, |e| {
        e["type"] == "turn.terminal"
            || (e["type"] == "runtime_request.updated"
                && e["runtimeRequest"]["status"] == "pending")
    })
    .await;
    let last = terminal(&seen);
    assert_eq!(
        last["type"], "runtime_request.updated",
        "no approval was asked: {last}"
    );
    eprintln!("approval: {}", last["runtimeRequest"]["kind"]);
    session
        .respond_to_runtime_request(RuntimeRequestResponse {
            request_id: from_json(last["runtimeRequest"]["id"].clone()).expect("request id"),
            decision: Some(from_json(json!("accept")).expect("decision")),
            feedback: None,
            answers: None,
        })
        .await
        .expect("the reply is written");
    let seen = until(&mut events, |e| e["type"] == "turn.terminal").await;
    eprintln!("first terminal: {}", terminal(&seen));
    assert_eq!(terminal(&seen)["status"], "completed");
    assert!(
        dir.0.join("approved.txt").exists(),
        "the approved command ran"
    );

    session
        .start_turn(turn(
            &thread,
            2,
            "full-access",
            &dir.cwd(),
            "Run this shell command and wait for it: sleep 60",
        ))
        .await
        .expect("turn/start succeeds");
    let seen = until(&mut events, |e| {
        e["type"] == "turn.terminal"
            || (e["type"] == "turn_item.updated" && e["turnItem"]["type"] == "command_execution")
    })
    .await;
    let provider_turn = seen
        .iter()
        .find_map(|e| e["providerTurn"]["id"].as_str())
        .expect("the turn registered")
        .to_owned();
    assert_ne!(
        terminal(&seen)["type"],
        "turn.terminal",
        "the turn ended before the command"
    );
    session
        .interrupt_turn(InterruptInput {
            provider_thread: thread.clone(),
            provider_turn_id: provider_turn.as_str().into(),
        })
        .await
        .expect("interrupt succeeds");
    let seen = until(&mut events, |e| e["type"] == "turn.terminal").await;
    eprintln!("second terminal: {}", terminal(&seen));
    assert_eq!(terminal(&seen)["status"], "interrupted");
    session.close().await;
}

/// A stand-in `codex app-server` that answers the start's requests and logs every method it
/// gets (`turn/interrupt` with its turn id). `HOLD` is a method it never answers. The first
/// `turn/start` behaves as `MODE` says, after `DELAY` ms:
///
/// - `answer`: answers with turn `turn-late`, then sends a message of that turn;
/// - `started`: sends only `turn/started` for `turn-late`;
/// - `silent`: sends nothing.
///
/// `turn/interrupt` of `turn-late` ends it (`turn/completed`, interrupted). Every later
/// `turn/start` runs `turn-next` to the end with the text "next". No model.
const FAKE_CODEX: &str = r#"#!/usr/bin/env node
const fs = require("node:fs");
const [LOG, HOLD, MODE, DELAY] = [__LOG__, __HOLD__, __MODE__, __DELAY__];
const write = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const answers = {
  initialize: { userAgent: "fake-codex/0.0.0" },
  "thread/start": { thread: { id: "thr-fake", createdAt: 0, updatedAt: 0 }, model: "m" },
  "config/read": { config: {} },
};
const turn = (id) => ({ id, status: "inProgress", items: [], startedAt: null });
let starts = 0;
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === undefined) return;
  const turnId = msg.method === "turn/interrupt" ? ` ${msg.params.turnId}` : "";
  fs.appendFileSync(LOG, `${msg.id === undefined ? "notify " : ""}${msg.method}${turnId}\n`);
  if (msg.id === undefined || msg.method === HOLD) return;
  if (msg.method === "turn/start" && starts++ === 0) {
    setTimeout(() => {
      if (MODE === "answer") {
        write({ id: msg.id, result: { turn: turn("turn-late") } });
        write({ method: "item/completed", params: { threadId: "thr-fake", turnId: "turn-late",
          item: { type: "agentMessage", id: "m-late", text: "leaked", phase: "final_answer" } } });
      } else if (MODE === "started") {
        write({ method: "turn/started", params: { threadId: "thr-fake", turn: turn("turn-late") } });
      }
    }, DELAY);
    return;
  }
  if (msg.method === "turn/start") {
    write({ id: msg.id, result: { turn: turn("turn-next") } });
    write({ method: "item/completed", params: { threadId: "thr-fake", turnId: "turn-next",
      item: { type: "agentMessage", id: "m-next", text: "next", phase: "final_answer" } } });
    write({ method: "turn/completed", params: { threadId: "thr-fake",
      turn: { id: "turn-next", status: "completed", completedAt: 3 } } });
    return;
  }
  write({ id: msg.id, result: answers[msg.method] ?? {} });
  if (msg.method === "turn/interrupt" && msg.params.turnId === "turn-late") {
    write({ method: "turn/completed", params: { threadId: "thr-fake",
      turn: { id: "turn-late", status: "interrupted", completedAt: 3 } } });
  }
});
process.stdin.on("end", () => process.exit(0));
"#;

/// A session on [`FAKE_CODEX`], its events, its thread, and the method log.
struct Fake {
    dir: Workspace,
    provider: CodexProvider,
    session: Box<dyn Session>,
    events: mpsc::Receiver<ProviderEvent>,
    thread: ProviderThread,
}

impl Fake {
    async fn open(
        name: &str,
        hold: &str,
        mode: &str,
        delay_ms: u64,
        abandoned_start_timeout: Duration,
    ) -> Option<Self> {
        if std::process::Command::new("node")
            .arg("--version")
            .output()
            .map_or(true, |o| !o.status.success())
        {
            eprintln!("skipped: no node");
            return None;
        }
        let dir = Workspace::new(name);
        let binary = dir.0.join("codex");
        conn_support::test_util::executable(
            &binary,
            &FAKE_CODEX
                .replace(
                    "__LOG__",
                    &serde_json::to_string(&dir.0.join("codex.log")).unwrap(),
                )
                .replace("__HOLD__", &serde_json::to_string(hold).unwrap())
                .replace("__MODE__", &serde_json::to_string(mode).unwrap())
                .replace("__DELAY__", &delay_ms.to_string()),
        )
        .unwrap();
        let config = CodexConfig {
            binary,
            home_path: Some(dir.0.join("codex-home")),
            abandoned_start_timeout,
            ..CodexConfig::default()
        };
        let provider = CodexProvider::new("codex".into(), config);
        let cwd = dir.cwd();
        let OpenedSession {
            session, events, ..
        } = provider
            .open_session(OpenSessionInput {
                thread_id: "live-thread".into(),
                provider_session_id: "live-session".into(),
                model_selection: selection(),
                runtime_policy: policy("full-access", &cwd),
                resume_from_session: None,
                mcp_servers: vec![],
                host: None,
            })
            .await
            .expect("session opens");
        let thread = session
            .ensure_thread(EnsureThreadInput {
                thread_id: "live-thread".into(),
                title: None,
                model_selection: selection(),
                runtime_policy: policy("full-access", &cwd),
                existing_provider_thread: None,
            })
            .await
            .expect("thread/start answers");
        Some(Self {
            dir,
            provider,
            session,
            events,
            thread,
        })
    }

    fn methods(&self) -> Vec<String> {
        std::fs::read_to_string(self.dir.0.join("codex.log"))
            .unwrap_or_default()
            .lines()
            .map(str::to_owned)
            .collect()
    }

    /// Starts turn `n` and abandons it once the fake logs `hold`, as the engine does on Stop.
    /// The start must end at once, with an error.
    async fn start_and_abandon(&self, n: u32, hold: &str) {
        let input = turn(&self.thread, n, "full-access", &self.dir.cwd(), "hello");
        let run_id = input.run_id.clone();
        let both = async {
            tokio::join!(self.session.start_turn(input), async {
                for _ in 0..500 {
                    if self.methods().last().map(String::as_str) == Some(hold) {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
                self.session
                    .abandon_turn_start(conn_provider::AbandonTurnStartInput {
                        thread_id: "live-thread".into(),
                        run_id: run_id.clone(),
                    })
                    .await;
            })
        };
        let (started, ()) = tokio::time::timeout(Duration::from_secs(5), both)
            .await
            .unwrap_or_else(|_| panic!("{hold}: the abandoned start did not end"));
        assert!(started.is_err(), "{hold}: {started:?}");
    }

    /// Every event so far, as JSON.
    fn drain(&mut self) -> Vec<Value> {
        let mut seen = Vec::new();
        while let Ok(event) = self.events.try_recv() {
            seen.push(to_json(&event));
        }
        seen
    }
}

/// No event may come from the abandoned turn: no provider turn, no message, no subagent.
fn assert_no_late_turn(events: &[Value]) {
    for event in events {
        let text = event.to_string();
        assert!(
            !text.contains("turn-late"),
            "an event of the abandoned turn: {text}"
        );
        assert!(
            !text.contains("leaked"),
            "a message of the abandoned turn: {text}"
        );
        assert_ne!(event["type"], "subagent.updated", "{text}");
        assert_ne!(event["type"], "app_thread.created", "{text}");
    }
}

/// Stop before `turn/start` went out: as T3's interrupted `startTurn`, ours stops at the
/// request it waits on and sends nothing more. The session stays usable. No CLI, no model.
#[tokio::test(flavor = "current_thread")]
async fn an_abandoned_start_before_turn_start_sends_nothing_more() {
    let Some(mut fake) = Fake::open(
        "abandon-config-read",
        "config/read",
        "silent",
        0,
        Duration::from_secs(60),
    )
    .await
    else {
        return;
    };
    fake.start_and_abandon(1, "config/read").await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    let seen = fake.methods();
    assert_eq!(
        seen.last().map(String::as_str),
        Some("config/read"),
        "{seen:?}"
    );
    assert!(!seen.iter().any(|m| m.starts_with("turn/")), "{seen:?}");
    assert_no_late_turn(&fake.drain());
    fake.session.close().await;
}

/// Stop while `turn/start` waits for its answer, and the answer comes later: the turn it
/// names gets `turn/interrupt`, and nothing of it becomes an event (Nick, 2026-11-15; T3
/// leaves the turn running).
#[tokio::test(flavor = "current_thread")]
async fn a_late_answer_to_an_abandoned_start_interrupts_its_turn() {
    let Some(mut fake) =
        Fake::open("abandon-answer", "", "answer", 300, Duration::from_secs(60)).await
    else {
        return;
    };
    fake.start_and_abandon(1, "turn/start").await;
    assert!(
        !fake
            .methods()
            .iter()
            .any(|m| m.starts_with("turn/interrupt")),
        "nothing goes before Codex names the turn"
    );
    for _ in 0..200 {
        if fake
            .methods()
            .iter()
            .any(|m| m == "turn/interrupt turn-late")
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let seen = fake.methods();
    assert_eq!(
        seen.iter()
            .filter(|m| m.starts_with("turn/interrupt"))
            .collect::<Vec<_>>(),
        ["turn/interrupt turn-late"],
        "{seen:?}"
    );
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_no_late_turn(&fake.drain());
    fake.session.close().await;
}

/// Only `turn/started` comes for the abandoned start: that turn gets `turn/interrupt`, and it
/// is neither a new run nor a subagent turn (T3 takes it for one, `rememberSubagentTurnStarted`).
#[tokio::test(flavor = "current_thread")]
async fn a_turn_started_for_an_abandoned_start_is_interrupted() {
    let Some(mut fake) = Fake::open(
        "abandon-started",
        "",
        "started",
        300,
        Duration::from_secs(60),
    )
    .await
    else {
        return;
    };
    fake.start_and_abandon(1, "turn/start").await;
    for _ in 0..200 {
        if fake
            .methods()
            .iter()
            .any(|m| m == "turn/interrupt turn-late")
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let seen = fake.methods();
    assert_eq!(
        seen.iter()
            .filter(|m| m.starts_with("turn/interrupt"))
            .collect::<Vec<_>>(),
        ["turn/interrupt turn-late"],
        "{seen:?}"
    );
    // The next turn starts once the stopped one ended, and is the run's own.
    let next = turn(&fake.thread, 2, "full-access", &fake.dir.cwd(), "again");
    tokio::time::timeout(Duration::from_secs(5), fake.session.start_turn(next))
        .await
        .expect("the next start does not wait out the answer's limit")
        .expect("the next turn starts");
    let events = until(&mut fake.events, |e| e["type"] == "turn.terminal").await;
    assert_eq!(events.last().unwrap()["status"], "completed");
    assert_no_late_turn(&events);
    fake.session.close().await;
}

/// Nothing ever comes for the abandoned start: nothing is sent, and the wait is bounded (here
/// 300 ms in place of 60 s); then the next turn starts and nothing is kept.
#[tokio::test(flavor = "current_thread")]
async fn an_abandoned_start_that_never_answers_sends_nothing_and_ends() {
    let Some(mut fake) = Fake::open(
        "abandon-silent",
        "",
        "silent",
        0,
        Duration::from_millis(300),
    )
    .await
    else {
        return;
    };
    fake.start_and_abandon(1, "turn/start").await;
    let begun = std::time::Instant::now();
    let next = turn(&fake.thread, 2, "full-access", &fake.dir.cwd(), "again");
    tokio::time::timeout(Duration::from_secs(5), fake.session.start_turn(next))
        .await
        .expect("the wait is bounded")
        .expect("the next turn starts");
    assert!(
        begun.elapsed() >= Duration::from_millis(200),
        "it waited for the answer first"
    );
    let events = until(&mut fake.events, |e| e["type"] == "turn.terminal").await;
    assert_eq!(events.last().unwrap()["status"], "completed");
    let seen = fake.methods();
    assert!(
        !seen.iter().any(|m| m.starts_with("turn/interrupt")),
        "{seen:?}"
    );
    assert_eq!(
        seen.iter().filter(|m| *m == "turn/start").count(),
        2,
        "{seen:?}"
    );
    assert_no_late_turn(&events);
    fake.session.close().await;
}

/// The next turn is sent before the late answer comes: it waits until the abandoned turn
/// is stopped and ended, so the late turn's frames never land in it.
#[tokio::test(flavor = "current_thread")]
async fn the_next_turn_waits_for_an_abandoned_start_that_reached_codex() {
    let Some(mut fake) =
        Fake::open("abandon-next", "", "answer", 500, Duration::from_secs(60)).await
    else {
        return;
    };
    fake.start_and_abandon(1, "turn/start").await;
    let next = turn(&fake.thread, 2, "full-access", &fake.dir.cwd(), "again");
    tokio::time::timeout(Duration::from_secs(5), fake.session.start_turn(next))
        .await
        .expect("the next start ends")
        .expect("the next turn starts");
    let events = until(&mut fake.events, |e| e["type"] == "turn.terminal").await;
    assert_eq!(events.last().unwrap()["status"], "completed");
    assert_no_late_turn(&events);
    let seen = fake.methods();
    let interrupt = seen.iter().position(|m| m == "turn/interrupt turn-late");
    let second = seen.iter().rposition(|m| m == "turn/start");
    assert!(
        interrupt.is_some() && interrupt < second,
        "the late turn is stopped before the next starts: {seen:?}"
    );
    assert!(
        events.iter().any(|e| e.to_string().contains("\"next\"")),
        "the next turn's own message"
    );
    fake.session.close().await;
}

/// The session closes before the late answer: close does not wait for it, the last session
/// stops the process, and nothing more is sent or shown.
#[tokio::test(flavor = "current_thread")]
async fn closing_the_session_ends_an_abandoned_start() {
    let Some(mut fake) =
        Fake::open("abandon-close", "", "answer", 500, Duration::from_secs(60)).await
    else {
        return;
    };
    fake.start_and_abandon(1, "turn/start").await;
    tokio::time::timeout(Duration::from_secs(5), fake.session.close())
        .await
        .expect("close does not wait for the answer");
    assert_eq!(
        fake.provider.app_server_pid(),
        None,
        "the last session stopped the process"
    );
    tokio::time::sleep(Duration::from_millis(700)).await;
    let seen = fake.methods();
    assert!(
        !seen.iter().any(|m| m.starts_with("turn/interrupt")),
        "{seen:?}"
    );
    assert_no_late_turn(&fake.drain());
}
