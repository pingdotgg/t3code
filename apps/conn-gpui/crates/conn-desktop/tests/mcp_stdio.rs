//! The MCP session manager against a fake stdio server (`tests/fixtures/fake_mcp_server.py`),
//! and, ignored by default, against `@modelcontextprotocol/server-everything` through `npx`.

use std::collections::BTreeMap;
use std::time::Duration;

use conn_desktop::mcp::store::{McpListKind, McpSession, McpTool};
use conn_desktop::mcp::{
    McpConnectRequest, McpEvent, McpEventKind, McpMethod, McpOptions, McpRequest, McpServer,
    McpSessions,
};
use serde_json::{Value, json};
use tokio::sync::mpsc;

fn fixture() -> String {
    format!(
        "{}/tests/fixtures/fake_mcp_server.py",
        env!("CARGO_MANIFEST_DIR")
    )
}

fn fake_server() -> McpServer {
    McpServer::Stdio {
        command: "python3".into(),
        args: vec!["-u".into(), fixture()],
        env: BTreeMap::new(),
        cwd: Some(env!("CARGO_MANIFEST_DIR").into()),
    }
}

fn sessions() -> (McpSessions, mpsc::Receiver<McpEvent>) {
    McpSessions::with_options(McpOptions {
        environment: Some(std::env::vars().collect()),
        ..McpOptions::default()
    })
}

async fn request(sessions: &McpSessions, method: McpMethod, params: Value) -> Value {
    let response = sessions
        .request(McpRequest {
            session_id: "s".into(),
            method,
            params,
        })
        .await;
    assert_eq!(response.error, None, "{} failed", method.as_str());
    response.result
}

/// Every event that arrives until none comes for a moment.
async fn drain(events: &mut mpsc::Receiver<McpEvent>) -> Vec<McpEvent> {
    let mut seen = Vec::new();
    while let Ok(Some(event)) =
        tokio::time::timeout(Duration::from_millis(300), events.recv()).await
    {
        seen.push(event);
    }
    seen
}

