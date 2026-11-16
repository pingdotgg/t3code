//! The webhook delivery log and the replay keys, in `<state>/scheduled-task-webhooks.sqlite`,
//! with the T3 server's tables and rules (`scheduled_task_webhook_deliveries`,
//! `scheduled_task_webhook_replay_keys`). Each call opens the file, works, and closes it, so
//! nothing stays in memory between deliveries. Blocking: call it from a blocking thread.

use std::path::Path;

use rusqlite::{Connection, OptionalExtension, params};

/// Rows kept per task in each bucket (`WEBHOOK_DELIVERY_RETENTION` and the two suppression
/// buckets).
pub const MAIN_RETENTION: i64 = 50;
pub const DEDUPE_RETENTION: i64 = 20;
pub const FILTERED_RETENTION: i64 = 20;
/// `PROMPT_TOO_LONG`: its rows count in the suppression bucket.
pub const PROMPT_TOO_LONG: &str = "The filled-in prompt is too long.";
/// How long a replay key holds (7 days).
pub const REPLAY_KEY_MS: i64 = 7 * 24 * 60 * 60 * 1000;

pub type Result<T> = std::result::Result<T, rusqlite::Error>;

/// One logged request, as `recordDelivery` writes it (body, headers and query already
/// limited and redacted by the caller).
#[derive(Clone, PartialEq, Eq)]
pub struct DeliveryRow {
    pub delivery_id: String,
    pub task_id: String,
    pub received_at: String,
    pub method: String,
    pub query: String,
    pub headers_json: String,
    pub body: String,
    pub body_bytes: i64,
    pub body_truncated: bool,
    pub outcome: String,
    pub signature_verified: bool,
    pub missing_fields_json: String,
    pub rendered_prompt: Option<String>,
    pub error: Option<String>,
}

impl std::fmt::Debug for DeliveryRow {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // The body may hold what the sender considers private.
        f.debug_struct("DeliveryRow")
            .field("delivery_id", &self.delivery_id)
            .field("task_id", &self.task_id)
            .field("outcome", &self.outcome)
            .finish_non_exhaustive()
    }
}

fn open(path: &Path) -> Result<Connection> {
    let conn = Connection::open(path)?;
    // A small cache, no memory map: the file is small and read rarely.
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
         PRAGMA synchronous=NORMAL;
         PRAGMA cache_size=-256;
         PRAGMA mmap_size=0;
         PRAGMA busy_timeout=5000;
         CREATE TABLE IF NOT EXISTS scheduled_task_webhook_deliveries (
           delivery_id TEXT PRIMARY KEY,
           task_id TEXT NOT NULL,
           received_at TEXT NOT NULL,
           method TEXT NOT NULL,
           query TEXT NOT NULL,
           headers_json TEXT NOT NULL,
           body TEXT NOT NULL,
           body_bytes INTEGER NOT NULL,
           body_truncated INTEGER NOT NULL,
           outcome TEXT NOT NULL,
           signature_verified INTEGER NOT NULL,
           missing_fields_json TEXT NOT NULL,
           rendered_prompt TEXT,
           error TEXT
         );
         CREATE INDEX IF NOT EXISTS scheduled_task_webhook_deliveries_task
           ON scheduled_task_webhook_deliveries (task_id, received_at);
         CREATE TABLE IF NOT EXISTS scheduled_task_webhook_replay_keys (
           task_id TEXT NOT NULL,
           replay_key TEXT NOT NULL,
           delivery_id TEXT NOT NULL,
           expires_at INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS scheduled_task_webhook_replay_keys_task
           ON scheduled_task_webhook_replay_keys (task_id, replay_key);
         CREATE INDEX IF NOT EXISTS scheduled_task_webhook_replay_keys_delivery
           ON scheduled_task_webhook_replay_keys (delivery_id);",
    )?;
    Ok(conn)
}

/// The SQL for a row's retention bucket (`deliveryBucket`).
const ROW_BUCKET: &str = "CASE WHEN outcome = 'filtered' THEN 'filtered'
  WHEN outcome IN ('duplicate', 'coalesced', 'rate_limited')
    OR error = 'The filled-in prompt is too long.' THEN 'dedupe'
  ELSE 'main' END";

