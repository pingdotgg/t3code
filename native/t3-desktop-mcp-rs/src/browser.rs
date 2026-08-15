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
#[cfg(unix)]
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use interprocess::local_socket::{ListenerOptions, SendHalf, Stream};
#[cfg(unix)]
use interprocess::local_socket::{GenericFilePath, ToFsName};
#[cfg(windows)]
use interprocess::local_socket::{GenericNamespaced, ToNsName};
// Imported anonymously: the traits share their names with the enums above.
use interprocess::local_socket::traits::{Listener as _, Stream as _};
use serde_json::{Value, json};

/// Timeout for extension replies; a stuck call must not wedge a turn.
const CALL_TIMEOUT: Duration = Duration::from_secs(20);

/// User-private filesystem socket (Unix) or user-scoped named pipe (Windows).
/// Abstract / global names are intentionally avoided — they have no ownership.
#[cfg(unix)]
fn bridge_socket_path() -> PathBuf {
    let dir = if let Some(runtime) = std::env::var_os("XDG_RUNTIME_DIR") {
        PathBuf::from(runtime).join("t3-desktop-mcp")
    } else if let Some(home) = std::env::var_os("HOME") {
        PathBuf::from(home).join(".local/share/t3-desktop-mcp")
    } else {
        let user = std::env::var("USER").unwrap_or_else(|_| "user".into());
        std::env::temp_dir().join(format!("t3-desktop-mcp-{user}"))
    };
    let _ = std::fs::create_dir_all(&dir);
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    dir.join("bridge.sock")
}

#[cfg(windows)]
fn bridge_pipe_name() -> String {
    let user = std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .unwrap_or_else(|_| "user".into());
    // Named-pipe namespace is global; embed the username so sessions do not collide.
    format!("t3-desktop-mcp-bridge-{user}")
}

pub struct BrowserBridge {
    /// Writer half of the accepted connection, once the extension shows up.
    outgoing: Arc<Mutex<Option<SendHalf>>>,
    replies: Receiver<Value>,
    next_id: AtomicU64,
    /// Bumped on every accept so disconnect sentinels from a prior host are ignored.
    connection_gen: Arc<AtomicU64>,
}

