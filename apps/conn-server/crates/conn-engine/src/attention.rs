//! Attention events for iOS push (nckrtl/conn#229, section 1): when a thread starts to need
//! the user, or stops, the commit that changed its shell row writes one event to the
//! `attention_outbox` table, in the same transaction. The server's sender drains the table to
//! the Orbit Gateway. Off unless [`crate::EngineConfig::attention`] is set: with it off,
//! nothing is written.
//!
//! The rules follow the desktop's notifications (`ThreadNotificationCoordinator.logic.ts`):
//!
//! - `approval`: a pending request that is not `user_input` or `auth_refresh`.
//! - `input`: a pending `user_input` request, or a pending secret (the shell shows it as a
//!   blocking `user_input`).
//! - `turn_failed`: the latest run failed.
//! - `turn_finished`: the latest run completed and nothing is pending, unless a Monitor holds
//!   a background wake's completion (`monitorHoldsWakeCompletion`). A background wake's
//!   completion waits [`RELEASED_COMPLETION_GRACE_MS`]; a new run in that time cancels it.
//! - Only listed top-level threads: not a subagent, a delegated task or a side chat; not
//!   archived. A thread's first shell row never raises one (the desktop's first sighting).
//! - Snooze (`effectiveSnoozed`): it holds back `turn_finished`, and an `input` or
//!   `turn_failed` that is older than the snooze. An approval, a newer question or a newer
//!   failure raises the thread's hand and is sent.
//! - Each key `(thread, request or run, kind)` is sent once (`attention_sent`).
//! - `attention_cleared` goes out when a request that was sent is answered, or when the
//!   thread is opened (`lastVisitedAt` or `opens` changes) after an event was sent.
//!
//! The title is the only content that leaves the server.

use conn_contract::attention::{
    ConnAttentionEvent, ConnAttentionEventType, ConnAttentionKind, attention_title,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;

use crate::store::StoreResult;

/// `RELEASED_COMPLETION_GRACE_MS`: a final wake can start right after a progress wake.
pub const RELEASED_COMPLETION_GRACE_MS: u64 = 5_000;
/// Sent keys older than this are forgotten. Request and run ids never come back.
const SENT_KEY_TTL_MS: u64 = 7 * 24 * 60 * 60 * 1000;

pub(crate) const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS attention_outbox (
  id              INTEGER PRIMARY KEY,
  event_id        TEXT NOT NULL UNIQUE,
  type            TEXT NOT NULL,
  kind            TEXT,
  thread_id       TEXT NOT NULL,
  request_id      TEXT,
  occurred_at     TEXT NOT NULL,
  thread_title    TEXT,
  created_ms      INTEGER NOT NULL,
  next_attempt_ms INTEGER NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS attention_outbox_due ON attention_outbox(next_attempt_ms);
CREATE TABLE IF NOT EXISTS attention_sent (
  thread_id  TEXT NOT NULL,
  key        TEXT NOT NULL,
  request_id TEXT,
  sent_ms    INTEGER NOT NULL,
  cleared    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (thread_id, key)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS attention_sent_age ON attention_sent(sent_ms);
";

/// What a shell row asks of the user now, before snooze and the skip rules.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Need {
    pub kind: ConnAttentionKind,
    pub request_id: Option<String>,
    /// The request or run this is about: with `kind`, the dedupe key.
    pub subject: String,
    /// When it began: the request's `createdAt`, or the run's `completedAt`.
    pub at: Option<String>,
}

impl Need {
    pub(crate) fn key(&self) -> String {
        format!("{}:{}", self.kind.as_str(), self.subject)
    }
}

fn text<'a>(row: &'a Value, field: &str) -> Option<&'a str> {
    row.get(field).and_then(Value::as_str)
}

fn ms(text: Option<&str>) -> Option<i64> {
    text.and_then(conn_support::time::millis_from_iso)
}

/// What the shell row asks of the user, if anything.
pub(crate) fn need(shell: &Value) -> Option<Need> {
    let request = shell.get("pendingRuntimeRequest").filter(|r| r.is_object());
    if let Some(request) = request {
        let kind = match text(request, "kind") {
            Some("user_input") => ConnAttentionKind::Input,
            Some("auth_refresh") | None => return None,
            Some(_) => ConnAttentionKind::Approval,
        };
        let id = text(request, "id")?.to_owned();
        return Some(Need {
            kind,
            request_id: Some(id.clone()),
            subject: id,
            at: text(request, "createdAt").map(str::to_owned),
        });
    }
    let run_id = text(shell, "latestRunId")?.to_owned();
    let kind = match text(shell, "status") {
        Some("failed") => ConnAttentionKind::TurnFailed,
        Some("completed") if !monitor_holds_wake_completion(shell) => {
            ConnAttentionKind::TurnFinished
        }
        _ => return None,
    };
    Some(Need {
        kind,
        request_id: None,
        subject: run_id,
        at: text(shell, "latestRunCompletedAt").map(str::to_owned),
    })
}

