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
      if (cmd.method === "stopTask" && fs.existsSync(LOG + ".hang-stop")) break;
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
            device_tools: false,
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

fn api_error() -> serde_json::Value {
    serde_json::json!({"type":"result","subtype":"success","is_error":true,"terminal_reason":"api_error",
        "result":"Root turn failed","duration_ms":1,"duration_api_ms":1,"num_turns":1,"usage":{},
        "modelUsage":{},"total_cost_usd":0})
}

/// The last `subagent.updated` status for a native task id.
fn workflow_status(seen: &[serde_json::Value], task_id: &str) -> serde_json::Value {
    seen.iter()
        .rev()
        .find(|e| e["subagent"]["nativeTaskRef"]["nativeId"] == task_id)
        .map(|e| e["subagent"]["status"].clone())
        .unwrap_or_default()
}

/// The spawned `stopTask` reaches the host a moment after the terminal event; under a loaded
/// test run that moment can pass a second. The host logs `call stopTask` before its `stop`
/// line, so wait for the `stop` line itself.
async fn logged_stops(log: &Path) -> Vec<String> {
    for _ in 0..1000 {
        let text = std::fs::read_to_string(log).unwrap_or_default();
        if text.lines().any(|l| l.starts_with("stop ")) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    std::fs::read_to_string(log)
        .unwrap_or_default()
        .lines()
        .filter(|l| l.starts_with("stop "))
        .map(str::to_string)
        .collect()
}

/// `ClaudeAdapterV2`: a root that fails stops its run's live workflow through the query and
/// settles the coordinator `failed`; a later manual Stop finds nothing running.
#[tokio::test(flavor = "current_thread")]
async fn a_failed_root_stops_its_runs_workflow() {
    use conn_provider::StopTaskInput;
    if !node_available() {
        return;
    }
    let dir = Scratch::new("failed-root-workflow");
    let (helper, log) = fake_host(&dir.0, true);
    let (session, mut events) = session(&helper);
    let cwd = dir.cwd();
    let thread = new_thread(&session, "full-access", &cwd).await;
    std::fs::write(
        log.with_extension("log.frames"),
        serde_json::json!([api_error()]).to_string(),
    )
    .unwrap();
    session
        .start_turn(turn(1, &thread, "workflow", "full-access", &cwd))
        .await
        .unwrap();
    let seen = until(&mut events, is_terminal).await;
    assert_eq!(seen.last().unwrap()["status"], "failed");
    assert_eq!(workflow_status(&seen, "wf1"), "failed");
    assert_eq!(logged_stops(&log).await, ["stop [\"wf1\"]"]);
    session
        .stop_task(StopTaskInput {
            provider_thread: thread,
            task_id: "wf1".into(),
        })
        .await
        .unwrap_err();
    session.close().await;
    helper.stop_if_idle().await;
}

/// An SDK that never answers `stopTask` must not hold the root's settlement.
#[tokio::test(flavor = "current_thread")]
async fn an_unanswered_workflow_stop_lets_the_root_settle() {
    if !node_available() {
        return;
    }
    let dir = Scratch::new("failed-root-hung-stop");
    let (helper, log) = fake_host(&dir.0, true);
    let (session, mut events) = session(&helper);
    let cwd = dir.cwd();
    let thread = new_thread(&session, "full-access", &cwd).await;
    std::fs::write(log.with_extension("log.hang-stop"), "").unwrap();
    std::fs::write(
        log.with_extension("log.frames"),
        serde_json::json!([api_error()]).to_string(),
    )
    .unwrap();
    session
        .start_turn(turn(1, &thread, "workflow", "full-access", &cwd))
        .await
        .unwrap();
    let seen = tokio::time::timeout(Duration::from_secs(5), until(&mut events, is_terminal))
        .await
        .expect("the root settles while stopTask is unanswered");
    assert_eq!(seen.last().unwrap()["status"], "failed");
    assert_eq!(workflow_status(&seen, "wf1"), "failed");
    assert_eq!(logged_stops(&log).await, ["stop [\"wf1\"]"]);
    session.close().await;
    helper.stop_if_idle().await;
}

/// A completed root keeps its background workflow running, and a failed later run leaves
/// the earlier run's workflow alone.
#[tokio::test(flavor = "current_thread")]
async fn a_failed_root_leaves_another_runs_workflow_running() {
    if !node_available() {
        return;
    }
    let dir = Scratch::new("failed-root-other-run");
    let (helper, log) = fake_host(&dir.0, true);
    let (session, mut events) = session(&helper);
    let cwd = dir.cwd();
    let thread = new_thread(&session, "full-access", &cwd).await;
    session
        .start_turn(turn(1, &thread, "workflow-background", "full-access", &cwd))
        .await
        .unwrap();
    let seen = until(&mut events, is_terminal).await;
    assert_eq!(seen.last().unwrap()["status"], "completed");
    assert_eq!(workflow_status(&seen, "wf1"), "running");
    std::fs::write(
        log.with_extension("log.frames"),
        serde_json::json!([api_error()]).to_string(),
    )
    .unwrap();
    session
        .start_turn(turn(2, &thread, "two", "full-access", &cwd))
        .await
        .unwrap();
    let seen = until(&mut events, is_terminal).await;
    assert_eq!(seen.last().unwrap()["status"], "failed");
    assert_eq!(workflow_status(&seen, "wf1"), serde_json::Value::Null);
    assert!(session.has_pending_background_work());
    let text = std::fs::read_to_string(&log).unwrap();
    assert!(!text.contains("call stopTask"), "{text}");
    session.close().await;
    helper.stop_if_idle().await;
}

/// A stopped root closes its query; the workflow ends `cancelled` without a `stopTask`.
#[tokio::test(flavor = "current_thread")]
async fn an_interrupted_root_cancels_its_workflow_without_stop_task() {
    if !node_available() {
        return;
    }
    let dir = Scratch::new("interrupted-root-workflow");
    let (helper, log) = fake_host(&dir.0, true);
    let (session, mut events) = session(&helper);
    let cwd = dir.cwd();
    let thread = new_thread(&session, "full-access", &cwd).await;
    session
        .start_turn(turn(1, &thread, "workflow", "full-access", &cwd))
        .await
        .unwrap();
    let turn_id = running_turn_id(&mut events).await;
    let mut seen = until(&mut events, |e| e["type"] == "subagent.updated").await;
    session
        .interrupt_turn(InterruptInput {
            provider_thread: thread.clone(),
            provider_turn_id: turn_id.as_str().into(),
        })
        .await
        .unwrap();
    seen.extend(until(&mut events, is_terminal).await);
    assert_eq!(seen.last().unwrap()["status"], "interrupted");
    assert_eq!(workflow_status(&seen, "wf1"), "cancelled");
    let text = std::fs::read_to_string(&log).unwrap();
    assert!(!text.contains("call stopTask"), "{text}");
    session.close().await;
    helper.stop_if_idle().await;
}

const MEMBER_ANSWER: &str = "Reviewed both migrations. The second one needs an index.";

/// A member transcript's assistant line, as Claude writes it.
fn member_line(uuid: &str, message_id: &str, text: &str) -> String {
    let line = serde_json::json!({"type":"assistant","effort":"high","uuid":uuid,"message":{
        "id":message_id,"role":"assistant","stop_reason":"end_turn","content":[{"type":"text","text":text}]}});
    format!("{line}\n")
}

/// A `workflow_agent` progress entry for the one member, `a1`.
fn member_entry(state: &str, attempt: u64, result: Option<&str>) -> serde_json::Value {
    let mut entry = serde_json::json!({"type":"workflow_agent","index":0,"label":"Reviewer",
        "state":state,"attempt":attempt,"startedAt":attempt * 10,"model":"claude-sonnet-4-6",
        "agentId":"a1","promptPreview":"Inspect code"});
    if state == "done" {
        entry["lastProgressAt"] = serde_json::json!(attempt * 10 + 5);
    }
    if let Some(result) = result {
        entry["resultPreview"] = serde_json::json!(result);
    }
    entry
}

/// Where the member's transcript sits, and how the session finds Claude's config folder.
enum MemberFile {
    /// `<config>/projects/workflow/agent-a1.jsonl`, the config folder as the `homePath` setting.
    Written(String),
    /// No transcript.
    Missing,
    /// A FIFO in the transcript's place. A writer waits for a reader and sends an answer.
    Fifo,
    /// The transcript under a relative `CLAUDE_CONFIG_DIR` in the instance environment, which
    /// the CLI resolves from the session cwd.
    RelativeConfig(String),
}

/// The assistant messages (id, text) a workflow member's child thread got, in order. The
/// member reports `progress` (one frame per entry), then the workflow and root complete.
async fn member_messages(
    name: &str,
    file: MemberFile,
    progress: &[serde_json::Value],
) -> Vec<(String, String)> {
    member_messages_flushed(name, file, progress, None).await.1
}

/// [`member_messages`], and with `flush`, a transcript line appended once the turn ended: the
/// messages until the terminal event, then all of them once one shows `flush`'s text.
async fn member_messages_flushed(
    name: &str,
    file: MemberFile,
    progress: &[serde_json::Value],
    flush: Option<(&str, &str)>,
) -> (Vec<(String, String)>, Vec<(String, String)>) {
    use serde_json::{Value, json};
    let dir = Scratch::new(name);
    let relative = matches!(file, MemberFile::RelativeConfig(_));
    let config = dir
        .0
        .join(if relative { "claude-config" } else { "config" });
    let transcripts = config.join("projects/workflow");
    std::fs::create_dir_all(&transcripts).unwrap();
    let transcript = transcripts.join("agent-a1.jsonl");
    match &file {
        MemberFile::Written(text) | MemberFile::RelativeConfig(text) => {
            std::fs::write(&transcript, text).unwrap();
        }
        MemberFile::Missing => {}
        MemberFile::Fifo => {
            let made = std::process::Command::new("mkfifo")
                .arg(&transcript)
                .status()
                .unwrap();
            assert!(made.success());
            let fifo = transcript.clone();
            // Never joined: with no reader it waits until the test process ends.
            std::thread::spawn(move || {
                use std::io::Write;
                if let Ok(mut pipe) = std::fs::OpenOptions::new().write(true).open(fifo) {
                    let _ =
                        pipe.write_all(member_line("pipe", "msg_pipe", "From a pipe").as_bytes());
                }
            });
        }
    }

    let (helper, log) = fake_host(&dir.0, true);
    let (tx, mut events) = mpsc::channel(crate::session::EVENT_CAPACITY);
    let config = if relative {
        ClaudeConfig {
            instance_env: vec![("CLAUDE_CONFIG_DIR".to_owned(), "claude-config".to_owned())].into(),
            ..ClaudeConfig::default()
        }
    } else {
        ClaudeConfig {
            home_path: Some(config),
            ..ClaudeConfig::default()
        }
    };
    let session = ClaudeSession::open(
        "provider-sixth".into(),
        "claudeAgent",
        config,
        helper.clone(),
        tx,
        vec![],
        Default::default(),
    );
    let cwd = dir.cwd();
    let thread = new_thread(&session, "full-access", &cwd).await;
    let mut frames = Vec::new();
    for line in include_str!("../testdata/cli/e16_workflow.ndjson").lines() {
        let envelope: Value = serde_json::from_str(line).unwrap();
        let mut msg = envelope["msg"].clone();
        if envelope["dir"] != "in" || msg["subtype"] == "task_progress" {
            continue;
        }
        if msg["uuid"] == "wf-4" {
            msg["tool_use_result"]["transcriptDir"] = json!(transcripts);
            frames.push(msg);
            for (n, entry) in progress.iter().enumerate() {
                frames.push(
                    json!({"type":"system","subtype":"task_progress","uuid":format!("member-{n}"),
                    "task_id":"wf1","tool_use_id":"tool-workflow","description":"Review",
                    "workflow_progress":[entry]}),
                );
            }
            continue;
        }
        let done = msg["uuid"] == "wf-7";
        frames.push(msg);
        if done {
            break;
        }
    }
    frames.push(json!({"type":"result","subtype":"success","is_error":false,"result":"Review complete",
        "duration_ms":1,"duration_api_ms":1,"num_turns":1,"usage":{},"modelUsage":{},"total_cost_usd":0}));
    std::fs::write(log.with_extension("log.frames"), json!(frames).to_string()).unwrap();
    session
        .start_turn(turn(1, &thread, "inspect", "full-access", &cwd))
        .await
        .unwrap();
    let mut seen = until(&mut events, is_terminal).await;
    assert_eq!(seen.last().unwrap()["status"], "completed");
    let at_terminal = seen.len();
    if let Some((line, text)) = flush {
        use std::io::Write;
        let mut handle = std::fs::OpenOptions::new()
            .append(true)
            .open(&transcript)
            .unwrap();
        handle.write_all(line.as_bytes()).unwrap();
        // Bounded: without the reread the text never comes.
        let flushed = until(&mut events, |e| e["message"]["text"] == text);
        if let Ok(more) = tokio::time::timeout(Duration::from_secs(10), flushed).await {
            seen.extend(more);
        }
    }
    let coordinator = seen
        .iter()
        .rev()
        .find(|e| e["subagent"]["workflow"]["runHandles"]["transcriptDir"] == json!(transcripts))
        .unwrap();
    let member = &coordinator["subagent"]["workflow"]["agents"][0];
    assert_eq!(member["agentId"], "a1");
    let messages = |events: &[serde_json::Value]| -> Vec<(String, String)> {
        events
            .iter()
            .map(|e| &e["message"])
            .filter(|m| m["threadId"] == member["childThreadId"] && m["role"] == "assistant")
            .map(|m| {
                (
                    m["id"].as_str().unwrap().to_owned(),
                    m["text"].as_str().unwrap().to_owned(),
                )
            })
            .collect()
    };
    let (before, all) = (messages(&seen[..at_terminal]), messages(&seen));
    session.close().await;
    helper.stop_if_idle().await;
    (before, all)
}

fn texts(messages: Vec<(String, String)>) -> Vec<String> {
    messages.into_iter().map(|(_, text)| text).collect()
}

/// The member settles once, with the excerpt "Looks good".
fn settles_once() -> [serde_json::Value; 2] {
    [
        member_entry("start", 1, None),
        member_entry("done", 1, Some("Looks good")),
    ]
}

/// `ClaudeAdapterV2`'s member transcript reader: a settled workflow member's child shows the
/// answer from its transcript, not the progress excerpt that contradicts it.
#[tokio::test(flavor = "current_thread")]
async fn a_settled_workflow_member_shows_its_transcript_answer() {
    if !node_available() {
        return;
    }
    let written = MemberFile::Written(member_line("wf-line-1", "msg_a1", MEMBER_ANSWER));
    let shown = member_messages("member-transcript", written, &settles_once()).await;
    assert_eq!(texts(shown), [MEMBER_ANSWER]);
    // Without a readable transcript the progress excerpt stands in, once.
    let shown = member_messages("member-excerpt", MemberFile::Missing, &settles_once()).await;
    assert_eq!(
        texts(shown),
        ["Partial answer from workflow progress:\n\nLooks good"]
    );
}

/// `readContainedWorkflowFile` opens the leaf with `O_NONBLOCK` and reads only a regular file:
/// a FIFO in the transcript's place neither blocks the session nor feeds it an answer.
#[tokio::test(flavor = "current_thread")]
async fn a_transcript_that_is_not_a_regular_file_is_not_read() {
    if !node_available() {
        return;
    }
    let shown = member_messages("member-fifo", MemberFile::Fifo, &settles_once()).await;
    assert_eq!(
        texts(shown),
        ["Partial answer from workflow progress:\n\nLooks good"]
    );
}

/// `!textShown && !resultShown`: a member that settled with nothing to show shows the excerpt
/// that arrives later, once.
#[tokio::test(flavor = "current_thread")]
async fn a_late_excerpt_is_shown_once() {
    if !node_available() {
        return;
    }
    let progress = [
        member_entry("start", 1, None),
        member_entry("done", 1, None),
        member_entry("done", 1, Some("Late excerpt")),
        member_entry("done", 1, Some("Changed excerpt")),
    ];
    let shown = member_messages("member-late-excerpt", MemberFile::Missing, &progress).await;
    assert_eq!(
        texts(shown),
        ["Partial answer from workflow progress:\n\nLate excerpt"]
    );
}

/// `ClaudeAdapterV2.test.ts` "reads a settled workflow member's transcript to its end past the
/// read cap": 80 long early messages, then `FINAL ANSWER`. All 81 show, in order, and no
/// excerpt.
#[tokio::test(flavor = "current_thread")]
async fn a_long_transcript_keeps_its_final_answer() {
    if !node_available() {
        return;
    }
    let filler = "x".repeat(16 * 1024);
    let mut transcript: String = (0..80)
        .map(|n| {
            member_line(
                &format!("line-early-{n}"),
                &format!("msg_early_{n}"),
                &format!("{n} {filler}"),
            )
        })
        .collect();
    transcript.push_str(&member_line("line-final", "msg_final", "FINAL ANSWER"));
    let shown = member_messages(
        "member-long-transcript",
        MemberFile::Written(transcript),
        &settles_once(),
    )
    .await;
    let mut expected: Vec<String> = (0..80).map(|n| format!("{n} {filler}")).collect();
    expected.push("FINAL ANSWER".to_owned());
    assert_eq!(texts(shown), expected);
}

/// Transcript lines keep their item ids across attempts (`nativeItemId: line.uuid`): a retry
/// that reads the same transcript updates the answer instead of adding a second one.
#[tokio::test(flavor = "current_thread")]
async fn a_retry_does_not_duplicate_transcript_answers() {
    if !node_available() {
        return;
    }
    let progress = [
        member_entry("start", 1, None),
        member_entry("done", 1, Some("First")),
        member_entry("start", 2, None),
        member_entry("done", 2, Some("Second")),
    ];
    let written = MemberFile::Written(member_line("wf-line-1", "msg_a1", MEMBER_ANSWER));
    let shown = member_messages("member-retry", written, &progress).await;
    let mut ids: Vec<&str> = shown.iter().map(|(id, _)| id.as_str()).collect();
    ids.dedup();
    assert_eq!(ids.len(), 1, "{shown:?}");
    assert_eq!(shown.last().unwrap().1, MEMBER_ANSWER);
}

/// `ClaudeAdapterV2` reads transcripts under the query's own `CLAUDE_CONFIG_DIR`, resolved from
/// the session cwd when relative.
#[tokio::test(flavor = "current_thread")]
async fn transcripts_are_read_under_the_querys_config_dir() {
    if !node_available() {
        return;
    }
    let file = MemberFile::RelativeConfig(member_line("wf-line-1", "msg_a1", MEMBER_ANSWER));
    let shown = member_messages("member-relative-config", file, &settles_once()).await;
    assert_eq!(texts(shown), [MEMBER_ANSWER]);
}

/// The final flush window does not hold the query: while a member's reread waits out the
/// window, the driver keeps taking frames (the root settles first), and the reread then shows
/// the line Claude flushed in the meantime instead of the excerpt.
#[tokio::test(flavor = "current_thread")]
async fn the_flush_wait_keeps_the_driver_draining() {
    if !node_available() {
        return;
    }
    // Settled a second from now, so the window is still open when the coordinator ends.
    let mut done = member_entry("done", 1, Some("Looks good"));
    done["lastProgressAt"] = serde_json::json!(conn_support::time::now_ms() + 1000);
    let mut pre_tool = member_line("wf-line-1", "msg_a1", "Let me look.");
    pre_tool = pre_tool.replace("end_turn", "tool_use");
    let final_line = member_line("wf-line-2", "msg_a2", "FINAL ANSWER");
    let (before, all) = member_messages_flushed(
        "member-flush-drain",
        MemberFile::Written(pre_tool),
        &[member_entry("start", 1, None), done],
        Some((&final_line, "FINAL ANSWER")),
    )
    .await;
    assert_eq!(texts(before), ["Let me look."]);
    assert_eq!(texts(all), ["Let me look.", "FINAL ANSWER"]);
}
