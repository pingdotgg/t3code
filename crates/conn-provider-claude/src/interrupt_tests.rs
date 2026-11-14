//! Interrupt as `ClaudeAdapterV2.interruptTurn` does it, against a fake SDK host: `interrupt`,
//! then `close`, then a wait for the CLI to exit; the next turn starts only after that, in a
//! new query that resumes. Needs `node`; skipped without it. No CLI, no model.

use std::{path::Path, time::Duration};

use conn_provider::{InterruptInput, ProviderError, Session};
use tokio::sync::mpsc;

use crate::helper::{Helper, HelperCommand, claude_host};
use crate::live_tests::{Scratch, is_terminal, new_thread, turn, until};
use crate::{ClaudeConfig, ClaudeSession};

/// A host that answers every request and logs the commands it gets. With `exit_on_close`, a
/// `close` ends the session 300 ms later, as an SDK query ends when its CLI exits; without
/// it, the CLI never exits.
const FAKE_HOST: &str = r#"
import * as fs from "node:fs";
import { createInterface } from "node:readline";
const [LOG, EXIT_ON_CLOSE, FN_DELAY] = [__LOG__, __EXIT__, __DELAY__];
const log = (text) => fs.appendFileSync(LOG, `${text}\n`);
const write = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const reply = (id, value) => write({ ch: "reply", id, ok: true, value });
const sessions = new Map();
write({ ch: "host", t: "ready", protocol: 1, node: process.versions.node });
createInterface({ input: process.stdin }).on("line", (line) => {
  const cmd = JSON.parse(line);
  switch (cmd.t) {
    case "open":
      sessions.set(cmd.sessionId, { driver: cmd.driver, instanceId: cmd.instanceId, sessionId: cmd.sessionId });
      log(`open resume=${cmd.options.resume ?? "-"}`);
      break;
    case "input":
      log("input");
      reply(cmd.id, null);
      break;
    case "call":
      log(`call ${cmd.method}`);
      reply(cmd.id, null);
      break;
    case "fn":
      log(`fn ${cmd.name}`);
      setTimeout(
        () => reply(cmd.id, cmd.name === "resolveSettings" ? { effective: {}, provenance: {}, sources: [] } : null),
        FN_DELAY,
      );
      break;
    case "close": {
      log("close");
      const session = sessions.get(cmd.sessionId);
      if (EXIT_ON_CLOSE && session !== undefined)
        setTimeout(() => {
          log("end");
          write({ ch: "sdk", t: "end", ...session });
        }, 300);
      break;
    }
    case "shutdown":
      process.exit(0);
  }
});
process.stdin.on("end", () => process.exit(0));
"#;

fn node_available() -> bool {
    std::process::Command::new("node")
        .arg("--version")
        .output()
        .is_ok_and(|o| o.status.success())
}

fn fake_host(dir: &Path, exit_on_close: bool) -> (Helper, std::path::PathBuf) {
    fake_host_with_delay(dir, exit_on_close, 0)
}

/// `fn_delay_ms` holds each function reply, as a cold SDK host holds `resolveSettings` while
/// it loads the SDK.
fn fake_host_with_delay(
    dir: &Path,
    exit_on_close: bool,
    fn_delay_ms: u64,
) -> (Helper, std::path::PathBuf) {
    let log = dir.join("host.log");
    let script = dir.join("fake-host.mjs");
    let text = FAKE_HOST
        .replace("__LOG__", &serde_json::to_string(&log).unwrap())
        .replace("__EXIT__", if exit_on_close { "true" } else { "false" })
        .replace("__DELAY__", &fn_delay_ms.to_string());
    std::fs::write(&script, text).unwrap();
    (
        claude_host(HelperCommand::from_path(&script), "claudeAgent"),
        log,
    )
}

fn session(helper: &Helper) -> (ClaudeSession, mpsc::Receiver<conn_provider::ProviderEvent>) {
    let (tx, events) = mpsc::channel(crate::session::EVENT_CAPACITY);
    let session = ClaudeSession::open(
        "provider-session-interrupt".into(),
        "claudeAgent",
        ClaudeConfig::default(),
        helper.clone(),
        tx,
        vec![],
    );
    (session, events)
}

