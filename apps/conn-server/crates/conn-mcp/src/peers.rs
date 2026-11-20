//! Linked environments as `/mcp` sees them: the port to the server's peer links, the tools
//! that run in another environment, and the four link tools. Reference:
//! `apps/server/src/peer/PeerForwarding.ts`, `McpToolAccess.routed` and the link handlers in
//! `toolkits/orchestrator/handlers.ts`.
//!
//! A tool whose `environmentId` is `OrchestratorMcpEnvironmentTarget` (`linked-targets.txt`,
//! generated) runs in the linked environment it names: its access rule checks the caller here,
//! and the same call goes there with the caller's limits, where the peer checks the rest.

use conn_engine::BoxFuture;
use conn_support::modes::runtime_rank;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::tools::{Args, Cx, ToolError, ToolResult, fail};
use crate::{Caller, ClientCaller};

/// The tools that run in a linked environment when `environmentId` names one.
const LINKED_TARGETS: &str = include_str!("linked-targets.txt");

/// The tools hidden while Linked environments is off (`hiddenWhileLinksOff`).
const LINKS_HIDDEN: &str = include_str!("links-hidden.txt");

pub(crate) fn takes_linked_environment(tool: &str) -> bool {
    LINKED_TARGETS.lines().any(|name| name == tool)
}

pub(crate) fn hidden_while_links_off(tool: &str) -> bool {
    LINKS_HIDDEN.lines().any(|name| name == tool)
}

/// `OrchestratorMcpFailure.code`: a peer's refusal keeps its own code when it is one of these.
const FAILURE_CODES: &[&str] = &[
    "capability_denied",
    "parent_not_active",
    "provider_unavailable",
    "model_unavailable",
    "runtime_mode_escalation_denied",
    "interaction_mode_escalation_denied",
    "task_not_found",
    "task_not_cancellable",
    "thread_not_found",
    "run_not_found",
    "thread_not_sendable",
    "thread_not_interruptible",
    "invalid_request",
    "orchestration_error",
    "thread_credential_required",
    "target_required",
];

pub(crate) fn failure_code(code: &str) -> &'static str {
    FAILURE_CODES
        .iter()
        .find(|known| **known == code)
        .copied()
        .unwrap_or("orchestration_error")
}

/// `linkedEnvironmentsOff` in `PeerForwarding.ts`.
pub(crate) const LINKED_ENVIRONMENTS_OFF: &str = "Linked environments is off on this machine, so no tool can act on another machine. Leave out environmentId to work here; the user can turn it on in Settings → Labs.";

/// `LINKED_ENVIRONMENTS_OFF` in `PeerLinks.ts`.
pub const LINKS_OFF_HERE: &str =
    "Linked environments is off on this machine. Turn it on in Settings → Labs.";

/// The scope a native bearer session needs for a link or settings tool, as the matching RPC
/// methods require (`peerLinks.*`, `server.updateSettings`).
pub(crate) fn native_scope(tool: &str) -> Option<&'static str> {
    match tool {
        "t3_environment_links" => Some("access:read"),
        "t3_environment_link" | "t3_environment_unlink" => Some("access:write"),
        "t3_environment_preferences_update" => Some("settings:write"),
        _ => None,
    }
}

/// What `threadNotFound` adds while links are on, for a caller that may use them.
pub(crate) const THREAD_IDS_HINT: &str = " Thread ids belong to one environment: for a thread on a linked one, find it with `t3_environment_links` and pass its `environmentId` to a tool that takes one.";

const NOT_LISTED: &str =
    "Not listed: not linked yet. Call t3_environment_link with a hint from the user's words.";

fn full_access(limits: &crate::tools::Limits) -> Result<(), ToolError> {
    if limits.runtime_mode == "full-access" && limits.interaction_mode == "default" {
        Ok(())
    } else {
        Err(fail("capability_denied", FULL_ACCESS_REQUIRED))
    }
}

const FULL_ACCESS_REQUIRED: &str = "Changing projects or environment settings needs a live full-access/default calling thread or a full-access client.";

