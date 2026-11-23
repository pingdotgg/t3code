//! Desktop Orbit integration: thin re-export of [`conn_orbit`] plus desktop-only Tasks panel
//! state, click-navigation guards, and local Application Support file storage.
//!
//! Pure Orbit Gateway transport, wire decoders, realtime follower, and domain logic live in
//! `crates/conn-orbit` so both `conn-gpui` (macOS) and the SwiftUI iOS client (via UniFFI) share
//! one client. This module keeps the existing `conn_desktop::orbit::*` paths working for
//! `conn-app` without requiring call-site rewrites.

pub mod linked_store;
pub mod navigation;
pub mod panel;
pub mod storage;

pub use conn_orbit::{
    APPEARANCE_SECTION, DESKTOP_DEVICE_SECTION, GatewayError, GatewayRequest, GatewayResponse,
    GatewayTransport, InsightsPeriod, OrbitEnvironment, OrbitFleet, OrbitFleetClient, OrbitGateway,
    OrbitNode, OrbitPairingTicket, OrbitProfile, OrbitProfileClient, OrbitProfileSettings,
    OrbitProject, OrbitProjectsClient, OrbitRealtimeEvent, OrbitServerTarget, OrbitSyncPrefs,
    OrbitTargetKind, OrbitTargetStatus, OrbitTasksClient, OrbitWorkspace, PROFILE_SCHEMA_VERSION,
    ProfileAppearance, ProfileAppearanceMode, ProfileCustomTheme, ProfileDeviceSection,
    ProfileError, ProfileResult, ProfileThemeAppearance, ProfileThemeSlot, ProfileThemeSlots,
    SectionMeta, SectionPatch, TaskDetail, TaskInsights, TaskInsightsQuery, TaskLane, TaskSummary,
    TasksError, TasksErrorReason, TasksFollower, TasksInvalidation, TasksListQuery,
    TasksLiveStatus, TasksPage, TasksResult, ThemeSlotSource, board, client, decode_projects,
    detail, extract_section, find_project, find_project_by_name, find_project_by_slug, fixtures,
    fleet, follow_orbit_tasks, format, gateway, insights, linked, merge_appearance,
    merge_device_section, merge_workspaces, orbit_realtime_event, parse_profile_appearance,
    parse_profile_device_section, profile, projects, realtime, same_workspaces,
    select_primary_agent_node, tasks, to_gateway_form, workspace_editor, workspace_matches_project,
};
pub use linked_store::{LinkedEnvironmentSettings, LinkedStore};
pub use storage::{CachedOrbitSession, OrbitSessionStore, OrbitSyncSnapshot};
