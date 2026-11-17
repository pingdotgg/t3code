//! `conn-server acp-mcp-bridge` end to end: the binary between a stand-in agent (this test,
//! on its stdin and stdout) and a stand-in `/mcp` endpoint (a local HTTP listener).

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

fn serve(listener: TcpListener, seen: Arc<Mutex<Vec<String>>>) {
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { return };
            let Ok(clone) = stream.try_clone() else {
                return;
            };
            let mut reader = BufReader::new(clone);
            let mut head = String::new();
            let mut length = 0usize;
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                    break;
                }
                if let Some(v) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                    length = v.trim().parse().unwrap_or(0);
                }
                head.push_str(&line);
            }
            let mut body = vec![0; length];
            if reader.read_exact(&mut body).is_err() {
                return;
            }
            let body = String::from_utf8(body).unwrap_or_default();
            if let Ok(mut seen) = seen.lock() {
                seen.push(format!("{head}\n{body}"));
            }
            let message: serde_json::Value = serde_json::from_str(&body).unwrap_or_default();
            let reply = match message["method"].as_str() {
                Some("initialize") => format!(
                    r#"{{"jsonrpc":"2.0","id":{},"result":{{"protocolVersion":"2025-06-18","capabilities":{{}}}}}}"#,
                    message["id"]
                ),
                Some("tools/list") => format!(
                    r#"{{"jsonrpc":"2.0","id":{},"result":{{"tools":[]}}}}"#,
                    message["id"]
                ),
                _ => String::new(),
            };
            let status = if reply.is_empty() {
                "202 Accepted"
            } else {
                "200 OK"
            };
            let _ = write!(
                stream,
                "HTTP/1.1 {status}\r\nmcp-session-id: s-1\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{reply}",
                reply.len()
            );
        }
    });
}

#[test]
fn relays_lines_with_t3s_headers_and_stays_small() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let seen = Arc::new(Mutex::new(Vec::new()));
    serve(listener, seen.clone());
    let mut child = Command::new(env!("CARGO_BIN_EXE_conn-server"))
        .arg("acp-mcp-bridge")
        .env_remove("HOME")
        .env_remove("T3CODE_HOME")
        .env_remove("CONN_SERVER_HOME")
        .env(
            "T3_ACP_MCP_ENDPOINT",
            format!("http://127.0.0.1:{port}/mcp"),
        )
        .env("T3_ACP_MCP_AUTHORIZATION", "Bearer secret")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    writeln!(
        stdin,
        r#"{{"jsonrpc":"2.0","id":1,"method":"initialize","params":{{}}}}"#
    )
    .unwrap();
    writeln!(
        stdin,
        r#"{{"jsonrpc":"2.0","method":"notifications/initialized"}}"#
    )
    .unwrap();
    writeln!(stdin, r#"{{"jsonrpc":"2.0","id":2,"method":"tools/list"}}"#).unwrap();
    writeln!(stdin, "not json").unwrap();
    let mut lines = Vec::new();
    for _ in 0..3 {
        let mut line = String::new();
        stdout.read_line(&mut line).unwrap();
        lines.push(serde_json::from_str::<serde_json::Value>(&line).unwrap());
    }
    // The parse error comes at once; the replies in their order.
    assert!(lines.iter().any(|l| l["error"]["code"] == -32700));
    assert!(
        lines
            .iter()
            .any(|l| l["id"] == 1 && l["result"]["protocolVersion"] == "2025-06-18")
    );
    assert!(
        lines
            .iter()
            .any(|l| l["id"] == 2 && l["result"]["tools"].is_array())
    );

    // Idle with a session open: the bridge's resident memory.
    let rss = Command::new("ps")
        .args(["-o", "rss=", "-p", &child.id().to_string()])
        .output()
        .unwrap();
    let rss_kib: u64 = String::from_utf8_lossy(&rss.stdout)
        .trim()
        .parse()
        .unwrap_or(0);
    eprintln!("acp-mcp-bridge resident memory while idle: {rss_kib} KiB");
    assert!(rss_kib > 0 && rss_kib < 32 * 1024, "{rss_kib} KiB");

    drop(stdin);
    assert!(child.wait().unwrap().success());
    let seen = seen.lock().unwrap();
    assert_eq!(seen.len(), 3);
    assert!(
        seen[0]
            .to_ascii_lowercase()
            .contains("authorization: bearer secret")
    );
    assert!(!seen[0].contains("mcp-session-id"));
    // After the handshake: the session id and the negotiated protocol version.
    assert!(seen[2].contains("mcp-session-id: s-1"));
    assert!(seen[2].contains("mcp-protocol-version: 2025-06-18"));
    assert!(seen[2].contains("accept: application/json, text/event-stream"));
}