// Match local waits: return before MCP client timeouts and relay idle drops.
const DEFAULT_WAIT_TIMEOUT_MS: i64 = 30_000;
const MAX_WAIT_TIMEOUT_MS: i64 = 45_000;

/// The limits a forwarded call carries (`T3-Mode-Limit`): the calling agent's modes here.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PeerLimits {
    pub runtime_mode: String,
    pub interaction_mode: String,
}

/// The thread here a forwarded call is made for (`T3-Sender-Thread`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PeerSender {
    pub environment_id: String,
    pub thread_id: String,
    pub title: String,
}

#[derive(Clone, Debug)]
pub struct PeerCall {
    pub environment_id: String,
    pub tool: String,
    pub arguments: Map<String, Value>,
    pub limits: PeerLimits,
    pub sender: Option<PeerSender>,
}

/// An `OrchestratorMcpFailure` as the agent hears it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PeerFailure {
    pub code: String,
    pub message: String,
}

/// A stored link, without asking the peer whether it answers.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LinkInfo {
    pub label: String,
    pub access: String,
    pub expired: bool,
}

/// An agent's `t3_environment_link` call, checked here.
#[derive(Clone, Debug)]
pub struct LinkAsk {
    pub thread_id: String,
    pub provider_instance_id: String,
    /// `requestNamespace`: retries with the same clientRequestId find their card.
    pub namespace: String,
    pub arguments: Map<String, Value>,
}

/// The server's peer links, as `/mcp` uses them.
pub trait Peers: Send + Sync {
    /// Whether the Linked environments beta (Settings → Labs) is on here.
    fn enabled(&self) -> bool;
    /// `PeerLinkSummary` entries, each probed.
    fn list(&self) -> BoxFuture<'_, Result<Vec<Value>, String>>;
    fn get(&self, environment_id: &str) -> BoxFuture<'_, Result<Option<LinkInfo>, String>>;
    fn unlink(&self, environment_id: &str) -> BoxFuture<'_, Result<bool, String>>;
    /// Runs a tool there and returns its structured result.
    fn call(&self, call: PeerCall) -> BoxFuture<'_, Result<Value, PeerFailure>>;
    /// Shows a link card in the calling thread (`PeerLinkRequests.request`).
    fn request_link(&self, ask: LinkAsk) -> BoxFuture<'_, Result<Value, PeerFailure>>;
}

pub(crate) fn peer_failure(error: PeerFailure) -> ToolError {
    fail(failure_code(&error.code), error.message)
}

