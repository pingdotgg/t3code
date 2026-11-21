//! Carries a T3 server's sessions, pairing links, peer links and scheduled tasks over to this
//! server's own files, once, at the first start in a T3 state folder. The threads and projects
//! go to the engine (`conn_engine::import_t3_state`); these live outside it.
//!
//! - **When.** The folder holds T3's `statev2.sqlite` and no `engine.sqlite`: the same first
//!   start that imports the threads. Each file is written only when it is missing, so nothing
//!   this server already keeps is replaced. Until the thread import of the same start is in
//!   place (`t3-carry.pending` lists what was carried), a later start reads them again from
//!   T3, which may have run in between.
//! - **Read-only.** T3's file is attached read-only, as the thread import attaches it.
//! - **Sessions** (`auth_sessions`, T3's `SessionStore`): every live bearer session (not
//!   revoked, not expired) goes to `auth.json`, marked as T3-signed. Its client keeps the
//!   token T3 gave it: `auth.rs` checks it with T3's `server-signing-key`, which stays in the
//!   shared secret store. Not carried: browser cookie sessions and DPoP-bound sessions (this
//!   server issues and checks neither).
//! - **Pairing links** (`auth_pairing_links`, `PairingGrantStore`): unspent, unrevoked,
//!   unexpired one-time codes, kept by their hash, peer-link codes included. Not carried:
//!   codes bound to an MCP sign-in in progress, codes waiting for T3 Connect approval or bound
//!   to a device key.
//! - **Peer links** (`peer_environment_links`, `PeerLinks`): every row, in T3's order. Their
//!   tokens stay in the secret store under the same names. A link T3 would show as expired
//!   (made before link fencing, `fenced = 0`) gets its `linkedAt` as expiry, as T3 shows it.
//! - **Scheduled tasks** (`scheduled_tasks`, `ScheduledTaskService.decodeRow`): every task
//!   with its schedule, state, counters and webhook credentials. Not carried: webhook replay
//!   keys and deliveries waiting for dispatch, and webhook coalescing (this server has none);
//!   tasks over [`conn_features::scheduled::MAX_TASKS`].

use std::path::Path;

use conn_support::time::millis_from_iso;
use rusqlite::{Connection, Row};
use serde_json::{Value, json};

use crate::auth::{ClientInfo, T3PairingLink, T3Session};
use crate::peers::T3PeerLink;

const T3_STATE_FILE: &str = "statev2.sqlite";
const ENGINE_FILE: &str = "engine.sqlite";
const AUTH_FILE: &str = "auth.json";
const PEERS_FILE: &str = "peer-links.json";
const TASKS_FILE: &str = "scheduled-tasks.json";
/// The files a carry-over wrote, until the thread import of the same start is in place.
const PENDING_FILE: &str = "t3-carry.pending";

/// What was carried over; `None` for a file that already existed or a table T3 lacks.
#[derive(Debug, Default)]
pub struct CarryReport {
    pub sessions: Option<usize>,
    pub sessions_skipped: usize,
    pub pairing_links: Option<usize>,
    pub peer_links: Option<usize>,
    pub scheduled_tasks: Option<usize>,
}

impl CarryReport {
    pub fn summary(&self) -> String {
        let count = |n: Option<usize>| n.map_or_else(|| "kept".to_owned(), |n| n.to_string());
        format!(
            "carried over from the T3 server: sessions {} ({} not carried: cookie or DPoP), \
             pairing links {}, peer links {}, scheduled tasks {}",
            count(self.sessions),
            self.sessions_skipped,
            count(self.pairing_links),
            count(self.peer_links),
            count(self.scheduled_tasks),
        )
    }
}

