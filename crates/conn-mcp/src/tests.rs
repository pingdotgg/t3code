//! Offline tests: the real engine with its scripted fake provider (`hang`, `ask`, `fail`,
//! else `echo: <text>`). Every tool result is checked against the `outputSchema` the
//! TypeScript server advertises for that tool.

use std::{path::PathBuf, sync::Arc, time::Duration};

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
    let dir = std::env::temp_dir().join(format!("conn-mcp-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let mut config = EngineConfig::new(dir.join("engine.sqlite"));
    config.projects = vec![ProjectConfig {
        title: "Project".into(),
        workspace_root: ROOT.into(),
    }];
    config.providers = vec![Arc::new(FakeProvider::new("claudeAgent"))];
    config.stream_flush = Duration::from_millis(5);
    config.host = host;
    let engine = Arc::new(SqliteEngine::open(config).unwrap());
    let service = McpService::new(McpConfig {
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
        assert_eq!(failure["_tag"], "OrchestratorMcpFailure");
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
    assert_eq!(names, catalog::names().collect::<Vec<_>>());
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
    let (code, _) = c.failure("delegate_task", json!({"task": "x"})).await;
    assert_eq!(code, "thread_credential_required");
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
    let (code, _) = stranger
        .failure("task_status", json!({"taskId": task_id}))
        .await;
    assert_eq!(code, "thread_credential_required");

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
    let (code, _) = swamp
        .failure("send_to_user", json!({"message": "hi"}))
        .await;
    assert_eq!(code, "thread_credential_required");
    let mut reader = Client::open(&f.service, client(false)).await;
    let (code, _) = reader
        .failure("send_to_user", json!({"message": "hi"}))
        .await;
    assert_eq!(code, "thread_credential_required");

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
    swamp
        .ok(
            "t3_thread_organize",
            json!({"threadId": full, "action": "unpin"}),
        )
        .await;
    assert!(thread_field(&f, &full, "pinnedAt").await.is_null());
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
const NAMED_NOT_SERVED: [&str; 17] = [
    "create_threads",
    "device_list",
    "device_open",
    "device_screenshot",
    "html_preview",
    "html_render",
    "link_pull_request",
    "link_pull_requests",
    "preview_open",
    "preview_status",
    "request_secret",
    "schedule_task",
    "t3_background_wait",
    "t3_environment_link",
    "t3_environment_links",
    "unwatch_pull_request",
    "watch_pull_request",
];

/// Every text we send to an agent that can name a tool: the orchestration text and Claude's
/// texts (`conn-mcp`), the `next` text of a running task, the Codex additional context
/// (`conn-provider-codex`), the pull request text (`conn-provider-claude`), and the served
/// tools' own descriptions.
fn agent_texts() -> Vec<&'static str> {
    vec![
        crate::AGENT_INSTRUCTIONS,
        crate::CLAUDE_INSTRUCTIONS,
        include_str!("running-task-next.txt"),
        include_str!("../../conn-provider-codex/src/instructions.rs"),
        include_str!("../../conn-provider-claude/src/launch.rs"),
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
    let dump: Value = serde_json::from_str(include_str!("../fixtures/ts-tools-list.json")).unwrap();
    // The live dump is an outside caller's list: the link tools and `tool_search` are hidden.
    let mut all: Vec<String> = dump["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap().to_owned())
        .collect();
    for hidden in [
        "t3_environment_link",
        "t3_environment_links",
        "t3_environment_unlink",
        "tool_search",
    ] {
        all.push(hidden.to_owned());
    }
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