impl Cx<'_> {
    fn peers(&self) -> Option<&dyn Peers> {
        self.config().peers.as_deref()
    }

    /// `callerLinkOrigin`: the link a caller acts for, its own session or the one that started
    /// its thread.
    pub(crate) async fn link_origin(&self) -> Result<Option<Value>, ToolError> {
        match self.caller {
            Caller::Client(client) if client.linked => Ok(Some(json!({
                "sessionId": client.session_id,
                "label": client.label,
                "access": client.access(),
            }))),
            Caller::Client(_) => Ok(None),
            // Only a thread read that succeeded says the caller acts for no link: a failed read
            // must not open the fence.
            Caller::Thread(thread) => {
                let own = self.projection(&thread.thread_id).await?;
                Ok(own["thread"]
                    .get("linkOrigin")
                    .cloned()
                    .filter(Value::is_object))
            }
        }
    }

    /// `fencingLinkOrigin`: a link paired below full access fences its work.
    pub(crate) async fn fencing_link(&self) -> Result<Option<Value>, ToolError> {
        Ok(self
            .link_origin()
            .await?
            .filter(|origin| origin["access"].as_str() != Some("full-access")))
    }

    /// `assertNotLinked`: fenced work never changes what this environment already has.
    pub(crate) async fn assert_not_linked(&self, what: &str) -> Result<(), ToolError> {
        match self.fencing_link().await? {
            Some(origin) => Err(fail(
                "capability_denied",
                format!(
                    "This work was started from {} through a linked environment, so it cannot {what}. A link paired with full access is not limited this way.",
                    origin["label"].as_str().unwrap_or_default()
                ),
            )),
            None => Ok(()),
        }
    }

    /// `assertSameLink`: a fenced caller changes only threads its own link started.
    pub(crate) async fn assert_same_link(&self, target: &Value) -> Result<(), ToolError> {
        let Some(origin) = self.fencing_link().await? else {
            return Ok(());
        };
        if target["linkOrigin"]["sessionId"] == origin["sessionId"] {
            return Ok(());
        }
        Err(fail(
            "capability_denied",
            format!(
                "This work was started from {} through a linked environment, so it may change only threads that link started. A link paired with full access is not limited this way.",
                origin["label"].as_str().unwrap_or_default()
            ),
        ))
    }

    /// A native bearer session may do what its scopes allow and no more: changing settings
    /// needs `settings:write`, links `access:read` or `access:write`, as the RPC methods do.
    pub(crate) fn require_scope(&self, scope: &str) -> Result<(), ToolError> {
        match self.caller {
            Caller::Client(ClientCaller {
                scopes: Some(scopes),
                ..
            }) if !scopes.iter().any(|s| s == scope) => Err(fail(
                "capability_denied",
                format!(
                    "This tool needs the {scope} permission, which this session was not granted."
                ),
            )),
            _ => Ok(()),
        }
    }

    /// `writesEnvironment`'s check: a live writing caller, not fenced, with full access.
    pub(crate) async fn environment_writer(&self) -> Result<(), ToolError> {
        let limits = self.writing_caller().await?;
        self.assert_not_linked("change projects or environment settings")
            .await?;
        full_access(&limits)
    }

    /// `writesEnvironment` with `linkedCallers: "allowed"`: adding a project or a clone leaves
    /// everything already here as it was, so linked work may do it.
    pub(crate) async fn environment_writer_from_links(&self) -> Result<(), ToolError> {
        full_access(&self.writing_caller().await?)
    }

    /// The check a call bound for a linked environment runs here first (`RemoteCheck`): the
    /// caller, not what it names, which lives there.
    async fn remote_check(&self, tool: &str, args: &Args) -> Result<(), ToolError> {
        let action = args.get("action").and_then(Value::as_str);
        let reads = match tool {
            "t3_pending_request" => action != Some("respond"),
            "t3_queue" => matches!(action, Some("list" | "read")),
            "t3_thread_transfer" => action == Some("status"),
            "t3_thread_configure" => !args.contains_key("modelSelection"),
            "orchestrator_capabilities"
            | "t3_thread_list"
            | "t3_thread_read"
            | "t3_thread_wait"
            | "t3_thread_search"
            | "t3_project_list"
            | "t3_project_read"
            | "t3_environment_read"
            | "list_scheduled_tasks"
            | "list_thread_pull_requests"
            | "t3_worktree_list"
            | "read_pull_request_guide"
            | "pull_request_read"
            | "pull_request_list"
            | "ci_logs"
            | "list_issues"
            | "read_issue"
            | "list_thread_issues" => true,
            _ => false,
        };
        if reads {
            return Ok(());
        }
        let limits = self.writing_caller().await?;
        if matches!(
            tool,
            "run_scheduled_task_now"
                | "t3_environment_preferences_update"
                | "t3_project_create"
                | "t3_project_update"
                | "t3_project_delete"
        ) && !(limits.runtime_mode == "full-access" && limits.interaction_mode == "default")
        {
            return Err(fail("capability_denied", FULL_ACCESS_REQUIRED));
        }
        Ok(())
    }

    /// `forwardingCaller`: the caller's limits and thread. Work a link started never uses this
    /// environment's links: the peer would see this environment's session, not that link.
    async fn forwarding_caller(
        &self,
    ) -> Result<(crate::tools::Limits, Option<PeerSender>), ToolError> {
        let limits = self.limits().await?;
        self.assert_not_linked("use this environment's links")
            .await?;
        let sender = match self.caller {
            Caller::Thread(thread) => {
                let title = self
                    .projection(&thread.thread_id)
                    .await
                    .ok()
                    .and_then(|p| p["thread"]["title"].as_str().map(str::to_owned))
                    .unwrap_or_default();
                Some(PeerSender {
                    environment_id: self.config().environment_id.clone(),
                    thread_id: thread.thread_id.clone(),
                    title,
                })
            }
            Caller::Client(_) => None,
        };
        Ok((limits, sender))
    }

    /// `McpToolAccess.routed` and `PeerForwarding.call`: runs `tool` in `target`.
    pub(crate) async fn forward(&self, tool: &str, mut args: Args, target: String) -> ToolResult {
        let Some(peers) = self.peers() else {
            return Err(fail("capability_denied", LINKED_ENVIRONMENTS_OFF));
        };
        if !peers.enabled() {
            return Err(fail("capability_denied", LINKED_ENVIRONMENTS_OFF));
        }
        self.remote_check(tool, &args).await?;
        let (limits, sender) = self.forwarding_caller().await?;
        // The peer refuses a mode above the link's access too, but as "broader than parent
        // mode", which misleads when the parent here is broader.
        if let Some(requested) = args.get("runtimeMode").and_then(Value::as_str)
            && matches!(
                requested,
                "approval-required" | "auto-accept-edits" | "auto" | "full-access"
            )
            && let Some(link) = peers
                .get(&target)
                .await
                .map_err(|message| fail("orchestration_error", message))?
            && !link.expired
            && link.access != "read-only"
            && runtime_rank(requested) > runtime_rank(&link.access)
        {
            return Err(fail(
                "runtime_mode_escalation_denied",
                format!(
                    "Linked environment \"{}\" was linked with {} access, so work there cannot run in {requested}. Omit runtimeMode to run it at a mode up to {}, or link it again with broader access.",
                    link.label, link.access, link.access
                ),
            ));
        }
        if args
            .get("attachments")
            .and_then(Value::as_array)
            .is_some_and(|a| !a.is_empty())
        {
            return Err(fail(
                "invalid_request",
                "A launch in a linked environment cannot carry attachments yet.",
            ));
        }
        // Every caller here reaches the peer as the one link session, so a retry key is
        // scoped to its caller before it leaves.
        scope_request(&mut args, tool, &self.caller.namespace());
        peers
            .call(PeerCall {
                environment_id: target,
                tool: tool.to_owned(),
                arguments: args,
                limits: PeerLimits {
                    runtime_mode: limits.runtime_mode,
                    interaction_mode: limits.interaction_mode,
                },
                sender,
            })
            .await
            .map_err(peer_failure)
    }
}

