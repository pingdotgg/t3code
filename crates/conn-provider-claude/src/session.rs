//! [`ClaudeSession`]: one provider session, at most one live SDK query.
//!
//! A query is the SDK's `query()` in the shared helper process ([`crate::helper`]); the SDK
//! starts and drives the `claude` CLI. The query opens lazily on the first turn (as T3 opens
//! its SDK query then), and again after it ended, went idle, or the thread, working directory
//! or launch options changed. A driver task per query reads its events, feeds the [`Mapper`],
//! and forwards provider events and callback answers in order. An idle watcher per query ends
//! it after [`ClaudeConfig::idle_timeout`]; the next turn resumes the conversation. State sits
//! behind one `std` mutex that is never held across an `.await`.

use std::{
    collections::HashSet,
    sync::{Arc, Mutex, MutexGuard},
    time::{Duration, Instant},
};

use conn_contract::{ProviderSessionId, ProviderThread, from_json, to_json};
use conn_provider::{
    BoxFuture, EnsureThreadInput, ForkThreadInput, InterruptInput, McpServer, ProviderError,
    ProviderEvent, ProviderResult, ResumeThreadInput, RollbackTarget, RollbackThreadInput,
    RuntimePolicy, RuntimeRequestResponse, Session, SteerInput, ThreadSnapshot, TurnInput,
};
use serde_json::{Map, Value, json};
use tokio::sync::{mpsc, watch};

use crate::DRIVER;
use crate::attachments;
use crate::catalog;
use crate::helper::{Helper, QueryEnd, QueryEvent, QueryHandle};
use crate::ids::{self, Env, SystemEnv};
use crate::launch::{
    self, BypassAvailability, ClaudeConfig, PolicyInput, QueryInput, QueryPolicy, T3_MCP_SERVER,
};
use crate::mapper::{Mapper, Out};
use crate::protocol::{
    CanUseTool, ControlRequest, Delivery, Elicitation, Inbound, UserDialog, user_message_value,
};

const CONTROL_TIMEOUT: Duration = Duration::from_secs(30);
/// `CLAUDE_BOOT_TIMEOUT`: the SDK leaves boot unbounded.
const BOOT_TIMEOUT: Duration = Duration::from_secs(5 * 60);
/// `CLAUDE_MCP_REGISTRATION_TIMEOUT`.
const MCP_REGISTRATION_TIMEOUT: Duration = Duration::from_secs(90);
/// `CLAUDE_T3_MCP_TOOL_TIMEOUT_MS`.
const MCP_TOOL_TIMEOUT_MS: u64 = 65 * 60 * 1000;
/// How long a closing query may take: the SDK's 2 s grace, SIGTERM, then SIGKILL after 5 s.
const CLOSE_TIMEOUT: Duration = Duration::from_secs(20);
/// The helper's session-file calls (T3's worker timeout).
const FUNCTION_TIMEOUT: Duration = Duration::from_secs(30);
const FLUSH_INTERVAL: Duration = Duration::from_millis(50);
pub const EVENT_CAPACITY: usize = 256;
const LOGGED_SKIPS_CAP: usize = 64;

pub struct ClaudeSession {
    id: ProviderSessionId,
    inner: Arc<Inner>,
}

impl std::fmt::Debug for ClaudeSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ClaudeSession")
            .field("id", &self.id)
            .finish_non_exhaustive()
    }
}

struct Inner {
    /// The provider instance (`providerInstanceId` on threads).
    instance_id: String,
    config: ClaudeConfig,
    helper: Helper,
    state: Mutex<State>,
}

struct State {
    mapper: Mapper<SystemEnv>,
    events: Option<mpsc::Sender<ProviderEvent>>,
    live: Option<Live>,
    generation: u64,
    /// Native ids that have a conversation on disk, so the next query uses `resume`.
    resumable: HashSet<String>,
    mcp_servers: Vec<McpServer>,
    /// Inline attachment bytes sent so far (`claudeAttachmentBudget`).
    attachment_bytes: u64,
    /// The running turn's prompt effort, for its steers.
    turn_prompt_effort: Option<String>,
    /// `resolveBypassAvailability`, cached per working directory (T3's `bypassCache`).
    bypass_cache: Option<(Option<String>, BypassAvailability)>,
    closed: bool,
    logged_skips: HashSet<String>,
}

struct Live {
    query: QueryHandle,
    generation: u64,
    /// Becomes true when the query's `end` arrived.
    ended: watch::Receiver<bool>,
    native_thread_id: String,
    cwd: Option<String>,
    policy: QueryPolicy,
    /// The permission mode now in force (a denied ExitPlanMode can leave `plan`).
    permission_mode: String,
    /// The mode the CLI reported in its first `init` (T3's `openedPermissionMode`).
    opened_permission_mode: String,
    received_init: bool,
    model: String,
    effort: Option<String>,
    selection_settings: Map<String, Value>,
    /// The MCP servers this query got; a different list needs `setMcpServers`.
    mcp_servers: Vec<McpServer>,
    /// `allowedTools` is a launch option: gaining or losing the T3 server needs a new query.
    t3_mcp: bool,
    restart_needed: bool,
    last_activity: Instant,
    /// Since when background work keeps this idle query alive.
    held_since: Option<Instant>,
}

impl ClaudeSession {
    pub(crate) fn open(
        id: ProviderSessionId,
        instance_id: &str,
        config: ClaudeConfig,
        helper: Helper,
        events: mpsc::Sender<ProviderEvent>,
    ) -> Self {
        let mapper = Mapper::new(SystemEnv, id.as_str());
        let inner = Arc::new(Inner {
            instance_id: instance_id.to_string(),
            config,
            helper,
            state: Mutex::new(State {
                mapper,
                events: Some(events),
                live: None,
                generation: 0,
                resumable: HashSet::new(),
                mcp_servers: Vec::new(),
                attachment_bytes: 0,
                turn_prompt_effort: None,
                bypass_cache: None,
                closed: false,
                logged_skips: HashSet::new(),
            }),
        });
        Self { id, inner }
    }

    #[cfg(test)]
    pub(crate) fn live_query(&self) -> Option<String> {
        self.inner
            .lock()
            .live
            .as_ref()
            .map(|l| l.query.id().to_string())
    }
}

impl Inner {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Sends events and callback answers in order. Holds no lock.
    async fn deliver(&self, query: Option<&QueryHandle>, outs: Vec<Out>) {
        if outs.is_empty() {
            return;
        }
        let events = self.lock().events.clone();
        for out in outs {
            match out {
                Out::Event(event) => {
                    if let Some(events) = &events {
                        let _ = events.send(event).await;
                    }
                }
                Out::Write(line) => {
                    if let (Some(query), Some((id, result))) = (query, callback_answer(&line)) {
                        query.answer(&id, result).await;
                    }
                }
                Out::Skipped(kind) => {
                    let mut state = self.lock();
                    // Kinds come from the CLI; remember a bounded number of them.
                    let new = state.logged_skips.len() < LOGGED_SKIPS_CAP
                        && state.logged_skips.insert(kind.clone());
                    drop(state);
                    if new {
                        eprintln!("conn-provider-claude: skipped SDK message kind `{kind}`");
                    }
                }
            }
        }
    }

