//! `conn-server acp-mcp-bridge`: the stdio MCP server an ACP agent starts for the `t3-code`
//! tools, relaying each JSON-RPC line to this server's `/mcp` over HTTP, as the T3 server's
//! `runAcpMcpStdioBridge` (`apps/server/src/mcp/AcpMcpStdioBridge.ts`) does.
//!
//! - The endpoint and the `Authorization` value come from `T3_ACP_MCP_ENDPOINT` and
//!   `T3_ACP_MCP_AUTHORIZATION`; the credential is never on the command line.
//! - Lines are relayed verbatim. `initialize` and `notifications/initialized` go in order;
//!   other messages wait for a handshake in flight, then run side by side.
//! - Each reply body (JSON, or the `data:` lines of an SSE body) is written to stdout as it
//!   came, an array as one line per entry. The `mcp-session-id` and the negotiated
//!   `mcp-protocol-version` follow on later requests.
//! - A failed request answers its id with T3's error texts; a line that is not JSON gets
//!   `-32700 Parse error`.
//!
//! One thread; the process lives as long as the agent keeps its stdin open.

use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, watch};

/// One agent line may be this long (T3 has no cap; a line past it is answered as a parse
/// error).
const MAX_LINE_BYTES: usize = 16 * 1024 * 1024;
/// A reply body may be this long.
const MAX_REPLY_BYTES: usize = 64 * 1024 * 1024;

#[derive(Default)]
struct Session {
    session_id: Option<String>,
    protocol_version: Option<String>,
}

struct Bridge {
    endpoint: Endpoint,
    authorization: String,
    session: Mutex<Session>,
    out: mpsc::Sender<String>,
}

/// `http://host:port/path`: the server's own `/mcp` is plain HTTP on a local address.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Endpoint {
    authority: String,
    path: String,
}

impl Endpoint {
    fn parse(url: &str) -> Result<Self, String> {
        let rest = url
            .strip_prefix("http://")
            .ok_or_else(|| format!("unsupported MCP endpoint {url}"))?;
        let (authority, path) = match rest.find('/') {
            Some(at) => (rest.get(..at).unwrap_or(""), rest.get(at..).unwrap_or("/")),
            None => (rest, "/"),
        };
        if authority.is_empty() {
            return Err(format!("unsupported MCP endpoint {url}"));
        }
        Ok(Self {
            authority: authority.to_owned(),
            path: path.to_owned(),
        })
    }
}

/// An HTTP reply: status, `mcp-session-id`, body.
struct HttpReply {
    status: u16,
    session_id: Option<String>,
    content_type: String,
    body: Vec<u8>,
}

fn protocol_version_of(entry: &Value) -> Option<String> {
    entry["result"]["protocolVersion"]
        .as_str()
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
}

/// Decodes a chunked body.
fn dechunk(mut body: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    loop {
        let Some(line_end) = body.windows(2).position(|w| w == b"\r\n") else {
            return out;
        };
        let size_text = String::from_utf8_lossy(body.get(..line_end).unwrap_or(&[])).to_string();
        let size_hex = size_text.split(';').next().unwrap_or("").trim();
        let Ok(size) = usize::from_str_radix(size_hex, 16) else {
            return out;
        };
        if size == 0 {
            return out;
        }
        let start = line_end + 2;
        let Some(chunk) = body.get(start..start + size) else {
            out.extend_from_slice(body.get(start..).unwrap_or(&[]));
            return out;
        };
        out.extend_from_slice(chunk);
        body = body.get(start + size + 2..).unwrap_or(&[]);
    }
}