/// Runs the carry-over when `state_dir` is a T3 state folder at its first start here.
/// Blocking: run it off the async runtime.
pub fn carry_t3_state(state_dir: &Path) -> Result<Option<CarryReport>, String> {
    let source = state_dir.join(T3_STATE_FILE);
    if state_dir.join(ENGINE_FILE).exists() || !source.is_file() {
        return Ok(None);
    }
    let conn = conn_engine::open_t3_read_only(&source)?;
    let now = conn_support::time::now_ms();
    let mut report = CarryReport::default();
    // Files an earlier start carried over while the thread import did not finish: the T3
    // server may have run since (a revoked session, a spent code), so they are read again.
    let marker = state_dir.join(PENDING_FILE);
    let pending = std::fs::read_to_string(&marker).unwrap_or_default();
    let is_pending = |name: &str| pending.lines().any(|line| line == name);
    let mut carry: Vec<&str> = [AUTH_FILE, PEERS_FILE, TASKS_FILE]
        .into_iter()
        .filter(|name| !state_dir.join(name).exists() || is_pending(name))
        .collect();
    // The marker goes first, so a start that stops between two writes reads them again.
    let save_marker = |names: &[&str]| {
        conn_support::fs::write_private(&marker, names.join("\n").as_bytes())
            .map_err(|e| format!("t3 carry: cannot write {PENDING_FILE}: {e}"))
    };
    if !carry.is_empty() {
        save_marker(&carry)?;
    }

    if carry.contains(&AUTH_FILE) {
        let auth = state_dir.join(AUTH_FILE);
        let (sessions, skipped) = read_sessions(&conn, now)?;
        let links = read_pairing_links(&conn, now)?;
        let (count, link_count) = (sessions.len(), links.len());
        let written =
            crate::auth::write_t3_import(&auth, sessions, links, is_pending(AUTH_FILE), now)
                .map_err(|e| format!("t3 carry: cannot write {}: {e}", auth.display()))?;
        if written {
            report.sessions = Some(count);
            report.sessions_skipped = skipped;
            report.pairing_links = Some(link_count);
        } else {
            // The CLI made it first: it is this server's file.
            carry.retain(|name| *name != AUTH_FILE);
            save_marker(&carry)?;
        }
    }
    if carry.contains(&PEERS_FILE) && has_table(&conn, "peer_environment_links")? {
        let links = read_peer_links(&conn)?;
        report.peer_links = Some(links.len());
        crate::peers::write_t3_import(state_dir, links)
            .map_err(|e| format!("t3 carry: cannot write {PEERS_FILE}: {e}"))?;
    }
    if carry.contains(&TASKS_FILE) && has_table(&conn, "scheduled_tasks")? {
        let tasks = read_scheduled_tasks(&conn)?;
        report.scheduled_tasks = Some(
            conn_features::scheduled::write_t3_import(state_dir, tasks)
                .map_err(|e| format!("t3 carry: cannot write {TASKS_FILE}: {e}"))?,
        );
    }
    Ok(Some(report))
}

/// Called once the thread import is in place (or was already): the carried files are this
/// server's from now on and are never read from T3 again.
pub fn finish_carry(state_dir: &Path) {
    let marker = state_dir.join(PENDING_FILE);
    if state_dir.join(ENGINE_FILE).exists()
        && let Err(error) = std::fs::remove_file(&marker)
        && error.kind() != std::io::ErrorKind::NotFound
    {
        eprintln!("conn-server: cannot remove {}: {error}", marker.display());
    }
}

fn err(error: impl std::fmt::Display) -> String {
    format!("t3 carry: {error}")
}

fn columns(conn: &Connection, table: &str) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA t3.table_info(\"{table}\")"))
        .map_err(err)?;
    stmt.query_map([], |row| row.get::<_, String>(1))
        .map_err(err)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(err)
}

fn has_table(conn: &Connection, table: &str) -> Result<bool, String> {
    Ok(!columns(conn, table)?.is_empty())
}

/// `column` when T3's table has it, else `fallback` (an older T3).
fn column_or(cols: &[String], column: &str, fallback: &str) -> String {
    if cols.iter().any(|c| c == column) {
        column.to_owned()
    } else {
        format!("{fallback} AS {column}")
    }
}

fn ms(text: &str) -> Option<u64> {
    millis_from_iso(text).and_then(|ms| u64::try_from(ms).ok())
}

fn scopes(text: &str) -> Vec<String> {
    serde_json::from_str(text).unwrap_or_default()
}