    fn live_query(&self) -> ProviderResult<QueryHandle> {
        self.lock()
            .live
            .as_ref()
            .map(|l| l.query.clone())
            .ok_or(ProviderError::SessionStopped)
    }

    async fn call(&self, method: &str, args: Value, timeout: Duration) -> ProviderResult<Value> {
        self.live_query()?.call(method, args, timeout).await
    }

    /// `setMcpServers`, as the T3 query runner calls it after `initializationResult`.
    /// Credentials stay out of argv. Servers that fail to connect are logged by name only.
    async fn set_mcp_servers(&self, servers: &[McpServer]) -> ProviderResult<()> {
        let mut map = Map::new();
        for server in servers {
            let headers: Map<String, Value> = server
                .headers
                .iter()
                .map(|(k, v)| (k.clone(), json!(v)))
                .collect();
            map.insert(
                server.name.clone(),
                json!({"type": "http", "url": server.url, "headers": headers, "timeout": MCP_TOOL_TIMEOUT_MS}),
            );
        }
        let answer = self
            .call("setMcpServers", json!([map]), MCP_REGISTRATION_TIMEOUT)
            .await;
        let failed: Vec<String> = match &answer {
            Ok(value) => value["errors"]
                .as_object()
                .map(|e| e.keys().cloned().collect())
                .unwrap_or_default(),
            Err(ProviderError::Failed { detail, .. }) if detail.ends_with("no answer in time") => {
                return Err(failed_err(
                    "set_mcp_servers",
                    "Claude did not register the MCP servers in time.",
                ));
            }
            Err(ProviderError::SessionStopped) => return Err(ProviderError::SessionStopped),
            Err(_) => servers.iter().map(|s| s.name.clone()).collect(),
        };
        if !failed.is_empty() {
            eprintln!(
                "conn-provider-claude: MCP servers unavailable: {}",
                failed.join(", ")
            );
        }
        if let Some(live) = &mut self.lock().live {
            live.mcp_servers = servers.to_vec();
        }
        Ok(())
    }
}

/// A mapper reply (a CLI `control_response` line) as a callback answer.
fn callback_answer(line: &str) -> Option<(String, Result<Value, String>)> {
    let mut value: Value = serde_json::from_str(line).ok()?;
    let response = value.get_mut("response")?;
    let id = response.get("request_id")?.as_str()?.to_string();
    if response.get("subtype").and_then(Value::as_str) == Some("success") {
        Some((
            id,
            Ok(response
                .get_mut("response")
                .map(Value::take)
                .unwrap_or(Value::Null)),
        ))
    } else {
        let error = response
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("control request failed")
            .to_string();
        Some((id, Err(error)))
    }
}

/// An SDK callback as the CLI control request the mapper reads. The SDK passes the request's
/// fields renamed (`can_use_tool` → `canUseTool(toolName, input, {toolUseID, ...})`).
fn callback_request(kind: &str, args: &Value) -> Option<ControlRequest> {
    let text = |v: &Value, key: &str| v.get(key).and_then(Value::as_str).map(str::to_string);
    match kind {
        "canUseTool" => {
            let options = args.get("options").unwrap_or(&Value::Null);
            Some(ControlRequest::CanUseTool(CanUseTool {
                tool_name: text(args, "toolName").unwrap_or_default(),
                input: args.get("input").cloned().unwrap_or(Value::Null),
                tool_use_id: text(options, "toolUseID").unwrap_or_default(),
                permission_suggestions: options.get("suggestions").cloned(),
                decision_reason: text(options, "decisionReason"),
                title: text(options, "title"),
                display_name: text(options, "displayName"),
                description: text(options, "description"),
                blocked_path: text(options, "blockedPath"),
                agent_id: text(options, "agentID"),
            }))
        }
        "elicitation" => Some(ControlRequest::Elicitation(Elicitation {
            mcp_server_name: text(args, "serverName").unwrap_or_default(),
            message: text(args, "message").unwrap_or_default(),
            mode: text(args, "mode"),
            requested_schema: args.get("requestedSchema").cloned(),
            title: text(args, "title"),
            display_name: text(args, "displayName"),
        })),
        "userDialog" => Some(ControlRequest::UserDialog(UserDialog {
            dialog_kind: text(args, "dialogKind").unwrap_or_default(),
            payload: args.get("payload").cloned().unwrap_or(Value::Null),
            tool_use_id: text(args, "toolUseID"),
        })),
        _ => None,
    }
}

/// The driver: one per query, ends after the query's `End`.
async fn drive(
    inner: Arc<Inner>,
    generation: u64,
    query: QueryHandle,
    mut rx: mpsc::Receiver<QueryEvent>,
    ended: watch::Sender<bool>,
) {
    loop {
        let dirty = inner.lock().mapper.has_dirty_streams();
        let event = if dirty {
            tokio::select! {
                event = rx.recv() => event,
                _ = tokio::time::sleep(FLUSH_INTERVAL) => {
                    let outs = inner.lock().mapper.flush();
                    inner.deliver(Some(&query), outs).await;
                    continue;
                }
            }
        } else {
            rx.recv().await
        };
        let message = match event {
            Some(QueryEvent::Message(value)) => {
                if value["type"] == "system" && value["subtype"] == "init" {
                    note_init(&mut inner.lock(), generation, &value);
                }
                Inbound::from_value(value)
            }
            Some(QueryEvent::Request { id, kind, args }) => match callback_request(&kind, &args) {
                Some(request) => Inbound::ControlRequest {
                    request_id: id,
                    request,
                },
                None => {
                    query
                        .answer(&id, Err(format!("unsupported callback {kind}")))
                        .await;
                    continue;
                }
            },
            Some(QueryEvent::Cancel { id }) => Inbound::ControlCancel { request_id: id },
            Some(QueryEvent::End(end)) => {
                on_end(&inner, generation, &end).await;
                let _ = ended.send(true);
                return;
            }
            None => {
                on_end(
                    &inner,
                    generation,
                    &QueryEnd {
                        helper_error: Some("the Claude helper stopped".into()),
                        ..QueryEnd::default()
                    },
                )
                .await;
                let _ = ended.send(true);
                return;
            }
        };
        touch(&mut inner.lock(), Some(generation));
        let outs = inner.lock().mapper.handle(message);
        inner.deliver(Some(&query), outs).await;
    }
}