fn process_alive(pid: i32) -> bool {
    std::process::Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

#[tokio::test]
async fn talks_to_a_stdio_server() {
    let (sessions, mut events) = sessions();
    let connected = sessions
        .connect(McpConnectRequest {
            session_id: "s".into(),
            server: fake_server(),
        })
        .await;
    assert_eq!(connected.error, None, "connect error");
    let info = connected.info.expect("info");
    assert_eq!(info.name, "fake", "name");
    assert_eq!(info.title.as_deref(), Some("Fake Server"), "title");
    assert_eq!(
        info.protocol_version.as_deref(),
        Some("2025-06-18"),
        "version"
    );
    assert!(
        info.capabilities.tools && info.capabilities.resources && info.capabilities.prompts,
        "capabilities"
    );
    assert!(!info.capabilities.logging, "no logging");

    let tools = request(&sessions, McpMethod::ToolsList, Value::Null).await;
    let names: Vec<&str> = tools["tools"]
        .as_array()
        .expect("tools")
        .iter()
        .filter_map(|tool| tool["name"].as_str())
        .collect();
    assert_eq!(names, ["echo", "fail", "exit", "spawn"], "both pages");
    assert!(tools.get("nextCursor").is_none(), "cursor folded away");

    let echoed = request(
        &sessions,
        McpMethod::ToolsCall,
        json!({ "name": "echo", "arguments": { "message": "hello" } }),
    )
    .await;
    assert_eq!(echoed["content"][0]["text"], "hello", "echo");

    let failed = sessions
        .request(McpRequest {
            session_id: "s".into(),
            method: McpMethod::ToolsCall,
            params: json!({ "name": "fail", "arguments": {} }),
        })
        .await;
    assert_eq!(
        failed.error.as_deref(),
        Some("MCP error -32602: Tool failed on purpose"),
        "rpc error"
    );

    let resources = request(&sessions, McpMethod::ResourcesList, Value::Null).await;
    assert_eq!(
        resources,
        json!({ "resources": [{ "uri": "mem://a", "name": "a" }] }),
        "resources"
    );
    let templates = request(&sessions, McpMethod::ResourceTemplatesList, Value::Null).await;
    assert_eq!(
        templates["resourceTemplates"][0]["uriTemplate"], "mem://{id}",
        "templates"
    );
    let prompts = request(&sessions, McpMethod::PromptsList, Value::Null).await;
    assert_eq!(prompts["prompts"][0]["name"], "greet", "prompts");
    request(&sessions, McpMethod::Ping, Value::Null).await;

    // The log: every message both ways, stderr, and the reply to the server's own ping.
    let log = drain(&mut events).await;
    let mut session = McpSession::default();
    session.begin_connect();
    for event in &log {
        session.receive_event(event);
    }
    assert!(
        log.iter().all(|event| event.session_id == "s"),
        "session id"
    );
    assert!(
        log.iter().any(|event| matches!(&event.kind,
            McpEventKind::Stderr { text } if text.contains("fake server starting"))),
        "stderr logged"
    );
    let sent = |method: &str| {
        log.iter().any(|event| {
            matches!(&event.kind, McpEventKind::Send { message } if message["method"] == method)
        })
    };
    assert!(
        sent("initialize") && sent("notifications/initialized"),
        "handshake logged"
    );
    assert!(
        log.iter().any(|event| matches!(&event.kind,
            McpEventKind::Send { message } if message["id"] == "srv-1" && message["result"] == json!({}))),
        "answered the server's ping"
    );
    let tool_pages = session
        .log
        .iter()
        .filter(|entry| entry.kind == "receive" && entry.method.as_deref() == Some("tools/list"))
        .count();
    assert_eq!(tool_pages, 2, "two pages, each named by its request");
    assert!(
        session
            .log
            .iter()
            .any(|entry| entry.is_error && entry.method.as_deref() == Some("tools/call")),
        "error row"
    );
    session.apply_list(
        McpListKind::Tools,
        &conn_desktop::mcp::McpResponse {
            error: None,
            result: tools,
            duration_ms: 0.0,
        },
    );
    assert_eq!(
        session.tools.as_deref().map(<[McpTool]>::len),
        Some(4),
        "store parses tools"
    );

    // Disconnect stops the server and anything it left in its process group.
    let spawned = request(&sessions, McpMethod::ToolsCall, json!({ "name": "spawn" })).await;
    let grandchild: i32 = spawned["content"][0]["text"]
        .as_str()
        .and_then(|pid| pid.parse().ok())
        .expect("pid");
    assert!(process_alive(grandchild), "grandchild running");
    sessions.disconnect("s").await;
    assert!(!sessions.is_connected("s"), "disconnected");
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(!process_alive(grandchild), "process group stopped");
    let after = sessions
        .request(McpRequest {
            session_id: "s".into(),
            method: McpMethod::Ping,
            params: Value::Null,
        })
        .await;
    assert_eq!(
        after.error.as_deref(),
        Some("The server is not connected."),
        "gone"
    );
    let late = drain(&mut events).await;
    assert!(
        !late.iter().any(|event| event.kind == McpEventKind::Closed),
        "a disconnect is not reported as the server closing"
    );
}

#[tokio::test]
async fn reports_a_server_that_exits() {
    let (sessions, mut events) = sessions();
    let connected = sessions
        .connect(McpConnectRequest {
            session_id: "s".into(),
            server: fake_server(),
        })
        .await;
    assert_eq!(connected.error, None, "connect");
    let exited = sessions
        .request(McpRequest {
            session_id: "s".into(),
            method: McpMethod::ToolsCall,
            params: json!({ "name": "exit" }),
        })
        .await;
    assert_eq!(
        exited.error.as_deref(),
        Some("MCP error -32000: Connection closed"),
        "pending call fails"
    );
    let log = drain(&mut events).await;
    assert_eq!(
        log.last().map(|event| &event.kind),
        Some(&McpEventKind::Closed),
        "closed comes last"
    );
    assert!(!sessions.is_connected("s"), "session dropped");
}

#[tokio::test]
async fn explains_failed_connects() {
    let (sessions, _events) = sessions();
    let missing = sessions
        .connect(McpConnectRequest {
            session_id: "s".into(),
            server: McpServer::Stdio {
                command: "definitely-not-a-command-xyz".into(),
                args: Vec::new(),
                env: BTreeMap::new(),
                cwd: None,
            },
        })
        .await;
    assert_eq!(
        missing.error.as_deref(),
        Some("definitely-not-a-command-xyz was not found on this machine's PATH."),
        "not found"
    );
    let crashed = sessions
        .connect(McpConnectRequest {
            session_id: "s".into(),
            server: McpServer::Stdio {
                command: "sh".into(),
                args: vec![
                    "-c".into(),
                    "echo 'cannot start: no key' >&2; exit 1".into(),
                ],
                env: BTreeMap::new(),
                cwd: None,
            },
        })
        .await;
    assert_eq!(
        crashed.error.as_deref(),
        Some("MCP error -32000: Connection closed\n\ncannot start: no key"),
        "stderr appended"
    );
    let bad_url = sessions
        .connect(McpConnectRequest {
            session_id: "s".into(),
            server: McpServer::Http {
                url: "app.test/mcp".into(),
                headers: Vec::new(),
            },
        })
        .await;
    assert_eq!(
        bad_url.error.as_deref(),
        Some("Enter a full URL, such as https://app.test/mcp."),
        "url"
    );
}

/// `cargo test -p conn-desktop --test mcp_stdio -- --ignored` (needs `npx` and the network).
#[tokio::test]
#[ignore = "runs npx and downloads @modelcontextprotocol/server-everything"]
async fn server_everything_over_npx() {
    let (sessions, mut events) = McpSessions::new();
    let connected = sessions
        .connect(McpConnectRequest {
            session_id: "s".into(),
            server: McpServer::Stdio {
                command: "npx".into(),
                args: vec![
                    "-y".into(),
                    "@modelcontextprotocol/server-everything".into(),
                ],
                env: BTreeMap::new(),
                cwd: None,
            },
        })
        .await;
    assert_eq!(connected.error, None, "connect");
    let info = connected.info.expect("info");
    println!("connected: {info:?} in {} ms", connected.duration_ms);
    let tools = request(&sessions, McpMethod::ToolsList, Value::Null).await;
    let names: Vec<&str> = tools["tools"]
        .as_array()
        .expect("tools")
        .iter()
        .filter_map(|tool| tool["name"].as_str())
        .collect();
    println!("tools: {names:?}");
    assert!(names.contains(&"echo"), "has echo");
    let echoed = request(
        &sessions,
        McpMethod::ToolsCall,
        json!({ "name": "echo", "arguments": { "message": "from conn-gpui" } }),
    )
    .await;
    println!("echo: {echoed}");
    let resources = request(&sessions, McpMethod::ResourcesList, Value::Null).await;
    let count = resources["resources"].as_array().map_or(0, Vec::len);
    println!("resources: {count} (paged)");
    assert!(count > 0, "has resources");
    let templates = sessions
        .request(McpRequest {
            session_id: "s".into(),
            method: McpMethod::ResourceTemplatesList,
            params: Value::Null,
        })
        .await;
    println!(
        "templates: {:?}",
        templates.error.as_ref().map_or_else(
            || templates.result["resourceTemplates"]
                .as_array()
                .map_or(0, Vec::len)
                .to_string(),
            Clone::clone
        )
    );
    let prompts = request(&sessions, McpMethod::PromptsList, Value::Null).await;
    println!(
        "prompts: {}",
        prompts["prompts"].as_array().map_or(0, Vec::len)
    );
    request(&sessions, McpMethod::Ping, Value::Null).await;
    sessions.disconnect("s").await;
    let log = drain(&mut events).await;
    println!("log events: {}", log.len());
    assert!(
        log.iter()
            .any(|event| matches!(event.kind, McpEventKind::Send { .. })),
        "logged"
    );
}

/// A server-everything process in its own process group; dropping it stops the group.
struct HttpEverything(std::process::Child);

impl HttpEverything {
    /// Starts it on `port` in `mode` (`streamableHttp` or `sse`).
    fn start(mode: &str, port: u16) -> std::io::Result<Self> {
        use std::os::unix::process::CommandExt;
        std::process::Command::new("sh")
            .args([
                "-lc",
                &format!("exec npx -y @modelcontextprotocol/server-everything {mode}"),
            ])
            .env("PORT", port.to_string())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .process_group(0)
            .spawn()
            .map(Self)
    }
}

impl Drop for HttpEverything {
    fn drop(&mut self) {
        let _ = std::process::Command::new("kill")
            .args(["-TERM", &format!("-{}", self.0.id())])
            .status();
        let _ = self.0.wait();
    }
}

/// Connects, retrying while the server starts (up to 30 seconds).
async fn connect_when_up(
    sessions: &McpSessions,
    server: McpServer,
) -> conn_desktop::mcp::McpConnectResponse {
    let mut attempts = 0;
    loop {
        let response = sessions
            .connect(McpConnectRequest {
                session_id: "s".into(),
                server: server.clone(),
            })
            .await;
        attempts += 1;
        if response.error.is_none() || attempts >= 60 {
            return response;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

/// `cargo test -p conn-desktop --test mcp_stdio -- --ignored` (needs `npx` and the network).
#[tokio::test]
#[ignore = "runs npx and downloads @modelcontextprotocol/server-everything"]
async fn server_everything_over_http_and_sse() {
    for (mode, port, sse) in [
        ("streamableHttp", 38_431_u16, false),
        ("sse", 38_432_u16, true),
    ] {
        let _server = HttpEverything::start(mode, port).expect("start server-everything");
        let (sessions, mut events) = sessions();
        let server = if sse {
            McpServer::Sse {
                url: format!("http://127.0.0.1:{port}/sse"),
                headers: Vec::new(),
            }
        } else {
            McpServer::Http {
                url: format!("http://127.0.0.1:{port}/mcp"),
                headers: Vec::new(),
            }
        };
        let connected = connect_when_up(&sessions, server).await;
        let outcome = async {
            assert_eq!(connected.error, None, "{mode} connect");
            let tools = request(&sessions, McpMethod::ToolsList, Value::Null).await;
            let count = tools["tools"].as_array().map_or(0, Vec::len);
            let echoed = request(
                &sessions,
                McpMethod::ToolsCall,
                json!({ "name": "echo", "arguments": { "message": mode } }),
            )
            .await;
            println!("{mode}: {count} tools, echo {echoed}");
            assert!(count > 0, "{mode} tools");
            sessions.disconnect("s").await;
            let log = drain(&mut events).await;
            assert!(
                log.iter()
                    .any(|event| matches!(event.kind, McpEventKind::Receive { .. })),
                "{mode} logged"
            );
        };
        outcome.await;
    }
}
