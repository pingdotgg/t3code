//! Offline tests: the real engine with its scripted fake provider (`hang`, `ask`, `fail`,
//! else `echo: <text>`). Every tool result is checked against the `outputSchema` the
//! TypeScript server advertises for that tool.

use std::{path::PathBuf, sync::Arc, time::Duration};

use conn_contract::from_json;
use conn_engine::{EngineConfig, ProjectConfig, SqliteEngine, fake::FakeProvider};
use http::{HeaderMap, HeaderValue, Method, StatusCode};
use serde_json::{Value, json};

use crate::{
    Caller, ClientCaller, McpConfig, McpService, ThreadCaller, ThreadCredentialRequest, catalog,
    tools,
};

const ROOT: &str = "/tmp/conn-mcp-test-project";

struct Fixture {
    service: Arc<McpService>,
    dir: PathBuf,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn fixture(name: &str) -> Fixture {
    fixture_with_host(name, None)
}

fn fixture_with_host(name: &str, host: Option<Arc<dyn conn_engine::EngineHost>>) -> Fixture {
    fixture_with(name, host, FakeProvider::new("claudeAgent"))
}

fn fixture_with(
    name: &str,
    host: Option<Arc<dyn conn_engine::EngineHost>>,
    provider: FakeProvider,
) -> Fixture {
    let dir = std::env::temp_dir().join(format!("conn-mcp-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let dir = dir.canonicalize().unwrap();
    let files = Arc::new(conn_files::Files::open(&dir).unwrap());
    let mut config = EngineConfig::new(dir.join("engine.sqlite"));
    config.projects = vec![ProjectConfig {
        title: "Project".into(),
        workspace_root: ROOT.into(),
    }];
    config.providers = vec![Arc::new(provider)];
    config.host = host.or_else(|| Some(Arc::new(threads_handoff::FilesHost(files.clone()))));
    let engine = Arc::new(SqliteEngine::open(config).unwrap());
    let service = McpService::new(McpConfig {
        preview: Some(conn_preview::tabs::Preview::new(dir.clone())),
        refresh_provider: None,
        files: Some(files),
        worktrees: Some(crate::WorktreeConfig {
            directory: Arc::new({
                let dir = dir.clone();
                move || dir.join("worktrees")
            }),
            settings: Arc::new(|| json!({})),
            terminals: None,
            hub: conn_vcs::VcsHub::default(),
        }),
        panels: Some(conn_features::panels::PanelBroker::default()),
        pull_requests: None,
        test_logins: Some(conn_features::test_logins::TestLogins::new(&dir)),
        secrets: Some(conn_features::secrets::SecretRequests::new(
            &dir,
            engine.clone(),
            Arc::new(conn_features::clock::SystemClock),
        )),
        engine,
        environment_id: "env-test".into(),
        label: "Test".into(),
        server_version: "0.0.0".into(),
        platform: json!({"os": "linux", "arch": "x64"}),
        providers: Arc::new(|| {
            vec![json!({
                "instanceId": "claudeAgent", "driver": "claudeAgent", "displayName": "Claude",
                "enabled": true, "installed": true, "status": "ready",
                "models": [{"slug": "claude-haiku-5-5", "name": "Claude Haiku 5.5"}],
            })]
        }),
        hosted_app_url: crate::DEFAULT_HOSTED_APP_URL.into(),
        scheduled_tasks: None,
        annotations: None,
    });
    service.set_listen_address("0.0.0.0:4711".parse().unwrap());
    Fixture { service, dir }
}

fn client(write: bool) -> Caller {
    Caller::Client(ClientCaller {
        session_id: if write { "swamp" } else { "reader" }.into(),
        max_runtime_mode: write.then_some("full-access"),
    })
}

fn project_id() -> String {
    SqliteEngine::project_id_for(ROOT)
}

/// One MCP client: a session, and a helper per request.
struct Client<'a> {
    service: &'a Arc<McpService>,
    caller: Caller,
    session: Option<String>,
    next_id: u64,
}

fn headers(pairs: &[(&'static str, &str)]) -> HeaderMap {
    let mut map = HeaderMap::new();
    for (name, value) in pairs {
        map.insert(*name, HeaderValue::from_str(value).unwrap());
    }
    map
}

const POST: [(&str, &str); 2] = [
    ("content-type", "application/json"),
    ("accept", "application/json, text/event-stream"),
];

impl<'a> Client<'a> {
    async fn open(service: &'a Arc<McpService>, caller: Caller) -> Self {
        let mut client = Self {
            service,
            caller,
            session: None,
            next_id: 1,
        };
        let reply = client
            .raw(
                json!({"jsonrpc": "2.0", "id": 0, "method": "initialize", "params": {
                "protocolVersion": "2025-06-18", "capabilities": {},
                "clientInfo": {"name": "test", "version": "0"}}}),
            )
            .await;
        assert_eq!(reply.0, StatusCode::OK);
        client.session = Some(reply.2.unwrap());
        client
    }

    /// Status, body, and the `mcp-session-id` header.
    async fn raw(&self, body: Value) -> (StatusCode, Option<Value>, Option<String>) {
        let mut pairs = POST.to_vec();
        if let Some(session) = &self.session {
            pairs.push(("mcp-session-id", session));
        }
        let reply = self
            .service
            .handle(
                self.caller.clone(),
                &Method::POST,
                &headers(&pairs),
                body.to_string().as_bytes(),
            )
            .await;
        let session = reply
            .headers
            .iter()
            .find(|(n, _)| *n == "mcp-session-id")
            .map(|(_, v)| v.clone());
        (
            reply.status,
            reply.body.map(|b| serde_json::from_str(&b).unwrap()),
            session,
        )
    }

    async fn request(&mut self, method: &str, params: Value) -> Value {
        self.next_id += 1;
        let (status, body, _) = self
            .raw(json!({"jsonrpc": "2.0", "id": self.next_id, "method": method, "params": params}))
            .await;
        assert_eq!(status, StatusCode::OK);
        body.unwrap()
    }

    /// A successful call's structured result, checked against the tool's output schema.
    async fn ok(&mut self, tool: &str, args: Value) -> Value {
        let reply = self
            .request("tools/call", json!({"name": tool, "arguments": args}))
            .await;
        let result = &reply["result"];
        assert_eq!(result["isError"], false, "{tool}: {reply}");
        let value = result["structuredContent"].clone();
        assert_eq!(
            serde_json::from_str::<Value>(result["content"][0]["text"].as_str().unwrap()).unwrap(),
            value
        );
        let (definition, _) = catalog::tool(tool).unwrap();
        if let Some(schema) = definition.get("outputSchema") {
            conforms(schema, &value, tool).unwrap();
        }
        value
    }

    /// A refused call's failure code and message.
    async fn failure(&mut self, tool: &str, args: Value) -> (String, String) {
        let reply = self
            .request("tools/call", json!({"name": tool, "arguments": args}))
            .await;
        assert_eq!(reply["result"]["isError"], true, "{tool}: {reply}");
        let failure: Value =
            serde_json::from_str(reply["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
        assert!(matches!(
            failure["_tag"].as_str(),
            Some("OrchestratorMcpFailure" | "WorktreeMcpFailure")
        ));
        (
            failure["code"].as_str().unwrap().to_owned(),
            failure["message"].as_str().unwrap().to_owned(),
        )
    }
}

/// The JSON Schema subset the advertised output schemas use.
fn conforms(schema: &Value, value: &Value, at: &str) -> Result<(), String> {
    if let Some(options) = schema["anyOf"].as_array() {
        return if options.iter().any(|o| conforms(o, value, at).is_ok()) {
            Ok(())
        } else {
            Err(format!("{at}: {value} matches no anyOf branch"))
        };
    }
    if let Some(allowed) = schema["enum"].as_array()
        && !allowed.contains(value)
    {
        return Err(format!("{at}: {value} not in {allowed:?}"));
    }
    let ok = match schema["type"].as_str() {
        Some("string") => value.is_string(),
        Some("integer") => value.is_i64() || value.is_u64(),
        Some("number") => value.is_number(),
        Some("boolean") => value.is_boolean(),
        Some("null") => value.is_null(),
        Some("array") => {
            for (i, item) in value.as_array().into_iter().flatten().enumerate() {
                conforms(&schema["items"], item, &format!("{at}[{i}]"))?;
            }
            value.is_array()
        }
        Some("object") => {
            let Some(object) = value.as_object() else {
                return Err(format!("{at}: {value} is not an object"));
            };
            for key in schema["required"].as_array().into_iter().flatten() {
                let key = key.as_str().unwrap();
                if !object.contains_key(key) {
                    return Err(format!("{at}: missing {key}"));
                }
            }
            for (key, property) in schema["properties"].as_object().into_iter().flatten() {
                if let Some(field) = object.get(key) {
                    conforms(property, field, &format!("{at}.{key}"))?;
                }
            }
            true
        }
        _ => true,
    };
    ok.then_some(())
        .ok_or_else(|| format!("{at}: {value} is not {}", schema["type"]))
}

#[test]
fn every_catalog_tool_has_a_handler_and_back() {
    let mut listed: Vec<&str> = catalog::names().collect();
    let mut handled = tools::HANDLED.to_vec();
    listed.sort_unstable();
    handled.sort_unstable();
    assert_eq!(listed, handled);
}

#[tokio::test(flavor = "current_thread")]
async fn transport_answers_as_the_typescript_server() {
    let f = fixture("transport");
    let service = &f.service;
    let swamp = client(true);
    let call = |method: Method, pairs: Vec<(&'static str, &'static str)>, body: &'static str| {
        let caller = swamp.clone();
        async move {
            let reply = service
                .handle(caller, &method, &headers(&pairs), body.as_bytes())
                .await;
            (reply.status, reply.body)
        }
    };
    let ping = r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#;
    assert_eq!(
        call(Method::GET, vec![], "").await.0,
        StatusCode::METHOD_NOT_ALLOWED
    );
    let mut with_origin = POST.to_vec();
    with_origin.push(("origin", "http://evil"));
    assert_eq!(
        call(Method::POST, with_origin, ping).await.0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(
            Method::POST,
            vec![("content-type", "text/plain"), POST[1]],
            ping
        )
        .await
        .0,
        StatusCode::UNSUPPORTED_MEDIA_TYPE
    );
    assert_eq!(
        call(
            Method::POST,
            vec![POST[0], ("accept", "application/json")],
            ping
        )
        .await
        .0,
        StatusCode::NOT_ACCEPTABLE
    );
    let (status, body) = call(Method::POST, POST.to_vec(), "{not json").await;
    assert_eq!(status, StatusCode::OK);
    assert!(body.unwrap().contains("\"code\":-32700"));
    assert_eq!(
        call(Method::POST, POST.to_vec(), "[]").await.0,
        StatusCode::BAD_REQUEST
    );
    let (status, body) = call(Method::POST, POST.to_vec(), ping).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(body.unwrap().contains("MCP-Session-Id header is required"));
    let mut unknown = POST.to_vec();
    unknown.push(("mcp-session-id", "nope"));
    assert_eq!(
        call(Method::POST, unknown, ping).await.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(Method::DELETE, vec![], "").await.0,
        StatusCode::BAD_REQUEST
    );

    let mut c = Client::open(service, swamp.clone()).await;
    let session = c.session.clone().unwrap();
    assert_eq!(c.request("ping", json!({})).await["result"], json!({}));
    let (status, body, _) = c
        .raw(json!({"jsonrpc": "2.0", "method": "notifications/initialized"}))
        .await;
    assert_eq!((status, body), (StatusCode::ACCEPTED, None));
    let list = c.request("tools/list", json!({})).await;
    let names: Vec<&str> = list["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    // An outside client is not offered the tools that act as a calling thread.
    let offered: Vec<_> = catalog::names()
        .filter(|name| catalog::offered(name, true))
        .collect();
    assert_eq!(names, offered);
    assert!(!names.contains(&"delegate_task"));
    assert_eq!(
        c.request("foo/bar", json!({})).await["error"]["message"],
        "Method not found: foo/bar"
    );
    let missing = c
        .request(
            "tools/call",
            json!({"name": "preview_open", "arguments": {}}),
        )
        .await;
    assert_eq!(missing["error"]["message"], "Tool 'preview_open' not found");
    let bogus = c
        .request(
            "tools/call",
            json!({"name": "t3_thread_list", "arguments": {"bogus": 1}}),
        )
        .await;
    assert_eq!(bogus["error"]["code"], -32602);
    assert!(
        bogus["error"]["message"].as_str().unwrap().starts_with(
            "Invalid parameters for tool 't3_thread_list': Unknown argument \"bogus\""
        )
    );
    let (code, _) = c
        .failure("t3_project_list", json!({"environmentId": "elsewhere"}))
        .await;
    assert_eq!(code, "capability_denied");
    c.ok("t3_project_list", json!({"environmentId": "env-test"}))
        .await;

    // A session answers only the credential that opened it.
    let other = Client {
        service,
        caller: client(false),
        session: Some(session.clone()),
        next_id: 1,
    };
    assert_eq!(
        other
            .raw(json!({"jsonrpc": "2.0", "id": 1, "method": "ping"}))
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    let mut close = vec![("mcp-session-id", session.as_str())];
    close.extend(POST);
    let reply = service
        .handle(swamp.clone(), &Method::DELETE, &headers(&close), b"")
        .await;
    assert_eq!(reply.status, StatusCode::NO_CONTENT);
    assert_eq!(
        c.raw(json!({"jsonrpc": "2.0", "id": 9, "method": "ping"}))
            .await
            .0,
        StatusCode::NOT_FOUND
    );
}

/// The calls Orbit's Swamp makes, in its order (README, "What Orbit needs").
#[tokio::test(flavor = "current_thread")]
async fn swamp_drives_a_thread_from_outside() {
    let f = fixture("swamp");
    let mut c = Client::open(&f.service, client(true)).await;

    let projects = c.ok("t3_project_list", json!({})).await;
    assert_eq!(projects["projects"][0]["workspaceRoot"], ROOT);
    let project = projects["projects"][0]["id"].as_str().unwrap().to_owned();
    assert_eq!(project, project_id());
    c.ok("t3_project_read", json!({"projectId": project})).await;
    c.ok("t3_environment_read", json!({})).await;

    let launch = json!({
        "projectId": project, "title": "Task", "message": "hello",
        "modelSelection": {"instanceId": "claudeAgent", "model": "claude-haiku-5-5", "options": {"effort": "low"}},
        "runtimeMode": "full-access", "interactionMode": "default",
        "workspaceStrategy": {"type": "root"}, "clientRequestId": "operation-1",
    });
    let launched = c.ok("t3_thread_launch", launch.clone()).await;
    let thread = launched["threadId"].as_str().unwrap().to_owned();
    assert!(
        launched["link"]
            .as_str()
            .unwrap()
            .starts_with("https://app.t3.codes/threads/env-test/")
    );
    let run = launched["runId"].as_str().unwrap().to_owned();
    // A retry with the same id returns the same run and starts no second turn.
    let again = c.ok("t3_thread_launch", launch).await;
    assert_eq!(
        (again["threadId"].as_str(), again["runId"].as_str()),
        (Some(thread.as_str()), Some(run.as_str()))
    );

    let waited = c
        .ok(
            "t3_thread_wait",
            json!({"threadId": thread, "runId": run, "timeoutMs": 10_000}),
        )
        .await;
    assert_eq!(
        (waited["status"].as_str(), waited["timedOut"].as_bool()),
        (Some("completed"), Some(false))
    );

    let read = c
        .ok(
            "t3_thread_read",
            json!({"threadId": thread, "view": "activity", "afterPosition": -1, "limit": 100}),
        )
        .await;
    let texts: Vec<&str> = read["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|i| i["text"].as_str())
        .collect();
    assert!(
        texts.contains(&"hello") && texts.contains(&"echo: hello"),
        "{texts:?}"
    );
    assert_eq!(read["thread"]["runCount"], 1);
    let first = read["items"][0]["position"].as_i64().unwrap();
    let rest = c
        .ok(
            "t3_thread_read",
            json!({"threadId": thread, "view": "activity", "afterPosition": first, "limit": 100}),
        )
        .await;
    assert_eq!(
        rest["items"].as_array().unwrap().len() + 1,
        read["items"].as_array().unwrap().len()
    );

    let sent = c
        .ok("t3_thread_send", json!({"threadId": thread, "message": "again", "mode": "queue", "clientRequestId": "operation-2"}))
        .await;
    assert_eq!(sent["delivery"], "started");
    let resent = c
        .ok("t3_thread_send", json!({"threadId": thread, "message": "again", "mode": "queue", "clientRequestId": "operation-2"}))
        .await;
    assert_eq!(resent["runId"], sent["runId"]);
    c.ok(
        "t3_thread_wait",
        json!({"threadId": thread, "runId": sent["runId"]}),
    )
    .await;
    let listed = c.ok("t3_thread_list", json!({"projectId": project})).await;
    assert_eq!(listed["total"], 1);
    assert_eq!(listed["threads"][0]["status"], "completed");
    let pending = c
        .ok(
            "t3_pending_request",
            json!({"action": "list", "threadId": thread}),
        )
        .await;
    assert_eq!(pending, json!({"requestIds": []}));
    assert_eq!(
        c.ok("t3_thread_interrupt", json!({"threadId": thread}))
            .await["status"],
        "no_active_run"
    );

    // Steer needs a running turn.
    let (code, _) = c
        .failure(
            "t3_thread_send",
            json!({"threadId": thread, "message": "nudge", "mode": "steer"}),
        )
        .await;
    assert_eq!(code, "thread_not_sendable");

    // Interrupt a running turn. A message queued meanwhile waits behind it.
    let hang = c
        .ok(
            "t3_thread_send",
            json!({"threadId": thread, "message": "hang"}),
        )
        .await;
    let busy = c
        .ok(
            "t3_thread_send",
            json!({"threadId": thread, "message": "busy", "mode": "queue"}),
        )
        .await;
    assert_eq!(busy["delivery"], "queued");
    assert_eq!(busy["status"], "queued");
    let timed_out = c
        .ok(
            "t3_thread_wait",
            json!({"threadId": thread, "runId": hang["runId"], "timeoutMs": 50}),
        )
        .await;
    assert_eq!(timed_out["timedOut"], true);
    let stopped = c
        .ok(
            "t3_thread_interrupt",
            json!({"threadId": thread, "runId": hang["runId"]}),
        )
        .await;
    assert_eq!(stopped["status"], "interrupt_requested");
    let ended = c
        .ok(
            "t3_thread_wait",
            json!({"threadId": thread, "runId": hang["runId"], "timeoutMs": 10_000}),
        )
        .await;
    assert_eq!(ended["status"], "interrupted");

    let renamed = c
        .ok(
            "t3_thread_update",
            json!({"threadId": thread, "action": "rename", "title": "Renamed"}),
        )
        .await;
    assert_eq!(renamed["title"], "Renamed");
    let found = c
        .ok(
            "t3_thread_search",
            json!({"query": "renam", "projectId": project}),
        )
        .await;
    assert_eq!(found["matches"][0]["threadId"], thread.as_str());
    let by_text = c
        .ok("t3_thread_search", json!({"query": "echo: hello"}))
        .await;
    assert_eq!(by_text["matches"][0]["source"], "assistant");
    let (code, _) = c
        .failure("t3_thread_read", json!({"threadId": "nope"}))
        .await;
    assert_eq!(code, "thread_not_found");
    not_offered(&mut c, "delegate_task", json!({"task": "x"})).await;
}

#[tokio::test(flavor = "current_thread")]
async fn a_read_only_client_cannot_write() {
    let f = fixture("readonly");
    let mut c = Client::open(&f.service, client(false)).await;
    c.ok("t3_thread_list", json!({"allProjects": true})).await;
    let (code, message) = c
        .failure(
            "t3_thread_launch",
            json!({"projectId": project_id(), "title": "x"}),
        )
        .await;
    assert_eq!(code, "capability_denied");
    assert!(message.contains("read-only"));
    let caps = c.ok("orchestrator_capabilities", json!({})).await;
    assert_eq!(caps["runtimeMode"], "approval-required");
}

/// An agent inside a thread: its credential, its own thread as the default target, and a
/// delegated child that wakes it when it ends.
#[tokio::test(flavor = "current_thread")]
async fn an_agent_delegates_a_task_and_is_woken() {
    let f = fixture("delegate");
    let mut swamp = Client::open(&f.service, client(true)).await;
    let parent = swamp
        .ok(
            "t3_thread_launch",
            json!({
                "projectId": project_id(), "title": "Parent", "message": "hang",
                "modelSelection": {"instanceId": "claudeAgent", "model": "claude-haiku-5-5"},
                "runtimeMode": "auto",
            }),
        )
        .await;
    let parent_id = parent["threadId"].as_str().unwrap().to_owned();
    swamp
        .ok(
            "t3_thread_wait",
            json!({"threadId": parent_id, "timeoutMs": 50}),
        )
        .await;

    let entry = f.service.issue_thread_credential(ThreadCredentialRequest {
        thread_id: parent_id.clone(),
        provider_instance_id: "claudeAgent".into(),
        subagent: false,
        preview: true,
    });
    assert_eq!(entry.url, "http://127.0.0.1:4711/mcp");
    let token = entry.authorization.strip_prefix("Bearer ").unwrap();
    let agent = Caller::Thread(f.service.resolve_thread_token(token).unwrap());
    assert!(f.service.resolve_thread_token("forged").is_none());
    assert_eq!(
        entry.claude_mcp_config()["mcpServers"]["t3-code"]["headers"]["Authorization"],
        entry.authorization.as_str()
    );

    let mut c = Client::open(&f.service, agent).await;
    let mine = c.ok("t3_thread_list", json!({})).await;
    assert_eq!(mine["currentThreadId"], parent_id.as_str());
    assert!(
        mine["threads"][0]["link"]
            .as_str()
            .unwrap()
            .starts_with("[Parent](t3-thread://v2/env-test/")
    );
    let caps = c.ok("orchestrator_capabilities", json!({})).await;
    assert_eq!(
        (
            caps["parentThreadId"].as_str(),
            caps["runtimeMode"].as_str()
        ),
        (Some(parent_id.as_str()), Some("auto"))
    );
    let (code, _) = c
        .failure(
            "delegate_task",
            json!({"task": "x", "runtimeMode": "full-access"}),
        )
        .await;
    assert_eq!(code, "runtime_mode_escalation_denied");

    let waited = c
        .ok(
            "delegate_task",
            json!({"task": "child work", "mode": "wait", "timeoutMs": 10_000}),
        )
        .await;
    assert_eq!(waited["status"], "completed");
    assert_eq!(waited["summary"], "echo: child work");
    assert!(waited.get("next").is_none());

    let task = c
        .ok(
            "delegate_task",
            json!({"task": "async work", "clientRequestId": "k1"}),
        )
        .await;
    let task_id = task["taskId"].as_str().unwrap().to_owned();
    assert_eq!(
        task["next"],
        "Completion wakes this thread. Do not wait on it or poll it. Continue other work, and end your turn when none is left."
    );
    let child = task["childThreadId"].as_str().unwrap().to_owned();
    c.ok(
        "t3_thread_wait",
        json!({"threadId": child, "timeoutMs": 10_000}),
    )
    .await;
    let status = c.ok("task_status", json!({"taskId": task_id})).await;
    assert_eq!(
        (status["status"].as_str(), status["workState"].as_str()),
        (Some("completed"), Some("result_available"))
    );
    assert_eq!(
        c.ok("task_cancel", json!({"taskId": task_id})).await["status"],
        "completed"
    );
    // Another thread cannot read this task.
    let mut stranger = Client::open(&f.service, swamp.caller.clone()).await;
    not_offered(&mut stranger, "task_status", json!({"taskId": task_id})).await;

    // The finished task woke the parent with a message queued behind its running turn, in
    // the transaction that ended the child's run (the engine's `delegated_task` wake).
    let parent_view = f
        .service
        .config
        .engine
        .get_thread_projection(parent_id.as_str().into())
        .await
        .unwrap();
    let wake = format!("Delegated task {task_id}");
    let woken = parent_view["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["text"].as_str().is_some_and(|t| t.starts_with(&wake)))
        .expect("a wake message");
    assert_eq!(woken["createdBy"], "agent");
    let child_view = f
        .service
        .config
        .engine
        .get_thread_projection(child.as_str().into())
        .await
        .unwrap();
    assert_eq!(
        child_view["thread"]["lineage"]["parentThreadId"],
        parent_id.as_str()
    );
    assert_eq!(
        child_view["thread"]["lineage"]["relationshipToParent"],
        "subagent"
    );
    f.service.revoke_thread(&parent_id);
    assert!(f.service.resolve_thread_token(token).is_none());
}

#[test]
fn credentials_expire_when_idle_and_stay_bounded() {
    let mut credentials = crate::credentials::Credentials::default();
    let request = || ThreadCredentialRequest {
        thread_id: "t".into(),
        provider_instance_id: "claudeAgent".into(),
        subagent: false,
        preview: true,
    };
    let (token, _) = credentials.issue(request());
    assert!(credentials.resolve(&token).is_some());
    credentials.age_all(Duration::from_secs(25 * 60 * 60));
    assert!(credentials.resolve(&token).is_none());
    credentials.touch("t");
    assert!(credentials.resolve(&token).is_some());
    for _ in 0..2000 {
        credentials.issue(request());
    }
    assert_eq!(credentials.len(), 1024);
}

/// Orbit freezes a container: on wake the wall clock jumped and the monotonic clock may not
/// have moved. Idle time on either clock counts, as T3's `idleMs` (`McpSessionRegistry.ts`).
#[test]
fn a_credential_counts_idle_time_the_wall_clock_shows_after_a_freeze() {
    let mut credentials = crate::credentials::Credentials::default();
    let (token, _) = credentials.issue(ThreadCredentialRequest {
        thread_id: "t".into(),
        provider_instance_id: "claudeAgent".into(),
        subagent: false,
        preview: true,
    });
    credentials.jump_wall(Duration::from_secs(10 * 60));
    assert!(credentials.resolve(&token).is_some(), "10 minutes: alive");
    credentials.jump_wall(Duration::from_secs(2 * 60 * 60));
    assert!(credentials.resolve(&token).is_some(), "2 hours: alive");
    credentials.jump_wall(Duration::from_secs(3 * 24 * 60 * 60));
    assert!(
        credentials.resolve(&token).is_none(),
        "3 days: idle too long"
    );
    assert!(credentials.resolve(&token).is_none(), "stays expired");
    credentials.touch("t");
    assert!(
        credentials.resolve(&token).is_some(),
        "the thread's next run"
    );
}

#[test]
fn sessions_stay_bounded() {
    let mut sessions = crate::sessions::Sessions::default();
    for _ in 0..1000 {
        sessions.open("o".into());
    }
    assert_eq!(sessions.len(), 256);
}

#[test]
fn caller_namespaces_key_idempotency_per_credential() {
    let thread = Caller::Thread(ThreadCaller {
        thread_id: "t".into(),
        provider_session_id: "p".into(),
        provider_instance_id: "claudeAgent".into(),
        subagent: false,
        preview: true,
    });
    assert_eq!(thread.namespace(), "p");
    assert_eq!(client(true).namespace(), "client:swamp");
}

/// Launches a thread from Swamp in the given modes with a first message; returns its id.
async fn launch_as_swamp(
    swamp: &mut Client<'_>,
    title: &str,
    message: &str,
    runtime: &str,
    interaction: &str,
) -> String {
    let launched = swamp
        .ok(
            "t3_thread_launch",
            json!({
                "projectId": project_id(), "title": title, "message": message,
                "modelSelection": {"instanceId": "claudeAgent", "model": "claude-haiku-5-5"},
                "runtimeMode": runtime, "interactionMode": interaction,
            }),
        )
        .await;
    launched["threadId"].as_str().unwrap().to_owned()
}

fn agent_of(f: &Fixture, thread_id: &str) -> Caller {
    let entry = f.service.issue_thread_credential(ThreadCredentialRequest {
        thread_id: thread_id.to_owned(),
        provider_instance_id: "claudeAgent".into(),
        subagent: false,
        preview: true,
    });
    let token = entry.authorization.strip_prefix("Bearer ").unwrap();
    Caller::Thread(f.service.resolve_thread_token(token).unwrap())
}

async fn dispatch(f: &Fixture, command: Value) {
    f.service
        .config
        .engine
        .dispatch(conn_contract::from_json(command).unwrap())
        .await
        .unwrap();
}

/// TS `writesThreads` and `writingCaller` (`McpToolAccess.ts`): a write from a thread
/// credential needs a live caller, and every target thread within the caller's modes.
#[tokio::test(flavor = "current_thread")]
async fn writes_need_a_live_caller_within_the_target_limits() {
    let f = fixture("live-caller");
    let mut swamp = Client::open(&f.service, client(true)).await;
    let full = launch_as_swamp(&mut swamp, "Full", "hang", "full-access", "default").await;
    let narrow = launch_as_swamp(&mut swamp, "Narrow", "hang", "approval-required", "plan").await;
    let mut agent = Client::open(&f.service, agent_of(&f, &narrow)).await;

    // A live caller below the target's modes is refused on every write tool.
    let respond = json!({"action": "respond", "threadId": full, "requestId": "r1", "answers": {}});
    for (tool, args) in [
        (
            "t3_thread_update",
            json!({"threadId": full, "action": "rename", "title": "pwned"}),
        ),
        ("t3_thread_send", json!({"threadId": full, "message": "x"})),
        ("t3_thread_interrupt", json!({"threadId": full})),
        ("t3_pending_request", respond),
    ] {
        let (code, _) = agent.failure(tool, args).await;
        assert_eq!(code, "runtime_mode_escalation_denied", "{tool}");
    }
    // Normal cases: its own thread, and a thread within its modes.
    let renamed = agent
        .ok(
            "t3_thread_update",
            json!({"action": "rename", "title": "Mine"}),
        )
        .await;
    assert_eq!(renamed["title"], "Mine");
    let (code, message) = agent
        .failure(
            "t3_pending_request",
            json!({"action": "respond", "requestId": "r1", "answers": {}}),
        )
        .await;
    assert_eq!(
        (code.as_str(), message.as_str()),
        (
            "invalid_request",
            "The pending user-input request was not found."
        )
    );
    let child = agent
        .ok(
            "t3_thread_launch",
            json!({"title": "Child", "message": "hang"}),
        )
        .await;
    let child = child["threadId"].as_str().unwrap().to_owned();
    agent
        .ok(
            "t3_thread_send",
            json!({"threadId": child, "message": "more", "mode": "queue"}),
        )
        .await;
    agent
        .ok("t3_thread_interrupt", json!({"threadId": child}))
        .await;
    let task = agent.ok("delegate_task", json!({"task": "hang"})).await;
    let task_id = task["taskId"].as_str().unwrap().to_owned();
    agent.ok("task_status", json!({"taskId": task_id})).await;
    assert_eq!(
        agent.ok("task_cancel", json!({"taskId": task_id})).await["status"],
        "cancel_requested"
    );

    // Archived: the credential still resolves, but the caller is no longer live.
    dispatch(
        &f,
        json!({"type": "thread.archive", "commandId": "archive-narrow", "threadId": narrow}),
    )
    .await;
    let dead = [
        ("t3_thread_launch", json!({"title": "Late"})),
        (
            "t3_thread_update",
            json!({"threadId": child, "action": "rename", "title": "x"}),
        ),
        (
            "t3_thread_update",
            json!({"action": "rename", "title": "x"}),
        ),
        ("t3_thread_send", json!({"threadId": child, "message": "x"})),
        ("t3_thread_interrupt", json!({"threadId": child})),
        (
            "t3_pending_request",
            json!({"action": "respond", "threadId": child, "requestId": "r1", "answers": {}}),
        ),
        ("delegate_task", json!({"task": "x"})),
        ("task_status", json!({"taskId": task_id})),
        ("task_cancel", json!({"taskId": task_id})),
    ];
    for (tool, args) in dead.clone() {
        let (code, message) = agent.failure(tool, args).await;
        assert_eq!(
            (code.as_str(), message.as_str()),
            (
                "parent_not_active",
                "The calling provider no longer owns an active thread run."
            ),
            "{tool}"
        );
    }
    // Reads stay open to it.
    agent.ok("t3_thread_read", json!({"threadId": child})).await;
    agent
        .ok(
            "t3_pending_request",
            json!({"action": "list", "threadId": child}),
        )
        .await;

    // A thread whose run ended is not live either.
    let idle = launch_as_swamp(&mut swamp, "Idle", "done", "full-access", "default").await;
    swamp
        .ok(
            "t3_thread_wait",
            json!({"threadId": idle, "timeoutMs": 10_000}),
        )
        .await;
    let mut idle_agent = Client::open(&f.service, agent_of(&f, &idle)).await;
    for (tool, args) in dead {
        let (code, _) = idle_agent.failure(tool, args).await;
        assert_eq!(code, "parent_not_active", "{tool}");
    }
}

/// Provisions a worktree the way the server's host answers, and records the request.
#[derive(Default)]
struct WorktreeHost {
    requests: std::sync::Mutex<Vec<conn_engine::WorktreeRequest>>,
}

impl conn_engine::EngineHost for WorktreeHost {
    fn provision_worktree(
        &self,
        request: conn_engine::WorktreeRequest,
    ) -> conn_engine::BoxFuture<'_, Result<conn_engine::ProvisionedWorktree, String>> {
        let branch = request.branch.clone().unwrap_or_else(|| "t3/abc123".into());
        let made = conn_engine::ProvisionedWorktree {
            path: format!("/tmp/conn-mcp-worktrees/{}", branch.replace('/', "-")),
            branch,
        };
        self.requests.lock().unwrap().push(request);
        Box::pin(std::future::ready(Ok(made)))
    }
}

/// `t3_thread_launch` with `workspaceStrategy: {type: "worktree"}` goes to the engine's
/// worktree launch, as the T3 server's does; the result has the same shape as a root launch.
#[tokio::test(flavor = "current_thread")]
async fn launch_prepares_a_worktree() {
    let host = Arc::new(WorktreeHost::default());
    let f = fixture_with_host("worktree", Some(host.clone()));
    let mut c = Client::open(&f.service, client(true)).await;
    let launched = c
        .ok(
            "t3_thread_launch",
            json!({
                "projectId": project_id(), "title": "Isolated", "message": "hello",
                "modelSelection": {"instanceId": "claudeAgent", "model": "claude-haiku-5-5"},
                "workspaceStrategy": {"type": "worktree", "baseRef": "main", "branch": "feature/x"},
                "clientRequestId": "wt-1",
            }),
        )
        .await;
    let thread = launched["threadId"].as_str().unwrap().to_owned();
    assert!(launched["runId"].is_string(), "{launched}");
    let requests = host.requests.lock().unwrap().clone();
    assert_eq!(requests.len(), 1);
    assert_eq!(
        (
            requests[0].base_ref.as_str(),
            requests[0].branch.as_deref(),
            requests[0].project_root.as_str()
        ),
        ("main", Some("feature/x"), ROOT)
    );
    let projection = f
        .service
        .config
        .engine
        .get_thread_projection(thread.as_str().into())
        .await
        .unwrap();
    assert_eq!(
        projection["thread"]["worktreePath"],
        "/tmp/conn-mcp-worktrees/feature-x"
    );
    assert_eq!(projection["thread"]["branch"], "feature/x");
    // A retry replays the first launch and makes no second worktree.
    c.ok(
        "t3_thread_launch",
        json!({
            "projectId": project_id(), "title": "Isolated", "message": "hello",
            "modelSelection": {"instanceId": "claudeAgent", "model": "claude-haiku-5-5"},
            "workspaceStrategy": {"type": "worktree", "baseRef": "main", "branch": "feature/x"},
            "clientRequestId": "wt-1",
        }),
    )
    .await;
    assert_eq!(host.requests.lock().unwrap().len(), 1);
}

/// A tool that acts as the calling thread is not offered to an outside client: as in
/// `apps/server` (`hiddenFromOutsideClients`), a call to it is "not found".
async fn not_offered(c: &mut Client<'_>, tool: &str, args: Value) {
    let (code, message) = rpc_error(c, tool, args).await;
    assert_eq!(
        (code, message.as_str()),
        (-32602, format!("Tool '{tool}' not found").as_str())
    );
}

/// The JSON-RPC error of a call the arguments check refused.
async fn rpc_error(c: &mut Client<'_>, tool: &str, args: Value) -> (i64, String) {
    let reply = c
        .request("tools/call", json!({"name": tool, "arguments": args}))
        .await;
    (
        reply["error"]["code"].as_i64().unwrap_or_default(),
        reply["error"]["message"]
            .as_str()
            .unwrap_or_default()
            .to_owned(),
    )
}

/// `send_to_user` (`toolkits/message`): `actsAsCaller`, so only a live thread caller; the
/// message is 1 to 4,000 UTF-16 units; the result echoes it as `sentMessage`.
#[tokio::test(flavor = "current_thread")]
async fn send_to_user_echoes_the_message_to_a_live_thread_caller() {
    let f = fixture("send-to-user");
    let mut swamp = Client::open(&f.service, client(true)).await;
    not_offered(&mut swamp, "send_to_user", json!({"message": "hi"})).await;
    let mut reader = Client::open(&f.service, client(false)).await;
    not_offered(&mut reader, "send_to_user", json!({"message": "hi"})).await;

    let live = launch_as_swamp(&mut swamp, "Live", "hang", "approval-required", "plan").await;
    let mut agent = Client::open(&f.service, agent_of(&f, &live)).await;
    let (code, message) = rpc_error(&mut agent, "send_to_user", json!({"message": ""})).await;
    assert_eq!(code, -32602, "{message}");
    // 4,000 UTF-16 units pass; one more fails. A CJK character is one unit, an emoji two.
    let long = "漢".repeat(4_000);
    let sent = agent.ok("send_to_user", json!({"message": long})).await;
    assert_eq!(sent["sentMessage"], long.as_str());
    let (code, _) = rpc_error(
        &mut agent,
        "send_to_user",
        json!({"message": "😀".repeat(2_001)}),
    )
    .await;
    assert_eq!(code, -32602);
    // Plan mode and the narrowest runtime mode may still use it: it touches only this thread.
    let sent = agent
        .ok(
            "send_to_user",
            json!({"message": "**Draft**\n\n```\ncode\n```"}),
        )
        .await;
    assert_eq!(
        sent,
        json!({"sentMessage": "**Draft**\n\n```\ncode\n```", "message": "Shown to the user. Don't repeat it."})
    );

    dispatch(
        &f,
        json!({"type": "thread.archive", "commandId": "archive-live", "threadId": live}),
    )
    .await;
    let (code, _) = agent
        .failure("send_to_user", json!({"message": "late"}))
        .await;
    assert_eq!(code, "parent_not_active");
}

/// Waits until the thread's provider turn runs, so its session is live.
async fn until_provider_turn(f: &Fixture, thread_id: &str) {
    for _ in 0..200 {
        let projection = f
            .service
            .config
            .engine
            .get_thread_projection(thread_id.into())
            .await
            .unwrap();
        let running = projection["providerTurns"]
            .as_array()
            .is_some_and(|turns| turns.iter().any(|t| t["status"] == "running"));
        if running && projection["thread"]["activeProviderThreadId"].is_string() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("no provider turn ran on {thread_id}");
}

/// `t3_background_wait` (`toolkits/orchestrator`): `actsAsCaller`; the calling thread's live
/// session marks the ids it runs, the rest come back unmatched; T3's codes and messages.
#[tokio::test(flavor = "current_thread")]
async fn background_wait_marks_the_callers_tasks() {
    let f = fixture("background-wait");
    let mut swamp = Client::open(&f.service, client(true)).await;
    let mut reader = Client::open(&f.service, client(false)).await;
    for c in [&mut swamp, &mut reader] {
        not_offered(c, "t3_background_wait", json!({"taskIds": ["bg-1"]})).await;
    }

    let live = launch_as_swamp(
        &mut swamp,
        "Live",
        "background-task-hang",
        "approval-required",
        "plan",
    )
    .await;
    until_provider_turn(&f, &live).await;
    let mut agent = Client::open(&f.service, agent_of(&f, &live)).await;
    // The argument check: 1 to 20 ids, none blank.
    let too_many: Vec<String> = (0..21).map(|i| format!("t{i}")).collect();
    for args in [
        json!({"taskIds": []}),
        json!({"taskIds": too_many}),
        json!({"taskIds": "bg-1"}),
        json!({"taskIds": ["bg-1"], "waiting": "yes"}),
    ] {
        let (code, message) = rpc_error(&mut agent, "t3_background_wait", args.clone()).await;
        assert_eq!(code, -32602, "{args}: {message}");
    }
    let (code, message) = rpc_error(
        &mut agent,
        "t3_background_wait",
        json!({"taskIds": ["bg-1", " "]}),
    )
    .await;
    assert_eq!(
        (code, message.as_str()),
        (
            -32602,
            "Invalid parameters for tool 't3_background_wait': Expected a non-blank string\n  at [\"taskIds\"][1]"
        )
    );

    // Plan mode and the narrowest runtime mode may use it: it marks only this thread's work.
    let marked = agent
        .ok("t3_background_wait", json!({"taskIds": [" bg-1 ", "x"]}))
        .await;
    assert_eq!(marked, json!({"matched": ["bg-1"], "unmatched": ["x"]}));
    let (code, message) = agent
        .failure("t3_background_wait", json!({"taskIds": ["x"]}))
        .await;
    assert_eq!(code, "invalid_request");
    assert!(message.starts_with("None of these IDs is running background work"));
    let cleared = agent
        .ok(
            "t3_background_wait",
            json!({"taskIds": ["x", "bg-1"], "waiting": false}),
        )
        .await;
    assert_eq!(cleared, json!({"matched": ["bg-1"], "unmatched": ["x"]}));

    dispatch(
        &f,
        json!({"type": "thread.archive", "commandId": "archive-live", "threadId": live}),
    )
    .await;
    let (code, _) = agent
        .failure("t3_background_wait", json!({"taskIds": ["bg-1"]}))
        .await;
    assert_eq!(code, "parent_not_active");
}

/// A provider without a background roster (Codex, Grok) answers `invalid_request`, as T3's
/// `unsupported` reason.
#[tokio::test(flavor = "current_thread")]
async fn background_wait_on_a_provider_without_a_roster() {
    let provider = FakeProvider::new("claudeAgent").without_background_wait();
    let f = fixture_with("background-wait-unsupported", None, provider);
    let mut swamp = Client::open(&f.service, client(true)).await;
    let live = launch_as_swamp(&mut swamp, "Live", "hang", "full-access", "default").await;
    until_provider_turn(&f, &live).await;
    let mut agent = Client::open(&f.service, agent_of(&f, &live)).await;
    let refused = agent
        .failure("t3_background_wait", json!({"taskIds": ["bg-1"]}))
        .await;
    assert_eq!(
        refused,
        (
            "invalid_request".to_owned(),
            "This provider cannot mark background work as awaited.".to_owned()
        )
    );
}

async fn thread_field(f: &Fixture, thread_id: &str, field: &str) -> Value {
    f.service
        .config
        .engine
        .get_thread_projection(thread_id.into())
        .await
        .unwrap()["thread"][field]
        .clone()
}

/// Polls until `field` of the thread equals `want`, for at most two seconds.
async fn until_field(f: &Fixture, thread_id: &str, field: &str, want: &Value) -> bool {
    for _ in 0..200 {
        if &thread_field(f, thread_id, field).await == want {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    false
}

/// `t3_thread_organize` (`toolkits/thread/handlers.ts`): `writesThreads([threadId])`, one
/// engine command per action, and the own agent's settle deferred to the end of its turn.
#[tokio::test(flavor = "current_thread")]
async fn organize_writes_as_the_typescript_server() {
    let f = fixture("organize");
    let mut swamp = Client::open(&f.service, client(true)).await;
    let full = launch_as_swamp(&mut swamp, "Full", "hang", "full-access", "default").await;
    let narrow = launch_as_swamp(&mut swamp, "Narrow", "hang", "approval-required", "plan").await;

    // Refusals first: a read-only client, a caller below the target's modes, a dead caller.
    let mut reader = Client::open(&f.service, client(false)).await;
    let (code, _) = reader
        .failure(
            "t3_thread_organize",
            json!({"threadId": full, "action": "pin"}),
        )
        .await;
    assert_eq!(code, "capability_denied");
    let mut agent = Client::open(&f.service, agent_of(&f, &narrow)).await;
    for action in ["pin", "archive", "settle", "mark_unread"] {
        let (code, _) = agent
            .failure(
                "t3_thread_organize",
                json!({"threadId": full, "action": action}),
            )
            .await;
        assert_eq!(code, "runtime_mode_escalation_denied", "{action}");
    }
    let (code, message) = agent
        .failure("t3_thread_organize", json!({"action": "snooze"}))
        .await;
    assert_eq!(
        (code.as_str(), message.as_str()),
        ("invalid_request", "snooze requires snoozedUntil.")
    );
    let (code, _) = swamp
        .failure("t3_thread_organize", json!({"action": "pin"}))
        .await;
    assert_eq!(code, "target_required");

    // Normal cases from outside: pin, unpin, archive, unarchive, snooze, unsnooze.
    let pinned = swamp
        .ok(
            "t3_thread_organize",
            json!({"threadId": full, "action": "pin"}),
        )
        .await;
    assert!(pinned["sequence"].as_u64().unwrap() > 0);
    assert!(thread_field(&f, &full, "pinnedAt").await.is_string());
    // Agents see it in the list and the read (`pinned: shell.pinnedAt != null`).
    let pinned_in = |list: &Value| {
        list["threads"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["threadId"] == full.as_str())
            .map(|t| t["pinned"].clone())
    };
    let list = swamp
        .ok("t3_thread_list", json!({"allProjects": true}))
        .await;
    assert_eq!(pinned_in(&list), Some(Value::Bool(true)));
    let read = swamp.ok("t3_thread_read", json!({"threadId": full})).await;
    assert_eq!(read["thread"]["pinned"], true);
    swamp
        .ok(
            "t3_thread_organize",
            json!({"threadId": full, "action": "unpin"}),
        )
        .await;
    assert!(thread_field(&f, &full, "pinnedAt").await.is_null());
    let list = swamp
        .ok("t3_thread_list", json!({"allProjects": true}))
        .await;
    assert_eq!(pinned_in(&list), Some(Value::Bool(false)));
    swamp
        .ok(
            "t3_thread_organize",
            json!({"threadId": full, "action": "snooze", "snoozedUntil": "2099-01-01T00:00:00.000Z"}),
        )
        .await;
    assert!(thread_field(&f, &full, "snoozedUntil").await.is_string());
    swamp
        .ok(
            "t3_thread_organize",
            json!({"threadId": full, "action": "unsnooze"}),
        )
        .await;
    assert!(thread_field(&f, &full, "snoozedUntil").await.is_null());
    // A running thread cannot settle from outside: the engine refuses.
    let (code, _) = swamp
        .failure(
            "t3_thread_organize",
            json!({"threadId": full, "action": "settle"}),
        )
        .await;
    assert_eq!(code, "orchestration_error");

    // The own agent settles mid-turn: the answer says when, and the thread settles once the
    // turn completes (a steer completes the fake turn).
    let mut own = Client::open(&f.service, agent_of(&f, &narrow)).await;
    let deferred = own
        .ok("t3_thread_organize", json!({"action": "settle"}))
        .await;
    assert_eq!(deferred, json!({"settlesWhenTurnEnds": true}));
    // A second request while one waits adds no second waiter.
    own.ok("t3_thread_organize", json!({"action": "settle"}))
        .await;
    assert_eq!(crate::lock(&f.service.settling).len(), 1);
    assert!(thread_field(&f, &narrow, "settledAt").await.is_null());
    swamp
        .ok(
            "t3_thread_send",
            json!({"threadId": narrow, "message": "finish", "mode": "steer"}),
        )
        .await;
    assert!(until_field(&f, &narrow, "settledOverride", &json!("settled")).await);
    assert!(thread_field(&f, &narrow, "settledAt").await.is_string());
    for _ in 0..100 {
        if crate::lock(&f.service.settling).is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(crate::lock(&f.service.settling).is_empty());

    // An interrupted turn does not settle.
    let other = launch_as_swamp(&mut swamp, "Other", "hang", "auto", "default").await;
    let mut other_agent = Client::open(&f.service, agent_of(&f, &other)).await;
    other_agent
        .ok("t3_thread_organize", json!({"action": "settle"}))
        .await;
    swamp
        .ok("t3_thread_interrupt", json!({"threadId": other}))
        .await;
    for _ in 0..100 {
        if crate::lock(&f.service.settling).is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(crate::lock(&f.service.settling).is_empty());
    assert_ne!(thread_field(&f, &other, "settledOverride").await, "settled");

    // Archived: the caller is no longer live.
    dispatch(
        &f,
        json!({"type": "thread.archive", "commandId": "archive-other", "threadId": other}),
    )
    .await;
    let (code, _) = other_agent
        .failure("t3_thread_organize", json!({"action": "unarchive"}))
        .await;
    assert_eq!(code, "parent_not_active");
}

/// `t3_queue` and `t3_thread_configure` (`toolkits/thread/handlers.ts`): reads are open, writes
/// take `writesThreads([threadId])`; queue writes are the engine's queued-run commands.
#[tokio::test(flavor = "current_thread")]
async fn queue_and_configure_follow_the_typescript_server() {
    let f = fixture("queue");
    let mut swamp = Client::open(&f.service, client(true)).await;
    let full = launch_as_swamp(&mut swamp, "Full", "hang", "full-access", "default").await;
    let narrow = launch_as_swamp(&mut swamp, "Narrow", "hang", "approval-required", "plan").await;
    let mut queued = Vec::new();
    for text in ["first", "second", &"x".repeat(1_200)] {
        let sent = swamp
            .ok(
                "t3_thread_send",
                json!({"threadId": full, "message": text, "mode": "queue"}),
            )
            .await;
        queued.push(sent["runId"].as_str().unwrap().to_owned());
    }

    // Refusals first: a read-only client and a narrower agent may read but not write.
    let mut reader = Client::open(&f.service, client(false)).await;
    reader
        .ok("t3_queue", json!({"threadId": full, "action": "list"}))
        .await;
    let (code, _) = reader
        .failure(
            "t3_queue",
            json!({"threadId": full, "action": "cancel", "queuedRunId": queued[0]}),
        )
        .await;
    assert_eq!(code, "capability_denied");
    let mut agent = Client::open(&f.service, agent_of(&f, &narrow)).await;
    let read = agent
        .ok("t3_thread_configure", json!({"threadId": full}))
        .await;
    assert_eq!(read["runtimeMode"], "full-access");
    for (tool, args) in [
        (
            "t3_queue",
            json!({"threadId": full, "action": "cancel", "queuedRunId": queued[0]}),
        ),
        (
            "t3_thread_configure",
            json!({"threadId": full, "modelSelection": {"instanceId": "claudeAgent", "model": "claude-haiku-5-5"}}),
        ),
    ] {
        let (code, _) = agent.failure(tool, args).await;
        assert_eq!(code, "runtime_mode_escalation_denied", "{tool}");
    }
    let (code, message) = swamp
        .failure(
            "t3_queue",
            json!({"threadId": full, "action": "edit", "queuedRunId": queued[0]}),
        )
        .await;
    assert_eq!(
        (code.as_str(), message.as_str()),
        ("invalid_request", "This action needs `text`.")
    );

    // Reads: send order, paging, the 1,000-character list cut and the 16,000 read cut.
    let list = swamp
        .ok(
            "t3_queue",
            json!({"threadId": full, "action": "list", "limit": 2}),
        )
        .await;
    let ids: Vec<&str> = list["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["queuedRunId"].as_str().unwrap())
        .collect();
    assert_eq!(ids, [queued[0].as_str(), queued[1].as_str()]);
    assert_eq!(list["nextCursor"], 2);
    let rest = swamp
        .ok(
            "t3_queue",
            json!({"threadId": full, "action": "list", "cursor": 2}),
        )
        .await;
    assert_eq!(rest["items"][0]["text"].as_str().unwrap().len(), 1_000);
    assert_eq!(rest["items"][0]["truncated"], true);
    assert_eq!(rest["nextCursor"], Value::Null);
    let one = swamp
        .ok(
            "t3_queue",
            json!({"threadId": full, "action": "read", "queuedRunId": queued[2]}),
        )
        .await;
    assert_eq!(
        (one["text"].as_str().unwrap().len(), &one["truncated"]),
        (1_200, &json!(false))
    );

    // Writes: edit, reorder to the end with null, cancel; each answers its sequence.
    swamp
        .ok(
            "t3_queue",
            json!({"threadId": full, "action": "edit", "queuedRunId": queued[0], "text": "edited"}),
        )
        .await;
    let edited = swamp
        .ok(
            "t3_queue",
            json!({"threadId": full, "action": "read", "queuedRunId": queued[0]}),
        )
        .await;
    assert_eq!(edited["text"], "edited");
    let moved = swamp
        .ok(
            "t3_queue",
            json!({"threadId": full, "action": "reorder", "queuedRunId": queued[0], "beforeRunId": null}),
        )
        .await;
    assert!(moved["sequence"].as_u64().unwrap() > 0);
    let order = swamp
        .ok("t3_queue", json!({"threadId": full, "action": "list"}))
        .await;
    assert_eq!(order["items"][2]["queuedRunId"], queued[0].as_str());
    swamp
        .ok(
            "t3_queue",
            json!({"threadId": full, "action": "cancel", "queuedRunId": queued[1]}),
        )
        .await;
    let (code, _) = swamp
        .failure(
            "t3_queue",
            json!({"threadId": full, "action": "cancel", "queuedRunId": queued[1]}),
        )
        .await;
    assert_eq!(code, "orchestration_error");
    let left = swamp
        .ok("t3_queue", json!({"threadId": full, "action": "list"}))
        .await;
    assert_eq!(left["items"].as_array().unwrap().len(), 2);

    // configure: the same provider instance sets the model.
    swamp
        .ok(
            "t3_thread_configure",
            json!({"threadId": full, "modelSelection": {"instanceId": "claudeAgent", "model": "claude-sonnet-5-5"}}),
        )
        .await;
    let read = swamp
        .ok("t3_thread_configure", json!({"threadId": full}))
        .await;
    assert_eq!(read["modelSelection"]["model"], "claude-sonnet-5-5");
}

/// `t3_thread_search` on the engine's message index (`searchThreads` in `ThreadSearch.ts`):
/// title hits first, then one message hit per other thread, with a fifth of the slots kept
/// for message hits; subagent and archived threads stay out.
#[tokio::test(flavor = "current_thread")]
async fn search_puts_titles_first_and_keeps_slots_for_messages() {
    let f = fixture("search");
    let mut swamp = Client::open(&f.service, client(true)).await;
    let mut by_title = Vec::new();
    for i in 0..6 {
        by_title.push(
            launch_as_swamp(
                &mut swamp,
                &format!("Zebra plan {i}"),
                "hello",
                "full-access",
                "default",
            )
            .await,
        );
    }
    let by_message = launch_as_swamp(
        &mut swamp,
        "Other",
        "zebra stripes today",
        "full-access",
        "default",
    )
    .await;
    let archived = launch_as_swamp(
        &mut swamp,
        "Gone",
        "zebra in an archived thread",
        "full-access",
        "default",
    )
    .await;
    for thread in by_title.iter().chain([&by_message, &archived]) {
        swamp
            .ok(
                "t3_thread_wait",
                json!({"threadId": thread, "timeoutMs": 10_000}),
            )
            .await;
    }
    dispatch(
        &f,
        json!({"type": "thread.archive", "commandId": "archive-gone", "threadId": archived}),
    )
    .await;

    let found = swamp
        .ok(
            "t3_thread_search",
            json!({"query": "zebra", "projectId": project_id()}),
        )
        .await;
    let rows: Vec<(&str, &str)> = found["matches"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| {
            (
                m["threadId"].as_str().unwrap(),
                m["source"].as_str().unwrap(),
            )
        })
        .collect();
    assert_eq!(rows.len(), 7, "{found}");
    assert!(rows[..6].iter().all(|(_, source)| *source == "title"));
    // The message hit comes from the index, with a snippet and the time. The engine takes
    // each thread's newest hit (the fake's echo); T3 ranks by match quality and then prefers
    // the user's words (`compareHits`): a known gap in the engine's search, not in this tool.
    assert_eq!(rows[6], (by_message.as_str(), "assistant"));
    let hit = &found["matches"][6];
    assert_eq!(hit["snippet"], "echo: zebra stripes today");
    assert!(hit["messageCreatedAt"].is_string());
    assert_eq!(hit["title"], "Other");
    // limit 5: one slot of five stays for the message hit.
    let found = swamp
        .ok(
            "t3_thread_search",
            json!({"query": "zebra", "limit": 5, "projectId": project_id()}),
        )
        .await;
    let sources: Vec<&str> = found["matches"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["source"].as_str().unwrap())
        .collect();
    assert_eq!(sources, ["title", "title", "title", "title", "assistant"]);
    // limit 4: no slot (4 / 5 = 0), titles only.
    let found = swamp
        .ok("t3_thread_search", json!({"query": "zebra", "limit": 4}))
        .await;
    assert!(
        found["matches"]
            .as_array()
            .unwrap()
            .iter()
            .all(|m| m["source"] == "title")
    );
    // Another project's scope finds nothing.
    let found = swamp
        .ok(
            "t3_thread_search",
            json!({"query": "zebra", "projectId": "project:other"}),
        )
        .await;
    assert_eq!(found["matches"], json!([]));
}

/// Tools that a text we send to an agent names and that this server does not serve. An agent
/// told to call one finds no such tool. Serve one, and this test makes you strike it here.
/// `preview_*` in the orchestration text also names all 13 preview tools.
const NAMED_NOT_SERVED: &[&str] = &[
    "ci_logs",
    "ci_rerun",
    "device_list",
    "device_open",
    "device_screenshot",
    "fill_credential",
    "link_issue",
    "pull_request_create",
    "t3_environment_link",
    "t3_environment_links",
];

/// Every text we send to an agent that can name a tool: the orchestration text and Claude's
/// texts (`conn-mcp`), the `next` text of a running task, the Codex additional context
/// (`conn-provider-codex`), the pull request text (`conn-provider-claude`), the ACP prompt
/// prefixes (`conn-provider-acp`), and the served tools' own descriptions.
fn agent_texts() -> Vec<&'static str> {
    vec![
        crate::AGENT_INSTRUCTIONS,
        crate::CLAUDE_INSTRUCTIONS,
        include_str!("running-task-next.txt"),
        include_str!("../../conn-provider-codex/src/instructions.rs"),
        include_str!("../../conn-provider-claude/src/launch.rs"),
        include_str!("../../conn-provider-acp/src/instructions.rs"),
        include_str!("catalog.jsonl"),
    ]
}

fn names_word(text: &str, name: &str) -> bool {
    let word = |c: char| c.is_ascii_alphanumeric() || c == '_';
    text.match_indices(name).any(|(at, _)| {
        let before = text.get(..at).and_then(|s| s.chars().last());
        let after = text.get(at + name.len()..).and_then(|s| s.chars().next());
        !before.is_some_and(word) && !after.is_some_and(word)
    })
}

#[test]
fn agent_texts_name_only_known_unserved_tools() {
    // Every tool apps/server registers, whoever may see it (`tools/gen-tools.mjs`).
    let all: Vec<String> = include_str!("../fixtures/t3-tool-names.txt")
        .lines()
        .map(str::to_owned)
        .collect();
    let served: Vec<&str> = catalog::names().collect();
    let texts = agent_texts();
    let mut named: Vec<&str> = all
        .iter()
        .map(String::as_str)
        .filter(|name| !served.contains(name))
        .filter(|name| texts.iter().any(|text| names_word(text, name)))
        .collect();
    named.sort_unstable();
    let mut expected: Vec<&str> = NAMED_NOT_SERVED.to_vec();
    expected.sort_unstable();
    assert_eq!(named, expected);
}

/// [`fixture`] with scheduled tasks on the same engine, their timer parked.
async fn fixture_with_tasks(name: &str) -> Fixture {
    let base = fixture(name);
    let engine = base.service.config.engine.clone();
    let tasks = conn_features::scheduled::ScheduledTasks::start(conn_features::scheduled::Config {
        state_dir: base.dir.clone(),
        clock: Arc::new(conn_features::clock::SystemClock),
        zone: jiff::tz::TimeZone::UTC,
        runner: Arc::new(conn_features::scheduled::EngineRunner::new(engine.clone())),
        secret_requests: base.service.config.secrets.clone(),
        start_timer: false,
    })
    .await;
    let config = &base.service.config;
    let service = McpService::new(McpConfig {
        preview: None,
        refresh_provider: None,
        worktrees: None,
        panels: Some(conn_features::panels::PanelBroker::default()),
        pull_requests: None,
        secrets: config.secrets.clone(),
        test_logins: base.service.config.test_logins.clone(),
        engine,
        environment_id: config.environment_id.clone(),
        label: config.label.clone(),
        server_version: config.server_version.clone(),
        platform: config.platform.clone(),
        providers: config.providers.clone(),
        hosted_app_url: config.hosted_app_url.clone(),
        scheduled_tasks: Some(tasks),
        files: config.files.clone(),
        annotations: Some(conn_features::annotations::Annotations::new(
            &base.dir,
            Arc::new(conn_features::clock::SystemClock),
            Arc::new(conn_features::annotations::EngineProjects(
                config.engine.clone(),
            )),
        )),
    });
    service.set_listen_address("0.0.0.0:4711".parse().unwrap());
    let dir = base.dir.clone();
    std::mem::forget(base);
    Fixture { service, dir }
}

/// The access rules of the scheduled task tools (`schedule_task` is `either(startsThreads,
/// writes)`, `list_scheduled_tasks` `reads`, `delete_scheduled_task` `writes`,
/// `run_scheduled_task_now` `writesEnvironment`), each refusal before the handler runs.
#[tokio::test(flavor = "current_thread")]
async fn scheduled_task_tools_refuse_as_the_typescript_server() {
    let f = fixture_with_tasks("scheduled-refusals").await;
    let read_only =
        "This tool changes the environment, and this MCP client was approved for read-only access.";
    let mut reader = Client::open(&f.service, client(false)).await;
    let schedule = json!({"type": "interval", "everyMs": 60_000});
    for (tool, args) in [
        (
            "schedule_task",
            json!({"projectId": project_id(), "prompt": "p", "schedule": schedule}),
        ),
        (
            "schedule_task",
            json!({"scheduledTaskId": "scheduled-task:x", "enabled": false}),
        ),
        (
            "delete_scheduled_task",
            json!({"scheduledTaskId": "scheduled-task:x"}),
        ),
        (
            "run_scheduled_task_now",
            json!({"taskId": "scheduled-task:x"}),
        ),
    ] {
        assert_eq!(
            reader.failure(tool, args).await,
            ("capability_denied".to_owned(), read_only.to_owned()),
            "{tool}"
        );
    }
    // Reads need nothing.
    assert_eq!(
        reader.ok("list_scheduled_tasks", json!({})).await,
        json!({"tasks": []})
    );

    let mut swamp = Client::open(&f.service, client(true)).await;
    assert_eq!(
        swamp
            .failure("schedule_task", json!({"projectId": project_id()}))
            .await,
        (
            "invalid_request".to_owned(),
            "A new scheduled task needs `prompt` and `schedule`.".to_owned()
        )
    );
    assert_eq!(
        swamp
            .failure(
                "schedule_task",
                json!({"prompt": "p", "schedule": schedule})
            )
            .await,
        (
            "target_required".to_owned(),
            "Pass projectId: this MCP client is not running inside a T3 thread.".to_owned()
        )
    );
    assert_eq!(
        swamp
            .failure("schedule_task", json!({"projectId": project_id(), "prompt": "p", "schedule": schedule, "bindToCurrentThread": true}))
            .await,
        ("invalid_request".to_owned(), "bindToCurrentThread needs an agent running inside a T3 thread.".to_owned())
    );
    assert_eq!(
        swamp
            .failure(
                "schedule_task",
                json!({"projectId": "project:none", "prompt": "p", "schedule": schedule})
            )
            .await,
        (
            "invalid_request".to_owned(),
            "Project project:none was not found.".to_owned()
        )
    );
    assert_eq!(
        swamp
            .failure(
                "schedule_task",
                json!({"projectId": project_id(), "prompt": "p", "schedule": schedule})
            )
            .await
            .0,
        "invalid_request",
        "a project without a default model"
    );
    assert_eq!(
        swamp
            .failure(
                "delete_scheduled_task",
                json!({"scheduledTaskId": "scheduled-task:x"})
            )
            .await,
        (
            "task_not_found".to_owned(),
            "Scheduled task scheduled-task:x was not found.".to_owned()
        )
    );
    assert_eq!(
        swamp
            .failure(
                "run_scheduled_task_now",
                json!({"taskId": "scheduled-task:x"})
            )
            .await,
        (
            "invalid_request".to_owned(),
            "The scheduled task was not found.".to_owned()
        )
    );

    // A thread caller whose run ended cannot write.
    let idle = launch_as_swamp(&mut swamp, "Idle", "done", "full-access", "default").await;
    let mut idle_agent = Client::open(&f.service, agent_of(&f, &idle)).await;
    let mut ended = false;
    for _ in 0..200 {
        let projection = f
            .service
            .config
            .engine
            .get_thread_projection(idle.as_str().into())
            .await
            .unwrap();
        if !projection["runs"].as_array().unwrap().is_empty() && !tools::has_active_run(&projection)
        {
            ended = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(ended, "the idle thread's run ended");
    assert_eq!(
        idle_agent
            .failure(
                "schedule_task",
                json!({"prompt": "p", "schedule": schedule})
            )
            .await
            .0,
        "parent_not_active"
    );
    // A live caller below full access may schedule, but not run a task now.
    let narrow =
        launch_as_swamp(&mut swamp, "Narrow", "hang", "approval-required", "default").await;
    let mut narrow_agent = Client::open(&f.service, agent_of(&f, &narrow)).await;
    let created = narrow_agent
        .ok(
            "schedule_task",
            json!({"prompt": "Check progress", "schedule": schedule}),
        )
        .await;
    assert_eq!(
        created["boundThreadId"],
        json!(narrow),
        "bound in its own project"
    );
    let id = created["scheduledTaskId"].as_str().unwrap().to_owned();
    assert_eq!(
        narrow_agent
            .failure("run_scheduled_task_now", json!({"taskId": id}))
            .await,
        ("capability_denied".to_owned(), FULL_ACCESS.to_owned())
    );
    // A task that runs broader than the caller cannot be changed by it.
    let full = launch_as_swamp(&mut swamp, "Full", "hang", "full-access", "default").await;
    let mut full_agent = Client::open(&f.service, agent_of(&f, &full)).await;
    let broad = full_agent
        .ok(
            "schedule_task",
            json!({"prompt": "Broad", "schedule": schedule}),
        )
        .await;
    let broad_id = broad["scheduledTaskId"].as_str().unwrap();
    for (tool, args) in [
        (
            "schedule_task",
            json!({"scheduledTaskId": broad_id, "enabled": false}),
        ),
        (
            "delete_scheduled_task",
            json!({"scheduledTaskId": broad_id}),
        ),
    ] {
        assert_eq!(
            narrow_agent.failure(tool, args).await.0,
            "runtime_mode_escalation_denied",
            "{tool}"
        );
    }
}

const FULL_ACCESS: &str = "Changing projects or environment settings needs a live full-access/default calling thread or a full-access client.";

/// The normal path: an agent schedules work in its thread, edits it, a client runs it now
/// (queued behind the busy thread), and deletes it.
#[tokio::test(flavor = "current_thread")]
async fn an_agent_schedules_edits_and_a_client_runs_and_deletes_a_task() {
    let f = fixture_with_tasks("scheduled-flow").await;
    let mut swamp = Client::open(&f.service, client(true)).await;
    let busy = launch_as_swamp(&mut swamp, "Busy", "hang", "full-access", "default").await;
    let mut agent = Client::open(&f.service, agent_of(&f, &busy)).await;
    let created = agent
        .ok(
            "schedule_task",
            json!({"prompt": "Check progress\nand report", "schedule": {"type": "fixed_time", "timeOfDay": "09:00"},
                   "clientRequestId": "k1"}),
        )
        .await;
    assert_eq!(
        created["title"], "Check progress",
        "title from the first line"
    );
    assert_eq!(created["freshSession"], false);
    assert_eq!(created["lastRunStatus"], "never");
    assert!(created["nextRunAt"].is_string(), "{created}");
    let id = created["scheduledTaskId"].as_str().unwrap().to_owned();
    assert!(id.starts_with("scheduled-task:command:mcp:"), "{id}");
    // The same clientRequestId replays onto the same task.
    let again = agent
        .ok("schedule_task", json!({"prompt": "Check progress", "schedule": {"type": "fixed_time", "timeOfDay": "09:00"}, "clientRequestId": "k1"}))
        .await;
    assert_eq!(again["scheduledTaskId"], json!(id));
    // A task that starts new threads gets a worktree from the default branch.
    let unbound = agent
        .ok("schedule_task", json!({"prompt": "Nightly", "schedule": {"type": "interval", "everyMs": 3_600_000}, "bindToCurrentThread": false}))
        .await;
    assert_eq!(unbound["boundThreadId"], Value::Null);
    let edited = agent
        .ok(
            "schedule_task",
            json!({"scheduledTaskId": id, "title": "Renamed", "enabled": false}),
        )
        .await;
    assert_eq!(
        (
            edited["title"].clone(),
            edited["enabled"].clone(),
            edited["nextRunAt"].clone()
        ),
        (json!("Renamed"), json!(false), Value::Null)
    );
    let listed = agent.ok("list_scheduled_tasks", json!({})).await;
    assert_eq!(listed["tasks"].as_array().unwrap().len(), 2);
    let ran = swamp
        .ok("run_scheduled_task_now", json!({"taskId": id}))
        .await;
    assert_eq!(ran["threadId"], json!(busy));
    assert_eq!(
        (ran["lastRunStatus"].clone(), ran["runCount"].clone()),
        (json!("succeeded"), json!(1))
    );
    assert!(ran["link"].is_string(), "{ran}");
    let deleted = swamp
        .ok("delete_scheduled_task", json!({"scheduledTaskId": id}))
        .await;
    assert_eq!(deleted, json!({"scheduledTaskId": id, "deleted": true}));
    assert_eq!(
        agent.ok("list_scheduled_tasks", json!({})).await["tasks"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

/// Own finding A: a task bound to a thread whose read fails is refused, as T3's
/// `scheduledTaskRunModes` fails on a read error; only a missing or deleted thread is skipped.
#[tokio::test(flavor = "current_thread")]
async fn a_task_whose_bound_thread_cannot_be_read_is_refused() {
    let f = fixture_with_tasks("scheduled-broken-thread").await;
    let mut swamp = Client::open(&f.service, client(true)).await;
    let bound = launch_as_swamp(&mut swamp, "Bound", "hang", "full-access", "default").await;
    let mut agent = Client::open(&f.service, agent_of(&f, &bound)).await;
    let created = agent
        .ok(
            "schedule_task",
            json!({"prompt": "Check", "schedule": {"type": "interval", "everyMs": 3_600_000}}),
        )
        .await;
    let id = created["scheduledTaskId"].as_str().unwrap().to_owned();
    assert_eq!(created["boundThreadId"], json!(bound));
    rusqlite::Connection::open(f.dir.join("engine.sqlite"))
        .unwrap()
        .execute(
            "UPDATE threads SET thread = '{not json' WHERE id = ?1",
            [&bound],
        )
        .unwrap();
    assert_eq!(
        swamp
            .failure(
                "schedule_task",
                json!({"scheduledTaskId": id, "enabled": false})
            )
            .await,
        (
            "orchestration_error".to_owned(),
            "T3 Code could not complete this request.".to_owned()
        )
    );
}

fn annotation(id: &str, comment: &str) -> conn_contract::AnnotationCapture {
    conn_contract::from_json(json!({"id": id, "comment": comment})).unwrap()
}

/// A failure the annotation toolkit renders as plain text.
async fn plain_failure(c: &mut Client<'_>, tool: &str, args: Value) -> String {
    let reply = c
        .request("tools/call", json!({"name": tool, "arguments": args}))
        .await;
    assert_eq!(reply["result"]["isError"], true, "{tool}: {reply}");
    reply["result"]["content"][0]["text"]
        .as_str()
        .unwrap()
        .to_owned()
}

/// `claims, completes and releases the calling thread's annotations`
/// (`McpAnnotationsToolkit.test.ts`).
#[tokio::test(flavor = "current_thread")]
async fn annotation_tools_claim_complete_and_release_the_callers_annotations() {
    let f = fixture_with_tasks("annotations-flow").await;
    let store = f.service.config.annotations.clone().unwrap();
    let mut first = annotation("first", "Make the button bigger");
    first.screenshot = Some(format!(
        "data:image/jpeg;base64,{}",
        conn_support::base64::encode(b"jpeg")
    ));
    store.create(&project_id(), first).await.unwrap();
    store
        .create(&project_id(), annotation("second", "Which font?"))
        .await
        .unwrap();
    let mut swamp = Client::open(&f.service, client(true)).await;
    let thread = launch_as_swamp(&mut swamp, "Agent", "hang", "full-access", "default").await;
    let mut agent = Client::open(&f.service, agent_of(&f, &thread)).await;

    let claimed = agent.ok("annotations_claim", json!({})).await;
    let record = &claimed["annotation"];
    assert_eq!(
        (
            record["id"].clone(),
            record["number"].clone(),
            record["status"].clone()
        ),
        (json!("first"), json!(1), json!("in_progress"))
    );
    assert!(
        record["screenshotPath"]
            .as_str()
            .unwrap()
            .ends_with("first.jpg"),
        "{record}"
    );
    let done = agent
        .ok(
            "annotations_complete",
            json!({"id": "first", "summary": "Bigger button; lint passes."}),
        )
        .await;
    assert_eq!(done["annotation"]["status"], "done");
    assert_eq!(done["annotation"]["summary"], "Bigger button; lint passes.");
    agent.ok("annotations_claim", json!({"id": "second"})).await;
    let asked = agent
        .ok(
            "annotations_release",
            json!({"id": "second", "question": true, "summary": "Serif or sans?"}),
        )
        .await;
    assert_eq!(
        (
            asked["annotation"]["status"].clone(),
            asked["annotation"]["question"].clone()
        ),
        (json!("todo"), json!(true))
    );
    assert_eq!(
        agent.ok("annotations_claim", json!({})).await,
        json!({"annotation": null})
    );
    let open = agent.ok("annotations_list", json!({})).await;
    let ids: Vec<&str> = open["annotations"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["second"]);
    let all = agent.ok("annotations_list", json!({"all": true})).await;
    assert_eq!(all["annotations"].as_array().unwrap().len(), 2);
}

/// `reports a conflict and refuses callers outside a thread`.
#[tokio::test(flavor = "current_thread")]
async fn annotation_tools_report_a_conflict_and_refuse_callers_outside_a_thread() {
    let f = fixture_with_tasks("annotations-refuse").await;
    let store = f.service.config.annotations.clone().unwrap();
    store
        .create(&project_id(), annotation("only", "Fix the header"))
        .await
        .unwrap();
    let mut swamp = Client::open(&f.service, client(true)).await;
    let thread = launch_as_swamp(&mut swamp, "Agent", "hang", "full-access", "default").await;
    let mut agent = Client::open(&f.service, agent_of(&f, &thread)).await;
    let reply = agent
        .request(
            "tools/call",
            json!({"name": "annotations_complete", "arguments": {"id": "only", "summary": "Done"}}),
        )
        .await;
    assert_eq!(reply["result"]["isError"], true);
    assert_eq!(
        reply["result"]["content"][0]["text"],
        "Annotation only is todo; it must be in_progress. Read the list again."
    );
    for tool in ["annotations_claim", "annotations_list"] {
        not_offered(&mut swamp, tool, json!({})).await;
    }
    assert_eq!(
        rpc_error(&mut agent, "annotations_claim", json!({"id": "../x"}))
            .await
            .0,
        -32602
    );
    // Still todo: the refused callers claimed nothing.
    assert!(
        store
            .claim(&project_id(), Some("only".into()))
            .await
            .unwrap()
            .is_some()
    );
    // An agent whose run ended cannot claim.
    let idle = launch_as_swamp(&mut swamp, "Idle", "done", "full-access", "default").await;
    let mut idle_agent = Client::open(&f.service, agent_of(&f, &idle)).await;
    for _ in 0..200 {
        let projection = f
            .service
            .config
            .engine
            .get_thread_projection(idle.as_str().into())
            .await
            .unwrap();
        if !projection["runs"].as_array().unwrap().is_empty() && !tools::has_active_run(&projection)
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(
        plain_failure(&mut idle_agent, "annotations_claim", json!({})).await,
        "The calling provider no longer owns an active thread run."
    );
    // Reading needs no live run.
    idle_agent.ok("annotations_list", json!({})).await;
}

mod threads_handoff;

#[tokio::test(flavor = "current_thread")]
async fn workflow_stop_reports_the_same_failure_and_write_guards_as_t3() {
    let f = fixture("workflow-stop");
    let mut c = Client::open(&f.service, client(true)).await;
    assert_eq!(
        c.failure(
            "t3_workflow_stop",
            json!({"threadId":"none", "subagentId":"none"})
        )
        .await,
        (
            "orchestration_error".into(),
            "This workflow has no live provider task.".into()
        )
    );
    let invalid = c
        .request(
            "tools/call",
            json!({
                "name":"t3_workflow_stop", "arguments":{"threadId":" ","subagentId":"task"}
            }),
        )
        .await;
    assert_eq!(invalid["error"]["code"], -32602, "{invalid}");
    let mut c = Client::open(&f.service, client(false)).await;
    assert_eq!(
        c.failure(
            "t3_workflow_stop",
            json!({"threadId":"none", "subagentId":"none"})
        )
        .await
        .0,
        "capability_denied"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn deferred_clients_load_tools_by_provider_session_and_receive_list_changed() {
    let f = fixture("deferred-tools");
    let caller = Caller::Thread(ThreadCaller {
        thread_id: "t".into(),
        provider_session_id: "s".into(),
        provider_instance_id: "claudeAgent".into(),
        subagent: false,
        preview: true,
    });
    let client = Client::open(&f.service, caller.clone()).await;
    let session = client.session.as_deref().unwrap();
    let request = |method: &str, params: Value| {
        json!({"jsonrpc":"2.0","id":1,"method":method,"params":params}).to_string()
    };
    let mut pairs = POST.to_vec();
    pairs.extend([
        ("mcp-session-id", session),
        ("t3-tool-exposure", "deferred"),
    ]);
    let names = |value: &Value| {
        value["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>()
    };
    let list = f
        .service
        .handle(
            caller.clone(),
            &Method::POST,
            &headers(&pairs),
            request("tools/list", json!({})).as_bytes(),
        )
        .await;
    let initial: Value = serde_json::from_str(list.body.as_deref().unwrap()).unwrap();
    assert_eq!(
        names(&initial),
        [
            "orchestrator_capabilities",
            "delegate_task",
            "task_status",
            "tool_search"
        ]
    );
    let reply = f
        .service
        .handle(
            caller.clone(),
            &Method::POST,
            &headers(&pairs),
            request(
                "tools/call",
                json!({"name":"tool_search","arguments":{"query":"T3_WORKFLOW_STOP"}}),
            )
            .as_bytes(),
        )
        .await;
    assert!(
        reply
            .headers
            .iter()
            .any(|(key, value)| *key == "content-type" && value == "text/event-stream")
    );
    let events: Vec<Value> = reply
        .body
        .as_deref()
        .unwrap()
        .lines()
        .filter_map(|l| l.strip_prefix("data: "))
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    assert_eq!(events[0]["method"], "notifications/tools/list_changed");
    assert_eq!(
        events[1]["result"]["structuredContent"]["tools"][0]["name"],
        "t3_workflow_stop"
    );
    let list = f
        .service
        .handle(
            caller.clone(),
            &Method::POST,
            &headers(&pairs),
            request("tools/list", json!({})).as_bytes(),
        )
        .await;
    let loaded: Value = serde_json::from_str(list.body.as_deref().unwrap()).unwrap();
    assert!(names(&loaded).contains(&"t3_workflow_stop".into()));
    let ordinary = client
        .raw(json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}))
        .await
        .1
        .unwrap();
    assert!(!names(&ordinary).contains(&"tool_search".into()));
    let empty = f
        .service
        .handle(
            caller,
            &Method::POST,
            &headers(&pairs),
            request(
                "tools/call",
                json!({"name":"tool_search","arguments":{"query":"@!!"}}),
            )
            .as_bytes(),
        )
        .await;
    assert!(
        empty
            .headers
            .iter()
            .any(|(key, value)| *key == "content-type" && value == "application/json")
    );
    let mut outside = Client::open(&f.service, crate::tests::client(true)).await;
    assert_eq!(
        outside
            .request(
                "tools/call",
                json!({"name":"tool_search","arguments":{"query":"thread"}})
            )
            .await["error"]["message"],
        "Tool 'tool_search' not found"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn secret_request_requires_an_active_owned_run_and_stays_hidden() {
    let f = fixture("secret-owner");
    let mut swamp = Client::open(&f.service, client(true)).await;
    not_offered(
        &mut swamp,
        "request_secret",
        json!({"label":"Key", "reason":"Test"}),
    )
    .await;
    let thread = launch_as_swamp(&mut swamp, "Secrets", "hang", "full-access", "default").await;
    let mut wrong = agent_of(&f, &thread);
    if let Caller::Thread(caller) = &mut wrong {
        caller.provider_instance_id = "codex".into();
    }
    let mut agent = Client::open(&f.service, wrong).await;
    let (code, _) = agent
        .failure("request_secret", json!({"label":"Key", "reason":"Test"}))
        .await;
    assert_eq!(code, "parent_not_active");
    f.service.config.engine.shutdown().await;
}

async fn await_secret_card(f: &Fixture, thread: &str, label: &str) -> Value {
    let engine = &f.service.config.engine;
    let mut changes = engine
        .subscribe_thread(from_json(json!({"threadId":thread})).unwrap())
        .await
        .unwrap();
    loop {
        let projection = engine.get_thread_projection(thread.into()).await.unwrap();
        if let Some(card) = projection["turnItems"]
            .as_array()
            .unwrap()
            .iter()
            .find(|i| i["type"] == "secret_request" && i["label"] == label)
        {
            return card.clone();
        }
        assert!(
            changes.recv().await.is_some(),
            "thread stream ended before card"
        );
    }
}

fn ask_secret(f: &Fixture, thread: &str, args: Value) -> tokio::task::JoinHandle<Value> {
    let service = f.service.clone();
    let caller = agent_of(f, thread);
    tokio::spawn(async move {
        Client::open(&service, caller)
            .await
            .ok("request_secret", args)
            .await
    })
}

#[tokio::test(flavor = "current_thread")]
async fn secret_answers_are_one_use_project_scoped_persistent_and_absent_from_events() {
    let f = fixture("secret-ref");
    let mut swamp = Client::open(&f.service, client(true)).await;
    let thread = launch_as_swamp(&mut swamp, "Secrets", "hang", "full-access", "default").await;
    let ask = ask_secret(
        &f,
        &thread,
        json!({"clientRequestId":"ref", "label":"Ref", "reason":"Fixture"}),
    );
    let card = await_secret_card(&f, &thread, "Ref").await;
    let shell = f.service.config.engine.shell_snapshot().await.unwrap();
    let row = shell["threads"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["id"] == thread)
        .unwrap();
    assert_eq!(row["pendingRuntimeRequest"]["userOnly"], true);
    assert_eq!(row["pendingRuntimeRequest"]["id"], card["id"]);
    let answer = json!({"threadId":thread,"turnItemId":card["id"],"answer":{"type":"save","secret":"test-answer"}});
    let secrets = f.service.config.secrets.as_ref().unwrap();
    secrets
        .answer(from_json(answer.clone()).unwrap())
        .await
        .unwrap();
    assert_eq!(
        secrets
            .answer(from_json(answer).unwrap())
            .await
            .unwrap_err()
            .0,
        "already_answered"
    );
    let result = ask.await.unwrap();
    assert_eq!(result["status"], "saved");
    let reference = result["secretRef"].as_str().unwrap();
    assert_eq!(
        secrets
            .save_to_file(&thread, card["id"].as_str().unwrap())
            .await
            .unwrap_err()
            .0,
        "not_a_file_request"
    );

    let projection = f
        .service
        .config
        .engine
        .get_thread_projection(thread.as_str().into())
        .await
        .unwrap();
    assert!(
        !projection.to_string().contains("test-answer"),
        "secret never enters events or projections"
    );
    assert_eq!(
        projection["turnItems"]
            .as_array()
            .unwrap()
            .iter()
            .find(|i| i["id"] == card["id"])
            .unwrap()["secretStatus"],
        "saved"
    );
    let reopened = conn_features::secrets::SecretRequests::new(
        &f.dir,
        f.service.config.engine.clone(),
        Arc::new(conn_features::clock::SystemClock),
    );
    assert_eq!(
        reopened
            .consume(reference, "other-project")
            .await
            .unwrap_err()
            .0,
        "ref_unavailable"
    );
    let project = project_id();
    let (first, second) = tokio::join!(
        reopened.consume(reference, &project),
        reopened.consume(reference, &project)
    );
    assert_eq!(
        usize::from(first.is_ok()) + usize::from(second.is_ok()),
        1,
        "one consumer wins"
    );
    assert_eq!(first.or(second).unwrap(), "test-answer");
    f.service.config.engine.shutdown().await;
}

#[tokio::test(flavor = "current_thread")]
async fn secret_file_delivery_and_pasted_values_retry_without_replacing_the_first_value() {
    use std::os::unix::fs::PermissionsExt;
    let f = fixture("secret-file");
    let mut swamp = Client::open(&f.service, client(true)).await;
    let thread = launch_as_swamp(&mut swamp, "Secrets", "hang", "full-access", "default").await;
    let secrets = f.service.config.secrets.as_ref().unwrap();
    let ask = ask_secret(
        &f,
        &thread,
        json!({"clientRequestId":"file","label":"File","reason":"Fixture","delivery":"file"}),
    );
    let card = await_secret_card(&f, &thread, "File").await;
    secrets.answer(from_json(json!({"threadId":thread,"turnItemId":card["id"],"answer":{"type":"save","secret":"shell-answer"}})).unwrap()).await.unwrap();
    let result = ask.await.unwrap();
    let file = result["file"].as_str().unwrap();
    assert_eq!(std::fs::read_to_string(file).unwrap(), "shell-answer");
    assert_eq!(
        std::fs::metadata(file).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(
        std::fs::metadata(f.dir.join("secrets/files"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    assert!(
        secrets
            .saved_ref(&thread, card["id"].as_str().unwrap())
            .await
            .unwrap()
            .is_none(),
        "file consumes stored copy"
    );
    let retried = ask_secret(
        &f,
        &thread,
        json!({"clientRequestId":"file","label":"File","reason":"Fixture","delivery":"file"}),
    )
    .await
    .unwrap();
    assert_eq!(retried, result);
    let mut agent = Client::open(&f.service, agent_of(&f, &thread)).await;
    let pasted = agent.ok("request_secret", json!({"clientRequestId":"pasted","label":"Pasted","reason":"Fixture","value":"  first-value\t "})).await;
    let repeated = agent.ok("request_secret", json!({"clientRequestId":"pasted","label":"Pasted","reason":"Fixture","value":"second-value"})).await;
    assert_eq!(pasted, repeated);
    assert_eq!(
        std::fs::read_to_string(pasted["file"].as_str().unwrap()).unwrap(),
        "  first-value\t "
    );
    for args in [
        json!({"label":" ","reason":"Test"}),
        json!({"label":"Key","reason":"Test","value":""}),
        json!({"label":"Key","reason":"Test","url":"file:///tmp/key"}),
    ] {
        let (code, _) = rpc_error(&mut agent, "request_secret", args).await;
        assert_eq!(code, -32602);
    }
    let (code, _) = agent
        .failure(
            "request_secret",
            json!({"label":"Pasted","reason":"Fixture","value":"value","delivery":"secretRef"}),
        )
        .await;
    assert_eq!(code, "invalid_request");
    let projection = f
        .service
        .config
        .engine
        .get_thread_projection(thread.as_str().into())
        .await
        .unwrap();
    assert_eq!(
        projection["turnItems"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|i| i["type"] == "secret_request")
            .count(),
        1,
        "pasted values need no card"
    );
    f.service.config.engine.shutdown().await;
}

#[tokio::test(flavor = "current_thread")]
async fn secret_decline_timeout_stop_and_aborted_call_close_the_card() {
    let f = fixture("secret-closed");
    let mut swamp = Client::open(&f.service, client(true)).await;
    let thread = launch_as_swamp(&mut swamp, "Secrets", "hang", "full-access", "default").await;
    let secrets = f.service.config.secrets.as_ref().unwrap();
    let ask = ask_secret(&f, &thread, json!({"label":"Declined","reason":"Fixture"}));
    let card = await_secret_card(&f, &thread, "Declined").await;
    secrets
        .answer(
            from_json(
                json!({"threadId":thread,"turnItemId":card["id"],"answer":{"type":"decline"}}),
            )
            .unwrap(),
        )
        .await
        .unwrap();
    let result = ask.await.unwrap();
    assert_eq!(result["status"], "declined");
    assert_eq!(
        result["note"],
        conn_features::secrets::unsaved_note("declined")
    );
    let timed = ask_secret(
        &f,
        &thread,
        json!({"label":"Timed","reason":"Fixture","timeoutMs":1000}),
    )
    .await
    .unwrap();
    assert_eq!(timed["status"], "timed_out");
    let abandoned = ask_secret(&f, &thread, json!({"label":"Aborted","reason":"Fixture"}));
    let card = await_secret_card(&f, &thread, "Aborted").await;
    let mut changes = f
        .service
        .config
        .engine
        .subscribe_thread(from_json(json!({"threadId":thread})).unwrap())
        .await
        .unwrap();
    abandoned.abort();
    assert!(abandoned.await.unwrap_err().is_cancelled());
    loop {
        let projection = f
            .service
            .config
            .engine
            .get_thread_projection(thread.as_str().into())
            .await
            .unwrap();
        if projection["turnItems"]
            .as_array()
            .unwrap()
            .iter()
            .any(|i| i["id"] == card["id"] && i["secretStatus"] == "cancelled")
        {
            break;
        }
        assert!(changes.recv().await.is_some());
    }
    let stopped = ask_secret(&f, &thread, json!({"label":"Stopped","reason":"Fixture"}));
    await_secret_card(&f, &thread, "Stopped").await;
    dispatch(
        &f,
        json!({"type":"thread.stop","commandId":"stop-secrets","threadId":thread}),
    )
    .await;
    assert_eq!(stopped.await.unwrap()["status"], "cancelled");
    f.service.config.engine.shutdown().await;
}

#[tokio::test(flavor = "current_thread")]
async fn panel_open_delivers_each_panel_to_the_callers_desktop_and_stays_hidden() {
    let f = fixture("panels");
    let mut swamp = Client::open(&f.service, client(true)).await;
    not_offered(&mut swamp, "panel_open", json!({"panel":"files"})).await;
    let thread = launch_as_swamp(&mut swamp, "Panels", "hang", "full-access", "default").await;
    let broker = f.service.config.panels.as_ref().unwrap();
    let mut desktop = broker.subscribe().unwrap();
    let mut agent = Client::open(&f.service, agent_of(&f, &thread)).await;

    for field in ["url", "tabId", "profileId"] {
        let mut input = json!({"panel":"browser"});
        input[field] = json!("   ");
        assert_eq!(
            rpc_error(&mut agent, "panel_open", input).await.0,
            -32602,
            "{field}"
        );
    }
    for panel in ["database", "mcp", "diff", "files", "browser"] {
        let mut args = json!({"panel":panel,"focusWindow":false});
        if panel == "database" {
            args["sql"] = json!("select 1");
        }
        let (result, ()) = tokio::join!(agent.ok("panel_open", args), async {
            let request = desktop.recv().await.unwrap();
            assert_eq!(request.thread_id, thread);
            assert!(!request.focus_window);
            if panel == "database" {
                assert_eq!(request.sql.as_deref(), Some("select 1"));
            }
            broker.respond(
                from_json(json!({"requestId":request.request_id,"ok":true,"deviceName":"Mac"}))
                    .unwrap(),
            );
        });
        assert_eq!(result, json!({"panel":panel,"shownOn":"Mac"}));
    }
    let (code, _) = agent
        .failure(
            "panel_open",
            json!({"panel":"browser","url":"https://example.com"}),
        )
        .await;
    assert_eq!(
        code, "capability_denied",
        "browser automation is explicitly unavailable"
    );
    let rejected = agent
        .request(
            "tools/call",
            json!({"name":"panel_open","arguments":{"panel":"files","sql":"select 1"}}),
        )
        .await;
    assert_eq!(
        rejected["result"]["content"][0]["text"],
        "sql applies to the database panel only."
    );
    drop(desktop);
    let missing = agent
        .request(
            "tools/call",
            json!({"name":"panel_open","arguments":{"panel":"browser"}}),
        )
        .await;
    assert_eq!(missing["result"]["isError"], true);
    assert!(
        missing["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("No Conn desktop app")
    );
    f.service.config.engine.shutdown().await;
}

#[tokio::test(flavor = "current_thread")]
async fn saved_secret_refs_sign_webhooks_with_project_scope_one_use_and_safe_replays() {
    let f = fixture_with_tasks("secret-webhook").await;
    let mut swamp = Client::open(&f.service, client(true)).await;
    let thread = launch_as_swamp(&mut swamp, "Signing", "hang", "full-access", "default").await;
    let ask = ask_secret(
        &f,
        &thread,
        json!({"label":"Signing key","reason":"Test webhook","clientRequestId":"sign-key"}),
    );
    let card = await_secret_card(&f, &thread, "Signing key").await;
    f.service.config.secrets.as_ref().unwrap().answer(from_json(json!({"threadId":thread,"turnItemId":card["id"],"answer":{"type":"save","secret":"test-sign-key"}})).unwrap()).await.unwrap();
    let saved = ask.await.unwrap();
    let signature = json!({"header":"x-signature","encoding":"hex","prefix":"sha256=","secretRef":saved["secretRef"],"secret":"must-not-replace-the-ref"});
    let tasks = f.service.config.scheduled_tasks.as_ref().unwrap();
    let wrong = tasks.upsert(from_json(json!({"title":"Wrong project","prompt":"Hello","enabled":true,"projectId":"other-project","schedule":{"type":"webhook","signature":signature},"workspaceStrategy":{"type":"root"},"modelSelection":{"instanceId":"claudeAgent","model":"claude-haiku-5-5"},"runtimeMode":"full-access","interactionMode":"default"})).unwrap()).await.unwrap_err();
    assert!(
        wrong.to_string().contains("already used or does not exist"),
        "{wrong}"
    );
    let mut agent = Client::open(&f.service, agent_of(&f, &thread)).await;
    let args = json!({"title":"Signed webhook","prompt":"Hello","clientRequestId":"signed-webhook","schedule":{"type":"webhook","signature":signature}});
    let task = agent.ok("schedule_task", args.clone()).await;
    assert_eq!(
        agent.ok("schedule_task", args).await["scheduledTaskId"],
        task["scheduledTaskId"]
    );
    let (code,message) = agent.failure("schedule_task",json!({"prompt":"Hello","clientRequestId":"another-webhook","schedule":{"type":"webhook","signature":signature}})).await;
    assert_eq!(code, "orchestration_error");
    assert!(
        message.contains("already used or does not exist"),
        "{message}"
    );
    let task = tasks
        .find(task["scheduledTaskId"].as_str().unwrap())
        .await
        .unwrap();
    let token = task
        .webhook
        .as_ref()
        .unwrap()
        .path
        .rsplit('/')
        .next()
        .unwrap();
    let body = b"{}";
    let signed = format!(
        "sha256={}",
        conn_support::hex::hex(&conn_support::hmac::hmac_sha256(b"test-sign-key", body))
    );
    let result = tasks
        .trigger_webhook(conn_features::scheduled::webhook::Delivery {
            hook_id: task.id.clone(),
            token: token.to_owned(),
            method: "POST".into(),
            query: String::new(),
            headers: vec![("x-signature".into(), signed)],
            body: body.to_vec(),
        })
        .await
        .unwrap();
    assert!(
        matches!(
            result,
            conn_features::scheduled::webhook::TriggerResult::Accepted { .. }
        ),
        "{result:?}"
    );
    assert!(
        !serde_json::to_string(&tasks.list().await)
            .unwrap()
            .contains("test-sign-key")
    );
    f.service.config.engine.shutdown().await;
}

#[tokio::test(flavor = "current_thread")]
async fn html_render_publishes_for_live_callers_and_guards_file_access() {
    let f = fixture("html-render");
    let mut swamp = Client::open(&f.service, client(true)).await;
    not_offered(
        &mut swamp,
        "html_render",
        json!({"html": "<p>Hi</p>", "title": "Hi", "height": 100}),
    )
    .await;
    let live = launch_as_swamp(&mut swamp, "HTML", "hang", "approval-required", "plan").await;
    let mut agent = Client::open(&f.service, agent_of(&f, &live)).await;
    let args = json!({"html": "<p>Hi</p>", "title": "  Hi  ", "height": 9000});
    let rendered = agent.ok("html_render", args.clone()).await;
    assert_eq!(rendered["htmlRender"]["title"], "Hi");
    assert_eq!(rendered["htmlRender"]["height"], 2000);
    let id = rendered["htmlRender"]["attachmentId"].as_str().unwrap();
    let file = f
        .service
        .config
        .files
        .as_ref()
        .unwrap()
        .attachments
        .resolve(id)
        .unwrap();
    assert!(
        std::fs::read_to_string(file.path)
            .unwrap()
            .contains("<p>Hi</p>")
    );
    let next = agent.ok("html_render", args).await;
    assert_ne!(next["htmlRender"]["attachmentId"], id);
    let path = f.dir.join("page.html");
    std::fs::write(&path, "<html>on disk</html>").unwrap();
    let path_args = json!({"path": path, "title": "File", "height": 400});
    let (code, message) = agent.failure("html_render", path_args.clone()).await;
    assert_eq!(code, "capability_denied");
    assert_eq!(
        message,
        "Pass html instead of path: only full-access threads may pass a path."
    );
    for invalid in [
        json!({"title": "a", "height": 100}),
        json!({"html":"<p>a</p>", "path": path, "title":"a", "height":100}),
        json!({"html":"<style>p{height:100vh}</style>", "title":"a", "height":100}),
    ] {
        let (code, _) = agent.failure("html_render", invalid).await;
        assert_eq!(code, "invalid_request");
    }
    let (code, _) = rpc_error(
        &mut agent,
        "html_render",
        json!({"html":"", "title":"a", "height":100}),
    )
    .await;
    assert_eq!(code, -32602);
    let full = launch_as_swamp(&mut swamp, "File HTML", "hang", "full-access", "default").await;
    let mut full_agent = Client::open(&f.service, agent_of(&f, &full)).await;
    let reference = full_agent.ok("html_render", path_args).await;
    assert_eq!(reference["htmlRender"]["title"], "File");
    dispatch(
        &f,
        json!({"type":"thread.archive", "commandId":"archive-html", "threadId":live}),
    )
    .await;
    let (code, _) = agent
        .failure(
            "html_render",
            json!({"html":"<p>late</p>", "title":"late", "height":80}),
        )
        .await;
    assert_eq!(code, "parent_not_active");
}

#[tokio::test]
async fn html_preview_validates_before_launch_and_reads_without_a_live_turn() {
    let f = fixture("html-preview");
    let mut client = Client::open(&f.service, client(true)).await;
    let launched=client.ok("t3_thread_launch",json!({"projectId":project_id(),"message":"hang","title":"Preview","runtimeMode":"approval-required"})).await;
    let thread = launched["threadId"].as_str().unwrap();
    let caller = Caller::Thread(ThreadCaller {
        thread_id: thread.into(),
        provider_session_id: "preview-agent".into(),
        provider_instance_id: "claudeAgent".into(),
        subagent: false,

        preview: false,
    });
    let mut agent = Client::open(&f.service, caller).await;
    client
        .ok("t3_thread_interrupt", json!({"threadId":thread}))
        .await;
    for (args, message) in [
        (json!({}), "Pass exactly one of html or path."),
        (
            json!({"html":"a","path":"/x.html"}),
            "Pass exactly one of html or path.",
        ),
        (
            json!({"path":"/unreadable.html"}),
            "Pass html instead of path: only full-access threads may pass a path.",
        ),
    ] {
        let reply = agent
            .request(
                "tools/call",
                json!({"name":"html_preview","arguments":args}),
            )
            .await;
        assert_eq!(
            reply["result"],
            json!({"isError":true,"content":[{"type":"text","text":message}],"structuredContent":{"error":{"_tag":"OrchestratorMcpFailure","operation":"preview","failureCount":1,"message":message}}})
        );
    }
    let reply = agent
        .request(
            "tools/call",
            json!({"name":"html_preview","arguments":{"html":"<div style='height:100vh'>"}}),
        )
        .await;
    assert_eq!(reply["result"]["isError"], true);
    assert!(
        reply["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("viewport height unit (100vh)")
    );
    let preview = f.service.config.preview.as_ref().unwrap().html_preview();
    let _first = preview.reserve().unwrap();
    let _second = preview.reserve().unwrap();
    let reply = agent
        .request(
            "tools/call",
            json!({"name":"html_preview","arguments":{"html":"<div style='height:100vh'>"}}),
        )
        .await;
    assert!(
        reply["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("preview queue is full")
    );
}

#[tokio::test]
async fn browser_tools_share_t3_empty_results_and_failures_without_launching_chrome() {
    let f = fixture("browser-tools");
    let mut client = Client::open(&f.service, client(true)).await;
    let launched=client.ok("t3_thread_launch",json!({"projectId":project_id(),"message":"hang","title":"Preview tools","runtimeMode":"full-access"})).await;
    let thread = launched["threadId"].as_str().unwrap();
    let mut blocked = agent_of(&f, thread);
    if let Caller::Thread(caller) = &mut blocked {
        caller.preview = false;
    }
    let mut denied = Client::open(&f.service, blocked).await;
    let reply = denied
        .request(
            "tools/call",
            json!({"name":"preview_status","arguments":{}}),
        )
        .await;
    assert_eq!(reply["result"]["isError"], true);
    assert_eq!(
        reply["result"]["content"][0]["text"],
        include_str!("preview-unavailable.txt")
    );
    let mut agent = Client::open(&f.service, agent_of(&f, thread)).await;
    let status = agent.ok("preview_status", json!({})).await;
    assert_eq!(status["available"], false);
    assert_eq!(status["tabs"], json!([]));
    assert_eq!(
        agent.ok("t3_preview_list", json!({})).await["sessions"],
        json!([])
    );
    assert_eq!(
        agent
            .ok("t3_preview_close", json!({"tabId":"missing"}))
            .await,
        json!({})
    );
    for (name, args) in [
        ("preview_open", json!({"tabId":"missing"})),
        ("preview_navigate", json!({"url":"http://localhost:3000"})),
        ("preview_resize", json!({"mode":"fill"})),
        ("preview_set_appearance", json!({"colorScheme":"dark"})),
        ("preview_evaluate", json!({"expression":"1+1"})),
        ("preview_dialog", json!({"accept":true})),
        ("preview_cdp_endpoint", json!({})),
        ("preview_snapshot", json!({})),
        ("preview_act", json!({"action":"click","x":1,"y":1})),
        ("preview_wait_for", json!({"text":"Ready"})),
        ("preview_recording_start", json!({})),
        ("preview_recording_stop", json!({})),
    ] {
        let reply = agent
            .request("tools/call", json!({"name":name,"arguments":args}))
            .await;
        assert_eq!(reply["result"]["isError"], true, "{name}: {reply}");
        let text = reply["result"]["content"][0]["text"].as_str().unwrap();
        assert!(!text.contains("Tool '"), "{name} must be registered");
        if name == "preview_snapshot" {
            assert_eq!(
                reply["result"]["structuredContent"]["error"]["_tag"],
                "PreviewAutomationTabNotFoundError"
            );
        } else if name == "preview_recording_stop" {
            assert!(text.contains("No recording is active"));
        } else {
            assert!(
                text.contains("was found") || text.contains("was not found"),
                "{name}: {text}"
            );
        }
    }
    assert!(
        !f.dir.join("tools").exists(),
        "unavailable status must never download Chrome"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn test_logins_save_find_and_hide_secrets() {
    let f = fixture("test-logins");
    let mut swamp = Client::open(&f.service, client(true)).await;
    for tool in ["save_test_login", "request_credentials", "database_query"] {
        not_offered(&mut swamp, tool, json!({})).await;
    }
    let thread = launch_as_swamp(&mut swamp, "Logins", "hang", "full-access", "default").await;
    let mut agent = Client::open(&f.service, agent_of(&f, &thread)).await;
    let saved = agent.ok("save_test_login", json!({"url":" https://www.example.test/login ","username":" admin ","password":" secret password ","label":" Admin ","otpSecret":" OTP "})).await;
    assert_eq!(saved["createdBy"], "agent");
    assert_eq!(saved["label"], "Admin");
    assert_eq!(saved["hasOtp"], true);
    assert!(saved.get("password").is_none());
    assert!(saved.get("otpSecret").is_none());
    let found = agent
        .ok(
            "request_credentials",
            json!({"domain":"http://example.test:8080/sign-in"}),
        )
        .await;
    assert_eq!(
        found,
        json!({"items":[{"id":saved["id"],"title":"Admin","urls":["https://www.example.test/login"],"username":" admin ","source":"test"}]})
    );
    for domain in ["sub.example.test", "not a host", "ftp://example.test"] {
        assert_eq!(
            agent
                .ok("request_credentials", json!({"domain":domain}))
                .await,
            json!({"items":[]})
        );
    }
    for (tool, args) in [
        (
            "save_test_login",
            json!({"url":"x","username":"","password":"x"}),
        ),
        ("request_credentials", json!({"domain":" "})),
    ] {
        assert_eq!(rpc_error(&mut agent, tool, args).await.0, -32602);
    }
    let file = f.dir.join("secrets/test-logins.bin");
    let saved_bytes = std::fs::read(&file).unwrap();
    std::fs::write(&file, "invalid fixture store").unwrap();
    for (tool, args) in [
        ("request_credentials", json!({"domain":"example.test"})),
        (
            "save_test_login",
            json!({"url":"example.test","username":"u","password":"p"}),
        ),
    ] {
        let reply = agent
            .request("tools/call", json!({"name":tool,"arguments":args}))
            .await;
        assert_eq!(
            reply["result"],
            json!({
                "content":[{"type":"text","text":"T3 Code could not read or save its test logins."}],
                "isError":true,
            }),
            "{tool}: {reply}"
        );
        assert_eq!(std::fs::read(&file).unwrap(), b"invalid fixture store");
    }
    std::fs::write(&file, saved_bytes).unwrap();
    let projection = f
        .service
        .config
        .engine
        .get_thread_projection(thread.clone().into())
        .await
        .unwrap();
    assert!(!projection.to_string().contains("secret password"));
    assert!(!projection.to_string().contains("OTP"));
    dispatch(
        &f,
        json!({"type":"thread.stop","commandId":"stop-logins","threadId":thread}),
    )
    .await;
    swamp
        .ok(
            "t3_thread_wait",
            json!({"threadId":thread,"timeoutMs":1000}),
        )
        .await;
    assert_eq!(
        agent
            .failure(
                "save_test_login",
                json!({"url":"x","username":"u","password":"p"})
            )
            .await
            .0,
        "parent_not_active"
    );
    assert_eq!(
        agent
            .ok("request_credentials", json!({"domain":"example.test"}))
            .await,
        found
    );
    f.service.config.engine.shutdown().await;
}

#[tokio::test(flavor = "current_thread")]
async fn mcp_panel_tools_relay_to_the_mac_and_keep_caller_guards() {
    let f = fixture("mcp-panel-tools");
    let mut outside = Client::open(&f.service, client(true)).await;
    not_offered(&mut outside, "mcp_call", json!({"tool":"weather"})).await;
    not_offered(
        &mut outside,
        "mcp_connect",
        json!({"name":"stub","url":"http://127.0.0.1/mcp"}),
    )
    .await;
    let thread = launch_as_swamp(&mut outside, "MCP", "hang", "full-access", "default").await;
    let mut agent = Client::open(&f.service, agent_of(&f, &thread)).await;
    let error = agent
        .request(
            "tools/call",
            json!({"name":"mcp_connect","arguments":{"name":"stub"}}),
        )
        .await;
    assert!(
        error.to_string().contains("Pass url or command, not both."),
        "{error}"
    );
    let error = agent
        .request(
            "tools/call",
            json!({"name":"mcp_call","arguments":{"tool":"weather"}}),
        )
        .await;
    assert!(
        error
            .to_string()
            .contains("No Conn desktop app is connected"),
        "{error}"
    );
    for (name, args) in [
        ("mcp_call", json!({"tool":" "})),
        ("mcp_call", json!({"tool":"x".repeat(201)})),
        ("mcp_call", json!({"tool":"weather","server":" "})),
        ("mcp_connect", json!({"url":" "})),
        ("mcp_connect", json!({"command":"x".repeat(8193)})),
        (
            "mcp_connect",
            json!({"name":"x".repeat(201),"url":"http://localhost"}),
        ),
        (
            "mcp_connect",
            json!({"url":"http://localhost","headers":{"key":"x".repeat(8193)}}),
        ),
        ("mcp_connect", json!({"command":"node","env":{"key":7}})),
    ] {
        let response = agent
            .request("tools/call", json!({"name":name,"arguments":args}))
            .await;
        assert_eq!(response["error"]["code"], -32602, "{name}: {response}");
    }
    let broker = f.service.config.panels.as_ref().unwrap();
    let mut desktop = broker.subscribe().unwrap();
    let mut obsolete = broker.subscribe().unwrap();
    let connect = agent.ok("mcp_connect",json!({"name":"stub","url":"http://127.0.0.1/mcp","headers":{"X-Test":"stub"},"focusWindow":false}));
    let stub = async {
        let request = conn_contract::to_json(&desktop.recv().await.unwrap());
        let old_request = obsolete.recv().await.unwrap();
        assert_eq!(
            old_request.request_id,
            request["requestId"].as_str().unwrap()
        );
        broker.respond(conn_contract::from_json(json!({"requestId":old_request.request_id,"ok":false,"error":"MCP is unavailable here"})).unwrap());
        assert_eq!(request["threadId"], thread);
        assert_eq!(request["focusWindow"], false);
        assert_eq!(
            request["mcpServer"],
            json!({"name":"stub","url":"http://127.0.0.1/mcp","headers":{"X-Test":"stub"}})
        );
        broker.respond(conn_contract::from_json(json!({"requestId":request["requestId"],"ok":true,"deviceName":"Test Mac","mcp":{"server":"stub","tools":[{"name":"weather"}]}})).unwrap());
    };
    assert_eq!(
        tokio::join!(connect, stub).0,
        json!({"server":"stub","tools":[{"name":"weather"}],"shownOn":"Test Mac"})
    );
    drop(obsolete);
    let call = agent.ok(
        "mcp_call",
        json!({"server":"  stub  ","tool":" weather ","arguments":{"city":"Amsterdam","options":{"raw":"  keep  ","nested":[null,7,true,{"value":"x"}]}}}),
    );
    let stub = async {
        let request = conn_contract::to_json(&desktop.recv().await.unwrap());
        assert_eq!(
            request["mcpCall"],
            json!({"server":"stub","tool":"weather","arguments":{"city":"Amsterdam","options":{"raw":"  keep  ","nested":[null,7,true,{"value":"x"}]}}})
        );
        broker.respond(conn_contract::from_json(json!({"requestId":request["requestId"],"ok":true,"mcpCall":{"server":"stub","tool":"weather","content":[{"type":"text","text":"sunny"}],"isError":false,"truncated":false,"durationMs":1}})).unwrap());
    };
    assert_eq!(tokio::join!(call, stub).0["shownOn"], "Conn desktop");
    dispatch(
        &f,
        json!({"type":"thread.archive","commandId":"close-mcp","threadId":thread}),
    )
    .await;
    assert_eq!(
        agent.failure("mcp_call", json!({"tool":"weather"})).await.0,
        "parent_not_active"
    );
    f.service.config.engine.shutdown().await;
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn database_query_forwards_to_the_desktop_and_returns_its_result() {
    let f = fixture("database-query");
    let mut swamp = Client::open(&f.service, client(true)).await;
    let thread = launch_as_swamp(&mut swamp, "Database", "hang", "full-access", "default").await;
    let mut agent = Client::open(&f.service, agent_of(&f, &thread)).await;
    assert!(
        plain_failure(&mut agent, "database_query", json!({"sql":"select 1"}))
            .await
            .contains("No Conn desktop app")
    );
    let broker = f.service.config.panels.as_ref().unwrap();
    let mut desktop = broker.subscribe().unwrap();
    let database = json!({"connection":"Development","columns":["id"],"rowCount":30.0,"rows":[{"id":1}],"truncated":true});
    let (result, ()) = tokio::join!(
        agent.ok(
            "database_query",
            json!({"sql":" select 1 ","connection":" Development ","focusWindow":false})
        ),
        async {
            let request = desktop.recv().await.unwrap();
            assert_eq!(request.thread_id, thread);
            assert_eq!(request.sql.as_deref(), Some("select 1"));
            assert_eq!(request.connection.as_deref(), Some("Development"));
            assert_eq!(request.run, Some(true));
            assert!(!request.focus_window);
            broker.respond(from_json(json!({"requestId":request.request_id,"ok":true,"deviceName":"Mac","database":database})).unwrap());
        }
    );
    let mut expected = database;
    expected["shownOn"] = json!("Mac");
    assert_eq!(result, expected);
    for (response, message) in [
        (
            json!({"ok":true}),
            "The Conn desktop showed the database panel but sent no result. It may run an older Conn.",
        ),
        (
            json!({"ok":false,"error":"Only read-only queries are allowed."}),
            "Only read-only queries are allowed.",
        ),
    ] {
        let (failure, ()) = tokio::join!(
            plain_failure(
                &mut agent,
                "database_query",
                json!({"sql":"delete from users"})
            ),
            async {
                let request = desktop.recv().await.unwrap();
                let mut response = response;
                response["requestId"] = json!(request.request_id);
                broker.respond(from_json(response).unwrap());
            }
        );
        assert_eq!(failure, message);
    }
    assert_eq!(
        plain_failure(&mut agent, "database_query", json!({"sql":"select 1"})).await,
        "No Conn desktop showed the database panel within 90 s."
    );
    for sql in [" ".to_owned(), "x".repeat(64_001)] {
        assert_eq!(
            rpc_error(&mut agent, "database_query", json!({"sql":sql}))
                .await
                .0,
            -32602
        );
    }
    f.service.config.engine.shutdown().await;
}

#[tokio::test(flavor = "current_thread")]
async fn test_logins_require_preview_capability() {
    let f = fixture("login-capability");
    let mut swamp = Client::open(&f.service, client(true)).await;
    let thread =
        launch_as_swamp(&mut swamp, "Login access", "hang", "full-access", "default").await;
    let mut caller = agent_of(&f, &thread);
    if let Caller::Thread(caller) = &mut caller {
        caller.preview = false;
    }
    let mut agent = Client::open(&f.service, caller).await;
    for (tool, args) in [
        ("request_credentials", json!({"domain":"example.test"})),
        (
            "save_test_login",
            json!({"url":"example.test","username":"u","password":"p"}),
        ),
    ] {
        let message = plain_failure(&mut agent, tool, args).await;
        assert!(
            message.starts_with("MCP credential does not grant the preview capability:"),
            "{message}"
        );
    }
    assert!(
        f.service
            .config
            .test_logins
            .as_ref()
            .unwrap()
            .list()
            .await
            .unwrap()
            .items
            .is_empty()
    );
    f.service.config.engine.shutdown().await;
}

#[test]
fn preview_grant_is_retained_per_credential() {
    let mut credentials = crate::credentials::Credentials::default();
    let (denied, _) = credentials.issue(ThreadCredentialRequest {
        thread_id: "t".into(),
        provider_instance_id: "claudeAgent".into(),
        subagent: false,
        preview: false,
    });
    let (granted, _) = credentials.issue(ThreadCredentialRequest {
        thread_id: "t".into(),
        provider_instance_id: "claudeAgent".into(),
        subagent: false,
        preview: true,
    });
    assert!(!credentials.resolve(&denied).unwrap().preview);
    assert!(credentials.resolve(&granted).unwrap().preview);
    credentials.touch("t");
    assert!(!credentials.resolve(&denied).unwrap().preview);
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn mcp_panel_actions_use_the_ninety_second_action_timeout() {
    let f = fixture("mcp-action-timeout");
    let mut outside = Client::open(&f.service, client(true)).await;
    let thread = launch_as_swamp(
        &mut outside,
        "MCP timeout",
        "hang",
        "full-access",
        "default",
    )
    .await;
    let mut agent = Client::open(&f.service, agent_of(&f, &thread)).await;
    let broker = f.service.config.panels.as_ref().unwrap();
    let mut desktop = broker.subscribe().unwrap();
    for (name, args, key, result) in [
        (
            "mcp_connect",
            json!({"url":"http://localhost/mcp"}),
            "mcp",
            json!({"server":"stub","tools":[]}),
        ),
        (
            "mcp_call",
            json!({"tool":"weather"}),
            "mcpCall",
            json!({"server":"stub","tool":"weather","content":[],"isError":false,"truncated":false,"durationMs":0}),
        ),
    ] {
        let pending = agent.ok(name, args.clone());
        let reply = async {
            let request = desktop.recv().await.unwrap();
            tokio::time::advance(Duration::from_secs(89)).await;
            let mut response =
                json!({"requestId":request.request_id,"ok":true,"deviceName":"Slow Mac"});
            response[key] = result;
            broker.respond(conn_contract::from_json(response).unwrap());
        };
        assert_eq!(tokio::join!(pending, reply).0["shownOn"], "Slow Mac");
        let pending = agent.request("tools/call", json!({"name":name,"arguments":args}));
        let expire = async {
            desktop.recv().await.unwrap();
            tokio::time::advance(Duration::from_secs(90)).await;
        };
        let response = tokio::join!(pending, expire).0;
        assert!(
            response.to_string().contains("within 90 s."),
            "{name}: {response}"
        );
    }
    f.service.config.engine.shutdown().await;
}

mod pull_request_watches;