/// `deliveryBucket`: each suppression bucket keeps its own rows, never real run history.
pub fn bucket(outcome: &str, error: Option<&str>) -> &'static str {
    match outcome {
        "filtered" => "filtered",
        "duplicate" | "coalesced" | "rate_limited" => "dedupe",
        _ if error == Some(PROMPT_TOO_LONG) => "dedupe",
        _ => "main",
    }
}

fn prune(conn: &Connection, task_id: &str, bucket: &str) -> Result<()> {
    let keep = match bucket {
        "main" => MAIN_RETENTION,
        "filtered" => FILTERED_RETENTION,
        _ => DEDUPE_RETENTION,
    };
    conn.execute(
        &format!(
            "DELETE FROM scheduled_task_webhook_deliveries
             WHERE task_id = ?1 AND ({ROW_BUCKET}) = ?2
               AND delivery_id NOT IN (
                 SELECT delivery_id FROM scheduled_task_webhook_deliveries
                 WHERE task_id = ?1 AND ({ROW_BUCKET}) = ?2
                 ORDER BY received_at DESC, rowid DESC LIMIT ?3)"
        ),
        params![task_id, bucket, keep],
    )?;
    Ok(())
}

/// `recordDelivery`: writes the row and trims its bucket. A second write of the same id
/// replaces the outcome fields.
pub fn record(path: &Path, row: &DeliveryRow) -> Result<()> {
    let mut conn = open(path)?;
    let tx = conn.transaction()?;
    tx.execute(
        "INSERT INTO scheduled_task_webhook_deliveries (
           delivery_id, task_id, received_at, method, query, headers_json, body, body_bytes,
           body_truncated, outcome, signature_verified, missing_fields_json, rendered_prompt, error)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
         ON CONFLICT (delivery_id) DO UPDATE SET
           outcome = excluded.outcome,
           signature_verified = excluded.signature_verified,
           missing_fields_json = excluded.missing_fields_json,
           rendered_prompt = excluded.rendered_prompt,
           error = excluded.error",
        params![
            row.delivery_id,
            row.task_id,
            row.received_at,
            row.method,
            row.query,
            row.headers_json,
            row.body,
            row.body_bytes,
            row.body_truncated,
            row.outcome,
            row.signature_verified,
            row.missing_fields_json,
            row.rendered_prompt,
            row.error,
        ],
    )?;
    prune(
        &tx,
        &row.task_id,
        bucket(&row.outcome, row.error.as_deref()),
    )?;
    tx.commit()
}

/// `markDeliveryFailed`: the delivery's run did not start (or its end was not recorded).
pub fn mark_failed(path: &Path, delivery_id: &str, message: &str) -> Result<()> {
    let mut conn = open(path)?;
    let tx = conn.transaction()?;
    let task: Option<String> = tx
        .query_row(
            "UPDATE scheduled_task_webhook_deliveries
             SET outcome = 'dispatch_failed', error = ?2
             WHERE delivery_id = ?1 RETURNING task_id",
            params![delivery_id, message],
            |row| row.get(0),
        )
        .optional()?;
    // An oversized prompt moves the row into the suppression bucket.
    if let Some(task) = task {
        prune(&tx, &task, bucket("dispatch_failed", Some(message)))?;
    }
    tx.commit()
}

fn read_row(row: &rusqlite::Row<'_>) -> Result<DeliveryRow> {
    Ok(DeliveryRow {
        delivery_id: row.get("delivery_id")?,
        task_id: row.get("task_id")?,
        received_at: row.get("received_at")?,
        method: row.get("method")?,
        query: row.get("query")?,
        headers_json: row.get("headers_json")?,
        body: row.get("body")?,
        body_bytes: row.get("body_bytes")?,
        body_truncated: row.get("body_truncated")?,
        outcome: row.get("outcome")?,
        signature_verified: row.get("signature_verified")?,
        missing_fields_json: row.get("missing_fields_json")?,
        rendered_prompt: row.get("rendered_prompt")?,
        error: row.get("error")?,
    })
}

