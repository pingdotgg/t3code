//! The Conn Server side of the conformance check (`tools/conformance/run.sh`): runs each
//! scenario of `scenarios.json` through `ClaudeProvider` and the SDK helper against
//! `stub-claude`, which records what the CLI receives. No model is called.
//!
//! ```sh
//! conformance <scenarios.json> <out-root> <workspace> <attachments-dir> <helper> [scenario...]
//! ```
//!
//! `run.sh` starts this under `env -i` with the same base environment it gives the T3 run, so
//! both CLIs inherit the same variables. `<out-root>/<scenario>/` must hold `stub-claude` and
//! `scripts/`; the stub writes `records/` there.

use std::{path::PathBuf, time::Duration};

use conn_contract::{from_json, to_json};
use conn_provider::{
    EnsureThreadInput, ForkThreadInput, InterruptInput, McpServer, OpenSessionInput, OpenedSession,
    Provider, ProviderEvent, ResumeThreadInput, RuntimeRequestResponse, Session, TurnInput,
    TurnMessage,
};
use conn_provider_claude::{ClaudeConfig, ClaudeProvider};
use serde_json::{Value, json};
use tokio::sync::mpsc;

const TIMEOUT: Duration = Duration::from_secs(60);
const THREAD: &str = "thread-conformance";
/// The MCP credential both runs register; the comparison sees it in the CLI's stdin.
pub const MCP_URL: &str = "http://127.0.0.1:9/mcp";
pub const MCP_AUTHORIZATION: &str = "Bearer conformance-credential";

struct Run {
    helper: conn_provider_claude::HelperCommand,
    model: String,
    mode: String,
    /// `policyOverride`: `approvalPolicy` and `sandboxPolicy` laid over the policy.
    policy_override: Value,
    cwd: String,
    attachments: PathBuf,
}

impl Run {
    fn model_selection(&self, model: Option<&str>) -> Value {
        json!({"instanceId": "claudeAgent", "model": model.unwrap_or(&self.model)})
    }

    fn policy(&self) -> Value {
        let mut policy =
            json!({"runtimeMode": self.mode, "interactionMode": "default", "cwd": self.cwd});
        if let (Some(policy), Some(over)) =
            (policy.as_object_mut(), self.policy_override.as_object())
        {
            policy.extend(over.clone());
        }
        policy
    }

    fn turn(
        &self,
        n: u32,
        thread: &conn_contract::ProviderThread,
        step: &Value,
        app_thread: &str,
    ) -> TurnInput {
        let model = step["model"].as_str();
        let attachments = if step["image"] == json!(true) {
            vec![
                from_json(json!({
                    "type": "image", "id": "attach-1", "name": "red.png",
                    "mimeType": "image/png", "sizeBytes": image_size(&self.attachments),
                }))
                .unwrap_or_else(|e| panic!("attachment: {e}")),
            ]
        } else {
            Vec::new()
        };
        TurnInput {
            app_thread: from_json(json!({
                "createdBy": "user", "creationSource": "web", "id": app_thread,
                "projectId": "project-conformance", "title": "Conformance",
                "providerInstanceId": "claudeAgent",
                "modelSelection": self.model_selection(model), "runtimeMode": self.mode,
                "interactionMode": "default", "branch": null, "worktreePath": null,
                "activeProviderThreadId": null,
                "lineage": {"parentThreadId": null, "relationshipToParent": null, "rootThreadId": app_thread},
                "forkedFrom": null, "createdAt": "2026-11-13T00:00:00.000Z",
                "updatedAt": "2026-11-13T00:00:00.000Z", "archivedAt": null,
            }))
            .unwrap_or_else(|e| panic!("app thread: {e}")),
            thread_id: app_thread.into(),
            run_id: format!("run-{n}").as_str().into(),
            run_ordinal: n,
            provider_turn_ordinal: n,
            attempt_id: format!("attempt-{n}").as_str().into(),
            root_node_id: format!("node-{n}").as_str().into(),
            provider_thread: thread.clone(),
            message: TurnMessage {
                message_id: format!("message-{n}").as_str().into(),
                text: step["turn"].as_str().unwrap_or_default().into(),
                attachments,
            },
            model_selection: from_json(self.model_selection(model))
                .unwrap_or_else(|e| panic!("model: {e}")),
            runtime_policy: from_json(self.policy()).unwrap_or_else(|e| panic!("policy: {e}")),
        }
    }
}

fn image_size(dir: &std::path::Path) -> u64 {
    std::fs::metadata(dir.join("attach-1.png")).map_or(0, |m| m.len())
}