async fn running_turn_id(events: &mut mpsc::Receiver<conn_provider::ProviderEvent>) -> String {
    let seen = until(events, |e| e["type"] == "provider_turn.updated").await;
    seen.last().unwrap()["providerTurn"]["id"]
        .as_str()
        .unwrap()
        .to_string()
}

#[tokio::test(flavor = "current_thread")]
async fn interrupt_closes_the_query_and_the_next_turn_resumes_after_the_exit() {
    if !node_available() {
        eprintln!("skipped: no node");
        return;
    }
    let scratch = Scratch::new("interrupt-close");
    let (helper, log) = fake_host(&scratch.0, true);
    let (session, mut events) = session(&helper);
    let cwd = scratch.cwd();
    let thread = new_thread(&session, "full-access", &cwd).await;
    session
        .start_turn(turn(1, &thread, "one", "full-access", &cwd))
        .await
        .unwrap();
    let turn_id = running_turn_id(&mut events).await;

    // The next turn is sent while the Stop runs, as T3's outbox queues it behind the Stop.
    let (interrupted, started) = tokio::join!(
        session.interrupt_turn(InterruptInput {
            provider_thread: thread.clone(),
            provider_turn_id: turn_id.as_str().into(),
        }),
        session.start_turn(turn(2, &thread, "two", "full-access", &cwd)),
    );
    interrupted.unwrap();
    started.unwrap();
    let seen = until(&mut events, is_terminal).await;
    assert_eq!(seen.last().unwrap()["status"], "interrupted");

    let lines: Vec<String> = std::fs::read_to_string(&log)
        .unwrap()
        .lines()
        .map(str::to_string)
        .collect();
    let at = |line: &str| lines.iter().position(|l| l == line);
    let opens: Vec<&String> = lines.iter().filter(|l| l.starts_with("open ")).collect();
    assert_eq!(opens.len(), 2, "{lines:?}");
    assert_eq!(opens.first().map(|l| l.as_str()), Some("open resume=-"));
    assert!(
        opens.get(1).is_some_and(|l| l.as_str() != "open resume=-"),
        "turn 2 resumes: {lines:?}"
    );
    let (interrupt, close, end) = (at("call interrupt"), at("close"), at("end"));
    let second_open = lines.iter().rposition(|l| l.starts_with("open "));
    assert!(
        interrupt < close && close < end && end < second_open,
        "interrupt, close, exit, then the new query: {lines:?}"
    );
    session.close().await;
}

#[tokio::test(flavor = "current_thread")]
async fn interrupt_times_out_when_the_cli_does_not_exit() {
    if !node_available() {
        eprintln!("skipped: no node");
        return;
    }
    let scratch = Scratch::new("interrupt-timeout");
    let (helper, _log) = fake_host(&scratch.0, false);
    let (session, mut events) = session(&helper);
    let session = session.with_stop_confirm_timeout(Duration::from_millis(300));
    let cwd = scratch.cwd();
    let thread = new_thread(&session, "full-access", &cwd).await;
    session
        .start_turn(turn(1, &thread, "one", "full-access", &cwd))
        .await
        .unwrap();
    let turn_id = running_turn_id(&mut events).await;
    let result = session
        .interrupt_turn(InterruptInput {
            provider_thread: thread.clone(),
            provider_turn_id: turn_id.as_str().into(),
        })
        .await;
    assert!(
        matches!(
            result,
            Err(ProviderError::InterruptTimeout { timeout_ms: 300 })
        ),
        "{result:?}"
    );
    // The turn stays open: the agent may still run, and the user decides with Force stop.
    assert!(session.live_query().is_some());
    while let Ok(event) = events.try_recv() {
        let value = serde_json::to_value(&event).unwrap();
        assert!(!is_terminal(&value), "the turn ended: {value}");
    }
    // Stopping the host ends the query; the turn then ends as interrupted.
    helper.stop().await;
    let seen = until(&mut events, is_terminal).await;
    assert_eq!(seen.last().unwrap()["status"], "interrupted");
}

