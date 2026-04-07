use std::path::PathBuf;

use rusqlite::params;

use crate::config::ServerRuntimeConfig;
use crate::persistence::{run_migrations, SqliteDb};
use crate::AppState;

#[test]
fn migrations_create_core_tables() {
    let dir = tempfile::tempdir().expect("temp dir");
    let db_path = dir.path().join("state.sqlite3");

    let db = SqliteDb::open_and_migrate(&db_path).expect("db open");
    db.with_conn_blocking(|conn| {
        let exists: i64 = conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='orchestration_events'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(exists, 1);

        let exists: i64 = conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='projection_threads'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(exists, 1);

        Ok(())
    })
    .expect("schema checks");
}

#[tokio::test]
async fn app_state_bootstraps_snapshot_from_sqlite() {
    let dir = tempfile::tempdir().expect("temp dir");
    let web_dist_dir = dir.path().join("web-dist");
    std::fs::create_dir_all(&web_dist_dir).expect("web dist");
    std::fs::write(web_dist_dir.join("index.html"), "<html></html>").expect("index");

    let db_path = dir.path().join("state.sqlite3");
    let db = SqliteDb::open_and_migrate(&db_path).expect("db open");

    let project_id = "project-1";
    let thread_id = "thread-1";

    db.with_conn_blocking(|conn| {
        conn.execute(
            "INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at, default_model_selection_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, NULL)",
            params![
                project_id,
                "Demo",
                "/tmp/workspace",
                "[]",
                "2026-04-07T00:00:00Z",
                "2026-04-07T00:00:00Z"
            ],
        )?;

        conn.execute(
            "INSERT INTO projection_threads (thread_id, project_id, title, branch, worktree_path, latest_turn_id, created_at, updated_at, deleted_at, runtime_mode, interaction_mode, model_selection_json, archived_at)
             VALUES (?1, ?2, ?3, NULL, NULL, NULL, ?4, ?5, NULL, ?6, ?7, ?8, NULL)",
            params![
                thread_id,
                project_id,
                "Thread",
                "2026-04-07T00:00:00Z",
                "2026-04-07T00:00:00Z",
                "full-access",
                "default",
                r#"{"provider":"codex","model":"gpt-5.4","options":null}"#
            ],
        )?;

        Ok(())
    })
    .expect("seed rows");

    let state = AppState::new(ServerRuntimeConfig {
        cwd: PathBuf::from(env!("CARGO_MANIFEST_DIR")),
        web_dist_dir,
        ws_token: "secret-token".to_owned(),
        logs_dir: dir.path().join("logs"),
        db_path,
    })
    .expect("app state");

    let snapshot = state.snapshot().await;
    assert_eq!(snapshot.projects.len(), 1);
    assert_eq!(snapshot.threads.len(), 1);
    assert_eq!(snapshot.projects[0].id, project_id);
    assert_eq!(snapshot.threads[0].id, thread_id);
}

#[test]
fn migration_summary_only_reports_newly_applied_steps() {
    let dir = tempfile::tempdir().expect("temp dir");
    let db_path = dir.path().join("state.sqlite3");
    let mut conn = rusqlite::Connection::open(db_path).expect("open sqlite");

    let first = run_migrations(&mut conn).expect("first migration run");
    assert_eq!(first.applied.len(), 19);
    assert_eq!(first.applied.first().map(|(v, _)| *v), Some(1));
    assert_eq!(first.applied.last().map(|(v, _)| *v), Some(19));

    let second = run_migrations(&mut conn).expect("second migration run");
    assert!(second.applied.is_empty());
}

#[tokio::test]
async fn app_state_fails_bootstrap_on_invalid_projection_json() {
    let dir = tempfile::tempdir().expect("temp dir");
    let web_dist_dir = dir.path().join("web-dist");
    std::fs::create_dir_all(&web_dist_dir).expect("web dist");
    std::fs::write(web_dist_dir.join("index.html"), "<html></html>").expect("index");

    let db_path = dir.path().join("state.sqlite3");
    let db = SqliteDb::open_and_migrate(&db_path).expect("db open");

    db.with_conn_blocking(|conn| {
        conn.execute(
            "INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at, default_model_selection_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, NULL)",
            params![
                "project-1",
                "Demo",
                "/tmp/workspace",
                "{not-valid-json",
                "2026-04-07T00:00:00Z",
                "2026-04-07T00:00:00Z"
            ],
        )?;

        Ok(())
    })
    .expect("seed invalid row");

    let err = AppState::new(ServerRuntimeConfig {
        cwd: PathBuf::from(env!("CARGO_MANIFEST_DIR")),
        web_dist_dir,
        ws_token: "secret-token".to_owned(),
        logs_dir: dir.path().join("logs"),
        db_path,
    })
    .expect_err("bootstrap should fail for invalid json");

    assert!(
        err.to_string().contains("invalid projection_projects.scripts_json"),
        "unexpected error: {err:#}"
    );
}
