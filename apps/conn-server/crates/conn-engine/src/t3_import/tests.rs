use std::path::{Path, PathBuf};

use rusqlite::Connection;
use serde_json::json;

use super::*;
use crate::store::Store;

const T3_SCHEMA: &str = include_str!("t3-schema.sql");

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("conn-t3-import-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

/// A T3 state file with one project, a live thread with a run, two messages and their turn
/// items, a deleted thread, and a fork whose context transfer names it as the target.
fn t3_state(dir: &Path) -> PathBuf {
    let path = dir.join(T3_STATE_FILE);
    let conn = Connection::open(&path).unwrap();
    conn.execute_batch(T3_SCHEMA).unwrap();
    conn.execute(
        "INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json,
           created_at, updated_at, deleted_at, default_model_selection_json, auto_pull,
           has_custom_title)
         VALUES ('p1', 'Repo', '/work/repo', '[]', '2026-01-01T00:00:00.000Z',
           '2026-01-02T00:00:00.000Z', NULL, '{\"instanceId\":\"codex\",\"model\":\"gpt\"}', 1, 1)",
        [],
    )
    .unwrap();
    let thread = |id: &str, deleted: Option<&str>| {
        let body = json!({
            "id": id, "projectId": "p1", "title": format!("Thread {id}"),
            "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-03T00:00:00.000Z",
            "archivedAt": null, "deletedAt": deleted,
            "lineage": {"parentThreadId": null, "relationshipToParent": null, "rootThreadId": id},
            "forkedFrom": null,
        });
        conn.execute(
            "INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title,
               default_provider, runtime_mode, interaction_mode, created_at, updated_at,
               deleted_at, payload_json)
             VALUES (?1, 'p1', ?2, 'codex', 'full-access', 'default', '2026-01-01T00:00:00.000Z',
               '2026-01-03T00:00:00.000Z', ?3, ?4)",
            rusqlite::params![id, body["title"].as_str(), deleted, body.to_string()],
        )
        .unwrap();
    };
    thread("t1", None);
    thread("t2", Some("2026-01-04T00:00:00.000Z"));
    thread("t3", None);
    let run = json!({"id": "r1", "threadId": "t1", "ordinal": 1, "status": "completed",
        "requestedAt": "2026-01-01T00:00:01.000Z", "startedAt": "2026-01-01T00:00:01.000Z",
        "completedAt": "2026-01-01T00:00:05.000Z"});
    conn.execute(
        "INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider,
           status, requested_at, completed_at, payload_json)
         VALUES ('r1', 't1', 1, 'codex', 'completed', '2026-01-01T00:00:01.000Z',
           '2026-01-01T00:00:05.000Z', ?1)",
        [run.to_string()],
    )
    .unwrap();
    // A gap in the run ordinals: T3 moves a queued run past newer ones when it starts it.
    let late = json!({"id": "r3", "threadId": "t1", "ordinal": 3, "status": "completed",
        "requestedAt": "2026-01-01T00:00:06.000Z"});
    conn.execute(
        "INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider,
           status, requested_at, payload_json)
         VALUES ('r3', 't1', 3, 'codex', 'completed', '2026-01-01T00:00:06.000Z', ?1)",
        [late.to_string()],
    )
    .unwrap();
    // A provider thread with no thread of its own, owned by a node of t1.
    conn.execute(
        "INSERT INTO orchestration_v2_projection_nodes (node_id, thread_id, run_id, root_node_id,
           kind, status, payload_json)
         VALUES ('n1', 't1', 'r1', 'n1', 'root_turn', 'completed', '{\"id\":\"n1\"}')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO orchestration_v2_projection_provider_threads (provider_thread_id, thread_id,
           owner_node_id, provider, status, updated_at, payload_json)
         VALUES ('pt-owned', NULL, 'n1', 'codex', 'active', '2026-01-01T00:00:05.000Z',
           '{\"id\":\"pt-owned\"}')",
        [],
    )
    .unwrap();
    // T3 gave out sequences far above the row count.
    conn.execute(
        "INSERT INTO orchestration_v2_projection_metadata (projection_name, schema_version,
           last_sequence, updated_at) VALUES ('thread-projections', 1, 900000, 'x')",
        [],
    )
    .unwrap();
    // Inserted out of order: T3 reads messages by `created_at`, turn items by `ordinal`.
    for (id, role, text, at, item, ordinal) in [
        (
            "m2",
            "assistant",
            "pong",
            "2026-01-01T00:00:04.000Z",
            "i2",
            7,
        ),
        ("m1", "user", "ping", "2026-01-01T00:00:02.000Z", "i1", 3),
    ] {
        let message = json!({"id": id, "threadId": "t1", "runId": "r1", "role": role,
            "text": text, "streaming": false, "createdAt": at, "updatedAt": at});
        conn.execute(
            "INSERT INTO orchestration_v2_projection_messages (message_id, thread_id, run_id,
               role, streaming, created_at, updated_at, payload_json)
             VALUES (?1, 't1', 'r1', ?2, 0, ?3, ?3, ?4)",
            rusqlite::params![id, role, at, message.to_string()],
        )
        .unwrap();
        let kind = format!("{role}_message");
        let body = json!({"id": item, "threadId": "t1", "runId": "r1", "ordinal": ordinal,
            "type": kind, "status": "completed", "messageId": id, "updatedAt": at});
        conn.execute(
            "INSERT INTO orchestration_v2_projection_turn_items (turn_item_id, thread_id, run_id,
               ordinal, type, status, updated_at, payload_json)
             VALUES (?1, 't1', 'r1', ?2, ?3, 'completed', ?4, ?5)",
            rusqlite::params![item, ordinal, kind, at, body.to_string()],
        )
        .unwrap();
    }
    // One provider session bound to two threads, and a detached one bound to none.
    for (id, status) in [("s1", "ready"), ("s-detached", "closed")] {
        let session = json!({"id": id, "status": status, "updatedAt": "2026-01-01T00:00:05.000Z"});
        conn.execute(
            "INSERT INTO orchestration_v2_projection_provider_sessions (provider_session_id,
               thread_id, provider, status, updated_at, payload_json)
             VALUES (?1, 't1', 'codex', ?2, '2026-01-01T00:00:05.000Z', ?3)",
            rusqlite::params![id, status, session.to_string()],
        )
        .unwrap();
    }
    for thread in ["t1", "t3"] {
        conn.execute(
            "INSERT INTO orchestration_v2_projection_provider_session_bindings
               (provider_session_id, thread_id) VALUES ('s1', ?1)",
            [thread],
        )
        .unwrap();
    }
    let transfer = json!({"id": "x1", "type": "fork", "sourceThreadId": "t1",
        "targetThreadId": "t3", "status": "consumed"});
    conn.execute(
        "INSERT INTO orchestration_v2_projection_context_transfers (context_transfer_id,
           source_thread_id, target_thread_id, type, status, source_provider, updated_at,
           payload_json)
         VALUES ('x1', 't1', 't3', 'fork', 'consumed', 'codex', '2026-01-01T00:00:06.000Z', ?1)",
        [transfer.to_string()],
    )
    .unwrap();
    path
}