/// `monitorHoldsWakeCompletion`: a background wake's run, while a Monitor (not a pull request
/// watch) still runs.
fn monitor_holds_wake_completion(shell: &Value) -> bool {
    shell["latestRunBackgroundWake"] == true
        && shell["pendingBackgroundTasks"]
            .as_array()
            .is_some_and(|tasks| {
                tasks.iter().any(|task| {
                    task["kind"] == "monitor"
                        && !text(task, "taskId").is_some_and(|id| {
                            id.starts_with(crate::background::PULL_REQUEST_WATCH_TASK_ID)
                        })
                })
            })
}

/// A listed top-level thread the user owns (`isDelegatedAppThread`, `isListedThreadLineage`),
/// not archived or deleted.
pub(crate) fn eligible(shell: &Value) -> bool {
    let lineage = &shell["lineage"];
    lineage["relationshipToParent"] != "subagent"
        && lineage["sideChat"] != true
        && !shell.get("delegatedFrom").is_some_and(|d| !d.is_null())
        && shell["archivedAt"].is_null()
        && shell["deletedAt"].is_null()
}

/// `effectiveSnoozed` as it applies to `need` (`isSnoozedForNotification` for completions).
pub(crate) fn snoozed(shell: &Value, need: &Need, now_ms: u64) -> bool {
    let Some(until) = ms(text(shell, "snoozedUntil")) else {
        return false;
    };
    let snoozed_at = ms(text(shell, "snoozedAt"));
    let active_at = |at: i64| until > at;
    let now = i64::try_from(now_ms).unwrap_or(i64::MAX);
    let at = ms(need.at.as_deref());
    match need.kind {
        // `threadRaisedHandWhileSnoozed`: an approval always wakes the thread.
        ConnAttentionKind::Approval => false,
        // Snoozing an existing question means "ask me later"; only a newer one wakes it.
        ConnAttentionKind::Input => {
            active_at(now) && matches!((at, snoozed_at), (Some(at), Some(s)) if at <= s)
        }
        // A failure wakes it when it is newer than the snooze.
        ConnAttentionKind::TurnFailed => {
            active_at(now)
                && match (at, snoozed_at) {
                    (None, _) => true,
                    (Some(_), None) => false,
                    (Some(at), Some(s)) => at <= s,
                }
        }
        ConnAttentionKind::TurnFinished => {
            if active_at(now) {
                return true;
            }
            // A completion that landed during the snooze stays held after the wake.
            match (at, snoozed_at) {
                (Some(at), Some(s)) if at < s => false,
                (Some(at), _) => active_at(at),
                (None, _) => false,
            }
        }
    }
}

/// An event for the outbox, before it has an id and a time.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Planned {
    pub event_type: ConnAttentionEventType,
    pub kind: Option<ConnAttentionKind>,
    pub request_id: Option<String>,
    pub title: Option<String>,
    /// Hold it this long before the first send (the released-completion grace).
    pub delay_ms: u64,
}

