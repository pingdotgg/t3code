//! Orbit Nodes & Instances discovery, auto-pairing, waking, and local session persistence.
//!
//! Orbit manages two distinct kinds of `conn-server` targets returned by the Gateway's
//! `/api/v1/conn/environments` registry:
//! - **Nodes** (`instance_id == None`): long-lived Orbit Nodes (`beast`, `mini`, `nick`, `shark`, …)
//!   running a host `conn-server`.
//! - **Instances** (`instance_id == Some(id)`): isolated per-project / per-branch Orbit Instances
//!   (e.g. `beast / dlf-leden / task-6169`) with `power_state` (`running` | `stopped`) that can be
//!   woken on demand via `POST /api/v1/instances/{id}/wake`.
//!
//! This module harmonizes the client domain model around **Nodes** and **Instances** while speaking
//! the Gateway's wire paths transparently. All code here is GPUI-free and `#![forbid(unsafe_code)]`.

use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::gateway::{GatewayRequest, GatewayTransport, OrbitGateway};
use super::profile::{ProfileError, ProfileResult};
use super::tasks::PowerState;

/// Registration status of an Orbit Node or Instance on the Gateway.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OrbitTargetStatus {
    Registered,
    SessionExpired,
}

/// Distinguishes a host Orbit Node from a per-project Orbit Instance.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum OrbitTargetKind {
    /// Host `conn-server` running directly on an Orbit Node (e.g. `beast`, `nick`, `mini`).
    Node {
        node_name: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        roles: Vec<String>,
        /// The Gateway's `is_primary_agent`: this Node is the fleet's primary Conn entry point.
        #[serde(default)]
        is_primary_agent: bool,
    },
    /// Isolated Orbit Instance for a project branch on a Node.
    Instance {
        instance_id: i64,
        instance_name: String,
        project_id: Option<i64>,
        project_name: Option<String>,
        project_slug: Option<String>,
        node_name: Option<String>,
        instance_url: Option<String>,
        power_state: Option<PowerState>,
    },
}

/// One registered Orbit `conn-server` target — either a Node or an Instance.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OrbitServerTarget {
    /// Gateway wire identifier (`environment_id` on the wire).
    pub server_id: String,
    pub label: String,
    pub url: String,
    pub server_version: Option<String>,
    pub registered_by: Option<String>,
    pub status: OrbitTargetStatus,
    pub cleanup_pending: bool,
    pub kind: OrbitTargetKind,
}

impl OrbitServerTarget {
    /// True when this target is an Orbit Node (`instance_id == None`).
    #[must_use]
    pub fn is_node(&self) -> bool {
        matches!(self.kind, OrbitTargetKind::Node { .. })
    }

    /// True when this target is an Orbit Instance (`instance_id == Some(_)`).
    #[must_use]
    pub fn is_instance(&self) -> bool {
        matches!(self.kind, OrbitTargetKind::Instance { .. })
    }

    /// Instance numeric id when this target is an Orbit Instance.
    #[must_use]
    pub fn instance_id(&self) -> Option<i64> {
        match &self.kind {
            OrbitTargetKind::Node { .. } => None,
            OrbitTargetKind::Instance { instance_id, .. } => Some(*instance_id),
        }
    }

    /// Power state for an Instance, or `None` for a host Node.
    #[must_use]
    pub fn power_state(&self) -> Option<PowerState> {
        match &self.kind {
            OrbitTargetKind::Node { .. } => None,
            OrbitTargetKind::Instance { power_state, .. } => *power_state,
        }
    }

    /// True for Nodes (always considered awake) and for running Instances.
    #[must_use]
    pub fn is_awake(&self) -> bool {
        match &self.kind {
            OrbitTargetKind::Node { .. } => true,
            OrbitTargetKind::Instance { power_state, .. } => {
                !matches!(power_state, Some(PowerState::Stopped))
            }
        }
    }

    /// Host node name (`beast`, `nick`, …) for both Nodes and Instances.
    #[must_use]
    pub fn node_name(&self) -> Option<&str> {
        match &self.kind {
            OrbitTargetKind::Node { node_name, .. } => Some(node_name.as_str()),
            OrbitTargetKind::Instance { node_name, .. } => {
                node_name.as_deref().or(self.registered_by.as_deref())
            }
        }
    }

    /// Orbit roles attached to this Node (empty for Instances or nodes without roles).
    #[must_use]
    pub fn roles(&self) -> &[String] {
        match &self.kind {
            OrbitTargetKind::Node { roles, .. } => roles.as_slice(),
            OrbitTargetKind::Instance { .. } => &[],
        }
    }

    /// True when this target is an Orbit Node carrying the `"agent"` role.
    #[must_use]
    pub fn has_agent_role(&self) -> bool {
        match &self.kind {
            OrbitTargetKind::Node { roles, .. } => {
                roles.iter().any(|r| r.eq_ignore_ascii_case("agent"))
            }
            OrbitTargetKind::Instance { .. } => false,
        }
    }

    /// True when the Gateway marks this Node as the primary agent (`is_primary_agent`).
    #[must_use]
    pub fn is_primary_agent(&self) -> bool {
        matches!(
            self.kind,
            OrbitTargetKind::Node {
                is_primary_agent: true,
                ..
            }
        )
    }

    /// Human-readable primary title (`beast` for a Node; `dlf-leden / task-6169` for an Instance).
    #[must_use]
    pub fn display_title(&self) -> String {
        match &self.kind {
            OrbitTargetKind::Node { .. } => self.label.clone(),
            OrbitTargetKind::Instance {
                instance_name,
                project_name,
                project_slug,
                ..
            } => {
                let project = project_name
                    .as_deref()
                    .or(project_slug.as_deref())
                    .filter(|s| !s.is_empty());
                match project {
                    Some(proj) => format!("{proj} / {instance_name}"),
                    None => self.label.clone(),
                }
            }
        }
    }

    /// Compact secondary description (`10.44.0.7:3773 · v0.1.6` or `on beast · running`).
    #[must_use]
    pub fn display_subtitle(&self) -> String {
        let short_url = self
            .url
            .strip_prefix("https://")
            .or_else(|| self.url.strip_prefix("http://"))
            .unwrap_or(&self.url);
        match &self.kind {
            OrbitTargetKind::Node { .. } => match &self.server_version {
                Some(ver) if !ver.is_empty() => format!("{short_url} · {ver}"),
                _ => short_url.to_owned(),
            },
            OrbitTargetKind::Instance {
                node_name,
                power_state,
                instance_url,
                ..
            } => {
                let mut parts = Vec::with_capacity(3);
                if let Some(node) = node_name.as_deref().or(self.registered_by.as_deref()) {
                    parts.push(format!("on {node}"));
                }
                if let Some(state) = power_state {
                    parts.push(match state {
                        PowerState::Running => "running".to_owned(),
                        PowerState::Stopped => "stopped".to_owned(),
                    });
                }
                if let Some(host) = instance_url.as_deref().and_then(|u| {
                    u.strip_prefix("https://")
                        .or_else(|| u.strip_prefix("http://"))
                }) {
                    parts.push(host.to_owned());
                } else {
                    parts.push(short_url.to_owned());
                }
                parts.join(" · ")
            }
        }
    }
}

/// Harmonized view of Orbit Nodes and Orbit Instances available to this caller.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct OrbitFleet {
    pub nodes: Vec<OrbitServerTarget>,
    pub instances: Vec<OrbitServerTarget>,
    /// The local Node's name given to [`Self::from_targets`], for [`Self::primary_agent_node`].
    pub local_node_name: Option<String>,
}

