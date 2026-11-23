//! Orbit Project thread-start client: Conn Projects listing, branch search, instance name check,
//! clone reservations, and clone create/finalize operation polling.
//!
//! Port of `packages/client-runtime/src/orbitGateway/{client,threadStart,reservations}.ts` and
//! `apps/mobile/src/features/orbit/{OrbitThreadStartScreen,orbitThreadStarts,orbitReservations}.ts`.
//! Every endpoint matches Orbit Gateway's `/api/v1/conn` contract verbatim.

use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::fleet::{OrbitFleetClient, OrbitPairingTicket};
use super::gateway::{GatewayError, GatewayRequest, GatewayTransport, OrbitGateway};
use super::profile::{ProfileError, ProfileResult};

/// Workspace root Orbit creates for a cloned Project Instance (`orbitThreadStartRuntime.ts`).
pub const ORBIT_CLONE_WORKSPACE: &str = "/srv/workspace";

const ADMISSION_TIMEOUT: Duration = Duration::from_secs(60);
const NAME_CHECK_TIMEOUT: Duration = Duration::from_secs(5);
const BRANCHES_TIMEOUT: Duration = Duration::from_secs(25);
const RESERVATION_WAIT: Duration = Duration::from_secs(120);
const CREATE_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const RESERVATION_POLL_MS: u64 = 500;
const FINALIZE_FAST_POLL_MS: u64 = 200;
const WAITED_POLL_MS: u64 = 500;
const NAME_SLUG_LENGTH: usize = 40;
const NAME_SLUG_WORDS: usize = 6;
const NAME_SLUG_RETRY_LENGTHS: [usize; 3] = [24, 12, 0];

/// Status of one start-readiness check on an [`OrbitConnProject`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OrbitConnProjectCheckStatus {
    Pass,
    Fail,
    NotChecked,
}

/// One start-readiness check reported on `GET /api/v1/conn/projects?include_unavailable=1`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OrbitConnProjectCheck {
    pub key: String,
    pub label: Option<String>,
    pub status: OrbitConnProjectCheckStatus,
    pub code: Option<String>,
    pub message: Option<String>,
}

/// One row of `GET /api/v1/conn/projects` (mirrors `OrbitGatewayProjectListing`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OrbitConnProject {
    pub id: i64,
    pub slug: String,
    pub name: String,
    pub node_id: Option<i64>,
    pub node_name: Option<String>,
    pub instance_domain_suffix: Option<String>,
    pub cloneable: bool,
    pub cloneable_reason: Option<String>,
    pub checks: Vec<OrbitConnProjectCheck>,
}

impl OrbitConnProject {
    /// True when a thread can start in this project (`startableOrbitProject`).
    #[must_use]
    pub fn is_startable(&self) -> bool {
        self.cloneable && self.node_id.is_some() && self.node_name.is_some()
    }
}

/// Why an Instance name is unavailable (`GET /conn/projects/{id}/instances/check`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OrbitInstanceNameReason {
    Taken,
    Invalid,
    Default,
    DomainInvalid,
}

/// Result of `GET /api/v1/conn/projects/{project}/instances/check?name=...`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OrbitInstanceNameCheck {
    pub name: String,
    pub available: bool,
    pub reason: Option<OrbitInstanceNameReason>,
    pub domain: Option<String>,
}

/// Open pull request associated with a branch on `GET /conn/projects/{id}/branches`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OrbitBranchPullRequest {
    pub number: i64,
    pub title: Option<String>,
    pub url: Option<String>,
}

/// Existing Orbit Instance currently working on a branch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OrbitBranchInstance {
    pub id: i64,
    pub name: String,
}

/// One branch returned by `GET /api/v1/conn/projects/{id}/branches`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OrbitBranch {
    pub name: String,
    pub is_default: bool,
    pub pull_request: Option<OrbitBranchPullRequest>,
    pub instance: Option<OrbitBranchInstance>,
}

/// Response of `GET /api/v1/conn/projects/{id}/branches`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OrbitBranches {
    pub branches: Vec<OrbitBranch>,
    pub pull_requests_unavailable: bool,
}

/// Branch choice when creating or finalizing an Orbit Project Instance.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum OrbitBranchSelection {
    /// Cut a new branch named after the Instance from `from`.
    New { from: String },
    /// Check out and push to existing branch `name`.
    Existing { name: String },
}

impl OrbitBranchSelection {
    fn to_wire(&self) -> Value {
        match self {
            Self::New { from } => json!({ "mode": "new", "from": from }),
            Self::Existing { name } => json!({ "mode": "existing", "name": name }),
        }
    }
}

/// Lifecycle state of a pre-warmed clone reservation (`/conn/reservations/{id}`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OrbitReservationState {
    Preparing,
    Ready,
    Finalizing,
    Finalized,
    Failed,
    Expired,
    Released,
}

/// Pre-warmed clone reservation (`POST /conn/projects/{id}/reservations`, `GET /conn/reservations/{id}`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OrbitReservation {
    pub id: String,
    pub project_id: i64,
    pub instance_id: Option<i64>,
    pub state: OrbitReservationState,
    pub expires_at: Option<String>,
    pub create_operation_id: Option<i64>,
    pub environment_id: Option<String>,
    pub finalize_operation_id: Option<i64>,
    pub error_code: Option<String>,
    /// One-time pairing ticket delivered once by a `ready` reservation `GET`.
    pub pairing: Option<OrbitPairingTicket>,
}

/// Lifecycle status of a Gateway Operation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OrbitOperationStatus {
    Queued,
    Running,
    Waiting,
    Succeeded,
    Failed,
    Cancelled,
    Interrupted,
}

impl OrbitOperationStatus {
    #[must_use]
    pub const fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Succeeded | Self::Failed | Self::Cancelled | Self::Interrupted
        )
    }
}