/// Writes the attention events of one shell change, inside the commit's transaction.
/// `previous` is the thread's stored shell row before this write, `next` the new one.
pub(crate) fn record(
    conn: &Connection,
    thread_id: &str,
    previous: Option<&Value>,
    next: &Value,
    now_ms: u64,
    now_iso: &str,
) -> StoreResult<bool> {
    let mut planned: Vec<Planned> = Vec::new();
    let Some(previous) = previous else {
        return Ok(false);
    };
    if !eligible(next) {
        return Ok(false);
    }
    let before = need(previous);
    let after = need(next);

    // A new run inside a background wake's grace cancels its completion.
    if previous["latestRunId"] != next["latestRunId"] {
        conn.execute(
            "DELETE FROM attention_outbox WHERE thread_id = ?1 AND kind = 'turn_finished'
             AND type = 'attention' AND attempts = 0 AND next_attempt_ms > ?2",
            params![thread_id, now_ms as i64],
        )
        .map_err(err)?;
    }

    // A request that was sent and is now answered.
    if let Some(request_id) = before.as_ref().and_then(|n| n.request_id.as_deref())
        && after.as_ref().and_then(|n| n.request_id.as_deref()) != Some(request_id)
        && !request_open(conn, thread_id, request_id)?
        && mark_cleared(conn, thread_id, Some(request_id))?
    {
        planned.push(cleared(Some(request_id)));
    }

    // The thread was opened somewhere after an event was sent.
    let opened = (next["lastVisitedAt"] != previous["lastVisitedAt"]
        && !next["lastVisitedAt"].is_null())
        || next["opens"] != previous["opens"];
    if opened && mark_cleared(conn, thread_id, None)? {
        planned.push(cleared(None));
    }

    if let Some(need) = after
        && before.as_ref().map(Need::key) != Some(need.key())
        && !snoozed(next, &need, now_ms)
        && remember_sent(conn, thread_id, &need, now_ms)?
    {
        let grace =
            need.kind == ConnAttentionKind::TurnFinished && next["latestRunBackgroundWake"] == true;
        planned.push(Planned {
            event_type: ConnAttentionEventType::Attention,
            kind: Some(need.kind),
            request_id: need.request_id,
            title: text(next, "title").and_then(attention_title),
            delay_ms: if grace {
                RELEASED_COMPLETION_GRACE_MS
            } else {
                0
            },
        });
    }

    for event in &planned {
        enqueue(conn, thread_id, event, now_ms, now_iso)?;
    }
    Ok(!planned.is_empty())
}

fn cleared(request_id: Option<&str>) -> Planned {
    Planned {
        event_type: ConnAttentionEventType::AttentionCleared,
        kind: None,
        request_id: request_id.map(str::to_owned),
        title: None,
        delay_ms: 0,
    }
}

fn err(e: rusqlite::Error) -> String {
    format!("store: {e}")
}

/// Whether a request is still waiting: a pending runtime request or a waiting secret.
fn request_open(conn: &Connection, thread_id: &str, request_id: &str) -> StoreResult<bool> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM entities WHERE thread_id = ?1 AND id = ?2 AND (
           (kind = 'runtimeRequests' AND json_extract(body, '$.status') = 'pending')
           OR (kind = 'turnItems' AND json_extract(body, '$.type') = 'secret_request'
               AND json_extract(body, '$.status') = 'waiting')))",
        params![thread_id, request_id],
        |row| row.get(0),
    )
    .map_err(err)
}

/// Records `need` as sent. False when its key was sent before.
fn remember_sent(
    conn: &Connection,
    thread_id: &str,
    need: &Need,
    now_ms: u64,
) -> StoreResult<bool> {
    conn.execute(
        "DELETE FROM attention_sent WHERE sent_ms < ?1",
        [now_ms.saturating_sub(SENT_KEY_TTL_MS) as i64],
    )
    .map_err(err)?;
    let inserted = conn
        .execute(
            "INSERT OR IGNORE INTO attention_sent (thread_id, key, request_id, sent_ms)
             VALUES (?1, ?2, ?3, ?4)",
            params![thread_id, need.key(), need.request_id, now_ms as i64],
        )
        .map_err(err)?;
    Ok(inserted == 1)
}

/// Marks sent events as cleared: the one for `request_id`, or every one of the thread.
/// True when one was still open, so a clear must go out.
fn mark_cleared(conn: &Connection, thread_id: &str, request_id: Option<&str>) -> StoreResult<bool> {
    let changed = match request_id {
        Some(request_id) => conn.execute(
            "UPDATE attention_sent SET cleared = 1
             WHERE thread_id = ?1 AND request_id = ?2 AND cleared = 0",
            params![thread_id, request_id],
        ),
        None => conn.execute(
            "UPDATE attention_sent SET cleared = 1 WHERE thread_id = ?1 AND cleared = 0",
            params![thread_id],
        ),
    }
    .map_err(err)?;
    Ok(changed > 0)
}

fn enqueue(
    conn: &Connection,
    thread_id: &str,
    event: &Planned,
    now_ms: u64,
    now_iso: &str,
) -> StoreResult<()> {
    conn.execute(
        "INSERT INTO attention_outbox (event_id, type, kind, thread_id, request_id, occurred_at,
           thread_title, created_ms, next_attempt_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            conn_support::ulid(now_ms),
            event.event_type.as_str(),
            event.kind.map(ConnAttentionKind::as_str),
            thread_id,
            event.request_id,
            now_iso,
            event.title,
            now_ms as i64,
            now_ms.saturating_add(event.delay_ms) as i64,
        ],
    )
    .map(drop)
    .map_err(err)
}