/// The first `init` of a query tells the mode the CLI opened in.
fn note_init(state: &mut State, generation: u64, init: &Value) {
    if let Some(live) = state
        .live
        .as_mut()
        .filter(|l| l.generation == generation && !l.received_init)
    {
        live.received_init = true;
        if let Some(mode) = init["permissionMode"].as_str() {
            live.opened_permission_mode = mode.to_string();
        }
    }
}

/// Marks the live query (of `generation`, if given) as active now.
fn touch(state: &mut State, generation: Option<u64>) {
    if let Some(live) = state
        .live
        .as_mut()
        .filter(|l| generation.is_none_or(|g| l.generation == g))
    {
        live.last_activity = Instant::now();
        live.held_since = None;
    }
}

/// Ends the query after `timeout` without a turn or output. Background work (a running
/// subagent, output held for a continuation) holds it up to `max_hold`, as T3's session
/// manager does with `hasPendingBackgroundWork`.
async fn idle_watch(inner: Arc<Inner>, generation: u64, timeout: Duration, max_hold: Duration) {
    loop {
        let wait = {
            let mut state = inner.lock();
            let busy = state.mapper.turn_active();
            let background = state.mapper.has_pending_background_work();
            let Some(live) = state.live.as_mut().filter(|l| l.generation == generation) else {
                return;
            };
            let idle_for = live.last_activity.elapsed();
            if busy {
                Some(timeout)
            } else if idle_for < timeout {
                Some(timeout - idle_for)
            } else if background
                && live.held_since.get_or_insert_with(Instant::now).elapsed() < max_hold
            {
                Some(timeout.min(max_hold))
            } else {
                None
            }
        };
        match wait {
            Some(duration) => tokio::time::sleep(duration).await,
            None => break,
        }
    }
    let live = {
        let mut state = inner.lock();
        match &state.live {
            Some(l) if l.generation == generation => state.live.take(),
            _ => return,
        }
    };
    if let Some(live) = live {
        end_query(&inner.helper, live).await;
    }
}

/// Closes a query and waits for its end, then stops the helper if nothing else uses it.
async fn end_query(helper: &Helper, live: Live) {
    let Live {
        query, mut ended, ..
    } = live;
    query.close().await;
    if tokio::time::timeout(CLOSE_TIMEOUT, ended.wait_for(|done| *done))
        .await
        .is_err()
    {
        eprintln!("conn-provider-claude: a Claude query did not end in time");
    }
    helper.stop_if_idle().await;
}

async fn on_end(inner: &Inner, generation: u64, end: &QueryEnd) {
    let outs = {
        let mut state = inner.lock();
        let current = state
            .live
            .as_ref()
            .is_some_and(|l| l.generation == generation);
        if !current {
            return;
        }
        let expected = state.closed;
        state.live = None;
        let detail = end_detail(end);
        state.mapper.on_exit(expected, &detail)
    };
    inner.deliver(None, outs).await;
    // The query ended by itself (crash, bad resume id): the helper may now be idle.
    inner.helper.stop_if_idle().await;
}

/// What the user sees for a query that ended mid-turn. stderr and the SDK's error message
/// can hold private text, so only known lines and the SDK's telemetry message are passed on,
/// as the TS adapter does (`claudeProcessExitFailure`).
fn end_detail(end: &QueryEnd) -> String {
    if let Some(helper) = &end.helper_error {
        return helper.clone();
    }
    let known = end
        .stderr
        .iter()
        .flat_map(|s| s.lines())
        .chain(
            end.error
                .iter()
                .filter_map(|e| e["message"].as_str())
                .flat_map(str::lines),
        )
        .find(|l| l.contains("No conversation found with session ID"));
    if let Some(line) = known {
        return format!("Claude exited: {}", line.trim());
    }
    if let Some(telemetry) = end
        .error
        .as_ref()
        .and_then(|e| e["telemetryMessage"].as_str())
    {
        return format!("{telemetry}.");
    }
    let exit = end
        .exit
        .as_ref()
        .map(|e| match (e["code"].as_i64(), e["signal"].as_str()) {
            (_, Some(signal)) => format!("signal {signal}"),
            (Some(code), None) => format!("exit code {code}"),
            _ => "unknown exit".into(),
        })
        .unwrap_or_else(|| "no exit status".into());
    format!("The Claude process exited unexpectedly ({exit}).")
}

/// `compileClaudeModelSelection`: API model id, effort, settings and the prompt effort.
fn model_selection(
    selection: &conn_contract::ModelSelection,
) -> (String, Option<String>, Map<String, Value>) {
    let compiled = catalog::compile(&to_json(selection));
    (compiled.api_model_id, compiled.effort, compiled.settings)
}

fn policy_input(policy: &RuntimePolicy) -> (String, String) {
    let runtime = to_json(&policy.runtime_mode);
    let interaction = to_json(&policy.interaction_mode);
    (
        runtime.as_str().unwrap_or("full-access").to_string(),
        interaction.as_str().unwrap_or("default").to_string(),
    )
}

/// The policy without settings (no bypass check): for live mode changes.
fn plain_policy(policy: &RuntimePolicy) -> QueryPolicy {
    let (runtime, interaction) = policy_input(policy);
    launch::query_policy(
        &PolicyInput {
            runtime_mode: &runtime,
            interaction_mode: &interaction,
            ..PolicyInput::default()
        },
        BypassAvailability::default(),
    )
}

fn native_thread_id(thread: &ProviderThread) -> Option<String> {
    to_json(thread)["nativeThreadRef"]["nativeId"]
        .as_str()
        .map(str::to_string)
}

/// The message to resume at after a rollback (`getNativeConversationHeadId`).
fn conversation_head(thread: &Value) -> Option<String> {
    thread["nativeConversationHeadRef"]["nativeId"]
        .as_str()
        .map(str::to_string)
}

/// A turn cursor the CLI can resume at: an assistant message uuid, not the `turn:` stand-in.
fn turn_cursor(turn: &Value) -> Option<String> {
    let id = turn["nativeTurnRef"]["nativeId"].as_str()?;
    (!id.starts_with("turn:")).then(|| id.to_string())
}

fn failed_err(operation: &'static str, detail: impl Into<String>) -> ProviderError {
    ProviderError::Failed {
        operation,
        detail: detail.into(),
    }
}

fn same_selection(
    live: &Live,
    model: &str,
    effort: &Option<String>,
    settings: &Map<String, Value>,
) -> bool {
    live.model == model && &live.effort == effort && &live.selection_settings == settings
}

/// What a turn must do before it offers the prompt.
enum Plan {
    Reuse {
        set_selection: bool,
        set_mode: Option<String>,
        set_mcp: bool,
    },
    Launch(Box<QueryInput>),
}