/// Subset of an Orbit Gateway Operation followed during instance creation/finalization.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OrbitOperation {
    pub id: i64,
    pub kind: String,
    pub status: OrbitOperationStatus,
    pub target_id: i64,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub poll_after_seconds: Option<u64>,
    pub result_environment_id: Option<String>,
    pub result_branch: Option<String>,
    pub result_base_branch: Option<String>,
    pub completion_operation_id: Option<i64>,
}

/// Ready clone Instance ready for Conn pairing and `orchestration.launchThread`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedOrbitInstance {
    pub environment_id: String,
    pub server_url: String,
    pub instance_id: Option<i64>,
    pub instance_name: String,
    /// One-time pairing delivered by a pre-warmed reservation, if available.
    pub pairing: Option<OrbitPairingTicket>,
}

/// Derives a valid Orbit Instance name from the thread's first message plus a random suffix
/// (port of `orbitThreadInstanceName` in `packages/client-runtime/src/orbitGateway/threadStart.ts`).
#[must_use]
pub fn orbit_thread_instance_name(message: &str, suffix: &str, slug_length: usize) -> String {
    let clean_suffix: String = suffix
        .to_ascii_lowercase()
        .chars()
        .filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == '-')
        .collect();
    let suffix_part = if clean_suffix.is_empty() {
        "clone"
    } else {
        clean_suffix.as_str()
    };

    if slug_length == 0 {
        return format!("thread-{suffix_part}");
    }

    let cleaned: String = message
        .chars()
        .map(|c| {
            let lower = c.to_ascii_lowercase();
            if lower.is_ascii_lowercase() || lower.is_ascii_digit() {
                lower
            } else {
                ' '
            }
        })
        .collect();

    let joined = cleaned
        .split_whitespace()
        .take(NAME_SLUG_WORDS)
        .collect::<Vec<_>>()
        .join("-");

    let truncated: String = joined.chars().take(slug_length).collect();
    let slug = truncated.trim_end_matches('-');
    if slug.is_empty() {
        format!("thread-{suffix_part}")
    } else {
        format!("{slug}-{suffix_part}")
    }
}

/// Refusal codes where Orbit created no Instance and falling back from reservation to create
/// would fail the exact same way (`ADMISSION_REFUSALS` in `threadStart.ts`).
fn is_admission_refusal(code: &str) -> bool {
    matches!(
        code,
        "instance.name_taken"
            | "branch.in_use"
            | "branch.not_found"
            | "branch.exists"
            | "source.head_unavailable"
            | "instance.placement_conflict"
            | "route.domain_invalid"
            | "validation.failed"
    )
}

/// Client for Orbit Project thread-start endpoints over any [`GatewayTransport`].
#[derive(Clone)]
pub struct OrbitThreadStartClient {
    transport: Arc<dyn GatewayTransport>,
}

const _: () = {
    const fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<OrbitThreadStartClient>();
};

impl std::fmt::Debug for OrbitThreadStartClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OrbitThreadStartClient")
            .finish_non_exhaustive()
    }
}

impl OrbitThreadStartClient {
    /// Builds a client backed by the live [`OrbitGateway`].
    ///
    /// # Errors
    /// Returns [`GatewayError`] if the underlying HTTP client fails to initialize.
    pub fn live() -> Result<Self, GatewayError> {
        Ok(Self::new(Arc::new(OrbitGateway::new()?)))
    }

    /// Builds a client backed by an arbitrary [`GatewayTransport`] (live or mock).
    #[must_use]
    pub fn new(transport: Arc<dyn GatewayTransport>) -> Self {
        Self { transport }
    }

    /// Lists startable Orbit Projects (`GET /api/v1/conn/projects`), matching `OrbitThreadStartScreen`.
    pub async fn conn_projects(&self) -> ProfileResult<Vec<OrbitConnProject>> {
        self.fetch_conn_projects(false).await
    }

    /// Lists all Orbit Projects including unavailable ones and their readiness checks
    /// (`GET /api/v1/conn/projects?include_unavailable=1`).
    pub async fn conn_projects_including_unavailable(
        &self,
    ) -> ProfileResult<Vec<OrbitConnProject>> {
        self.fetch_conn_projects(true).await
    }

    async fn fetch_conn_projects(
        &self,
        include_unavailable: bool,
    ) -> ProfileResult<Vec<OrbitConnProject>> {
        let mut req = GatewayRequest::get("/projects");
        if include_unavailable {
            req = req.with_query("include_unavailable", "1");
        }
        let data = self.call_data(req).await?;
        let arr = data.as_array().ok_or_else(|| invalid("/projects"))?;
        arr.iter()
            .map(|row| decode_conn_project(row, "/projects"))
            .collect()
    }

    /// Checks whether `name` is available for a new Instance of `project_id`
    /// (`GET /api/v1/conn/projects/{project_id}/instances/check?name=...`).
    pub async fn check_instance_name(
        &self,
        project_id: i64,
        name: &str,
    ) -> ProfileResult<OrbitInstanceNameCheck> {
        let path = format!("/projects/{project_id}/instances/check");
        let req = GatewayRequest::get(&path)
            .with_query("name", name)
            .with_timeout(NAME_CHECK_TIMEOUT);
        let data = self.call_data(req).await?;
        decode_instance_name_check(&data, name, &path)
    }

