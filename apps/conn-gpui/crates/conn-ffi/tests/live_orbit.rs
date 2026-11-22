//! Read-only live smoke test against the Orbit Gateway (`https://gateway.orbit`).
//!
//! Strictly read-only (`me`, `fleet`, `primary_agent`, `projects`, `tasks_board`) — never mints
//! pairings, starts threads, or mutates Gateway state. Gated behind `CONN_FFI_LIVE_ORBIT=1` and
//! `#[ignore]` so `cargo test --workspace` stays offline-safe.
//!
//! Run manually on an Orbit Node Mac:
//! `CONN_FFI_LIVE_ORBIT=1 cargo test -p conn-ffi --test live_orbit -- --ignored --nocapture`

use conn_ffi::{FfiTasksBoardQuery, OrbitCore};

#[test]
#[ignore = "needs live Orbit Gateway; set CONN_FFI_LIVE_ORBIT=1"]
#[expect(
    clippy::panic_in_result_fn,
    reason = "live smoke test prints summary counts and asserts reachability"
)]
fn reads_me_fleet_primary_agent_projects_and_tasks_board() -> Result<(), Box<dyn std::error::Error>>
{
    if std::env::var("CONN_FFI_LIVE_ORBIT").as_deref() != Ok("1") {
        return Ok(());
    }

    let orbit = OrbitCore::new(None)?;

    let me = futures::executor::block_on(orbit.me())?;
    let fleet = futures::executor::block_on(orbit.fleet())?;
    let primary = futures::executor::block_on(orbit.primary_agent())?;
    let projects = futures::executor::block_on(orbit.projects())?;
    let board = futures::executor::block_on(orbit.tasks_board(FfiTasksBoardQuery::default()))?;

    let node_count = fleet.iter().filter(|e| e.is_node).count();
    let instance_count = fleet.len().saturating_sub(node_count);
    let lane_counts: Vec<(String, u32)> = board
        .lanes
        .iter()
        .map(|lane| (lane.label.clone(), lane.total))
        .collect();
    let total_tasks: u32 = lane_counts.iter().map(|(_, n)| *n).sum();
    let insight_cards = board.insights.as_ref().map_or(0, |strip| strip.cards.len());

    println!(
        "live orbit smoke: me.has_profile={}, fleet={} ({} nodes, {} instances), primary_agent_found={}, projects={}, tasks={} (lanes={:?}), insight_cards={}",
        me.profile.is_some(),
        fleet.len(),
        node_count,
        instance_count,
        primary.is_some(),
        projects.len(),
        total_tasks,
        lane_counts,
        insight_cards,
    );

    assert!(
        !me.name.is_empty(),
        "Orbit Gateway /me must return a non-empty node name"
    );
    Ok(())
}