/// `claudeSdkBypassSettings`: keep the disable switches only when they say `disable`.
fn sdk_bypass_settings(mut settings: Value) -> Value {
    if let Some(map) = settings.as_object_mut() {
        if map.get("disableAutoMode") != Some(&json!("disable")) {
            map.remove("disableAutoMode");
        }
        if let Some(permissions) = map.get_mut("permissions").and_then(Value::as_object_mut) {
            for key in ["disableBypassPermissionsMode", "disableAutoMode"] {
                if permissions.get(key) != Some(&json!("disable")) {
                    permissions.remove(key);
                }
            }
        }
    }
    settings
}

/// `claudeBypassAvailability`.
fn availability(settings: &Value) -> BypassAvailability {
    let disable = json!("disable");
    BypassAvailability {
        bypass_disabled: settings["permissions"]["disableBypassPermissionsMode"] == disable,
        auto_disabled: settings["disableAutoMode"] == disable
            || settings["permissions"]["disableAutoMode"] == disable,
    }
}

/// Reads a settings file; a missing file is `{}`, an unreadable one an error (T3).
fn read_settings(path: &std::path::Path) -> Result<Value, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

impl ClaudeSession {
    /// The process environment the CLI gets, with the entrypoint from Claude's settings.
    async fn environment(&self, thread_id: &str, resume: bool) -> Map<String, Value> {
        let config = self.inner.config.clone();
        let thread_id = thread_id.to_string();
        let built = tokio::task::spawn_blocking(move || {
            let host: Vec<(String, String)> = std::env::vars().collect();
            let draft = launch::query_env(&config, &thread_id, resume, host.clone(), None);
            let entry = launch::settings_entrypoint(&launch::config_dir(&config, &draft));
            launch::query_env(&config, &thread_id, resume, host, entry)
        })
        .await;
        built.unwrap_or_default()
    }

    /// `resolveBypassAvailability` for this working directory: Claude's effective settings
    /// (through the SDK's `resolveSettings`), the custom home's settings and the remote ones.
    /// A failure counts as bypass disabled, as in T3.
    async fn bypass_availability(&self, cwd: Option<&str>) -> BypassAvailability {
        if let Some((cached_cwd, availability)) = &self.inner.lock().bypass_cache
            && cached_cwd.as_deref() == cwd
        {
            return *availability;
        }
        let config = &self.inner.config;
        let custom_home = config.home_path.is_some()
            || config
                .instance_env
                .iter()
                .any(|(k, _)| k == "CLAUDE_CONFIG_DIR");
        let env = self.environment("", false).await;
        let home = launch::config_dir(config, &env);
        let files = tokio::task::spawn_blocking(move || {
            let remote = read_settings(&home.join("remote-settings.json"))?;
            let own = if custom_home {
                read_settings(&home.join("settings.json"))?
            } else {
                json!({})
            };
            Ok::<_, String>((remote, own))
        })
        .await
        .map_err(|e| e.to_string())
        .and_then(|r| r);
        let result = match files {
            Ok((remote, own)) => {
                let mut options = json!({
                    "settingSources": if custom_home { json!(["project", "local"]) } else { json!(["user", "project", "local"]) },
                    "serverManagedSettings": sdk_bypass_settings(remote.clone()),
                });
                if let Some(cwd) = cwd {
                    options["cwd"] = json!(cwd);
                }
                self.inner
                    .helper
                    .function("resolveSettings", json!([options]), None, FUNCTION_TIMEOUT)
                    .await
                    .map(|resolved| {
                        let sources = [&resolved["effective"], &own, &remote].map(availability);
                        BypassAvailability {
                            bypass_disabled: sources.iter().any(|s| s.bypass_disabled),
                            auto_disabled: sources.iter().any(|s| s.auto_disabled),
                        }
                    })
                    .map_err(|e| e.to_string())
            }
            Err(e) => Err(e),
        };
        match result {
            Ok(availability) => {
                self.inner.lock().bypass_cache = Some((cwd.map(str::to_string), availability));
                availability
            }
            Err(detail) => {
                eprintln!(
                    "conn-provider-claude: could not read Claude's bypass settings: {detail}"
                );
                BypassAvailability {
                    bypass_disabled: true,
                    auto_disabled: false,
                }
            }
        }
    }

    /// `queryPolicyForTurn`.
    async fn turn_policy(&self, policy: &RuntimePolicy) -> QueryPolicy {
        let plain = plain_policy(policy);
        if plain.permission_mode != "bypassPermissions" {
            return plain;
        }
        let availability = self.bypass_availability(policy.cwd.as_deref()).await;
        let (runtime, interaction) = policy_input(policy);
        launch::query_policy(
            &PolicyInput {
                runtime_mode: &runtime,
                interaction_mode: &interaction,
                ..PolicyInput::default()
            },
            availability,
        )
    }