    /// Derives an Instance name from `message` + `suffix`, shortening on `domain_invalid`
    /// (port of `fitOrbitThreadInstanceName` in `threadStart.ts`).
    pub async fn fit_instance_name(
        &self,
        project_id: i64,
        message: &str,
        suffix: &str,
    ) -> ProfileResult<String> {
        let mut candidates = Vec::with_capacity(1 + NAME_SLUG_RETRY_LENGTHS.len());
        let first = orbit_thread_instance_name(message, suffix, NAME_SLUG_LENGTH);
        candidates.push(first);
        for len in NAME_SLUG_RETRY_LENGTHS {
            let next = orbit_thread_instance_name(message, suffix, len);
            if candidates.last().is_none_or(|prev| prev != &next) {
                candidates.push(next);
            }
        }

        let mut saw_domain_invalid = false;
        for candidate in &candidates {
            match self.check_instance_name(project_id, candidate).await {
                Ok(check)
                    if !check.available
                        && check.reason == Some(OrbitInstanceNameReason::DomainInvalid) =>
                {
                    saw_domain_invalid = true;
                }
                Ok(_) => return Ok(candidate.clone()),
                Err(_) if !saw_domain_invalid => return Ok(candidate.clone()),
                Err(err) => return Err(err),
            }
        }

        Err(ProfileError::Gateway {
            code: "route.domain_invalid".to_owned(),
            message: "This name makes the address too long. Use a shorter name.".to_owned(),
            status: 422,
        })
    }

