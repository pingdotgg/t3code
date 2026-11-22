//! `thread list|start|send|show`: the T3 CLI's thread commands (`apps/server/src/cli/thread.ts`),
//! which Orbit's task turns run inside a container.
//!
//! Like the T3 CLI, a command finds the running server through `server-runtime.json`, issues
//! itself a short MCP client session in the shared auth store, calls the server's own `/mcp`
//! tools (`t3_project_list`, `t3_thread_launch`, `t3_thread_send`, `t3_thread_wait`,
//! `t3_thread_read`, `t3_thread_list`) and revokes the session before it exits. Output, error
//! texts and exit codes follow the T3 CLI: 0 done, 1 failed, 2 the run waits for an answer.
//!
//! The CLI is its own short process with no async runtime, so it uses blocking I/O.

use std::{
    io::{self, Read, Write},
    net::{SocketAddr, TcpStream, ToSocketAddrs},
    path::{Component, Path, PathBuf},
    time::Duration,
};

use serde::de::{Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use serde_json::{Value, json};

use crate::{
    auth::{AuthStore, ClientInfo},
    home,
};

/// Short enough that a run which stops to ask something is noticed soon (`WAIT_SLICE_MS`).
const WAIT_SLICE_MS: u64 = 15_000;
const WAKE_GRACE_MS: u64 = 10_000;
const WAKE_POLL_MS: u64 = 500;
const READ_PAGE_LIMIT: u64 = 100;
const READ_ITEM_MAX_CHARS: u64 = 20_000;
const TITLE_MAX_CHARS: usize = 80;
const TERMINAL_RUN_STATUSES: [&str; 5] = [
    "completed",
    "failed",
    "cancelled",
    "interrupted",
    "rolled_back",
];

/// `issueMcpClientSession` with `access: "full-access"`: the scopes, subject, runtime ceiling
/// and label the T3 CLI's own session carries. Revoked when the command ends.
const SESSION_LABEL: &str = "t3 thread cli";
const MCP_PROTOCOL_VERSION: &str = "2025-06-18";
const CLIENT_NAME: &str = "t3-thread-cli";

/// How long one HTTP exchange with the local server may take. A wait slice is 15 s.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const READ_TIMEOUT: Duration = Duration::from_secs(300);
/// The largest answer read from `/mcp`. A page holds at most 100 items of 20,000 characters.
const MAX_RESPONSE_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub enum ThreadCommand {
    List {
        project: String,
        json: bool,
    },
    Start {
        project: String,
        message: String,
        title: Option<String>,
        provider: Option<String>,
        model: Option<String>,
        worktree: Option<String>,
        branch: Option<String>,
        wait: bool,
        json: bool,
    },
    Send {
        thread: String,
        message: String,
        wait: bool,
        json: bool,
    },
    Show {
        thread: String,
        messages: usize,
        json: bool,
    },
}

/// How a command ends when it does not succeed: one line on stderr and an exit code.
#[derive(Debug, PartialEq, Eq)]
struct Exit {
    code: i32,
    message: String,
}

impl Exit {
    fn fail(message: impl Into<String>) -> Self {
        Self {
            code: 1,
            message: message.into(),
        }
    }
}

type Outcome<T> = Result<T, Exit>;

/// Runs a thread command. Returns the exit code.
pub fn run(state_dir: &Path, command: ThreadCommand) -> i32 {
    match execute(state_dir, command) {
        Ok(()) => 0,
        Err(exit) => {
            eprintln!("{}", exit.message);
            exit.code
        }
    }
}

fn execute(state_dir: &Path, command: ThreadCommand) -> Outcome<()> {
    match command {
        ThreadCommand::List { project, json } => with_tools(state_dir, |tools| {
            let project = resolve_project(tools, &project)?;
            let mut threads: Vec<Value> = Vec::new();
            let mut cursor = Some(0u64);
            while let Some(at) = cursor {
                let page = tools.call(
                    "t3_thread_list",
                    json!({"projectId": project.id, "includeSubagents": false, "limit": 100, "cursor": at}),
                )?;
                let Some(items) = page.get("threads").and_then(Value::as_array) else {
                    return Err(unexpected("t3_thread_list"));
                };
                threads.extend(items.iter().cloned());
                cursor = next_cursor(&page, "t3_thread_list")?;
            }
            if json {
                let schema = tool_output_schema("t3_thread_list");
                let item = schema
                    .as_ref()
                    .and_then(|s| s.path(&["properties", "threads"]));
                print_line(&ordered(&Value::Array(threads), item));
            } else {
                for thread in &threads {
                    print_line(&format!(
                        "{}  {:<11}  {}",
                        text_of(thread, "threadId"),
                        text_of(thread, "status"),
                        text_of(thread, "title")
                    ));
                }
            }
            Ok(())
        }),
        ThreadCommand::Start {
            project,
            message,
            title,
            provider,
            model,
            worktree,
            branch,
            wait,
            json,
        } => {
            let message = read_message(&message)?;
            let workspace_strategy = match (worktree, branch) {
                (None, Some(_)) => {
                    return Err(Exit::fail("--branch needs --worktree <base-ref>."));
                }
                (None, None) => None,
                (Some(base_ref), branch) => {
                    let mut strategy = json!({"type": "worktree", "baseRef": base_ref});
                    if let Some(branch) = branch {
                        strategy["branch"] = json!(branch);
                    }
                    Some(strategy)
                }
            };
            let model_selection = match (provider, model) {
                (Some(instance), Some(model)) => {
                    Some(json!({"instanceId": instance, "model": model}))
                }
                (None, None) => None,
                _ => return Err(Exit::fail("--provider and --model go together.")),
            };
            let title = js_trim(&title.unwrap_or_else(|| title_from_message(&message))).to_owned();
            if title.is_empty() {
                return Err(Exit::fail("The title is empty."));
            }
            with_tools(state_dir, |tools| {
                let project = resolve_project(tools, &project)?;
                let mut args = json!({"projectId": project.id, "title": title, "message": message});
                if let Some(strategy) = &workspace_strategy {
                    args["workspaceStrategy"] = strategy.clone();
                }
                if let Some(selection) = &model_selection {
                    args["modelSelection"] = selection.clone();
                }
                let launched = tools.call("t3_thread_launch", args)?;
                let (Some(thread_id), Some(project_id)) = (
                    launched.get("threadId").and_then(Value::as_str),
                    launched.get("projectId").and_then(Value::as_str),
                ) else {
                    return Err(unexpected("t3_thread_launch"));
                };
                let run_id = match launched.get("runId") {
                    Some(Value::String(id)) => Some(id.as_str()),
                    Some(Value::Null) => None,
                    _ => return Err(unexpected("t3_thread_launch")),
                };
                if wait && let Some(run_id) = run_id {
                    if !json {
                        eprintln!("Thread {thread_id}");
                    }
                    return finish_run(tools, thread_id, run_id, json, true);
                }
                if json {
                    print_line(&object(&[
                        ("threadId", json!(thread_id)),
                        ("projectId", json!(project_id)),
                        ("runId", json!(run_id)),
                    ]));
                } else {
                    print_line(thread_id);
                }
                Ok(())
            })
        }
        ThreadCommand::Send {
            thread,
            message,
            wait,
            json,
        } => {
            let thread_id = decode_thread_id(&thread)?;
            let message = read_message(&message)?;
            with_tools(state_dir, |tools| {
                // Work already running when this is sent is not this message's to wait for.
                let follow_wakes = if wait {
                    thread_is_idle(tools, &thread_id)?
                } else {
                    false
                };
                let sent = tools.call(
                    "t3_thread_send",
                    json!({"threadId": thread_id, "message": message, "mode": "queue"}),
                )?;
                let Some(run_id) = sent.get("runId").and_then(Value::as_str) else {
                    return Err(unexpected("t3_thread_send"));
                };
                if wait {
                    return finish_run(tools, &thread_id, run_id, json, follow_wakes);
                }
                if json {
                    let schema = tool_output_schema("t3_thread_send");
                    print_line(&ordered(&sent, schema.as_ref()));
                } else if sent.get("delivery").and_then(Value::as_str) == Some("queued") {
                    print_line("Queued.");
                } else {
                    print_line("Sent.");
                }
                Ok(())
            })
        }
        ThreadCommand::Show {
            thread,
            messages: count,
            json,
        } => {
            let thread_id = decode_thread_id(&thread)?;
            with_tools(state_dir, |tools| {
                let (thread, latest) = read_latest_messages(tools, &thread_id, count)?;
                let mut messages = Vec::with_capacity(latest.len());
                for item in &latest {
                    let role = if item.get("type").and_then(Value::as_str) == Some("user_message") {
                        "user"
                    } else {
                        "assistant"
                    };
                    let text = read_full_text(tools, &thread_id, item)?;
                    messages.push((
                        role,
                        item.get("runId").cloned().unwrap_or(Value::Null),
                        text,
                    ));
                }
                if json {
                    let schema = tool_output_schema("t3_thread_read");
                    let detail = schema
                        .as_ref()
                        .and_then(|s| s.path(&["properties", "thread"]));
                    let rendered: Vec<String> = messages
                        .iter()
                        .map(|(role, run_id, text)| {
                            object(&[
                                ("role", json!(role)),
                                ("runId", run_id.clone()),
                                ("text", json!(text)),
                            ])
                        })
                        .collect();
                    print_line(&format!(
                        "{{\"thread\":{},\"messages\":[{}]}}",
                        ordered(&thread, detail),
                        rendered.join(",")
                    ));
                    return Ok(());
                }
                print_line(&text_of(&thread, "title"));
                print_line(&format!(
                    "{}  {}  {}/{}",
                    text_of(&thread, "threadId"),
                    text_of(&thread, "status"),
                    text_of(&thread, "providerInstanceId"),
                    text_of(&thread, "model")
                ));
                if let Some(path) = thread.get("worktreePath").and_then(Value::as_str) {
                    let branch = thread
                        .get("branch")
                        .and_then(Value::as_str)
                        .unwrap_or("(no branch)");
                    print_line(&format!("{branch}  {path}"));
                }
                let pending = thread
                    .get("pendingRequestCount")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                if pending > 0 {
                    print_line(&format!("Waiting for {pending} answer(s)."));
                }
                for (role, _, text) in &messages {
                    print_line(&format!("\n[{role}]\n{text}"));
                }
                Ok(())
            })
        }
    }
}

// ---------------------------------------------------------------------------------------
// The session and the MCP connection

/// `withThreadTools`: finds the running server, signs in as a short-lived MCP client of it,
/// runs `work`, and revokes the session whatever `work` returned.
fn with_tools<T>(state_dir: &Path, work: impl FnOnce(&mut Tools) -> Outcome<T>) -> Outcome<T> {
    let Some(runtime) = home::read_runtime_state(state_dir) else {
        return Err(Exit::fail(format!(
            "No running Conn Server uses {}. Start Conn, then retry.",
            base_dir(state_dir).display()
        )));
    };
    let auth_path = state_dir.join("auth.json");
    let auth = AuthStore::open(auth_path.clone())
        .map_err(|e| Exit::fail(format!("could not read {}: {e}", auth_path.display())))?;
    let issued = auth
        .issue_mcp_client_session(SESSION_LABEL, "full-access", false, ClientInfo::default())
        .map_err(|e| Exit::fail(format!("could not issue a session: {e}")))?;
    let mut tools = Tools {
        client: McpClient::new(&runtime.origin, &issued.token),
        origin: runtime.origin.clone(),
    };
    let result = match tools.client.initialize() {
        Ok(()) => work(&mut tools),
        Err(cause) => Err(tools.unreachable(&cause)),
    };
    tools.client.terminate();
    if let Err(error) = auth.revoke_session(None, &issued.principal.session_id) {
        eprintln!("could not revoke the CLI's session: {error}");
    }
    result
}

/// The home that holds `userdata`, as the T3 CLI names it in its messages.
fn base_dir(state_dir: &Path) -> &Path {
    match (state_dir.file_name(), state_dir.parent()) {
        (Some(name), Some(parent)) if name == "userdata" => parent,
        _ => state_dir,
    }
}

struct Tools {
    client: McpClient,
    origin: String,
}

impl Tools {
    fn unreachable(&self, cause: &str) -> Exit {
        Exit::fail(format!(
            "Could not reach the Conn Server at {}. {cause}",
            self.origin
        ))
    }

    /// One tool call; its `structuredContent` on success.
    fn call(&mut self, tool: &str, arguments: Value) -> Outcome<Value> {
        let envelope = self
            .client
            .request("tools/call", json!({"name": tool, "arguments": arguments}))
            .map_err(|cause| self.unreachable(&cause))?;
        let result = envelope.get("result").cloned().unwrap_or(Value::Null);
        let Some(fields) = result.as_object() else {
            return Err(unexpected(tool));
        };
        let is_error = match fields.get("isError") {
            None => false,
            Some(Value::Bool(flag)) => *flag,
            Some(_) => return Err(unexpected(tool)),
        };
        let content = match fields.get("content") {
            None => Vec::new(),
            Some(Value::Array(parts)) => parts.clone(),
            Some(_) => return Err(unexpected(tool)),
        };
        let content_ok = content.iter().all(|part| {
            part.get("type").is_some_and(Value::is_string)
                && part.get("text").is_none_or(Value::is_string)
        });
        if !content_ok {
            return Err(unexpected(tool));
        }
        if is_error {
            return Err(Exit::fail(tool_failure_detail(&content)));
        }
        match fields.get("structuredContent") {
            Some(value @ Value::Object(_)) => Ok(value.clone()),
            _ => Err(unexpected(tool)),
        }
    }
}

fn unexpected(tool: &str) -> Exit {
    Exit::fail(format!(
        "The server sent an unexpected {tool} result. Update the t3 CLI to match the server."
    ))
}

/// `toolFailureDetail`: an `OrchestratorMcpFailure`'s message, else the text itself.
fn tool_failure_detail(content: &[Value]) -> String {
    let text = content
        .iter()
        .find_map(|part| part.get("text").and_then(Value::as_str))
        .unwrap_or_default();
    let failure: Option<Value> = serde_json::from_str(text).ok();
    let message = failure.as_ref().and_then(|failure| {
        let tagged = failure.get("_tag").and_then(Value::as_str) == Some("OrchestratorMcpFailure");
        let coded = failure.get("code").is_some_and(Value::is_string);
        failure
            .get("message")
            .and_then(Value::as_str)
            .filter(|_| tagged && coded)
    });
    match message {
        Some(message) => message.to_owned(),
        None if text.is_empty() => "The tool call failed.".into(),
        None => text.to_owned(),
    }
}

fn next_cursor(page: &Value, tool: &str) -> Outcome<Option<u64>> {
    match page.get("nextCursor") {
        Some(Value::Null) => Ok(None),
        Some(value) => value.as_u64().map(Some).ok_or_else(|| unexpected(tool)),
        None => Err(unexpected(tool)),
    }
}

/// Streamable HTTP to `/mcp`, one request per connection, as `mcpToolSession` speaks it.
struct McpClient {
    origin: String,
    authorization: String,
    session: Option<String>,
    protocol: Option<String>,
    next_id: u64,
}

struct HttpReply {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl HttpReply {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(n, _)| n.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

impl McpClient {
    fn new(origin: &str, token: &str) -> Self {
        Self {
            origin: origin.trim_end_matches('/').to_owned(),
            authorization: format!("Bearer {token}"),
            session: None,
            protocol: None,
            next_id: 0,
        }
    }

    fn initialize(&mut self) -> Result<(), String> {
        self.request(
            "initialize",
            json!({
                "protocolVersion": MCP_PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {"name": CLIENT_NAME, "version": "0.0.0"},
            }),
        )?;
        self.send(&json!({"jsonrpc": "2.0", "method": "notifications/initialized"}))?;
        Ok(())
    }

    /// Ends the MCP session; failures are ignored, as the T3 CLI ignores them.
    fn terminate(&mut self) {
        if self.session.is_some() {
            let _ = self.exchange("DELETE", None);
        }
    }

    fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = format!("t3-cli-{}", self.next_id);
        self.next_id += 1;
        let payloads =
            self.send(&json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}))?;
        let envelope = payloads
            .into_iter()
            .find(|payload| payload.get("id").and_then(Value::as_str) == Some(id.as_str()));
        match envelope {
            Some(envelope) => match envelope.get("error") {
                None => Ok(envelope),
                Some(error) => Err(format!("Conn MCP {method} failed: {error}")),
            },
            None => Err(format!("Conn MCP {method} failed.")),
        }
    }

    /// Posts one message; returns the JSON-RPC payloads of the answer.
    fn send(&mut self, message: &Value) -> Result<Vec<Value>, String> {
        let reply = self.exchange("POST", Some(&message.to_string()))?;
        if let Some(session) = reply.header("mcp-session-id") {
            self.session = Some(session.to_owned());
        }
        if !(200..300).contains(&reply.status) {
            return Err(format!(
                "Conn MCP endpoint responded with HTTP {}.",
                reply.status
            ));
        }
        let body = String::from_utf8_lossy(&reply.body);
        let event_stream = reply
            .header("content-type")
            .is_some_and(|t| t.trim_start().starts_with("text/event-stream"));
        let mut payloads = Vec::new();
        if event_stream {
            for line in body.lines() {
                if let Some(data) = line.strip_prefix("data:")
                    && let Ok(payload) = serde_json::from_str::<Value>(data.trim_start())
                {
                    payloads.push(payload);
                }
            }
        } else if !body.trim().is_empty() {
            let payload: Value = serde_json::from_str(body.trim())
                .map_err(|_| "Conn MCP endpoint sent a body that is not JSON.".to_owned())?;
            match payload {
                Value::Array(batch) => payloads.extend(batch),
                single => payloads.push(single),
            }
        }
        for payload in &payloads {
            if let Some(version) = payload
                .get("result")
                .and_then(|r| r.get("protocolVersion"))
                .and_then(Value::as_str)
            {
                self.protocol = Some(version.to_owned());
            }
        }
        Ok(payloads)
    }

    fn exchange(&self, method: &str, body: Option<&str>) -> Result<HttpReply, String> {
        let authority = self
            .origin
            .strip_prefix("http://")
            .ok_or_else(|| format!("unsupported origin {}", self.origin))?;
        let addr: SocketAddr = authority
            .to_socket_addrs()
            .map_err(|e| e.to_string())?
            .next()
            .ok_or("no address")?;
        let mut stream =
            TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT).map_err(|e| e.to_string())?;
        stream
            .set_read_timeout(Some(READ_TIMEOUT))
            .map_err(|e| e.to_string())?;
        let mut request = format!(
            "{method} /mcp HTTP/1.1\r\nhost: {authority}\r\naccept: application/json, text/event-stream\r\nauthorization: {}\r\n",
            self.authorization
        );
        if let Some(session) = &self.session {
            request.push_str(&format!("mcp-session-id: {session}\r\n"));
        }
        if let Some(protocol) = &self.protocol {
            request.push_str(&format!("mcp-protocol-version: {protocol}\r\n"));
        }
        let body = body.unwrap_or_default();
        if method == "POST" {
            request.push_str("content-type: application/json\r\n");
        }
        request.push_str(&format!(
            "content-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len()
        ));
        stream
            .write_all(request.as_bytes())
            .map_err(|e| e.to_string())?;
        let mut raw = Vec::new();
        stream
            .take(MAX_RESPONSE_BYTES)
            .read_to_end(&mut raw)
            .map_err(|e| e.to_string())?;
        parse_http_reply(&raw).ok_or_else(|| "the server sent a malformed HTTP answer".into())
    }
}