/// The next provider event, or `None` after [`TIMEOUT`] or when the channel closed.
async fn next(events: &mut mpsc::Receiver<ProviderEvent>) -> Option<Value> {
    let event = tokio::time::timeout(TIMEOUT, events.recv()).await.ok()??;
    Some(serde_json::to_value(&event).unwrap_or_default())
}

async fn open(
    provider: &ClaudeProvider,
    run: &Run,
    mcp: bool,
) -> (Box<dyn Session>, mpsc::Receiver<ProviderEvent>) {
    let OpenedSession { session, events } = provider
        .open_session(OpenSessionInput {
            thread_id: THREAD.into(),
            provider_session_id: "provider-session-conformance".into(),
            model_selection: from_json(run.model_selection(None)).unwrap_or_else(|e| panic!("{e}")),
            runtime_policy: from_json(run.policy()).unwrap_or_else(|e| panic!("{e}")),
            resume_from_session: None,
        })
        .await
        .unwrap_or_else(|e| panic!("open_session: {e}"));
    if mcp {
        session
            .set_mcp_servers(vec![McpServer {
                name: "t3-code".into(),
                url: MCP_URL.into(),
                headers: vec![("Authorization".into(), MCP_AUTHORIZATION.into())],
            }])
            .await
            .unwrap_or_else(|e| panic!("set_mcp_servers: {e}"));
    }
    (session, events)
}

