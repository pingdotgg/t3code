//! UniFFI Swift/iOS bridge over [`conn_orbit`]: Orbit Gateway identity, fleet discovery,
//! primary `agent`-role node selection, auto-pairing into [`ConnCore`], read-only profile &
//! workspace sync, Orbit project & General thread starts, Tasks board/detail/insights, and
//! Reverb realtime invalidations.

use std::collections::HashMap;
use std::fmt;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use conn_orbit::board::{BoardLane, task_card_detail, tasks_board_lanes};
use conn_orbit::detail::{
    AgentRow, StatusTone, SubtaskLead, agent_state_text, agent_state_tone, agents_for,
    orbit_agent_driver_kind, subtask_lead, subtask_status_text, subtask_usage_text,
    task_status_text, task_usage,
};
use conn_orbit::insights::{
    ChangeTone, INSIGHTS, InsightId, TrendPoint, format_insight_value, insight_change_text,
    insight_change_tone, insight_change_trend, insight_result, insight_trend,
};
use conn_orbit::tasks::{
    AgentRole, AgentState, AttentionKind, ConversationRef, Deliverable, ImplementerMode,
    InsightsPeriod, PowerState, PullRequestState, Subtask, SubtaskCounts, SubtaskStatus, TaskAgent,
    TaskAttention, TaskDetail, TaskEnvironment, TaskInsights, TaskInsightsQuery, TaskLabelTone,
    TaskLane, TaskMetrics, TaskProject, TaskPullRequest, TaskStatus, TaskSummary, TaskWorkspace,
    TasksListQuery,
};
use conn_orbit::{
    APPEARANCE_SECTION, BearerCheckOutcome, EnvironmentConnectPlan, GatewayTransport,
    ORBIT_CLONE_WORKSPACE, OrbitBranch, OrbitBranchInstance, OrbitBranchPullRequest,
    OrbitBranchSelection, OrbitBranches, OrbitConnProject, OrbitConnProjectCheck,
    OrbitConnProjectCheckStatus, OrbitFleetClient, OrbitGateway, OrbitInstanceNameCheck,
    OrbitInstanceNameReason, OrbitNode, OrbitPairingTicket, OrbitProfile, OrbitProfileClient,
    OrbitProfileSettings, OrbitRealtimeEvent, OrbitReservation, OrbitReservationState,
    OrbitServerTarget, OrbitTargetKind, OrbitTargetStatus, OrbitTasksClient,
    OrbitThreadStartClient, OrbitWorkspace, ProfileAppearance, ProfileAppearanceMode,
    ProfileCustomTheme, ProfileThemeAppearance, ProfileThemeSlot, TasksFollower, TasksInvalidation,
    TasksLiveStatus, ThemeSlotSource, check_bearer_session, extract_section, follow_orbit_tasks,
    orbit_thread_instance_name, parse_profile_appearance, select_primary_agent_node,
    workspace_matches_project,
};
use serde_json::Value;
use tokio::task::JoinHandle;

use crate::core::{ConnCore, CoreListener};
use crate::theme::FfiAppearance;
use crate::types::{FfiCredential, FfiError, FfiOrbitErrorReason};

const SHUTDOWN_TIMEOUT: Duration = Duration::from_millis(250);
const CLONE_READY_TIMEOUT: Duration = Duration::from_secs(60);
const DEFAULT_TASKS_LIMIT: u32 = 100;

/// Foreign callback listener implemented in Swift to receive Orbit Gateway realtime invalidations.
///
/// Every method is called with no internal locks held. Invalidations only notify the app to
/// re-read the authoritative state via [`OrbitCore`].
#[uniffi::export(with_foreign)]
pub trait OrbitListener: Send + Sync {
    /// Fired when Orbit Tasks changed (`task_id` is `None` for a full board refresh or `Some(id)`
    /// for a specific task).
    fn on_tasks_changed(&self, task_id: Option<i64>);
    /// Fired when the Reverb realtime follower transitions between `Connecting`, `Live`, and
    /// `Polling`.
    fn on_realtime_status(&self, status: FfiTasksLiveStatus);
    /// Fired when a Node or Instance changed on the shared `private-orbit` Reverb channel.
    fn on_fleet_changed(&self);
    /// Fired when the bound Orbit profile changed on another device.
    fn on_profile_changed(&self);
}

// ---------------------------------------------------------------------------
// Identity & Fleet FFI types
// ---------------------------------------------------------------------------

/// Orbit user profile metadata (`GET /api/v1/conn/profiles` or `me.profile`).
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct FfiOrbitProfile {
    pub id: i64,
    pub name: String,
    pub settings_version: i64,
    pub updated_at: String,
}

impl From<OrbitProfile> for FfiOrbitProfile {
    fn from(value: OrbitProfile) -> Self {
        Self {
            id: value.id,
            name: value.name,
            settings_version: value.settings_version,
            updated_at: value.updated_at,
        }
    }
}

/// Caller Node identity seen by the Orbit Gateway (`GET /api/v1/conn/me`).
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct FfiOrbitMe {
    pub id: i64,
    pub name: String,
    pub wireguard_ip: String,
    pub profile: Option<FfiOrbitProfile>,
}

impl From<OrbitNode> for FfiOrbitMe {
    fn from(value: OrbitNode) -> Self {
        Self {
            id: value.id,
            name: value.name,
            wireguard_ip: value.wireguard_ip,
            profile: value.profile.map(Into::into),
        }
    }
}

/// Registration status of an Orbit Node or Instance on the Gateway.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, uniffi::Enum)]
pub enum FfiOrbitTargetStatus {
    Registered,
    SessionExpired,
}

impl From<OrbitTargetStatus> for FfiOrbitTargetStatus {
    fn from(value: OrbitTargetStatus) -> Self {
        match value {
            OrbitTargetStatus::Registered => Self::Registered,
            OrbitTargetStatus::SessionExpired => Self::SessionExpired,
        }
    }
}

/// Container power state for an Orbit Instance.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, uniffi::Enum)]
pub enum FfiOrbitPowerState {
    Running,
    Stopped,
}

impl From<PowerState> for FfiOrbitPowerState {
    fn from(value: PowerState) -> Self {
        match value {
            PowerState::Running => Self::Running,
            PowerState::Stopped => Self::Stopped,
        }
    }
}

/// One registered Orbit `conn-server` environment — either a host Node or a per-project Instance.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct FfiOrbitEnvironment {
    /// Gateway wire identifier (`environment_id` on the wire).
    pub server_id: String,
    pub label: String,
    pub display_title: String,
    pub display_subtitle: String,
    pub node_name: Option<String>,
    pub url: String,
    pub roles: Vec<String>,
    /// The Node carries the Orbit `agent` role, i.e. it is the Conn entry point.
    pub has_agent_role: bool,
    pub status: FfiOrbitTargetStatus,
    /// Always `false` on iOS (the phone does not host `conn-server`).
    pub is_local: bool,
    pub is_node: bool,
    pub is_awake: bool,
    pub instance_id: Option<i64>,
    pub instance_name: Option<String>,
    pub project_id: Option<i64>,
    pub project_name: Option<String>,
    pub project_slug: Option<String>,
    pub instance_url: Option<String>,
    pub power_state: Option<FfiOrbitPowerState>,
    pub server_version: Option<String>,
    pub registered_by: Option<String>,
}

fn map_orbit_environment(target: &OrbitServerTarget, is_local: bool) -> FfiOrbitEnvironment {
    let (instance_id, instance_name, project_id, project_name, project_slug, instance_url) =
        match &target.kind {
            OrbitTargetKind::Node { .. } => (None, None, None, None, None, None),
            OrbitTargetKind::Instance {
                instance_id,
                instance_name,
                project_id,
                project_name,
                project_slug,
                instance_url,
                ..
            } => (
                Some(*instance_id),
                Some(instance_name.clone()),
                *project_id,
                project_name.clone(),
                project_slug.clone(),
                instance_url.clone(),
            ),
        };

    FfiOrbitEnvironment {
        server_id: target.server_id.clone(),
        label: target.label.clone(),
        display_title: target.display_title(),
        display_subtitle: target.display_subtitle(),
        node_name: target.node_name().map(str::to_owned),
        url: target.url.clone(),
        roles: target.roles().to_vec(),
        has_agent_role: target.has_agent_role(),
        status: target.status.into(),
        is_local,
        is_node: target.is_node(),
        is_awake: target.is_awake(),
        instance_id,
        instance_name,
        project_id,
        project_name,
        project_slug,
        instance_url,
        power_state: target.power_state().map(Into::into),
        server_version: target.server_version.clone(),
        registered_by: target.registered_by.clone(),
    }
}

// ---------------------------------------------------------------------------
// Profile, Workspaces & Appearance FFI types
// ---------------------------------------------------------------------------

/// One workspace filter synced through the Orbit profile (`settings.workspaces`).
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct FfiOrbitWorkspace {
    pub id: String,
    pub name: String,
    pub color: String,
    pub icon: Option<String>,
    pub image: Option<String>,
    pub project_refs: Vec<String>,
    pub project_keys: Vec<String>,
}

impl From<OrbitWorkspace> for FfiOrbitWorkspace {
    fn from(value: OrbitWorkspace) -> Self {
        Self {
            id: value.id,
            name: value.name,
            color: value.color,
            icon: value.icon,
            image: value.image,
            project_refs: value.project_refs,
            project_keys: value.project_keys,
        }
    }
}

impl From<FfiOrbitWorkspace> for OrbitWorkspace {
    fn from(value: FfiOrbitWorkspace) -> Self {
        Self {
            id: value.id,
            name: value.name,
            color: value.color,
            icon: value.icon,
            image: value.image,
            project_refs: value.project_refs,
            project_keys: value.project_keys,
        }
    }
}

/// Overall appearance mode preference synced in the Orbit profile.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, uniffi::Enum)]
pub enum FfiOrbitAppearanceMode {
    Light,
    Dark,
    System,
}

impl From<ProfileAppearanceMode> for FfiOrbitAppearanceMode {
    fn from(value: ProfileAppearanceMode) -> Self {
        match value {
            ProfileAppearanceMode::Light => Self::Light,
            ProfileAppearanceMode::Dark => Self::Dark,
            ProfileAppearanceMode::System => Self::System,
        }
    }
}

/// Source kind of a theme slot inside the Orbit profile `appearance` section.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, uniffi::Enum)]
pub enum FfiOrbitThemeSlotSource {
    Stock,
    Builtin,
    Custom,
    Published,
}

impl From<ThemeSlotSource> for FfiOrbitThemeSlotSource {
    fn from(value: ThemeSlotSource) -> Self {
        match value {
            ThemeSlotSource::Stock => Self::Stock,
            ThemeSlotSource::Builtin => Self::Builtin,
            ThemeSlotSource::Custom => Self::Custom,
            ThemeSlotSource::Published => Self::Published,
        }
    }
}

fn map_profile_appearance(app: ProfileThemeAppearance) -> FfiAppearance {
    match app {
        ProfileThemeAppearance::Light => FfiAppearance::Light,
        ProfileThemeAppearance::Dark => FfiAppearance::Dark,
    }
}

/// One theme slot (`themes.light` or `themes.dark`) from the Orbit profile `appearance` section.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct FfiOrbitThemeSlot {
    pub id: String,
    pub normalized_theme_id: String,
    pub source: FfiOrbitThemeSlotSource,
    pub name: Option<String>,
    pub appearance: Option<FfiAppearance>,
    pub colors: HashMap<String, String>,
}

fn map_theme_slot(slot: &ProfileThemeSlot, target: ProfileThemeAppearance) -> FfiOrbitThemeSlot {
    let normalized_theme_id = slot.normalized_theme_id(target);
    match slot {
        ProfileThemeSlot::Reference { id, source } => FfiOrbitThemeSlot {
            id: id.clone(),
            normalized_theme_id,
            source: (*source).into(),
            name: None,
            appearance: None,
            colors: HashMap::new(),
        },
        ProfileThemeSlot::Resolved {
            id,
            name,
            source,
            appearance,
            colors,
        } => FfiOrbitThemeSlot {
            id: id.clone(),
            normalized_theme_id,
            source: (*source).into(),
            name: Some(name.clone()),
            appearance: Some(map_profile_appearance(*appearance)),
            colors: colors.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
        },
    }
}

/// Custom theme carried in the Orbit profile's `appearance.customThemes` library.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct FfiOrbitCustomTheme {
    pub id: String,
    pub name: String,
    pub appearance: FfiAppearance,
    pub colors: HashMap<String, String>,
}

impl From<ProfileCustomTheme> for FfiOrbitCustomTheme {
    fn from(value: ProfileCustomTheme) -> Self {
        Self {
            id: value.id,
            name: value.name,
            appearance: map_profile_appearance(value.appearance),
            colors: value.colors.into_iter().collect(),
        }
    }
}

/// Parsed `appearance` section of an Orbit profile (mirroring `orbitProfileSync.ts`).
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct FfiOrbitAppearance {
    pub mode: FfiOrbitAppearanceMode,
    pub contrast: f64,
    pub light_theme_id: String,
    pub dark_theme_id: String,
    pub light_slot: FfiOrbitThemeSlot,
    pub dark_slot: FfiOrbitThemeSlot,
    pub custom_themes: Vec<FfiOrbitCustomTheme>,
}

impl From<ProfileAppearance> for FfiOrbitAppearance {
    fn from(value: ProfileAppearance) -> Self {
        let light_slot = map_theme_slot(&value.themes.light, ProfileThemeAppearance::Light);
        let dark_slot = map_theme_slot(&value.themes.dark, ProfileThemeAppearance::Dark);
        Self {
            mode: value.mode.into(),
            contrast: value.contrast,
            light_theme_id: light_slot.normalized_theme_id.clone(),
            dark_theme_id: dark_slot.normalized_theme_id.clone(),
            light_slot,
            dark_slot,
            custom_themes: value.custom_themes.into_iter().map(Into::into).collect(),
        }
    }
}