/// A task's deliveries, newest first (at most 90 rows by the retention rules).
pub fn list(path: &Path, task_id: &str) -> Result<Vec<DeliveryRow>> {
    let conn = open(path)?;
    let mut statement = conn.prepare(
        "SELECT * FROM scheduled_task_webhook_deliveries WHERE task_id = ?1
         ORDER BY received_at DESC, rowid DESC",
    )?;
    let rows = statement.query_map(params![task_id], read_row)?;
    rows.collect()
}

pub fn get(path: &Path, task_id: &str, delivery_id: &str) -> Result<Option<DeliveryRow>> {
    let conn = open(path)?;
    conn.query_row(
        "SELECT * FROM scheduled_task_webhook_deliveries
         WHERE task_id = ?1 AND delivery_id = ?2",
        params![task_id, delivery_id],
        read_row,
    )
    .optional()
}

/// `hasReplayKey`: an empty key never matches.
pub fn has_replay_key(path: &Path, task_id: &str, key: &str, now: i64) -> Result<bool> {
    if key.is_empty() {
        return Ok(false);
    }
    let conn = open(path)?;
    conn.query_row(
        "SELECT 1 FROM scheduled_task_webhook_replay_keys
         WHERE task_id = ?1 AND replay_key = ?2 AND expires_at > ?3",
        params![task_id, key, now],
        |_| Ok(()),
    )
    .optional()
    .map(|found| found.is_some())
}