impl Bridge {
    /// POSTs one JSON-RPC line (`fetch` with T3's headers).
    async fn post(&self, line: &str) -> Result<HttpReply, String> {
        let (session_id, protocol_version) = {
            let session = self.session.lock().map_err(|_| "poisoned")?;
            (session.session_id.clone(), session.protocol_version.clone())
        };
        let mut request = format!(
            "POST {} HTTP/1.1\r\nhost: {}\r\ncontent-type: application/json\r\naccept: application/json, text/event-stream\r\nauthorization: {}\r\n",
            self.endpoint.path, self.endpoint.authority, self.authorization
        );
        if let Some(id) = session_id {
            request.push_str(&format!("mcp-session-id: {id}\r\n"));
        }
        if let Some(version) = protocol_version {
            request.push_str(&format!("mcp-protocol-version: {version}\r\n"));
        }
        request.push_str(&format!(
            "content-length: {}\r\nconnection: close\r\n\r\n",
            line.len()
        ));
        let mut stream = tokio::net::TcpStream::connect(&self.endpoint.authority)
            .await
            .map_err(|e| e.to_string())?;
        stream
            .write_all(request.as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        stream
            .write_all(line.as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        let mut raw = Vec::new();
        (&mut stream)
            .take(MAX_REPLY_BYTES as u64)
            .read_to_end(&mut raw)
            .await
            .map_err(|e| e.to_string())?;
        let split = raw
            .windows(4)
            .position(|w| w == b"\r\n\r\n")
            .ok_or("malformed HTTP reply")?;
        let head = String::from_utf8_lossy(raw.get(..split).unwrap_or(&[])).to_string();
        let body = raw.get(split + 4..).unwrap_or(&[]);
        let mut lines = head.split("\r\n");
        let status = lines
            .next()
            .and_then(|l| l.split(' ').nth(1))
            .and_then(|s| s.parse().ok())
            .ok_or("malformed HTTP status line")?;
        let mut reply = HttpReply {
            status,
            session_id: None,
            content_type: String::new(),
            body: body.to_vec(),
        };
        let mut chunked = false;
        for header in lines {
            let Some((name, value)) = header.split_once(':') else {
                continue;
            };
            let value = value.trim();
            match name.trim().to_ascii_lowercase().as_str() {
                "mcp-session-id" => reply.session_id = Some(value.to_owned()),
                "content-type" => reply.content_type = value.to_ascii_lowercase(),
                "transfer-encoding" => chunked = value.eq_ignore_ascii_case("chunked"),
                _ => {}
            }
        }
        if chunked {
            reply.body = dechunk(body);
        }
        Ok(reply)
    }

    /// The JSON payloads of a reply body (`responsePayloads`): one JSON body, or SSE events.
    fn payloads(reply: &HttpReply) -> Vec<Value> {
        let text = String::from_utf8_lossy(&reply.body);
        if reply.content_type.starts_with("text/event-stream") {
            return text
                .split("\n\n")
                .filter_map(|event| {
                    let data: Vec<&str> = event
                        .lines()
                        .filter_map(|l| l.strip_prefix("data:"))
                        .map(|d| d.strip_prefix(' ').unwrap_or(d))
                        .collect();
                    (!data.is_empty()).then(|| data.join("\n"))
                })
                .filter_map(|data| serde_json::from_str(&data).ok())
                .collect();
        }
        if text.trim().is_empty() {
            return Vec::new();
        }
        serde_json::from_str(&text).into_iter().collect()
    }

    async fn write(&self, message: &Value) {
        let _ = self.out.send(message.to_string()).await;
    }

    async fn error(&self, id: Value, message: String, code: i64) {
        self.write(
            &json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}}),
        )
        .await;
    }

    /// `forward`: one message to the endpoint, its replies to stdout.
    async fn forward(&self, line: String, id: Option<Value>) {
        match self.post(&line).await {
            Ok(reply) => {
                if let Some(session_id) = &reply.session_id
                    && let Ok(mut session) = self.session.lock()
                {
                    session.session_id = Some(session_id.clone());
                }
                if !(200..300).contains(&reply.status) {
                    if let Some(id) = id {
                        self.error(
                            id,
                            format!("T3 Code MCP endpoint responded with HTTP {}.", reply.status),
                            -32603,
                        )
                        .await;
                    }
                    return;
                }
                for payload in Self::payloads(&reply) {
                    let entries = match payload {
                        Value::Array(entries) => entries,
                        other => vec![other],
                    };
                    for entry in entries {
                        if let Some(version) = protocol_version_of(&entry)
                            && let Ok(mut session) = self.session.lock()
                        {
                            session.protocol_version = Some(version);
                        }
                        self.write(&entry).await;
                    }
                }
            }
            Err(error) => {
                if let Some(id) = id {
                    self.error(
                        id,
                        format!("T3 Code MCP bridge request failed: {error}"),
                        -32603,
                    )
                    .await;
                }
            }
        }
    }
}

