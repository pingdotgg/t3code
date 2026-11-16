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
const [LOG, EXIT_ON_CLOSE, FN_DELAY, HANG_INIT] = [__LOG__, __EXIT__, __DELAY__, __HANG_INIT__];
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
      if (["workflow", "workflow-background"].includes(cmd.message.message.content)) {
        write({ch:"sdk", t:"msg", ...sessions.get(cmd.sessionId), m:{type:"system",subtype:"task_started",task_id:"wf1",tool_use_id:"run1",task_type:"local_workflow",workflow_name:"Review",description:"Review",prompt:"workflow()"}});
      }
      if (cmd.message.message.content === "workflow-background") {
        write({ch:"sdk", t:"msg", ...sessions.get(cmd.sessionId), m:{type:"result",subtype:"success",is_error:false,result:"started",duration_ms:1,duration_api_ms:1,num_turns:1,total_cost_usd:0,usage:{},modelUsage:{},session_id:"fake"}});
      }
      if (fs.existsSync(LOG + ".frames")) {
        for (const frame of JSON.parse(fs.readFileSync(LOG + ".frames", "utf8")))
          write({ch:"sdk",t:"msg",...sessions.get(cmd.sessionId),m:{...frame,session_id:cmd.message.session_id}});
      }
      break;
    case "call":
      log(`call ${cmd.method}`);
      if (cmd.method === "stopTask") log(`stop ${JSON.stringify(cmd.args)}`);
      // A CLI still booting: `initializationResult` does not answer.
      if (["mcpServerStatus", "readMcpResource", "callMcpTool", "listPermissionRules"].includes(cmd.method)) log(`mcp ${JSON.stringify(cmd)}`);
      if (fs.existsSync(LOG + ".errors")) {
        const error = JSON.parse(fs.readFileSync(LOG + ".errors","utf8"))[cmd.method];
        if (error) {write({ch:"reply",id:cmd.id,ok:false,error:{message:error}});break;}
      }
      if (cmd.method === "initializationResult" && !HANG_INIT) reply(cmd.id, {});
      else if (cmd.method === "mcpServerStatus") reply(cmd.id, fs.existsSync(LOG + ".servers") ? JSON.parse(fs.readFileSync(LOG + ".servers","utf8")) : [{name:"weather",status:"connected",tools:[{name:"show",_meta:{ui:{resourceUri:"ui://weather"}},annotations:{readOnly:true}}]}]);
      else if (cmd.method === "listPermissionRules") reply(cmd.id, fs.existsSync(LOG + ".rules") ? JSON.parse(fs.readFileSync(LOG + ".rules","utf8")) : []);
      else if (cmd.method === "callMcpTool") reply(cmd.id, {content:[{type:"text",text:"sunny"}],_meta:{stub:true}});
      else if (cmd.method === "readMcpResource") reply(cmd.id, {contents:[{uri:cmd.args[1],mimeType:"text/html;profile=mcp-app",text:"<h1>Weather</h1>"}]});
      else if (!(HANG_INIT && cmd.method === "initializationResult")) reply(cmd.id, null);
      break;
    case "abort": {
      log("abort");
      const session = sessions.get(cmd.sessionId);
      if (session !== undefined)
        setTimeout(() => {
          log("end");
          write({ ch: "sdk", t: "end", ...session });
        }, 100);
      break;
    }
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
        .replace("__DELAY__", &fn_delay_ms.to_string())
        .replace("__HANG_INIT__", "false");
    std::fs::write(&script, text).unwrap();
    (
        claude_host(HelperCommand::from_path(&script), "claudeAgent"),
        log,
    )
}

/// A Claude home that does not exist: a session reads `settings.json` from its home, and the
/// default is `~/.claude`, the real one of whoever runs the tests.
fn no_home_config() -> ClaudeConfig {
    ClaudeConfig {
        home_path: Some(std::env::temp_dir().join("conn-claude-interrupt-tests-no-home")),
        ..ClaudeConfig::default()
    }
}