/// `claimReplayKey`, with `hasReplayKey` in the same transaction: drops expired keys and
/// records this one for 7 days. `false` when a live key already holds it.
pub fn claim_replay_key(
    path: &Path,
    task_id: &str,
    key: &str,
    delivery_id: &str,
    now: i64,
) -> Result<bool> {
    if key.is_empty() {
        return Ok(true);
    }
    let mut conn = open(path)?;
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let held = tx
        .query_row(
            "SELECT 1 FROM scheduled_task_webhook_replay_keys
             WHERE task_id = ?1 AND replay_key = ?2 AND expires_at > ?3",
            params![task_id, key, now],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if held {
        return Ok(false);
    }
    tx.execute(
        "DELETE FROM scheduled_task_webhook_replay_keys WHERE expires_at <= ?1",
        params![now],
    )?;
    tx.execute(
        "INSERT INTO scheduled_task_webhook_replay_keys (task_id, replay_key, delivery_id, expires_at)
         VALUES (?1, ?2, ?3, ?4)",
        params![task_id, key, delivery_id, now.saturating_add(REPLAY_KEY_MS)],
    )?;
    tx.commit()?;
    Ok(true)
}

/// `releaseWebhookReplay`: a delivery that did not run gives its key back.
pub fn release_replay(path: &Path, delivery_id: &str) -> Result<()> {
    let conn = open(path)?;
    conn.execute(
        "DELETE FROM scheduled_task_webhook_replay_keys WHERE delivery_id = ?1",
        params![delivery_id],
    )?;
    Ok(())
}

/// A deleted task's deliveries and keys.
pub fn delete_task(path: &Path, task_id: &str) -> Result<()> {
    if !path.exists() {
        return Ok(());
    }
    let mut conn = open(path)?;
    let tx = conn.transaction()?;
    tx.execute(
        "DELETE FROM scheduled_task_webhook_deliveries WHERE task_id = ?1",
        params![task_id],
    )?;
    tx.execute(
        "DELETE FROM scheduled_task_webhook_replay_keys WHERE task_id = ?1",
        params![task_id],
    )?;
    tx.commit()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(id: &str, outcome: &str, at: &str) -> DeliveryRow {
        DeliveryRow {
            delivery_id: id.to_owned(),
            task_id: "t".to_owned(),
            received_at: at.to_owned(),
            method: "POST".to_owned(),
            query: String::new(),
            headers_json: "{}".to_owned(),
            body: String::new(),
            body_bytes: 0,
            body_truncated: false,
            outcome: outcome.to_owned(),
            signature_verified: false,
            missing_fields_json: "[]".to_owned(),
            rendered_prompt: None,
            error: None,
        }
    }

    #[test]
    fn retention_keeps_each_bucket_apart() {
        let dir =
            std::env::temp_dir().join(format!("conn-hooks-store-{}", conn_support::uuid_v4()));
        std::fs::create_dir_all(&dir).expect("dir");
        let db = dir.join("hooks.sqlite");
        for i in 0..60 {
            record(
                &db,
                &row(
                    &format!("m{i}"),
                    "accepted",
                    &format!("2026-01-01T00:00:{i:02}.000Z"),
                ),
            )
            .expect("record");
        }
        for i in 0..30 {
            record(
                &db,
                &row(
                    &format!("f{i}"),
                    "filtered",
                    &format!("2026-01-01T00:01:{i:02}.000Z"),
                ),
            )
            .expect("record");
            record(
                &db,
                &row(
                    &format!("d{i}"),
                    "duplicate",
                    &format!("2026-01-01T00:02:{i:02}.000Z"),
                ),
            )
            .expect("record");
        }
        let rows = list(&db, "t").expect("list");
        let count = |prefix: &str| {
            rows.iter()
                .filter(|r| r.delivery_id.starts_with(prefix))
                .count()
        };
        assert_eq!((count("m"), count("f"), count("d")), (50, 20, 20));
        assert_eq!(rows.first().map(|r| r.delivery_id.as_str()), Some("d29"));
        // A failed prompt moves a main row to the suppression bucket.
        mark_failed(&db, "m59", PROMPT_TOO_LONG).expect("mark");
        assert_eq!(
            get(&db, "t", "m59").expect("get").map(|r| r.outcome),
            None,
            "trimmed: the dedupe bucket was full of newer rows"
        );
        delete_task(&db, "t").expect("delete");
        assert!(list(&db, "t").expect("list").is_empty());
        std::fs::remove_dir_all(dir).expect("clean up");
    }

    #[test]
    fn replay_keys_expire_and_release() {
        let dir = std::env::temp_dir().join(format!("conn-hooks-keys-{}", conn_support::uuid_v4()));
        std::fs::create_dir_all(&dir).expect("dir");
        let db = dir.join("hooks.sqlite");
        assert!(!has_replay_key(&db, "t", "", 0).expect("empty"));
        assert!(claim_replay_key(&db, "t", "k", "d1", 1_000).expect("claim"));
        assert!(!claim_replay_key(&db, "t", "k", "d2", 1_500).expect("held"));
        assert!(has_replay_key(&db, "t", "k", 2_000).expect("held"));
        assert!(!has_replay_key(&db, "u", "k", 2_000).expect("per task"));
        assert!(!has_replay_key(&db, "t", "k", 1_000 + REPLAY_KEY_MS).expect("expired"));
        release_replay(&db, "d1").expect("release");
        assert!(!has_replay_key(&db, "t", "k", 2_000).expect("released"));
        std::fs::remove_dir_all(dir).expect("clean up");
    }

    /// A replay key is kept 7 days by the wall clock, as T3's `claimReplayKey`
    /// (`webhookDedupe.ts`): it still holds after a container woke 10 minutes, 2 hours or
    /// 3 days later, and is gone after 7 days.
    #[test]
    fn replay_keys_hold_through_wall_clock_jumps() {
        let dir = std::env::temp_dir().join(format!("conn-hooks-jump-{}", conn_support::uuid_v4()));
        std::fs::create_dir_all(&dir).expect("dir");
        let db = dir.join("hooks.sqlite");
        let t0 = 1_782_896_400_000;
        assert!(claim_replay_key(&db, "t", "k", "d1", t0).expect("claim"));
        for jump_ms in [600_000, 7_200_000, 259_200_000] {
            assert!(has_replay_key(&db, "t", "k", t0 + jump_ms).expect("held"));
            assert!(!claim_replay_key(&db, "t", "k", "d2", t0 + jump_ms).expect("duplicate"));
        }
        assert!(claim_replay_key(&db, "t", "k", "d3", t0 + REPLAY_KEY_MS).expect("expired"));
        std::fs::remove_dir_all(dir).expect("clean up");
    }
}