impl OrbitFleet {
    /// Splits raw Gateway targets into sorted `nodes` (local node first) and `instances`
    /// (running instances first, then alphabetical by title).
    #[must_use]
    pub fn from_targets(targets: Vec<OrbitServerTarget>, local_node_name: Option<&str>) -> Self {
        let mut nodes = Vec::new();
        let mut instances = Vec::new();
        for target in targets {
            if target.cleanup_pending {
                continue;
            }
            if target.is_node() {
                nodes.push(target);
            } else {
                instances.push(target);
            }
        }

        nodes.sort_by(|a, b| {
            let a_local = local_node_name.is_some_and(|n| a.label.eq_ignore_ascii_case(n));
            let b_local = local_node_name.is_some_and(|n| b.label.eq_ignore_ascii_case(n));
            b_local.cmp(&a_local).then_with(|| {
                a.label
                    .to_ascii_lowercase()
                    .cmp(&b.label.to_ascii_lowercase())
            })
        });

        instances.sort_by(|a, b| {
            let a_running = matches!(a.power_state(), Some(PowerState::Running));
            let b_running = matches!(b.power_state(), Some(PowerState::Running));
            b_running.cmp(&a_running).then_with(|| {
                a.display_title()
                    .to_ascii_lowercase()
                    .cmp(&b.display_title().to_ascii_lowercase())
            })
        });

        Self {
            nodes,
            instances,
            local_node_name: local_node_name.map(str::to_owned),
        }
    }

    /// Looks up any Node or Instance by its Gateway `server_id`.
    #[must_use]
    pub fn find_by_server_id(&self, server_id: &str) -> Option<&OrbitServerTarget> {
        self.nodes
            .iter()
            .chain(self.instances.iter())
            .find(|t| t.server_id == server_id)
    }

    /// Looks up any Node or Instance matching `url` (ignoring trailing slashes).
    #[must_use]
    pub fn find_by_url(&self, url: &str) -> Option<&OrbitServerTarget> {
        let needle = url.trim_end_matches('/');
        self.nodes
            .iter()
            .chain(self.instances.iter())
            .find(|t| t.url.trim_end_matches('/') == needle)
    }

    /// Number of running Instances.
    #[must_use]
    pub fn running_instance_count(&self) -> usize {
        self.instances
            .iter()
            .filter(|t| matches!(t.power_state(), Some(PowerState::Running)))
            .count()
    }

    /// All Orbit Nodes carrying the `"agent"` role.
    #[must_use]
    pub fn agent_nodes(&self) -> Vec<&OrbitServerTarget> {
        self.nodes
            .iter()
            .filter(|node| node.has_agent_role())
            .collect()
    }

    /// Preferred default Orbit Node entry point: [`select_primary_agent_node`] with the local
    /// Node this fleet was built with.
    #[must_use]
    pub fn primary_agent_node(&self) -> Option<&OrbitServerTarget> {
        select_primary_agent_node(&self.nodes, self.local_node_name.as_deref())
    }

    /// Selects the primary `agent`-role Node from this fleet, falling back only to
    /// `local_node_name` when that local host Node is registered (otherwise `None`, e.g. on iOS).
    ///
    /// Delegates to [`select_primary_agent_node`]; see its docs for the full selection order and
    /// the Gateway pairing + token-exchange flow needed to connect to the selected node.
    #[must_use]
    pub fn select_primary_agent_node(
        &self,
        local_node_name: Option<&str>,
    ) -> Option<&OrbitServerTarget> {
        select_primary_agent_node(&self.nodes, local_node_name)
    }
}

fn matches_local_node(target: &OrbitServerTarget, local_node_name: Option<&str>) -> bool {
    let Some(needle) = local_node_name.map(str::trim).filter(|s| !s.is_empty()) else {
        return false;
    };
    target
        .node_name()
        .is_some_and(|name| name.eq_ignore_ascii_case(needle))
        || target.label.eq_ignore_ascii_case(needle)
}

fn deterministic_node_order<'a>(
    target: &'a OrbitServerTarget,
    local_node_name: Option<&str>,
) -> (bool, String, &'a str) {
    (
        !matches_local_node(target, local_node_name),
        target.label.to_ascii_lowercase(),
        target.server_id.as_str(),
    )
}

/// Selects the primary agent Node from the Gateway's target list (`docs/scope.md` §5.4). The
/// Gateway reports each Node's `roles` and `is_primary_agent` on `GET /api/v1/conn/environments`.
///
/// Mirrors how desktop (`conn-app`) and Expo mobile (`apps/mobile/src/features/orbit/orbitGatewayStore.ts`,
/// `OrbitEnvironmentSections.tsx`) interpret `GET /api/v1/conn/environments`:
/// - Only host Nodes (`instance_id == None`, i.e. [`OrbitServerTarget::is_node`]) that are
///   `Registered` and not `cleanup_pending` are eligible; per-project Instance clones and
///   `SessionExpired` registrations are skipped.
/// - Selection priority:
///   1. The agent entry, `agent_entry_node`: the Node the Gateway marks `is_primary_agent`,
///      else the only Node with the `"agent"` role.
///   2. Else, when `local_node_name` is `Some(name)`, the registered host Node matching `name` by
///      `node_name` or `label` (desktop day-1 local fallback).
///   3. `None` when neither applies (e.g. on iOS, where the phone does not host `conn-server`,
///      or when `local_node_name` is `None`).
///
/// # Connecting to the selected node (URL + credential)
///
/// Selecting a node only identifies the target; callers obtain a `conn-server` URL and bearer
/// credential via the following flow (not executed here):
///
/// 1. **Discover the node & fleet:** Call `GET /api/v1/conn/me`
///    ([`OrbitProfileClient::me`](super::profile::OrbitProfileClient::me)) for this device's node
///    name and `GET /api/v1/conn/environments` ([`OrbitFleetClient::list_fleet`]), mirroring
///    `packages/client-runtime/src/orbitGateway/client.ts` (`me`, `environments`),
///    `apps/mobile/src/features/orbit/orbitGatewayStore.ts` (`refreshOrbitGateway`), and
///    `apps/conn-gpui/crates/conn-app/src/orbit_sync.rs` (`fetch_orbit_profile`).
/// 2. **Reuse a cached bearer token when already paired:** If the client already persisted a
///    bearer token for `target.server_id` (macOS: `conn_desktop::orbit::OrbitSessionStore`; iOS:
///    Keychain / SecureStore), connect directly to `target.url` with that bearer token (see
///    `apps/conn-gpui/crates/conn-app/src/app.rs` `connect_orbit_target` and
///    `apps/mobile/src/features/orbit/orbitGatewayStore.ts` `reconcileEnvironments`).
/// 3. **Mint a one-time pairing URL from Orbit Gateway:** Call
///    [`OrbitFleetClient::mint_pairing`] with `target.server_id`, which sends
///    `POST /api/v1/conn/environments/{server_id}/pairings` (passing `{ "renew": true }` when
///    renewing an expired/expiring session). If the Gateway responds `202 Accepted` with an async
///    `conn.pairing_create` Operation, `mint_pairing` polls `GET /api/v1/operations/{id}` until
///    `status == "succeeded"` and reads `GET /api/v1/conn/environments/{server_id}/pairings/{pairing_id}`
///    once to return an [`OrbitPairingTicket`] (see
///    `packages/client-runtime/src/orbitGateway/client.ts` `pair` and
///    `apps/mobile/src/features/orbit/orbitGatewayStore.ts` `attemptPairing`).
/// 4. **Extract the `conn-server` URL and pairing code:** Read
///    [`OrbitPairingTicket::http_base_url`] (falling back to `target.url`) and
///    [`OrbitPairingTicket::pairing_code`] (the `#token=<code>` fragment).
/// 5. **Exchange the pairing code for a `conn-server` bearer token:** `POST {http_base_url}/oauth/token`
///    (`application/x-www-form-urlencoded`, `grant_type=urn:ietf:params:oauth:grant-type:token-exchange`,
///    `subject_token=<code>`, `subject_token_type=urn:t3:params:oauth:token-type:environment-bootstrap`,
///    `requested_token_type=urn:t3:params:oauth:token-type:access_token`). In Rust, passing
///    `conn_client::Credential::PairingCode(code)` does this exchange automatically (see
///    `apps/conn-gpui/crates/conn-client/src/auth.rs` `exchange_pairing_code` and
///    `apps/conn-gpui/crates/conn-client/src/driver.rs`); in TypeScript/Expo, see
///    `packages/client-runtime/src/connection/onboarding.ts` (`registerPairingConnection`) and
///    `apps/mobile/src/connection/onboarding.ts` (`connectPairingUrl`). Persist the returned
///    `access_token` per `server_id` and open `/ws?orchestrationProtocol=2` with
///    `Authorization: Bearer <access_token>`.
#[must_use]
pub fn select_primary_agent_node<'a>(
    targets: &'a [OrbitServerTarget],
    local_node_name: Option<&str>,
) -> Option<&'a OrbitServerTarget> {
    agent_entry_node(targets, local_node_name).or_else(|| {
        eligible_nodes(targets)
            .filter(|node| matches_local_node(node, local_node_name))
            .min_by_key(|node| deterministic_node_order(node, local_node_name))
    })
}

