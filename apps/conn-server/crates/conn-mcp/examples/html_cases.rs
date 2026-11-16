//! Runs HTML cases through the MCP transport on a fake provider, with caller-owned temp state.
use conn_engine::{EngineConfig, ProjectConfig, SqliteEngine, fake::FakeProvider};
use conn_mcp::{Caller, ClientCaller, McpConfig, McpService, ThreadCaller};
use http::{HeaderMap, HeaderValue, Method};
use serde_json::{Value, json};
use std::{
    io::{self, Read},
    path::PathBuf,
    sync::Arc,
};

type Error = Box<dyn std::error::Error + Send + Sync>;

async fn open(service: &Arc<McpService>, caller: &Caller) -> Result<HeaderMap, Error> {
    let mut headers = HeaderMap::new();
    headers.insert("content-type", HeaderValue::from_static("application/json"));
    headers.insert(
        "accept",
        HeaderValue::from_static("application/json, text/event-stream"),
    );
    let response = service.handle(caller.clone(), &Method::POST, &headers, &serde_json::to_vec(&json!({"jsonrpc":"2.0", "id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"html-parity","version":"1"}}}))?).await;
    let session = response
        .headers
        .iter()
        .find(|(name, _)| *name == "mcp-session-id")
        .map(|(_, value)| value)
        .ok_or("no MCP session")?;
    headers.insert("mcp-session-id", HeaderValue::from_str(session)?);
    Ok(headers)
}

async fn call(
    service: &Arc<McpService>,
    caller: &Caller,
    headers: &HeaderMap,
    name: &str,
    args: Value,
) -> Result<Value, Error> {
    let body = serde_json::to_vec(
        &json!({"jsonrpc":"2.0", "id":2,"method":"tools/call","params":{"name":name,"arguments":args}}),
    )?;
    let reply = service
        .handle(caller.clone(), &Method::POST, headers, &body)
        .await;
    Ok(serde_json::from_str(
        reply.body.as_deref().ok_or("no MCP body")?,
    )?)
}

async fn run(state: PathBuf, cases: Vec<Value>) -> Result<Vec<Value>, Error> {
    let mut config = EngineConfig::new(state.join("engine.sqlite"));
    config.projects = vec![ProjectConfig {
        title: "HTML".into(),
        workspace_root: state.to_string_lossy().into_owned(),
    }];
    config.providers = vec![Arc::new(FakeProvider::new("claudeAgent"))];
    let files_state = state.clone();
    let (engine, files) = tokio::task::spawn_blocking(move || -> Result<_, Error> {
        Ok((
            Arc::new(SqliteEngine::open(config)?),
            Arc::new(conn_files::Files::open(&files_state)?),
        ))
    })
    .await??;
    let service = McpService::new(McpConfig {
        test_logins: None,
        refresh_provider: None,
        worktrees: None,
        engine,
        environment_id: "html-parity".into(),
        label: "HTML".into(),
        server_version: "0.0.0".into(),
        platform: json!({"os":"linux","arch":"x64"}),
        providers: Arc::new(|| {
            vec![
                json!({"instanceId":"claudeAgent","driver":"claudeAgent","enabled":true,"installed":true,"status":"ready","models":[{"slug":"test","name":"Test"}]}),
            ]
        }),
        hosted_app_url: conn_mcp::DEFAULT_HOSTED_APP_URL.into(),
        scheduled_tasks: None,
        annotations: None,
        secrets: None,
        panels: None,
        files: Some(files),
    });
    let client = Caller::Client(ClientCaller {
        session_id: "html-parity".into(),
        max_runtime_mode: Some("full-access"),
    });
    let client_headers = open(&service, &client).await?;
    let mut agents = Vec::new();
    for runtime in ["full-access", "approval-required"] {
        let launch = call(&service, &client, &client_headers,"t3_thread_launch",json!({"projectId":SqliteEngine::project_id_for(&state.to_string_lossy()),"message":"hang","title":"HTML parity","runtimeMode":runtime,"interactionMode":"plan","modelSelection":{"instanceId":"claudeAgent","model":"test"}})).await?;
        let thread_id = launch
            .pointer("/result/structuredContent/threadId")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("no launched thread: {launch}"))?
            .to_owned();
        let caller = Caller::Thread(ThreadCaller {
            thread_id,
            provider_session_id: runtime.into(),
            provider_instance_id: "claudeAgent".into(),
            subagent: false,
            preview: false,
        });
        let headers = open(&service, &caller).await?;
        agents.push((caller, headers));
    }
    let before = anonymous_kib().await;
    let mut replies = Vec::new();
    for case in cases {
        let mode = usize::from(
            case.get("supervised")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        );
        let (caller, headers) = agents.get(mode).ok_or("missing caller")?;
        let args = case.get("args").cloned().ok_or("missing args")?;
        let mut reply = call(&service, caller, headers, "html_render", args).await?;
        if let Some(id) = reply
            .pointer("/result/structuredContent/htmlRender/attachmentId")
            .and_then(Value::as_str)
        {
            let path = state.join("attachments").join(format!("{id}.html"));
            let html = tokio::task::spawn_blocking(move || std::fs::read_to_string(path)).await??;
            reply
                .as_object_mut()
                .ok_or("not an object")?
                .insert("storedHtml".into(), Value::String(html));
        }
        replies.push(reply);
    }
    eprintln!(
        "HTML fixture Pss_Anon KiB: before={before:?}, after={:?}",
        anonymous_kib().await
    );
    Ok(replies)
}

async fn anonymous_kib() -> Option<u64> {
    tokio::task::spawn_blocking(|| {
        let text = std::fs::read_to_string("/proc/self/smaps_rollup").ok()?;
        text.lines().find_map(|line| {
            line.strip_prefix("Pss_Anon:")
                .and_then(|value| value.split_whitespace().next())?
                .parse()
                .ok()
        })
    })
    .await
    .ok()
    .flatten()
}

fn main() -> Result<(), Error> {
    let state = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .ok_or("pass a temp state folder")?;
    let mut input = String::new();
    io::stdin()
        .take(64 * 1024 * 1024)
        .read_to_string(&mut input)?;
    let cases = serde_json::from_str(&input)?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let replies = runtime.block_on(run(state, cases))?;
    println!("{}", serde_json::to_string(&replies)?);
    Ok(())
}