/// Live bearer sessions, and how many live sessions were not carried (cookie or DPoP).
fn read_sessions(conn: &Connection, now: u64) -> Result<(Vec<T3Session>, usize), String> {
    let cols = columns(conn, "auth_sessions")?;
    if cols.is_empty() {
        return Ok((Vec::new(), 0));
    }
    let sql = format!(
        "SELECT session_id, subject, scopes, method, client_label, client_ip_address,
                client_user_agent, client_device_type, client_os, client_browser, issued_at,
                expires_at, last_connected_at, {proof}
         FROM t3.auth_sessions WHERE revoked_at IS NULL ORDER BY issued_at, session_id",
        proof = column_or(&cols, "proof_key_thumbprint", "NULL"),
    );
    let mut stmt = conn.prepare(&sql).map_err(err)?;
    let mut rows = stmt.query([]).map_err(err)?;
    let (mut sessions, mut skipped) = (Vec::new(), 0);
    while let Some(row) = rows.next().map_err(err)? {
        let text = |i: usize| row.get::<_, Option<String>>(i);
        let Some(expires_at_ms) = text(11).map_err(err)?.as_deref().and_then(ms) else {
            continue;
        };
        if expires_at_ms <= now {
            continue;
        }
        let method: String = row.get(3).map_err(err)?;
        if method != "bearer-access-token" || text(13).map_err(err)?.is_some() {
            skipped += 1;
            continue;
        }
        sessions.push(T3Session {
            id: row.get(0).map_err(err)?,
            subject: row.get(1).map_err(err)?,
            scopes: scopes(&row.get::<_, String>(2).map_err(err)?),
            client: ClientInfo {
                label: text(4).map_err(err)?,
                ip_address: text(5).map_err(err)?,
                user_agent: text(6).map_err(err)?,
                device_type: text(7).map_err(err)?.unwrap_or_else(|| "unknown".into()),
                os: text(8).map_err(err)?,
                browser: text(9).map_err(err)?,
            },
            issued_at_ms: text(10).map_err(err)?.as_deref().and_then(ms).unwrap_or(0),
            expires_at_ms,
            last_connected_at_ms: text(12).map_err(err)?.as_deref().and_then(ms),
        });
    }
    Ok((sessions, skipped))
}

/// Unspent one-time pairing codes a client could still exchange here.
fn read_pairing_links(conn: &Connection, now: u64) -> Result<Vec<T3PairingLink>, String> {
    query_pairing_links(conn, now, None)
}

/// One pairing code that T3's own CLI made after the carry-over: `t3 auth pairing create
/// --base-dir ~/.t3`, which Conn desktop's SSH setup runs on the host, writes T3's table even
/// while this server owns the folder. Only a plain one-time code (subject `one-time-token`),
/// read-only, by its code (case-insensitive, as codes here are). `None` when the folder has no
/// T3 state or no such unspent code. Blocking.
pub(crate) fn read_t3_pairing_code(
    state_dir: &Path,
    code: &str,
    now: u64,
) -> Result<Option<T3PairingLink>, String> {
    let source = state_dir.join(T3_STATE_FILE);
    if !source.is_file() {
        return Ok(None);
    }
    let conn = conn_engine::open_t3_read_only(&source)?;
    Ok(query_pairing_links(&conn, now, Some(code))?
        .into_iter()
        .next())
}