    /// Ensures a query for the turn's thread, with its model, effort, mode and MCP servers.
    /// Returns the policy in force.
    async fn prepare(&self, input: &TurnInput) -> ProviderResult<QueryPolicy> {
        let inner = &self.inner;
        let native = native_thread_id(&input.provider_thread)
            .ok_or_else(|| failed_err("start_turn", "provider thread has no native Claude id"))?;
        let (model, effort, selection_settings) = model_selection(&input.model_selection);
        let policy = self.turn_policy(&input.runtime_policy).await;
        let cwd = input.runtime_policy.cwd.clone();
        let thread = to_json(&input.provider_thread);
        let title = to_json(&input.app_thread)["title"]
            .as_str()
            .map(str::to_string);

        let (plan, old) = {
            let mut state = inner.lock();
            if state.closed {
                return Err(ProviderError::SessionStopped);
            }
            let t3_mcp = state.mcp_servers.iter().any(|s| s.name == T3_MCP_SERVER);
            let reusable = state.live.as_ref().is_some_and(|l| {
                l.query.is_open()
                    && !l.restart_needed
                    && l.native_thread_id == native
                    && l.cwd == cwd
                    && l.policy == policy
                    && l.t3_mcp == t3_mcp
                    && (same_selection(l, &model, &effort, &selection_settings)
                        // canApplyClaudeSelectionLive, and a model change only when the CLI
                        // opened in the policy's mode (T3's openedPermissionMode check).
                        || (l.selection_settings.get("alwaysThinkingEnabled")
                            == selection_settings.get("alwaysThinkingEnabled")
                            && (effort.is_some() || l.effort.is_none())
                            && (l.model == model
                                || l.opened_permission_mode == policy.permission_mode)))
            });
            if let Some(live) = state.live.as_ref().filter(|_| reusable) {
                let plan = Plan::Reuse {
                    set_selection: live.model != model
                        || live.effort != effort
                        || live.selection_settings != selection_settings,
                    // A denied ExitPlanMode leaves Claude in plan mode; restore only from plan.
                    set_mode: (live.permission_mode == "plan"
                        && live.policy.permission_mode != "plan")
                        .then(|| live.policy.permission_mode.clone()),
                    set_mcp: live.mcp_servers != state.mcp_servers,
                };
                (plan, None)
            } else {
                // A persisted turn requires resume, also after an idle release.
                let resume = state.resumable.contains(&native)
                    || input.provider_turn_ordinal > 1
                    || conversation_head(&thread).is_some();
                let read_only = false;
                let query = QueryInput {
                    thread_id: input.thread_id.as_str().into(),
                    native_thread_id: native.clone(),
                    resume,
                    model: model.clone(),
                    effort: effort.clone(),
                    selection_settings: selection_settings.clone(),
                    allowed_tools: launch::mcp_allowed_tools(&policy, t3_mcp, read_only),
                    policy: policy.clone(),
                    cwd: cwd.clone(),
                    resume_at: conversation_head(&thread),
                    title,
                    t3_mcp,
                    prompt_suggestions: false,
                };
                (Plan::Launch(Box::new(query)), state.live.take())
            }
        };
        if let Some(old) = old {
            end_query(&inner.helper, old).await;
        }

        match plan {
            Plan::Launch(query) => self.launch(*query).await?,
            Plan::Reuse {
                set_selection,
                set_mode,
                set_mcp,
            } => {
                if set_selection {
                    self.apply_live_selection(&model, effort.as_deref(), &selection_settings)
                        .await?;
                }
                if let Some(mode) = set_mode {
                    let restored = match inner
                        .call("setPermissionMode", json!([mode]), CONTROL_TIMEOUT)
                        .await
                    {
                        Ok(_) => mode,
                        Err(_) if mode == "bypassPermissions" => {
                            inner
                                .call("setPermissionMode", json!(["default"]), CONTROL_TIMEOUT)
                                .await?;
                            "default".to_string()
                        }
                        Err(e) => return Err(e),
                    };
                    if let Some(live) = &mut inner.lock().live {
                        live.permission_mode = restored;
                    }
                }
                if set_mcp {
                    let servers = inner.lock().mcp_servers.clone();
                    inner.set_mcp_servers(&servers).await?;
                }
            }
        }
        let mut state = inner.lock();
        state.resumable.insert(native);
        touch(&mut state, None);
        state.mapper.set_policy_asks(launch::asks_user(&policy));
        Ok(policy)
    }

    /// `applySelectionLive`: `setModel` when the model changed, then `applyFlagSettings`.
    async fn apply_live_selection(
        &self,
        model: &str,
        effort: Option<&str>,
        settings: &Map<String, Value>,
    ) -> ProviderResult<()> {
        let model_changed = self
            .inner
            .lock()
            .live
            .as_ref()
            .is_some_and(|l| l.model != model);
        if model_changed {
            self.inner
                .call("setModel", json!([model]), CONTROL_TIMEOUT)
                .await?;
        }
        let mut flags = Map::new();
        if let Some(effort) = effort {
            flags.insert("effortLevel".into(), json!(effort));
        }
        flags.insert(
            "fastMode".into(),
            settings.get("fastMode").cloned().unwrap_or(Value::Null),
        );
        flags.insert(
            "ultracode".into(),
            settings.get("ultracode").cloned().unwrap_or(Value::Null),
        );
        self.inner
            .call("applyFlagSettings", json!([flags]), CONTROL_TIMEOUT)
            .await?;
        if let Some(live) = &mut self.inner.lock().live {
            live.model = model.to_string();
            live.effort = effort.map(str::to_string);
            live.selection_settings = settings.clone();
        }
        Ok(())
    }

    /// Applies a selection to the live query, or marks it for a new one when the change
    /// cannot apply live (thinking toggled, effort cleared).
    async fn apply_selection(
        &self,
        selection: &conn_contract::ModelSelection,
    ) -> ProviderResult<()> {
        let (model, effort, settings) = model_selection(selection);
        let live_change = {
            let mut state = self.inner.lock();
            match &mut state.live {
                Some(live) => {
                    let can_apply = live.selection_settings.get("alwaysThinkingEnabled")
                        == settings.get("alwaysThinkingEnabled")
                        && (effort.is_some() || live.effort.is_none());
                    live.restart_needed |= !can_apply;
                    can_apply
                        && (live.model != model
                            || live.effort != effort
                            || live.selection_settings != settings)
                }
                None => false,
            }
        };
        if live_change {
            self.apply_live_selection(&model, effort.as_deref(), &settings)
                .await?;
        }
        Ok(())
    }

    async fn start_turn_inner(&self, input: TurnInput) -> ProviderResult<()> {
        if self.inner.lock().mapper.turn_active() {
            return Err(failed_err(
                "start_turn",
                "the previous turn is still running",
            ));
        }
        let policy = self.prepare(&input).await?;
        let effort = catalog::compile(&to_json(&input.model_selection)).prompt_effort;
        self.inner.lock().turn_prompt_effort = effort.clone();
        let text = catalog::prompt_text(&input.message.text, effort.as_deref());
        let content = self.content(&text, &input.message.attachments).await;
        let inner = &self.inner;
        let (outs, query, uuid) = {
            let mut state = inner.lock();
            let query = state
                .live
                .as_ref()
                .map(|l| l.query.clone())
                .ok_or(ProviderError::SessionStopped)?;
            let mode = state
                .live
                .as_ref()
                .map_or(policy.permission_mode.clone(), |l| {
                    l.permission_mode.clone()
                });
            let outs = state.mapper.begin_turn(&input, &mode);
            (outs, query, SystemEnv.uuid())
        };
        inner.deliver(Some(&query), outs).await;
        let offered = query
            .input(
                user_message_value(content, &uuid, Delivery::Turn),
                CONTROL_TIMEOUT,
            )
            .await;
        if offered.is_err() {
            let outs = inner
                .lock()
                .mapper
                .on_exit(false, "The Claude process stopped before the turn started.");
            inner.deliver(None, outs).await;
            return Err(ProviderError::SessionStopped);
        }
        Ok(())
    }

    /// The prompt content with attachments. Files are read off the runtime thread.
    async fn content(&self, text: &str, list: &[conn_contract::ChatAttachment]) -> Value {
        if list.is_empty() {
            return json!(text);
        }
        let dir = self.inner.config.attachments_dir.clone();
        let used = self.inner.lock().attachment_bytes;
        let (owned_text, owned_list) = (text.to_string(), list.to_vec());
        let built = tokio::task::spawn_blocking(move || {
            let mut used = used;
            let content =
                attachments::prompt_content(&owned_text, &owned_list, dir.as_deref(), &mut used);
            (content, used)
        })
        .await;
        match built {
            Ok((content, used)) => {
                self.inner.lock().attachment_bytes = used;
                content
            }
            Err(_) => json!(text),
        }
    }