/// T3 emits the provider turn right after `query()`. A cold SDK host holds `resolveSettings`
/// (here 1.5 s); the turn must show as running before that, and the host must still get the
/// same commands in the same order: `resolveSettings`, then `open`, then the prompt.
#[tokio::test(flavor = "current_thread")]
async fn a_cold_start_shows_the_turn_before_the_host_answers() {
    if !node_available() {
        eprintln!("skipped: no node");
        return;
    }
    let scratch = Scratch::new("cold-start-turn");
    let (helper, log) = fake_host_with_delay(&scratch.0, true, 1_500);
    let (session, mut events) = session(&helper);
    let cwd = scratch.cwd();
    let thread = new_thread(&session, "full-access", &cwd).await;
    let started = std::time::Instant::now();
    let (result, shown_after) = tokio::join!(
        async {
            let result = session
                .start_turn(turn(1, &thread, "one", "full-access", &cwd))
                .await;
            (result, started.elapsed())
        },
        async {
            let seen = until(&mut events, |e| e["type"] == "provider_turn.updated").await;
            assert_eq!(seen.last().unwrap()["providerTurn"]["status"], "running");
            started.elapsed()
        },
    );
    let (result, returned_after) = result;
    result.unwrap();
    assert!(
        shown_after < Duration::from_millis(1_000)
            && returned_after >= Duration::from_millis(1_400),
        "the turn showed after {shown_after:?}, the start returned after {returned_after:?}"
    );
    let lines: Vec<String> = std::fs::read_to_string(&log)
        .unwrap()
        .lines()
        .map(str::to_string)
        .collect();
    assert_eq!(
        lines,
        ["fn resolveSettings", "open resume=-", "input"],
        "the host sees what it saw before"
    );
    session.close().await;
}

/// A turn opened before its query fails when the query cannot start, and the start returns
/// the error.
#[tokio::test(flavor = "current_thread")]
async fn a_cold_start_that_cannot_open_fails_the_early_turn() {
    let scratch = Scratch::new("cold-start-fail");
    let helper = claude_host(
        HelperCommand::from_path(&scratch.0.join("missing-host.mjs")),
        "claudeAgent",
    );
    let (session, mut events) = session(&helper);
    let cwd = scratch.cwd();
    let thread = new_thread(&session, "approval-required", &cwd).await;
    let result = session
        .start_turn(turn(1, &thread, "one", "approval-required", &cwd))
        .await;
    assert!(result.is_err(), "{result:?}");
    let seen = until(&mut events, is_terminal).await;
    assert_eq!(seen.last().unwrap()["status"], "failed");
    assert!(
        seen.iter()
            .any(|e| e["type"] == "provider_turn.updated"
                && e["providerTurn"]["status"] == "running")
    );
}

/// The engine steers once the provider turn runs; on a cold start that is before the query
/// exists. The steer waits for the start and then reaches the query after the prompt.
#[tokio::test(flavor = "current_thread")]
async fn a_steer_during_a_cold_start_waits_for_the_query() {
    if !node_available() {
        eprintln!("skipped: no node");
        return;
    }
    let scratch = Scratch::new("cold-start-steer");
    let (helper, log) = fake_host_with_delay(&scratch.0, true, 800);
    let (session, mut events) = session(&helper);
    let cwd = scratch.cwd();
    let thread = new_thread(&session, "full-access", &cwd).await;
    let (started, steered) = tokio::join!(
        session.start_turn(turn(1, &thread, "one", "full-access", &cwd)),
        async {
            let turn_id = running_turn_id(&mut events).await;
            session
                .steer_turn(conn_provider::SteerInput {
                    thread_id: "thread-live".into(),
                    run_id: "run-1".into(),
                    provider_thread: thread.clone(),
                    provider_turn_id: turn_id.as_str().into(),
                    message: conn_provider::TurnMessage {
                        created_by: conn_contract::OrchestrationV2Actor::User,
                        creation_source: conn_contract::OrchestrationV2CreationSource::Web,
                        scheduled_task_id: None,
                        sender_thread_id: None,
                        message_id: "message-steer".into(),
                        text: "two".into(),
                        attachments: vec![],
                    },
                    model_selection: None,
                })
                .await
        },
    );
    started.unwrap();
    steered.unwrap();
    let lines: Vec<String> = std::fs::read_to_string(&log)
        .unwrap()
        .lines()
        .map(str::to_string)
        .collect();
    assert_eq!(
        lines,
        ["fn resolveSettings", "open resume=-", "input", "input"]
    );
    session.close().await;
}
