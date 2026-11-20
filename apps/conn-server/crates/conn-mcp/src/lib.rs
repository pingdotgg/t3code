//! `/mcp`: the T3 tool server that agents inside a thread, and outside callers such as Orbit's
//! Swamp, call over MCP's Streamable HTTP transport. `README.md` maps the TypeScript boundary
//! this reproduces.
//!
//! - [`McpService::handle`] serves one HTTP request for an authenticated [`Caller`].
//! - [`McpService::issue_thread_credential`] gives a provider the `t3-code` server entry for
//!   one thread: URL, `Authorization` header, and the shapes Claude and Codex take.
//! - [`McpService::resolve_thread_token`] turns a bearer token back into its thread.
//!
//! The tool definitions come from `apps/server` (`tools/gen-tools.mjs` → `src/catalog.jsonl`);
//! the handlers are ours, on the [`Engine`] trait.

use std::{
    net::SocketAddr,
    sync::{Arc, Mutex, OnceLock},
};

use conn_engine::Engine;
use serde_json::Value;

mod catalog;
mod credentials;
mod exposure;
mod input;
mod http_limits {
    include!("http-limits.rs");
}
pub use http_limits::MAX_MCP_BODY_BYTES;
mod links;
mod peers;
mod sessions;
pub mod snapshot;
mod time;
mod tools;
mod transport;
mod view;
mod worktrees;

pub use credentials::ThreadCredentialRequest;
pub use peers::{
    LINKS_OFF_HERE, LinkAsk, LinkInfo, PeerCall, PeerFailure, PeerLimits, PeerSender, Peers,
};
pub use transport::Reply;
pub use worktrees::WorktreeConfig;

/// What the service needs from the server around it.
pub struct McpConfig {
    pub preview: Option<conn_preview::tabs::Preview>,
    pub engine: Arc<dyn Engine>,
    /// The same attachment store used by client RPC and HTTP uploads.
    pub files: Option<Arc<conn_files::Files>>,
    /// Worktree defaults, git status and setup terminals.
    pub worktrees: Option<WorktreeConfig>,
    pub environment_id: String,
    pub label: String,
    pub server_version: String,
    /// `ExecutionEnvironmentDescriptor.platform`: `{os, arch}`.
    pub platform: Value,
    /// `ServerProvider` entries (`ServerConfig.providers`), read on each capabilities call.
    pub providers: Arc<dyn Fn() -> Vec<Value> + Send + Sync>,
    /// Recheck an instance when its model or availability snapshot refuses a batch target.
    pub refresh_provider: Option<ProviderRefresh>,
    /// Outside callers get thread links through this app, as Copy thread's do.
    pub hosted_app_url: String,
    /// Scheduled tasks; without it the scheduled task tools answer that they are not served.
    pub scheduled_tasks: Option<conn_features::scheduled::ScheduledTasks>,
    /// Annotations; without it the annotation tools answer that they are not served.
    pub annotations: Option<conn_features::annotations::Annotations>,
    /// The store also used by secrets.answerRequest.
    pub secrets: Option<conn_features::secrets::SecretRequests>,
    pub test_logins: Option<conn_features::test_logins::TestLogins>,
    /// The broker also used by panels.requests and panels.respond.
    pub panels: Option<conn_features::panels::PanelBroker>,
    /// Linked environments; without it every tool stays in this environment.
    pub peers: Option<Arc<dyn Peers>>,
    /// The server settings, for the environment preference tools.
    pub settings: Option<SettingsPort>,
    /// Device hosts; without them the device tools answer that device access is off.
    pub devices: Option<conn_devices::Devices>,
    /// The server's GitHub pull request panel; without it the watch and guide tools answer
    /// as T3 does when no host can be read.
    pub pull_requests: Option<PullRequestHost>,
}

/// Reads and patches the server settings (`ServerSettingsService`).
#[derive(Clone)]
pub struct SettingsPort {
    pub read: Arc<dyn Fn() -> SettingsMap + Send + Sync>,
    /// Applies a `ServerSettingsPatch`; returns the settings after it.
    pub update: SettingsUpdate,
}

pub type SettingsMap = serde_json::Map<String, Value>;
pub type SettingsUpdate = Arc<
    dyn Fn(Value) -> conn_engine::BoxFuture<'static, Result<SettingsMap, String>> + Send + Sync,
>;

impl std::fmt::Debug for SettingsPort {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SettingsPort").finish_non_exhaustive()
    }
}