/// `scopedRequestId` and `waitForThread`'s cap: every caller here reaches the peer as the one
/// link session, so a retry key is scoped to its caller (`namespace`) before it leaves.
pub(crate) fn scope_request(args: &mut Args, tool: &str, namespace: &str) {
    if let Some(Value::String(id)) = args.get("clientRequestId") {
        let digest = Sha256::digest(format!("{namespace}\n{id}").as_bytes());
        let scoped = format!("fwd:{}", conn_support::hex::hex(&digest));
        args.insert("clientRequestId".into(), json!(scoped));
    }
    if tool == "t3_thread_wait" {
        let asked = args
            .get("timeoutMs")
            .and_then(Value::as_i64)
            .unwrap_or(DEFAULT_WAIT_TIMEOUT_MS);
        args.insert(
            "timeoutMs".into(),
            json!(asked.clamp(1, MAX_WAIT_TIMEOUT_MS)),
        );
    }
}

/// `t3_environment_links` (`PeerForwarding.links`).
pub(crate) async fn links(cx: &Cx<'_>) -> ToolResult {
    cx.forwarding_caller().await?;
    let Some(peers) = cx.peers().filter(|p| p.enabled()) else {
        return Err(fail("capability_denied", LINKED_ENVIRONMENTS_OFF));
    };
    let listed = peers
        .list()
        .await
        .map_err(|message| fail("orchestration_error", message))?;
    let links: Vec<Value> = listed
        .iter()
        .map(|link| {
            json!({
                "environmentId": link["environmentId"],
                "label": link["label"],
                "status": link["status"],
                "access": link["access"],
                "expiresAt": link["expiresAt"],
                "lastError": link["lastError"],
            })
        })
        .collect();
    Ok(json!({
        "environmentId": cx.config().environment_id,
        "links": links,
        "notListed": NOT_LISTED,
    }))
}