fn checksum(path: &Path) -> Vec<u8> {
    fs::read(path).unwrap()
}

#[test]
fn imports_threads_projects_and_rows_once_and_leaves_t3_untouched() {
    let dir = temp_dir("once");
    let source = t3_state(&dir);
    let before = checksum(&source);

    let report = import_t3_state(&dir).unwrap().unwrap();
    assert_eq!(report.projects, 1);
    assert_eq!(report.threads, 3);
    let count = |kind: &str| {
        report
            .collections
            .iter()
            .find(|(k, _)| *k == kind)
            .map(|(_, n)| *n)
    };
    assert_eq!(count("runs"), Some(2));
    assert_eq!(count("messages"), Some(2));
    assert_eq!(count("turnItems"), Some(2));
    assert_eq!(count("contextTransfers"), Some(1));
    assert_eq!(count("providerSessions"), Some(2));
    assert_eq!(checksum(&source), before, "T3's file must not change");
    assert!(!dir.join("engine.sqlite.t3-import").exists());

    let store = Store::open(&dir.join(ENGINE_FILE)).unwrap();
    let shell = store.shell_snapshot().unwrap();
    let ids: Vec<&str> = shell["threads"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["id"].as_str().unwrap())
        .collect();
    assert_eq!(
        ids,
        ["t1", "t3"],
        "the deleted thread stays out of the shell"
    );
    assert_eq!(shell["projects"][0]["id"], "p1");
    assert_eq!(shell["projects"][0]["hasCustomTitle"], true);
    assert_eq!(shell["projects"][0]["autoPull"], true);
    assert_eq!(
        shell["projects"][0]["defaultModelSelection"]["model"],
        "gpt"
    );
    assert!(shell["projects"][0].get("deletedAt").is_none());

    let projection = store.thread_projection("t1").unwrap().unwrap();
    assert_eq!(projection["updatedAt"], "2026-01-03T00:00:00.000Z");
    let texts: Vec<&str> = projection["messages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["text"].as_str().unwrap())
        .collect();
    assert_eq!(texts, ["ping", "pong"]);
    let ordinals: Vec<i64> = projection["turnItems"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["ordinal"].as_i64().unwrap())
        .collect();
    assert_eq!(ordinals, [3, 7]);
    assert_eq!(projection["runs"][0]["status"], "completed");
    let provider_threads: Vec<&str> = projection["providerThreads"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["id"].as_str().unwrap())
        .collect();
    assert_eq!(provider_threads, ["pt-owned"], "owned through its node");
    assert!(store.thread_projection("t2").unwrap().is_none());
    let fork = store.thread_projection("t3").unwrap().unwrap();
    assert_eq!(fork["contextTransfers"][0]["id"], "x1");
    let sessions = |p: &serde_json::Value| -> Vec<String> {
        p["providerSessions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["id"].as_str().unwrap().to_owned())
            .collect()
    };
    assert_eq!(
        sessions(&projection),
        ["s1"],
        "a detached session stays out"
    );
    assert_eq!(
        sessions(&fork),
        ["s1"],
        "a session shows in each thread bound to it"
    );

    // New writes go after the imported rows and after every sequence T3 gave out, so a T3
    // cursor gets a snapshot; a new run takes the ordinal after the highest.
    assert_eq!(store.imported_through(), 900_000);
    assert!(store.high_water() > 900_000);
    let mut store = store;
    let tx = store.tx().unwrap();
    assert_eq!(tx.next_run_ordinal("t1").unwrap(), 4);
    drop(tx);
    drop(store);

    // Once: a second call leaves the engine's file alone.
    assert_eq!(import_t3_state(&dir).unwrap(), None);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn a_partial_import_is_removed_and_redone() {
    let dir = temp_dir("partial");
    t3_state(&dir);
    fs::write(dir.join("engine.sqlite.t3-import"), b"left by a crash").unwrap();
    let report = import_t3_state(&dir).unwrap().unwrap();
    assert_eq!(report.threads, 3);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn nothing_to_do_without_a_t3_file_or_with_an_engine_file() {
    let dir = temp_dir("none");
    assert_eq!(import_t3_state(&dir).unwrap(), None);
    assert!(!dir.join(ENGINE_FILE).exists());
    t3_state(&dir);
    fs::write(dir.join(ENGINE_FILE), b"").unwrap();
    assert_eq!(import_t3_state(&dir).unwrap(), None);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn the_uri_escapes_what_a_uri_reads() {
    assert_eq!(
        read_only_uri(Path::new("/a b/c?d#e%.sqlite"), false),
        "file:/a%20b/c%3Fd%23e%25.sqlite?mode=ro"
    );
    assert!(read_only_uri(Path::new("/x"), true).ends_with("?mode=ro&immutable=1"));
}

/// A WAL file a T3 server closed cleanly has no `-wal` or `-shm`; in a folder that is not
/// writable a read-only open cannot create them, and the importer reads it as immutable.
#[test]
fn a_cleanly_closed_wal_file_in_a_read_only_folder_is_read() {
    use std::os::unix::fs::PermissionsExt;
    let dir = temp_dir("readonly");
    let source = t3_state(&dir);
    {
        let conn = Connection::open(&source).unwrap();
        conn.execute_batch("PRAGMA journal_mode=WAL;").unwrap();
    }
    assert!(!dir.join("statev2.sqlite-wal").exists());
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o555)).unwrap();
    let conn = Connection::open_with_flags(
        ":memory:",
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_URI,
    )
    .unwrap();
    let attached = attach_t3(&conn, &source);
    let threads = conn.query_row(
        "SELECT count(*) FROM t3.orchestration_v2_projection_threads",
        [],
        |row| row.get::<_, i64>(0),
    );
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
    attached.unwrap();
    assert_eq!(threads.unwrap(), 3);
    assert!(!dir.join("statev2.sqlite-wal").exists());
    let _ = fs::remove_dir_all(&dir);
}

/// A T3 file from before later migrations: no `has_custom_title` and other project columns,
/// no session bindings, no MCP app context, no metadata. The import still runs.
#[test]
fn an_older_t3_schema_imports_with_defaults() {
    let dir = temp_dir("older");
    let path = dir.join(T3_STATE_FILE);
    let conn = Connection::open(&path).unwrap();
    conn.execute_batch(T3_SCHEMA).unwrap();
    conn.execute_batch(
        "DROP TABLE projection_projects;
         CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY, title TEXT NOT NULL,
           workspace_root TEXT NOT NULL, scripts_json TEXT NOT NULL, created_at TEXT NOT NULL,
           updated_at TEXT NOT NULL, deleted_at TEXT);
         INSERT INTO projection_projects VALUES ('p1', 'Repo', '/work/repo', '[]',
           '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL);
         DROP TABLE orchestration_v2_projection_provider_session_bindings;
         DROP TABLE orchestration_v2_projection_context_transfers;
         DROP TABLE mcp_app_model_context;
         DROP TABLE orchestration_v2_projection_metadata;
         INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title,
           default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
         VALUES ('t1', 'p1', 'T', 'codex', 'full-access', 'default', '2026-01-01T00:00:00.000Z',
           '2026-01-01T00:00:00.000Z', '{\"id\":\"t1\",\"projectId\":\"p1\",\"title\":\"T\"}');",
    )
    .unwrap();
    drop(conn);
    let report = import_t3_state(&dir).unwrap().unwrap();
    assert_eq!((report.projects, report.threads), (1, 1));
    let store = Store::open(&dir.join(ENGINE_FILE)).unwrap();
    let shell = store.shell_snapshot().unwrap();
    assert_eq!(shell["projects"][0]["hasCustomTitle"], false);
    assert_eq!(shell["projects"][0]["pinnedAt"], serde_json::Value::Null);
    assert_eq!(shell["threads"][0]["id"], "t1");
    drop(store);
    let _ = fs::remove_dir_all(&dir);
}

/// A client that kept a cursor from the T3 server reconnects: the imported rows have no
/// events here, so the thread stream and the shell answer with a snapshot, never an empty
/// replay.
#[test]
fn a_t3_cursor_gets_a_snapshot() {
    let dir = temp_dir("cursor");
    t3_state(&dir);
    import_t3_state(&dir).unwrap().unwrap();
    let store = Store::open(&dir.join(ENGINE_FILE)).unwrap();
    let (imported, high) = (store.imported_through(), store.high_water());
    for t3_cursor in [0, 5, 899_999, 900_000] {
        assert!(
            !crate::streams::can_replay(t3_cursor, high, imported),
            "{t3_cursor}"
        );
    }
    // The shell's own resume check refuses them too: the import wrote no project changes.
    for t3_cursor in [0, 5, 899_999] {
        assert_eq!(
            store.shell_changes_since(t3_cursor).unwrap(),
            None,
            "{t3_cursor}"
        );
    }
    assert!(crate::streams::can_replay(high, high, imported));
    assert!(store.shell_changes_since(high).unwrap().is_some());
    // A store that was never imported resumes any cursor up to its high water.
    assert!(crate::streams::can_replay(0, 10, 0));
    drop(store);
    let _ = fs::remove_dir_all(&dir);
}

/// The shell stream at T3's last cursor answers with a snapshot (projects included), not a
/// replay of the rebuilt thread rows alone.
#[tokio::test(flavor = "current_thread")]
async fn the_shell_at_the_boundary_is_a_snapshot() {
    use crate::{Engine, EngineConfig, SqliteEngine};
    use conn_contract::{from_json, to_json};

    let dir = temp_dir("shell-boundary");
    t3_state(&dir);
    import_t3_state(&dir).unwrap().unwrap();
    let engine = SqliteEngine::open(EngineConfig::new(dir.join(ENGINE_FILE))).unwrap();
    for cursor in [5, 900_000] {
        let mut shell = engine
            .subscribe_shell(
                from_json(json!({"afterSequence": cursor, "httpSnapshotFallback": true})).unwrap(),
            )
            .await
            .unwrap();
        let first = to_json(&shell.recv().await.unwrap().unwrap());
        assert_eq!(first, json!({"kind": "snapshot-required"}), "{cursor}");
    }
    drop(engine);
    let _ = fs::remove_dir_all(&dir);
}