    /// Lists branches of `project_id` (`GET /api/v1/conn/projects/{project_id}/branches`).
    pub async fn branches(
        &self,
        project_id: i64,
        query: Option<&str>,
    ) -> ProfileResult<OrbitBranches> {
        let path = format!("/projects/{project_id}/branches");
        let mut req = GatewayRequest::get(&path).with_timeout(BRANCHES_TIMEOUT);
        if let Some(q) = query.map(str::trim).filter(|q| !q.is_empty()) {
            req = req.with_query("query", q);
        }
        let envelope = self.call_envelope(req).await?;
        let rows = envelope
            .get("data")
            .and_then(Value::as_array)
            .ok_or_else(|| invalid(&path))?;
        let pull_requests_unavailable = envelope
            .get("meta")
            .and_then(|m| m.get("pull_requests_unavailable"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let branches = rows.iter().filter_map(decode_branch).collect();
        Ok(OrbitBranches {
            branches,
            pull_requests_unavailable,
        })
    }

    /// Reserves a pre-warmed clone Instance for `project_id`
    /// (`POST /api/v1/conn/projects/{project_id}/reservations`).
    pub async fn reserve(
        &self,
        project_id: i64,
        idempotency_key: Option<&str>,
    ) -> ProfileResult<OrbitReservation> {
        let path = format!("/projects/{project_id}/reservations");
        let mut req = GatewayRequest::post(&path)
            .with_body("{}")
            .with_timeout(ADMISSION_TIMEOUT);
        if let Some(key) = idempotency_key {
            req = req.with_idempotency_key(key);
        }
        let data = self.call_data(req).await?;
        decode_reservation(&data, &path, None)
    }

    /// Reads a reservation and extends its TTL (`GET /api/v1/conn/reservations/{id}`).
    pub async fn reservation(&self, reservation_id: &str) -> ProfileResult<OrbitReservation> {
        let path = format!("/reservations/{reservation_id}");
        let data = self.call_data(GatewayRequest::get(&path)).await?;
        decode_reservation(&data, &path, Some(reservation_id))
    }

    /// Releases a reservation (`DELETE /api/v1/conn/reservations/{id}`).
    /// Returns the destroy operation id when one was started, or `None` on HTTP 204.
    pub async fn release_reservation(&self, reservation_id: &str) -> ProfileResult<Option<i64>> {
        let path = format!("/reservations/{reservation_id}");
        let response = self
            .transport
            .send(GatewayRequest::delete(&path))
            .await
            .map_err(|err| ProfileError::Unreachable(err.to_string()))?;
        if response.status == 204 {
            return Ok(None);
        }
        let envelope = parse_response_envelope(&path, response)?;
        let data = envelope.get("data").and_then(Value::as_object);
        let op_id = data.and_then(|obj| {
            obj.get("destroy_operation_id")
                .or_else(|| obj.get("id"))
                .or_else(|| obj.get("operation").and_then(|o| o.get("id")))
                .or_else(|| obj.get("operation_id"))
                .and_then(Value::as_i64)
        });
        Ok(op_id)
    }

    /// Finalizes a ready reservation with `name` and optional `branch`
    /// (`POST /api/v1/conn/reservations/{id}/finalize`).
    pub async fn finalize_reservation(
        &self,
        reservation_id: &str,
        name: &str,
        idempotency_key: &str,
        branch: Option<&OrbitBranchSelection>,
    ) -> ProfileResult<OrbitOperation> {
        let path = format!("/reservations/{reservation_id}/finalize");
        let body = match branch {
            Some(sel) => json!({ "name": name, "branch": sel.to_wire() }),
            None => json!({ "name": name }),
        };
        let req = GatewayRequest::post(&path)
            .with_body(body.to_string())
            .with_timeout(ADMISSION_TIMEOUT)
            .with_idempotency_key(idempotency_key);
        let data = self.call_data(req).await?;
        decode_operation(&data, &path)
    }

    /// Admits a new clone Instance for `project_id`
    /// (`POST /api/v1/conn/projects/{project_id}/instances`).
    pub async fn create_thread_instance(
        &self,
        project_id: i64,
        name: &str,
        idempotency_key: &str,
        branch: Option<&OrbitBranchSelection>,
    ) -> ProfileResult<OrbitOperation> {
        let path = format!("/projects/{project_id}/instances");
        let body = match branch {
            Some(sel) => json!({ "name": name, "branch": sel.to_wire() }),
            None => json!({ "name": name }),
        };
        let req = GatewayRequest::post(&path)
            .with_body(body.to_string())
            .with_timeout(ADMISSION_TIMEOUT)
            .with_idempotency_key(idempotency_key);
        let data = self.call_data(req).await?;
        decode_operation(&data, &path)
    }

    /// Reads an Operation (`GET /api/v1/conn/operations/{id}`, falling back to
    /// `GET /api/v1/operations/{id}` on 404 for Gateways predating Conn finalize reads).
    pub async fn operation(&self, operation_id: i64) -> ProfileResult<OrbitOperation> {
        let path = format!("/operations/{operation_id}");
        match self.call_data(GatewayRequest::get(&path)).await {
            Ok(data) => decode_operation(&data, &path),
            Err(ProfileError::Gateway { status: 404, .. }) => {
                let data = self.call_data(GatewayRequest::get(&path).at_root()).await?;
                decode_operation(&data, &path)
            }
            Err(err) => Err(err),
        }
    }

    /// Provisions a clone Instance for `project_id` — finalizing a pre-warmed `reservation_id`
    /// when usable (falling back cleanly to `create_thread_instance` if the reservation expired,
    /// failed, or disappeared), polling until ready, and resolving its `environment_id` and URL.
    #[expect(
        clippy::too_many_arguments,
        reason = "mirrors OrbitThreadStart inputs without inventing an extra wrapper struct"
    )]
    pub async fn prepare_new_instance(
        &self,
        fleet: &OrbitFleetClient,
        project_id: i64,
        instance_name: Option<&str>,
        message: &str,
        reservation_id: Option<&str>,
        cached_reservation_pairing: Option<OrbitPairingTicket>,
        branch: Option<&OrbitBranchSelection>,
        suffix: &str,
        idempotency_prefix: &str,
    ) -> ProfileResult<PreparedOrbitInstance> {
        let resolved_name = match instance_name.map(str::trim).filter(|s| !s.is_empty()) {
            Some(explicit) => explicit.to_owned(),
            None => self.fit_instance_name(project_id, message, suffix).await?,
        };

        let mut reservation_pairing = cached_reservation_pairing;
        let mut finalized_env_id: Option<String> = None;
        let mut instance_id: Option<i64> = None;

        // Try finalizing the pre-warmed reservation first when provided.
        let mut created_op: Option<OrbitOperation> = None;
        if let Some(res_id) = reservation_id.map(str::trim).filter(|s| !s.is_empty()) {
            match self
                .try_finalize_reservation(
                    res_id,
                    project_id,
                    &resolved_name,
                    branch,
                    &format!("{idempotency_prefix}:finalize"),
                    &mut reservation_pairing,
                )
                .await
            {
                Ok(Some((op, res_env_id, res_instance_id))) => {
                    finalized_env_id = res_env_id;
                    instance_id = res_instance_id.or(Some(op.target_id));
                    created_op = Some(op);
                }
                Ok(None) => {
                    // Reservation unavailable/expired -> release best-effort and fall back to create.
                    let _ = self.release_reservation(res_id).await;
                    reservation_pairing = None;
                }
                Err(err) => return Err(err),
            }
        }

        // Fall back to direct Instance creation if no reservation was finalized.
        let op = match created_op {
            Some(op) => op,
            None => {
                let started = self
                    .create_thread_instance(
                        project_id,
                        &resolved_name,
                        &format!("{idempotency_prefix}:create"),
                        branch,
                    )
                    .await?;
                instance_id = Some(started.target_id);
                self.poll_operation(started, CREATE_TIMEOUT, WAITED_POLL_MS)
                    .await?
            }
        };

        let env_id_hint = finalized_env_id.or(op.result_environment_id);
        let fleet_snapshot = fleet.list_fleet(None).await?;
        let target = env_id_hint
            .as_deref()
            .and_then(|id| fleet_snapshot.find_by_server_id(id))
            .or_else(|| {
                instance_id.and_then(|iid| {
                    fleet_snapshot
                        .instances
                        .iter()
                        .find(|t| t.instance_id() == Some(iid))
                })
            });

        let (environment_id, server_url) = match target {
            Some(t) => (t.server_id.clone(), t.url.clone()),
            None => match (env_id_hint, reservation_pairing.as_ref()) {
                (Some(env_id), Some(ticket)) => {
                    let url = ticket
                        .http_base_url()
                        .map(|u| u.to_string())
                        .ok_or_else(|| invalid("/environments"))?;
                    (env_id, url)
                }
                _ => {
                    return Err(ProfileError::Gateway {
                        code: "conn.environment_missing".to_owned(),
                        message: "Orbit created the clone but lists no Conn Server for it."
                            .to_owned(),
                        status: 404,
                    });
                }
            },
        };

        let matching_pairing = reservation_pairing.filter(|t| t.server_id == environment_id);
        Ok(PreparedOrbitInstance {
            environment_id,
            server_url,
            instance_id,
            instance_name: resolved_name,
            pairing: matching_pairing,
        })
    }

