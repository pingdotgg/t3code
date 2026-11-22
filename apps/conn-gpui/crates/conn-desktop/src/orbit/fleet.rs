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

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

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
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
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

    /// True when this target is an Orbit Node designated as the primary `agent` entry point.
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

    /// True when this target is an Orbit Node carrying the `"agent"` role (or marked primary agent).
    #[must_use]
    pub fn has_agent_role(&self) -> bool {
        match &self.kind {
            OrbitTargetKind::Node {
                roles,
                is_primary_agent,
                ..
            } => *is_primary_agent || roles.iter().any(|r| r.eq_ignore_ascii_case("agent")),
            OrbitTargetKind::Instance { .. } => false,
        }
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

        Self { nodes, instances }
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

    /// All Orbit Nodes carrying the `"agent"` role (including any marked `is_primary_agent`).
    #[must_use]
    pub fn agent_nodes(&self) -> Vec<&OrbitServerTarget> {
        self.nodes
            .iter()
            .filter(|node| node.has_agent_role())
            .collect()
    }

    /// Preferred default Orbit Node entry point:
    /// 1. A registered node with `is_primary_agent == true` (falling back to any `is_primary_agent`),
    /// 2. The first registered node carrying the `"agent"` role,
    /// 3. The local node fallback (first registered node, else `nodes.first()`, since
    ///    [`Self::from_targets`] sorts the local node first).
    #[must_use]
    pub fn primary_agent_node(&self) -> Option<&OrbitServerTarget> {
        self.nodes
            .iter()
            .find(|n| n.status == OrbitTargetStatus::Registered && n.is_primary_agent())
            .or_else(|| self.nodes.iter().find(|n| n.is_primary_agent()))
            .or_else(|| {
                self.nodes
                    .iter()
                    .find(|n| n.status == OrbitTargetStatus::Registered && n.has_agent_role())
            })
            .or_else(|| {
                self.nodes
                    .iter()
                    .find(|n| n.status == OrbitTargetStatus::Registered)
            })
            .or_else(|| self.nodes.first())
    }
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
            is_primary_agent: decode_is_primary_agent(obj),
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

fn decode_is_primary_agent(obj: &serde_json::Map<String, Value>) -> bool {
    obj.get("is_primary_agent")
        .or_else(|| obj.get("primary_agent"))
        .or_else(|| {
            obj.get("node")
                .and_then(|n| n.get("is_primary_agent").or_else(|| n.get("primary_agent")))
        })
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

// ---------------------------------------------------------------------------
// Local bearer session store (isolated under conn-gpui app support)
// ---------------------------------------------------------------------------

/// Cached bearer token for one paired Orbit Node or Instance.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CachedOrbitSession {
    pub server_id: String,
    pub url: String,
    pub label: String,
    pub bearer: String,
    pub paired_at_unix: i64,
}

/// Persistent local store of auto-paired `conn-server` bearer tokens for Orbit Nodes/Instances.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct OrbitSessionStore {
    #[serde(default)]
    pub active_server_id: Option<String>,
    #[serde(default)]
    pub sessions: BTreeMap<String, CachedOrbitSession>,
}

