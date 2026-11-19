//! Streamable HTTP, protocol 2025-06-18, single endpoint, as Effect's `McpServer.layerHttp`
//! serves it for T3. Search results with matches send a list-changed notification and result
//! over SSE; other replies use JSON. `GET` (the server-to-client SSE stream) is 405, as in TS.
//! Statuses and error bodies follow a live TS server (`README.md`, "Transport").

use std::sync::Arc;

use http::{HeaderMap, Method, StatusCode, header};
use serde_json::{Map, Value, json};

use crate::{Caller, McpService, catalog, sessions::Lookup, tools};

pub(crate) const PROTOCOL_VERSION: &str = "2025-06-18";
const SESSION_HEADER: &str = "mcp-session-id";
const PROTOCOL_HEADER: &str = "mcp-protocol-version";

/// One HTTP response for the route to send.
#[derive(Debug)]
pub struct Reply {
    pub status: StatusCode,
    pub headers: Vec<(&'static str, String)>,
    /// `None`: empty body.
    pub body: Option<String>,
}

impl Reply {
    fn empty(status: StatusCode) -> Self {
        Self {
            status,
            headers: Vec::new(),
            body: None,
        }
    }

    fn json(status: StatusCode, body: String) -> Self {
        Self {
            status,
            headers: vec![("content-type", "application/json".to_owned())],
            body: Some(body),
        }
    }

    fn with(mut self, name: &'static str, value: String) -> Self {
        self.headers.push((name, value));
        self
    }
}

fn header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|v| v.to_str().ok())
}

/// Media types of a header, lowercased, without parameters; `q=0` entries dropped.
fn media_types(value: Option<&str>) -> Vec<String> {
    value
        .unwrap_or("")
        .split(',')
        .filter_map(|part| {
            let mut pieces = part.split(';');
            let media = pieces.next()?.trim().to_ascii_lowercase();
            let refused = pieces.any(|p| {
                p.trim()
                    .strip_prefix("q=")
                    .and_then(|q| q.parse::<f64>().ok())
                    .is_some_and(|q| q <= 0.0 || q > 1.0)
            });
            (!media.is_empty() && !refused).then_some(media)
        })
        .collect()
}

fn rpc_error(id: &Value, code: i64, message: &str) -> String {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}}).to_string()
}