    async fn launch(&self, input: QueryInput) -> ProviderResult<()> {
        let inner = &self.inner;
        let env = self.environment(&input.thread_id, input.resume).await;
        let options = launch::query_options(&inner.config, &input, env);
        let mut query = inner.helper.open(options, json!({}))?;
        let Some(rx) = query.take_events() else {
            return Err(failed_err("start_turn", "the query has no event stream"));
        };
        let handle = query.handle();
        let (ended_tx, ended) = watch::channel(false);
        let generation = {
            let mut state = inner.lock();
            state.generation += 1;
            let generation = state.generation;
            state.live = Some(Live {
                query: handle.clone(),
                generation,
                ended,
                native_thread_id: input.native_thread_id.clone(),
                cwd: input.cwd.clone(),
                permission_mode: input.policy.permission_mode.clone(),
                opened_permission_mode: input.policy.permission_mode.clone(),
                received_init: false,
                policy: input.policy.clone(),
                model: input.model.clone(),
                effort: input.effort.clone(),
                selection_settings: input.selection_settings.clone(),
                mcp_servers: Vec::new(),
                t3_mcp: input.t3_mcp,
                restart_needed: false,
                last_activity: Instant::now(),
                held_since: None,
            });
            generation
        };
        tokio::spawn(drive(
            inner.clone(),
            generation,
            handle.clone(),
            rx,
            ended_tx,
        ));
        if let Some(timeout) = inner.config.idle_timeout {
            tokio::spawn(idle_watch(
                inner.clone(),
                generation,
                timeout,
                inner.config.idle_max_hold,
            ));
        }
        // As T3: only a query with MCP servers waits for boot, then registers them.
        let servers = inner.lock().mcp_servers.clone();
        if servers.is_empty() {
            return Ok(());
        }
        let mut result = handle
            .call("initializationResult", json!([]), BOOT_TIMEOUT)
            .await
            .map(|_| ());
        if matches!(&result, Err(ProviderError::Failed { .. })) {
            // T3 ignores a failed initialization here; the message stream reports it.
            result = Ok(());
        }
        if result.is_ok() {
            result = inner.set_mcp_servers(&servers).await;
        }
        if let Err(error) = result {
            let live = inner.lock().live.take();
            if let Some(live) = live {
                end_query(&inner.helper, live).await;
            }
            return Err(match error {
                ProviderError::SessionStopped => failed_err(
                    "start_turn",
                    "Claude ended before it registered the MCP servers (an unknown resume id, a bad option, or no credentials)",
                ),
                other => other,
            });
        }
        Ok(())
    }

    /// Ends the live query if it serves `native`; the next turn starts a new one.
    async fn release(&self, native: &str) {
        let live = {
            let mut state = self.inner.lock();
            if state
                .live
                .as_ref()
                .is_some_and(|l| l.native_thread_id == native)
            {
                state.live.take()
            } else {
                None
            }
        };
        if let Some(live) = live {
            end_query(&self.inner.helper, live).await;
        }
    }

    fn require_idle(&self, operation: &'static str) -> ProviderResult<()> {
        if self.inner.lock().mapper.turn_active() {
            return Err(ProviderError::Protocol {
                detail: format!("Claude cannot {operation} while a turn is running."),
            });
        }
        Ok(())
    }

    /// The `CLAUDE_CONFIG_DIR` the SDK's session-file functions must read, when it is not the
    /// helper's own (T3 runs those in a worker then).
    fn function_config_dir(&self) -> Option<String> {
        let config = &self.inner.config;
        if let Some(home) = &config.home_path {
            return Some(home.to_string_lossy().into_owned());
        }
        config
            .instance_env
            .iter()
            .find(|(k, _)| k == "CLAUDE_CONFIG_DIR")
            .map(|(_, v)| launch::expand_home(v).to_string_lossy().into_owned())
    }
}

fn new_thread(
    instance_id: &str,
    session: &str,
    app_thread_id: Value,
    native: &str,
    owner: Value,
    forked_from: Value,
    head: Value,
) -> Value {
    let now = SystemEnv.now();
    json!({
        "id": ids::provider_thread_id(DRIVER, native),
        "driver": DRIVER,
        "providerInstanceId": instance_id,
        "providerSessionId": session,
        "appThreadId": app_thread_id,
        "ownerNodeId": owner,
        "nativeThreadRef": {"driver": DRIVER, "nativeId": native, "strength": "strong"},
        "nativeConversationHeadRef": head,
        "status": "idle",
        "firstRunOrdinal": null,
        "lastRunOrdinal": null,
        "handoffIds": [],
        "forkedFrom": forked_from,
        "createdAt": now,
        "updatedAt": now,
    })
}

impl Session for ClaudeSession {
    fn provider_session_id(&self) -> &ProviderSessionId {
        &self.id
    }

