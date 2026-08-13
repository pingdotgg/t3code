//! Agent-owned Chrome tabs, via the T3 Code Chrome extension.
//!
//! Chrome owns the lifetime of a native messaging host: it spawns the host when
//! the extension connects and speaks 4-byte-length-prefixed JSON over that
//! process's stdio. The MCP server is a different process with its own
//! lifetime, so the two are joined by a local socket:
//!
//! ```text
//!   Chrome ──stdio(length-prefixed)──▶ `t3-desktop-mcp native-host`
//!                                          │ local socket
//!                                          ▼
//!                                    MCP server (this process)
//! ```
//!
//! This mirrors the macOS Swift bridge exactly, including the wire messages, so
//! one extension build serves all three platforms. The server binds the socket,
//! so the first live server claims the browser and later ones fall back to the
//! accessibility tools.

use std::io::{BufRead, BufReader, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use interprocess::local_socket::{GenericNamespaced, ListenerOptions, SendHalf, Stream, ToNsName};
// Imported anonymously: the traits share their names with the enums above.
use interprocess::local_socket::traits::{Listener as _, Stream as _};
use serde_json::{Value, json};

/// Shared by the server and the `native-host` relay. Namespaced so it maps to a
/// named pipe on Windows and an abstract/socket name on Linux.
const SOCKET_NAME: &str = "t3-desktop-mcp-bridge.sock";

/// The extension answers promptly or not at all; a stuck call must not wedge a
/// turn, so give up and let the model try the desktop tools instead.
const CALL_TIMEOUT: Duration = Duration::from_secs(20);

pub struct BrowserBridge {
    /// Writer half of the accepted connection, once the extension shows up.
    outgoing: Arc<Mutex<Option<SendHalf>>>,
    replies: Receiver<Value>,
    next_id: AtomicU64,
}

impl BrowserBridge {
    pub fn new() -> Self {
        let outgoing: Arc<Mutex<Option<SendHalf>>> = Arc::new(Mutex::new(None));
        let (sender, replies) = channel();
        spawn_listener(Arc::clone(&outgoing), sender);
        Self {
            outgoing,
            replies,
            next_id: AtomicU64::new(1),
        }
    }

    fn connected(&self) -> bool {
        self.outgoing.lock().is_ok_and(|guard| guard.is_some())
    }

    /// Dispatch a `browser_*` call. `command` has the `browser_` prefix stripped.
    pub fn call(&mut self, command: &str, args: &Value) -> Result<String, String> {
        if !self.connected() {
            return Err(format!(
                "browser_{command} needs the T3 Code Chrome extension, which is not connected. \
                 Install it from native/t3-chrome-extension, or use the desktop tools instead: \
                 get_app_state on the browser window, then click"
            ));
        }

        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let request = json!({ "id": id, "command": command, "params": normalise(command, args) });

        {
            let mut guard = self
                .outgoing
                .lock()
                .map_err(|_| "the browser bridge is poisoned".to_string())?;
            let stream = guard
                .as_mut()
                .ok_or_else(|| "the extension disconnected".to_string())?;
            writeln!(stream, "{request}").map_err(|error| format!("could not reach the extension: {error}"))?;
            stream
                .flush()
                .map_err(|error| format!("could not reach the extension: {error}"))?;
        }

        // Replies carry the originating id, so a slow answer to an earlier call
        // cannot be mistaken for this one's.
        let deadline = std::time::Instant::now() + CALL_TIMEOUT;
        loop {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() {
                return Err(format!("browser_{command} timed out waiting for the extension"));
            }
            let reply = self
                .replies
                .recv_timeout(remaining)
                .map_err(|_| format!("browser_{command} timed out waiting for the extension"))?;
            if reply.get("id").and_then(Value::as_u64) != Some(id) {
                continue;
            }
            if reply.get("ok").and_then(Value::as_bool) == Some(true) {
                let result = reply.get("result").cloned().unwrap_or(json!({}));
                return Ok(describe(command, &result));
            }
            return Err(reply
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("the extension reported an error")
                .to_string());
        }
    }
}

impl Default for BrowserBridge {
    fn default() -> Self {
        Self::new()
    }
}

/// Accept the native host and pump its replies onto `sender`.
fn spawn_listener(outgoing: Arc<Mutex<Option<SendHalf>>>, sender: Sender<Value>) {
    std::thread::spawn(move || {
        let Ok(name) = SOCKET_NAME.to_ns_name::<GenericNamespaced>() else {
            return;
        };
        let Ok(listener) = ListenerOptions::new().name(name).create_sync() else {
            // Another server already owns the browser; the accessibility tools
            // still work, so this is not worth reporting as a failure.
            return;
        };

        loop {
            let Ok(stream) = listener.accept() else { continue };
            let (recv, send) = stream.split();
            if let Ok(mut guard) = outgoing.lock() {
                *guard = Some(send);
            }

            let reader = BufReader::new(recv);
            for line in reader.lines() {
                let Ok(line) = line else { break };
                if let Ok(value) = serde_json::from_str::<Value>(&line)
                    && sender.send(value).is_err()
                {
                    return;
                }
            }

            // The host went away; drop the writer so `call` reports honestly.
            if let Ok(mut guard) = outgoing.lock() {
                *guard = None;
            }
        }
    });
}

/// Translate tool arguments into the extension's parameter names.
fn normalise(command: &str, args: &Value) -> Value {
    let mut params = json!({});
    let map = params.as_object_mut().expect("just built an object");
    if let Some(tab) = args.get("tab_id").and_then(Value::as_i64) {
        map.insert("tabId".into(), json!(tab));
    }
    for key in ["url", "text", "key", "index", "x", "y"] {
        if let Some(value) = args.get(key) {
            map.insert(key.into(), value.clone());
        }
    }
    // `browser_select_tab` and `browser_close_tab` accept either form.
    if command.ends_with("_tab")
        && !map.contains_key("tabId")
        && let Some(index) = args.get("index").and_then(Value::as_i64)
    {
        map.insert("tabId".into(), json!(index));
    }
    params
}

/// Render a reply as the tool text the macOS server produces.
fn describe(command: &str, result: &Value) -> String {
    match command {
        "open_tab" => format!(
            "opened tab_id={} — {}  [{}]",
            result.get("tabId").and_then(Value::as_i64).unwrap_or(-1),
            result.get("title").and_then(Value::as_str).unwrap_or(""),
            result.get("url").and_then(Value::as_str).unwrap_or("")
        ),
        "list_tabs" => describe_tabs(result),
        "snapshot" => describe_snapshot(result),
        "close_all_tabs" => {
            let closed = result.get("closed").and_then(Value::as_i64).unwrap_or(0);
            if closed == 0 {
                "nothing to clean up — the agent had no tabs open".to_string()
            } else {
                format!(
                    "closed {closed} agent tab{} and removed the tab group",
                    if closed == 1 { "" } else { "s" }
                )
            }
        }
        other => format!("{other} ok"),
    }
}

fn describe_tabs(result: &Value) -> String {
    let tabs = result.get("tabs").and_then(Value::as_array).cloned().unwrap_or_default();
    if tabs.is_empty() {
        return "the agent has no tabs open yet — call browser_open_tab".to_string();
    }
    let mut lines = vec![format!(
        "agent tab group ({} tab{}):",
        tabs.len(),
        if tabs.len() == 1 { "" } else { "s" }
    )];
    for tab in tabs {
        lines.push(format!(
            "{}tab_id={}  {}  [{}]",
            if tab.get("active").and_then(Value::as_bool) == Some(true) {
                "* "
            } else {
                "  "
            },
            tab.get("tabId").and_then(Value::as_i64).unwrap_or(-1),
            tab.get("title").and_then(Value::as_str).unwrap_or(""),
            tab.get("url").and_then(Value::as_str).unwrap_or("")
        ));
    }
    lines.join("\n")
}

fn describe_snapshot(result: &Value) -> String {
    let mut lines = vec![format!(
        "{}  [{}]",
        result.get("title").and_then(Value::as_str).unwrap_or("?"),
        result.get("url").and_then(Value::as_str).unwrap_or("")
    )];
    for element in result
        .get("elements")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
    {
        let label = element.get("label").and_then(Value::as_str).unwrap_or("");
        lines.push(format!(
            "  [{}] {}{}{}",
            element.get("i").and_then(Value::as_i64).unwrap_or(-1),
            element.get("tag").and_then(Value::as_str).unwrap_or("?"),
            if label.is_empty() {
                String::new()
            } else {
                format!(" \"{label}\"")
            },
            if element.get("inView").and_then(Value::as_bool) == Some(false) {
                "  (scrolled out of view)"
            } else {
                ""
            }
        ));
    }
    lines.join("\n")
}

/// Relay mode: Chrome on stdio, the MCP server on the local socket.
///
/// Chrome frames each message with a 4-byte native-endian length; the socket
/// side is newline-delimited JSON, which keeps the server's reader trivial.
pub fn run_native_host() -> std::io::Result<()> {
    let name = SOCKET_NAME
        .to_ns_name::<GenericNamespaced>()
        .map_err(std::io::Error::other)?;
    let stream = Stream::connect(name)?;
    let (recv, mut writer) = stream.split();

    // Server → Chrome.
    std::thread::spawn(move || {
        let reader = BufReader::new(recv);
        let mut stdout = std::io::stdout();
        for line in reader.lines() {
            let Ok(line) = line else { break };
            let bytes = line.as_bytes();
            if stdout
                .write_all(&(bytes.len() as u32).to_ne_bytes())
                .and_then(|()| stdout.write_all(bytes))
                .and_then(|()| stdout.flush())
                .is_err()
            {
                break;
            }
        }
    });

    // Chrome → server.
    let mut stdin = std::io::stdin().lock();
    loop {
        let mut header = [0u8; 4];
        if std::io::Read::read_exact(&mut stdin, &mut header).is_err() {
            return Ok(());
        }
        let length = u32::from_ne_bytes(header) as usize;
        // Chrome caps messages well below this; a wild length means a desync.
        if length == 0 || length > 64 * 1024 * 1024 {
            return Ok(());
        }
        let mut body = vec![0u8; length];
        if std::io::Read::read_exact(&mut stdin, &mut body).is_err() {
            return Ok(());
        }
        writer.write_all(&body)?;
        writer.write_all(b"\n")?;
        writer.flush()?;
    }
}

#[cfg(test)]
mod tests {
    use super::{BrowserBridge, describe, describe_snapshot, describe_tabs, normalise};
    use serde_json::json;

    #[test]
    fn an_unconnected_bridge_points_at_the_working_alternative() {
        let mut bridge = BrowserBridge::new();
        let error = bridge.call("open_tab", &json!({})).unwrap_err();

        assert!(error.contains("browser_open_tab"), "names the tool: {error}");
        assert!(error.contains("get_app_state"), "offers a path: {error}");
    }

    #[test]
    fn tool_arguments_are_renamed_for_the_extension() {
        // The tools speak snake_case; the extension speaks camelCase.
        let params = normalise("snapshot", &json!({ "tab_id": 7, "text": "hi" }));
        assert_eq!(params["tabId"], json!(7));
        assert_eq!(params["text"], json!("hi"));
        assert!(params.get("tab_id").is_none());
    }

    #[test]
    fn tab_commands_accept_an_index_when_no_tab_id_is_given() {
        let params = normalise("select_tab", &json!({ "index": 2 }));
        assert_eq!(params["tabId"], json!(2));
    }

    #[test]
    fn an_empty_tab_list_tells_the_model_what_to_do_next() {
        assert!(describe_tabs(&json!({ "tabs": [] })).contains("browser_open_tab"));
    }

    #[test]
    fn tab_lists_mark_the_active_tab() {
        let rendered = describe_tabs(&json!({
            "tabs": [
                { "tabId": 1, "title": "One", "url": "https://one", "active": false },
                { "tabId": 2, "title": "Two", "url": "https://two", "active": true }
            ]
        }));
        assert!(rendered.contains("  tab_id=1"), "{rendered}");
        assert!(rendered.contains("* tab_id=2"), "{rendered}");
    }

    #[test]
    fn snapshots_flag_offscreen_elements() {
        let rendered = describe_snapshot(&json!({
            "title": "Page",
            "url": "https://example",
            "elements": [
                { "i": 0, "tag": "button", "label": "Go", "inView": true },
                { "i": 1, "tag": "a", "label": "Hidden", "inView": false }
            ]
        }));
        assert!(rendered.contains("[0] button \"Go\""), "{rendered}");
        assert!(rendered.contains("(scrolled out of view)"), "{rendered}");
    }

    #[test]
    fn closing_nothing_is_reported_as_nothing() {
        assert!(describe("close_all_tabs", &json!({ "closed": 0 })).contains("nothing to clean up"));
        assert!(describe("close_all_tabs", &json!({ "closed": 1 })).contains("closed 1 agent tab "));
        assert!(describe("close_all_tabs", &json!({ "closed": 3 })).contains("closed 3 agent tabs"));
    }
}