fn parse_http_reply(raw: &[u8]) -> Option<HttpReply> {
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n")?;
    let head = std::str::from_utf8(raw.get(..split)?).ok()?;
    let rest = raw.get(split + 4..)?;
    let mut lines = head.split("\r\n");
    let status: u16 = lines.next()?.split_whitespace().nth(1)?.parse().ok()?;
    let headers: Vec<(String, String)> = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_owned()))
        .collect();
    let chunked = headers
        .iter()
        .any(|(n, v)| n == "transfer-encoding" && v.to_ascii_lowercase().contains("chunked"));
    let body = if chunked {
        dechunk(rest)?
    } else {
        match headers
            .iter()
            .find(|(n, _)| n == "content-length")
            .and_then(|(_, v)| v.parse::<usize>().ok())
        {
            Some(length) => rest.get(..length.min(rest.len()))?.to_vec(),
            None => rest.to_vec(),
        }
    };
    Some(HttpReply {
        status,
        headers,
        body,
    })
}

fn dechunk(mut rest: &[u8]) -> Option<Vec<u8>> {
    let mut body = Vec::new();
    loop {
        let line_end = rest.windows(2).position(|w| w == b"\r\n")?;
        let size_text = std::str::from_utf8(rest.get(..line_end)?).ok()?;
        let size_text = size_text.split(';').next().unwrap_or_default().trim();
        let size = usize::from_str_radix(size_text, 16).ok()?;
        rest = rest.get(line_end + 2..)?;
        if size == 0 {
            return Some(body);
        }
        body.extend_from_slice(rest.get(..size)?);
        rest = rest.get(size + 2..)?;
    }
}