    fn ensure_thread(
        &self,
        input: EnsureThreadInput,
    ) -> BoxFuture<'_, ProviderResult<ProviderThread>> {
        Box::pin(async move {
            if let Some(existing) = input.existing_provider_thread
                && native_thread_id(&existing).is_some()
            {
                let mut thread = to_json(&existing);
                thread["providerSessionId"] = json!(self.id.as_str());
                return from_json(thread).map_err(|e| failed_err("ensure_thread", e.to_string()));
            }
            let native = SystemEnv.uuid();
            let thread = new_thread(
                &self.inner.instance_id,
                self.id.as_str(),
                json!(input.thread_id.as_str()),
                &native,
                Value::Null,
                Value::Null,
                Value::Null,
            );
            from_json(thread).map_err(|e| failed_err("ensure_thread", e.to_string()))
        })
    }

    fn resume_thread(
        &self,
        input: ResumeThreadInput,
    ) -> BoxFuture<'_, ProviderResult<ProviderThread>> {
        Box::pin(async move {
            let native = native_thread_id(&input.provider_thread).ok_or_else(|| {
                failed_err("resume_thread", "provider thread has no native Claude id")
            })?;
            let mut thread = to_json(&input.provider_thread);
            // A fork's transcript exists from the moment `forkSession` made it.
            self.inner.lock().resumable.insert(native);
            thread["providerSessionId"] = json!(self.id.as_str());
            thread["status"] = json!("idle");
            thread["updatedAt"] = json!(SystemEnv.now());
            from_json(thread).map_err(|e| failed_err("resume_thread", e.to_string()))
        })
    }

    fn start_turn(&self, input: TurnInput) -> BoxFuture<'_, ProviderResult<()>> {
        Box::pin(self.start_turn_inner(input))
    }

    fn start_continuation_turn(&self, input: TurnInput) -> BoxFuture<'_, ProviderResult<()>> {
        Box::pin(async move {
            let (outs, query) = {
                let mut state = self.inner.lock();
                if state.mapper.turn_active() {
                    return Err(failed_err("start_continuation_turn", "a turn is running"));
                }
                let Some(live) = &state.live else {
                    return Err(ProviderError::SessionStopped);
                };
                let query = live.query.clone();
                let mode = live.permission_mode.clone();
                (state.mapper.begin_continuation(&input, &mode), query)
            };
            self.inner.deliver(Some(&query), outs).await;
            Ok(())
        })
    }

    fn steer_turn(&self, input: SteerInput) -> BoxFuture<'_, ProviderResult<()>> {
        Box::pin(async move {
            if let Some(selection) = &input.model_selection {
                self.apply_selection(selection).await?;
            }
            // The steer's own selection, else the running turn's (T3's liveSteerSelection).
            let effort = match &input.model_selection {
                Some(selection) => catalog::compile(&to_json(selection)).prompt_effort,
                None => self.inner.lock().turn_prompt_effort.clone(),
            };
            let text = catalog::prompt_text(&input.message.text, effort.as_deref());
            let content = self.content(&text, &input.message.attachments).await;
            let uuid = SystemEnv.uuid();
            let (query, outs) = {
                let mut state = self.inner.lock();
                let query = state
                    .live
                    .as_ref()
                    .map(|l| l.query.clone())
                    .ok_or(ProviderError::SessionStopped)?;
                if state.mapper.active_turn_id() != Some(input.provider_turn_id.as_str()) {
                    return Err(failed_err("steer_turn", "that turn is not running"));
                }
                touch(&mut state, None);
                let outs = state
                    .mapper
                    .steer_sent(&uuid, input.message.message_id.as_str());
                (query, outs)
            };
            self.inner.deliver(Some(&query), outs).await;
            let offered = query
                .input(
                    user_message_value(content, &uuid, Delivery::Steer),
                    CONTROL_TIMEOUT,
                )
                .await;
            if offered.is_err() {
                let outs = self.inner.lock().mapper.steer_failed(&uuid);
                self.inner.deliver(None, outs).await;
                return Err(ProviderError::SessionStopped);
            }
            Ok(())
        })
    }

    fn interrupt_turn(&self, input: InterruptInput) -> BoxFuture<'_, ProviderResult<()>> {
        Box::pin(async move {
            {
                let mut state = self.inner.lock();
                if state.live.is_none()
                    || state.mapper.active_turn_id() != Some(input.provider_turn_id.as_str())
                {
                    return Ok(());
                }
                state.mapper.mark_interrupted();
            }
            self.inner
                .call("interrupt", json!([]), CONTROL_TIMEOUT)
                .await
                .map(|_| ())
        })
    }

    fn apply_model_selection(
        &self,
        _thread: ProviderThread,
        selection: conn_contract::ModelSelection,
    ) -> BoxFuture<'_, ProviderResult<()>> {
        Box::pin(async move { self.apply_selection(&selection).await })
    }

    fn apply_runtime_policy(
        &self,
        _thread: ProviderThread,
        policy: RuntimePolicy,
    ) -> BoxFuture<'_, ProviderResult<()>> {
        Box::pin(async move {
            let next = plain_policy(&policy);
            {
                let mut state = self.inner.lock();
                let Some(live) = &mut state.live else {
                    return Ok(());
                };
                if live.policy == next {
                    return Ok(());
                }
                // The policy key is part of the query: like T3, a change opens a new query on
                // the next turn. A plain mode change between asking modes applies live.
                let live_change = next.permission_mode != "bypassPermissions"
                    && live.policy.permission_mode != "bypassPermissions"
                    && next.tools == live.policy.tools
                    && next.allowed_tools == live.policy.allowed_tools;
                if !live_change {
                    live.restart_needed = true;
                    return Err(ProviderError::Unsupported {
                        operation: "apply_runtime_policy",
                    });
                }
            }
            let mode = next.permission_mode.clone();
            self.inner
                .call("setPermissionMode", json!([mode]), CONTROL_TIMEOUT)
                .await?;
            let mut state = self.inner.lock();
            if let Some(live) = &mut state.live {
                live.permission_mode = mode.clone();
                live.policy = next.clone();
            }
            state.mapper.set_permission_mode(&mode);
            state.mapper.set_policy_asks(launch::asks_user(&next));
            Ok(())
        })
    }

    fn respond_to_runtime_request(
        &self,
        input: RuntimeRequestResponse,
    ) -> BoxFuture<'_, ProviderResult<()>> {
        Box::pin(async move {
            let (outs, query) = {
                let mut state = self.inner.lock();
                let query = state.live.as_ref().map(|l| l.query.clone());
                let Some(query) = query else {
                    return Err(ProviderError::SessionStopped);
                };
                (state.mapper.respond(&input)?, query)
            };
            self.inner.deliver(Some(&query), outs).await;
            Ok(())
        })
    }

    fn set_mcp_servers(&self, servers: Vec<McpServer>) -> BoxFuture<'_, ProviderResult<()>> {
        Box::pin(async move {
            let live_update = {
                let mut state = self.inner.lock();
                state.mcp_servers = servers.clone();
                let t3 = servers.iter().any(|s| s.name == T3_MCP_SERVER);
                match &mut state.live {
                    // The T3 allow rule is a launch option; a change waits for a new query.
                    Some(live) if live.t3_mcp != t3 => {
                        live.restart_needed = true;
                        false
                    }
                    Some(live) => live.mcp_servers != servers,
                    None => false,
                }
            };
            if live_update {
                self.inner.set_mcp_servers(&servers).await?;
            }
            Ok(())
        })
    }

    fn rollback_thread(
        &self,
        input: RollbackThreadInput,
    ) -> BoxFuture<'_, ProviderResult<ThreadSnapshot>> {
        Box::pin(async move {
            self.require_idle("roll back")?;
            let thread = to_json(&input.provider_thread);
            let native = native_thread_id(&input.provider_thread).ok_or_else(|| {
                failed_err("rollback_thread", "provider thread has no native Claude id")
            })?;
            self.release(&native).await;
            let rolled = match input.target {
                RollbackTarget::ThreadStart { .. } => {
                    // A new native session; the old transcript stays on disk.
                    let mut fresh = new_thread(
                        &self.inner.instance_id,
                        self.id.as_str(),
                        thread["appThreadId"].clone(),
                        &SystemEnv.uuid(),
                        thread["ownerNodeId"].clone(),
                        thread["forkedFrom"].clone(),
                        Value::Null,
                    );
                    fresh["handoffIds"] = thread["handoffIds"].clone();
                    fresh
                }
                RollbackTarget::ProviderTurn {
                    app_run_ordinal,
                    provider_turn,
                    ..
                } => {
                    let target = to_json(&provider_turn);
                    let later_turns = input.provider_thread_turns.iter().any(|t| {
                        let t = to_json(t);
                        t["ordinal"].as_i64() > target["ordinal"].as_i64()
                            && t["providerThreadId"] == thread["id"]
                    });
                    let head = match turn_cursor(&target) {
                        Some(cursor) => {
                            json!({"driver": DRIVER, "nativeId": cursor, "strength": "weak"})
                        }
                        None if !later_turns => Value::Null,
                        None => {
                            return Err(failed_err(
                                "rollback_thread",
                                "no Claude message cursor was recorded for that turn",
                            ));
                        }
                    };
                    let mut rolled = thread.clone();
                    rolled["providerSessionId"] = json!(self.id.as_str());
                    rolled["nativeConversationHeadRef"] = head;
                    rolled["status"] = json!("idle");
                    rolled["lastRunOrdinal"] = json!(app_run_ordinal);
                    rolled["updatedAt"] = json!(SystemEnv.now());
                    self.inner.lock().resumable.insert(native);
                    rolled
                }
            };
            Ok(ThreadSnapshot {
                provider_thread: from_json(rolled)
                    .map_err(|e| failed_err("rollback_thread", e.to_string()))?,
                provider_turns: Vec::new(),
                messages: Vec::new(),
                runtime_requests: Vec::new(),
            })
        })
    }

    /// The SDK's `forkSession` copies the source transcript (up to the fork turn) into a new
    /// session, as T3 does; the new thread resumes that session on its first turn.
    fn fork_thread(&self, input: ForkThreadInput) -> BoxFuture<'_, ProviderResult<ProviderThread>> {
        Box::pin(async move {
            self.require_idle("fork")?;
            let source = to_json(&input.source_provider_thread);
            let source_native =
                native_thread_id(&input.source_provider_thread).ok_or_else(|| {
                    failed_err("fork_thread", "provider thread has no native Claude id")
                })?;
            self.release(&source_native).await;
            let up_to = match &input.provider_turn_id {
                None => conversation_head(&source),
                Some(turn_id) => {
                    let mut turns: Vec<Value> = input
                        .source_provider_turns
                        .iter()
                        .map(to_json)
                        .filter(|t| t["providerThreadId"] == source["id"])
                        .collect();
                    turns.sort_by_key(|t| t["ordinal"].as_i64());
                    let index = turns
                        .iter()
                        .position(|t| t["id"] == json!(turn_id.as_str()))
                        .ok_or_else(|| {
                            failed_err("fork_thread", "the fork turn is not on that thread")
                        })?;
                    match turns.get(index).and_then(turn_cursor) {
                        Some(cursor) => Some(cursor),
                        None if index + 1 == turns.len() => conversation_head(&source),
                        None => {
                            return Err(failed_err(
                                "fork_thread",
                                "no Claude message cursor was recorded for that turn",
                            ));
                        }
                    }
                }
            };
            let options = match &up_to {
                Some(id) => json!({"upToMessageId": id}),
                None => json!({}),
            };
            let config_dir = self.function_config_dir();
            let forked = self
                .inner
                .helper
                .function(
                    "forkSession",
                    json!([source_native, options]),
                    config_dir.as_deref(),
                    FUNCTION_TIMEOUT,
                )
                .await?;
            let native = forked["sessionId"]
                .as_str()
                .ok_or_else(|| failed_err("fork_thread", "forkSession returned no session id"))?
                .to_string();
            self.inner.lock().resumable.insert(native.clone());
            let mut forked_from = json!({"providerThreadId": source["id"]});
            if let Some(turn_id) = &input.provider_turn_id {
                forked_from["providerTurnId"] = json!(turn_id.as_str());
            }
            let thread = new_thread(
                &self.inner.instance_id,
                self.id.as_str(),
                json!(input.target_thread_id.as_str()),
                &native,
                input
                    .owner_node_id
                    .as_ref()
                    .map_or(Value::Null, |n| json!(n.as_str())),
                forked_from,
                Value::Null,
            );
            from_json(thread).map_err(|e| failed_err("fork_thread", e.to_string()))
        })
    }

    fn has_pending_background_work(&self) -> bool {
        self.inner.lock().mapper.has_pending_background_work()
    }

    fn close(&self) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            let live = {
                let mut state = self.inner.lock();
                state.closed = true;
                state.live.take()
            };
            if let Some(live) = live {
                end_query(&self.inner.helper, live).await;
            }
            // A turn still open ends as interrupted; then the event channel closes.
            let outs = self
                .inner
                .lock()
                .mapper
                .on_exit(true, "The session closed.");
            self.inner.deliver(None, outs).await;
            self.inner.lock().events = None;
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn callbacks_become_the_control_requests_the_mapper_reads() {
        let args = json!({
            "toolName": "Bash",
            "input": {"command": "ls"},
            "options": {"toolUseID": "toolu_1", "blockedPath": "/x", "suggestions": [{"type": "addRules"}], "requestId": "r1"},
        });
        let Some(ControlRequest::CanUseTool(request)) = callback_request("canUseTool", &args)
        else {
            panic!("not a can_use_tool request");
        };
        assert_eq!(request.tool_name, "Bash");
        assert_eq!(request.tool_use_id, "toolu_1");
        assert_eq!(request.blocked_path.as_deref(), Some("/x"));
        assert!(request.permission_suggestions.is_some());
        assert!(callback_request("hook", &args).is_none());
    }

    #[test]
    fn mapper_replies_become_callback_answers() {
        let ok = crate::protocol::control_success("r1", json!({"behavior": "allow"}));
        assert_eq!(
            callback_answer(&ok),
            Some(("r1".into(), Ok(json!({"behavior": "allow"}))))
        );
        let err = crate::protocol::control_error("r2", "no");
        assert_eq!(callback_answer(&err), Some(("r2".into(), Err("no".into()))));
    }

    #[test]
    fn bypass_settings_read_like_t3() {
        let remote = json!({"permissions": {"disableBypassPermissionsMode": "disable", "allow": []}, "disableAutoMode": false});
        let sdk = sdk_bypass_settings(remote.clone());
        assert_eq!(
            sdk,
            json!({"permissions": {"disableBypassPermissionsMode": "disable", "allow": []}})
        );
        assert_eq!(
            availability(&remote),
            BypassAvailability {
                bypass_disabled: true,
                auto_disabled: false
            }
        );
    }

    #[test]
    fn end_details_keep_private_text_out() {
        let end = QueryEnd {
            error: Some(
                json!({"message": "exit 1: secret stderr", "telemetryMessage": "Claude Code process exited with code 1"}),
            ),
            ..QueryEnd::default()
        };
        assert_eq!(end_detail(&end), "Claude Code process exited with code 1.");
        let missing = QueryEnd {
            stderr: Some("No conversation found with session ID: abc\n".into()),
            ..QueryEnd::default()
        };
        assert!(end_detail(&missing).contains("No conversation found"));
    }
}