/// One call into the server's pull request panel: `(operation, input)` to the result, or the
/// contract failure (`PullRequestUnavailableError`, `PullRequestOperationError`, ...). The
/// operations are `watchSummary`, `locateProject` and `reviewGuide`.
pub type PullRequestHost = Arc<
    dyn Fn(&'static str, Value) -> conn_engine::BoxFuture<'static, Result<Value, Value>>
        + Send
        + Sync,
>;

pub type ProviderRefresh = Arc<dyn Fn(String) -> conn_engine::BoxFuture<'static, ()> + Send + Sync>;

impl std::fmt::Debug for McpConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("McpConfig")
            .field("environment_id", &self.environment_id)
            .field("label", &self.label)
            .field("server_version", &self.server_version)
            .field("platform", &self.platform)
            .field("hosted_app_url", &self.hosted_app_url)
            .finish_non_exhaustive()
    }
}

pub const DEFAULT_HOSTED_APP_URL: &str = "https://app.t3.codes";

/// Who calls. The route authenticates; the service only reads this.
#[derive(Clone, Debug, PartialEq)]
pub enum Caller {
    /// An agent T3 started, with the token [`McpService::issue_thread_credential`] issued.
    Thread(ThreadCaller),
    /// A bearer session from outside a thread: a paired device, `t3 auth session issue`.
    Client(ClientCaller),
}

#[derive(Clone, Debug, PartialEq)]
pub struct ThreadCaller {
    pub thread_id: String,
    pub provider_session_id: String,
    pub provider_instance_id: String,
    /// Captured when the provider session starts, not re-read on each call.
    pub preview: bool,
    /// The `device` capability, captured the same way.
    pub device: bool,
    /// A delegated child: it hands its work back to its parent.
    pub subagent: bool,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ClientCaller {
    pub session_id: String,
    /// `None`: read-only. Otherwise the broadest runtime mode it may start threads in.
    pub max_runtime_mode: Option<&'static str>,
    /// The client's name, as it registered or paired.
    pub label: String,
    /// Another environment's peer link: what it starts here carries its session as
    /// `linkOrigin`, and below full access it changes only that work.
    pub linked: bool,
    /// Narrower modes the client asked for on this request (`T3-Mode-Limit`): runtime,
    /// interaction.
    pub narrowed: Option<(&'static str, &'static str)>,
    /// A native bearer session's scopes (`None` for an MCP OAuth client, whose access level
    /// decides). Tools that change settings or links check them, as the RPC methods do.
    pub scopes: Option<Vec<String>>,
}

impl ClientCaller {
    /// `AuthMcpClientAccess`.
    pub fn access(&self) -> &'static str {
        self.max_runtime_mode.unwrap_or("read-only")
    }
}

impl Caller {
    /// Keys idempotent writes and MCP sessions to the credential, as TS `requestNamespace` does.
    fn namespace(&self) -> String {
        match self {
            Caller::Thread(thread) => thread.provider_session_id.clone(),
            Caller::Client(client) => format!("client:{}", client.session_id),
        }
    }
}

/// The `t3-code` MCP server entry a provider passes to its CLI for one thread.
#[derive(Clone, PartialEq)]
pub struct McpServerEntry {
    pub thread_id: String,
    pub provider_session_id: String,
    pub url: String,
    /// The full header value: `Bearer <token>`.
    pub authorization: String,
}

impl std::fmt::Debug for McpServerEntry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("McpServerEntry")
            .field("thread_id", &self.thread_id)
            .field("provider_session_id", &self.provider_session_id)
            .field("url", &self.url)
            .field("authorization", &"<redacted>")
            .finish()
    }
}

/// T3 waits can block for an hour; providers' own MCP timeouts must stay above that.
pub const TOOL_TIMEOUT_SECS: u64 = 65 * 60;
pub const SERVER_NAME: &str = "t3-code";

/// What T3 appends to an agent's system prompt when it has the `t3-code` server
/// (`T3_CODE_ORCHESTRATION_INSTRUCTIONS`), generated by `tools/gen-tools.mjs`.
pub const AGENT_INSTRUCTIONS: &str = include_str!("instructions.txt");

/// What T3's Claude adapter appends after [`AGENT_INSTRUCTIONS`]: its own texts, in its order
/// (`CLAUDE_BACKGROUND_WAIT_INSTRUCTIONS + CLAUDE_SEND_TO_USER_INSTRUCTIONS` at the pin),
/// without the device-tool text. Generated by `tools/gen-tools.mjs`.
pub const CLAUDE_INSTRUCTIONS: &str = include_str!("claude-instructions.txt");