// ---------------------------------------------------------------------------------------
// Arguments

/// `readMessageArgument`: `-` reads stdin to its end.
fn read_message(argument: &str) -> Outcome<String> {
    let text = if argument == "-" {
        let mut bytes = Vec::new();
        io::stdin()
            .read_to_end(&mut bytes)
            .map_err(|e| Exit::fail(format!("could not read stdin: {e}")))?;
        String::from_utf8_lossy(&bytes).into_owned()
    } else {
        argument.to_owned()
    };
    if js_trim(&text).is_empty() {
        return Err(Exit::fail("The message is empty."));
    }
    Ok(text)
}

fn decode_thread_id(value: &str) -> Outcome<String> {
    let id = js_trim(js_trim(value));
    if id.is_empty() {
        return Err(Exit::fail(format!("'{value}' is not a thread id.")));
    }
    Ok(id.to_owned())
}

/// `String.prototype.trim`: white space, line terminators and the byte order mark.
fn js_trim(text: &str) -> &str {
    text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

/// `titleFromMessage`: the first line, cut to 80 UTF-16 units with an ellipsis.
pub fn title_from_message(message: &str) -> String {
    let first = js_trim(js_trim(message).split('\n').next().unwrap_or_default());
    let units: Vec<u16> = first.encode_utf16().collect();
    if units.len() <= TITLE_MAX_CHARS {
        return first.to_owned();
    }
    let mut end = TITLE_MAX_CHARS - 1;
    let previous = units.get(end - 1).copied().unwrap_or_default();
    let next = units.get(end).copied().unwrap_or_default();
    if (0xd800..=0xdbff).contains(&previous) && (0xdc00..=0xdfff).contains(&next) {
        end -= 1;
    }
    let head = String::from_utf16_lossy(units.get(..end).unwrap_or_default());
    format!("{}…", head.trim_end())
}

// ---------------------------------------------------------------------------------------
// Projects

struct Project {
    id: String,
    title: String,
    workspace_root: String,
}

fn list_all_projects(tools: &mut Tools) -> Outcome<Vec<Project>> {
    let mut projects = Vec::new();
    let mut cursor = Some(0u64);
    while let Some(at) = cursor {
        let page = tools.call("t3_project_list", json!({"cursor": at, "limit": 100}))?;
        let Some(items) = page.get("projects").and_then(Value::as_array) else {
            return Err(unexpected("t3_project_list"));
        };
        for item in items {
            let (Some(id), Some(title), Some(root)) = (
                item.get("id").and_then(Value::as_str),
                item.get("title").and_then(Value::as_str),
                item.get("workspaceRoot").and_then(Value::as_str),
            ) else {
                return Err(unexpected("t3_project_list"));
            };
            projects.push(Project {
                id: id.to_owned(),
                title: title.to_owned(),
                workspace_root: root.to_owned(),
            });
        }
        cursor = next_cursor(&page, "t3_project_list")?;
    }
    Ok(projects)
}

/// `resolveProject`: a project id, or a path inside a project's folder (the deepest project
/// wins). A path inside a git worktree resolves as the same path in the repository's other
/// checkouts.
fn resolve_project(tools: &mut Tools, identifier: &str) -> Outcome<Project> {
    let projects = list_all_projects(tools)?;
    let not_found = || {
        Exit::fail(format!(
            "No Conn project matches '{identifier}'. Pass a project id or a path inside a project."
        ))
    };
    if let Some(index) = projects.iter().position(|p| p.id == identifier) {
        return projects.into_iter().nth(index).ok_or_else(not_found);
    }
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
    let target = real_path(&lexical_resolve(&cwd, &expand_home(identifier)));
    let roots: Vec<PathBuf> = projects
        .iter()
        .map(|p| real_path(Path::new(&p.workspace_root)))
        .collect();
    if let Some(index) = deepest_containing(&roots, &target) {
        return projects.into_iter().nth(index).ok_or_else(not_found);
    }
    let git_dir = if target.is_file() {
        target.parent().map(Path::to_path_buf).unwrap_or_default()
    } else {
        target.clone()
    };
    let listed: Vec<PathBuf> = list_git_checkouts(&git_dir)
        .iter()
        .map(|p| real_path(Path::new(p)))
        .collect();
    let Some(own) = listed
        .iter()
        .filter(|checkout| contains(checkout, &target))
        .fold(None::<&PathBuf>, |best, checkout| match best {
            Some(best) if path_len(best) >= path_len(checkout) => Some(best),
            _ => Some(checkout),
        })
    else {
        return Err(not_found());
    };
    let relative = target.strip_prefix(own).unwrap_or(Path::new(""));
    let mut matches: Vec<usize> = Vec::new();
    for checkout in &listed {
        if checkout == own {
            continue;
        }
        let candidate = if relative.as_os_str().is_empty() {
            checkout.clone()
        } else {
            checkout.join(relative)
        };
        if let Some(index) = deepest_containing(&roots, &candidate)
            && !matches
                .iter()
                .any(|m| projects.get(*m).map(|p| &p.id) == projects.get(index).map(|p| &p.id))
        {
            matches.push(index);
        }
    }
    match matches.as_slice() {
        [] => Err(not_found()),
        [only] => projects.into_iter().nth(*only).ok_or_else(not_found),
        several => {
            let names: Vec<String> = several
                .iter()
                .filter_map(|i| projects.get(*i))
                .map(|p| format!("{} ({})", p.title, p.id))
                .collect();
            Err(Exit::fail(format!(
                "'{identifier}' is in a git worktree shared by several projects: {}. Pass a project id instead.",
                names.join(", ")
            )))
        }
    }
}

fn path_len(path: &Path) -> usize {
    path.as_os_str().len()
}

fn contains(root: &Path, candidate: &Path) -> bool {
    candidate.starts_with(root)
}

/// The index of the project whose root holds `candidate` and is longest; the first on a tie.
fn deepest_containing(roots: &[PathBuf], candidate: &Path) -> Option<usize> {
    let mut best: Option<usize> = None;
    for (index, root) in roots.iter().enumerate() {
        if !contains(root, candidate) {
            continue;
        }
        let longer = best
            .and_then(|b| roots.get(b))
            .is_none_or(|b| path_len(root) > path_len(b));
        if longer {
            best = Some(index);
        }
    }
    best
}

fn expand_home(input: &str) -> PathBuf {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    match (input, home) {
        ("~", Some(home)) => home,
        (_, Some(home)) if input.starts_with("~/") || input.starts_with("~\\") => {
            home.join(input.get(2..).unwrap_or_default())
        }
        _ => PathBuf::from(input),
    }
}

/// `path.resolve(cwd, input)`: absolute, with `.` and `..` folded, symlinks untouched.
fn lexical_resolve(cwd: &Path, input: &Path) -> PathBuf {
    let joined = if input.is_absolute() {
        input.to_path_buf()
    } else {
        cwd.join(input)
    };
    let mut out = PathBuf::new();
    for component in joined.components() {
        match component {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// `realPath`, or the path itself when it does not resolve.
fn real_path(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// `listGitCheckouts`: the non-bare checkouts of the repository at `directory`.
fn list_git_checkouts(directory: &Path) -> Vec<String> {
    let list = |extra: &[&str]| -> Option<String> {
        let output = std::process::Command::new("git")
            .args(["worktree", "list", "--porcelain"])
            .args(extra)
            .current_dir(directory)
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .output()
            .ok()?;
        output
            .status
            .success()
            .then(|| String::from_utf8_lossy(&output.stdout).into_owned())
    };
    // Git before 2.36 refuses `-z`; its line output is turned into NUL records.
    let stdout = list(&["-z"])
        .or_else(|| list(&[]).map(|text| text.replace('\n', "\0")))
        .unwrap_or_default();
    parse_worktree_records(&stdout)
}

fn parse_worktree_records(stdout: &str) -> Vec<String> {
    stdout
        .split("\0\0")
        .filter_map(|record| {
            let mut fields = record.split('\0');
            let first = fields.next().unwrap_or_default();
            let bare = fields.any(|field| field == "bare");
            first
                .strip_prefix("worktree ")
                .filter(|_| !bare)
                .map(str::to_owned)
        })
        .collect()
}

// ---------------------------------------------------------------------------------------
// Reading a thread

fn read(tools: &mut Tools, arguments: Value) -> Outcome<Value> {
    let page = tools.call("t3_thread_read", arguments)?;
    let valid = page.get("thread").is_some_and(Value::is_object)
        && page.get("recentRuns").is_some_and(Value::is_array)
        && page.get("items").is_some_and(Value::is_array)
        && page.get("hasMore").is_some_and(Value::is_boolean);
    if valid {
        Ok(page)
    } else {
        Err(unexpected("t3_thread_read"))
    }
}

fn items_of(page: &Value) -> Vec<Value> {
    page.get("items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn has_more(page: &Value) -> bool {
    page.get("hasMore")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn next_position(page: &Value) -> Option<i64> {
    page.get("nextPosition").and_then(Value::as_i64)
}

/// `readTimeline`: every item on a view, oldest first.
fn read_timeline(tools: &mut Tools, thread_id: &str, view: &str) -> Outcome<Vec<Value>> {
    let mut items = Vec::new();
    let mut after: Option<i64> = None;
    loop {
        let mut args = json!({
            "threadId": thread_id, "view": view, "limit": READ_PAGE_LIMIT,
            "maxCharsPerItem": READ_ITEM_MAX_CHARS, "runLimit": 1,
        });
        if let Some(after) = after {
            args["afterPosition"] = json!(after);
        }
        let page = read(tools, args)?;
        items.extend(items_of(&page));
        after = next_position(&page);
        if !(has_more(&page) && after.is_some()) {
            return Ok(items);
        }
    }
}

fn is_message(item: &Value) -> bool {
    matches!(
        item.get("type").and_then(Value::as_str),
        Some("user_message" | "assistant_message")
    )
}

/// `readLatestMessages`: the thread and its latest `count` user and assistant messages,
/// oldest first. The read starts near the end and widens backward while tool and plan
/// items leave too few messages.
fn read_latest_messages(
    tools: &mut Tools,
    thread_id: &str,
    count: usize,
) -> Outcome<(Value, Vec<Value>)> {
    let first = read(
        tools,
        json!({"threadId": thread_id, "limit": 1, "runLimit": 1}),
    )?;
    let mut thread = first.get("thread").cloned().unwrap_or(Value::Null);
    let mut messages: Vec<Value> = Vec::new();
    let mut before: Option<i64> = None;
    let mut start = thread.get("itemCount").and_then(Value::as_i64).unwrap_or(0);
    let mut span = i64::try_from(count.max(READ_PAGE_LIMIT as usize)).unwrap_or(i64::MAX);
    loop {
        let end = before;
        start = (start - span).max(0);
        let mut window: Vec<Value> = Vec::new();
        let mut after = start - 1;
        loop {
            let mut args = json!({
                "threadId": thread_id, "view": "messages", "limit": READ_PAGE_LIMIT,
                "maxCharsPerItem": READ_ITEM_MAX_CHARS, "runLimit": 1,
            });
            if after >= 0 {
                args["afterPosition"] = json!(after);
            }
            let page = read(tools, args)?;
            window.extend(items_of(&page).into_iter().filter(|item| {
                let position = item.get("position").and_then(Value::as_i64).unwrap_or(0);
                is_message(item) && end.is_none_or(|end| position < end)
            }));
            thread = page.get("thread").cloned().unwrap_or(Value::Null);
            match next_position(&page) {
                Some(next) => after = next,
                None => break,
            }
            let limit = end.map_or(i64::MAX, |end| end - 1);
            if !(has_more(&page) && after < limit) {
                break;
            }
        }
        window.append(&mut messages);
        messages = window;
        before = Some(start);
        span = span.saturating_mul(2);
        if !(messages.len() < count && start > 0) {
            break;
        }
    }
    let skip = messages.len().saturating_sub(count);
    Ok((thread, messages.split_off(skip)))
}

/// `readFullText`: an item's text past the read's per-item cap.
fn read_full_text(tools: &mut Tools, thread_id: &str, item: &Value) -> Outcome<String> {
    let mut text = item
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let next_offset = |item: &Value| -> Option<u64> {
        if item.get("textTruncated").and_then(Value::as_bool) == Some(true) {
            item.get("nextTextOffset").and_then(Value::as_u64)
        } else {
            None
        }
    };
    let item_id = item.get("itemId").cloned().unwrap_or(Value::Null);
    let mut offset = next_offset(item);
    while let Some(at) = offset {
        let page = read(
            tools,
            json!({"threadId": thread_id, "itemId": item_id, "textOffset": at, "runLimit": 1, "maxCharsPerItem": READ_ITEM_MAX_CHARS}),
        )?;
        let Some(chunk) = items_of(&page)
            .into_iter()
            .find(|c| c.get("itemId") == Some(&item_id))
        else {
            break;
        };
        text.push_str(
            chunk
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        );
        offset = next_offset(&chunk);
    }
    Ok(text)
}

/// `runResultText`: the run's last assistant message, or its last error.
fn run_result_text(
    tools: &mut Tools,
    thread_id: &str,
    run_id: &str,
    kind: &str,
) -> Outcome<Option<String>> {
    let view = if kind == "assistant_message" {
        "messages"
    } else {
        "activity"
    };
    let items = read_timeline(tools, thread_id, view)?;
    let last = items.iter().rev().find(|item| {
        item.get("runId").and_then(Value::as_str) == Some(run_id)
            && item.get("type").and_then(Value::as_str) == Some(kind)
    });
    match last {
        Some(item) => read_full_text(tools, thread_id, item).map(Some),
        None => Ok(None),
    }
}

// ---------------------------------------------------------------------------------------
// Waiting for a run

struct Waited {
    run_id: Option<String>,
    status: String,
    timed_out: bool,
    result_run: Option<(String, String)>,
}

fn wait_call(tools: &mut Tools, arguments: Value) -> Outcome<Waited> {
    let waited = tools.call("t3_thread_wait", arguments)?;
    let run_id = match waited.get("runId") {
        Some(Value::String(id)) => Some(id.clone()),
        Some(Value::Null) => None,
        _ => return Err(unexpected("t3_thread_wait")),
    };
    let (Some(status), Some(timed_out)) = (
        waited.get("status").and_then(Value::as_str),
        waited.get("timedOut").and_then(Value::as_bool),
    ) else {
        return Err(unexpected("t3_thread_wait"));
    };
    let result_run = waited.get("resultRun").and_then(|r| {
        Some((
            r.get("runId")?.as_str()?.to_owned(),
            r.get("status")?.as_str()?.to_owned(),
        ))
    });
    Ok(Waited {
        run_id,
        status: status.to_owned(),
        timed_out,
        result_run,
    })
}

/// `threadIsIdle`: no active run and no delegated or background work.
fn thread_is_idle(tools: &mut Tools, thread_id: &str) -> Outcome<bool> {
    let waited = wait_call(
        tools,
        json!({"threadId": thread_id, "timeoutMs": 1, "untilDelegatedWorkSettled": true}),
    )?;
    Ok(!waited.timed_out)
}

fn pending_request_count(tools: &mut Tools, thread_id: &str) -> Outcome<u64> {
    let page = read(
        tools,
        json!({"threadId": thread_id, "limit": 1, "runLimit": 1}),
    )?;
    Ok(page
        .get("thread")
        .and_then(|t| t.get("pendingRequestCount"))
        .and_then(Value::as_u64)
        .unwrap_or(0))
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum WaitOutcome {
    Ended {
        run_id: Option<String>,
        status: String,
    },
    NeedsInput,
}

struct RunsAfter {
    later: Vec<(String, String)>,
    sent: bool,
}

/// `runsAfter`: the runs after `run_id`, and whether one holds a message someone sent.
fn runs_after(tools: &mut Tools, thread_id: &str, run_id: &str) -> Outcome<RunsAfter> {
    let page = read(
        tools,
        json!({"threadId": thread_id, "limit": 1, "runLimit": 50}),
    )?;
    let runs: Vec<(String, u64, String)> = page
        .get("recentRuns")
        .and_then(Value::as_array)
        .map(|runs| {
            runs.iter()
                .filter_map(|run| {
                    Some((
                        run.get("runId")?.as_str()?.to_owned(),
                        run.get("ordinal")?.as_u64()?,
                        run.get("status")?.as_str()?.to_owned(),
                    ))
                })
                .collect()
        })
        .unwrap_or_default();
    let Some(own) = runs.iter().find(|(id, _, _)| id == run_id).map(|r| r.1) else {
        return Ok(RunsAfter {
            later: Vec::new(),
            sent: true,
        });
    };
    let later: Vec<(String, String)> = runs
        .into_iter()
        .filter(|(_, ordinal, _)| *ordinal > own)
        .map(|(id, _, status)| (id, status))
        .collect();
    if later.is_empty() {
        return Ok(RunsAfter { later, sent: false });
    }
    let items = read_timeline(tools, thread_id, "messages")?;
    let sent = items.iter().any(|item| {
        item.get("type").and_then(Value::as_str) == Some("user_message")
            && item
                .get("runId")
                .and_then(Value::as_str)
                .is_some_and(|id| later.iter().any(|(run, _)| run == id))
    });
    Ok(RunsAfter { later, sent })
}

/// `waitForRun`: waits for this exact run, following a restart to its continuation. With
/// `follow_wakes`, a completed run is followed to the runs its background work wakes, as long
/// as no one else sends to the thread.
fn wait_for_run(
    tools: &mut Tools,
    thread_id: &str,
    run_id: &str,
    follow_wakes: bool,
) -> Outcome<WaitOutcome> {
    let slice = |tools: &mut Tools, timeout_ms: u64, settled: bool| {
        let mut args = json!({"threadId": thread_id, "runId": run_id, "timeoutMs": timeout_ms});
        if settled {
            args["untilDelegatedWorkSettled"] = json!(true);
        }
        wait_call(tools, args)
    };
    let ended = |waited: &Waited| WaitOutcome::Ended {
        run_id: waited.run_id.clone(),
        status: waited.status.clone(),
    };
    let outcome = loop {
        let waited = slice(tools, WAIT_SLICE_MS, false)?;
        if !waited.timed_out {
            break ended(&waited);
        }
        // A pending request on this run, or on an earlier run it is queued behind, blocks
        // it until someone answers.
        if pending_request_count(tools, thread_id)? > 0 {
            // The count is thread-wide: if this run ended since the slice, the request
            // belongs to a later run.
            let recheck = slice(tools, 1, false)?;
            break if recheck.timed_out {
                WaitOutcome::NeedsInput
            } else {
                ended(&recheck)
            };
        }
    };
    let final_run_id = match &outcome {
        WaitOutcome::Ended { run_id: id, status } if follow_wakes && status == "completed" => {
            id.clone().unwrap_or_else(|| run_id.to_owned())
        }
        _ => return Ok(outcome),
    };
    let mut work_outlived_run = false;
    loop {
        let waited = slice(tools, WAIT_SLICE_MS, true)?;
        let after = runs_after(tools, thread_id, &final_run_id)?;
        if after.sent {
            return Ok(outcome);
        }
        if !waited.timed_out {
            if let Some((result_id, result_status)) = &waited.result_run
                && after.later.iter().any(|(id, _)| id == result_id)
            {
                return Ok(WaitOutcome::Ended {
                    run_id: Some(result_id.clone()),
                    status: result_status.clone(),
                });
            }
            if !work_outlived_run {
                return Ok(outcome);
            }
            if after
                .later
                .iter()
                .any(|(_, status)| !TERMINAL_RUN_STATUSES.contains(&status.as_str()))
            {
                continue;
            }
            if after.later.is_empty() && wake_run_recorded(tools, thread_id, &final_run_id)? {
                continue;
            }
            return Ok(outcome);
        }
        work_outlived_run = true;
        // Earlier runs have ended, so the request is on a run this one's work woke.
        if pending_request_count(tools, thread_id)? > 0 {
            return Ok(WaitOutcome::NeedsInput);
        }
    }
}

/// A provider records the run that background work wakes only after that work has ended, so
/// the thread briefly looks settled in between.
fn wake_run_recorded(tools: &mut Tools, thread_id: &str, run_id: &str) -> Outcome<bool> {
    let mut waited = 0;
    while waited < WAKE_GRACE_MS {
        std::thread::sleep(Duration::from_millis(WAKE_POLL_MS));
        let after = runs_after(tools, thread_id, run_id)?;
        if after.sent {
            return Ok(false);
        }
        if !after.later.is_empty() {
            return Ok(true);
        }
        waited += WAKE_POLL_MS;
    }
    Ok(false)
}

/// `finishRun`: waits, prints the result (with `--json` always, so a script keeps the thread
/// id when the run fails), and ends 1 on a run that did not complete, 2 on a question.
fn finish_run(
    tools: &mut Tools,
    thread_id: &str,
    run_id: &str,
    json: bool,
    follow_wakes: bool,
) -> Outcome<()> {
    let outcome = wait_for_run(tools, thread_id, run_id, follow_wakes)?;
    let (run_id, status) = match &outcome {
        WaitOutcome::Ended { run_id: id, status } => (
            id.clone().unwrap_or_else(|| run_id.to_owned()),
            status.clone(),
        ),
        WaitOutcome::NeedsInput => (run_id.to_owned(), "waiting".to_owned()),
    };
    let reply = if status == "completed" {
        run_result_text(tools, thread_id, &run_id, "assistant_message")?
    } else {
        None
    };
    let error = if status == "completed" || status == "waiting" {
        None
    } else {
        run_result_text(tools, thread_id, &run_id, "error")?
    };
    if json {
        print_line(&object(&[
            ("threadId", json!(thread_id)),
            ("runId", json!(run_id)),
            ("status", json!(status)),
            ("reply", json!(reply)),
            ("error", json!(error)),
        ]));
    } else if let Some(reply) = &reply {
        print_line(reply);
    }
    if outcome == WaitOutcome::NeedsInput {
        return Err(Exit {
            code: 2,
            message: format!(
                "Thread {thread_id} is waiting for an answer. Open it in Conn to respond."
            ),
        });
    }
    if status != "completed" {
        let reason = match error {
            Some(error) => format!(": {error}"),
            None => ".".into(),
        };
        return Err(Exit::fail(format!(
            "Thread {thread_id} stopped with status {status}{reason}"
        )));
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------
// Output

fn print_line(text: &str) {
    let mut out = io::stdout().lock();
    let _ = out.write_all(text.as_bytes());
    let _ = out.write_all(b"\n");
    let _ = out.flush();
}

fn text_of(value: &Value, key: &str) -> String {
    match value.get(key) {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Null) => "null".into(),
        None => "undefined".into(),
        Some(other) => other.to_string(),
    }
}

/// A JSON object with its keys in the given order, as `JSON.stringify` writes it.
fn object(fields: &[(&str, Value)]) -> String {
    let body: Vec<String> = fields
        .iter()
        .map(|(key, value)| format!("{}:{}", Value::from(*key), value))
        .collect();
    format!("{{{}}}", body.join(","))
}

/// A JSON value whose object keys keep their written order: a tool's advertised schema,
/// which lists properties in the contract's order.
#[derive(Debug)]
enum Node {
    Object(Vec<(String, Node)>),
    Array(Vec<Node>),
    Leaf(Value),
}

impl Node {
    fn get(&self, key: &str) -> Option<&Node> {
        match self {
            Node::Object(fields) => fields.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    fn path(&self, keys: &[&str]) -> Option<&Node> {
        keys.iter().try_fold(self, |node, key| node.get(key))
    }

    fn is_type(&self, name: &str) -> bool {
        matches!(self.get("type"), Some(Node::Leaf(Value::String(t))) if t == name)
    }

    /// The branch of a union that describes `value`'s kind.
    fn branch_for(&self, value: &Value) -> &Node {
        let Some(Node::Array(branches)) = self.get("anyOf") else {
            return self;
        };
        let fits = |branch: &&Node| match value {
            Value::Object(_) => branch.is_type("object") || branch.get("properties").is_some(),
            Value::Array(_) => branch.is_type("array") || branch.get("items").is_some(),
            _ => false,
        };
        branches.iter().find(fits).unwrap_or(self)
    }
}

impl<'de> Deserialize<'de> for Node {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct NodeVisitor;
        impl<'de> Visitor<'de> for NodeVisitor {
            type Value = Node;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("JSON")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Node, A::Error> {
                let mut fields = Vec::new();
                while let Some((key, value)) = map.next_entry::<String, Node>()? {
                    fields.push((key, value));
                }
                Ok(Node::Object(fields))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Node, A::Error> {
                let mut items = Vec::new();
                while let Some(item) = seq.next_element::<Node>()? {
                    items.push(item);
                }
                Ok(Node::Array(items))
            }
            fn visit_bool<E>(self, v: bool) -> Result<Node, E> {
                Ok(Node::Leaf(Value::Bool(v)))
            }
            fn visit_i64<E>(self, v: i64) -> Result<Node, E> {
                Ok(Node::Leaf(Value::from(v)))
            }
            fn visit_u64<E>(self, v: u64) -> Result<Node, E> {
                Ok(Node::Leaf(Value::from(v)))
            }
            fn visit_f64<E>(self, v: f64) -> Result<Node, E> {
                Ok(Node::Leaf(Value::from(v)))
            }
            fn visit_str<E>(self, v: &str) -> Result<Node, E> {
                Ok(Node::Leaf(Value::String(v.to_owned())))
            }
            fn visit_string<E>(self, v: String) -> Result<Node, E> {
                Ok(Node::Leaf(Value::String(v)))
            }
            fn visit_unit<E>(self) -> Result<Node, E> {
                Ok(Node::Leaf(Value::Null))
            }
            fn visit_none<E>(self) -> Result<Node, E> {
                Ok(Node::Leaf(Value::Null))
            }
        }
        deserializer.deserialize_any(NodeVisitor)
    }
}

/// The output schema `/mcp` advertises for `tool`, with its key order.
fn tool_output_schema(tool: &str) -> Option<Node> {
    let line = conn_mcp::tool_definition(tool)?;
    let definition: Node = serde_json::from_str(line).ok()?;
    match definition {
        Node::Object(fields) => fields
            .into_iter()
            .find(|(key, _)| key == "outputSchema")
            .map(|(_, schema)| schema),
        _ => None,
    }
}

/// `value` as the T3 CLI prints it after decoding it with the contract's schema: object keys
/// in the schema's order, keys the schema does not list dropped.
fn ordered(value: &Value, schema: Option<&Node>) -> String {
    let mut out = String::new();
    write_ordered(&mut out, value, schema);
    out
}

fn write_ordered(out: &mut String, value: &Value, schema: Option<&Node>) {
    let schema = schema.map(|s| s.branch_for(value));
    match value {
        Value::Object(fields) => {
            out.push('{');
            let mut first = true;
            let mut field = |out: &mut String, key: &str, value: &Value, schema: Option<&Node>| {
                if !first {
                    out.push(',');
                }
                first = false;
                out.push_str(&Value::from(key).to_string());
                out.push(':');
                write_ordered(out, value, schema);
            };
            match schema.and_then(|s| s.get("properties")) {
                Some(Node::Object(properties)) => {
                    for (key, property) in properties {
                        if let Some(value) = fields.get(key) {
                            field(out, key, value, Some(property));
                        }
                    }
                }
                _ => {
                    for (key, value) in fields {
                        field(out, key, value, None);
                    }
                }
            }
            out.push('}');
        }
        Value::Array(items) => {
            let item_schema = schema.and_then(|s| s.get("items"));
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_ordered(out, item, item_schema);
            }
            out.push(']');
        }
        leaf => out.push_str(&leaf.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titles_follow_the_t3_cli() {
        assert_eq!(title_from_message("  Fix it\nmore"), "Fix it");
        let long = "a".repeat(100);
        assert_eq!(title_from_message(&long), format!("{}…", "a".repeat(79)));
        // A surrogate pair is not split.
        // The cut at 79 units would fall inside the pair at units 78 and 79.
        let emoji = format!("{}😀b", "a".repeat(78));
        assert_eq!(
            title_from_message(&format!("{emoji}{}", "c".repeat(10))),
            format!("{}…", "a".repeat(78))
        );
        let whole = format!("{}😀b", "a".repeat(77));
        assert_eq!(
            title_from_message(&format!("{whole}{}", "c".repeat(10))),
            format!("{}😀…", "a".repeat(77))
        );
    }

    #[test]
    fn thread_ids_are_trimmed_and_blank_is_refused() {
        assert_eq!(decode_thread_id(" t1 ").unwrap(), "t1");
        assert_eq!(
            decode_thread_id(" ").unwrap_err().message,
            "' ' is not a thread id."
        );
    }

    #[test]
    fn output_keeps_the_schema_order_and_drops_unknown_keys() {
        let schema: Node = serde_json::from_str(
            r#"{"type":"object","properties":{"b":{"type":"string"},"a":{"anyOf":[{"type":"object","properties":{"z":{},"y":{}}},{"type":"null"}]},"c":{"type":"array","items":{"type":"object","properties":{"q":{},"p":{}}}}}}"#,
        )
        .unwrap();
        let value =
            json!({"a": {"y": 1, "z": 2}, "b": "x", "extra": true, "c": [{"p": 1, "q": 2}]});
        assert_eq!(
            ordered(&value, Some(&schema)),
            r#"{"b":"x","a":{"z":2,"y":1},"c":[{"q":2,"p":1}]}"#
        );
        assert_eq!(ordered(&json!({"a": null}), Some(&schema)), r#"{"a":null}"#);
    }

    #[test]
    fn the_catalog_has_the_schemas_the_cli_prints() {
        for (tool, path) in [
            (
                "t3_thread_list",
                vec!["properties", "threads", "items", "properties", "threadId"],
            ),
            (
                "t3_thread_read",
                vec!["properties", "thread", "properties", "pendingRequestCount"],
            ),
            ("t3_thread_send", vec!["properties", "delivery"]),
        ] {
            let schema = tool_output_schema(tool).unwrap();
            assert!(schema.path(&path).is_some(), "{tool}");
        }
    }

    #[test]
    fn failures_read_like_the_t3_cli() {
        let failure = json!({"_tag": "OrchestratorMcpFailure", "code": "thread_not_found", "message": "Thread x is no longer available."});
        assert_eq!(
            tool_failure_detail(&[json!({"type": "text", "text": failure.to_string()})]),
            "Thread x is no longer available."
        );
        assert_eq!(
            tool_failure_detail(&[json!({"type": "text", "text": "plain"})]),
            "plain"
        );
        assert_eq!(tool_failure_detail(&[]), "The tool call failed.");
    }

    #[test]
    fn http_answers_are_read_plain_or_chunked() {
        let plain = parse_http_reply(
            b"HTTP/1.1 200 OK\r\nMcp-Session-Id: s1\r\ncontent-length: 2\r\n\r\n{}",
        )
        .unwrap();
        assert_eq!(plain.status, 200);
        assert_eq!(plain.header("mcp-session-id"), Some("s1"));
        assert_eq!(plain.body, b"{}");
        let chunked = parse_http_reply(
            b"HTTP/1.1 202 Accepted\r\ntransfer-encoding: chunked\r\n\r\n3\r\nabc\r\n2\r\nde\r\n0\r\n\r\n",
        )
        .unwrap();
        assert_eq!(chunked.status, 202);
        assert_eq!(chunked.body, b"abcde");
        assert!(parse_http_reply(b"garbage").is_none());
        assert!(
            parse_http_reply(b"HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\nzz\r\n")
                .is_none()
        );
    }

    #[test]
    fn worktree_records_skip_bare_checkouts() {
        let out = "worktree /a\0HEAD 1\0branch refs/heads/main\0\0worktree /b\0bare\0\0worktree /c\0detached\0\0";
        assert_eq!(parse_worktree_records(out), vec!["/a", "/c"]);
    }

    #[test]
    fn the_deepest_project_wins() {
        let roots = vec![
            PathBuf::from("/w"),
            PathBuf::from("/w/sub"),
            PathBuf::from("/x"),
        ];
        assert_eq!(
            deepest_containing(&roots, Path::new("/w/sub/file")),
            Some(1)
        );
        assert_eq!(deepest_containing(&roots, Path::new("/w/other")), Some(0));
        assert_eq!(deepest_containing(&roots, Path::new("/wx")), None);
        assert_eq!(
            lexical_resolve(Path::new("/w/sub"), Path::new("../x/./y")),
            PathBuf::from("/w/x/y")
        );
    }

    #[test]
    fn the_base_dir_is_the_home_above_userdata() {
        assert_eq!(base_dir(Path::new("/h/.t3/userdata")), Path::new("/h/.t3"));
        assert_eq!(base_dir(Path::new("/tmp/state")), Path::new("/tmp/state"));
    }
}