impl BrowserBridge {
    pub fn new() -> Self {
        let outgoing: Arc<Mutex<Option<SendHalf>>> = Arc::new(Mutex::new(None));
        let connection_gen = Arc::new(AtomicU64::new(0));
        let (sender, replies) = channel();
        spawn_listener(Arc::clone(&outgoing), Arc::clone(&connection_gen), sender);
        Self {
            outgoing,
            replies,
            next_id: AtomicU64::new(1),
            connection_gen,
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

        let params = self.params_for(command, args)?;
        let result = self.dispatch(command, params)?;
        Ok(describe(command, &result, args))
    }

    /// Build extension params, resolving 1-based `index` to an owned `tabId`
    /// for select_tab / close_tab when `tab_id` was omitted.
    fn params_for(&mut self, command: &str, args: &Value) -> Result<Value, String> {
        let mut params = normalise(command, args);
        if matches!(command, "select_tab" | "close_tab") {
            let needs_tab = params
                .get("tabId")
                .and_then(Value::as_i64)
                .is_none();
            if needs_tab {
                if let Some(index) = args.get("index").and_then(Value::as_i64) {
                    let tab_id = self.tab_id_for_index(index)?;
                    if let Some(map) = params.as_object_mut() {
                        map.insert("tabId".into(), json!(tab_id));
                        map.remove("index");
                    }
                }
            }
        }
        Ok(params)
    }

    fn tab_id_for_index(&mut self, index: i64) -> Result<i64, String> {
        if index < 1 {
            return Err("index must be a 1-based tab position from browser_list_tabs".into());
        }
        let listed = self.dispatch("list_tabs", json!({}))?;
        let tabs = listed
            .get("tabs")
            .and_then(Value::as_array)
            .ok_or_else(|| "the extension returned no tab list".to_string())?;
        let idx = (index - 1) as usize;
        tabs.get(idx)
            .and_then(|tab| tab.get("tabId").and_then(Value::as_i64))
            .ok_or_else(|| {
                format!(
                    "no agent tab at index {index} — call browser_list_tabs ({} open)",
                    tabs.len()
                )
            })
    }

    fn dispatch(&mut self, command: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let request = json!({ "id": id, "command": command, "params": params });

        // Sample connection generation under the outgoing lock so a reconnect
        // between load and write cannot pair a new SendHalf with an old gen.
        let gen_at_send = {
            let mut guard = self
                .outgoing
                .lock()
                .map_err(|_| "the browser bridge is poisoned".to_string())?;
            let stream = guard
                .as_mut()
                .ok_or_else(|| "the extension disconnected".to_string())?;
            let generation = self.connection_gen.load(Ordering::SeqCst);
            writeln!(stream, "{request}").map_err(|error| format!("could not reach the extension: {error}"))?;
            stream
                .flush()
                .map_err(|error| format!("could not reach the extension: {error}"))?;
            generation
        };

        // Replies carry the originating id, so a slow answer to an earlier call
        // cannot be mistaken for this one's. Disconnect sentinels are scoped to
        // connection_gen so a prior host drop cannot fail a call on the new socket.
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
            if reply.get("disconnected").and_then(Value::as_bool) == Some(true) {
                let reply_gen = reply.get("connectionGen").and_then(Value::as_u64);
                if reply_gen == Some(gen_at_send) {
                    return Err("the extension disconnected".to_string());
                }
                continue;
            }
            if reply.get("id").and_then(Value::as_u64) != Some(id) {
                continue;
            }
            if reply.get("ok").and_then(Value::as_bool) == Some(true) {
                return Ok(reply.get("result").cloned().unwrap_or(json!({})));
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
fn spawn_listener(
    outgoing: Arc<Mutex<Option<SendHalf>>>,
    connection_gen: Arc<AtomicU64>,
    sender: Sender<Value>,
) {
    std::thread::spawn(move || {
        #[cfg(unix)]
        let path = bridge_socket_path();
        #[cfg(unix)]
        let name = match path.as_os_str().to_fs_name::<GenericFilePath>() {
            Ok(name) => name,
            Err(_) => return,
        };
        #[cfg(windows)]
        let pipe = bridge_pipe_name();
        #[cfg(windows)]
        let name = match pipe.to_ns_name::<GenericNamespaced>() {
            Ok(name) => name,
            Err(_) => return,
        };
        let Ok(listener) = ListenerOptions::new().name(name).create_sync() else {
            // Another server already owns the browser; the accessibility tools
            // still work, so this is not worth reporting as a failure.
            return;
        };
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        }

        loop {
            let Ok(stream) = listener.accept() else { continue };
            let (recv, send) = stream.split();
            // New generation: prior disconnect sentinels become stale and are
            // ignored by dispatch (they carry the old connectionGen).
            let generation = connection_gen.fetch_add(1, Ordering::SeqCst) + 1;
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

            // The host went away; drop the writer so `call` reports honestly,
            // and wake any in-flight `dispatch` wait instead of letting it sit
            // until CALL_TIMEOUT. Tag with this connection's generation.
            if let Ok(mut guard) = outgoing.lock() {
                *guard = None;
            }
            let _ = sender.send(json!({
                "disconnected": true,
                "connectionGen": generation,
                "ok": false,
                "error": "the extension disconnected",
            }));
        }
    });
}

/// Translate tool arguments into the extension's parameter names.
fn normalise(_command: &str, args: &Value) -> Value {
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
    // Keep `index` in the wire params for commands that still accept it; select_tab
    // / close_tab resolve index → tabId in `BrowserBridge::params_for` before dispatch.
    params
}

/// Render a reply as the tool text the macOS server produces.
fn describe(command: &str, result: &Value, args: &Value) -> String {
    match command {
        // A freshly opened tab has not loaded yet, so the reply usually carries
        // no title and no url. Echo the requested address instead of rendering
        // an empty pair the model would read as a failed open.
        "open_tab" => {
            let tab = result.get("tabId").and_then(Value::as_i64).unwrap_or(-1);
            let title = result.get("title").and_then(Value::as_str).unwrap_or("");
            let url = result
                .get("url")
                .and_then(Value::as_str)
                .filter(|url| !url.is_empty() && *url != "about:blank")
                .or_else(|| args.get("url").and_then(Value::as_str))
                .unwrap_or("about:blank");
            if title.is_empty() {
                format!("opened {url} in the agent tab group (tab_id={tab})")
            } else {
                format!("opened tab_id={tab} — {title}  [{url}]")
            }
        }
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
        // The remaining commands have no interesting payload, so the useful
        // confirmation is what was done and where. Worded as the macOS server
        // words it, so a model reads the same feedback on either platform.
        other => {
            let tab = match other {
                "select_tab" => result.get("tabId").and_then(Value::as_i64),
                "close_tab" => result
                    .get("closed")
                    .and_then(Value::as_i64)
                    .or_else(|| result.get("tabId").and_then(Value::as_i64)),
                _ => None,
            }
            .or_else(|| args.get("tab_id").and_then(Value::as_i64))
            .or_else(|| args.get("index").and_then(Value::as_i64))
            .unwrap_or(-1);
            match other {
                "click" => format!("clicked in tab {tab}"),
                "type" => format!(
                    "typed {} characters into tab {tab}",
                    args.get("text").and_then(Value::as_str).unwrap_or("").chars().count()
                ),
                "press" => format!(
                    "pressed {} in tab {tab}",
                    args.get("key").and_then(Value::as_str).unwrap_or("?")
                ),
                "navigate" => format!(
                    "navigated tab {tab} to {}",
                    args.get("url").and_then(Value::as_str).unwrap_or("")
                ),
                "select_tab" => format!("switched the agent group to tab {tab}"),
                "close_tab" => format!("closed tab {tab}"),
                _ => format!("{other} ok"),
            }
        }
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
    #[cfg(unix)]
    let path = bridge_socket_path();
    #[cfg(unix)]
    let name = path.as_os_str().to_fs_name::<GenericFilePath>()?;
    #[cfg(windows)]
    let pipe = bridge_pipe_name();
    #[cfg(windows)]
    let name = pipe.to_ns_name::<GenericNamespaced>()?;
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
    fn tab_commands_keep_index_in_normalise_for_bridge_resolution() {
        // `normalise` leaves index alone; `params_for` resolves it to tabId via list_tabs.
        let params = normalise("select_tab", &json!({ "index": 2 }));
        assert_eq!(params.get("index"), Some(&json!(2)));
        assert!(params.get("tabId").is_none());
        let params = normalise("close_tab", &json!({ "index": 1 }));
        assert!(params.get("tabId").is_none());
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
        let no_args = json!({});
        assert!(describe("close_all_tabs", &json!({ "closed": 0 }), &no_args).contains("nothing to clean up"));
        assert!(describe("close_all_tabs", &json!({ "closed": 1 }), &no_args).contains("closed 1 agent tab "));
        assert!(describe("close_all_tabs", &json!({ "closed": 3 }), &no_args).contains("closed 3 agent tabs"));
    }

    #[test]
    fn a_freshly_opened_tab_echoes_the_requested_url() {
        // Chrome answers before the tab loads, so title and url come back empty;
        // rendering that verbatim reads like the open failed.
        let rendered = describe(
            "open_tab",
            &json!({ "tabId": 42 }),
            &json!({ "url": "https://example.com" }),
        );
        assert!(rendered.contains("https://example.com"), "{rendered}");
        assert!(rendered.contains("tab_id=42"), "{rendered}");
        assert!(!rendered.contains("[]"), "empty url pair leaked: {rendered}");
    }

    #[test]
    fn action_confirmations_name_the_tab_they_acted_on() {
        // "click ok" tells a model nothing; these mirror the macOS wording.
        let tab = json!({ "tab_id": 9 });
        assert_eq!(describe("click", &json!({}), &tab), "clicked in tab 9");
        assert_eq!(describe("select_tab", &json!({}), &tab), "switched the agent group to tab 9");
        assert_eq!(describe("close_tab", &json!({}), &tab), "closed tab 9");
        assert_eq!(
            describe("press", &json!({}), &json!({ "tab_id": 9, "key": "Enter" })),
            "pressed Enter in tab 9"
        );
        assert_eq!(
            describe("type", &json!({}), &json!({ "tab_id": 9, "text": "hello" })),
            "typed 5 characters into tab 9"
        );
        assert_eq!(
            describe("navigate", &json!({}), &json!({ "tab_id": 9, "url": "https://a.test" })),
            "navigated tab 9 to https://a.test"
        );
    }

    #[test]
    fn a_loaded_tab_reports_its_own_title() {
        let rendered = describe(
            "open_tab",
            &json!({ "tabId": 7, "title": "Example Domain", "url": "https://example.com/" }),
            &json!({}),
        );
        assert!(rendered.contains("Example Domain"), "{rendered}");
    }
}