/// `T3_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH`: Claude's device text, after
/// [`CLAUDE_INSTRUCTIONS`] (between newlines) and as the SubagentStart hook's context, when the
/// session has the device tools.
pub const DEVICE_INSTRUCTIONS: &str = include_str!("device-instructions.txt");

/// One tool's advertised definition, as one JSON line whose keys keep the contract's order.
/// The `t3 thread` CLI prints results in that order, as the T3 CLI does after decoding them.
pub fn tool_definition(name: &str) -> Option<&'static str> {
    catalog::line(name)
}

/// Whether `value` has the shape `tool`'s advertised output schema requires: the types,
/// required fields and literals it names (excess fields are allowed, as an Effect struct
/// decode allows them). A tool that advertises no output schema accepts any value. A result
/// forwarded from a linked environment is checked with this, as `PeerMcpClient` decodes it
/// with the tool's success schema.
pub fn tool_result_matches(tool: &str, value: &serde_json::Value) -> bool {
    if catalog::tool(tool).is_none() {
        return false;
    }
    match catalog::result_schema(tool) {
        Some(schema) => catalog::conforms(&schema, value, tool).is_ok(),
        None => true,
    }
}

impl McpServerEntry {
    /// One `mcpServers` entry for Claude (`--mcp-config '{"mcpServers":{"t3-code": …}}'` or the
    /// SDK's `mcpServers`), as `claudeMcpQueryOverrides` builds it.
    pub fn claude_server(&self) -> Value {
        serde_json::json!({
            "type": "http",
            "url": self.url,
            "headers": { "Authorization": self.authorization },
            "timeout": TOOL_TIMEOUT_SECS * 1000,
        })
    }

    /// The `--mcp-config` JSON for the Claude CLI.
    pub fn claude_mcp_config(&self) -> Value {
        serde_json::json!({ "mcpServers": { SERVER_NAME: self.claude_server() } })
    }
}

pub struct McpService {
    config: McpConfig,
    credentials: Mutex<credentials::Credentials>,
    sessions: Mutex<sessions::Sessions>,
    exposure: Mutex<exposure::Exposure>,
    /// Threads whose own agent asked to settle them when the active run completes.
    settling: Mutex<std::collections::HashSet<String>>,
    endpoint: OnceLock<String>,
    upload_owners: Mutex<tools::attachments::UploadOwners>,
    handoffs: Mutex<std::collections::HashSet<String>>,
    /// Whether each calling thread's project is on a forge (`forgeOfThread`): read per request,
    /// kept a minute, at most 1,000 threads.
    forges: Mutex<std::collections::HashMap<String, (bool, std::time::Instant)>>,
}

impl std::fmt::Debug for McpService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // The credentials and sessions hold agent tokens.
        f.debug_struct("McpService")
            .field("config", &self.config)
            .field("endpoint", &self.endpoint)
            .finish_non_exhaustive()
    }
}

impl McpService {
    pub async fn run_worktree_setup(
        &self,
        thread: &str,
        path: &str,
        project: &Value,
    ) -> Result<(), String> {
        let Some(config) = &self.config.worktrees else {
            return Ok(());
        };
        tools::worktree::setup(config, thread, project, path).await?;
        Ok(())
    }

    pub fn new(config: McpConfig) -> Arc<Self> {
        Arc::new(Self {
            config,
            credentials: Mutex::new(credentials::Credentials::default()),
            sessions: Mutex::new(sessions::Sessions::default()),
            exposure: Mutex::new(exposure::Exposure::default()),
            settling: Mutex::new(std::collections::HashSet::new()),
            endpoint: OnceLock::new(),
            upload_owners: Mutex::new(tools::attachments::UploadOwners::default()),
            handoffs: Mutex::new(std::collections::HashSet::new()),
            forges: Mutex::new(std::collections::HashMap::new()),
        })
    }

    /// Records where `/mcp` answers. An unspecified address (`0.0.0.0`) becomes loopback:
    /// agents run on this machine.
    pub fn set_listen_address(&self, address: SocketAddr) {
        let host = match address.ip() {
            ip if ip.is_unspecified() => "127.0.0.1".to_owned(),
            std::net::IpAddr::V6(ip) => format!("[{ip}]"),
            std::net::IpAddr::V4(ip) => ip.to_string(),
        };
        let _ = self
            .endpoint
            .set(format!("http://{host}:{}/mcp", address.port()));
    }

    pub fn endpoint(&self) -> String {
        self.endpoint
            .get()
            .cloned()
            .unwrap_or_else(|| "http://127.0.0.1/mcp".to_owned())
    }