pub(crate) async fn handle(
    service: &Arc<McpService>,
    caller: Caller,
    method: &Method,
    headers: &HeaderMap,
    body: &[u8],
) -> Reply {
    // No browser origin is allowed, as TS configures `layerHttp` (no `allowedOrigins`).
    if headers.contains_key(header::ORIGIN) {
        return Reply::empty(StatusCode::FORBIDDEN);
    }
    let owner = caller.namespace();
    let session_id = header(headers, SESSION_HEADER);
    if *method == Method::DELETE {
        let Some(id) = session_id else {
            return Reply::empty(StatusCode::BAD_REQUEST);
        };
        return match service.lock_sessions().close(id, &owner) {
            Lookup::Found => Reply::empty(StatusCode::NO_CONTENT),
            Lookup::Unknown => Reply::empty(StatusCode::NOT_FOUND),
        };
    }
    if *method != Method::POST {
        return Reply::empty(StatusCode::METHOD_NOT_ALLOWED).with("allow", "POST, DELETE".into());
    }
    if media_types(header(headers, "content-type"))
        .first()
        .map(String::as_str)
        != Some("application/json")
    {
        return Reply::empty(StatusCode::UNSUPPORTED_MEDIA_TYPE);
    }
    let accepted = media_types(header(headers, "accept"));
    if !accepted.iter().any(|m| m == "application/json")
        || !accepted.iter().any(|m| m == "text/event-stream")
    {
        return Reply::empty(StatusCode::NOT_ACCEPTABLE);
    }
    let mut message: Value = match serde_json::from_slice(body) {
        Ok(message) => message,
        Err(_) => {
            let body = json!({"jsonrpc": "2.0", "id": null,
                "error": {"code": -32700, "message": "Parse error", "_tag": "ParseError"}});
            return Reply::json(StatusCode::OK, body.to_string());
        }
    };
    if message.is_array() {
        // JSON-RPC batches are not part of 2025-06-18.
        return Reply::empty(StatusCode::BAD_REQUEST);
    }
    let id = message.get("id").cloned();
    let rpc_id = id.clone().unwrap_or(Value::Null);
    let method_name = message["method"].as_str().unwrap_or_default();
    if let Some(version) = header(headers, PROTOCOL_HEADER)
        && version != PROTOCOL_VERSION
    {
        let body = json!({"jsonrpc": "2.0", "id": rpc_id, "error": {
            "code": -32022,
            "message": format!("Unsupported protocol version '{version}'"),
            "data": {"supported": [PROTOCOL_VERSION], "requested": version},
        }});
        return Reply::json(StatusCode::BAD_REQUEST, body.to_string());
    }

    if method_name == "initialize" {
        let session = service.lock_sessions().open(owner);
        let config = &service.config;
        // Any requested version gets 2025-06-18, as TS answers versions it does not serve.
        let result = json!({
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {"logging": {}, "tools": {"listChanged": true}, "completions": {}},
            "serverInfo": {"name": "T3 Code", "version": config.server_version},
        });
        return Reply::json(
            StatusCode::OK,
            format!(
                "{}\n",
                json!({"jsonrpc": "2.0", "id": rpc_id, "result": result})
            ),
        )
        .with(SESSION_HEADER, session)
        .with(PROTOCOL_HEADER, PROTOCOL_VERSION.into());
    }

    let Some(session) = session_id else {
        if id.is_none() {
            return Reply::empty(StatusCode::BAD_REQUEST);
        }
        let body = json!({"jsonrpc": "2.0", "id": rpc_id, "error": {
            "code": -32600,
            "message": "MCP-Session-Id header is required; send initialize to start a session",
            "_tag": "InvalidRequest",
        }});
        return Reply::json(StatusCode::BAD_REQUEST, body.to_string());
    };
    if let Lookup::Unknown = service.lock_sessions().touch(session, &owner) {
        return Reply::empty(StatusCode::NOT_FOUND);
    }
    // Notifications (`notifications/initialized`, `notifications/cancelled`, ...): accepted.
    // A cancelled call ends when its client drops the connection.
    if id.is_none() {
        return Reply::empty(StatusCode::ACCEPTED).with(PROTOCOL_HEADER, PROTOCOL_VERSION.into());
    }

    let mut changed = false;
    let body = match method_name {
        "ping" | "logging/setLevel" => {
            json!({"jsonrpc": "2.0", "id": rpc_id, "result": {}}).to_string()
        }
        "tools/list" => format!(
            "{{\"jsonrpc\":\"2.0\",\"id\":{rpc_id},\"result\":{}}}",
            match &caller {
                Caller::Thread(thread)
                    if header(headers, "t3-tool-exposure") == Some("deferred") =>
                {
                    let exposure = crate::lock(&service.exposure);
                    catalog::list_filtered(|name| {
                        exposure.listed(&thread.provider_session_id, name)
                            && catalog::offered_to(name, &caller)
                    })
                }
                _ => catalog::list_for(&caller),
            }
        ),
        "tools/call" => {
            let params = message
                .get_mut("params")
                .map(Value::take)
                .unwrap_or_default();
            let (result, list_changed) = call(service, &caller, &rpc_id, params, headers).await;
            changed = list_changed;
            result
        }
        other => rpc_error(&rpc_id, -32601, &format!("Method not found: {other}")),
    };
    if changed {
        let notification =
            json!({"jsonrpc":"2.0","method":"notifications/tools/list_changed","params":{}});
        return Reply {
            status: StatusCode::OK,
            headers: vec![
                ("content-type", "text/event-stream".into()),
                (PROTOCOL_HEADER, PROTOCOL_VERSION.into()),
            ],
            body: Some(format!(
                "event: message\ndata: {notification}\n\nevent: message\ndata: {body}\n\n"
            )),
        };
    }
    Reply::json(StatusCode::OK, format!("{body}\n")).with(PROTOCOL_HEADER, PROTOCOL_VERSION.into())
}

