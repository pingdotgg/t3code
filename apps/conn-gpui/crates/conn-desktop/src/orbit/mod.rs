//! Orbit Tasks: the Gateway client, the Tasks reads, realtime updates, and the pure logic the
//! Tasks panel renders from.
//!
//! Ports Conn's desktop `orbitGateway.ts` IPC method, the shared `client-runtime` Tasks client
//! (`tasks.ts`, `tasksWire.ts`, `tasksClient.ts`, `taskInsights.ts`, `tasksRealtime.ts`), and the
//! renderer logic under `apps/web/src/orbit/tasks/`.
//!
//! Typical use from the app's Tokio runtime:
//!
//! ```no_run
//! # async fn demo() -> Result<(), Box<dyn std::error::Error>> {
//! use conn_desktop::orbit::{InsightsPeriod, OrbitTasksClient, TaskInsightsQuery, TasksListQuery};
//! let client = OrbitTasksClient::live()?;
//! let page = client.list_tasks(&TasksListQuery { limit: Some(100), ..Default::default() }).await?;
//! let lanes = conn_desktop::orbit::board::tasks_board_lanes(&page.tasks, "", &[]);
//! let insights = client
//!     .get_task_insights(TaskInsightsQuery { period: InsightsPeriod::Month, project: None })
//!     .await?;
//! # let _ = (lanes, insights);
//! # Ok(()) }
//! ```

pub mod board;
pub mod client;
pub mod detail;
pub mod fixtures;
pub mod fleet;
pub mod format;
pub mod gateway;
pub mod insights;
pub mod navigation;
pub mod panel;
pub mod profile;
pub mod projects;
pub mod realtime;
pub mod tasks;

pub use client::{OrbitTasksClient, TasksError, TasksErrorReason, TasksInvalidation, TasksResult};
pub use fleet::{
    CachedOrbitSession, OrbitFleet, OrbitFleetClient, OrbitPairingTicket, OrbitServerTarget,
    OrbitSessionStore, OrbitTargetKind, OrbitTargetStatus,
};
pub use gateway::{GatewayError, GatewayRequest, GatewayResponse, GatewayTransport, OrbitGateway};
pub use profile::{
    APPEARANCE_SECTION, DESKTOP_DEVICE_SECTION, OrbitNode, OrbitProfile, OrbitProfileClient,
    OrbitProfileSettings, OrbitSyncPrefs, OrbitSyncSnapshot, OrbitWorkspace,
    PROFILE_SCHEMA_VERSION, ProfileAppearance, ProfileAppearanceMode, ProfileCustomTheme,
    ProfileDeviceSection, ProfileError, ProfileResult, ProfileThemeAppearance, ProfileThemeSlot,
    ProfileThemeSlots, SectionMeta, SectionPatch, ThemeSlotSource, extract_section,
    merge_appearance, merge_device_section, merge_workspaces, parse_profile_appearance,
    parse_profile_device_section, same_workspaces, to_gateway_form, workspace_matches_project,
};
pub use projects::{
    OrbitProject, OrbitProjectsClient, decode_projects, find_project, find_project_by_name,
    find_project_by_slug,
};
pub use realtime::{
    OrbitRealtimeEvent, TasksFollower, TasksLiveStatus, follow_orbit_tasks, orbit_realtime_event,
};
pub use tasks::{
    InsightsPeriod, OrbitEnvironment, TaskDetail, TaskInsights, TaskInsightsQuery, TaskLane,
    TaskSummary, TasksListQuery, TasksPage,
};

/// Live checks against `https://gateway.orbit`, read-only GETs only. Run on a Mac that is an
/// Orbit Node with the Orbit root CA in its keychain:
/// `cargo test -p conn-desktop orbit::live -- --ignored --nocapture`.
#[cfg(test)]
mod live {
    use super::insights::{InsightId, format_insight_value, insight_result, insight_trend};
    use super::*;

    fn client() -> OrbitTasksClient {
        match OrbitTasksClient::live() {
            Ok(client) => client,
            Err(error) => panic!("client: {error}"),
        }
    }