impl OrbitSessionStore {
    /// Default path (`~/Library/Application Support/conn-gpui/orbit-sessions.json` on macOS),
    /// overridable with `CONN_GPUI_CONFIG_DIR` for isolated dev/test sessions.
    #[must_use]
    pub fn default_path() -> Option<PathBuf> {
        if let Some(dir) = std::env::var_os("CONN_GPUI_CONFIG_DIR") {
            return Some(PathBuf::from(dir).join("orbit-sessions.json"));
        }
        let home = std::env::var_os("HOME").map(PathBuf::from)?;
        #[cfg(target_os = "macos")]
        let dir = home
            .join("Library")
            .join("Application Support")
            .join("conn-gpui");
        #[cfg(not(target_os = "macos"))]
        let dir = std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".config"))
            .join("conn-gpui");
        Some(dir.join("orbit-sessions.json"))
    }

    /// Loads the store from disk, returning empty defaults if missing or unreadable.
    #[must_use]
    pub fn load_from(path: &Path) -> Self {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default()
    }

    /// Loads from the default application support path.
    #[must_use]
    pub fn load_default() -> Self {
        Self::default_path()
            .map(|p| Self::load_from(&p))
            .unwrap_or_default()
    }

    /// Saves atomically to `path` (mode `0600` on Unix since it stores bearer tokens).
    pub fn save_to(&self, path: &Path) -> std::io::Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let payload = serde_json::to_string_pretty(self)
            .map_err(|err| std::io::Error::new(std::io::ErrorKind::InvalidData, err))?;
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, payload)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
        }
        std::fs::rename(&tmp, path)
    }

    /// Saves to the default application support path.
    pub fn save_default(&self) -> std::io::Result<()> {
        let Some(path) = Self::default_path() else {
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "HOME directory not set",
            ));
        };
        self.save_to(&path)
    }

    /// Returns a cached bearer token for `server_id`, when present.
    #[must_use]
    pub fn bearer_for(&self, server_id: &str) -> Option<&str> {
        self.sessions
            .get(server_id)
            .map(|s| s.bearer.as_str())
            .filter(|t| !t.is_empty())
    }

    /// Records a newly paired bearer token for `server_id` and marks it active.
    pub fn record_bearer(
        &mut self,
        server_id: impl Into<String>,
        url: impl Into<String>,
        label: impl Into<String>,
        bearer: impl Into<String>,
    ) {
        let server_id = server_id.into();
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| i64::try_from(d.as_secs()).unwrap_or(i64::MAX));
        self.active_server_id = Some(server_id.clone());
        self.sessions.insert(
            server_id.clone(),
            CachedOrbitSession {
                server_id,
                url: url.into(),
                label: label.into(),
                bearer: bearer.into(),
                paired_at_unix: now,
            },
        );
    }

    /// Clears a cached bearer token (e.g. after a 401/Auth failure so next attempt re-pairs).
    pub fn remove_bearer(&mut self, server_id: &str) {
        self.sessions.remove(server_id);
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;
    use crate::orbit::gateway::{BoxFuture, GatewayError, GatewayResponse};

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

    #[test]
    fn session_store_roundtrips_bearer_tokens() {
        let dir =
            std::env::temp_dir().join(format!("conn-orbit-sessions-test-{}", std::process::id()));
        let path = dir.join("orbit-sessions.json");
        let mut store = OrbitSessionStore::default();
        store.record_bearer("node-beast", "http://10.44.0.7:3773", "beast", "tok-secret");
        store.save_to(&path).expect("save");

        let loaded = OrbitSessionStore::load_from(&path);
        assert_eq!(loaded.active_server_id.as_deref(), Some("node-beast"));
        assert_eq!(loaded.bearer_for("node-beast"), Some("tok-secret"));

        let _ = std::fs::remove_dir_all(&dir);
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
                    "primary_agent": true
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
        assert!(!nick.is_primary_agent());
        assert!(nick.roles().is_empty());

        assert!(beast.has_agent_role());
        assert!(!beast.is_primary_agent());
        assert_eq!(beast.roles(), ["router", "agent"]);

        assert!(mini.has_agent_role());
        assert!(mini.is_primary_agent());
        assert_eq!(mini.roles(), ["agent"]);

        let agent_ids: Vec<&str> = fleet
            .agent_nodes()
            .into_iter()
            .map(|n| n.server_id.as_str())
            .collect();
        assert_eq!(agent_ids, vec!["node-beast", "node-mini"]);

        // 1. Prefers `is_primary_agent == true`.
        assert_eq!(
            fleet.primary_agent_node().map(|n| n.server_id.as_str()),
            Some("node-mini")
        );

        // 2. Without a primary agent, prefers the first registered node with `"agent"` role.
        let without_primary =
            OrbitFleet::from_targets(vec![nick.clone(), beast.clone()], Some("nick"));
        assert_eq!(
            without_primary
                .primary_agent_node()
                .map(|n| n.server_id.as_str()),
            Some("node-beast")
        );

        // 3. Without any agent-role node, falls back to the local node (sorted first).
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

        // 4. Empty fleet returns None.
        assert_eq!(OrbitFleet::default().primary_agent_node(), None);
    }

    #[test]
    fn deserializes_legacy_orbit_sessions_and_targets_without_agent_fields() {
        let legacy_sessions_json = serde_json::json!({
            "active_server_id": "node-nick",
            "sessions": {
                "node-nick": {
                    "server_id": "node-nick",
                    "url": "http://10.44.0.6:3773",
                    "label": "nick",
                    "bearer": "legacy-token",
                    "paired_at_unix": 1_700_000_000
                }
            }
        })
        .to_string();
        let store: OrbitSessionStore =
            serde_json::from_str(&legacy_sessions_json).expect("legacy orbit-sessions.json");
        assert_eq!(store.active_server_id.as_deref(), Some("node-nick"));
        assert_eq!(store.bearer_for("node-nick"), Some("legacy-token"));

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
        assert!(!target.is_primary_agent());
        assert!(!target.has_agent_role());
    }
}