async fn scenario(root: &std::path::Path, run: &Run, model: &str, spec: &Value) {
    let name = spec["name"].as_str().unwrap_or("scenario");
    let dir = root.join(name);
    let config = ClaudeConfig {
        binary: dir.join("stub-claude"),
        attachments_dir: Some(run.attachments.clone()),
        helper: run.helper.clone(),
        idle_timeout: None,
        mcp_instructions: Some(format!(
            "{}{}",
            conn_mcp::AGENT_INSTRUCTIONS,
            conn_mcp::CLAUDE_INSTRUCTIONS
        )),
        ..ClaudeConfig::default()
    };
    let provider = ClaudeProvider::new("claudeAgent".into(), config);
    let settings_file =
        std::env::var_os("CLAUDE_CONFIG_DIR").map(|dir| PathBuf::from(dir).join("settings.json"));
    if let (Some(file), Some(settings)) = (&settings_file, spec.get("claudeSettings")) {
        std::fs::write(file, settings.to_string()).unwrap_or_else(|e| panic!("settings: {e}"));
    }
    let run = Run {
        helper: run.helper.clone(),
        model: model.into(),
        mode: spec["runtimeMode"].as_str().unwrap_or("full-access").into(),
        policy_override: spec["policyOverride"].clone(),
        cwd: run.cwd.clone(),
        attachments: run.attachments.clone(),
    };
    let mcp = spec["mcp"] == json!(true);
    let (mut session, mut events) = open(&provider, &run, mcp).await;
    let mut thread = session
        .ensure_thread(EnsureThreadInput {
            thread_id: THREAD.into(),
            title: None,
            model_selection: from_json(run.model_selection(None)).unwrap_or_else(|e| panic!("{e}")),
            runtime_policy: from_json(run.policy()).unwrap_or_else(|e| panic!("{e}")),
            existing_provider_thread: None,
        })
        .await
        .unwrap_or_else(|e| panic!("ensure_thread: {e}"));
    let mut app_thread = THREAD.to_string();
    let mut turns: Vec<Value> = Vec::new();
    let mut n = 0;
    'steps: for step in spec["steps"].as_array().into_iter().flatten() {
        if step["reopen"] == json!(true) {
            session.close().await;
            let (s, e) = open(&provider, &run, mcp).await;
            session = s;
            events = e;
            thread = session
                .resume_thread(ResumeThreadInput {
                    thread_id: Some(THREAD.into()),
                    provider_thread: thread.clone(),
                    model_selection: from_json(run.model_selection(None))
                        .unwrap_or_else(|e| panic!("{e}")),
                    runtime_policy: from_json(run.policy()).unwrap_or_else(|e| panic!("{e}")),
                })
                .await
                .unwrap_or_else(|e| panic!("resume_thread: {e}"));
            continue;
        }
        if step["fork"] == json!(true) {
            let forked = session
                .fork_thread(ForkThreadInput {
                    source_provider_thread: thread.clone(),
                    source_provider_turns: turns
                        .iter()
                        .map(|t| from_json(t.clone()).unwrap_or_else(|e| panic!("{e}")))
                        .collect(),
                    provider_turn_id: None,
                    target_thread_id: "thread-conformance-fork".into(),
                    owner_node_id: None,
                    model_selection: None,
                    runtime_policy: None,
                })
                .await
                .unwrap_or_else(|e| panic!("fork_thread: {e}"));
            thread = forked;
            app_thread = "thread-conformance-fork".into();
            n = 0;
            continue;
        }
        n += 1;
        let input = run.turn(n, &thread, step, &app_thread);
        session
            .start_turn(input)
            .await
            .unwrap_or_else(|e| panic!("{name}: start_turn: {e}"));
        let mut answers: Vec<String> = step["answers"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|a| a.as_str().map(str::to_string))
            .collect();
        answers.reverse();
        let mut interrupted = step["interrupt"] != json!(true);
        let mut live_selection = step.get("liveSelection").cloned();
        loop {
            let Some(event) = next(&mut events).await else {
                eprintln!("{name}: turn {n}: no provider event in time; scenario stopped");
                break 'steps;
            };
            match event["type"].as_str() {
                Some("provider_thread.updated") => {
                    thread = from_json(event["providerThread"].clone())
                        .unwrap_or_else(|e| panic!("{e}"));
                }
                Some("provider_turn.updated") => {
                    let turn = event["providerTurn"].clone();
                    if let Some(change) = live_selection
                        .as_ref()
                        .filter(|_| turn["tokenUsage"].is_object())
                    {
                        let mut selection = run.model_selection(change["model"].as_str());
                        if let Some(options) = change.get("options") {
                            selection["options"] = options.clone();
                        }
                        session
                            .apply_model_selection(
                                thread.clone(),
                                from_json(selection).unwrap_or_else(|e| panic!("{e}")),
                            )
                            .await
                            .unwrap_or_else(|e| panic!("apply_model_selection: {e}"));
                        live_selection = None;
                    }
                    if !interrupted && turn["tokenUsage"].is_object() {
                        interrupted = true;
                        session
                            .interrupt_turn(InterruptInput {
                                provider_thread: thread.clone(),
                                provider_turn_id: turn["id"].as_str().unwrap_or_default().into(),
                            })
                            .await
                            .unwrap_or_else(|e| panic!("interrupt: {e}"));
                    }
                    turns.retain(|t| t["id"] != turn["id"]);
                    turns.push(turn);
                }
                Some("runtime_request.updated")
                    if event["runtimeRequest"]["status"] == "pending" =>
                {
                    let decision = answers.pop().unwrap_or_else(|| "decline".into());
                    let id = event["runtimeRequest"]["id"].as_str().unwrap_or_default();
                    session
                        .respond_to_runtime_request(RuntimeRequestResponse {
                            request_id: id.into(),
                            decision: Some(
                                from_json(json!(decision)).unwrap_or_else(|e| panic!("{e}")),
                            ),
                            feedback: None,
                            answers: None,
                        })
                        .await
                        .unwrap_or_else(|e| panic!("respond: {e}"));
                }
                Some("turn.terminal") => {
                    eprintln!("{name}: turn {n} {}", event["status"]);
                    break;
                }
                _ => {}
            }
        }
    }
    session.close().await;
    if let (Some(file), Some(_)) = (&settings_file, spec.get("claudeSettings")) {
        let _ = std::fs::remove_file(file);
    }
    // The thread as T3 would persist it, for the record.
    let _ = to_json(&thread);
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [scenarios, root, cwd, attachments, helper, only @ ..] = args.as_slice() else {
        eprintln!(
            "usage: conformance <scenarios.json> <out-root> <workspace> <attachments-dir> <helper> [scenario...]"
        );
        std::process::exit(2);
    };
    let text = std::fs::read_to_string(scenarios).unwrap_or_else(|e| panic!("{scenarios}: {e}"));
    let file: Value = serde_json::from_str(&text).unwrap_or_else(|e| panic!("{scenarios}: {e}"));
    let model = file["model"]
        .as_str()
        .unwrap_or("claude-haiku-5-5")
        .to_string();
    let run = Run {
        helper: conn_provider_claude::HelperCommand::from_path(helper),
        model: model.clone(),
        mode: String::new(),
        policy_override: Value::Null,
        cwd: cwd.clone(),
        attachments: PathBuf::from(attachments),
    };
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap_or_else(|e| panic!("runtime: {e}"));
    runtime.block_on(async {
        for spec in file["scenarios"].as_array().into_iter().flatten() {
            let name = spec["name"].as_str().unwrap_or_default();
            if !only.is_empty() && !only.iter().any(|o| o == name) {
                continue;
            }
            scenario(std::path::Path::new(root), &run, &model, spec).await;
        }
    });
}