/// Settings snapshot for one Orbit profile (workspaces + appearance section).
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct FfiOrbitProfileSettings {
    pub profile_id: i64,
    pub version: i64,
    pub updated_at: String,
    pub workspaces: Vec<FfiOrbitWorkspace>,
    pub appearance: Option<FfiOrbitAppearance>,
}

impl From<OrbitProfileSettings> for FfiOrbitProfileSettings {
    fn from(settings: OrbitProfileSettings) -> Self {
        let appearance = extract_section(&settings, APPEARANCE_SECTION)
            .and_then(|map| parse_profile_appearance(&Value::Object(map)))
            .map(Into::into);
        Self {
            profile_id: settings.profile_id,
            version: settings.version,
            updated_at: settings.updated_at,
            workspaces: settings.workspaces.into_iter().map(Into::into).collect(),
            appearance,
        }
    }
}

/// Bound Orbit profile plus its resolved workspaces and appearance settings.
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct FfiOrbitBoundProfile {
    pub profile: FfiOrbitProfile,
    pub settings: FfiOrbitProfileSettings,
}

// ---------------------------------------------------------------------------
// Projects & Orbit Thread Start FFI types
// ---------------------------------------------------------------------------

/// Status of one start-readiness check on an [`FfiOrbitProject`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, uniffi::Enum)]
pub enum FfiOrbitProjectCheckStatus {
    Pass,
    Fail,
    NotChecked,
}

impl From<OrbitConnProjectCheckStatus> for FfiOrbitProjectCheckStatus {
    fn from(value: OrbitConnProjectCheckStatus) -> Self {
        match value {
            OrbitConnProjectCheckStatus::Pass => Self::Pass,
            OrbitConnProjectCheckStatus::Fail => Self::Fail,
            OrbitConnProjectCheckStatus::NotChecked => Self::NotChecked,
        }
    }
}

/// One start-readiness check reported on an [`FfiOrbitProject`].
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct FfiOrbitProjectCheck {
    pub key: String,
    pub label: Option<String>,
    pub status: FfiOrbitProjectCheckStatus,
    pub code: Option<String>,
    pub message: Option<String>,
}

impl From<OrbitConnProjectCheck> for FfiOrbitProjectCheck {
    fn from(value: OrbitConnProjectCheck) -> Self {
        Self {
            key: value.key,
            label: value.label,
            status: value.status.into(),
            code: value.code,
            message: value.message,
        }
    }
}

/// First-party Orbit Project from `GET /api/v1/conn/projects` (mirrors `OrbitGatewayProjectListing`).
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct FfiOrbitProject {
    pub id: i64,
    pub slug: String,
    pub name: String,
    pub node_id: Option<i64>,
    pub node_name: Option<String>,
    pub instance_domain_suffix: Option<String>,
    pub cloneable: bool,
    pub startable: bool,
    pub cloneable_reason: Option<String>,
    pub checks: Vec<FfiOrbitProjectCheck>,
}

impl From<OrbitConnProject> for FfiOrbitProject {
    fn from(value: OrbitConnProject) -> Self {
        let startable = value.is_startable();
        Self {
            id: value.id,
            slug: value.slug,
            name: value.name,
            node_id: value.node_id,
            node_name: value.node_name,
            instance_domain_suffix: value.instance_domain_suffix,
            cloneable: value.cloneable,
            startable,
            cloneable_reason: value.cloneable_reason,
            checks: value.checks.into_iter().map(Into::into).collect(),
        }
    }
}

/// Why an Orbit Instance name is unavailable.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, uniffi::Enum)]
pub enum FfiOrbitInstanceNameReason {
    Taken,
    Invalid,
    Default,
    DomainInvalid,
}

impl From<OrbitInstanceNameReason> for FfiOrbitInstanceNameReason {
    fn from(value: OrbitInstanceNameReason) -> Self {
        match value {
            OrbitInstanceNameReason::Taken => Self::Taken,
            OrbitInstanceNameReason::Invalid => Self::Invalid,
            OrbitInstanceNameReason::Default => Self::Default,
            OrbitInstanceNameReason::DomainInvalid => Self::DomainInvalid,
        }
    }
}

/// Result of `GET /api/v1/conn/projects/{id}/instances/check`.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct FfiOrbitInstanceNameCheck {
    pub name: String,
    pub available: bool,
    pub reason: Option<FfiOrbitInstanceNameReason>,
    pub domain: Option<String>,
}

impl From<OrbitInstanceNameCheck> for FfiOrbitInstanceNameCheck {
    fn from(value: OrbitInstanceNameCheck) -> Self {
        Self {
            name: value.name,
            available: value.available,
            reason: value.reason.map(Into::into),
            domain: value.domain,
        }
    }
}

/// Pull request summary attached to a project branch.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct FfiOrbitBranchPullRequest {
    pub number: i64,
    pub title: Option<String>,
    pub url: Option<String>,
}

impl From<OrbitBranchPullRequest> for FfiOrbitBranchPullRequest {
    fn from(value: OrbitBranchPullRequest) -> Self {
        Self {
            number: value.number,
            title: value.title,
            url: value.url,
        }
    }
}

/// Existing Orbit Instance working on a project branch.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct FfiOrbitBranchInstance {
    pub id: i64,
    pub name: String,
}

impl From<OrbitBranchInstance> for FfiOrbitBranchInstance {
    fn from(value: OrbitBranchInstance) -> Self {
        Self {
            id: value.id,
            name: value.name,
        }
    }
}

/// One branch of an Orbit Project's repository.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct FfiOrbitBranch {
    pub name: String,
    pub is_default: bool,
    pub pull_request: Option<FfiOrbitBranchPullRequest>,
    pub instance: Option<FfiOrbitBranchInstance>,
}

impl From<OrbitBranch> for FfiOrbitBranch {
    fn from(value: OrbitBranch) -> Self {
        Self {
            name: value.name,
            is_default: value.is_default,
            pull_request: value.pull_request.map(Into::into),
            instance: value.instance.map(Into::into),
        }
    }
}

/// Branch listing for an Orbit Project.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct FfiOrbitBranches {
    pub branches: Vec<FfiOrbitBranch>,
    pub pull_requests_unavailable: bool,
}

impl From<OrbitBranches> for FfiOrbitBranches {
    fn from(value: OrbitBranches) -> Self {
        Self {
            branches: value.branches.into_iter().map(Into::into).collect(),
            pull_requests_unavailable: value.pull_requests_unavailable,
        }
    }
}

/// Branch selection when creating or finalizing an Orbit Project clone Instance.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum FfiOrbitBranchSelection {
    /// Cut a new branch named after the Instance from `from`.
    New { from: String },
    /// Check out and push to existing branch `name`.
    Existing { name: String },
}

impl From<FfiOrbitBranchSelection> for OrbitBranchSelection {
    fn from(value: FfiOrbitBranchSelection) -> Self {
        match value {
            FfiOrbitBranchSelection::New { from } => Self::New { from },
            FfiOrbitBranchSelection::Existing { name } => Self::Existing { name },
        }
    }
}

/// Lifecycle state of a pre-warmed clone reservation.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, uniffi::Enum)]
pub enum FfiOrbitReservationState {
    Preparing,
    Ready,
    Finalizing,
    Finalized,
    Failed,
    Expired,
    Released,
}

impl From<OrbitReservationState> for FfiOrbitReservationState {
    fn from(value: OrbitReservationState) -> Self {
        match value {
            OrbitReservationState::Preparing => Self::Preparing,
            OrbitReservationState::Ready => Self::Ready,
            OrbitReservationState::Finalizing => Self::Finalizing,
            OrbitReservationState::Finalized => Self::Finalized,
            OrbitReservationState::Failed => Self::Failed,
            OrbitReservationState::Expired => Self::Expired,
            OrbitReservationState::Released => Self::Released,
        }
    }
}

/// Pre-warmed clone reservation returned by [`OrbitCore::reserve_project`] / [`OrbitCore::get_reservation`].
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct FfiOrbitReservation {
    pub id: String,
    pub project_id: i64,
    pub instance_id: Option<i64>,
    pub state: FfiOrbitReservationState,
    pub expires_at: Option<String>,
    pub environment_id: Option<String>,
    pub error_code: Option<String>,
    pub has_pairing: bool,
}

impl From<&OrbitReservation> for FfiOrbitReservation {
    fn from(value: &OrbitReservation) -> Self {
        Self {
            id: value.id.clone(),
            project_id: value.project_id,
            instance_id: value.instance_id,
            state: value.state.into(),
            expires_at: value.expires_at.clone(),
            environment_id: value.environment_id.clone(),
            error_code: value.error_code.clone(),
            has_pairing: value.pairing.is_some(),
        }
    }
}

/// Target for [`OrbitCore::start_project_thread`]: either a new clone Instance (optionally
/// finalizing a pre-warmed reservation) or an existing Orbit Instance environment.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum FfiOrbitProjectTarget {
    /// Provision a new clone Instance (finalizing `reservation_id` when supplied and ready).
    NewInstance {
        project_id: i64,
        /// Custom instance name; if `None`, derived from the first message and checked for fit.
        instance_name: Option<String>,
        /// Pre-warmed reservation id from [`OrbitCore::reserve_project`].
        reservation_id: Option<String>,
        /// Branch selection; `None` clones the project's default branch.
        branch: Option<FfiOrbitBranchSelection>,
    },
    /// Start the thread inside an existing Orbit Instance environment (waking it if stopped).
    ExistingInstance {
        environment_id: String,
        /// Cached bearer token for `environment_id`, if already paired in Keychain.
        cached_bearer: Option<String>,
    },
}

/// Result of starting a General or Orbit Project thread, carrying the new thread id, which Orbit
/// environment it lives on, and the connected [`ConnCore`] handle ready to render it.
#[derive(Clone, Debug, uniffi::Record)]
pub struct FfiStartedOrbitThread {
    pub thread_id: String,
    pub environment_id: String,
    pub server_url: String,
    pub project_id: String,
    pub instance_id: Option<i64>,
    pub instance_name: Option<String>,
    pub core: Arc<ConnCore>,
}

// ---------------------------------------------------------------------------
// Tasks Board, Detail, Insights & Realtime FFI types
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, uniffi::Enum)]
pub enum FfiTaskStatus {
    Backlog,
    Todo,
    Reserved,
    Running,
    Reviewing,
    Settling,
    WaitingForReview,
    Completed,
    Failed,
    Cancelled,
}