/// The agent entry point among registered host Nodes: the Node the Gateway marks
/// `is_primary_agent`, else the only Node with the `"agent"` role. `None` when no Node is primary
/// and zero or several Nodes carry the role. `local_node_name` only breaks ties.
fn agent_entry_node<'a>(
    targets: &'a [OrbitServerTarget],
    local_node_name: Option<&str>,
) -> Option<&'a OrbitServerTarget> {
    if let Some(primary) = eligible_nodes(targets)
        .filter(|node| node.is_primary_agent())
        .min_by_key(|node| deterministic_node_order(node, local_node_name))
    {
        return Some(primary);
    }
    let mut agents = eligible_nodes(targets).filter(|node| node.has_agent_role());
    match (agents.next(), agents.next()) {
        (Some(only), None) => Some(only),
        _ => None,
    }
}

fn eligible_nodes(targets: &[OrbitServerTarget]) -> impl Iterator<Item = &OrbitServerTarget> {
    targets.iter().filter(|target| {
        target.is_node()
            && !target.cleanup_pending
            && target.status == OrbitTargetStatus::Registered
    })
}

/// One-time pairing link minted by Orbit Gateway for a Node or Instance.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OrbitPairingTicket {
    pub server_id: String,
    pub pairing_url: String,
    pub expires_at: String,
}

impl OrbitPairingTicket {
    /// Extracts the `#token=<code>` pairing code from `pairing_url`.
    #[must_use]
    pub fn pairing_code(&self) -> Option<String> {
        let parsed = url::Url::parse(&self.pairing_url).ok()?;
        let code = parsed.fragment()?.strip_prefix("token=")?;
        if code.is_empty() {
            None
        } else {
            Some(code.to_owned())
        }
    }

    /// Extracts the normalized HTTP base URL (`http://host:port/`) from `pairing_url`.
    #[must_use]
    pub fn http_base_url(&self) -> Option<url::Url> {
        let mut parsed = url::Url::parse(&self.pairing_url).ok()?;
        parsed.set_path("/");
        parsed.set_query(None);
        parsed.set_fragment(None);
        Some(parsed)
    }
}

/// Outcome of checking whether a cached bearer token is still accepted by a `conn-server`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum BearerCheckOutcome {
    /// The server accepted the bearer token (or does not expose `/api/auth/session`).
    Valid,
    /// The server explicitly rejected the bearer token (401/403 or `authenticated: false`).
    Rejected,
    /// The server could not be reached or answered 5xx; keep the cached token for retry.
    Unreachable,
}

/// Resolved connection plan for an Orbit `conn-server` target (steps 2–4 of the Orbit flow).
#[derive(Clone, PartialEq, Eq)]
pub enum EnvironmentConnectPlan {
    /// Reuse the caller's cached bearer token against `server_url`.
    ReuseBearer { server_url: String, bearer: String },
    /// Exchange a freshly minted single-use pairing code against `server_url`.
    PairWithCode {
        server_url: String,
        pairing_code: String,
        expires_at: String,
    },
}

impl std::fmt::Debug for EnvironmentConnectPlan {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ReuseBearer { server_url, .. } => f
                .debug_struct("ReuseBearer")
                .field("server_url", server_url)
                .field("bearer", &"<redacted>")
                .finish(),
            Self::PairWithCode {
                server_url,
                expires_at,
                ..
            } => f
                .debug_struct("PairWithCode")
                .field("server_url", server_url)
                .field("pairing_code", &"<redacted>")
                .field("expires_at", expires_at)
                .finish(),
        }
    }
}

/// Probes `GET {server_url}/api/auth/session` with `Authorization: Bearer {bearer}` to distinguish
/// a revoked/expired cached bearer from a valid session or transient network failure.
pub async fn check_bearer_session(server_url: &str, bearer: &str) -> BearerCheckOutcome {
    let Ok(base) = url::Url::parse(server_url.trim()) else {
        return BearerCheckOutcome::Unreachable;
    };
    let Ok(session_url) = base.join("api/auth/session") else {
        return BearerCheckOutcome::Unreachable;
    };
    let Ok(client) = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none())
        .build()
    else {
        return BearerCheckOutcome::Unreachable;
    };
    let Ok(response) = client
        .get(session_url)
        .header(reqwest::header::ACCEPT, "application/json")
        .bearer_auth(bearer)
        .send()
        .await
    else {
        return BearerCheckOutcome::Unreachable;
    };
    let status = response.status().as_u16();
    if status == 401 || status == 403 {
        return BearerCheckOutcome::Rejected;
    }
    if (200..300).contains(&status) {
        if let Ok(body) = response.text().await
            && let Ok(parsed) = serde_json::from_str::<Value>(&body)
            && parsed.get("authenticated").and_then(Value::as_bool) == Some(false)
        {
            return BearerCheckOutcome::Rejected;
        }
        return BearerCheckOutcome::Valid;
    }
    if status == 404 {
        return BearerCheckOutcome::Valid;
    }
    BearerCheckOutcome::Unreachable
}

/// Client for Orbit Node & Instance discovery, pairing, and waking.
#[derive(Clone)]
pub struct OrbitFleetClient {
    transport: Arc<dyn GatewayTransport>,
}

impl std::fmt::Debug for OrbitFleetClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OrbitFleetClient").finish_non_exhaustive()
    }
}

impl OrbitFleetClient {
    /// Builds a fleet client backed by the live macOS `OrbitGateway`.
    pub fn live() -> Result<Self, super::gateway::GatewayError> {
        Ok(Self::new(Arc::new(OrbitGateway::new()?)))
    }