async fn call(
    service: &Arc<McpService>,
    caller: &Caller,
    id: &Value,
    mut params: Value,
    headers: &HeaderMap,
) -> (String, bool) {
    let invalid = |message: &str| (rpc_error(id, -32602, message), false);
    let mut arguments = match params["arguments"].take() {
        Value::Object(map) => map,
        Value::Null => Map::new(),
        _ => return invalid("Invalid method parameters"),
    };
    let Some(name) = params["name"].as_str() else {
        return invalid("Invalid method parameters");
    };
    let found = catalog::tool(name).filter(|_| catalog::offered_to(name, caller));
    let Some((tool, order)) = found else {
        return invalid(&format!("Tool '{name}' not found"));
    };
    if let Err(problem) =
        catalog::check_arguments(name, &tool["inputSchema"], &order, &mut arguments)
    {
        return invalid(&format!("Invalid parameters for tool '{name}': {problem}"));
    }
    if let Err(problem) = crate::input::check(name, &mut arguments) {
        return invalid(&format!("Invalid parameters for tool '{name}': {problem}"));
    }
    let origin = header(headers, "host")
        .filter(|host| !host.contains(['/', '\\', ' ']))
        .map(|host| {
            format!(
                "{}://{host}",
                if header(headers, "x-forwarded-proto") == Some("https") {
                    "https"
                } else {
                    "http"
                }
            )
        });
    let mut changed = false;
    let include_image = arguments.get("includeImage").and_then(Value::as_bool) == Some(true);
    let result = match tools::call(service, caller, name, arguments, origin.as_deref()).await {
        Ok(mut value) if name == "preview_snapshot" && value.get("screenshot").is_some() => {
            let data = value
                .get_mut("screenshot")
                .and_then(Value::as_object_mut)
                .and_then(|s| s.remove("data"))
                .unwrap_or(Value::Null);
            let url = value.get("url").cloned().unwrap_or(Value::Null);
            let (mut value, text, omitted) = crate::snapshot::bound_metadata(value);
            let mut content = vec![
                json!({"type":"text","text":json!({"url":url}).to_string()}),
                json!({"type":"text","text":text}),
            ];
            if !omitted.is_empty() {
                content.push(json!({"type":"text","text":format!("Snapshot text was bounded. Omitted: {}.",omitted.join("; "))}));
                value["omitted"] = json!(omitted);
            }
            if include_image {
                content.push(json!({"type":"image","data":data,"mimeType":"image/png"}));
            }
            json!({"content":content,"structuredContent":value,"isError":false})
        }
        Ok(mut value) if name == "html_preview" => {
            let data = value
                .get_mut("screenshot")
                .and_then(Value::as_object_mut)
                .and_then(|s| s.remove("data"))
                .unwrap_or(Value::Null);
            json!({"content":[{"type":"text","text":value.to_string()},{"type":"image","mimeType":"image/png","data":data}],"structuredContent":value,"isError":false})
        }
        Ok(value) => {
            changed = name == "tool_search"
                && value["tools"]
                    .as_array()
                    .is_some_and(|tools| !tools.is_empty());
            json!({"content": [{"type": "text", "text": value.to_string()}], "structuredContent": value, "isError": false})
        }
        Err(tools::ToolError::Failure { message, .. }) if name == "html_preview" => {
            json!({"content":[{"type":"text","text":message}],"structuredContent":{"error":{"_tag":"OrchestratorMcpFailure","operation":"preview","failureCount":1,"message":message}},"isError":true})
        }
        Err(tools::ToolError::Failure { code, message }) => {
            let failure =
                json!({"_tag": "OrchestratorMcpFailure", "code": code, "message": message});
            json!({"content": [{"type": "text", "text": failure.to_string()}], "isError": true})
        }
        Err(tools::ToolError::Preview { tag, message }) if name == "preview_snapshot" => {
            json!({"content":[{"type":"text","text":format!("Preview snapshot failed: {message}")}],"structuredContent":{"error":{"_tag":tag,"operation":"snapshot","failureCount":1,"message":message}},"isError":true})
        }
        Err(tools::ToolError::Preview { message, .. }) => {
            json!({"content":[{"type":"text","text":message}],"isError":true})
        }
        Err(tools::ToolError::Worktree { code, message }) => {
            let failure = json!({"_tag":"WorktreeMcpFailure", "code":code, "message":message});
            json!({"content":[{"type":"text", "text":failure.to_string()}], "isError":true})
        }
        Err(tools::ToolError::Message(message)) => {
            json!({"content": [{"type": "text", "text": message}], "isError": true})
        }
        Err(tools::ToolError::InvalidParams(problem)) => {
            return invalid(&format!("Invalid parameters for tool '{name}': {problem}"));
        }
    };
    (
        json!({"jsonrpc": "2.0", "id": id, "result": result}).to_string(),
        changed,
    )
}
