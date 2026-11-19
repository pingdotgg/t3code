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
mod sessions;
pub mod snapshot;
mod time;
mod tools;
mod transport;
mod view;
mod worktrees;

pub use credentials::ThreadCredentialRequest;
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
    /// The server's GitHub pull request panel; without it the watch and guide tools answer
    /// as T3 does when no host can be read.
    pub pull_requests: Option<PullRequestHost>,
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
    /// A delegated child: it hands its work back to its parent.
    pub subagent: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ClientCaller {
    pub session_id: String,
    /// `None`: read-only. Otherwise the broadest runtime mode it may start threads in.
    pub max_runtime_mode: Option<&'static str>,
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

/// One tool's advertised definition, as one JSON line whose keys keep the contract's order.
/// The `t3 thread` CLI prints results in that order, as the T3 CLI does after decoding them.
pub fn tool_definition(name: &str) -> Option<&'static str> {
    catalog::line(name)
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