    /// A fresh credential for one provider session of a thread. The provider passes the
    /// entry to its CLI; revoke it with [`Self::revoke_provider_session`] when the session ends.
    pub fn issue_thread_credential(&self, request: ThreadCredentialRequest) -> McpServerEntry {
        let (token, caller) = self.lock_credentials().issue(request);
        McpServerEntry {
            thread_id: caller.thread_id,
            provider_session_id: caller.provider_session_id,
            url: self.endpoint(),
            authorization: format!("Bearer {token}"),
        }
    }

    pub fn resolve_thread_token(&self, token: &str) -> Option<ThreadCaller> {
        self.lock_credentials().resolve(token)
    }

    /// Keeps a thread's tokens alive while its provider still runs turns.
    pub fn touch_thread(&self, thread_id: &str) {
        self.lock_credentials().touch(thread_id);
    }

    /// Whether the credential of `provider_session_id` still works and was issued for what
    /// `request` asks (T3's `prepareMcpSession` reuse check).
    pub fn thread_credential_fits(
        &self,
        provider_session_id: &str,
        request: &ThreadCredentialRequest,
    ) -> bool {
        self.lock_credentials().fits(provider_session_id, request)
    }

    pub fn revoke_provider_session(&self, provider_session_id: &str) {
        self.lock_credentials()
            .revoke(|caller| caller.provider_session_id == provider_session_id);
    }

    pub fn revoke_thread(&self, thread_id: &str) {
        self.lock_credentials()
            .revoke(|caller| caller.thread_id == thread_id);
    }

    /// Serves one `/mcp` request. `body` is the raw request body.
    pub async fn handle(
        self: &Arc<Self>,
        caller: Caller,
        method: &http::Method,
        headers: &http::HeaderMap,
        body: &[u8],
    ) -> Reply {
        transport::handle(self, caller, method, headers, body).await
    }

    /// Whether Linked environments is on here, read per request.
    /// `hiddenWithoutForge` for this caller: false only when a thread's project is on no forge
    /// the server reads. Outside clients, unknown threads and failed reads keep the tools.
    pub(crate) async fn forge_shown(&self, caller: &Caller) -> bool {
        const TTL: std::time::Duration = std::time::Duration::from_secs(60);
        const CAPACITY: usize = 1_000;
        let Caller::Thread(thread) = caller else {
            return true;
        };
        let now = std::time::Instant::now();
        if let Some((shown, at)) = lock(&self.forges).get(&thread.thread_id)
            && now.duration_since(*at) < TTL
        {
            return *shown;
        }
        let shown = self.read_forge(&thread.thread_id).await;
        let mut forges = lock(&self.forges);
        if forges.len() >= CAPACITY {
            forges.retain(|_, (_, at)| now.duration_since(*at) < TTL);
        }
        if forges.len() >= CAPACITY
            && let Some(oldest) = forges
                .iter()
                .min_by_key(|(_, (_, at))| *at)
                .map(|(id, _)| id.clone())
        {
            forges.remove(&oldest);
        }
        forges.insert(thread.thread_id.clone(), (shown, now));
        shown
    }

    async fn read_forge(&self, thread_id: &str) -> bool {
        let Some(host) = self.config.pull_requests.clone() else {
            return true;
        };
        let Ok(projection) = self
            .config
            .engine
            .get_thread_projection(conn_contract::ThreadId::from(thread_id))
            .await
        else {
            return true;
        };
        let project = projection["thread"]["projectId"].clone();
        if project.is_null() {
            return true;
        }
        match host("servesProject", serde_json::json!({"projectId": project})).await {
            Ok(Value::Bool(shown)) => shown,
            _ => true,
        }
    }

    pub(crate) fn links_enabled(&self) -> bool {
        self.config.peers.as_ref().is_some_and(|p| p.enabled())
    }

    fn lock_credentials(&self) -> std::sync::MutexGuard<'_, credentials::Credentials> {
        crate::lock(&self.credentials)
    }

    fn lock_sessions(&self) -> std::sync::MutexGuard<'_, sessions::Sessions> {
        crate::lock(&self.sessions)
    }
}

/// 32 bytes from the OS, hex encoded.
fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    getrandom::fill(&mut buf).expect("OS random source");
    conn_support::hex::hex(&buf)
}
/// Locks a std mutex. A poisoned lock means a thread panicked while it held the lock: a bug.
/// With `panic = "abort"` a release build stops at the panic itself.
pub(crate) fn lock<T>(mutex: &std::sync::Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().expect("conn-mcp lock poisoned")
}

#[cfg(test)]
mod tests;