    async fn try_finalize_reservation(
        &self,
        reservation_id: &str,
        project_id: i64,
        name: &str,
        branch: Option<&OrbitBranchSelection>,
        idempotency_key: &str,
        cached_pairing: &mut Option<OrbitPairingTicket>,
    ) -> ProfileResult<Option<(OrbitOperation, Option<String>, Option<i64>)>> {
        let ready_deadline = tokio::time::Instant::now() + RESERVATION_WAIT;
        let (reserved_env_id, reserved_instance_id) = loop {
            match self.reservation(reservation_id).await {
                Ok(res) => {
                    if res.id != reservation_id || res.project_id != project_id {
                        return Ok(None);
                    }
                    match res.state {
                        OrbitReservationState::Ready
                        | OrbitReservationState::Finalizing
                        | OrbitReservationState::Finalized => {
                            if let Some(ticket) = res.pairing {
                                *cached_pairing = Some(ticket);
                            }
                            break (res.environment_id, res.instance_id);
                        }
                        OrbitReservationState::Preparing => {}
                        OrbitReservationState::Failed
                        | OrbitReservationState::Expired
                        | OrbitReservationState::Released => return Ok(None),
                    }
                }
                Err(ProfileError::Gateway {
                    status: 404 | 410, ..
                }) => return Ok(None),
                Err(ProfileError::Gateway { code, .. })
                    if code.starts_with("reservation.") && code != "reservation.finalized" =>
                {
                    return Ok(None);
                }
                Err(_) => return Ok(None),
            }
            if tokio::time::Instant::now() >= ready_deadline {
                return Ok(None);
            }
            tokio::time::sleep(Duration::from_millis(RESERVATION_POLL_MS)).await;
        };

        let started = match self
            .finalize_reservation(reservation_id, name, idempotency_key, branch)
            .await
        {
            Ok(op) => op,
            Err(ProfileError::Gateway { code, .. }) if is_admission_refusal(&code) => {
                return Err(ProfileError::Gateway {
                    message: if code == "route.domain_invalid" {
                        "This name makes the address too long. Use a shorter name.".to_owned()
                    } else {
                        format!("Orbit refused to start the clone ({code}).")
                    },
                    code,
                    status: 422,
                });
            }
            Err(_) => return Ok(None),
        };

        match self
            .poll_operation(started, CREATE_TIMEOUT, FINALIZE_FAST_POLL_MS)
            .await
        {
            Ok(op) => Ok(Some((op, reserved_env_id, reserved_instance_id))),
            Err(ProfileError::Gateway { code, .. }) if code == "operation.timeout" => {
                Err(ProfileError::Gateway {
                    code,
                    message: "Timed out waiting for Orbit to finalize the clone.".to_owned(),
                    status: 504,
                })
            }
            Err(_) => Ok(None),
        }
    }

    async fn poll_operation(
        &self,
        mut op: OrbitOperation,
        timeout: Duration,
        fast_poll_ms: u64,
    ) -> ProfileResult<OrbitOperation> {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            match op.status {
                OrbitOperationStatus::Succeeded => return Ok(op),
                status if status.is_terminal() => {
                    let code = op
                        .error_code
                        .unwrap_or_else(|| format!("operation.{status:?}").to_lowercase());
                    let message = op
                        .error_message
                        .unwrap_or_else(|| format!("Orbit could not create the clone ({code})."));
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
                    message: "Timed out waiting for Orbit operation to complete.".to_owned(),
                    status: 504,
                });
            }
            let hinted_ms = op
                .poll_after_seconds
                .map_or(WAITED_POLL_MS, |s| (s * 1000).clamp(500, 15_000));
            let wait_ms = hinted_ms.min(fast_poll_ms.max(100));
            tokio::time::sleep(Duration::from_millis(wait_ms)).await;
            op = self.operation(op.id).await?;
        }
    }

    async fn call_data(&self, request: GatewayRequest) -> ProfileResult<Value> {
        let path = request.path.clone();
        let envelope = self.call_envelope(request).await?;
        envelope.get("data").cloned().ok_or_else(|| invalid(&path))
    }

    async fn call_envelope(&self, request: GatewayRequest) -> ProfileResult<Value> {
        let path = request.path.clone();
        let response = self
            .transport
            .send(request)
            .await
            .map_err(|err| ProfileError::Unreachable(err.to_string()))?;
        parse_response_envelope(&path, response)
    }
}

fn parse_response_envelope(
    path: &str,
    response: super::gateway::GatewayResponse,
) -> ProfileResult<Value> {
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
            .map_or_else(
                || format!("The Orbit Gateway answered {}.", response.status),
                ToOwned::to_owned,
            );
        return Err(ProfileError::Gateway {
            code,
            message,
            status: response.status,
        });
    }
    let json = parsed.ok_or_else(|| invalid(path))?;
    if !json.is_object() || json.get("data").is_none() {
        return Err(invalid(path));
    }
    Ok(json)
}

fn invalid(path: &str) -> ProfileError {
    ProfileError::InvalidResponse {
        path: path.to_owned(),
    }
}

fn optional_text(value: Option<&Value>) -> Option<String> {
    let trimmed = value?.as_str()?.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}

fn decode_project_check(value: &Value) -> Option<OrbitConnProjectCheck> {
    let obj = value.as_object()?;
    let key = optional_text(obj.get("key"))?;
    let status = match obj.get("status")?.as_str()? {
        "pass" => OrbitConnProjectCheckStatus::Pass,
        "fail" => OrbitConnProjectCheckStatus::Fail,
        "not_checked" => OrbitConnProjectCheckStatus::NotChecked,
        _ => return None,
    };
    Some(OrbitConnProjectCheck {
        key,
        label: optional_text(obj.get("label")),
        status,
        code: optional_text(obj.get("code")),
        message: optional_text(obj.get("message")),
    })
}

fn decode_conn_project(value: &Value, path: &str) -> ProfileResult<OrbitConnProject> {
    let obj = value.as_object().ok_or_else(|| invalid(path))?;
    let id = obj
        .get("id")
        .and_then(Value::as_i64)
        .ok_or_else(|| invalid(path))?;
    let slug = obj
        .get("slug")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid(path))?
        .to_owned();
    let name = obj
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid(path))?
        .to_owned();
    let cloneable = obj
        .get("cloneable")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let checks = obj
        .get("checks")
        .and_then(Value::as_array)
        .map(|arr| arr.iter().filter_map(decode_project_check).collect())
        .unwrap_or_default();
    Ok(OrbitConnProject {
        id,
        slug,
        name,
        node_id: obj.get("node_id").and_then(Value::as_i64),
        node_name: optional_text(obj.get("node_name")),
        instance_domain_suffix: optional_text(obj.get("instance_domain_suffix")),
        cloneable,
        cloneable_reason: optional_text(obj.get("cloneable_reason")),
        checks,
    })
}