/// With `code`, only the plain one-time code with that credential.
fn query_pairing_links(
    conn: &Connection,
    now: u64,
    code: Option<&str>,
) -> Result<Vec<T3PairingLink>, String> {
    let cols = columns(conn, "auth_pairing_links")?;
    if cols.is_empty() {
        return Ok(Vec::new());
    }
    let only_code = if code.is_some() {
        "AND subject = 'one-time-token' AND upper(trim(credential)) = ?1"
    } else {
        ""
    };
    let sql = format!(
        "SELECT id, credential, scopes, subject, label, created_at, expires_at
         FROM t3.auth_pairing_links
         WHERE revoked_at IS NULL AND consumed_at IS NULL AND method = 'one-time-token'
           AND (subject NOT LIKE 'mcp-approval:%' OR subject LIKE 'mcp-approval:peer-link:%')
           AND {proof} IS NULL AND {approval} = 0 AND {denied} = 0 {only_code}
         ORDER BY created_at, id",
        proof = if cols.iter().any(|c| c == "proof_key_thumbprint") {
            "proof_key_thumbprint"
        } else {
            "NULL"
        },
        approval = if cols.iter().any(|c| c == "requires_connect_approval") {
            "requires_connect_approval"
        } else {
            "0"
        },
        denied = if cols.iter().any(|c| c == "connect_denied") {
            "connect_denied"
        } else {
            "0"
        },
    );
    let mut stmt = conn.prepare(&sql).map_err(err)?;
    let mut rows = match code {
        Some(code) => stmt.query([code.trim().to_ascii_uppercase()]),
        None => stmt.query([]),
    }
    .map_err(err)?;
    let mut links = Vec::new();
    while let Some(row) = rows.next().map_err(err)? {
        let Some(expires_at_ms) = row.get::<_, String>(6).ok().as_deref().and_then(ms) else {
            continue;
        };
        if expires_at_ms <= now {
            continue;
        }
        links.push(T3PairingLink {
            id: row.get(0).map_err(err)?,
            credential: row.get(1).map_err(err)?,
            scopes: scopes(&row.get::<_, String>(2).map_err(err)?),
            subject: row.get(3).map_err(err)?,
            label: row.get(4).map_err(err)?,
            created_at_ms: row
                .get::<_, String>(5)
                .ok()
                .as_deref()
                .and_then(ms)
                .unwrap_or(0),
            expires_at_ms,
        });
    }
    Ok(links)
}

fn read_peer_links(conn: &Connection) -> Result<Vec<T3PeerLink>, String> {
    let cols = columns(conn, "peer_environment_links")?;
    let sql = format!(
        "SELECT environment_id, secret_name, label, urls_json, access, linked_at, expires_at,
                last_reached_at, last_error, {fenced}
         FROM t3.peer_environment_links ORDER BY label, environment_id",
        fenced = column_or(&cols, "fenced", "0"),
    );
    let mut stmt = conn.prepare(&sql).map_err(err)?;
    let mut rows = stmt.query([]).map_err(err)?;
    let mut links = Vec::new();
    while let Some(row) = rows.next().map_err(err)? {
        let linked_at_ms = row
            .get::<_, String>(5)
            .ok()
            .as_deref()
            .and_then(ms)
            .unwrap_or(0);
        let fenced = row.get::<_, i64>(9).map_err(err)? == 1;
        let expires_at_ms = if fenced {
            row.get::<_, String>(6)
                .ok()
                .as_deref()
                .and_then(ms)
                .unwrap_or(linked_at_ms)
        } else {
            linked_at_ms
        };
        links.push(T3PeerLink {
            environment_id: row.get(0).map_err(err)?,
            secret_name: row.get(1).map_err(err)?,
            label: row.get(2).map_err(err)?,
            urls: serde_json::from_str(&row.get::<_, String>(3).map_err(err)?).unwrap_or_default(),
            access: row.get(4).map_err(err)?,
            linked_at_ms,
            expires_at_ms,
            last_reached_at_ms: row
                .get::<_, Option<String>>(7)
                .map_err(err)?
                .as_deref()
                .and_then(ms),
            last_error: row.get(8).map_err(err)?,
        });
    }
    Ok(links)
}

type TaskRow = (
    Value,
    Option<conn_features::scheduled::webhook::Credentials>,
);

/// Each task as T3's `decodeRow` builds it, with its webhook credentials.
fn read_scheduled_tasks(conn: &Connection) -> Result<Vec<TaskRow>, String> {
    let cols = columns(conn, "scheduled_tasks")?;
    let sql = format!(
        "SELECT task_id, title, prompt, enabled, schedule_json, project_id, thread_id,
                {thread_mode}, workspace_strategy_json, model_selection_json, runtime_mode,
                interaction_mode, created_by, creation_source, created_at, updated_at,
                next_run_at, last_run_at, last_run_status, last_run_error, run_count,
                {token}, {secret}
         FROM t3.scheduled_tasks ORDER BY created_at, task_id",
        // T3's migration 080 gave a bound task `continue` and the others `new_thread`.
        thread_mode = column_or(
            &cols,
            "thread_mode",
            "CASE WHEN thread_id IS NULL THEN 'new_thread' ELSE 'continue' END",
        ),
        token = column_or(&cols, "webhook_token", "NULL"),
        secret = column_or(&cols, "webhook_secret", "NULL"),
    );
    let mut stmt = conn.prepare(&sql).map_err(err)?;
    let mut rows = stmt.query([]).map_err(err)?;
    let mut tasks = Vec::new();
    while let Some(row) = rows.next().map_err(err)? {
        tasks.push(task_row(row).map_err(err)?);
    }
    Ok(tasks)
}