    /// Builds a fleet client backed by an arbitrary [`GatewayTransport`] (live or mock).
    #[must_use]
    pub fn new(transport: Arc<dyn GatewayTransport>) -> Self {
        Self { transport }
    }

    /// Lists all Orbit Nodes and Instances registered on the Gateway.
    pub async fn list_fleet(&self, local_node_name: Option<&str>) -> ProfileResult<OrbitFleet> {
        let data = self.call(GatewayRequest::get("/environments")).await?;
        let arr = data.as_array().ok_or_else(|| invalid("/environments"))?;
        let mut targets = Vec::with_capacity(arr.len());
        for row in arr {
            if let Some(target) = decode_target(row) {
                targets.push(target);
            }
        }
        Ok(OrbitFleet::from_targets(targets, local_node_name))
    }

    /// Mints a single-use pairing URL (`POST /api/v1/conn/environments/{server_id}/pairings`)
    /// for connecting to a Node or Instance without manual tokens.
    ///
    /// Supports both synchronous pairing responses (`{ pairing, pairing_url }`) and Orbit
    /// Gateway's async operation responses (`202 Accepted` with `{ id, status, target_id }`,
    /// polled via `GET /api/v1/operations/{id}` followed by
    /// `GET /api/v1/conn/environments/{server_id}/pairings/{pairing_id}`).
    pub async fn mint_pairing(&self, server_id: &str) -> ProfileResult<OrbitPairingTicket> {
        let path = format!("/environments/{server_id}/pairings");
        let data = self.call(GatewayRequest::post(&path)).await?;
        if let Some(ticket) = decode_pairing_ticket(&data, server_id) {
            return Ok(ticket);
        }

        // Async Gateway operation (`conn.pairing_create`): poll `/api/v1/operations/{id}` until
        // it succeeds, then fetch the issued pairing URL.
        let op_id = data
            .get("id")
            .and_then(Value::as_i64)
            .ok_or_else(|| invalid(&path))?;
        let mut op = data;
        let op_path = format!("/operations/{op_id}");
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);

        loop {
            let status = op.get("status").and_then(Value::as_str).unwrap_or_default();
            match status {
                "succeeded" => break,
                "failed" | "cancelled" | "timed_out" => {
                    let message = op
                        .get("error")
                        .and_then(|e| {
                            e.as_str()
                                .or_else(|| e.get("message").and_then(Value::as_str))
                        })
                        .or_else(|| op.get("error_code").and_then(Value::as_str))
                        .unwrap_or("Orbit pairing operation failed.")
                        .to_owned();
                    return Err(ProfileError::Gateway {
                        code: format!("orbit.pairing_{status}"),
                        message,
                        status: 500,
                    });
                }
                _ => {}
            }

            if tokio::time::Instant::now() >= deadline {
                return Err(ProfileError::Gateway {
                    code: "orbit.pairing_timeout".to_owned(),
                    message: "Timed out waiting for Orbit Gateway to mint a pairing link."
                        .to_owned(),
                    status: 504,
                });
            }

            let wait_secs = op
                .get("poll_after_seconds")
                .and_then(Value::as_u64)
                .unwrap_or(1)
                .clamp(1, 2);
            tokio::time::sleep(std::time::Duration::from_millis(wait_secs * 500)).await;
            op = self.call(GatewayRequest::get(&op_path).at_root()).await?;
        }

        let pairing_id = op
            .get("result")
            .and_then(|r| r.get("pairing_id"))
            .and_then(Value::as_i64)
            .or_else(|| op.get("target_id").and_then(Value::as_i64))
            .ok_or_else(|| invalid(&op_path))?;

        let fetch_path = format!("/environments/{server_id}/pairings/{pairing_id}");
        let fetched = self.call(GatewayRequest::get(&fetch_path)).await?;
        decode_pairing_ticket(&fetched, server_id).ok_or_else(|| invalid(&fetch_path))
    }

    /// Requests Orbit to wake a stopped Instance (`POST /api/v1/instances/{id}/wake`).
    /// Returns the Gateway operation id when provided.
    pub async fn wake_instance(&self, instance_id: i64) -> ProfileResult<Option<i64>> {
        let path = format!("/instances/{instance_id}/wake");
        let data = self.call(GatewayRequest::post(&path).at_root()).await?;
        let op_id = data
            .get("operation_id")
            .or_else(|| data.get("id"))
            .and_then(Value::as_i64);
        Ok(op_id)
    }

    /// Requests Orbit to wake a stopped Instance and polls `GET /api/v1/operations/{id}` until
    /// the wake operation finishes (mirroring `packages/client-runtime/src/orbitGateway/instanceWake.ts`).
    pub async fn wake_and_wait_instance(&self, instance_id: i64) -> ProfileResult<()> {
        let Some(op_id) = self.wake_instance(instance_id).await? else {
            return Ok(());
        };
        let op_path = format!("/operations/{op_id}");
        let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
        loop {
            let op = self.call(GatewayRequest::get(&op_path).at_root()).await?;
            let status = op.get("status").and_then(Value::as_str).unwrap_or_default();
            match status {
                "succeeded" => return Ok(()),
                "failed" | "cancelled" | "interrupted" | "timed_out" => {
                    let code = op
                        .get("error_code")
                        .and_then(Value::as_str)
                        .unwrap_or("instance.wake_failed")
                        .to_owned();
                    let message = op
                        .get("error")
                        .and_then(|e| {
                            e.as_str()
                                .or_else(|| e.get("message").and_then(Value::as_str))
                        })
                        .unwrap_or("Orbit could not wake the instance.")
                        .to_owned();
                    return Err(ProfileError::Gateway {
                        code,
                        message,
                        status: 500,
                    });
                }
                _ => {}
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(ProfileError::Gateway {
                    code: "operation.timeout".to_owned(),
                    message: "Timed out waiting for Orbit instance to wake.".to_owned(),
                    status: 504,
                });
            }
            let wait_secs = op
                .get("poll_after_seconds")
                .and_then(Value::as_u64)
                .unwrap_or(1)
                .clamp(1, 2);
            tokio::time::sleep(Duration::from_millis(wait_secs * 500)).await;
        }
    }

    /// Resolves how to connect to `server_id` (steps 2–4 of the Orbit connect flow):
    /// - Looks up `server_id` in the Gateway's fleet.
    /// - When a non-empty `cached_bearer` is supplied, invokes `verify_bearer(url, bearer)`:
    ///   reuses it on [`BearerCheckOutcome::Valid`] or [`BearerCheckOutcome::Unreachable`], and
    ///   falls back to minting a fresh pairing **once** on [`BearerCheckOutcome::Rejected`].
    /// - When no cached bearer is supplied, mints a pairing directly via [`Self::mint_pairing`].
    pub async fn resolve_environment_connect<F, Fut>(
        &self,
        server_id: &str,
        cached_bearer: Option<&str>,
        verify_bearer: F,
    ) -> ProfileResult<EnvironmentConnectPlan>
    where
        F: FnOnce(String, String) -> Fut,
        Fut: Future<Output = BearerCheckOutcome>,
    {
        let fleet = self.list_fleet(None).await?;
        let target = fleet
            .find_by_server_id(server_id)
            .ok_or_else(|| ProfileError::Gateway {
                code: "http.404".to_owned(),
                message: format!("Orbit environment `{server_id}` was not found."),
                status: 404,
            })?;
        let target_url = target.url.clone();

        if let Some(bearer) = cached_bearer.map(str::trim).filter(|s| !s.is_empty()) {
            match verify_bearer(target_url.clone(), bearer.to_owned()).await {
                BearerCheckOutcome::Valid | BearerCheckOutcome::Unreachable => {
                    return Ok(EnvironmentConnectPlan::ReuseBearer {
                        server_url: target_url,
                        bearer: bearer.to_owned(),
                    });
                }
                BearerCheckOutcome::Rejected => {}
            }
        }

        let ticket = self.mint_pairing(server_id).await?;
        let pairing_code = ticket
            .pairing_code()
            .ok_or_else(|| invalid(&format!("/environments/{server_id}/pairings")))?;
        let server_url = ticket
            .http_base_url()
            .map(|u| u.to_string())
            .unwrap_or(target_url);
        Ok(EnvironmentConnectPlan::PairWithCode {
            server_url,
            pairing_code,
            expires_at: ticket.expires_at,
        })
    }

    async fn call(&self, request: GatewayRequest) -> ProfileResult<Value> {
        let path = request.path.clone();
        let response = self
            .transport
            .send(request)
            .await
            .map_err(|err| ProfileError::Unreachable(err.to_string()))?;

        let parsed: Option<Value> = serde_json::from_str(&response.body).ok();
        if !(200..300).contains(&response.status) {
            let err_obj = parsed
                .as_ref()
                .and_then(Value::as_object)
                .and_then(|o| o.get("error"))
                .and_then(Value::as_object);
            let code = err_obj
                .and_then(|e| e.get("code"))
                .and_then(Value::as_str)
                .unwrap_or("gateway.request_failed")
                .to_owned();
            let message = err_obj
                .and_then(|e| e.get("message"))
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
                .unwrap_or_else(|| format!("The Orbit Gateway answered {}.", response.status));
            return Err(ProfileError::Gateway {
                code,
                message,
                status: response.status,
            });
        }
        let envelope = parsed
            .as_ref()
            .and_then(Value::as_object)
            .ok_or_else(|| invalid(&path))?;
        envelope.get("data").cloned().ok_or_else(|| invalid(&path))
    }
}