fn decode_instance_name_check(
    value: &Value,
    requested: &str,
    path: &str,
) -> ProfileResult<OrbitInstanceNameCheck> {
    let obj = value.as_object().ok_or_else(|| invalid(path))?;
    let available = obj
        .get("available")
        .and_then(Value::as_bool)
        .ok_or_else(|| invalid(path))?;
    let reason = if available {
        None
    } else {
        match obj.get("reason").and_then(Value::as_str) {
            Some("taken") => Some(OrbitInstanceNameReason::Taken),
            Some("invalid") => Some(OrbitInstanceNameReason::Invalid),
            Some("default") => Some(OrbitInstanceNameReason::Default),
            Some("domain_invalid") => Some(OrbitInstanceNameReason::DomainInvalid),
            _ => None,
        }
    };
    Ok(OrbitInstanceNameCheck {
        name: optional_text(obj.get("name")).unwrap_or_else(|| requested.to_owned()),
        available,
        reason,
        domain: optional_text(obj.get("domain")),
    })
}

fn decode_branch(value: &Value) -> Option<OrbitBranch> {
    let obj = value.as_object()?;
    let name = optional_text(obj.get("name"))?;
    let pull_request = obj
        .get("pull_request")
        .and_then(Value::as_object)
        .and_then(|pr| {
            let number = pr.get("number").and_then(Value::as_i64)?;
            Some(OrbitBranchPullRequest {
                number,
                title: optional_text(pr.get("title")),
                url: optional_text(pr.get("url")),
            })
        });
    let instance = obj
        .get("instance")
        .and_then(Value::as_object)
        .and_then(|inst| {
            let id = inst.get("id").and_then(Value::as_i64)?;
            let inst_name = optional_text(inst.get("name"))?;
            Some(OrbitBranchInstance {
                id,
                name: inst_name,
            })
        });
    Some(OrbitBranch {
        name,
        is_default: obj.get("default").and_then(Value::as_bool).unwrap_or(false),
        pull_request,
        instance,
    })
}

fn decode_reservation(
    value: &Value,
    path: &str,
    requested_id: Option<&str>,
) -> ProfileResult<OrbitReservation> {
    let obj = value.as_object().ok_or_else(|| invalid(path))?;
    let id = obj
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid(path))?
        .to_owned();
    if let Some(expected) = requested_id
        && id != expected
    {
        return Err(invalid(path));
    }
    let project_id = obj
        .get("project_id")
        .and_then(Value::as_i64)
        .ok_or_else(|| invalid(path))?;
    let state = match obj.get("state").and_then(Value::as_str) {
        Some("preparing") => OrbitReservationState::Preparing,
        Some("ready") => OrbitReservationState::Ready,
        Some("finalizing") => OrbitReservationState::Finalizing,
        Some("finalized") => OrbitReservationState::Finalized,
        Some("failed") => OrbitReservationState::Failed,
        Some("expired") => OrbitReservationState::Expired,
        Some("released") => OrbitReservationState::Released,
        _ => return Err(invalid(path)),
    };
    let environment_id = optional_text(obj.get("environment_id"));
    let pairing = if requested_id.is_some() && state == OrbitReservationState::Ready {
        decode_inline_pairing(obj.get("pairing")).filter(|ticket| {
            environment_id
                .as_deref()
                .is_some_and(|env_id| ticket.server_id == env_id)
        })
    } else {
        None
    };
    Ok(OrbitReservation {
        id,
        project_id,
        instance_id: obj.get("instance_id").and_then(Value::as_i64),
        state,
        expires_at: optional_text(obj.get("expires_at")),
        create_operation_id: obj.get("create_operation_id").and_then(Value::as_i64),
        environment_id,
        finalize_operation_id: obj.get("finalize_operation_id").and_then(Value::as_i64),
        error_code: optional_text(obj.get("error_code")),
        pairing,
    })
}

fn decode_inline_pairing(value: Option<&Value>) -> Option<OrbitPairingTicket> {
    let obj = value?.as_object()?;
    let pairing_url = obj.get("pairing_url")?.as_str()?.to_owned();
    let pairing = obj.get("pairing")?.as_object()?;
    let server_id = pairing.get("environment_id")?.as_str()?.to_owned();
    let expires_at = pairing.get("expires_at")?.as_str()?.to_owned();
    Some(OrbitPairingTicket {
        server_id,
        pairing_url,
        expires_at,
    })
}