/// Runs the bridge on stdin and stdout until stdin ends and every request is answered.
pub async fn run(endpoint: &str, authorization: String) -> Result<(), String> {
    let (out_tx, mut out_rx) = mpsc::channel::<String>(64);
    let writer = tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(line) = out_rx.recv().await {
            if stdout
                .write_all(format!("{line}\n").as_bytes())
                .await
                .is_err()
                || stdout.flush().await.is_err()
            {
                return;
            }
        }
    });
    let bridge = Arc::new(Bridge {
        endpoint: Endpoint::parse(endpoint)?,
        authorization,
        session: Mutex::new(Session::default()),
        out: out_tx,
    });
    // Handshake messages run one after another; others wait while one is in flight.
    let (handshake_tx, mut handshake_rx) = mpsc::channel::<(String, Option<Value>)>(8);
    let (pending_tx, pending_rx) = watch::channel(0usize);
    let pending_tx = Arc::new(pending_tx);
    {
        let bridge = bridge.clone();
        let pending_tx = pending_tx.clone();
        tokio::spawn(async move {
            while let Some((line, id)) = handshake_rx.recv().await {
                bridge.forward(line, id).await;
                pending_tx.send_modify(|n| *n = n.saturating_sub(1));
            }
        });
    }
    let mut tasks = tokio::task::JoinSet::new();
    let mut input = BufReader::new(tokio::io::stdin());
    let mut buffer = Vec::new();
    loop {
        buffer.clear();
        let read = (&mut input)
            .take(MAX_LINE_BYTES as u64)
            .read_until(b'\n', &mut buffer)
            .await
            .map_err(|e| e.to_string())?;
        if read == 0 {
            break;
        }
        let line = String::from_utf8_lossy(&buffer)
            .trim_end_matches(['\r', '\n'])
            .to_owned();
        if line.trim().is_empty() {
            continue;
        }
        let Ok(envelope) = serde_json::from_str::<Value>(&line) else {
            bridge
                .error(Value::Null, "Parse error".into(), -32700)
                .await;
            continue;
        };
        if !envelope.is_object() {
            continue;
        }
        let id = envelope.get("id").cloned();
        let is_response =
            id.is_some() && (envelope.get("result").is_some() || envelope.get("error").is_some());
        let method = envelope["method"].as_str().unwrap_or("");
        if !is_response && (method == "initialize" || method == "notifications/initialized") {
            pending_tx.send_modify(|n| *n += 1);
            if handshake_tx.send((line, id)).await.is_err() {
                break;
            }
            continue;
        }
        let bridge = bridge.clone();
        let mut pending = pending_rx.clone();
        let wait = !is_response;
        tasks.spawn(async move {
            if wait {
                let _ = pending.wait_for(|n| *n == 0).await;
            }
            bridge.forward(line, id).await;
        });
        // Finished tasks go, so the set holds only requests in flight.
        while tasks.try_join_next().is_some() {}
    }
    drop(handshake_tx);
    let _ = pending_rx.clone().wait_for(|n| *n == 0).await;
    while tasks.join_next().await.is_some() {}
    drop(bridge);
    let _ = writer.await;
    Ok(())
}

/// The `acp-mcp-bridge` command: T3's environment variables, then [`run`] on one thread.
pub fn main() -> i32 {
    let (Some(endpoint), Some(authorization)) = (
        std::env::var_os("T3_ACP_MCP_ENDPOINT").and_then(|v| v.into_string().ok()),
        std::env::var_os("T3_ACP_MCP_AUTHORIZATION").and_then(|v| v.into_string().ok()),
    ) else {
        eprintln!("acp-mcp-bridge requires T3_ACP_MCP_ENDPOINT and T3_ACP_MCP_AUTHORIZATION.");
        return 2;
    };
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("acp-mcp-bridge: {error}");
            return 1;
        }
    };
    match runtime.block_on(run(&endpoint, authorization)) {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("acp-mcp-bridge: {error}");
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_endpoint_and_chunked_bodies() {
        assert_eq!(
            Endpoint::parse("http://127.0.0.1:3773/mcp").unwrap(),
            Endpoint {
                authority: "127.0.0.1:3773".into(),
                path: "/mcp".into()
            }
        );
        assert!(Endpoint::parse("https://x/mcp").is_err());
        assert_eq!(dechunk(b"3\r\nabc\r\n2\r\nde\r\n0\r\n\r\n"), b"abcde");
        let sse = HttpReply {
            status: 200,
            session_id: None,
            content_type: "text/event-stream".into(),
            body: b"event: message\ndata: {\"id\":1}\n\ndata: [1,2]\n\n".to_vec(),
        };
        assert_eq!(
            Bridge::payloads(&sse),
            vec![json!({"id": 1}), json!([1, 2])]
        );
    }
}