fn invalid(path: &str) -> ProfileError {
    ProfileError::InvalidResponse {
        path: path.to_owned(),
    }
}

fn decode_pairing_ticket(data: &Value, fallback_server_id: &str) -> Option<OrbitPairingTicket> {
    let obj = data.as_object()?;
    let pairing_url = obj.get("pairing_url").and_then(Value::as_str)?.to_owned();
    let pairing = obj.get("pairing").and_then(Value::as_object)?;
    let resolved_id = pairing
        .get("environment_id")
        .and_then(Value::as_str)
        .unwrap_or(fallback_server_id)
        .to_owned();
    let expires_at = pairing
        .get("expires_at")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    Some(OrbitPairingTicket {
        server_id: resolved_id,
        pairing_url,
        expires_at,
    })
}

fn decode_target(value: &Value) -> Option<OrbitServerTarget> {
    let obj = value.as_object()?;
    let server_id = obj.get("environment_id")?.as_str()?.trim().to_owned();
    let label = obj.get("label")?.as_str()?.trim().to_owned();
    let url = obj.get("url")?.as_str()?.trim().to_owned();
    if server_id.is_empty() || url.is_empty() {
        return None;
    }
    let server_version = obj
        .get("server_version")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    let registered_by = obj
        .get("registered_by")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    let status = match obj.get("status").and_then(Value::as_str) {
        Some("session_expired") => OrbitTargetStatus::SessionExpired,
        _ => OrbitTargetStatus::Registered,
    };
    let cleanup_pending = obj
        .get("cleanup_pending")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let kind = match obj.get("instance_id").and_then(Value::as_i64) {
        Some(instance_id) => {
            let instance_name = obj
                .get("instance_name")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
                .unwrap_or_else(|| label.clone());
            let power_state = match obj.get("power_state").and_then(Value::as_str) {
                Some("running") => Some(PowerState::Running),
                Some("stopped") => Some(PowerState::Stopped),
                _ => None,
            };
            OrbitTargetKind::Instance {
                instance_id,
                instance_name,
                project_id: obj.get("project_id").and_then(Value::as_i64),
                project_name: obj
                    .get("project_name")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned),
                project_slug: obj
                    .get("project_slug")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned),
                node_name: obj
                    .get("node_name")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned),
                instance_url: obj
                    .get("instance_url")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned),
                power_state,
            }
        }
        None => OrbitTargetKind::Node {
            node_name: obj
                .get("node_name")
                .and_then(Value::as_str)
                .or(registered_by.as_deref())
                .unwrap_or(&label)
                .to_owned(),
            roles: decode_roles(obj),
            is_primary_agent: obj
                .get("is_primary_agent")
                .or_else(|| obj.get("node").and_then(|n| n.get("primary_agent")))
                .and_then(Value::as_bool)
                .unwrap_or(false),
        },
    };

    Some(OrbitServerTarget {
        server_id,
        label,
        url,
        server_version,
        registered_by,
        status,
        cleanup_pending,
        kind,
    })
}