fn decode_operation(value: &Value, path: &str) -> ProfileResult<OrbitOperation> {
    let obj = value.as_object().ok_or_else(|| invalid(path))?;
    let id = obj
        .get("id")
        .and_then(Value::as_i64)
        .ok_or_else(|| invalid(path))?;
    let kind = obj
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let status = match obj.get("status").and_then(Value::as_str) {
        Some("queued") => OrbitOperationStatus::Queued,
        Some("running") => OrbitOperationStatus::Running,
        Some("waiting") => OrbitOperationStatus::Waiting,
        Some("succeeded") => OrbitOperationStatus::Succeeded,
        Some("failed") => OrbitOperationStatus::Failed,
        Some("cancelled") => OrbitOperationStatus::Cancelled,
        Some("interrupted") => OrbitOperationStatus::Interrupted,
        _ => return Err(invalid(path)),
    };
    let target_id = obj
        .get("target_id")
        .and_then(Value::as_i64)
        .ok_or_else(|| invalid(path))?;
    let error_code = optional_text(obj.get("error_code")).or_else(|| {
        obj.get("error")
            .and_then(Value::as_object)
            .and_then(|e| optional_text(e.get("code")))
    });
    let error_message = obj.get("error").and_then(|e| {
        e.as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(ToOwned::to_owned)
            .or_else(|| e.as_object().and_then(|m| optional_text(m.get("message"))))
    });
    let result = obj.get("result").and_then(Value::as_object);
    let result_environment_id = result
        .and_then(|r| r.get("t3"))
        .and_then(Value::as_object)
        .and_then(|t3| optional_text(t3.get("environment_id")));
    let result_branch = result.and_then(|r| optional_text(r.get("branch")));
    let result_base_branch = result.and_then(|r| optional_text(r.get("base_branch")));
    let completion_operation_id = result
        .and_then(|r| r.get("completion_operation_id"))
        .and_then(Value::as_i64);

    Ok(OrbitOperation {
        id,
        kind,
        status,
        target_id,
        error_code,
        error_message,
        poll_after_seconds: obj.get("poll_after_seconds").and_then(Value::as_u64),
        result_environment_id,
        result_branch,
        result_base_branch,
        completion_operation_id,
    })
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;
    use crate::gateway::{BoxFuture, GatewayMethod, GatewayResponse};

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

    #[test]
    fn derives_orbit_thread_instance_names() {
        assert_eq!(
            orbit_thread_instance_name("Fix the login redirect bug!", "a1b2c3", 40),
            "fix-the-login-redirect-bug-a1b2c3",
            "slugifies first words with suffix"
        );
        assert_eq!(
            orbit_thread_instance_name("one two three four five six seven eight", "xyz", 40),
            "one-two-three-four-five-six-xyz",
            "caps slug at 6 words"
        );
        assert_eq!(
            orbit_thread_instance_name("   !!!   ", "123456", 40),
            "thread-123456",
            "empty slug falls back to thread"
        );
        assert_eq!(
            orbit_thread_instance_name("Fix login", "123456", 0),
            "thread-123456",
            "zero slug length uses thread prefix"
        );
    }

    #[tokio::test]
    async fn decodes_conn_projects_branches_and_fits_instance_name() {
        let transport = MockGateway::new(|req| {
            match (req.method, req.path.as_str()) {
            (GatewayMethod::Get, "/projects") => Ok(GatewayResponse {
                status: 200,
                body: json!({
                    "data": [
                        {
                            "id": 78,
                            "slug": "orbit",
                            "name": "Orbit",
                            "node_id": 9,
                            "node_name": "beast",
                            "instance_domain_suffix": ".orbit.test",
                            "cloneable": true,
                            "cloneable_reason": null,
                            "checks": [
                                { "key": "default_instance", "label": "Default instance", "status": "pass" }
                            ]
                        },
                        {
                            "id": 79,
                            "slug": "docs",
                            "name": "Docs",
                            "node_id": null,
                            "node_name": null,
                            "cloneable": false,
                            "cloneable_reason": "No default instance",
                            "checks": [
                                { "key": "default_instance", "status": "fail", "code": "instance.default_missing", "message": "Missing" }
                            ]
                        }
                    ]
                })
                .to_string(),
            }),
            (GatewayMethod::Get, "/projects/78/branches") => {
                assert_eq!(
                    req.query.get("query").map(String::as_str),
                    Some("feat"),
                    "branch query forwarded"
                );
                Ok(GatewayResponse {
                    status: 200,
                    body: json!({
                        "data": [
                            {
                                "name": "main",
                                "default": true,
                                "pull_request": null,
                                "instance": null
                            },
                            {
                                "name": "feat/ios",
                                "default": false,
                                "pull_request": { "number": 42, "title": "iOS", "url": "https://github.com/org/repo/pull/42" },
                                "instance": { "id": 501, "name": "ios-work" }
                            }
                        ],
                        "meta": { "pull_requests_unavailable": false }
                    })
                    .to_string(),
                })
            }
            (GatewayMethod::Get, "/projects/78/instances/check") => {
                let name = req.query.get("name").cloned().unwrap_or_default();
                let fits = name.len() <= 20;
                Ok(GatewayResponse {
                    status: 200,
                    body: json!({
                        "data": {
                            "name": name,
                            "available": fits,
                            "reason": if fits { Value::Null } else { json!("domain_invalid") },
                            "domain": if fits { json!(format!("{name}.orbit.test")) } else { Value::Null }
                        }
                    })
                    .to_string(),
                })
            }
            other => panic!("unexpected request: {other:?}"),
        }
        });

        let client = OrbitThreadStartClient::new(transport);
        let projects = client
            .conn_projects_including_unavailable()
            .await
            .expect("conn projects");
        assert_eq!(projects.len(), 2, "expected 2 projects");
        assert!(projects[0].is_startable(), "first project is startable");
        assert!(
            !projects[1].is_startable(),
            "second project is not startable"
        );
        assert_eq!(
            projects[1].checks[0].status,
            OrbitConnProjectCheckStatus::Fail,
            "check status decoded"
        );

        let branches = client.branches(78, Some("feat")).await.expect("branches");
        assert_eq!(branches.branches.len(), 2, "two branches decoded");
        assert!(branches.branches[0].is_default, "default branch flagged");
        assert_eq!(
            branches.branches[1].pull_request.as_ref().map(|p| p.number),
            Some(42),
            "PR number decoded"
        );
        assert_eq!(
            branches.branches[1].instance.as_ref().map(|i| i.id),
            Some(501),
            "branch instance id decoded"
        );

        let fitted = client
            .fit_instance_name(
                78,
                "a very long feature name that exceeds domain limit easily",
                "abc123",
            )
            .await
            .expect("fitted name");
        assert!(
            fitted.len() <= 20 && fitted.ends_with("-abc123"),
            "fitted name `{fitted}` should shorten slug while keeping suffix"
        );
    }

    #[tokio::test]
    async fn prepares_instance_via_reservation_finalize_with_inline_pairing_and_root_op_fallback() {
        let transport = MockGateway::new(|req| match (req.method, req.root, req.path.as_str()) {
            (GatewayMethod::Get, false, "/reservations/res-1") => Ok(GatewayResponse {
                status: 200,
                body: json!({
                    "data": {
                        "id": "res-1",
                        "project_id": 78,
                        "instance_id": 900,
                        "state": "ready",
                        "environment_id": "env-clone-900",
                        "pairing": {
                            "pairing_url": "http://10.44.0.7:4900/pair#token=res-code",
                            "pairing": {
                                "environment_id": "env-clone-900",
                                "expires_at": "2026-11-22T20:00:00Z"
                            }
                        }
                    }
                })
                .to_string(),
            }),
            (GatewayMethod::Post, false, "/reservations/res-1/finalize") => Ok(GatewayResponse {
                status: 202,
                body: json!({
                    "data": {
                        "id": 7001,
                        "kind": "instance.finalize",
                        "status": "running",
                        "target_id": 900,
                        "poll_after_seconds": 1
                    }
                })
                .to_string(),
            }),
            (GatewayMethod::Get, false, "/operations/7001") => Ok(GatewayResponse {
                status: 404,
                body: json!({ "error": { "code": "http.404", "message": "not on conn" } })
                    .to_string(),
            }),
            (GatewayMethod::Get, true, "/operations/7001") => Ok(GatewayResponse {
                status: 200,
                body: json!({
                    "data": {
                        "id": 7001,
                        "kind": "instance.finalize",
                        "status": "succeeded",
                        "target_id": 900,
                        "result": { "branch": "fix-bug-abc123" }
                    }
                })
                .to_string(),
            }),
            (GatewayMethod::Get, false, "/environments") => Ok(GatewayResponse {
                status: 200,
                body: json!({
                    "data": [{
                        "environment_id": "env-clone-900",
                        "label": "orbit / fix-bug-abc123",
                        "url": "http://10.44.0.7:4900",
                        "status": "registered",
                        "cleanup_pending": false,
                        "instance_id": 900,
                        "project_id": 78,
                        "power_state": "running"
                    }]
                })
                .to_string(),
            }),
            other => panic!("unexpected request: {other:?}"),
        });

        let ts_client = OrbitThreadStartClient::new(transport.clone());
        let fleet_client = OrbitFleetClient::new(transport);
        let prepared = ts_client
            .prepare_new_instance(
                &fleet_client,
                78,
                Some("fix-bug-abc123"),
                "Fix bug",
                Some("res-1"),
                None,
                None,
                "abc123",
                "test-start",
            )
            .await
            .expect("prepared via reservation");

        assert_eq!(
            prepared.environment_id, "env-clone-900",
            "environment_id resolved from reservation"
        );
        assert_eq!(
            prepared.server_url, "http://10.44.0.7:4900",
            "server_url resolved from fleet"
        );
        assert_eq!(prepared.instance_id, Some(900), "instance_id preserved");
        assert_eq!(
            prepared
                .pairing
                .as_ref()
                .and_then(OrbitPairingTicket::pairing_code)
                .as_deref(),
            Some("res-code"),
            "inline reservation pairing preserved"
        );
    }

    #[tokio::test]
    async fn falls_back_to_create_when_reservation_is_expired() {
        let saw_create = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let saw_create_ref = Arc::clone(&saw_create);
        let transport = MockGateway::new(move |req| match (req.method, req.path.as_str()) {
            (GatewayMethod::Get, "/reservations/res-old") => Ok(GatewayResponse {
                status: 200,
                body: json!({
                    "data": {
                        "id": "res-old",
                        "project_id": 78,
                        "state": "expired"
                    }
                })
                .to_string(),
            }),
            (GatewayMethod::Delete, "/reservations/res-old") => Ok(GatewayResponse {
                status: 204,
                body: String::new(),
            }),
            (GatewayMethod::Post, "/projects/78/instances") => {
                saw_create_ref.store(true, std::sync::atomic::Ordering::SeqCst);
                Ok(GatewayResponse {
                    status: 202,
                    body: json!({
                        "data": {
                            "id": 8001,
                            "kind": "instance.create",
                            "status": "succeeded",
                            "target_id": 901,
                            "result": { "t3": { "environment_id": "env-clone-901" } }
                        }
                    })
                    .to_string(),
                })
            }
            (GatewayMethod::Get, "/environments") => Ok(GatewayResponse {
                status: 200,
                body: json!({
                    "data": [{
                        "environment_id": "env-clone-901",
                        "label": "orbit / fresh-clone",
                        "url": "http://10.44.0.7:4901",
                        "status": "registered",
                        "cleanup_pending": false,
                        "instance_id": 901,
                        "project_id": 78,
                        "power_state": "running"
                    }]
                })
                .to_string(),
            }),
            other => panic!("unexpected request: {other:?}"),
        });

        let ts_client = OrbitThreadStartClient::new(transport.clone());
        let fleet_client = OrbitFleetClient::new(transport);
        let prepared = ts_client
            .prepare_new_instance(
                &fleet_client,
                78,
                Some("fresh-clone"),
                "Fresh task",
                Some("res-old"),
                None,
                None,
                "abc123",
                "test-fallback",
            )
            .await
            .expect("prepared via fallback create");

        assert!(
            saw_create.load(std::sync::atomic::Ordering::SeqCst),
            "expired reservation must fall back to POST /projects/{{id}}/instances"
        );
        assert_eq!(prepared.environment_id, "env-clone-901");
        assert_eq!(prepared.pairing, None);
    }
}
