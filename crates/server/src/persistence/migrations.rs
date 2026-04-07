#![warn(clippy::all, clippy::pedantic)]

use rusqlite::Connection;
use rusqlite_migration::{Migrations, M};

#[derive(Clone, Debug)]
pub struct MigrationSummary {
    pub applied: Vec<(i32, &'static str)>,
}

const MIGRATION_NAMES: &[&str] = &[
    "OrchestrationEvents",
    "OrchestrationCommandReceipts",
    "CheckpointDiffBlobs",
    "ProviderSessionRuntime",
    "Projections",
    "ProjectionThreadSessionRuntimeModeColumns",
    "ProjectionThreadMessageAttachments",
    "ProjectionThreadActivitySequence",
    "ProviderSessionRuntimeMode",
    "ProjectionThreadsRuntimeMode",
    "OrchestrationThreadCreatedRuntimeMode",
    "ProjectionThreadsInteractionMode",
    "ProjectionThreadProposedPlans",
    "ProjectionThreadProposedPlanImplementation",
    "ProjectionTurnsSourceProposedPlan",
    "CanonicalizeModelSelections",
    "ProjectionThreadsArchivedAt",
    "ProjectionThreadsArchivedAtIndex",
    "ProjectionSnapshotLookupIndexes",
];
pub const MIGRATION_COUNT: usize = MIGRATION_NAMES.len();

/// Runs the full `SQLite` migration set (1-19) against `conn`.
///
/// # Errors
///
/// Returns an error if any migration fails to apply.
pub fn run_migrations(conn: &mut Connection) -> anyhow::Result<MigrationSummary> {
    use anyhow::Context;

    let migrations = Migrations::new(vec![
        M::up(include_str!("sql/001_orchestration_events.sql")),
        M::up(include_str!("sql/002_orchestration_command_receipts.sql")),
        M::up(include_str!("sql/003_checkpoint_diff_blobs.sql")),
        M::up(include_str!("sql/004_provider_session_runtime.sql")),
        M::up(include_str!("sql/005_projections.sql")),
        M::up(include_str!(
            "sql/006_projection_thread_session_runtime_mode_columns.sql"
        )),
        M::up(include_str!(
            "sql/007_projection_thread_message_attachments.sql"
        )),
        M::up(include_str!(
            "sql/008_projection_thread_activity_sequence.sql"
        )),
        M::up(include_str!("sql/009_provider_session_runtime_mode.sql")),
        M::up(include_str!("sql/010_projection_threads_runtime_mode.sql")),
        M::up(include_str!(
            "sql/011_orchestration_thread_created_runtime_mode.sql"
        )),
        M::up(include_str!(
            "sql/012_projection_threads_interaction_mode.sql"
        )),
        M::up(include_str!("sql/013_projection_thread_proposed_plans.sql")),
        M::up(include_str!(
            "sql/014_projection_thread_proposed_plan_implementation.sql"
        )),
        M::up(include_str!(
            "sql/015_projection_turns_source_proposed_plan.sql"
        )),
        M::up(include_str!("sql/016_canonicalize_model_selections.sql")),
        M::up(include_str!("sql/017_projection_threads_archived_at.sql")),
        M::up(include_str!(
            "sql/018_projection_threads_archived_at_index.sql"
        )),
        M::up(include_str!(
            "sql/019_projection_snapshot_lookup_indexes.sql"
        )),
    ]);

    let previous_version = conn
        .pragma_query_value(None, "user_version", |row| row.get::<_, i32>(0))
        .context("failed to read sqlite user_version before migrations")?;

    // Ensure the migrations bookkeeping table exists and apply pending migrations.
    migrations.to_latest(conn)?;

    let current_version = conn
        .pragma_query_value(None, "user_version", |row| row.get::<_, i32>(0))
        .context("failed to read sqlite user_version after migrations")?;

    let start = previous_version.max(0) + 1;
    let end = current_version.max(0);
    let applied = if start <= end {
        let mut applied = Vec::new();
        for version in start..=end {
            let index = usize::try_from(version - 1)
                .context("migration version could not be converted to index")?;
            if let Some(name) = MIGRATION_NAMES.get(index) {
                applied.push((version, *name));
            }
        }
        applied
    } else {
        Vec::new()
    };

    Ok(MigrationSummary { applied })
}