fn decode_roles(obj: &serde_json::Map<String, Value>) -> Vec<String> {
    let raw = obj
        .get("roles")
        .or_else(|| obj.get("node_roles"))
        .or_else(|| obj.get("node").and_then(|n| n.get("roles")));
    let Some(value) = raw else {
        return Vec::new();
    };
    let mut roles = Vec::new();
    match value {
        Value::Array(items) => {
            for item in items {
                let role = item.as_str().or_else(|| {
                    item.as_object().and_then(|map| {
                        map.get("name")
                            .or_else(|| map.get("slug"))
                            .or_else(|| map.get("role"))
                            .and_then(Value::as_str)
                    })
                });
                if let Some(trimmed) = role.map(str::trim).filter(|s| !s.is_empty())
                    && !roles
                        .iter()
                        .any(|r: &String| r.eq_ignore_ascii_case(trimmed))
                {
                    roles.push(trimmed.to_owned());
                }
            }
        }
        Value::String(s) => {
            for part in s.split(',') {
                let trimmed = part.trim();
                if !trimmed.is_empty()
                    && !roles
                        .iter()
                        .any(|r: &String| r.eq_ignore_ascii_case(trimmed))
                {
                    roles.push(trimmed.to_owned());
                }
            }
        }
        _ => {}
    }
    roles
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;
    use crate::gateway::{BoxFuture, GatewayError, GatewayResponse};

    struct MockGateway {
        handler:
            Mutex<Box<dyn FnMut(GatewayRequest) -> Result<GatewayResponse, GatewayError> + Send>>,
    }

    impl MockGateway {
        fn new(
            f: impl FnMut(GatewayRequest) -> Result<GatewayResponse, GatewayError> + Send + 'static,
        ) -> Arc<Self> {
            Arc::new(Self {
                handler: Mutex::new(Box::new(f)),
            })
        }
    }

    impl GatewayTransport for MockGateway {
        fn send(
            &self,
            request: GatewayRequest,
        ) -> BoxFuture<'_, Result<GatewayResponse, GatewayError>> {
            let res = (self.handler.lock().unwrap_or_else(|e| e.into_inner()))(request);
            Box::pin(async move { res })
        }
    }

    #[tokio::test]
    async fn lists_and_splits_nodes_and_instances_with_deterministic_sorting() {
        let payload = serde_json::json!({
            "data": [
                {
                    "environment_id": "node-beast",
                    "label": "beast",
                    "url": "http://10.44.0.7:3773",
                    "server_version": "0.1.7",
                    "registered_by": "beast",
                    "status": "registered",
                    "cleanup_pending": false,
                    "instance_id": null
                },
                {
                    "environment_id": "node-nick",
                    "label": "nick",
                    "url": "http://10.44.0.6:3773",
                    "server_version": "0.1.7",
                    "registered_by": "nick",
                    "status": "registered",
                    "cleanup_pending": false,
                    "instance_id": null
                },
                {
                    "environment_id": "inst-stopped",
                    "label": "dlf / bookmark",
                    "url": "http://10.44.0.7:3967",
                    "registered_by": "beast",
                    "status": "registered",
                    "cleanup_pending": false,
                    "instance_id": 100,
                    "project_id": 10,
                    "project_name": "DLF",
                    "project_slug": "dlf",
                    "instance_name": "bookmark",
                    "node_name": "beast",
                    "instance_url": "https://bookmark.dlf.test",
                    "power_state": "stopped"
                },
                {
                    "environment_id": "inst-running",
                    "label": "hauzer / ps-server",
                    "url": "http://10.44.0.7:3817",
                    "registered_by": "beast",
                    "status": "registered",
                    "cleanup_pending": false,
                    "instance_id": 200,
                    "project_id": 20,
                    "project_name": "Hauzer",
                    "project_slug": "hauzer",
                    "instance_name": "ps-server",
                    "node_name": "beast",
                    "instance_url": "https://ps-server.hauzer.test",
                    "power_state": "running"
                },
                {
                    "environment_id": "inst-cleaning",
                    "label": "old / cleanup",
                    "url": "http://10.44.0.7:3999",
                    "status": "registered",
                    "cleanup_pending": true,
                    "instance_id": 300
                }
            ]
        })
        .to_string();

        let transport = MockGateway::new(move |req| {
            assert_eq!(req.path, "/environments");
            Ok(GatewayResponse {
                status: 200,
                body: payload.clone(),
            })
        });
        let client = OrbitFleetClient::new(transport);
        let fleet = client.list_fleet(Some("nick")).await.expect("list_fleet");

        assert_eq!(fleet.nodes.len(), 2);
        // Local node ("nick") sorts first.
        assert_eq!(fleet.nodes[0].label, "nick");
        assert!(fleet.nodes[0].is_node());
        assert_eq!(fleet.nodes[1].label, "beast");

        // Cleanup-pending instance is filtered out; running sorts before stopped.
        assert_eq!(fleet.instances.len(), 2);
        assert_eq!(fleet.instances[0].server_id, "inst-running");
        assert!(fleet.instances[0].is_instance());
        assert!(fleet.instances[0].is_awake());
        assert_eq!(fleet.instances[0].display_title(), "Hauzer / ps-server");
        assert_eq!(fleet.instances[1].server_id, "inst-stopped");
        assert!(!fleet.instances[1].is_awake());
        assert_eq!(fleet.running_instance_count(), 1);
    }

    #[tokio::test]
    async fn mints_pairing_ticket_and_extracts_code_and_base_url() {
        let transport = MockGateway::new(|req| {
            assert_eq!(req.path, "/environments/node-beast/pairings");
            Ok(GatewayResponse {
                status: 200,
                body: serde_json::json!({
                    "data": {
                        "pairing_url": "http://10.44.0.7:3773/pair#token=abc123xyz",
                        "pairing": {
                            "environment_id": "node-beast",
                            "expires_at": "2026-11-21T20:00:00Z"
                        }
                    }
                })
                .to_string(),
            })
        });
        let client = OrbitFleetClient::new(transport);
        let ticket = client.mint_pairing("node-beast").await.expect("pairing");
        assert_eq!(ticket.pairing_code().as_deref(), Some("abc123xyz"));
        assert_eq!(
            ticket.http_base_url().map(|u| u.to_string()).as_deref(),
            Some("http://10.44.0.7:3773/")
        );
    }

    #[tokio::test]
    async fn mints_pairing_ticket_via_async_operation_poll() {
        let poll_count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let poll_count_ref = std::sync::Arc::clone(&poll_count);
        let transport = MockGateway::new(move |req| match (req.root, req.path.as_str()) {
            (false, "/environments/node-nick/pairings") => Ok(GatewayResponse {
                status: 202,
                body: serde_json::json!({
                    "data": {
                        "id": 32452,
                        "kind": "conn.pairing_create",
                        "target_id": 3508,
                        "status": "queued",
                        "poll_after_seconds": 1
                    }
                })
                .to_string(),
            }),
            (true, "/operations/32452") => {
                poll_count_ref.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Ok(GatewayResponse {
                    status: 200,
                    body: serde_json::json!({
                        "data": {
                            "id": 32452,
                            "status": "succeeded",
                            "target_id": 3508,
                            "result": { "pairing_id": 3508 }
                        }
                    })
                    .to_string(),
                })
            }
            (false, "/environments/node-nick/pairings/3508") => Ok(GatewayResponse {
                status: 200,
                body: serde_json::json!({
                    "data": {
                        "pairing_url": "http://10.44.0.6:3773/pair#token=ASYNC999",
                        "pairing": {
                            "id": 3508,
                            "environment_id": "node-nick",
                            "expires_at": "2026-11-22T08:25:18+00:00"
                        }
                    }
                })
                .to_string(),
            }),
            other => panic!("unexpected request: {other:?}"),
        });
        let client = OrbitFleetClient::new(transport);
        let ticket = client
            .mint_pairing("node-nick")
            .await
            .expect("async pairing");
        assert_eq!(poll_count.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert_eq!(ticket.pairing_code().as_deref(), Some("ASYNC999"));
        assert_eq!(
            ticket.http_base_url().map(|u| u.to_string()).as_deref(),
            Some("http://10.44.0.6:3773/")
        );
    }

    #[tokio::test]
    async fn wakes_instance_via_root_api_route() {
        let transport = MockGateway::new(|req| {
            assert!(req.root);
            assert_eq!(req.path, "/instances/2639/wake");
            Ok(GatewayResponse {
                status: 200,
                body: serde_json::json!({ "data": { "operation_id": 991 } }).to_string(),
            })
        });
        let client = OrbitFleetClient::new(transport);
        let op = client.wake_instance(2639).await.expect("wake");
        assert_eq!(op, Some(991));
    }

    #[tokio::test]
    async fn decodes_agent_roles_and_resolves_primary_agent_node() {
        let payload = serde_json::json!({
            "data": [
                {
                    "environment_id": "node-nick",
                    "label": "nick",
                    "url": "http://10.44.0.6:3773",
                    "registered_by": "nick",
                    "status": "registered",
                    "cleanup_pending": false,
                    "instance_id": null
                },
                {
                    "environment_id": "node-beast",
                    "label": "beast",
                    "url": "http://10.44.0.7:3773",
                    "registered_by": "beast",
                    "status": "registered",
                    "cleanup_pending": false,
                    "instance_id": null,
                    "node": { "roles": ["router", "agent"] }
                },
                {
                    "environment_id": "node-mini",
                    "label": "mini",
                    "url": "http://10.44.0.8:3773",
                    "registered_by": "mini",
                    "status": "registered",
                    "cleanup_pending": false,
                    "instance_id": null,
                    "roles": ["agent", "Agent", "  "],
                    "is_primary_agent": true
                }
            ]
        })
        .to_string();

        let transport = MockGateway::new(move |_| {
            Ok(GatewayResponse {
                status: 200,
                body: payload.clone(),
            })
        });
        let client = OrbitFleetClient::new(transport);
        let fleet = client.list_fleet(Some("nick")).await.expect("list_fleet");

        assert_eq!(fleet.nodes.len(), 3);
        let nick = fleet.find_by_server_id("node-nick").expect("nick");
        let beast = fleet.find_by_server_id("node-beast").expect("beast");
        let mini = fleet.find_by_server_id("node-mini").expect("mini");

        assert!(!nick.has_agent_role());
        assert!(nick.roles().is_empty());
        assert!(!nick.is_primary_agent());
        assert!(!beast.is_primary_agent());
        assert!(mini.is_primary_agent());

        assert!(beast.has_agent_role());
        assert_eq!(beast.roles(), ["router", "agent"]);

        assert!(mini.has_agent_role());
        assert_eq!(mini.roles(), ["agent"]);

        let agent_ids: Vec<&str> = fleet
            .agent_nodes()
            .into_iter()
            .map(|n| n.server_id.as_str())
            .collect();
        assert_eq!(agent_ids, vec!["node-beast", "node-mini"]);

        // 1. The Gateway's `is_primary_agent` wins over the alphabetical agent order.
        assert_eq!(
            fleet.primary_agent_node().map(|n| n.server_id.as_str()),
            Some("node-mini")
        );

        // 2. Several agent nodes and none primary: no guess, the local node.
        let mut plain_mini = mini.clone();
        plain_mini.kind = OrbitTargetKind::Node {
            node_name: "mini".to_owned(),
            roles: vec!["agent".to_owned()],
            is_primary_agent: false,
        };
        let no_primary =
            OrbitFleet::from_targets(vec![nick.clone(), beast.clone(), plain_mini], Some("nick"));
        assert_eq!(
            no_primary
                .primary_agent_node()
                .map(|n| n.server_id.as_str()),
            Some("node-nick")
        );

        // 3. Exactly one agent node and none primary: that node.
        let without_primary =
            OrbitFleet::from_targets(vec![nick.clone(), beast.clone()], Some("nick"));
        assert_eq!(
            without_primary
                .primary_agent_node()
                .map(|n| n.server_id.as_str()),
            Some("node-beast")
        );

        // 4. Without any agent-role node, falls back to the local node (sorted first).
        let mut plain_beast = beast.clone();
        plain_beast.kind = OrbitTargetKind::Node {
            node_name: "beast".to_owned(),
            roles: Vec::new(),
            is_primary_agent: false,
        };
        let without_agents =
            OrbitFleet::from_targets(vec![plain_beast, nick.clone()], Some("nick"));
        assert!(without_agents.agent_nodes().is_empty());
        assert_eq!(
            without_agents
                .primary_agent_node()
                .map(|n| n.server_id.as_str()),
            Some("node-nick")
        );

        // 5. Empty fleet returns None.
        assert_eq!(OrbitFleet::default().primary_agent_node(), None);
    }

    #[test]
    fn deserializes_legacy_orbit_targets_without_agent_fields() {
        let legacy_target_json = serde_json::json!({
            "server_id": "node-nick",
            "label": "nick",
            "url": "http://10.44.0.6:3773",
            "server_version": "0.1.7",
            "registered_by": "nick",
            "status": "registered",
            "cleanup_pending": false,
            "kind": {
                "kind": "node",
                "node_name": "nick"
            }
        })
        .to_string();
        let target: OrbitServerTarget =
            serde_json::from_str(&legacy_target_json).expect("legacy OrbitServerTarget");
        assert!(target.is_node());
        assert!(target.roles().is_empty());
        assert!(!target.has_agent_role());
    }

    fn make_node(
        server_id: &str,
        label: &str,
        node_name: &str,
        roles: &[&str],
        status: OrbitTargetStatus,
        cleanup_pending: bool,
    ) -> OrbitServerTarget {
        OrbitServerTarget {
            server_id: server_id.to_owned(),
            label: label.to_owned(),
            url: format!("http://10.44.0.10:3773/{server_id}"),
            server_version: Some("0.1.7".to_owned()),
            registered_by: Some(node_name.to_owned()),
            status,
            cleanup_pending,
            kind: OrbitTargetKind::Node {
                node_name: node_name.to_owned(),
                roles: roles.iter().map(|r| (*r).to_owned()).collect(),
                is_primary_agent: false,
            },
        }
    }

    fn as_primary(mut node: OrbitServerTarget) -> OrbitServerTarget {
        if let OrbitTargetKind::Node {
            is_primary_agent, ..
        } = &mut node.kind
        {
            *is_primary_agent = true;
        }
        node
    }

    fn make_instance(server_id: &str, label: &str, instance_id: i64) -> OrbitServerTarget {
        OrbitServerTarget {
            server_id: server_id.to_owned(),
            label: label.to_owned(),
            url: format!("http://10.44.0.10:3800/{server_id}"),
            server_version: Some("0.1.7".to_owned()),
            registered_by: Some("beast".to_owned()),
            status: OrbitTargetStatus::Registered,
            cleanup_pending: false,
            kind: OrbitTargetKind::Instance {
                instance_id,
                instance_name: label.to_owned(),
                project_id: Some(1),
                project_name: Some("Orbit".to_owned()),
                project_slug: Some("orbit".to_owned()),
                node_name: Some("beast".to_owned()),
                instance_url: None,
                power_state: Some(PowerState::Running),
            },
        }
    }

    #[test]
    fn select_primary_agent_node_prefers_primary_then_sole_agent_then_local() {
        let nick = make_node(
            "node-nick",
            "nick",
            "nick",
            &[],
            OrbitTargetStatus::Registered,
            false,
        );
        let beast_agent = make_node(
            "node-beast",
            "beast",
            "beast",
            &["router", "agent"],
            OrbitTargetStatus::Registered,
            false,
        );
        let mini_agent = make_node(
            "node-mini",
            "mini",
            "mini",
            &["agent"],
            OrbitTargetStatus::Registered,
            false,
        );
        let instance = make_instance("inst-1", "orbit / main", 42);

        // 1. The Gateway's primary agent wins over the local node and the alphabetical order.
        let targets = vec![
            instance.clone(),
            nick.clone(),
            beast_agent.clone(),
            as_primary(mini_agent.clone()),
        ];
        assert_eq!(
            select_primary_agent_node(&targets, Some("nick")).map(|n| n.server_id.as_str()),
            Some("node-mini"),
            "is_primary_agent wins over the local node and the other agent node"
        );
        assert_eq!(
            select_primary_agent_node(&targets, None).map(|n| n.server_id.as_str()),
            Some("node-mini"),
            "iOS caller (no local_node_name) picks the primary agent node"
        );

        // 2. No primary and exactly one agent-role node: that node.
        let one_agent = vec![instance.clone(), nick.clone(), beast_agent.clone()];
        assert_eq!(
            select_primary_agent_node(&one_agent, Some("nick")).map(|n| n.server_id.as_str()),
            Some("node-beast"),
            "the only agent-role node wins over the local node"
        );

        // No primary and several agent-role nodes: no guess, only the local fallback.
        let two_agents = vec![beast_agent, mini_agent, nick.clone()];
        assert_eq!(
            select_primary_agent_node(&two_agents, Some("nick")).map(|n| n.server_id.as_str()),
            Some("node-nick"),
            "several agent nodes without a primary fall back to the local node"
        );
        assert_eq!(
            select_primary_agent_node(&two_agents, None),
            None,
            "several agent nodes without a primary and no local node: None"
        );

        // 3. No `"agent"`-role node: desktop falls back to local registered node; iOS gets None.
        let no_agents = vec![
            instance,
            make_node(
                "node-beast",
                "beast",
                "beast",
                &["router"],
                OrbitTargetStatus::Registered,
                false,
            ),
            nick,
        ];
        assert_eq!(
            select_primary_agent_node(&no_agents, Some("NICK")).map(|n| n.server_id.as_str()),
            Some("node-nick"),
            "desktop falls back to matching local node case-insensitively"
        );
        assert_eq!(
            select_primary_agent_node(&no_agents, Some("iphone")),
            None,
            "iOS node name not hosting conn-server returns None when no agent-role node exists"
        );
        assert_eq!(
            select_primary_agent_node(&no_agents, None),
            None,
            "unset local_node_name returns None when no agent-role node exists"
        );
        assert_eq!(
            select_primary_agent_node(&no_agents, Some("   ")),
            None,
            "whitespace-only local_node_name is treated as unset"
        );
        assert_eq!(
            select_primary_agent_node(&[], Some("nick")),
            None,
            "empty target list returns None"
        );
    }

    #[test]
    fn select_primary_agent_node_skips_expired_cleanup_and_instances() {
        let expired_agent = make_node(
            "node-mini",
            "mini",
            "mini",
            &["agent"],
            OrbitTargetStatus::SessionExpired,
            false,
        );
        let cleaning_agent = make_node(
            "node-old",
            "old",
            "old",
            &["agent"],
            OrbitTargetStatus::Registered,
            true,
        );
        let healthy_agent = make_node(
            "node-beast",
            "beast",
            "beast",
            &["agent"],
            OrbitTargetStatus::Registered,
            false,
        );
        let instance = make_instance("inst-99", "orbit / task", 99);

        let targets = vec![
            expired_agent.clone(),
            cleaning_agent.clone(),
            instance.clone(),
            healthy_agent.clone(),
        ];
        assert_eq!(
            select_primary_agent_node(&targets, None).map(|n| n.server_id.as_str()),
            Some("node-beast"),
            "expired and cleanup_pending agent nodes are skipped"
        );

        let only_unusable = vec![expired_agent, cleaning_agent, instance];
        assert_eq!(
            select_primary_agent_node(&only_unusable, Some("mini")),
            None,
            "expired local node is not selected"
        );

        let other_agent = make_node(
            "node-zed",
            "zed",
            "zed",
            &["agent"],
            OrbitTargetStatus::Registered,
            false,
        );
        let remote_agents =
            OrbitFleet::from_targets(vec![healthy_agent.clone(), other_agent], Some("nick"));
        assert_eq!(
            remote_agents.primary_agent_node(),
            None,
            "two unmarked remote agent nodes and no local node: no guess"
        );
        assert_eq!(
            select_primary_agent_node(&remote_agents.nodes, Some("nick")),
            None,
            "the standalone selector agrees"
        );

        let fleet = OrbitFleet::from_targets(vec![healthy_agent], Some("nick"));
        assert_eq!(
            fleet
                .select_primary_agent_node(Some("nick"))
                .map(|n| n.server_id.as_str()),
            Some("node-beast"),
            "OrbitFleet::select_primary_agent_node delegates consistently"
        );
    }

    #[tokio::test]
    async fn resolve_environment_connect_reuses_valid_bearer_and_mints_on_none_or_rejection() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let mint_calls = Arc::new(AtomicUsize::new(0));
        let mint_calls_ref = Arc::clone(&mint_calls);
        let transport = MockGateway::new(move |req| match req.path.as_str() {
            "/environments" => Ok(GatewayResponse {
                status: 200,
                body: serde_json::json!({
                    "data": [{
                        "environment_id": "node-mini",
                        "label": "mini",
                        "url": "http://10.44.0.8:3773",
                        "status": "registered",
                        "cleanup_pending": false,
                        "instance_id": null,
                        "roles": ["agent"]
                    }]
                })
                .to_string(),
            }),
            "/environments/node-mini/pairings" => {
                mint_calls_ref.fetch_add(1, Ordering::SeqCst);
                Ok(GatewayResponse {
                    status: 200,
                    body: serde_json::json!({
                        "data": {
                            "pairing_url": "http://10.44.0.8:3773/pair#token=fresh-code",
                            "pairing": {
                                "environment_id": "node-mini",
                                "expires_at": "2026-11-22T20:00:00Z"
                            }
                        }
                    })
                    .to_string(),
                })
            }
            other => panic!("unexpected path: {other}"),
        });

        let client = OrbitFleetClient::new(transport);

        // 1. Valid cached bearer -> reused, zero mints.
        let plan = client
            .resolve_environment_connect("node-mini", Some("cached-tok"), |_, _| async {
                BearerCheckOutcome::Valid
            })
            .await
            .expect("reuse plan");
        assert_eq!(
            plan,
            EnvironmentConnectPlan::ReuseBearer {
                server_url: "http://10.44.0.8:3773".to_owned(),
                bearer: "cached-tok".to_owned(),
            },
            "valid cached bearer must be reused"
        );
        assert_eq!(
            mint_calls.load(Ordering::SeqCst),
            0,
            "valid cached bearer must not mint a pairing"
        );

        // 2. Unreachable probe -> keep cached bearer for ConnCore reconnect, zero mints.
        let plan = client
            .resolve_environment_connect("node-mini", Some("cached-tok"), |_, _| async {
                BearerCheckOutcome::Unreachable
            })
            .await
            .expect("unreachable plan");
        assert!(
            matches!(plan, EnvironmentConnectPlan::ReuseBearer { .. }),
            "unreachable probe should preserve cached bearer"
        );
        assert_eq!(mint_calls.load(Ordering::SeqCst), 0);

        // 3. Rejected cached bearer -> falls back to minting a pairing once.
        let plan = client
            .resolve_environment_connect("node-mini", Some("stale-tok"), |_, _| async {
                BearerCheckOutcome::Rejected
            })
            .await
            .expect("fallback mint plan");
        assert_eq!(
            plan,
            EnvironmentConnectPlan::PairWithCode {
                server_url: "http://10.44.0.8:3773/".to_owned(),
                pairing_code: "fresh-code".to_owned(),
                expires_at: "2026-11-22T20:00:00Z".to_owned(),
            },
            "rejected cached bearer must fall back to minting a pairing"
        );
        assert_eq!(
            mint_calls.load(Ordering::SeqCst),
            1,
            "rejected cached bearer must mint exactly once"
        );

        // 4. No cached bearer -> mints directly without probing.
        let probed = Arc::new(AtomicUsize::new(0));
        let probed_ref = Arc::clone(&probed);
        let plan = client
            .resolve_environment_connect("node-mini", None, move |_, _| async move {
                probed_ref.fetch_add(1, Ordering::SeqCst);
                BearerCheckOutcome::Valid
            })
            .await
            .expect("direct mint plan");
        assert!(
            matches!(plan, EnvironmentConnectPlan::PairWithCode { .. }),
            "missing bearer must mint directly"
        );
        assert_eq!(
            probed.load(Ordering::SeqCst),
            0,
            "verify_bearer must not run when cached_bearer is None"
        );
        assert_eq!(mint_calls.load(Ordering::SeqCst), 2);

        // 5. Unknown server_id -> 404 NotFound.
        let err = client
            .resolve_environment_connect("missing-env", None, |_, _| async {
                BearerCheckOutcome::Valid
            })
            .await
            .expect_err("unknown server_id must fail");
        assert_eq!(
            err.reason(),
            crate::OrbitErrorReason::NotFound,
            "unknown server_id should classify as NotFound"
        );
    }
}