/// `t3_environment_unlink`: forgets the link here; the peer lists the session until revoked.
pub(crate) async fn unlink(cx: &Cx<'_>, args: &Args) -> ToolResult {
    cx.environment_writer().await?;
    let environment = args
        .get("environmentId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let Some(peers) = cx.peers() else {
        return Err(fail(
            "orchestration_error",
            "This environment cannot reach linked environments.",
        ));
    };
    let removed = peers
        .unlink(&environment)
        .await
        .map_err(|message| fail("orchestration_error", message))?;
    Ok(json!({"environmentId": environment, "removed": removed}))
}

/// `t3_environment_link`: a card in the calling thread; returns at once.
pub(crate) async fn link(cx: &Cx<'_>, args: &Args) -> ToolResult {
    cx.environment_writer().await?;
    let thread = cx.require_thread("t3_environment_link")?.clone();
    let Some(peers) = cx.peers().filter(|p| p.enabled()) else {
        return Err(fail("capability_denied", LINKS_OFF_HERE));
    };
    peers
        .request_link(LinkAsk {
            thread_id: thread.thread_id.clone(),
            provider_instance_id: thread.provider_instance_id.clone(),
            namespace: cx.caller.namespace(),
            arguments: args.clone(),
        })
        .await
        .map_err(peer_failure)
}

/// T3's `preferences` of default settings, generated by `tools/gen-tools.mjs`.
const PREFERENCE_DEFAULTS: &str = include_str!("preference-defaults.json");

/// `preferences` in `toolkits/environment/handlers.ts`: what an agent may read and change, from
/// the sparse settings over the defaults. `defaultThreadEnvMode` is left out while unset, as its
/// schema (`OmittedWhenNull`) encodes it.
pub(crate) fn preferences(settings: &Map<String, Value>) -> Value {
    let mut out: Value = serde_json::from_str(PREFERENCE_DEFAULTS).unwrap_or_else(|_| json!({}));
    for key in [
        "defaultThreadEnvMode",
        "newWorktreesStartFromOrigin",
        "enableProviderUpdateChecks",
    ] {
        if let Some(value) = settings.get(key) {
            out[key] = value.clone();
        }
    }
    if let Some(profile) = settings
        .get("backgroundActivity")
        .and_then(|b| b.get("profile"))
    {
        out["backgroundActivity"]["profile"] = profile.clone();
    }
    if let Some(style) = settings
        .get("sourceControlWritingStyle")
        .and_then(Value::as_object)
    {
        for (key, value) in style {
            out["sourceControlWritingStyle"][key] = value.clone();
        }
    }
    let instructions = out["sourceControlWritingStyle"]["customInstructions"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let count = instructions.chars().count();
    out["sourceControlWritingStyle"]["customInstructions"] =
        json!(instructions.chars().take(4000).collect::<String>());
    out["sourceControlWritingStyle"]["truncated"] = json!(count > 4000);
    if let Some(fields) = out.as_object_mut()
        && fields
            .get("defaultThreadEnvMode")
            .is_some_and(Value::is_null)
    {
        fields.remove("defaultThreadEnvMode");
    }
    out
}

/// `t3_environment_preferences_update`: the omitted fields stay as they are.
pub(crate) async fn preferences_update(cx: &Cx<'_>, args: &Args) -> ToolResult {
    cx.environment_writer().await?;
    let Some(settings) = &cx.config().settings else {
        return Err(fail(
            "orchestration_error",
            "Settings are not available here.",
        ));
    };
    let patch: Map<String, Value> = args
        .iter()
        .filter(|(key, _)| key.as_str() != "environmentId")
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    let updated = (settings.update)(Value::Object(patch))
        .await
        .map_err(|message| fail("orchestration_error", message))?;
    Ok(preferences(&updated))
}