fn session(helper: &Helper) -> (ClaudeSession, mpsc::Receiver<conn_provider::ProviderEvent>) {
    let (tx, events) = mpsc::channel(crate::session::EVENT_CAPACITY);
    let session = ClaudeSession::open(
        "provider-session-interrupt".into(),
        "claudeAgent",
        no_home_config(),
        helper.clone(),
        tx,
        vec![],
        Default::default(),
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
        HelperCommand::from_path(scratch.0.join("missing-host.mjs")),
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

/// Stop during the CLI's boot (the session has MCP servers, so the start waits for
/// `initializationResult`, as T3's `openQuery`): the engine abandons the start, and the query
/// is aborted (the host ends the prompt stream, SIGKILLs the CLI, waits, disposes) instead of
/// closed. The early turn ends `interrupted`, no prompt is sent, and the next start opens a new
/// query. Before: the start held `turn_control` until the boot ended (up to 5 minutes).
#[tokio::test(flavor = "current_thread")]
async fn an_abandoned_start_aborts_the_booting_query() {
    if !node_available() {
        eprintln!("skipped: no node");
        return;
    }
    let scratch = Scratch::new("abandon-boot");
    let (helper, log) = fake_host(&scratch.0, true);
    let script = scratch.0.join("fake-host.mjs");
    let text = std::fs::read_to_string(&script)
        .unwrap()
        // HANG_INIT is the last value of the first line's list.
        .replace(", false];", ", true];");
    std::fs::write(&script, text).unwrap();
    let (tx, mut events) = mpsc::channel(crate::session::EVENT_CAPACITY);
    let session = ClaudeSession::open(
        "provider-session-abandon".into(),
        "claudeAgent",
        no_home_config(),
        helper.clone(),
        tx,
        vec![conn_provider::McpServer {
            name: "t3".into(),
            url: "http://127.0.0.1:9/mcp".into(),
            headers: vec![],
        }],
        Default::default(),
    );
    let cwd = scratch.cwd();
    let thread = new_thread(&session, "full-access", &cwd).await;
    let started = std::time::Instant::now();
    let (result, ()) = tokio::join!(
        session.start_turn(turn(1, &thread, "one", "full-access", &cwd)),
        async {
            running_turn_id(&mut events).await;
            // Wait for the boot call, then Stop.
            for _ in 0..100 {
                if std::fs::read_to_string(&log)
                    .unwrap_or_default()
                    .contains("call initializationResult")
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            session
                .abandon_turn_start(conn_provider::AbandonTurnStartInput {
                    thread_id: "thread-live".into(),
                    run_id: "run-1".into(),
                })
                .await;
        }
    );
    assert!(result.is_err(), "{result:?}");
    assert!(started.elapsed() < Duration::from_secs(5));
    let seen = until(&mut events, is_terminal).await;
    assert_eq!(seen.last().unwrap()["status"], "interrupted");
    let lines: Vec<String> = std::fs::read_to_string(&log)
        .unwrap()
        .lines()
        .map(str::to_string)
        .collect();
    assert_eq!(
        lines,
        [
            "fn resolveSettings",
            "open resume=-",
            "call initializationResult",
            "abort",
            "end"
        ],
        "aborted, never closed or prompted"
    );
    assert!(session.live_query().is_none());
    session.close().await;
}

#[tokio::test(flavor = "current_thread")]
async fn workflow_stop_calls_the_sdk_without_interrupting_the_turn() {
    use conn_provider::StopTaskInput;
    if !node_available() {
        return;
    }
    let dir = Scratch::new("workflow-stop");
    let (helper, log) = fake_host(&dir.0, true);
    let (session, mut events) = session(&helper);
    let cwd = dir.cwd();
    let thread = new_thread(&session, "full-access", &cwd).await;
    let input = turn(1, &thread, "workflow", "full-access", &cwd);
    session.start_turn(input).await.unwrap();
    let _ = until(&mut events, |e| e["type"] == "subagent.updated").await;
    session
        .stop_task(StopTaskInput {
            provider_thread: thread.clone(),
            task_id: "unknown".into(),
        })
        .await
        .unwrap_err();
    session
        .stop_task(StopTaskInput {
            provider_thread: thread,
            task_id: "wf1".into(),
        })
        .await
        .unwrap();
    let text = std::fs::read_to_string(log).unwrap();
    assert!(text.contains("stop [\"wf1\"]"), "{text}");
    assert!(!text.contains("call interrupt"), "{text}");
    session.close().await;
    helper.stop_if_idle().await;
}

#[tokio::test(flavor = "current_thread")]
async fn replacing_a_query_settles_its_workflow_and_refuses_a_stale_stop() {
    use conn_provider::StopTaskInput;
    if !node_available() {
        return;
    }
    let dir = Scratch::new("workflow-replacement");
    let (helper, log) = fake_host(&dir.0, true);
    let (session, mut events) = session(&helper);
    let cwd = dir.cwd();
    let thread = new_thread(&session, "full-access", &cwd).await;
    session
        .start_turn(turn(1, &thread, "workflow-background", "full-access", &cwd))
        .await
        .unwrap();
    let seen = until(&mut events, is_terminal).await;
    assert!(seen.iter().any(|e| e["subagent"]["status"] == "running"));
    // A changed policy forces a new CLI for the same native thread.
    session
        .start_turn(turn(2, &thread, "replacement", "approval-required", &cwd))
        .await
        .unwrap();
    let error = session
        .stop_task(StopTaskInput {
            provider_thread: thread,
            task_id: "wf1".into(),
        })
        .await
        .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("No running workflow task belongs to this provider thread"),
        "{error}"
    );
    let seen = until(&mut events, |e| {
        e["type"] == "provider_turn.updated" && e["providerTurn"]["status"] == "running"
    })
    .await;
    assert!(
        seen.iter().any(|e| e["subagent"]["status"] == "failed"),
        "{seen:?}"
    );
    assert!(
        !seen.iter().any(is_terminal),
        "the replacement stays running: {seen:?}"
    );
    let text = std::fs::read_to_string(log).unwrap();
    assert_eq!(
        text.lines()
            .filter(|line| line.starts_with("open "))
            .count(),
        2,
        "{text}"
    );
    assert!(!text.contains("call stopTask"), "{text}");
    session.close().await;
    helper.stop_if_idle().await;
}

#[tokio::test(flavor = "current_thread")]
async fn releasing_a_query_cancels_its_background_workflow() {
    use conn_provider::{RollbackTarget, RollbackThreadInput};
    if !node_available() {
        return;
    }
    let dir = Scratch::new("workflow-release");
    let (helper, _) = fake_host(&dir.0, true);
    let (session, mut events) = session(&helper);
    let cwd = dir.cwd();
    let thread = new_thread(&session, "full-access", &cwd).await;
    session
        .start_turn(turn(1, &thread, "workflow-background", "full-access", &cwd))
        .await
        .unwrap();
    until(&mut events, is_terminal).await;
    session
        .rollback_thread(RollbackThreadInput {
            provider_thread: thread,
            target: RollbackTarget::ThreadStart {
                checkpoint_id: "checkpoint-start".into(),
            },
            provider_thread_turns: vec![],
        })
        .await
        .unwrap();
    let mut settled = false;
    while let Ok(event) = events.try_recv() {
        let event = conn_contract::to_json(&event);
        settled |= event["subagent"]["status"] == "cancelled";
    }
    assert!(
        settled,
        "release must settle its query's workflow before returning"
    );
    assert!(!session.has_pending_background_work());
    session.close().await;
    helper.stop_if_idle().await;
}

#[tokio::test(flavor = "current_thread")]
async fn mcp_apps_use_the_live_query_and_honor_permission_rules() {
    use conn_provider::mcp_apps::{Operation, Request};
    use serde_json::json;
    let scratch = Scratch::new("mcp-apps");
    let (helper, log) = fake_host(&scratch.0, true);
    let recording: serde_json::Value =
        serde_json::from_str(include_str!("../testdata/mcp-app.json")).unwrap();
    std::fs::write(
        log.with_extension("log.frames"),
        serde_json::to_vec(&recording["frames"]).unwrap(),
    )
    .unwrap();
    let (session, mut events) = session(&helper);
    let cwd = scratch.cwd();
    let thread = new_thread(&session, "full-access", &cwd).await;
    let request = |operation| Request {
        provider_thread: thread.clone(),
        server: "weather".into(),
        operation,
    };
    assert!(matches!(
        session.mcp_app_request(request(Operation::ListTools)).await,
        Err(ProviderError::SessionStopped)
    ));
    session
        .start_turn(turn(1, &thread, "one", "full-access", &cwd))
        .await
        .unwrap();
    until(&mut events, is_terminal).await;
    let tools = session
        .mcp_app_request(request(Operation::ListTools))
        .await
        .unwrap();
    assert_eq!(tools[0]["annotations"]["readOnlyHint"], true);
    let source = session
        .mcp_app_source(
            json!({"toolName":"mcp__weather__show","runId":"run-1","status":"completed"}),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(source.resource_uri, "ui://weather");
    let result = session
        .mcp_app_request(request(Operation::CallTool {
            tool: "show".into(),
            arguments: json!({"city":"Amsterdam"}),
        }))
        .await
        .unwrap();
    assert_eq!(result["content"][0]["text"], "sunny");
    let result = session
        .mcp_app_request(request(Operation::ReadResource {
            uri: "ui://weather".into(),
        }))
        .await
        .unwrap();
    assert_eq!(result["contents"][0]["uri"], "ui://weather");
    for (method, operation, detail) in [
        (
            "mcpServerStatus",
            Operation::ListTools,
            "Failed to list Claude MCP tools.",
        ),
        (
            "callMcpTool",
            Operation::CallTool {
                tool: "show".into(),
                arguments: json!({}),
            },
            "Claude MCP tool call failed.",
        ),
        (
            "readMcpResource",
            Operation::ReadResource {
                uri: "ui://weather".into(),
            },
            "Claude MCP resource read failed.",
        ),
    ] {
        std::fs::write(
            log.with_extension("log.errors"),
            json!({method:"SDK rejected the native control request"}).to_string(),
        )
        .unwrap();
        let error = session
            .mcp_app_request(request(operation))
            .await
            .unwrap_err();
        assert!(
            matches!(error,ProviderError::Protocol {detail:ref got} if got == detail),
            "{error}"
        );
    }
    std::fs::remove_file(log.with_extension("log.errors")).unwrap();
    let mut other = conn_contract::to_json(&thread);
    other["nativeThreadRef"]["nativeId"] = json!("another-thread");
    assert!(matches!(
        session
            .read_mcp_app_document(Request {
                provider_thread: conn_contract::from_json(other).unwrap(),
                server: "weather".into(),
                operation: Operation::ReadResource {
                    uri: "ui://weather".into()
                }
            })
            .await,
        Err(ProviderError::SessionStopped)
    ));
    std::fs::write(
        log.with_extension("log.rules"),
        json!([{"behavior":"deny","rule":"mcp__alias__tool"}]).to_string(),
    )
    .unwrap();
    let tools = session
        .mcp_app_request(request(Operation::ListTools))
        .await
        .unwrap();
    assert!(tools[0]["annotations"].get("readOnlyHint").is_none());
    assert!(
        session
            .mcp_app_request(request(Operation::CallTool {
                tool: "show".into(),
                arguments: json!({})
            }))
            .await
            .unwrap_err()
            .to_string()
            .contains("deny rule")
    );
    std::fs::write(log.with_extension("log.rules"), "[]").unwrap();
    std::fs::write(log.with_extension("log.servers"),json!([{"name":"weather","status":"connected","tools":[{"name":"show.weather"},{"name":"show_weather","_meta":{"ui":{"resourceUri":"ui://weather"}}}]}]).to_string()).unwrap();
    assert!(
        session
            .mcp_app_request(request(Operation::CallTool {
                tool: "show.weather".into(),
                arguments: json!({})
            }))
            .await
            .unwrap_err()
            .to_string()
            .contains("same Claude tool name")
    );
    assert!(
        session
            .mcp_app_source(json!({"toolName":"mcp__weather__show_weather","runId":"run-1","status":"completed"}))
            .await
            .unwrap()
            .is_none()
    );
    std::fs::write(
        log.with_extension("log.servers"),
        json!([{"name":"weather"},{"name":"weather__other"}]).to_string(),
    )
    .unwrap();
    assert!(
        session
            .mcp_app_request(request(Operation::ListTools))
            .await
            .unwrap_err()
            .to_string()
            .contains("overlap")
    );
    let transcript = std::fs::read_to_string(&log).unwrap();
    assert_eq!(
        transcript
            .lines()
            .filter(|line| line.contains("call callMcpTool"))
            .count(),
        2
    );
    assert!(transcript.contains("mcp__weather__show"));
    assert_eq!(
        transcript
            .lines()
            .filter(|line| *line == "call initializationResult")
            .count(),
        0,
        "App callbacks use streamed capabilities without SDK initialization calls"
    );
    session.close().await;
    helper.stop().await;
}

#[tokio::test(flavor = "current_thread")]
async fn mcp_apps_require_each_streamed_capability_and_skip_subagent_sources() {
    use conn_provider::mcp_apps::{Operation, Request};
    use serde_json::{Value, json};
    let recording: Value = serde_json::from_str(include_str!("../testdata/mcp-app.json")).unwrap();
    for missing in 0..4 {
        let scratch = Scratch::new("mcp-init");
        let (helper, log) = fake_host(&scratch.0, true);
        let mut frames = recording["frames"].clone();
        if missing < 3 {
            frames[0]["capabilities"]
                .as_array_mut()
                .unwrap()
                .remove(missing);
        }
        let mut duplicate = recording["frames"][0].clone();
        if missing == 3 {
            duplicate["capabilities"] = json!([]);
        }
        frames.as_array_mut().unwrap().insert(1, duplicate);
        std::fs::write(
            log.with_extension("log.frames"),
            serde_json::to_vec(&frames).unwrap(),
        )
        .unwrap();
        let (session, mut events) = session(&helper);
        let cwd = scratch.cwd();
        let thread = new_thread(&session, "full-access", &cwd).await;
        session
            .start_turn(turn(1, &thread, "one", "full-access", &cwd))
            .await
            .unwrap();
        until(&mut events, is_terminal).await;
        let result = session
            .mcp_app_request(Request {
                provider_thread: thread,
                server: "weather".into(),
                operation: Operation::ListTools,
            })
            .await;
        assert_eq!(
            result.is_ok(),
            missing == 3,
            "capability index {missing}: {result:?}"
        );
        let before = std::fs::read_to_string(&log).unwrap();
        let source = session
            .mcp_app_source(
                json!({"toolName":"mcp__weather__show","runId":null,"status":"completed"}),
            )
            .await
            .unwrap();
        assert!(source.is_none(), "subagents cannot capture an App");
        assert_eq!(
            std::fs::read_to_string(&log).unwrap(),
            before,
            "subagent capture makes no SDK call"
        );
        assert_eq!(
            before
                .lines()
                .filter(|line| *line == "call initializationResult")
                .count(),
            0
        );
        session.close().await;
        helper.stop().await;
    }
}