    #[tokio::test]
    #[ignore = "needs the live Orbit Gateway"]
    async fn reads_orbit_profile_and_settings() {
        let client = match OrbitProfileClient::live() {
            Ok(client) => client,
            Err(error) => panic!("profile client: {error}"),
        };
        let node = match client.me().await {
            Ok(node) => node,
            Err(error) => panic!("me: {error}"),
        };
        let profiles = client.profiles().await.unwrap_or_default();
        println!(
            "orbit node: {} ({}), profiles: {}, bound: {:?}",
            node.name,
            node.wireguard_ip,
            profiles.len(),
            node.profile.as_ref().map(|p| (&p.name, p.id))
        );
        let fleet_client = match OrbitFleetClient::live() {
            Ok(client) => client,
            Err(error) => panic!("fleet client: {error}"),
        };
        let fleet = match fleet_client.list_fleet(Some(&node.name)).await {
            Ok(fleet) => fleet,
            Err(error) => panic!("list_fleet: {error}"),
        };
        println!(
            "orbit fleet: {} nodes ({:?}), {} instances ({} running)",
            fleet.nodes.len(),
            fleet
                .nodes
                .iter()
                .map(|n| n.label.as_str())
                .collect::<Vec<_>>(),
            fleet.instances.len(),
            fleet.running_instance_count()
        );
        if let Some(profile) = node.profile {
            let settings = match client.settings(profile.id).await {
                Ok(settings) => settings,
                Err(error) => panic!("settings: {error}"),
            };
            let custom_count = extract_section(&settings, APPEARANCE_SECTION)
                .and_then(|m| parse_profile_appearance(&serde_json::Value::Object(m)))
                .map_or(0, |a| a.custom_themes.len());
            println!(
                "profile settings v{}: {} workspaces, {} custom themes, sections: {:?}",
                settings.version,
                settings.workspaces.len(),
                custom_count,
                settings
                    .sections
                    .as_ref()
                    .map(|s| s.keys().collect::<Vec<_>>())
            );
        }
    }

    #[tokio::test]
    #[ignore = "needs the live Orbit Gateway"]
    async fn trusts_the_keychain_root_and_reads_me() {
        let gateway = match OrbitGateway::new() {
            Ok(gateway) => gateway,
            Err(error) => panic!("gateway: {error}"),
        };
        let response = gateway.send(&GatewayRequest::get("/me")).await;
        assert_eq!(response.map(|r| r.status), Ok(200));
    }

    #[tokio::test]
    #[ignore = "needs the live Orbit Gateway"]
    async fn reads_the_board_detail_insights_and_environments() {
        let client = client();
        let page = client
            .list_tasks(&TasksListQuery {
                limit: Some(100),
                ..TasksListQuery::default()
            })
            .await;
        let page = match page {
            Ok(page) => page,
            Err(error) => panic!("list: {error:?}"),
        };
        let lanes = board::tasks_board_lanes(&page.tasks, "", &[]);
        println!(
            "board: {} tasks, {} skipped, next cursor {}, lanes {:?}",
            page.tasks.len(),
            page.skipped,
            page.next_cursor.is_some(),
            lanes.iter().map(|l| (l.label, l.total)).collect::<Vec<_>>()
        );
        assert!(!page.tasks.is_empty());

        let detail = match client.get_task(page.tasks[0].id).await {
            Ok(detail) => detail,
            Err(error) => panic!("detail: {error:?}"),
        };
        println!(
            "detail: {} subtasks, {} agents",
            detail.subtasks.len(),
            detail.agents.len()
        );

        for period in InsightsPeriod::ALL {
            let insights = client
                .get_task_insights(TaskInsightsQuery {
                    period,
                    project: None,
                })
                .await;
            let insights = match insights {
                Ok(insights) => insights,
                Err(error) => panic!("insights {}: {error:?}", period.as_str()),
            };
            let reported = insights::INSIGHTS
                .iter()
                .filter(|spec| insight_result(Some(&insights), spec.id).value.is_some())
                .count();
            let trend = insight_trend(Some(&insights), InsightId::Completed).map_or(0, |t| t.len());
            let tokens = insight_result(Some(&insights), InsightId::Spent)
                .value
                .map(|v| format_insight_value(InsightId::Spent, v));
            println!(
                "insights {}: {} of 8 numbers reported, {} daily, {} hourly, {} weekly, {} models, completed trend {} points, tokens shown as {:?}",
                period.as_str(),
                reported,
                insights.daily.len(),
                insights.hourly.len(),
                insights.weekly.len(),
                insights.by_model.len(),
                trend,
                tokens.map(|t| t.chars().any(|c| c.is_ascii_digit()))
            );
        }

        match client.environments().await {
            Ok(environments) => println!("environments: {}", environments.len()),
            Err(error) => println!("environments: {:?}", error.reason),
        }
    }

    /// Opens the Reverb socket (GET discovery plus the wss handshake, no channel auth) and waits
    /// for `pusher:connection_established`, proving the socket trusts the keychain root too.
    #[tokio::test]
    #[ignore = "needs the live Orbit Gateway"]
    async fn opens_the_realtime_socket() {
        use futures::StreamExt;
        let client = client();
        let socket = realtime::open_socket(&*client.transport()).await;
        let Some(mut socket) = socket else {
            panic!("no realtime socket");
        };
        let first = tokio::time::timeout(std::time::Duration::from_secs(10), socket.next()).await;
        let text = match first {
            Ok(Some(Ok(message))) => message
                .into_text()
                .map(|t| t.to_string())
                .unwrap_or_default(),
            other => panic!("no first frame: {other:?}"),
        };
        assert!(text.contains("pusher:connection_established"), "{text}");
        println!("realtime: connection established");
    }
}