fn task_row(row: &Row<'_>) -> rusqlite::Result<TaskRow> {
    let text = |i: usize| row.get::<_, Option<String>>(i);
    let parsed = |i: usize| -> rusqlite::Result<Value> {
        Ok(text(i)?
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or(Value::Null))
    };
    let task = json!({
        "id": text(0)?,
        "title": text(1)?,
        "prompt": text(2)?,
        "enabled": row.get::<_, i64>(3)? == 1,
        "schedule": parsed(4)?,
        "projectId": text(5)?,
        "threadId": text(6)?,
        "threadMode": text(7)?,
        "workspaceStrategy": parsed(8)?,
        "modelSelection": parsed(9)?,
        "runtimeMode": text(10)?,
        "interactionMode": text(11)?,
        "createdBy": text(12)?,
        "creationSource": text(13)?,
        "createdAt": text(14)?,
        "updatedAt": text(15)?,
        "nextRunAt": text(16)?,
        "lastRunAt": text(17)?,
        "lastRunStatus": text(18)?,
        "lastRunError": text(19)?,
        "runCount": row.get::<_, i64>(20)?,
    });
    let credentials = text(21)?.map(|token| conn_features::scheduled::webhook::Credentials {
        token,
        secret: text(22).ok().flatten(),
    });
    Ok((task, credentials))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// T3's tables as mini's T3 server has them (`statev2.sqlite`, 2026-11-21).
    const T3_TABLES: &str = "
      CREATE TABLE auth_sessions (session_id TEXT PRIMARY KEY, subject TEXT NOT NULL,
        scopes TEXT NOT NULL, method TEXT NOT NULL, client_label TEXT, client_ip_address TEXT,
        client_user_agent TEXT, client_device_type TEXT NOT NULL DEFAULT 'unknown', client_os TEXT,
        client_browser TEXT, issued_at TEXT NOT NULL, expires_at TEXT NOT NULL,
        last_connected_at TEXT, revoked_at TEXT, client_surface TEXT, client_app_version TEXT,
        proof_key_thumbprint TEXT);
      CREATE TABLE auth_pairing_links (id TEXT PRIMARY KEY, credential TEXT NOT NULL UNIQUE,
        method TEXT NOT NULL, scopes TEXT NOT NULL, subject TEXT NOT NULL, label TEXT,
        created_at TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_at TEXT, revoked_at TEXT,
        proof_key_thumbprint TEXT, requires_connect_approval INTEGER NOT NULL DEFAULT 0,
        requested_client_json TEXT, connect_denied INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE peer_environment_links (environment_id TEXT PRIMARY KEY,
        secret_name TEXT NOT NULL, label TEXT NOT NULL, urls_json TEXT NOT NULL,
        access TEXT NOT NULL, linked_at TEXT NOT NULL, expires_at TEXT NOT NULL,
        last_reached_at TEXT, last_error TEXT, fenced INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE scheduled_tasks (task_id TEXT PRIMARY KEY, title TEXT NOT NULL,
        prompt TEXT NOT NULL, enabled INTEGER NOT NULL, schedule_json TEXT NOT NULL,
        project_id TEXT NOT NULL, thread_id TEXT, workspace_strategy_json TEXT NOT NULL,
        model_selection_json TEXT NOT NULL, runtime_mode TEXT NOT NULL,
        interaction_mode TEXT NOT NULL, created_by TEXT NOT NULL, creation_source TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, next_run_at TEXT, last_run_at TEXT,
        last_run_status TEXT NOT NULL, last_run_error TEXT, run_count INTEGER NOT NULL,
        webhook_token TEXT, webhook_secret TEXT, last_run_webhook_delivery_id TEXT,
        thread_mode TEXT NOT NULL DEFAULT 'new_thread');
      INSERT INTO auth_sessions (session_id, subject, scopes, method, client_label,
        client_device_type, issued_at, expires_at, revoked_at, proof_key_thumbprint) VALUES
        ('live', 'one-time-token', '[\"orchestration:read\"]', 'bearer-access-token', 'phone',
          'mobile', '2026-11-01T00:00:00.000Z', '2999-01-01T00:00:00.000Z', NULL, NULL),
        ('expired', 'one-time-token', '[]', 'bearer-access-token', NULL, 'unknown',
          '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z', NULL, NULL),
        ('revoked', 'one-time-token', '[]', 'bearer-access-token', NULL, 'unknown',
          '2026-11-01T00:00:00.000Z', '2999-01-01T00:00:00.000Z', '2026-11-02T00:00:00.000Z', NULL),
        ('cookie', 'browser', '[]', 'browser-session-cookie', NULL, 'unknown',
          '2026-11-01T00:00:00.000Z', '2999-01-01T00:00:00.000Z', NULL, NULL),
        ('dpop', 'one-time-token', '[]', 'bearer-access-token', NULL, 'unknown',
          '2026-11-01T00:00:00.000Z', '2999-01-01T00:00:00.000Z', NULL, 'thumb');
      INSERT INTO auth_pairing_links (id, credential, method, scopes, subject, created_at,
        expires_at, consumed_at) VALUES
        ('open', 'ABCDEFGHJKMN', 'one-time-token', '[]', 'one-time-token',
          '2026-11-01T00:00:00.000Z', '2999-01-01T00:00:00.000Z', NULL),
        ('spent', 'BCDEFGHJKMNP', 'one-time-token', '[]', 'one-time-token',
          '2026-11-01T00:00:00.000Z', '2999-01-01T00:00:00.000Z', '2026-11-02T00:00:00.000Z'),
        ('peer', 'CDEFGHJKMNPQ', 'one-time-token', '[]', 'mcp-approval:peer-link:full-access',
          '2026-11-01T00:00:00.000Z', '2999-01-01T00:00:00.000Z', NULL),
        ('signin', 'DEFGHJKMNPQR', 'one-time-token', '[]', 'mcp-approval:client-1',
          '2026-11-01T00:00:00.000Z', '2999-01-01T00:00:00.000Z', NULL);
      INSERT INTO peer_environment_links VALUES
        ('env-b', 'peer-link-b', 'beast', '[\"http://10.44.0.7:3773\"]', 'full-access',
          '2026-11-01T00:00:00.000Z', '2026-12-01T00:00:00.000Z', NULL, NULL, 1),
        ('env-a', 'peer-link-a', 'aged', '[\"http://10.44.0.8:3773\"]', 'read-only',
          '2026-10-01T00:00:00.000Z', '2026-12-01T00:00:00.000Z', NULL, 'gone', 0);
      INSERT INTO scheduled_tasks VALUES ('scheduled-task:one', 'Check', 'Say pong.', 1,
        '{\"type\":\"interval\",\"everyMs\":600000}', 'project-1', 'thread-1',
        '{\"type\":\"root\"}', '{\"instanceId\":\"claudeAgent\",\"model\":\"claude-haiku-4-5\"}',
        'full-access', 'default', 'agent', 'mcp', '2026-11-01T00:00:00.000Z',
        '2026-11-02T00:00:00.000Z', '2026-11-21T12:00:00.000Z', '2026-11-21T11:50:00.000Z',
        'succeeded', NULL, 12, NULL, NULL, NULL, 'continue');";

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("conn-server-{name}-{}", crate::auth::random_hex(6)));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Conn desktop's SSH setup runs `t3 auth pairing create --base-dir ~/.t3` on a host
    /// this server already serves: T3's CLI writes the code to T3's table, after the carry.
    #[test]
    fn codes_t3_writes_after_the_carry_are_spent_here_once() {
        use crate::auth::{AuthStore, ClientInfo, ExchangeError};
        let dir = temp_dir("t3-late-code");
        let t3 = Connection::open(dir.join(T3_STATE_FILE)).unwrap();
        t3.execute_batch(T3_TABLES).unwrap();
        let add_at = |id: &str, code: &str, subject: &str, created: &str| {
            t3.execute(
                "INSERT INTO auth_pairing_links (id, credential, method, scopes, subject,
                   label, created_at, expires_at) VALUES (?1, ?2, 'one-time-token',
                   '[\"orchestration:read\"]', ?3, 'ssh', ?4, '2999-01-01T00:00:00.000Z')",
                [id, code, subject, created],
            )
            .unwrap();
        };
        // Made after the carry-over below.
        let add = |id: &str, code: &str, subject: &str| {
            add_at(id, code, subject, "2998-01-01T00:00:00.000Z");
        };
        add_at(
            "carried-2",
            "FGHJKMNPQRST",
            "one-time-token",
            "2026-11-21T00:00:00.000Z",
        );
        carry_t3_state(&dir).unwrap().expect("first start");
        let exchange = |store: &AuthStore, code: &str| {
            store
                .exchange(code, None, ClientInfo::default())
                .map(|issued| issued.principal.scopes)
        };
        let store = AuthStore::open(dir.join(AUTH_FILE)).unwrap();

        // A carried code, spent here: T3's table still lists it, and that must not count.
        assert!(exchange(&store, "FGHJKMNPQRST").is_ok());
        assert!(matches!(
            exchange(&store, "FGHJKMNPQRST"),
            Err(ExchangeError::InvalidCredential)
        ));
        // A carried code revoked here stays revoked.
        assert!(store.revoke_pairing_link("open").unwrap());
        assert!(matches!(
            exchange(&store, "ABCDEFGHJKMN"),
            Err(ExchangeError::InvalidCredential)
        ));

        // Written by T3's CLI after the carry: works once, case-insensitively.
        add("late", "GHJKMNPQRSTV", "one-time-token");
        add(
            "late-peer",
            "HJKMNPQRSTVW",
            "mcp-approval:peer-link:full-access",
        );
        assert_eq!(
            exchange(&store, "ghjkmnpqrstv").unwrap(),
            vec!["orchestration:read".to_owned()]
        );
        assert!(matches!(
            exchange(&store, "GHJKMNPQRSTV"),
            Err(ExchangeError::InvalidCredential)
        ));
        // Spent means spent for a process that opens the file afresh too.
        drop(store);
        let store = AuthStore::open(dir.join(AUTH_FILE)).unwrap();
        assert!(matches!(
            exchange(&store, "GHJKMNPQRSTV"),
            Err(ExchangeError::InvalidCredential)
        ));
        assert!(matches!(
            exchange(&store, "FGHJKMNPQRST"),
            Err(ExchangeError::InvalidCredential)
        ));
        assert!(matches!(
            exchange(&store, "ABCDEFGHJKMN"),
            Err(ExchangeError::InvalidCredential)
        ));
        // Only plain one-time codes: a peer-link code is for a peer link, and T3's spent,
        // purpose-bound and unknown codes stay refused.
        for code in [
            "HJKMNPQRSTVW",
            "BCDEFGHJKMNP",
            "DEFGHJKMNPQR",
            "JKMNPQRSTVWX",
        ] {
            assert!(
                matches!(
                    exchange(&store, code),
                    Err(ExchangeError::InvalidCredential)
                ),
                "{code}"
            );
        }
        drop(store);
        drop(t3);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A code from before the carry-over is this file's to decide, even when the file lost
    /// track of it; and a file written before carry times were kept takes none from T3.
    #[test]
    fn codes_from_before_the_carry_never_come_from_t3s_table() {
        use crate::auth::{AuthStore, ClientInfo};
        let dir = temp_dir("t3-early-code");
        let t3 = Connection::open(dir.join(T3_STATE_FILE)).unwrap();
        t3.execute_batch(T3_TABLES).unwrap();
        carry_t3_state(&dir).unwrap().expect("first start");
        // As if the carried code had been spent here by a version without spent records.
        t3.execute(
            "INSERT INTO auth_pairing_links (id, credential, method, scopes, subject, label,
               created_at, expires_at) VALUES ('early', 'KMNPQRSTVWXY', 'one-time-token',
               '[\"orchestration:read\"]', 'one-time-token', 'ssh', '2000-01-01T00:00:00.000Z',
               '2999-01-01T00:00:00.000Z')",
            [],
        )
        .unwrap();
        let store = AuthStore::open(dir.join(AUTH_FILE)).unwrap();
        assert!(
            store
                .exchange("KMNPQRSTVWXY", None, ClientInfo::default())
                .is_err()
        );
        // An auth file without a carry time (an older version's): no code from T3's table.
        drop(store);
        let path = dir.join(AUTH_FILE);
        let mut file: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        file.as_object_mut().unwrap().remove("t3CarriedAtMs");
        std::fs::write(&path, serde_json::to_vec(&file).unwrap()).unwrap();
        t3.execute(
            "INSERT INTO auth_pairing_links (id, credential, method, scopes, subject, label,
               created_at, expires_at) VALUES ('late', 'MNPQRSTVWXYZ', 'one-time-token',
               '[\"orchestration:read\"]', 'one-time-token', 'ssh', '2998-01-01T00:00:00.000Z',
               '2999-01-01T00:00:00.000Z')",
            [],
        )
        .unwrap();
        let store = AuthStore::open(path).unwrap();
        assert!(
            store
                .exchange("MNPQRSTVWXYZ", None, ClientInfo::default())
                .is_err()
        );
        drop(t3);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn carries_sessions_links_and_tasks_once() {
        let dir = temp_dir("t3-carry");
        let t3 = Connection::open(dir.join(T3_STATE_FILE)).unwrap();
        t3.execute_batch(T3_TABLES).unwrap();
        drop(t3);

        let report = carry_t3_state(&dir)
            .unwrap()
            .expect("a T3 folder at its first start");
        assert_eq!(report.sessions, Some(1), "only the live bearer session");
        assert_eq!(report.sessions_skipped, 2, "cookie and DPoP");
        assert_eq!(
            report.pairing_links,
            Some(2),
            "the open code and the peer-link code"
        );
        assert_eq!(report.peer_links, Some(2));
        assert_eq!(report.scheduled_tasks, Some(1));

        let auth: Value =
            serde_json::from_slice(&std::fs::read(dir.join(AUTH_FILE)).unwrap()).unwrap();
        assert_eq!(auth["sessions"][0]["id"], "live");
        assert_eq!(auth["sessions"][0]["t3Signed"], true);
        assert_eq!(auth["sessions"][0]["client"]["label"], "phone");

        let peers: Value =
            serde_json::from_slice(&std::fs::read(dir.join(PEERS_FILE)).unwrap()).unwrap();
        let links = peers["links"].as_array().unwrap();
        assert_eq!(links[0]["label"], "aged", "T3's order: label, then id");
        assert_eq!(
            links[0]["expiresAtMs"], links[0]["linkedAtMs"],
            "an unfenced link shows as expired, as T3 shows it"
        );
        assert_eq!(links[1]["secretName"], "peer-link-b");
        assert_eq!(links[1]["urls"][0], "http://10.44.0.7:3773");

        let tasks: Value =
            serde_json::from_slice(&std::fs::read(dir.join(TASKS_FILE)).unwrap()).unwrap();
        let task = &tasks["tasks"][0];
        assert_eq!(task["id"], "scheduled-task:one");
        assert_eq!(task["threadMode"], "continue");
        assert_eq!(task["runCount"], 12);
        assert_eq!(task["nextRunAt"], "2026-11-21T12:00:00.000Z");

        // While the thread import has not finished, the carried files are read again (the
        // T3 server may have revoked a session since).
        let again = carry_t3_state(&dir).unwrap().unwrap();
        assert_eq!(
            (again.sessions, again.peer_links, again.scheduled_tasks),
            (Some(1), Some(2), Some(1))
        );

        // Files this server wrote itself are never replaced.
        std::fs::remove_file(dir.join(PENDING_FILE)).unwrap();
        std::fs::remove_file(dir.join(TASKS_FILE)).unwrap();
        let again = carry_t3_state(&dir).unwrap().unwrap();
        assert_eq!((again.sessions, again.peer_links), (None, None));
        assert_eq!(again.scheduled_tasks, Some(1));
        assert_eq!(
            std::fs::read_to_string(dir.join(PENDING_FILE)).unwrap(),
            TASKS_FILE
        );

        // After the first start (the engine store exists) nothing runs.
        std::fs::write(dir.join(ENGINE_FILE), b"").unwrap();
        finish_carry(&dir);
        assert!(!dir.join(PENDING_FILE).exists());
        assert!(carry_t3_state(&dir).unwrap().is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