impl From<TaskStatus> for FfiTaskStatus {
    fn from(value: TaskStatus) -> Self {
        match value {
            TaskStatus::Backlog => Self::Backlog,
            TaskStatus::Todo => Self::Todo,
            TaskStatus::Reserved => Self::Reserved,
            TaskStatus::Running => Self::Running,
            TaskStatus::Reviewing => Self::Reviewing,
            TaskStatus::Settling => Self::Settling,
            TaskStatus::WaitingForReview => Self::WaitingForReview,
            TaskStatus::Completed => Self::Completed,
            TaskStatus::Failed => Self::Failed,
            TaskStatus::Cancelled => Self::Cancelled,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, uniffi::Enum)]
pub enum FfiSubtaskStatus {
    Todo,
    Reserved,
    Running,
    Reviewing,
    Completed,
    Failed,
    Cancelled,
    Unknown,
}

impl From<SubtaskStatus> for FfiSubtaskStatus {
    fn from(value: SubtaskStatus) -> Self {
        match value {
            SubtaskStatus::Todo => Self::Todo,
            SubtaskStatus::Reserved => Self::Reserved,
            SubtaskStatus::Running => Self::Running,
            SubtaskStatus::Reviewing => Self::Reviewing,
            SubtaskStatus::Completed => Self::Completed,
            SubtaskStatus::Failed => Self::Failed,
            SubtaskStatus::Cancelled => Self::Cancelled,
            SubtaskStatus::Unknown => Self::Unknown,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, uniffi::Enum)]
pub enum FfiTaskLane {
    Backlog,
    Todo,
    InProgress,
    Done,
}

impl From<TaskLane> for FfiTaskLane {
    fn from(value: TaskLane) -> Self {
        match value {
            TaskLane::Backlog => Self::Backlog,
            TaskLane::Todo => Self::Todo,
            TaskLane::InProgress => Self::InProgress,
            TaskLane::Done => Self::Done,
        }
    }
}

impl From<FfiTaskLane> for TaskLane {
    fn from(value: FfiTaskLane) -> Self {
        match value {
            FfiTaskLane::Backlog => Self::Backlog,
            FfiTaskLane::Todo => Self::Todo,
            FfiTaskLane::InProgress => Self::InProgress,
            FfiTaskLane::Done => Self::Done,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, uniffi::Enum)]
pub enum FfiTaskLabelTone {
    Info,
    Warning,
    Destructive,
    Muted,
}

impl From<TaskLabelTone> for FfiTaskLabelTone {
    fn from(value: TaskLabelTone) -> Self {
        match value {
            TaskLabelTone::Info => Self::Info,
            TaskLabelTone::Warning => Self::Warning,
            TaskLabelTone::Destructive => Self::Destructive,
            TaskLabelTone::Muted => Self::Muted,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, uniffi::Enum)]
pub enum FfiStatusTone {
    Success,
    Info,
    Warning,
    Destructive,
    Muted,
}

impl From<StatusTone> for FfiStatusTone {
    fn from(value: StatusTone) -> Self {
        match value {
            StatusTone::Success => Self::Success,
            StatusTone::Info => Self::Info,
            StatusTone::Warning => Self::Warning,
            StatusTone::Destructive => Self::Destructive,
            StatusTone::Muted => Self::Muted,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, uniffi::Enum)]
pub enum FfiAttentionKind {
    Question,
    Failure,
    Direction,
    Observation,
    RemovalFailure,
}

impl From<AttentionKind> for FfiAttentionKind {
    fn from(value: AttentionKind) -> Self {
        match value {
            AttentionKind::Question => Self::Question,
            AttentionKind::Failure => Self::Failure,
            AttentionKind::Direction => Self::Direction,
            AttentionKind::Observation => Self::Observation,
            AttentionKind::RemovalFailure => Self::RemovalFailure,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, uniffi::Enum)]
pub enum FfiPullRequestState {
    Open,
    Merged,
    Closed,
}

impl From<PullRequestState> for FfiPullRequestState {
    fn from(value: PullRequestState) -> Self {
        match value {
            PullRequestState::Open => Self::Open,
            PullRequestState::Merged => Self::Merged,
            PullRequestState::Closed => Self::Closed,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, uniffi::Enum)]
pub enum FfiAgentRole {
    Implementer,
    Reviewer,
    Unknown,
}

impl From<AgentRole> for FfiAgentRole {
    fn from(value: AgentRole) -> Self {
        match value {
            AgentRole::Implementer => Self::Implementer,
            AgentRole::Reviewer => Self::Reviewer,
            AgentRole::Unknown => Self::Unknown,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, uniffi::Enum)]
pub enum FfiAgentState {
    Idle,
    Working,
    AskingForInput,
    Done,
    Failed,
    Unknown,
}

impl From<AgentState> for FfiAgentState {
    fn from(value: AgentState) -> Self {
        match value {
            AgentState::Idle => Self::Idle,
            AgentState::Working => Self::Working,
            AgentState::AskingForInput => Self::AskingForInput,
            AgentState::Done => Self::Done,
            AgentState::Failed => Self::Failed,
            AgentState::Unknown => Self::Unknown,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, uniffi::Enum)]
pub enum FfiImplementerMode {
    PerSubtask,
    Shared,
}

impl From<ImplementerMode> for FfiImplementerMode {
    fn from(value: ImplementerMode) -> Self {
        match value {
            ImplementerMode::PerSubtask => Self::PerSubtask,
            ImplementerMode::Shared => Self::Shared,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum FfiTaskEnvironmentState {
    NotStarted,
    Disposed,
    Stopped,
    Unreachable,
    Ready { environment_id: String },
}

impl From<TaskEnvironment> for FfiTaskEnvironmentState {
    fn from(value: TaskEnvironment) -> Self {
        match value {
            TaskEnvironment::NotStarted => Self::NotStarted,
            TaskEnvironment::Disposed => Self::Disposed,
            TaskEnvironment::Stopped => Self::Stopped,
            TaskEnvironment::Unreachable => Self::Unreachable,
            TaskEnvironment::Ready { environment_id } => Self::Ready { environment_id },
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, uniffi::Enum)]
pub enum FfiInsightsPeriod {
    Day,
    Week,
    Month,
}

impl From<InsightsPeriod> for FfiInsightsPeriod {
    fn from(value: InsightsPeriod) -> Self {
        match value {
            InsightsPeriod::Day => Self::Day,
            InsightsPeriod::Week => Self::Week,
            InsightsPeriod::Month => Self::Month,
        }
    }
}

impl From<FfiInsightsPeriod> for InsightsPeriod {
    fn from(value: FfiInsightsPeriod) -> Self {
        match value {
            FfiInsightsPeriod::Day => Self::Day,
            FfiInsightsPeriod::Week => Self::Week,
            FfiInsightsPeriod::Month => Self::Month,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, uniffi::Enum)]
pub enum FfiInsightId {
    Completed,
    Spent,
    Tokens,
    Wasted,
    Delivery,
    FirstPass,
    MergeWait,
    ReviewRounds,
}

impl From<InsightId> for FfiInsightId {
    fn from(value: InsightId) -> Self {
        match value {
            InsightId::Completed => Self::Completed,
            InsightId::Spent => Self::Spent,
            InsightId::Tokens => Self::Tokens,
            InsightId::Wasted => Self::Wasted,
            InsightId::Delivery => Self::Delivery,
            InsightId::FirstPass => Self::FirstPass,
            InsightId::MergeWait => Self::MergeWait,
            InsightId::ReviewRounds => Self::ReviewRounds,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, uniffi::Enum)]
pub enum FfiChangeTone {
    Good,
    Bad,
    Neutral,
}

impl From<ChangeTone> for FfiChangeTone {
    fn from(value: ChangeTone) -> Self {
        match value {
            ChangeTone::Good => Self::Good,
            ChangeTone::Bad => Self::Bad,
            ChangeTone::Neutral => Self::Neutral,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, uniffi::Enum)]
pub enum FfiTasksLiveStatus {
    Connecting,
    Live,
    Polling,
}

impl From<TasksLiveStatus> for FfiTasksLiveStatus {
    fn from(value: TasksLiveStatus) -> Self {
        match value {
            TasksLiveStatus::Connecting => Self::Connecting,
            TasksLiveStatus::Live => Self::Live,
            TasksLiveStatus::Polling => Self::Polling,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct FfiTaskAttention {
    pub kind: FfiAttentionKind,
    pub question: Option<String>,
    pub reason: Option<String>,
}

impl From<&TaskAttention> for FfiTaskAttention {
    fn from(value: &TaskAttention) -> Self {
        Self {
            kind: value.kind.into(),
            question: value.question.clone(),
            reason: value.reason.clone(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct FfiTaskProject {
    pub id: i64,
    pub slug: String,
    pub name: String,
    pub code: Option<String>,
}

impl From<&TaskProject> for FfiTaskProject {
    fn from(value: &TaskProject) -> Self {
        Self {
            id: value.id,
            slug: value.slug.clone(),
            name: value.name.clone(),
            code: value.code.clone(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct FfiTaskWorkspace {
    pub instance_id: i64,
    pub name: String,
    pub status: String,
    pub power_state: Option<FfiOrbitPowerState>,
    pub node_id: Option<i64>,
    pub node_name: Option<String>,
    pub branch: Option<String>,
    pub conn_environment_id: Option<String>,
}

impl From<&TaskWorkspace> for FfiTaskWorkspace {
    fn from(value: &TaskWorkspace) -> Self {
        Self {
            instance_id: value.instance_id,
            name: value.name.clone(),
            status: value.status.clone(),
            power_state: value.power_state.map(Into::into),
            node_id: value.node.as_ref().map(|n| n.id),
            node_name: value.node.as_ref().map(|n| n.name.clone()),
            branch: value.branch.clone(),
            conn_environment_id: value.conn_environment_id.clone(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct FfiTaskPullRequest {
    pub number: i64,
    pub url: String,
    pub state: Option<FfiPullRequestState>,
}

impl From<&TaskPullRequest> for FfiTaskPullRequest {
    fn from(value: &TaskPullRequest) -> Self {
        Self {
            number: value.number,
            url: value.url.clone(),
            state: value.state.map(Into::into),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Record)]
pub struct FfiSubtaskCounts {
    pub total: i64,
    pub todo: i64,
    pub running: i64,
    pub completed: i64,
    pub failed: i64,
    pub cancelled: i64,
}

impl From<SubtaskCounts> for FfiSubtaskCounts {
    fn from(value: SubtaskCounts) -> Self {
        Self {
            total: value.total,
            todo: value.todo,
            running: value.running,
            completed: value.completed,
            failed: value.failed,
            cancelled: value.cancelled,
        }
    }
}

/// One Orbit Task card summary for the board and detail header.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct FfiTaskSummary {
    pub id: i64,
    pub title: String,
    pub status: FfiTaskStatus,
    pub status_text: String,
    pub lane: FfiTaskLane,
    pub label: Option<String>,
    pub label_tone: Option<FfiTaskLabelTone>,
    pub card_detail: String,
    pub attention: Option<FfiTaskAttention>,
    pub project: FfiTaskProject,
    pub workspace: Option<FfiTaskWorkspace>,
    pub environment: FfiTaskEnvironmentState,
    pub pull_request: Option<FfiTaskPullRequest>,
    pub subtask_counts: FfiSubtaskCounts,
    pub created_at: String,
    pub updated_at: String,
    pub last_activity_at: Option<String>,
}

impl From<&TaskSummary> for FfiTaskSummary {
    fn from(task: &TaskSummary) -> Self {
        let finer = task.label();
        Self {
            id: task.id,
            title: task.title.clone(),
            status: task.status.into(),
            status_text: task_status_text(task.status).to_owned(),
            lane: task.lane().into(),
            label: finer.map(|l| l.label.to_owned()),
            label_tone: finer.map(|l| l.tone.into()),
            card_detail: task_card_detail(task),
            attention: task.attention.as_ref().map(Into::into),
            project: (&task.project).into(),
            workspace: task.workspace.as_ref().map(Into::into),
            environment: task.environment().into(),
            pull_request: task.pull_request.as_ref().map(Into::into),
            subtask_counts: task.subtask_counts.into(),
            created_at: task.created_at.clone(),
            updated_at: task.updated_at.clone(),
            last_activity_at: task.last_activity_at.clone(),
        }
    }
}

/// One lane on [`FfiTasksBoard`].
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct FfiTaskBoardLane {
    pub id: FfiTaskLane,
    pub label: String,
    pub total: u32,
    pub tasks: Vec<FfiTaskSummary>,
}

impl From<BoardLane<'_>> for FfiTaskBoardLane {
    fn from(lane: BoardLane<'_>) -> Self {
        Self {
            id: lane.id.into(),
            label: lane.label.to_owned(),
            total: u32::try_from(lane.total).unwrap_or(u32::MAX),
            tasks: lane.tasks.into_iter().map(Into::into).collect(),
        }
    }
}

/// One sparkline point on an [`FfiInsightCard`].
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct FfiInsightTrendPoint {
    pub date: String,
    pub value: f64,
}

impl From<TrendPoint> for FfiInsightTrendPoint {
    fn from(value: TrendPoint) -> Self {
        Self {
            date: value.date,
            value: value.value,
        }
    }
}

/// One KPI insight card in [`FfiTaskInsightsStrip`].
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct FfiInsightCard {
    pub id: FfiInsightId,
    pub label: String,
    pub value: Option<f64>,
    pub formatted_value: Option<String>,
    pub change: Option<f64>,
    pub change_text: Option<String>,
    pub change_tone: FfiChangeTone,
    /// `Some(true)` = down arrow, `Some(false)` = up arrow, `None` = no arrow.
    pub trend_down: Option<bool>,
    pub sparkline: Vec<FfiInsightTrendPoint>,
}

/// KPI strip rendered above the Tasks board.
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct FfiTaskInsightsStrip {
    pub period: FfiInsightsPeriod,
    pub cards: Vec<FfiInsightCard>,
}

fn map_insights_strip(insights: &TaskInsights) -> FfiTaskInsightsStrip {
    let cards = INSIGHTS
        .iter()
        .map(|spec| {
            let result = insight_result(Some(insights), spec.id);
            let sparkline = insight_trend(Some(insights), spec.id)
                .unwrap_or_default()
                .into_iter()
                .map(Into::into)
                .collect();
            FfiInsightCard {
                id: spec.id.into(),
                label: spec.label.to_owned(),
                value: result.value,
                formatted_value: result.value.map(|v| format_insight_value(spec.id, v)),
                change: result.change,
                change_text: insight_change_text(*spec, result),
                change_tone: insight_change_tone(*spec, result.change).into(),
                trend_down: insight_change_trend(result.change),
                sparkline,
            }
        })
        .collect();
    FfiTaskInsightsStrip {
        period: insights.period.into(),
        cards,
    }
}

/// Query options for [`OrbitCore::tasks_board`].
#[derive(Clone, Debug, Default, PartialEq, Eq, uniffi::Record)]
pub struct FfiTasksBoardQuery {
    pub project_id: Option<i64>,
    pub search_query: Option<String>,
    pub hidden_lanes: Vec<FfiTaskLane>,
    pub insights_period: Option<FfiInsightsPeriod>,
    pub limit: Option<u32>,
}

/// Full Tasks board snapshot: lanes with filtered task cards plus the KPI insights strip.
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct FfiTasksBoard {
    pub lanes: Vec<FfiTaskBoardLane>,
    pub skipped: u32,
    pub has_more: bool,
    pub insights: Option<FfiTaskInsightsStrip>,
}

#[derive(Clone, Copy, Debug, PartialEq, uniffi::Record)]
pub struct FfiTaskMetrics {
    pub duration_ms: Option<f64>,
    pub tokens: Option<f64>,
    pub lines_added: Option<f64>,
    pub lines_deleted: Option<f64>,
}

impl From<TaskMetrics> for FfiTaskMetrics {
    fn from(value: TaskMetrics) -> Self {
        Self {
            duration_ms: value.duration_ms,
            tokens: value.tokens,
            lines_added: value.lines_added,
            lines_deleted: value.lines_deleted,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct FfiDeliverable {
    pub id: String,
    pub kind: String,
    pub description: String,
}

impl From<&Deliverable> for FfiDeliverable {
    fn from(value: &Deliverable) -> Self {
        Self {
            id: value.id.clone(),
            kind: value.kind.clone(),
            description: value.description.clone(),
        }
    }
}

/// Canonical reference to a Conn conversation linked to an Orbit Task agent.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct FfiConversationRef {
    pub environment_id: String,
    pub thread_id: String,
}

impl From<&ConversationRef> for FfiConversationRef {
    fn from(value: &ConversationRef) -> Self {
        Self {
            environment_id: value.environment_id.clone(),
            thread_id: value.thread_id.clone(),
        }
    }
}

/// One subtask on [`FfiTaskDetail`].
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct FfiSubtask {
    pub id: i64,
    pub position: i64,
    pub title: String,
    pub brief: String,
    pub deliverables: Vec<FfiDeliverable>,
    pub status: FfiSubtaskStatus,
    pub status_text: String,
    pub tone: FfiStatusTone,
    pub attention: Option<FfiTaskAttention>,
    pub current_implementer_agent_id: Option<i64>,
    pub metrics: FfiTaskMetrics,
    pub usage_text: Option<String>,
    pub linked_thread: Option<FfiConversationRef>,
}

fn map_subtask(task: &TaskDetail, subtask: &Subtask) -> FfiSubtask {
    let lead = subtask_lead(task, subtask);
    let (tone, lead_agent): (FfiStatusTone, Option<&TaskAgent>) = match lead {
        SubtaskLead::Agent { agent, tone } => (tone.into(), Some(agent)),
        SubtaskLead::State { tone } => (tone.into(), None),
        SubtaskLead::Done => (FfiStatusTone::Success, None),
        SubtaskLead::NotStarted => (FfiStatusTone::Muted, None),
    };
    let linked_thread = lead_agent
        .and_then(|agent| agent.conn.as_ref())
        .or_else(|| {
            subtask
                .current_implementer_agent_id
                .and_then(|id| task.agents.iter().find(|a| a.id == id))
                .and_then(|a| a.conn.as_ref())
        })
        .map(Into::into);
    FfiSubtask {
        id: subtask.id,
        position: subtask.position,
        title: subtask.title.clone(),
        brief: subtask.brief.clone(),
        deliverables: subtask.deliverables.iter().map(Into::into).collect(),
        status: subtask.status.into(),
        status_text: subtask_status_text(subtask, task).to_owned(),
        tone,
        attention: subtask.attention.as_ref().map(Into::into),
        current_implementer_agent_id: subtask.current_implementer_agent_id,
        metrics: subtask.metrics.into(),
        usage_text: subtask_usage_text(&subtask.metrics),
        linked_thread,
    }
}

/// One implementer or reviewer agent row on [`FfiTaskDetail`].
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct FfiTaskAgent {
    pub id: i64,
    pub role: FfiAgentRole,
    pub label: String,
    pub subtask_ids: Vec<i64>,
    pub current: bool,
    pub attempt: i64,
    pub provider: Option<String>,
    pub driver_kind: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub state: Option<FfiAgentState>,
    pub state_text: String,
    pub state_tone: FfiStatusTone,
    pub needs_input: bool,
    pub created_at: String,
    pub observed_at: Option<String>,
    pub conversation: Option<FfiConversationRef>,
}

fn map_agent_row(row: AgentRow<'_>) -> FfiTaskAgent {
    let agent = row.agent;
    FfiTaskAgent {
        id: agent.id,
        role: agent.role.into(),
        label: row.label,
        subtask_ids: agent.subtask_ids.clone(),
        current: agent.current,
        attempt: agent.attempt,
        provider: agent.provider.clone(),
        driver_kind: orbit_agent_driver_kind(agent.provider.as_deref()),
        model: agent.model.clone(),
        effort: agent.effort.clone(),
        state: agent.state.map(Into::into),
        state_text: agent_state_text(agent).to_owned(),
        state_tone: agent_state_tone(agent).into(),
        needs_input: agent.needs_input,
        created_at: agent.created_at.clone(),
        observed_at: agent.observed_at.clone(),
        conversation: row.conversation.map(Into::into),
    }
}

/// Full Orbit Task detail (`GET /api/v1/conn/tasks/{id}`).
#[derive(Clone, Debug, PartialEq, uniffi::Record)]
pub struct FfiTaskDetail {
    pub summary: FfiTaskSummary,
    pub brief: String,
    pub implementer_mode: FfiImplementerMode,
    pub metrics: FfiTaskMetrics,
    pub usage_text: String,
    pub usage_description: String,
    pub subtasks: Vec<FfiSubtask>,
    pub agents: Vec<FfiTaskAgent>,
}

impl From<&TaskDetail> for FfiTaskDetail {
    fn from(detail: &TaskDetail) -> Self {
        let usage = task_usage(&detail.metrics);
        let agents_model = agents_for(detail, None);
        let agents = agents_model
            .current
            .into_iter()
            .chain(agents_model.earlier)
            .map(map_agent_row)
            .collect();
        Self {
            summary: (&detail.summary).into(),
            brief: detail.brief.clone(),
            implementer_mode: detail.implementer_mode().into(),
            metrics: detail.metrics.into(),
            usage_text: usage.text,
            usage_description: usage.description,
            subtasks: detail
                .subtasks
                .iter()
                .map(|sub| map_subtask(detail, sub))
                .collect(),
            agents,
        }
    }
}

// ---------------------------------------------------------------------------
// Top-level pure FFI helpers
// ---------------------------------------------------------------------------

/// Matches a `conn-server` project against an [`FfiOrbitWorkspace`]'s `project_refs` and
/// `project_keys` (wrapping [`conn_orbit::workspace_matches_project`]).
#[must_use]
#[uniffi::export]
pub fn orbit_workspace_matches_project(
    workspace: FfiOrbitWorkspace,
    project_id: String,
    project_title: String,
    workspace_root: String,
) -> bool {
    let ws: OrbitWorkspace = workspace.into();
    workspace_matches_project(&ws, &project_id, &project_title, &workspace_root)
}

/// Derives an Orbit clone Instance name from the thread's first message plus a suffix
/// (wrapping [`conn_orbit::orbit_thread_instance_name`]).
#[must_use]
#[uniffi::export]
pub fn orbit_derive_instance_name(message: String, suffix: String) -> String {
    orbit_thread_instance_name(&message, &suffix, 40)
}

// ---------------------------------------------------------------------------
// OrbitCore UniFFI object
// ---------------------------------------------------------------------------

struct RealtimeHandle {
    _follower: TasksFollower,
    forward_task: JoinHandle<()>,
}

impl Drop for RealtimeHandle {
    fn drop(&mut self) {
        self.forward_task.abort();
    }
}

/// UniFFI handle to the Orbit Gateway client, Reverb realtime follower, and Tokio runtime.
#[derive(uniffi::Object)]
pub struct OrbitCore {
    runtime: Option<tokio::runtime::Runtime>,
    runtime_handle: tokio::runtime::Handle,
    transport: Arc<dyn GatewayTransport>,
    reservation_pairings: Arc<Mutex<HashMap<String, OrbitPairingTicket>>>,
    realtime: Mutex<Option<RealtimeHandle>>,
}

impl fmt::Debug for OrbitCore {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("OrbitCore").finish_non_exhaustive()
    }
}

impl Drop for OrbitCore {
    fn drop(&mut self) {
        self.stop_realtime();
        if let Some(runtime) = self.runtime.take() {
            if tokio::runtime::Handle::try_current().is_ok() {
                runtime.shutdown_background();
            } else {
                runtime.shutdown_timeout(SHUTDOWN_TIMEOUT);
            }
        }
    }
}

fn build_orbit_runtime() -> Result<tokio::runtime::Runtime, FfiError> {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .thread_name("conn-orbit-ffi")
        .enable_all()
        .build()
        .map_err(|err| FfiError::Connection {
            message: format!("failed to build orbit tokio runtime: {err}"),
        })
}

fn new_idempotency_suffix() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    let mixed = ((nanos as u64) ^ seq.wrapping_mul(0x9e37_79b9_7f4a_7c15)) & 0x00ff_ffff;
    format!("{mixed:06x}")
}

fn new_idempotency_key(prefix: &str) -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis());
    format!("conn-ios:{prefix}:{millis}:{seq}")
}

impl OrbitCore {
    /// Internal constructor injecting a custom [`GatewayTransport`] for unit tests.
    #[cfg(test)]
    pub(crate) fn with_transport(
        transport: Arc<dyn GatewayTransport>,
    ) -> Result<Arc<Self>, FfiError> {
        let runtime = build_orbit_runtime()?;
        let runtime_handle = runtime.handle().clone();
        Ok(Arc::new(Self {
            runtime: Some(runtime),
            runtime_handle,
            transport,
            reservation_pairings: Arc::new(Mutex::new(HashMap::new())),
            realtime: Mutex::new(None),
        }))
    }

    fn profile_client(&self) -> OrbitProfileClient {
        OrbitProfileClient::new(Arc::clone(&self.transport))
    }

    fn fleet_client(&self) -> OrbitFleetClient {
        OrbitFleetClient::new(Arc::clone(&self.transport))
    }

    pub(crate) fn tasks_client(&self) -> OrbitTasksClient {
        OrbitTasksClient::new(Arc::clone(&self.transport))
    }

    fn thread_start_client(&self) -> OrbitThreadStartClient {
        OrbitThreadStartClient::new(Arc::clone(&self.transport))
    }

    pub(crate) async fn spawn_on_rt<F, T>(&self, fut: F) -> Result<T, FfiError>
    where
        F: std::future::Future<Output = Result<T, FfiError>> + Send + 'static,
        T: Send + 'static,
    {
        self.runtime_handle
            .spawn(fut)
            .await
            .map_err(|_| FfiError::Closed)?
    }

    async fn connect_environment_with_probe<F, Fut>(
        &self,
        server_id: String,
        cached_bearer: Option<String>,
        listener: Arc<dyn CoreListener>,
        verify_bearer: F,
    ) -> Result<Arc<ConnCore>, FfiError>
    where
        F: FnOnce(String, String) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = BearerCheckOutcome> + Send + 'static,
    {
        let fleet = self.fleet_client();
        let plan = self
            .spawn_on_rt(async move {
                fleet
                    .resolve_environment_connect(
                        &server_id,
                        cached_bearer.as_deref(),
                        verify_bearer,
                    )
                    .await
                    .map_err(FfiError::from)
            })
            .await?;

        match plan {
            EnvironmentConnectPlan::ReuseBearer { server_url, bearer } => ConnCore::connect(
                server_url,
                FfiCredential::Bearer { token: bearer },
                listener,
            ),
            EnvironmentConnectPlan::PairWithCode {
                server_url,
                pairing_code,
                ..
            } => ConnCore::connect(
                server_url,
                FfiCredential::PairingCode { code: pairing_code },
                listener,
            ),
        }
    }
}

#[uniffi::export]
impl OrbitCore {
    /// Creates a new [`OrbitCore`] targeting `gateway_url` (or `https://gateway.orbit` when
    /// `None`), backed by `rustls-platform-verifier` for macOS Keychain and iOS trust store roots.
    ///
    /// # Errors
    ///
    /// Returns [`FfiError::InvalidUrl`] if `gateway_url` is not a valid `http://` or `https://`
    /// URL, [`FfiError::Orbit`] if the TLS/HTTP client fails to initialize, or
    /// [`FfiError::Connection`] if the background Tokio runtime cannot be built.
    #[uniffi::constructor]
    pub fn new(gateway_url: Option<String>) -> Result<Arc<Self>, FfiError> {
        let gateway = match gateway_url
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            Some(url) => OrbitGateway::with_base_url(url)?,
            None => OrbitGateway::new()?,
        };
        let runtime = build_orbit_runtime()?;
        let runtime_handle = runtime.handle().clone();
        Ok(Arc::new(Self {
            runtime: Some(runtime),
            runtime_handle,
            transport: Arc::new(gateway),
            reservation_pairings: Arc::new(Mutex::new(HashMap::new())),
            realtime: Mutex::new(None),
        }))
    }

    /// Reads the caller's Orbit Node identity (`GET /api/v1/conn/me`), proving WireGuard
    /// reachability without credentials.
    ///
    /// # Errors
    ///
    /// Returns [`FfiError::Orbit`] with the mapped [`FfiOrbitErrorReason`].
    pub async fn me(&self) -> Result<FfiOrbitMe, FfiError> {
        let client = self.profile_client();
        self.spawn_on_rt(async move { client.me().await.map(Into::into).map_err(FfiError::from) })
            .await
    }

    /// Lists all Orbit Nodes and Instances registered on the Gateway (`GET /api/v1/conn/environments`).
    ///
    /// # Errors
    ///
    /// Returns [`FfiError::Orbit`] with the mapped [`FfiOrbitErrorReason`].
    pub async fn fleet(&self) -> Result<Vec<FfiOrbitEnvironment>, FfiError> {
        let client = self.fleet_client();
        self.spawn_on_rt(async move {
            let fleet = client.list_fleet(None).await.map_err(FfiError::from)?;
            let envs = fleet
                .nodes
                .iter()
                .chain(fleet.instances.iter())
                .map(|target| map_orbit_environment(target, false))
                .collect();
            Ok(envs)
        })
        .await
    }

    /// Selects the primary Orbit `agent`-role Node (`select_primary_agent_node` with `None`
    /// because the iPhone does not host `conn-server`).
    ///
    /// # Errors
    ///
    /// Returns [`FfiError::Orbit`] with the mapped [`FfiOrbitErrorReason`].
    pub async fn primary_agent(&self) -> Result<Option<FfiOrbitEnvironment>, FfiError> {
        let client = self.fleet_client();
        self.spawn_on_rt(async move {
            let fleet = client.list_fleet(None).await.map_err(FfiError::from)?;
            Ok(select_primary_agent_node(&fleet.nodes, None)
                .map(|target| map_orbit_environment(target, false)))
        })
        .await
    }

    /// Connects a [`ConnCore`] to Orbit environment `server_id` (steps 2–5 of the documented
    /// Orbit connect flow):
    /// - Reuses `cached_bearer` when supplied and accepted by `GET /api/auth/session`.
    /// - Otherwise (no cached bearer, or auth failure on the cached bearer) mints a fresh pairing
    ///   link once (`mint_pairing`), extracts the base URL + `#token=` pairing code, and starts
    ///   [`ConnCore`] with [`FfiCredential::PairingCode`]; [`CoreListener::on_bearer_issued`]
    ///   delivers the resulting bearer token to store per `server_id` in Keychain.
    ///
    /// # Errors
    ///
    /// Returns [`FfiError::Orbit`] if the environment is not found or pairing fails, or any
    /// [`FfiError`] returned by [`ConnCore::connect`].
    pub async fn connect_environment(
        &self,
        server_id: String,
        cached_bearer: Option<String>,
        listener: Arc<dyn CoreListener>,
    ) -> Result<Arc<ConnCore>, FfiError> {
        self.connect_environment_with_probe(
            server_id,
            cached_bearer,
            listener,
            |url, bearer| async move { check_bearer_session(&url, &bearer).await },
        )
        .await
    }

    /// Wakes a stopped Orbit Instance (`POST /api/v1/instances/{instance_id}/wake`).
    ///
    /// # Errors
    ///
    /// Returns [`FfiError::Orbit`] with the mapped [`FfiOrbitErrorReason`].
    pub async fn wake_instance(&self, instance_id: i64) -> Result<Option<i64>, FfiError> {
        let client = self.fleet_client();
        self.spawn_on_rt(async move {
            client
                .wake_instance(instance_id)
                .await
                .map_err(FfiError::from)
        })
        .await
    }

    /// Lists Orbit profiles (`GET /api/v1/conn/profiles`).
    ///
    /// # Errors
    ///
    /// Returns [`FfiError::Orbit`] with the mapped [`FfiOrbitErrorReason`].
    pub async fn profiles(&self) -> Result<Vec<FfiOrbitProfile>, FfiError> {
        let client = self.profile_client();
        self.spawn_on_rt(async move {
            let list = client.profiles().await.map_err(FfiError::from)?;
            Ok(list.into_iter().map(Into::into).collect())
        })
        .await
    }

    /// Reads workspaces and appearance settings for `profile_id` (`GET /api/v1/conn/profiles/{id}/settings`).
    ///
    /// # Errors
    ///
    /// Returns [`FfiError::Orbit`] with the mapped [`FfiOrbitErrorReason`].
    pub async fn profile_settings(
        &self,
        profile_id: i64,
    ) -> Result<FfiOrbitProfileSettings, FfiError> {
        let client = self.profile_client();
        self.spawn_on_rt(async move {
            client
                .settings(profile_id)
                .await
                .map(Into::into)
                .map_err(FfiError::from)
        })
        .await
    }

    /// Reads the currently bound Orbit profile (`GET /me`) and its workspaces + appearance
    /// settings (`GET /profiles/{id}/settings`), or `None` when this device has no bound profile.
    ///
    /// # Errors
    ///
    /// Returns [`FfiError::Orbit`] with the mapped [`FfiOrbitErrorReason`].
    pub async fn bound_profile(&self) -> Result<Option<FfiOrbitBoundProfile>, FfiError> {
        let client = self.profile_client();
        self.spawn_on_rt(async move {
            let me = client.me().await.map_err(FfiError::from)?;
            let Some(profile) = me.profile else {
                return Ok(None);
            };
            let settings = client.settings(profile.id).await.map_err(FfiError::from)?;
            Ok(Some(FfiOrbitBoundProfile {
                profile: profile.into(),
                settings: settings.into(),
            }))
        })
        .await
    }

    /// Lists startable Orbit Projects (`GET /api/v1/conn/projects`), matching `OrbitThreadStartScreen`.
    ///
    /// # Errors
    ///
    /// Returns [`FfiError::Orbit`] with the mapped [`FfiOrbitErrorReason`].
    pub async fn projects(&self) -> Result<Vec<FfiOrbitProject>, FfiError> {
        let client = self.thread_start_client();
        self.spawn_on_rt(async move {
            let rows = client.conn_projects().await.map_err(FfiError::from)?;
            Ok(rows.into_iter().map(Into::into).collect())
        })
        .await
    }

    /// Lists all Orbit Projects including unavailable ones and their readiness checks
    /// (`GET /api/v1/conn/projects?include_unavailable=1`).
    ///
    /// # Errors
    ///
    /// Returns [`FfiError::Orbit`] with the mapped [`FfiOrbitErrorReason`].
    pub async fn projects_including_unavailable(&self) -> Result<Vec<FfiOrbitProject>, FfiError> {
        let client = self.thread_start_client();
        self.spawn_on_rt(async move {
            let rows = client
                .conn_projects_including_unavailable()
                .await
                .map_err(FfiError::from)?;
            Ok(rows.into_iter().map(Into::into).collect())
        })
        .await
    }

    /// Lists branches of Orbit Project `project_id` (`GET /api/v1/conn/projects/{id}/branches`).
    ///
    /// # Errors
    ///
    /// Returns [`FfiError::Orbit`] with the mapped [`FfiOrbitErrorReason`].
    pub async fn project_branches(
        &self,
        project_id: i64,
        query: Option<String>,
    ) -> Result<FfiOrbitBranches, FfiError> {
        let client = self.thread_start_client();
        self.spawn_on_rt(async move {
            client
                .branches(project_id, query.as_deref())
                .await
                .map(Into::into)
                .map_err(FfiError::from)
        })
        .await
    }

    /// Checks whether `name` is available for a new Instance of `project_id`
    /// (`GET /api/v1/conn/projects/{id}/instances/check?name=...`).
    ///
    /// # Errors
    ///
    /// Returns [`FfiError::Orbit`] with the mapped [`FfiOrbitErrorReason`].
    pub async fn check_instance_name(
        &self,
        project_id: i64,
        name: String,
    ) -> Result<FfiOrbitInstanceNameCheck, FfiError> {
        let client = self.thread_start_client();
        self.spawn_on_rt(async move {
            client
                .check_instance_name(project_id, &name)
                .await
                .map(Into::into)
                .map_err(FfiError::from)
        })
        .await
    }

    /// Pre-warms a clone reservation while the New Orbit Thread screen is open
    /// (`POST /api/v1/conn/projects/{project_id}/reservations`).
    ///
    /// # Errors
    ///
    /// Returns [`FfiError::Orbit`] with the mapped [`FfiOrbitErrorReason`].
    pub async fn reserve_project(&self, project_id: i64) -> Result<FfiOrbitReservation, FfiError> {
        let client = self.thread_start_client();
        let key = new_idempotency_key("reservation");
        self.spawn_on_rt(async move {
            let res = client
                .reserve(project_id, Some(&key))
                .await
                .map_err(FfiError::from)?;
            Ok(FfiOrbitReservation::from(&res))
        })
        .await
    }

    /// Polls a reservation (`GET /api/v1/conn/reservations/{reservation_id}`) and caches any
    /// one-time pairing ticket returned once `state == Ready` for use by [`Self::start_project_thread`].
    ///
    /// # Errors
    ///
    /// Returns [`FfiError::Orbit`] with the mapped [`FfiOrbitErrorReason`].
    pub async fn get_reservation(
        &self,
        reservation_id: String,
    ) -> Result<FfiOrbitReservation, FfiError> {
        let client = self.thread_start_client();
        let pairings = Arc::clone(&self.reservation_pairings);
        self.spawn_on_rt(async move {
            let res = client
                .reservation(&reservation_id)
                .await
                .map_err(FfiError::from)?;
            if let Some(ticket) = res.pairing.clone()
                && let Ok(mut guard) = pairings.lock()
            {
                guard.insert(res.id.clone(), ticket);
            }
            Ok(FfiOrbitReservation::from(&res))
        })
        .await
    }

    /// Releases an unused pre-warmed reservation (`DELETE /api/v1/conn/reservations/{reservation_id}`).
    ///
    /// # Errors
    ///
    /// Returns [`FfiError::Orbit`] with the mapped [`FfiOrbitErrorReason`].
    pub async fn release_reservation(
        &self,
        reservation_id: String,
    ) -> Result<Option<i64>, FfiError> {
        if let Ok(mut guard) = self.reservation_pairings.lock() {
            guard.remove(&reservation_id);
        }
        let client = self.thread_start_client();
        self.spawn_on_rt(async move {
            client
                .release_reservation(&reservation_id)
                .await
                .map_err(FfiError::from)
        })
        .await
    }

    /// Starts a General (unbound) thread on the primary Orbit `agent`-role Node:
    /// resolves `primary_agent()`, connects `ConnCore` (reusing `cached_bearer` or minting a
    /// pairing once), ensures the agent node's scratch project (`projects.ensureScratch`), and
    /// launches the thread via `orchestration.launchThread`.
    ///
    /// # Errors
    ///
    /// Returns [`FfiError::InvalidInput`] if `text` is blank, [`FfiError::Orbit`] if no primary
    /// agent node exists or pairing fails, or any connection/RPC [`FfiError`].
    pub async fn start_general_thread(
        &self,
        text: String,
        cached_bearer: Option<String>,
        listener: Arc<dyn CoreListener>,
    ) -> Result<FfiStartedOrbitThread, FfiError> {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return Err(FfiError::InvalidInput {
                message: "initial message must not be empty".to_owned(),
            });
        }
        let Some(agent) = self.primary_agent().await? else {
            return Err(FfiError::Orbit {
                message: "No primary Orbit agent node is available.".to_owned(),
                reason: FfiOrbitErrorReason::NotFound,
            });
        };
        let core = self
            .connect_environment(agent.server_id.clone(), cached_bearer, listener)
            .await?;
        let project_id = core.ensure_scratch_project().await?;
        let thread_id = core
            .launch_thread(project_id.clone(), trimmed.to_owned())
            .await?;
        Ok(FfiStartedOrbitThread {
            thread_id,
            environment_id: agent.server_id,
            server_url: core.server_url(),
            project_id,
            instance_id: None,
            instance_name: None,
            core,
        })
    }

    /// Starts a thread inside an Orbit Project (mirroring `OrbitThreadStartScreen`,
    /// `orbitThreadStarts.ts`, and `orbitReservations.ts`):
    /// - `NewInstance`: finalizes a ready `reservation_id` (falling back to creating a new clone
    ///   Instance if the reservation expired/disappeared), pairs with the clone's `conn-server`,
    ///   waits for its `/srv/workspace` project, and launches the thread.
    /// - `ExistingInstance`: wakes the instance if stopped, connects (reusing `cached_bearer` or
    ///   minting a pairing once), waits for its `/srv/workspace` project, and launches the thread.
    ///
    /// # Errors
    ///
    /// Returns [`FfiError::InvalidInput`] if `text` is blank, [`FfiError::Orbit`] on Gateway
    /// errors, or any connection/RPC [`FfiError`].
    pub async fn start_project_thread(
        &self,
        target: FfiOrbitProjectTarget,
        text: String,
        listener: Arc<dyn CoreListener>,
    ) -> Result<FfiStartedOrbitThread, FfiError> {
        let trimmed = text.trim().to_owned();
        if trimmed.is_empty() {
            return Err(FfiError::InvalidInput {
                message: "initial message must not be empty".to_owned(),
            });
        }

        match target {
            FfiOrbitProjectTarget::NewInstance {
                project_id,
                instance_name,
                reservation_id,
                branch,
            } => {
                let cached_pairing = reservation_id.as_deref().and_then(|res_id| {
                    self.reservation_pairings
                        .lock()
                        .ok()
                        .and_then(|mut guard| guard.remove(res_id))
                });
                let ts_client = self.thread_start_client();
                let fleet_client = self.fleet_client();
                let msg_for_name = trimmed.clone();
                let suffix = new_idempotency_suffix();
                let key_prefix = new_idempotency_key("thread-start");
                let wire_branch: Option<OrbitBranchSelection> = branch.map(Into::into);

                let prepared = self
                    .spawn_on_rt(async move {
                        ts_client
                            .prepare_new_instance(
                                &fleet_client,
                                project_id,
                                instance_name.as_deref(),
                                &msg_for_name,
                                reservation_id.as_deref(),
                                cached_pairing,
                                wire_branch.as_ref(),
                                &suffix,
                                &key_prefix,
                            )
                            .await
                            .map_err(FfiError::from)
                    })
                    .await?;

                let core = if let Some(ticket) = prepared.pairing {
                    if let Some(code) = ticket.pairing_code() {
                        let url = ticket
                            .http_base_url()
                            .map(|u| u.to_string())
                            .unwrap_or_else(|| prepared.server_url.clone());
                        ConnCore::connect(url, FfiCredential::PairingCode { code }, listener)?
                    } else {
                        self.connect_environment(prepared.environment_id.clone(), None, listener)
                            .await?
                    }
                } else {
                    self.connect_environment(prepared.environment_id.clone(), None, listener)
                        .await?
                };

                let clone_project_id = core
                    .wait_for_project(ORBIT_CLONE_WORKSPACE, CLONE_READY_TIMEOUT)
                    .await?;
                let thread_id = core
                    .launch_thread(clone_project_id.clone(), trimmed)
                    .await?;
                Ok(FfiStartedOrbitThread {
                    thread_id,
                    environment_id: prepared.environment_id,
                    server_url: core.server_url(),
                    project_id: clone_project_id,
                    instance_id: prepared.instance_id,
                    instance_name: Some(prepared.instance_name),
                    core,
                })
            }
            FfiOrbitProjectTarget::ExistingInstance {
                environment_id,
                cached_bearer,
            } => {
                let fleet_client = self.fleet_client();
                let env_id_lookup = environment_id.clone();
                let (instance_id, instance_name, needs_wake) = self
                    .spawn_on_rt(async move {
                        let fleet = fleet_client
                            .list_fleet(None)
                            .await
                            .map_err(FfiError::from)?;
                        let env = fleet.find_by_server_id(&env_id_lookup).ok_or_else(|| {
                            FfiError::Orbit {
                                message: format!("Orbit environment `{env_id_lookup}` not found."),
                                reason: FfiOrbitErrorReason::NotFound,
                            }
                        })?;
                        let iid = env.instance_id();
                        let name = match &env.kind {
                            OrbitTargetKind::Instance { instance_name, .. } => {
                                Some(instance_name.clone())
                            }
                            OrbitTargetKind::Node { .. } => None,
                        };
                        let stopped = env.power_state() == Some(PowerState::Stopped);
                        Ok((iid, name, stopped))
                    })
                    .await?;

                if needs_wake && let Some(iid) = instance_id {
                    let wake_fleet = self.fleet_client();
                    self.spawn_on_rt(async move {
                        wake_fleet
                            .wake_and_wait_instance(iid)
                            .await
                            .map_err(FfiError::from)
                    })
                    .await?;
                }

                let core = self
                    .connect_environment(environment_id.clone(), cached_bearer, listener)
                    .await?;
                let clone_project_id = core
                    .wait_for_project(ORBIT_CLONE_WORKSPACE, CLONE_READY_TIMEOUT)
                    .await?;
                let thread_id = core
                    .launch_thread(clone_project_id.clone(), trimmed)
                    .await?;
                Ok(FfiStartedOrbitThread {
                    thread_id,
                    environment_id,
                    server_url: core.server_url(),
                    project_id: clone_project_id,
                    instance_id,
                    instance_name,
                    core,
                })
            }
        }
    }

    /// Reads the Orbit Tasks board (lanes + task summaries + KPI insights strip), mirroring
    /// `conn_orbit::board` and `conn_orbit::insights`.
    ///
    /// # Errors
    ///
    /// Returns [`FfiError::Orbit`] if reading the task list fails. If reading `/task-insights`
    /// fails independently (e.g. an older Gateway), `insights` degrades gracefully to `None`.
    pub async fn tasks_board(&self, query: FfiTasksBoardQuery) -> Result<FfiTasksBoard, FfiError> {
        let client = self.tasks_client();
        self.spawn_on_rt(async move {
            let list_query = TasksListQuery {
                project: query.project_id,
                limit: Some(query.limit.unwrap_or(DEFAULT_TASKS_LIMIT).clamp(1, 100)),
                ..TasksListQuery::default()
            };
            let insights_query = TaskInsightsQuery {
                period: query
                    .insights_period
                    .map_or(InsightsPeriod::Month, Into::into),
                project: query.project_id,
            };
            let (page_res, insights_res) = tokio::join!(
                client.list_tasks(&list_query),
                client.get_task_insights(insights_query),
            );
            let page = page_res.map_err(FfiError::from)?;
            let hidden: Vec<TaskLane> = query.hidden_lanes.into_iter().map(Into::into).collect();
            let search = query.search_query.as_deref().unwrap_or("");
            let lanes = tasks_board_lanes(&page.tasks, search, &hidden)
                .into_iter()
                .map(Into::into)
                .collect();
            let insights = insights_res.ok().as_ref().map(map_insights_strip);
            Ok(FfiTasksBoard {
                lanes,
                skipped: u32::try_from(page.skipped).unwrap_or(u32::MAX),
                has_more: page.next_cursor.is_some(),
                insights,
            })
        })
        .await
    }

    /// Reads full detail for one Orbit Task (`GET /api/v1/conn/tasks/{task_id}`), including
    /// subtasks, linked agent conversations, usage metrics, and pull request metadata.
    ///
    /// # Errors
    ///
    /// Returns [`FfiError::Orbit`] with the mapped [`FfiOrbitErrorReason`].
    pub async fn task_detail(&self, task_id: i64) -> Result<FfiTaskDetail, FfiError> {
        let client = self.tasks_client();
        self.spawn_on_rt(async move {
            let detail = client.get_task(task_id).await.map_err(FfiError::from)?;
            Ok(FfiTaskDetail::from(&detail))
        })
        .await
    }

    /// Starts Orbit's Reverb WebSocket + 30 s fallback poll follower (`conn_orbit::realtime`)
    /// and forwards task/fleet/profile invalidations to `listener`. Replaces any active follower.
    pub fn start_realtime(&self, listener: Arc<dyn OrbitListener>) {
        let tasks_client = self.tasks_client();
        let mut invalidations = tasks_client.subscribe();
        let follower = follow_orbit_tasks(&self.runtime_handle, tasks_client);
        let mut status_rx = follower.status();
        let mut events_rx = follower.subscribe_events();

        let forward_task = self.runtime_handle.spawn(async move {
            let initial = *status_rx.borrow_and_update();
            listener.on_realtime_status(initial.into());
            loop {
                tokio::select! {
                    inv = invalidations.recv() => match inv {
                        Ok(TasksInvalidation::List) => listener.on_tasks_changed(None),
                        Ok(TasksInvalidation::Task(id)) => listener.on_tasks_changed(Some(id)),
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                            listener.on_tasks_changed(None);
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    },
                    changed = status_rx.changed() => {
                        if changed.is_err() {
                            break;
                        }
                        let next = *status_rx.borrow_and_update();
                        listener.on_realtime_status(next.into());
                    },
                    ev = events_rx.recv() => match ev {
                        Ok(OrbitRealtimeEvent::FleetChanged) => listener.on_fleet_changed(),
                        Ok(OrbitRealtimeEvent::ProfileChanged) => listener.on_profile_changed(),
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                            listener.on_fleet_changed();
                            listener.on_profile_changed();
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    },
                }
            }
        });

        let handle = RealtimeHandle {
            _follower: follower,
            forward_task,
        };
        let previous = self
            .realtime
            .lock()
            .ok()
            .and_then(|mut slot| slot.replace(handle));
        drop(previous);
    }

    /// Stops the active Reverb realtime follower, if any. Safe to call more than once.
    pub fn stop_realtime(&self) {
        let previous = self.realtime.lock().ok().and_then(|mut slot| slot.take());
        drop(previous);
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Condvar, Mutex};

    use conn_orbit::fixtures::{FixtureScenario, FixtureTransport};
    use conn_orbit::gateway::{
        BoxFuture, GatewayError, GatewayMethod, GatewayRequest, GatewayResponse,
    };
    use conn_wire::{Exit, FromClient, FromServer, encode_server_frame};
    use futures::{SinkExt, StreamExt};
    use serde_json::json;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tokio_tungstenite::accept_async;
    use tokio_tungstenite::tungstenite::Message;

    use super::*;
    use crate::types::{FfiConnectionStatus, FfiShellSnapshot, FfiThreadSnapshot};

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

    #[derive(Default)]
    struct TestCoreState {
        connected: bool,
        bearer: Option<String>,
        shell: Option<FfiShellSnapshot>,
        failed: Option<String>,
    }

    #[derive(Default)]
    struct TestCoreListener {
        inner: Mutex<TestCoreState>,
        notify: Condvar,
    }

    impl TestCoreListener {
        fn wait_for<F>(&self, timeout: Duration, mut pred: F) -> bool
        where
            F: FnMut(&TestCoreState) -> bool,
        {
            let deadline = std::time::Instant::now() + timeout;
            let Ok(mut guard) = self.inner.lock() else {
                return false;
            };
            while !pred(&guard) {
                let Some(rem) = deadline.checked_duration_since(std::time::Instant::now()) else {
                    return false;
                };
                let Ok((next, res)) = self.notify.wait_timeout(guard, rem) else {
                    return false;
                };
                guard = next;
                if res.timed_out() {
                    return pred(&guard);
                }
            }
            true
        }
    }

    impl CoreListener for TestCoreListener {
        fn on_status(&self, status: FfiConnectionStatus) {
            if let Ok(mut guard) = self.inner.lock() {
                match status {
                    FfiConnectionStatus::Connected => guard.connected = true,
                    FfiConnectionStatus::Failed { message } => guard.failed = Some(message),
                    FfiConnectionStatus::Connecting | FfiConnectionStatus::Reconnecting { .. } => {}
                }
                self.notify.notify_all();
            }
        }

        fn on_bearer_issued(&self, token: String) {
            if let Ok(mut guard) = self.inner.lock() {
                guard.bearer = Some(token);
                self.notify.notify_all();
            }
        }

        fn on_shell(&self, snapshot: FfiShellSnapshot) {
            if let Ok(mut guard) = self.inner.lock() {
                guard.shell = Some(snapshot);
                self.notify.notify_all();
            }
        }

        fn on_thread(&self, _snapshot: FfiThreadSnapshot) {}

        fn on_error(&self, _message: String) {}

        fn on_providers_changed(&self) {}

        fn on_thread_deleted(&self, _thread_id: String) {}
    }

    /// Minimal in-process HTTP + WebSocket mock `conn-server` supporting:
    /// - `GET /api/auth/session` (validates `valid_bearer`)
    /// - `POST /oauth/token` (exchanges `expected_code` for `issued_bearer`)
    /// - `GET /ws` (Effect RPC: `orchestration.subscribeShell`, `projects.ensureScratch`,
    ///   `orchestration.launchThread`)
    async fn spawn_mock_conn_server(
        valid_bearer: &'static str,
        expected_code: &'static str,
        issued_bearer: &'static str,
        workspace_root: &'static str,
    ) -> (String, JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind mock conn-server");
        let addr = listener.local_addr().expect("mock conn-server addr");
        let base_url = format!("http://{addr}");

        let task = tokio::spawn(async move {
            loop {
                let Ok((mut tcp, _)) = listener.accept().await else {
                    break;
                };
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 8192];
                    let Ok(n) = tcp.peek(&mut buf).await else {
                        return;
                    };
                    let head = String::from_utf8_lossy(&buf[..n]);
                    if head.starts_with("GET /ws") {
                        let Ok(mut ws) = accept_async(tcp).await else {
                            return;
                        };
                        while let Some(Ok(Message::Text(text))) = ws.next().await {
                            let Ok(frames) = conn_wire::decode_client_message(&text) else {
                                continue;
                            };
                            for frame in frames {
                                if let FromClient::Request(req) = frame {
                                    match req.tag.as_str() {
                                        "orchestration.subscribeShell" => {
                                            let chunk = FromServer::Chunk {
                                                request_id: req.id,
                                                values: vec![
                                                    json!({
                                                        "kind": "snapshot",
                                                        "snapshot": {
                                                            "schemaVersion": 1,
                                                            "snapshotSequence": 1,
                                                            "projects": [{
                                                                "id": "proj-1",
                                                                "title": "Workspace",
                                                                "workspaceRoot": workspace_root,
                                                                "defaultModelSelection": {
                                                                    "instanceId": "claudeAgent",
                                                                    "model": "claude-sonnet-4-5"
                                                                },
                                                                "scripts": [],
                                                                "createdAt": "2026-11-22T00:00:00Z",
                                                                "updatedAt": "2026-11-22T00:00:00Z",
                                                                "archivedAt": null
                                                            }],
                                                            "threads": [],
                                                            "archivedThreads": []
                                                        }
                                                    }),
                                                    json!({ "kind": "synchronized" }),
                                                ],
                                            };
                                            let _ = ws
                                                .send(Message::Text(
                                                    encode_server_frame(&chunk).into(),
                                                ))
                                                .await;
                                        }
                                        "projects.ensureScratch" => {
                                            let reply = FromServer::Exit {
                                                request_id: req.id,
                                                exit: Exit::success(json!({
                                                    "projectId": "proj-scratch"
                                                })),
                                            };
                                            let _ = ws
                                                .send(Message::Text(
                                                    encode_server_frame(&reply).into(),
                                                ))
                                                .await;
                                        }
                                        "orchestration.launchThread" => {
                                            let tid = req.payload["threadId"]
                                                .as_str()
                                                .unwrap_or("launched-1");
                                            let reply = FromServer::Exit {
                                                request_id: req.id,
                                                exit: Exit::success(json!({
                                                    "threadId": tid,
                                                    "sequence": 2
                                                })),
                                            };
                                            let _ = ws
                                                .send(Message::Text(
                                                    encode_server_frame(&reply).into(),
                                                ))
                                                .await;
                                        }
                                        _ => {}
                                    }
                                }
                            }
                        }
                        return;
                    }

                    let mut raw = Vec::new();
                    let mut tmp = [0u8; 4096];
                    loop {
                        let Ok(read_n) = tcp.read(&mut tmp).await else {
                            return;
                        };
                        if read_n == 0 {
                            break;
                        }
                        raw.extend_from_slice(&tmp[..read_n]);
                        if let Some(hdr_end) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
                            let headers = String::from_utf8_lossy(&raw[..hdr_end]);
                            let content_len = headers
                                .lines()
                                .find_map(|line| {
                                    let (name, val) = line.split_once(':')?;
                                    name.trim()
                                        .eq_ignore_ascii_case("content-length")
                                        .then(|| val.trim().parse::<usize>().ok())
                                        .flatten()
                                })
                                .unwrap_or(0);
                            if raw.len() >= hdr_end + 4 + content_len {
                                break;
                            }
                        }
                    }
                    let req_str = String::from_utf8_lossy(&raw);
                    let (status_line, body) = if req_str.starts_with("GET /api/auth/session") {
                        let expected_header = format!("authorization: bearer {valid_bearer}");
                        let authed = req_str
                            .lines()
                            .any(|line| line.eq_ignore_ascii_case(&expected_header));
                        (
                            "HTTP/1.1 200 OK",
                            json!({ "authenticated": authed }).to_string(),
                        )
                    } else if req_str.starts_with("POST /oauth/token") {
                        if req_str.contains(&format!("subject_token={expected_code}")) {
                            (
                                "HTTP/1.1 200 OK",
                                json!({ "access_token": issued_bearer }).to_string(),
                            )
                        } else {
                            (
                                "HTTP/1.1 401 Unauthorized",
                                json!({ "error": "invalid_credential" }).to_string(),
                            )
                        }
                    } else {
                        ("HTTP/1.1 404 Not Found", "{}".to_owned())
                    };
                    let resp = format!(
                        "{status_line}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = tcp.write_all(resp.as_bytes()).await;
                });
            }
        });

        (base_url, task)
    }

    #[test]
    fn maps_me_fleet_primary_agent_profiles_and_bound_profile() {
        let transport = MockGateway::new(|req| match (req.method, req.path.as_str()) {
            (GatewayMethod::Get, "/me") => Ok(GatewayResponse {
                status: 200,
                body: json!({
                    "data": {
                        "id": 12,
                        "name": "nick-iphone",
                        "wireguard_ip": "10.44.0.21",
                        "profile": {
                            "id": 7,
                            "name": "Nick",
                            "settings_version": 5,
                            "updated_at": "2026-11-22T10:00:00Z"
                        }
                    }
                })
                .to_string(),
            }),
            (GatewayMethod::Get, "/profiles") => Ok(GatewayResponse {
                status: 200,
                body: json!({
                    "data": [{
                        "id": 7,
                        "name": "Nick",
                        "settings_version": 5,
                        "updated_at": "2026-11-22T10:00:00Z"
                    }]
                })
                .to_string(),
            }),
            (GatewayMethod::Get, "/profiles/7/settings") => Ok(GatewayResponse {
                status: 200,
                body: json!({
                    "data": {
                        "profile_id": 7,
                        "version": 5,
                        "updated_at": "2026-11-22T10:00:00Z",
                        "settings": {
                            "workspaces": [{
                                "id": "ws-orbit",
                                "name": "Orbit",
                                "color": "blue",
                                "icon": "globe",
                                "image": null,
                                "projectRefs": ["env-1:/srv/workspace"],
                                "projectKeys": ["orbit"]
                            }],
                            "appearance": {
                                "schema": 1,
                                "mode": "dark",
                                "contrast": 50,
                                "themes": {
                                    "light": { "id": "t3-code", "source": "stock" },
                                    "dark": { "id": "dark-ocean", "source": "builtin" }
                                },
                                "customThemes": [{
                                    "id": "midnight",
                                    "name": "Midnight",
                                    "appearance": "dark",
                                    "colors": { "canvas": "#0b1220" }
                                }]
                            }
                        }
                    }
                })
                .to_string(),
            }),
            (GatewayMethod::Get, "/environments") => Ok(GatewayResponse {
                status: 200,
                body: json!({
                    "data": [
                        {
                            "environment_id": "node-mini",
                            "label": "mini",
                            "url": "http://10.44.0.8:3773",
                            "server_version": "0.1.9",
                            "registered_by": "mini",
                            "status": "registered",
                            "cleanup_pending": false,
                            "instance_id": null,
                            "roles": ["agent"]
                        },
                        {
                            "environment_id": "inst-42",
                            "label": "orbit / task-42",
                            "url": "http://10.44.0.7:3900",
                            "registered_by": "beast",
                            "status": "registered",
                            "cleanup_pending": false,
                            "instance_id": 42,
                            "instance_name": "task-42",
                            "project_id": 78,
                            "project_name": "Orbit",
                            "project_slug": "orbit",
                            "node_name": "beast",
                            "power_state": "running"
                        }
                    ]
                })
                .to_string(),
            }),
            other => panic!("unexpected gateway call: {other:?}"),
        });

        let orbit = OrbitCore::with_transport(transport).expect("OrbitCore");

        let me = futures::executor::block_on(orbit.me()).expect("me");
        assert_eq!(me.name, "nick-iphone", "node name mapped");
        assert_eq!(me.wireguard_ip, "10.44.0.21", "wireguard_ip mapped");
        assert_eq!(
            me.profile.as_ref().map(|p| p.id),
            Some(7),
            "bound profile id mapped"
        );

        let fleet = futures::executor::block_on(orbit.fleet()).expect("fleet");
        assert_eq!(fleet.len(), 2, "fleet includes node + instance");
        assert!(fleet[0].is_node, "node sorted first");
        assert!(fleet[0].has_agent_role, "agent role mapped");
        assert!(!fleet[0].is_local, "iOS has no local host node");
        assert_eq!(fleet[1].instance_id, Some(42), "instance id mapped");
        assert_eq!(
            fleet[1].power_state,
            Some(FfiOrbitPowerState::Running),
            "power state mapped"
        );

        let primary = futures::executor::block_on(orbit.primary_agent()).expect("primary_agent");
        assert_eq!(
            primary.as_ref().map(|e| e.server_id.as_str()),
            Some("node-mini"),
            "primary_agent uses select_primary_agent_node"
        );

        let profiles = futures::executor::block_on(orbit.profiles()).expect("profiles");
        assert_eq!(profiles.len(), 1, "profiles list mapped");

        let bound = futures::executor::block_on(orbit.bound_profile())
            .expect("bound_profile")
            .expect("profile is bound");
        assert_eq!(bound.profile.id, 7, "bound profile metadata mapped");
        assert_eq!(bound.settings.workspaces.len(), 1, "workspaces mapped");
        assert!(
            orbit_workspace_matches_project(
                bound.settings.workspaces[0].clone(),
                "p1".to_owned(),
                "Orbit".to_owned(),
                "/srv/workspace".to_owned(),
            ),
            "workspace_matches_project delegates to conn_orbit"
        );
        let appearance = bound
            .settings
            .appearance
            .expect("appearance section parsed");
        assert_eq!(
            appearance.mode,
            FfiOrbitAppearanceMode::Dark,
            "appearance mode mapped"
        );
        assert_eq!(
            appearance.light_theme_id, "t3-code-light",
            "stock light slot normalized"
        );
        assert_eq!(
            appearance.dark_theme_id, "dark-ocean",
            "builtin dark slot preserved"
        );
        assert_eq!(
            appearance.custom_themes.len(),
            1,
            "custom themes mapped with palette colors"
        );
        assert_eq!(
            appearance.custom_themes[0]
                .colors
                .get("canvas")
                .map(String::as_str),
            Some("#0b1220"),
            "custom theme color entry preserved"
        );
    }

    #[test]
    fn maps_tasks_board_insights_detail_and_error_scenarios_via_fixture_transport() {
        let transport = Arc::new(FixtureTransport::new(FixtureScenario::Default));
        let orbit = OrbitCore::with_transport(transport).expect("OrbitCore");

        let board = futures::executor::block_on(orbit.tasks_board(FfiTasksBoardQuery {
            project_id: None,
            search_query: Some("#482".to_owned()),
            hidden_lanes: vec![FfiTaskLane::Backlog],
            insights_period: Some(FfiInsightsPeriod::Month),
            limit: Some(50),
        }))
        .expect("tasks_board");

        assert_eq!(board.lanes.len(), 3, "hidden Backlog lane excluded");
        let in_progress = board
            .lanes
            .iter()
            .find(|l| l.id == FfiTaskLane::InProgress)
            .expect("InProgress lane");
        assert_eq!(in_progress.tasks.len(), 1, "search matched task #482");
        assert_eq!(in_progress.tasks[0].id, 482, "task 482 present");
        assert_eq!(
            in_progress.tasks[0].label.as_deref(),
            Some("Working"),
            "finer task label mapped"
        );
        assert_eq!(
            in_progress.tasks[0]
                .pull_request
                .as_ref()
                .map(|pr| pr.number),
            Some(1931),
            "PR link mapped"
        );
        let strip = board.insights.expect("insights strip populated");
        assert_eq!(strip.cards.len(), 8, "all 8 KPI insight cards mapped");

        let detail = futures::executor::block_on(orbit.task_detail(482)).expect("task_detail");
        assert_eq!(detail.summary.id, 482, "detail summary mapped");
        assert_eq!(detail.subtasks.len(), 4, "subtasks mapped in order");
        assert!(!detail.agents.is_empty(), "agents mapped");
        assert!(
            detail.agents[0].conversation.is_some(),
            "linked thread environment/thread id mapped on active agent"
        );
        assert_eq!(
            detail.subtasks[0].linked_thread, detail.agents[0].conversation,
            "subtask linked_thread resolved from implementer"
        );

        // Error scenario mapping.
        for (scenario, expected_reason) in [
            (FixtureScenario::NotANode, FfiOrbitErrorReason::NotANode),
            (
                FixtureScenario::AccessRequired,
                FfiOrbitErrorReason::AccessRequired,
            ),
            (
                FixtureScenario::ExtensionDisabled,
                FfiOrbitErrorReason::ExtensionDisabled,
            ),
            (
                FixtureScenario::Unreachable,
                FfiOrbitErrorReason::Unreachable,
            ),
        ] {
            let err_orbit = OrbitCore::with_transport(Arc::new(FixtureTransport::new(scenario)))
                .expect("error OrbitCore");
            let err =
                futures::executor::block_on(err_orbit.tasks_board(FfiTasksBoardQuery::default()))
                    .expect_err("expected scenario error");
            assert!(
                matches!(err, FfiError::Orbit { reason, .. } if reason == expected_reason),
                "scenario {scenario:?} expected {expected_reason:?}, got {err:?}"
            );
        }
    }

    #[test]
    fn connect_environment_reuses_valid_bearer_and_falls_back_to_mint_on_auth_failure() {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("test tokio rt");
        let (server_url, server_task) = rt.block_on(spawn_mock_conn_server(
            "good-bearer",
            "minted-pair-code",
            "fresh-bearer",
            "/srv/workspace",
        ));

        let mint_count = Arc::new(AtomicUsize::new(0));
        let mint_count_ref = Arc::clone(&mint_count);
        let url_for_gw = server_url;
        let transport = MockGateway::new(move |req| match req.path.as_str() {
            "/environments" => Ok(GatewayResponse {
                status: 200,
                body: json!({
                    "data": [{
                        "environment_id": "node-mini",
                        "label": "mini",
                        "url": url_for_gw,
                        "status": "registered",
                        "cleanup_pending": false,
                        "instance_id": null,
                        "roles": ["agent"]
                    }]
                })
                .to_string(),
            }),
            "/environments/node-mini/pairings" => {
                mint_count_ref.fetch_add(1, Ordering::SeqCst);
                Ok(GatewayResponse {
                    status: 200,
                    body: json!({
                        "data": {
                            "pairing_url": format!("{url_for_gw}/pair#token=minted-pair-code"),
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

        let orbit = OrbitCore::with_transport(transport).expect("OrbitCore");

        // 1. Valid cached bearer -> reused, zero pairing minted.
        let listener_valid = Arc::new(TestCoreListener::default());
        let core_valid = futures::executor::block_on(orbit.connect_environment(
            "node-mini".to_owned(),
            Some("good-bearer".to_owned()),
            listener_valid.clone(),
        ))
        .expect("connect with valid bearer");
        assert!(
            listener_valid.wait_for(Duration::from_secs(5), |s| s.connected),
            "ConnCore reached Connected with reused bearer"
        );
        assert_eq!(
            mint_count.load(Ordering::SeqCst),
            0,
            "valid cached bearer must not mint a pairing"
        );
        core_valid.disconnect();

        // 2. Stale/rejected cached bearer -> falls back to minting once, exchanges code, emits fresh bearer.
        let listener_fallback = Arc::new(TestCoreListener::default());
        let core_fallback = futures::executor::block_on(orbit.connect_environment(
            "node-mini".to_owned(),
            Some("stale-bearer".to_owned()),
            listener_fallback.clone(),
        ))
        .expect("connect fallback after rejected bearer");
        assert!(
            listener_fallback.wait_for(Duration::from_secs(5), |s| {
                s.connected && s.bearer.as_deref() == Some("fresh-bearer")
            }),
            "fallback pairing must issue fresh bearer and connect"
        );
        assert_eq!(
            mint_count.load(Ordering::SeqCst),
            1,
            "rejected cached bearer must trigger exactly one pairing mint"
        );
        core_fallback.disconnect();

        // 3. start_general_thread on the agent-role node -> calls projects.ensureScratch + launchThread.
        let listener_general = Arc::new(TestCoreListener::default());
        let started = futures::executor::block_on(orbit.start_general_thread(
            "Check cluster health".to_owned(),
            Some("good-bearer".to_owned()),
            listener_general,
        ))
        .expect("start_general_thread");
        assert_eq!(
            started.environment_id, "node-mini",
            "General thread lives on the agent-role node"
        );
        assert_eq!(
            started.project_id, "proj-scratch",
            "General thread targets projects.ensureScratch projectId"
        );
        assert!(
            !started.thread_id.is_empty(),
            "General thread returned non-empty thread id"
        );
        assert_eq!(
            started.instance_id, None,
            "General thread has no instance_id"
        );
        started.core.disconnect();

        server_task.abort();
    }

    #[test]
    fn start_project_thread_finalizes_reservation_and_launches_in_clone_workspace() {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("test tokio rt");
        let (server_url, server_task) = rt.block_on(spawn_mock_conn_server(
            "unused",
            "res-inline-code",
            "clone-bearer",
            ORBIT_CLONE_WORKSPACE,
        ));
        let url_for_gw = server_url;

        let transport = MockGateway::new(move |req| match (req.method, req.path.as_str()) {
            (GatewayMethod::Get, "/reservations/res-42") => Ok(GatewayResponse {
                status: 200,
                body: json!({
                    "data": {
                        "id": "res-42",
                        "project_id": 78,
                        "instance_id": 900,
                        "state": "ready",
                        "environment_id": "env-clone-900",
                        "pairing": {
                            "pairing_url": format!("{url_for_gw}/pair#token=res-inline-code"),
                            "pairing": {
                                "environment_id": "env-clone-900",
                                "expires_at": "2026-11-22T20:00:00Z"
                            }
                        }
                    }
                })
                .to_string(),
            }),
            (GatewayMethod::Post, "/reservations/res-42/finalize") => Ok(GatewayResponse {
                status: 200,
                body: json!({
                    "data": {
                        "id": 77,
                        "kind": "instance.finalize",
                        "status": "succeeded",
                        "target_id": 900,
                        "result": { "branch": "fix-auth-a1b2c3" }
                    }
                })
                .to_string(),
            }),
            (GatewayMethod::Get, "/environments") => Ok(GatewayResponse {
                status: 200,
                body: json!({
                    "data": [{
                        "environment_id": "env-clone-900",
                        "label": "orbit / fix-auth-a1b2c3",
                        "url": url_for_gw,
                        "status": "registered",
                        "cleanup_pending": false,
                        "instance_id": 900,
                        "project_id": 78,
                        "power_state": "running"
                    }]
                })
                .to_string(),
            }),
            other => panic!("unexpected path: {other:?}"),
        });

        let orbit = OrbitCore::with_transport(transport).expect("OrbitCore");
        let listener = Arc::new(TestCoreListener::default());
        let started = futures::executor::block_on(orbit.start_project_thread(
            FfiOrbitProjectTarget::NewInstance {
                project_id: 78,
                instance_name: Some("fix-auth-a1b2c3".to_owned()),
                reservation_id: Some("res-42".to_owned()),
                branch: None,
            },
            "Fix auth bug".to_owned(),
            listener.clone(),
        ))
        .expect("start_project_thread");

        assert_eq!(
            started.environment_id, "env-clone-900",
            "project thread lives on finalized clone environment"
        );
        assert_eq!(
            started.project_id, "proj-1",
            "resolved /srv/workspace project"
        );
        assert_eq!(started.instance_id, Some(900), "instance_id returned");
        assert_eq!(
            started.instance_name.as_deref(),
            Some("fix-auth-a1b2c3"),
            "instance_name returned"
        );
        assert!(
            listener.wait_for(Duration::from_secs(5), |s| {
                s.bearer.as_deref() == Some("clone-bearer")
            }),
            "clone pairing issued bearer to listener"
        );
        started.core.disconnect();
        server_task.abort();
    }

    #[test]
    fn maps_projects_branches_reservations_and_wakes_stopped_existing_instance() {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("test tokio rt");
        let (server_url, server_task) = rt.block_on(spawn_mock_conn_server(
            "existing-bearer",
            "unused-code",
            "unused-fresh",
            ORBIT_CLONE_WORKSPACE,
        ));
        let url_for_gw = server_url;
        let wake_calls = Arc::new(AtomicUsize::new(0));
        let wake_calls_ref = Arc::clone(&wake_calls);
        let env_polls = Arc::new(AtomicUsize::new(0));
        let env_polls_ref = Arc::clone(&env_polls);

        let transport = MockGateway::new(move |req| {
            match (req.method, req.path.as_str()) {
            (GatewayMethod::Get, "/projects") => Ok(GatewayResponse {
                status: 200,
                body: json!({
                    "data": [{
                        "id": 78,
                        "slug": "conn",
                        "name": "Conn",
                        "node_id": 2,
                        "node_name": "mini",
                        "instance_domain_suffix": ".conn.orbit",
                        "cloneable": true,
                        "cloneable_reason": null,
                        "checks": [
                            { "key": "git", "label": "Git repo", "status": "pass", "code": null, "message": null }
                        ]
                    }]
                })
                .to_string(),
            }),
            (GatewayMethod::Get, "/projects/78/branches") => Ok(GatewayResponse {
                status: 200,
                body: json!({
                    "data": [
                        { "name": "main", "default": true, "pull_request": null, "instance": null },
                        {
                            "name": "feat/ios",
                            "default": false,
                            "pull_request": { "number": 42, "title": "iOS bridge", "url": "https://github.com/nckrtl/conn/pull/42" },
                            "instance": { "id": 901, "name": "existing-clone" }
                        }
                    ],
                    "meta": { "pull_requests_unavailable": false }
                })
                .to_string(),
            }),
            (GatewayMethod::Get, "/projects/78/instances/check") => Ok(GatewayResponse {
                status: 200,
                body: json!({
                    "data": {
                        "name": "fix-auth-a1b2c3",
                        "available": true,
                        "reason": null,
                        "domain": "fix-auth-a1b2c3.conn.orbit"
                    }
                })
                .to_string(),
            }),
            (GatewayMethod::Post, "/projects/78/reservations") => Ok(GatewayResponse {
                status: 200,
                body: json!({
                    "data": {
                        "id": "res-77",
                        "project_id": 78,
                        "instance_id": 902,
                        "state": "preparing",
                        "environment_id": null,
                        "expires_at": "2026-11-22T20:10:00Z"
                    }
                })
                .to_string(),
            }),
            (GatewayMethod::Get, "/reservations/res-77") => Ok(GatewayResponse {
                status: 200,
                body: json!({
                    "data": {
                        "id": "res-77",
                        "project_id": 78,
                        "instance_id": 902,
                        "state": "ready",
                        "environment_id": "env-902",
                        "expires_at": "2026-11-22T20:10:00Z",
                        "pairing": {
                            "pairing_url": format!("{url_for_gw}/pair#token=res-77-code"),
                            "pairing": {
                                "environment_id": "env-902",
                                "expires_at": "2026-11-22T20:10:00Z"
                            }
                        }
                    }
                })
                .to_string(),
            }),
            (GatewayMethod::Delete, "/reservations/res-77") => Ok(GatewayResponse {
                status: 200,
                body: json!({ "data": { "operation_id": 55 } }).to_string(),
            }),
            (GatewayMethod::Get, "/environments") => {
                let n = env_polls_ref.fetch_add(1, Ordering::SeqCst);
                let power = if n == 0 { "stopped" } else { "running" };
                Ok(GatewayResponse {
                    status: 200,
                    body: json!({
                        "data": [{
                            "environment_id": "env-existing-901",
                            "label": "conn / existing-clone",
                            "url": url_for_gw,
                            "status": "registered",
                            "cleanup_pending": false,
                            "instance_id": 901,
                            "project_id": 78,
                            "power_state": power
                        }]
                    })
                    .to_string(),
                })
            }
            (GatewayMethod::Post, "/instances/901/wake") => {
                wake_calls_ref.fetch_add(1, Ordering::SeqCst);
                Ok(GatewayResponse {
                    status: 200,
                    body: json!({ "data": { "operation_id": 88 } }).to_string(),
                })
            }
            (GatewayMethod::Get, "/operations/88") => Ok(GatewayResponse {
                status: 200,
                body: json!({
                    "data": {
                        "id": 88,
                        "kind": "instance.wake",
                        "status": "succeeded"
                    }
                })
                .to_string(),
            }),
            other => panic!("unexpected path: {other:?}"),
        }
        });

        let orbit = OrbitCore::with_transport(transport).expect("OrbitCore");

        let projects = futures::executor::block_on(orbit.projects()).expect("projects");
        assert_eq!(projects.len(), 1, "projects mapped");
        assert_eq!(projects[0].slug, "conn");
        assert!(projects[0].startable, "startable flag mapped");
        assert_eq!(projects[0].checks.len(), 1, "readiness checks mapped");

        let branches =
            futures::executor::block_on(orbit.project_branches(78, None)).expect("branches");
        assert_eq!(branches.branches.len(), 2);
        assert!(branches.branches[0].is_default);
        assert_eq!(
            branches.branches[1]
                .pull_request
                .as_ref()
                .map(|pr| pr.number),
            Some(42)
        );
        assert_eq!(
            branches.branches[1].instance.as_ref().map(|i| i.id),
            Some(901)
        );

        let check = futures::executor::block_on(
            orbit.check_instance_name(78, "fix-auth-a1b2c3".to_owned()),
        )
        .expect("check_instance_name");
        assert!(check.available);
        assert_eq!(check.name, "fix-auth-a1b2c3");
        assert_eq!(check.domain.as_deref(), Some("fix-auth-a1b2c3.conn.orbit"));

        assert_eq!(
            orbit_derive_instance_name("Fix auth bug".to_owned(), "a1b2c3".to_owned()),
            "fix-auth-bug-a1b2c3"
        );

        let res = futures::executor::block_on(orbit.reserve_project(78)).expect("reserve");
        assert_eq!(res.state, FfiOrbitReservationState::Preparing);
        let ready =
            futures::executor::block_on(orbit.get_reservation("res-77".to_owned())).expect("poll");
        assert_eq!(ready.state, FfiOrbitReservationState::Ready);
        assert!(ready.has_pairing, "inline pairing cached");
        let rel_op = futures::executor::block_on(orbit.release_reservation("res-77".to_owned()))
            .expect("release");
        assert_eq!(rel_op, Some(55));

        let listener = Arc::new(TestCoreListener::default());
        let started = futures::executor::block_on(orbit.start_project_thread(
            FfiOrbitProjectTarget::ExistingInstance {
                environment_id: "env-existing-901".to_owned(),
                cached_bearer: Some("existing-bearer".to_owned()),
            },
            "Continue work".to_owned(),
            listener,
        ))
        .expect("start_project_thread existing instance");
        assert_eq!(
            wake_calls.load(Ordering::SeqCst),
            1,
            "stopped existing instance was woken before connect"
        );
        assert_eq!(started.environment_id, "env-existing-901");
        assert_eq!(started.project_id, "proj-1");
        assert_eq!(started.instance_id, Some(901));
        started.core.disconnect();

        server_task.abort();
    }

    #[test]
    fn realtime_subscription_delivers_tasks_status_fleet_and_profile_callbacks() {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("reverb test rt");
        let (ws_url, server_task) = rt.block_on(async {
            let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind reverb");
            let addr = listener.local_addr().expect("reverb addr");
            let task = tokio::spawn(async move {
                let Ok((stream, _)) = listener.accept().await else {
                    return;
                };
                let Ok(mut ws) = accept_async(stream).await else {
                    return;
                };
                let frame = |event: &str, data: Value, channel: Option<&str>| {
                    let mut msg = json!({ "event": event, "data": data.to_string() });
                    if let Some(ch) = channel {
                        msg["channel"] = json!(ch);
                    }
                    Message::Text(msg.to_string().into())
                };
                let _ = ws
                    .send(frame(
                        "pusher:connection_established",
                        json!({ "socket_id": "12.34" }),
                        None,
                    ))
                    .await;
                while let Some(Ok(Message::Text(text))) = ws.next().await {
                    let v: Value = serde_json::from_str(&text).unwrap_or_default();
                    if v["event"] == "pusher:subscribe" {
                        break;
                    }
                }
                let _ = ws
                    .send(frame(
                        "pusher_internal:subscription_succeeded",
                        json!({}),
                        Some("private-orbit"),
                    ))
                    .await;
                let _ = ws
                    .send(frame(
                        "node.updated",
                        json!({ "id": 1 }),
                        Some("private-orbit"),
                    ))
                    .await;
                let _ = ws
                    .send(frame(
                        "conn.profile.updated",
                        json!({ "id": 7 }),
                        Some("private-orbit"),
                    ))
                    .await;
                tokio::time::sleep(Duration::from_secs(5)).await;
            });
            (format!("ws://{addr}"), task)
        });

        let transport = MockGateway::new(move |req| {
            let body = if req.path == "/realtime" {
                json!({ "data": { "url": ws_url, "key": "k" } })
            } else {
                json!({ "auth": "sig" })
            };
            Ok(GatewayResponse {
                status: 200,
                body: body.to_string(),
            })
        });

        #[derive(Default)]
        struct RecordedOrbit {
            tasks_changed: usize,
            live_seen: bool,
            fleet_changed: usize,
            profile_changed: usize,
        }
        #[derive(Default)]
        struct TestOrbitListener {
            inner: Mutex<RecordedOrbit>,
            notify: Condvar,
        }
        impl OrbitListener for TestOrbitListener {
            fn on_tasks_changed(&self, _task_id: Option<i64>) {
                if let Ok(mut g) = self.inner.lock() {
                    g.tasks_changed += 1;
                    self.notify.notify_all();
                }
            }
            fn on_realtime_status(&self, status: FfiTasksLiveStatus) {
                if let Ok(mut g) = self.inner.lock() {
                    if status == FfiTasksLiveStatus::Live {
                        g.live_seen = true;
                    }
                    self.notify.notify_all();
                }
            }
            fn on_fleet_changed(&self) {
                if let Ok(mut g) = self.inner.lock() {
                    g.fleet_changed += 1;
                    self.notify.notify_all();
                }
            }
            fn on_profile_changed(&self) {
                if let Ok(mut g) = self.inner.lock() {
                    g.profile_changed += 1;
                    self.notify.notify_all();
                }
            }
        }

        let orbit = OrbitCore::with_transport(transport).expect("OrbitCore");
        let listener = Arc::new(TestOrbitListener::default());
        orbit.start_realtime(listener.clone());

        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let mut guard = listener.inner.lock().expect("lock");
        while !(guard.live_seen
            && guard.tasks_changed > 0
            && guard.fleet_changed > 0
            && guard.profile_changed > 0)
        {
            let Some(rem) = deadline.checked_duration_since(std::time::Instant::now()) else {
                break;
            };
            let (next, res) = listener.notify.wait_timeout(guard, rem).expect("wait");
            guard = next;
            if res.timed_out() {
                break;
            }
        }
        assert!(guard.live_seen, "realtime status reached Live");
        assert!(guard.tasks_changed > 0, "on_tasks_changed fired");
        assert!(guard.fleet_changed > 0, "on_fleet_changed fired");
        assert!(guard.profile_changed > 0, "on_profile_changed fired");
        drop(guard);

        orbit.stop_realtime();
        server_task.abort();
    }
}