/// One event waiting in the outbox.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AttentionOutboxRow {
    /// The row, for [`crate::SqliteEngine::attention_delivered`] and `attention_retry`.
    pub outbox_id: i64,
    /// Sends that failed so far.
    pub attempts: u32,
    /// When the event was written, by the engine's clock.
    pub created_ms: u64,
    pub event_id: String,
    pub event_type: ConnAttentionEventType,
    pub kind: Option<ConnAttentionKind>,
    pub thread_id: String,
    pub request_id: Option<String>,
    pub occurred_at: String,
    pub thread_title: Option<String>,
}

impl AttentionOutboxRow {
    /// The Gateway body for this server's environment.
    pub fn to_event(&self, environment_id: &str) -> ConnAttentionEvent {
        ConnAttentionEvent {
            event_id: self.event_id.clone(),
            event_type: self.event_type,
            kind: self.kind,
            environment_id: environment_id.to_owned(),
            thread_id: self.thread_id.clone(),
            request_id: self.request_id.clone(),
            occurred_at: self.occurred_at.clone(),
            thread_title: self.thread_title.clone(),
        }
    }
}

/// Up to `limit` events due at `now_ms`, oldest due first. Rows a later version wrote in a
/// shape this one cannot read are skipped.
pub(crate) fn due(
    conn: &Connection,
    now_ms: u64,
    limit: usize,
) -> StoreResult<Vec<AttentionOutboxRow>> {
    let mut statement = conn
        .prepare(
            "SELECT id, attempts, created_ms, event_id, type, kind, thread_id, request_id,
                    occurred_at, thread_title
             FROM attention_outbox WHERE next_attempt_ms <= ?1
             ORDER BY next_attempt_ms, id LIMIT ?2",
        )
        .map_err(err)?;
    let rows = statement
        .query_map(
            params![now_ms as i64, i64::try_from(limit).unwrap_or(i64::MAX)],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, Option<String>>(9)?,
                ))
            },
        )
        .map_err(err)?;
    let mut out = Vec::new();
    for row in rows {
        let (id, attempts, created, event_id, kind_of, kind, thread_id, request_id, at, title) =
            row.map_err(err)?;
        let Some(event_type) = ConnAttentionEventType::parse(&kind_of) else {
            continue;
        };
        let kind = match kind.as_deref().map(ConnAttentionKind::parse) {
            Some(None) => continue,
            Some(Some(kind)) => Some(kind),
            None => None,
        };
        out.push(AttentionOutboxRow {
            outbox_id: id,
            attempts: u32::try_from(attempts.max(0)).unwrap_or(u32::MAX),
            created_ms: u64::try_from(created.max(0)).unwrap_or(0),
            event_id,
            event_type,
            kind,
            thread_id,
            request_id,
            occurred_at: at,
            thread_title: title,
        });
    }
    Ok(out)
}

/// When the next event is due, if any is waiting.
pub(crate) fn next_due(conn: &Connection) -> StoreResult<Option<u64>> {
    conn.query_row(
        "SELECT MIN(next_attempt_ms) FROM attention_outbox",
        [],
        |row| row.get::<_, Option<i64>>(0),
    )
    .optional()
    .map(|at| at.flatten().map(|at| u64::try_from(at.max(0)).unwrap_or(0)))
    .map_err(err)
}

pub(crate) fn delivered(conn: &Connection, outbox_id: i64) -> StoreResult<()> {
    conn.execute("DELETE FROM attention_outbox WHERE id = ?1", [outbox_id])
        .map(drop)
        .map_err(err)
}

pub(crate) fn retry(
    conn: &Connection,
    outbox_id: i64,
    attempts: u32,
    at_ms: u64,
) -> StoreResult<()> {
    conn.execute(
        "UPDATE attention_outbox SET attempts = ?2, next_attempt_ms = ?3 WHERE id = ?1",
        params![outbox_id, i64::from(attempts), at_ms as i64],
    )
    .map(drop)
    .map_err(err)
}

/// Drops events written before `before_ms`. Returns how many.
pub(crate) fn drop_older(conn: &Connection, before_ms: u64) -> StoreResult<usize> {
    conn.execute(
        "DELETE FROM attention_outbox WHERE created_ms < ?1",
        [before_ms as i64],
    )
    .map_err(err)
}

#[cfg(test)]
#[path = "attention_tests.rs"]
mod tests;
