//! The SQLite store: the event log, the projections the streams read, command receipts.
//!
//! One connection, one writer. Every write runs inside a [`Tx`]: a command or a batch of
//! provider events appends events, each event updates the projection in the same
//! transaction, and the commit recomputes the shell rows it touched. Nothing here keeps a
//! thread's history in memory; snapshots and replays read it back from SQLite.
//!
//! Settings chosen for memory: WAL, `synchronous=NORMAL` (no fsync per commit), a 1 MiB page
//! cache, no mmap, and no statement cache (the `cache` feature is off).

use std::path::Path;

use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde_json::{Value, json};

use crate::shell;
use crate::time::now_iso;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS events (
  seq       INTEGER PRIMARY KEY,
  thread_id TEXT NOT NULL,
  command_id TEXT,
  type      TEXT NOT NULL,
  streaming INTEGER NOT NULL DEFAULT 0,
  event     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_by_thread ON events(thread_id, seq);
CREATE TABLE IF NOT EXISTS threads (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  deleted     INTEGER NOT NULL DEFAULT 0,
  activity_at TEXT NOT NULL,
  thread      TEXT NOT NULL,
  shell       TEXT
);
CREATE TABLE IF NOT EXISTS entities (
  thread_id TEXT NOT NULL,
  kind      TEXT NOT NULL,
  id        TEXT NOT NULL,
  first_seq INTEGER NOT NULL,
  seq       INTEGER NOT NULL,
  ordinal   INTEGER,
  body      TEXT NOT NULL,
  PRIMARY KEY (thread_id, kind, id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS projects (
  id             TEXT PRIMARY KEY,
  workspace_root TEXT NOT NULL UNIQUE,
  body           TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS shell_changes (
  seq  INTEGER PRIMARY KEY,
  item TEXT NOT NULL
);
-- Final message texts for `searchThreads`. Trigram tokens make LIKE '%q%' an index lookup
-- for queries of three or more characters. `message_keys` gives each message a stable rowid.
CREATE VIRTUAL TABLE IF NOT EXISTS message_search USING fts5(text, tokenize = 'trigram');
CREATE TABLE IF NOT EXISTS message_keys (
  id         INTEGER PRIMARY KEY,
  thread_id  TEXT NOT NULL,
  message_id TEXT NOT NULL,
  UNIQUE (thread_id, message_id)
);
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS receipts (
  command_id   TEXT PRIMARY KEY,
  command_type TEXT NOT NULL,
  sequence     INTEGER NOT NULL
);
";

/// The projection collections of `OrchestrationV2ThreadProjection`, in its field order.
pub(crate) const COLLECTIONS: [&str; 15] = [
    "runs",
    "attempts",
    "nodes",
    "subagents",
    "providerSessions",
    "providerThreads",
    "providerTurns",
    "runtimeRequests",
    "messages",
    "plans",
    "turnItems",
    "checkpointScopes",
    "checkpoints",
    "contextHandoffs",
    "contextTransfers",
];

/// The projection collection an event type replaces an entity in. One line per event kind.
fn collection_of(event_type: &str) -> Option<&'static str> {
    Some(match event_type {
        "run.created" | "run.updated" => "runs",
        "run-attempt.created" | "run-attempt.updated" => "attempts",
        "node.updated" => "nodes",
        "subagent.updated" => "subagents",
        "provider-session.attached" | "provider-session.updated" => "providerSessions",
        "provider-thread.updated" => "providerThreads",
        "provider-turn.updated" => "providerTurns",
        "runtime-request.updated" => "runtimeRequests",
        "message.updated" => "messages",
        "plan.updated" => "plans",
        "turn-item.updated" => "turnItems",
        "checkpoint-scope.created" => "checkpointScopes",
        "checkpoint.captured" => "checkpoints",
        "context-handoff.updated" => "contextHandoffs",
        "context-transfer.created" | "context-transfer.updated" => "contextTransfers",
        _ => return None,
    })
}

/// Events that change only a row's body: they move the shell only when they add a row.
fn streams_only(event_type: &str) -> bool {
    matches!(
        event_type,
        "message.updated" | "turn-item.updated" | "node.updated" | "provider-turn.updated"
    )
}

pub(crate) type StoreResult<T> = Result<T, String>;

/// Shell changes kept for resuming streams. An older cursor gets a fresh snapshot instead.
pub(crate) const SHELL_CHANGES_KEEP: i64 = 1024;
/// Command receipts kept for retries. Clients retry within seconds, not thousands of commands.
pub(crate) const RECEIPTS_KEEP: i64 = 4096;
/// Retention runs when the sequence crosses a multiple of this, not on every commit.
const PRUNE_EVERY: u64 = 256;

fn err(e: rusqlite::Error) -> String {
    format!("store: {e}")
}

/// A stored JSON column. The engine wrote it, so bad JSON is a broken store, not a value.
fn parse(text: String) -> StoreResult<Value> {
    serde_json::from_str(&text).map_err(|e| format!("store: a stored row is not JSON: {e}"))
}

/// Every row of a one-column JSON query; the first row error fails the read.
fn json_rows(rows: impl Iterator<Item = rusqlite::Result<String>>) -> StoreResult<Vec<Value>> {
    rows.map(|row| row.map_err(err).and_then(parse)).collect()
}

/// Every row of a text-and-JSON query.
fn keyed_rows(
    rows: impl Iterator<Item = rusqlite::Result<(String, String)>>,
) -> StoreResult<Vec<(String, Value)>> {
    rows.map(|row| {
        let (key, body) = row.map_err(err)?;
        Ok((key, parse(body)?))
    })
    .collect()
}

pub(crate) struct Store {
    conn: Connection,
    next_seq: u64,
    /// A title generator is configured, so commands may ask for titles.
    pub(crate) generates_titles: bool,
}

impl Store {
    pub(crate) fn open(path: &Path) -> StoreResult<Self> {
        let conn = Connection::open(path).map_err(err)?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA synchronous=NORMAL;
             PRAGMA cache_size=-1024;
             PRAGMA mmap_size=0;
             PRAGMA journal_size_limit=4194304;",
        )
        .map_err(err)?;
        conn.execute_batch(SCHEMA).map_err(err)?;
        migrate(&conn)?;
        let high: i64 = conn
            .query_row(
                "SELECT MAX(COALESCE((SELECT MAX(seq) FROM events), 0),
                            COALESCE((SELECT MAX(seq) FROM shell_changes), 0),
                            COALESCE((SELECT MAX(sequence) FROM receipts), 0))",
                [],
                |row| row.get(0),
            )
            .map_err(err)?;
        Ok(Self {
            conn,
            next_seq: high as u64 + 1,
            generates_titles: false,
        })
    }

    /// `EXPLAIN QUERY PLAN` details, one per step, for tests that prove an index is used.
    #[cfg(test)]
    pub(crate) fn query_plan(&self, sql: &str, args: impl rusqlite::Params) -> Vec<String> {
        let explain = format!("EXPLAIN QUERY PLAN {sql}");
        let Ok(mut stmt) = self.conn.prepare(&explain) else {
            return vec![];
        };
        stmt.query_map(args, |row| row.get::<_, String>(3))
            .and_then(|rows| rows.collect())
            .unwrap_or_default()
    }

    /// The sequence of the last committed change.
    pub(crate) fn high_water(&self) -> u64 {
        self.next_seq - 1
    }

    pub(crate) fn tx(&mut self) -> StoreResult<Tx<'_>> {
        let start = self.next_seq;
        let generates_titles = self.generates_titles;
        Ok(Tx {
            generates_titles,
            tx: self.conn.transaction().map_err(err)?,
            store_seq: &mut self.next_seq,
            next_seq: start,
            start,
            now: now_iso(),
            touched: Vec::new(),
        })
    }

    pub(crate) fn receipt(&self, command_id: &str) -> StoreResult<Option<u64>> {
        self.conn
            .query_row(
                "SELECT sequence FROM receipts WHERE command_id = ?1",
                [command_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map(|seq| seq.map(|s| s as u64))
            .map_err(err)
    }

    pub(crate) fn thread_exists(&self, thread_id: &str) -> StoreResult<bool> {
        thread(&self.conn, thread_id).map(|t| t.is_some())
    }

    /// `OrchestrationV2ShellSnapshot` as of [`Self::high_water`].
    pub(crate) fn shell_snapshot(&self) -> StoreResult<Value> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT shell FROM threads WHERE deleted = 0 AND shell IS NOT NULL ORDER BY rowid",
            )
            .map_err(err)?;
        let threads: Vec<Value> = json_rows(
            stmt.query_map([], |row| row.get::<_, String>(0))
                .map_err(err)?,
        )?
        .into_iter()
        .filter(|row| row["archivedAt"].is_null())
        .collect();
        let mut stmt = self
            .conn
            .prepare("SELECT body FROM projects ORDER BY rowid")
            .map_err(err)?;
        let projects: Vec<Value> = json_rows(
            stmt.query_map([], |row| row.get::<_, String>(0))
                .map_err(err)?,
        )?
        .into_iter()
        .filter(|project| project["deletedAt"].is_null())
        .map(|project| shell_project(&project))
        .collect();
        Ok(json!({
            "schemaVersion": 2,
            "snapshotSequence": self.high_water(),
            "threads": threads,
            "archivedThreads": [],
            "projects": projects,
        }))
    }

    /// Shell changes after `after`, or `None` when retention already dropped some of them.
    pub(crate) fn shell_changes_since(&self, after: u64) -> StoreResult<Option<Vec<Value>>> {
        let pruned: i64 = self
            .conn
            .query_row(
                "SELECT COALESCE((SELECT value FROM meta WHERE key = 'shell_pruned_through'), 0)",
                [],
                |row| row.get(0),
            )
            .map_err(err)?;
        // Every change above the pruned mark is kept.
        if (after as i64) < pruned {
            return Ok(None);
        }
        self.shell_changes_after(after).map(Some)
    }

    pub(crate) fn shell_changes_after(&self, after: u64) -> StoreResult<Vec<Value>> {
        let mut stmt = self
            .conn
            .prepare("SELECT item FROM shell_changes WHERE seq > ?1 ORDER BY seq")
            .map_err(err)?;
        let rows = json_rows(
            stmt.query_map([after as i64], |row| row.get::<_, String>(0))
                .map_err(err)?,
        )?;
        Ok(rows)
    }

    /// `OrchestrationV2ThreadProjection`, or `None` for an unknown or deleted thread.
    pub(crate) fn thread_projection(&self, thread_id: &str) -> StoreResult<Option<Value>> {
        self.thread_projection_with(thread_id, false)
    }

    /// The projection, built with one copy of each turn item: it lives in `visibleTurnItems`,
    /// and `turnItems` holds the same values unless `omit_local_items` (the client restores
    /// them from `visibleTurnItems` when the snapshot says `turnItemsOmitLocalVisible`).
    pub(crate) fn thread_projection_with(
        &self,
        thread_id: &str,
        omit_local_items: bool,
    ) -> StoreResult<Option<Value>> {
        let row = self
            .conn
            .query_row(
                "SELECT thread, activity_at, deleted FROM threads WHERE id = ?1",
                [thread_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, bool>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(err)?;
        let Some((thread, activity_at, false)) = row else {
            return Ok(None);
        };
        let mut projection = serde_json::Map::new();
        projection.insert("thread".into(), parse(thread)?);
        for kind in COLLECTIONS {
            let rows = if kind == "turnItems" {
                vec![]
            } else {
                entities(&self.conn, thread_id, kind)?
            };
            projection.insert(kind.into(), Value::Array(rows));
        }
        // Turn items in timeline order, read once and moved into their rows.
        let items = self.query_json(
            "SELECT body FROM entities WHERE thread_id = ?1 AND kind = 'turnItems'
             ORDER BY ordinal, id",
            [thread_id],
        )?;
        if !omit_local_items {
            projection.insert("turnItems".into(), Value::Array(items.clone()));
        }
        let visible: Vec<Value> = items
            .into_iter()
            .enumerate()
            .map(|(position, item)| {
                json!({
                    "position": position,
                    "visibility": "local",
                    "sourceThreadId": thread_id,
                    "sourceItemId": item["id"].clone(),
                    "item": item,
                })
            })
            .collect();
        projection.insert("visibleTurnItems".into(), Value::Array(visible));
        projection.insert("updatedAt".into(), Value::String(activity_at));
        Ok(Some(Value::Object(projection)))
    }

    /// Stored events of one thread after `after`, at most `limit`, as `(sequence, event)`.
    pub(crate) fn thread_events_after(
        &self,
        thread_id: &str,
        after: u64,
        limit: usize,
    ) -> StoreResult<Vec<(u64, Value)>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT seq, event FROM events WHERE thread_id = ?1 AND seq > ?2 ORDER BY seq LIMIT ?3",
            )
            .map_err(err)?;
        let rows = stmt
            .query_map(params![thread_id, after as i64, limit as i64], |row| {
                Ok((row.get::<_, i64>(0)? as u64, row.get::<_, String>(1)?))
            })
            .map_err(err)?
            .map(|row| {
                let (seq, text) = row.map_err(err)?;
                Ok((seq, parse(text)?))
            })
            .collect::<StoreResult<Vec<_>>>()?;
        Ok(rows)
    }

    /// One page of the whole event log after `after`, oldest first, as
    /// `OrchestrationV2StoredEvent` rows (`sequence`, `commandId`, `event`).
    pub(crate) fn stored_events_after(&self, after: u64, limit: usize) -> StoreResult<Vec<Value>> {
        let mut stmt = self
            .conn
            .prepare("SELECT seq, command_id, event FROM events WHERE seq > ?1 ORDER BY seq LIMIT ?2")
            .map_err(err)?;
        let rows = stmt
            .query_map(params![after as i64, limit as i64], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(err)?
            .map(|row| {
                let (seq, command_id, text) = row.map_err(err)?;
                Ok(json!({"sequence": seq, "commandId": command_id, "event": parse(text)?}))
            })
            .collect::<StoreResult<Vec<_>>>()?;
        Ok(rows)
    }

    /// One JSON column per row.
    pub(crate) fn query_json(
        &self,
        sql: &str,
        args: impl rusqlite::Params,
    ) -> StoreResult<Vec<Value>> {
        let mut stmt = self.conn.prepare(sql).map_err(err)?;
        let rows = json_rows(
            stmt.query_map(args, |row| row.get::<_, String>(0))
                .map_err(err)?,
        )?;
        Ok(rows)
    }

    /// A text column and a JSON column per row.
    pub(crate) fn query_rows(
        &self,
        sql: &str,
        args: impl rusqlite::Params,
    ) -> StoreResult<Vec<(String, Value)>> {
        let mut stmt = self.conn.prepare(sql).map_err(err)?;
        let rows = stmt
            .query_map(args, |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(err)?;
        keyed_rows(rows)
    }

    /// Runs that were live when the store was last written: `(thread_id, run)`.
    pub(crate) fn unfinished_runs(&self) -> StoreResult<Vec<(String, Value)>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT thread_id, body FROM entities WHERE kind = 'runs'
                 AND json_extract(body, '$.status') IN ('preparing','queued','starting','running','waiting')",
            )
            .map_err(err)?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(err)?;
        keyed_rows(rows)
    }

    #[cfg(test)]
    pub(crate) fn event_count(&self, thread_id: &str) -> u64 {
        self.conn
            .query_row(
                "SELECT COUNT(*) FROM events WHERE thread_id = ?1",
                [thread_id],
                |row| row.get::<_, i64>(0),
            )
            .unwrap_or(0) as u64
    }
}

/// One atomic write. Reads inside it see its own appends.
pub(crate) struct Tx<'a> {
    tx: Transaction<'a>,
    /// The store's counter. Written only after the commit succeeds, so a failed or dropped
    /// write gives back the sequences it took.
    store_seq: &'a mut u64,
    /// The next sequence inside this write.
    next_seq: u64,
    start: u64,
    now: String,
    /// Threads whose shell row may have changed, with the last sequence that touched them.
    touched: Vec<(String, u64)>,
    pub(crate) generates_titles: bool,
}

impl Tx<'_> {
    pub(crate) fn now(&self) -> &str {
        &self.now
    }

    fn alloc(&mut self) -> u64 {
        let seq = self.next_seq;
        self.next_seq += 1;
        seq
    }

    /// Appends one domain event and applies it to the projection. Returns its sequence.
    pub(crate) fn append(&mut self, draft: Draft) -> StoreResult<u64> {
        let seq = self.alloc();
        let Draft {
            thread_id,
            event_type,
            mut payload,
            run_id,
            node_id,
            command_id,
        } = draft;
        let collection = collection_of(event_type);
        let mut inserted = false;
        if let Some(kind) = collection {
            let id = payload["id"].as_str().unwrap_or_default().to_owned();
            let existing: Option<(i64, Option<i64>)> = self
                .tx
                .query_row(
                    "SELECT first_seq, ordinal FROM entities WHERE thread_id = ?1 AND kind = ?2 AND id = ?3",
                    params![thread_id, kind, id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
                .map_err(err)?;
            inserted = existing.is_none();
            let ordinal = match kind {
                "turnItems" => {
                    // The engine owns turn item positions: a new item goes after every item
                    // of the thread, an update keeps the position it already has.
                    let ordinal = match existing {
                        Some((_, Some(ordinal))) => ordinal,
                        _ => {
                            let max: Option<i64> = self
                                .tx
                                .query_row(
                                    "SELECT MAX(ordinal) FROM entities WHERE thread_id = ?1 AND kind = 'turnItems'",
                                    [&thread_id],
                                    |row| row.get(0),
                                )
                                .map_err(err)?;
                            let wanted = payload["ordinal"].as_i64().unwrap_or(0);
                            wanted.max(max.unwrap_or(0) + 1)
                        }
                    };
                    payload["ordinal"] = json!(ordinal);
                    Some(ordinal)
                }
                "runs" => payload["ordinal"].as_i64(),
                _ => None,
            };
            if kind == "messages" && payload["streaming"] != true {
                index_message(
                    &self.tx,
                    &thread_id,
                    &id,
                    payload["text"].as_str().unwrap_or(""),
                )?;
            }
            let first_seq = existing.map(|(first, _)| first).unwrap_or(seq as i64);
            self.tx
                .execute(
                    "INSERT OR REPLACE INTO entities (thread_id, kind, id, first_seq, seq, ordinal, body)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![thread_id, kind, id, first_seq, seq as i64, ordinal, payload.to_string()],
                )
                .map_err(err)?;
        } else if event_type.starts_with("thread.") {
            let project_id = payload["projectId"].as_str().unwrap_or_default().to_owned();
            let deleted = event_type == "thread.deleted";
            self.tx
                .execute(
                    "INSERT INTO threads (id, project_id, deleted, activity_at, thread) VALUES (?1, ?2, ?3, ?4, ?5)
                     ON CONFLICT(id) DO UPDATE SET project_id = ?2, deleted = ?3, activity_at = ?4, thread = ?5",
                    params![thread_id, project_id, deleted, self.now, payload.to_string()],
                )
                .map_err(err)?;
        } else if event_type == "provider-session.detached" {
            let id = payload["providerSessionId"].as_str().unwrap_or_default();
            self.tx
                .execute(
                    "DELETE FROM entities WHERE thread_id = ?1 AND kind = 'providerSessions' AND id = ?2",
                    params![thread_id, id],
                )
                .map_err(err)?;
        }

        let mut event = json!({
            "id": format!("event:{seq}"),
            "threadId": thread_id,
            "occurredAt": self.now,
            "type": event_type,
            "payload": payload,
        });
        if let Some(run_id) = run_id {
            event["runId"] = json!(run_id);
        }
        if let Some(node_id) = node_id {
            event["nodeId"] = json!(node_id);
        }
        let streaming = event["payload"]["streaming"] == json!(true);
        self.tx
            .execute(
                "INSERT INTO events (seq, thread_id, command_id, type, streaming, event) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![seq as i64, thread_id, command_id, event_type, streaming, event.to_string()],
            )
            .map_err(err)?;
        if collection.is_some() || event_type.starts_with("thread.") {
            self.tx
                .execute(
                    "UPDATE threads SET activity_at = ?2 WHERE id = ?1",
                    params![thread_id, self.now],
                )
                .map_err(err)?;
        }
        if inserted || !streams_only(event_type) {
            match self.touched.iter_mut().find(|(id, _)| *id == thread_id) {
                Some(entry) => entry.1 = seq,
                None => self.touched.push((thread_id, seq)),
            }
        }
        Ok(seq)
    }

    /// Drops streaming versions of rows that have a final version, so the log keeps one event
    /// per finished message instead of one per streamed chunk.
    pub(crate) fn compact_streaming(&mut self, thread_id: &str) -> StoreResult<()> {
        self.tx
            .execute(
                "DELETE FROM events WHERE thread_id = ?1 AND streaming = 1",
                [thread_id],
            )
            .map(|_| ())
            .map_err(err)
    }

    pub(crate) fn thread(&self, thread_id: &str) -> StoreResult<Option<Value>> {
        thread(&self.tx, thread_id)
    }

    pub(crate) fn entity(
        &self,
        thread_id: &str,
        kind: &str,
        id: &str,
    ) -> StoreResult<Option<Value>> {
        self.tx
            .query_row(
                "SELECT body FROM entities WHERE thread_id = ?1 AND kind = ?2 AND id = ?3",
                params![thread_id, kind, id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(err)?
            .map(parse)
            .transpose()
    }

    pub(crate) fn entities(&self, thread_id: &str, kind: &str) -> StoreResult<Vec<Value>> {
        entities(&self.tx, thread_id, kind)
    }

    /// Rows of one collection whose JSON field `field` equals `value`, oldest first.
    pub(crate) fn entities_where(
        &self,
        thread_id: &str,
        kind: &str,
        field: &str,
        value: &str,
    ) -> StoreResult<Vec<Value>> {
        let mut stmt = self
            .tx
            .prepare(
                "SELECT body FROM entities WHERE thread_id = ?1 AND kind = ?2
                 AND json_extract(body, ?3) = ?4 ORDER BY first_seq",
            )
            .map_err(err)?;
        let rows = json_rows(
            stmt.query_map(
                params![thread_id, kind, format!("$.{field}"), value],
                |row| row.get::<_, String>(0),
            )
            .map_err(err)?,
        )?;
        Ok(rows)
    }

    /// The newest run in an active status, read without loading the thread's other runs.
    pub(crate) fn active_run(&self, thread_id: &str) -> StoreResult<Option<Value>> {
        self.tx
            .query_row(
                "SELECT body FROM entities WHERE thread_id = ?1 AND kind = 'runs'
                 AND json_extract(body, '$.status') IN ('preparing', 'starting', 'running', 'waiting')
                 ORDER BY ordinal DESC LIMIT 1",
                [thread_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(err)?
            .map(parse)
            .transpose()
    }

    pub(crate) fn count(&self, thread_id: &str, kind: &str) -> StoreResult<u64> {
        self.tx
            .query_row(
                "SELECT COUNT(*) FROM entities WHERE thread_id = ?1 AND kind = ?2",
                params![thread_id, kind],
                |row| row.get::<_, i64>(0),
            )
            .map(|n| n as u64)
            .map_err(err)
    }

    /// A project that was not deleted.
    pub(crate) fn project(&self, project_id: &str) -> StoreResult<Option<Value>> {
        Ok(self
            .project_any(project_id)?
            .filter(|p| p["deletedAt"].is_null()))
    }

    /// A project row, deleted or not.
    pub(crate) fn project_any(&self, project_id: &str) -> StoreResult<Option<Value>> {
        self.tx
            .query_row(
                "SELECT body FROM projects WHERE id = ?1",
                [project_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(err)?
            .map(parse)
            .transpose()
    }

    /// The project row that owns `workspace_root`, deleted or not.
    pub(crate) fn project_by_root(&self, workspace_root: &str) -> StoreResult<Option<Value>> {
        self.tx
            .query_row(
                "SELECT body FROM projects WHERE workspace_root = ?1",
                [workspace_root],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(err)?
            .map(parse)
            .transpose()
    }

    /// Writes a project row and its shell change: `project.updated`, or `project.removed`
    /// when the body has `deletedAt`. A deleted row that held the same folder gives way.
    pub(crate) fn put_project(&mut self, project: &Value) -> StoreResult<u64> {
        let id = project["id"].as_str().unwrap_or_default();
        let root = project["workspaceRoot"].as_str().unwrap_or_default();
        self.tx
            .execute(
                "DELETE FROM projects WHERE workspace_root = ?1 AND id != ?2",
                params![root, id],
            )
            .map_err(err)?;
        self.tx
            .execute(
                "INSERT INTO projects (id, workspace_root, body) VALUES (?1, ?2, ?3)
                 ON CONFLICT(id) DO UPDATE SET workspace_root = ?2, body = ?3",
                params![id, root, project.to_string()],
            )
            .map_err(err)?;
        let seq = self.alloc();
        let item = if project["deletedAt"].is_null() {
            json!({"kind": "project.updated", "sequence": seq, "project": shell_project(project)})
        } else {
            json!({"kind": "project.removed", "sequence": seq, "projectId": id})
        };
        self.tx
            .execute(
                "INSERT INTO shell_changes (seq, item) VALUES (?1, ?2)",
                params![seq as i64, item.to_string()],
            )
            .map_err(err)?;
        Ok(seq)
    }

    /// Thread ids of one project, archived included, newest first.
    pub(crate) fn project_thread_ids(&self, project_id: &str) -> StoreResult<Vec<String>> {
        let mut stmt = self
            .tx
            .prepare(
                "SELECT id FROM threads WHERE project_id = ?1 AND deleted = 0 ORDER BY rowid DESC",
            )
            .map_err(err)?;
        let rows = stmt
            .query_map([project_id], |row| row.get::<_, String>(0))
            .map_err(err)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(err)?;
        Ok(rows)
    }

    /// Thread rows (not deleted) whose JSON field `field` equals `value`.
    pub(crate) fn threads_where(&self, field: &str, value: &str) -> StoreResult<Vec<Value>> {
        let mut stmt = self
            .tx
            .prepare("SELECT thread FROM threads WHERE deleted = 0 AND json_extract(thread, ?1) = ?2 ORDER BY rowid")
            .map_err(err)?;
        let rows = json_rows(
            stmt.query_map(params![format!("$.{field}"), value], |row| {
                row.get::<_, String>(0)
            })
            .map_err(err)?,
        )?;
        Ok(rows)
    }

    /// Adds a project for `workspace_root` unless a row (even a deleted one) has it, so a
    /// project a client removed stays removed after a restart. Returns its id.
    pub(crate) fn ensure_project(
        &mut self,
        id: &str,
        title: &str,
        workspace_root: &str,
    ) -> StoreResult<String> {
        if let Some(existing) = self.project_by_root(workspace_root)? {
            return Ok(existing["id"].as_str().unwrap_or(id).to_owned());
        }
        let project = new_project(id, title, workspace_root, &self.now);
        self.put_project(&project)?;
        Ok(id.to_owned())
    }

    /// Recomputes touched shell rows, records the receipt, and commits. Returns the sequence
    /// a client waits for: the last change of this write, or the high water if it wrote none.
    pub(crate) fn commit(mut self, receipt: Option<(&str, &str)>) -> StoreResult<u64> {
        for (thread_id, seq) in std::mem::take(&mut self.touched) {
            let previous: Option<(Option<String>, bool)> = self
                .tx
                .query_row(
                    "SELECT shell, deleted FROM threads WHERE id = ?1",
                    [&thread_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
                .map_err(err)?;
            let Some((previous, deleted)) = previous else {
                continue;
            };
            let item = if deleted {
                if previous.is_none() {
                    continue;
                }
                let location = previous
                    .clone()
                    .map(parse)
                    .transpose()?
                    .filter(|row| !row["archivedAt"].is_null())
                    .map_or("active", |_| "archive");
                self.tx
                    .execute(
                        "UPDATE threads SET shell = NULL WHERE id = ?1",
                        [&thread_id],
                    )
                    .map_err(err)?;
                json!({"kind": "thread.removed", "sequence": seq, "location": location, "threadId": thread_id})
            } else {
                let row = shell::thread_shell(&self, &thread_id)?;
                let text = row.to_string();
                if previous.as_deref() == Some(text.as_str()) {
                    continue;
                }
                self.tx
                    .execute(
                        "UPDATE threads SET shell = ?2 WHERE id = ?1",
                        params![thread_id, text],
                    )
                    .map_err(err)?;
                let location = if row["archivedAt"].is_null() {
                    "active"
                } else {
                    "archive"
                };
                json!({"kind": "thread.updated", "sequence": seq, "location": location, "thread": row})
            };
            self.tx
                .execute(
                    "INSERT OR REPLACE INTO shell_changes (seq, item) VALUES (?1, ?2)",
                    params![seq as i64, item.to_string()],
                )
                .map_err(err)?;
        }
        let high = self.next_seq - 1;
        if let Some((command_id, command_type)) = receipt {
            self.tx
                .execute(
                    "INSERT OR REPLACE INTO receipts (command_id, command_type, sequence) VALUES (?1, ?2, ?3)",
                    params![command_id, command_type, high as i64],
                )
                .map_err(err)?;
        }
        if high / PRUNE_EVERY != (self.start.saturating_sub(1)) / PRUNE_EVERY {
            prune(&self.tx)?;
        }
        self.tx.commit().map_err(err)?;
        *self.store_seq = self.next_seq;
        Ok(high)
    }

    /// Ends the write without committing. Sequences it took are given back: the store's
    /// counter only moves on a commit.
    pub(crate) fn rollback(self) {}

    // Raw access for the shell derivation in `shell.rs`.
    pub(crate) fn conn(&self) -> &Connection {
        &self.tx
    }
}

/// A new `Project` row (`packages/contracts/src/project.ts`).
pub(crate) fn new_project(id: &str, title: &str, workspace_root: &str, now: &str) -> Value {
    json!({
        "id": id,
        "title": title,
        "workspaceRoot": workspace_root,
        "defaultModelSelection": null,
        "scripts": [],
        "createdAt": now,
        "updatedAt": now,
        "deletedAt": null,
    })
}

/// The shell row of a project: the `Project` without `deletedAt`.
pub(crate) fn shell_project(project: &Value) -> Value {
    let mut row = project.clone();
    if let Some(map) = row.as_object_mut() {
        map.remove("deletedAt");
    }
    row
}

/// Schema steps beyond `CREATE ... IF NOT EXISTS`, by `PRAGMA user_version`.
fn migrate(conn: &Connection) -> StoreResult<()> {
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(err)?;
    if version < 1 {
        // 1: index the messages a store written before search had.
        let rows: Vec<(String, String, String)> = {
            let mut stmt = conn
                .prepare(
                    "SELECT thread_id, id, COALESCE(json_extract(body, '$.text'), '') FROM entities
                     WHERE kind = 'messages' AND COALESCE(json_extract(body, '$.streaming'), 0) = 0",
                )
                .map_err(err)?;
            stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
                .map_err(err)?
                .collect::<rusqlite::Result<_>>()
                .map_err(err)?
        };
        for (thread_id, message_id, text) in rows {
            index_message(conn, &thread_id, &message_id, &text)?;
        }
        conn.execute_batch("PRAGMA user_version = 1").map_err(err)?;
    }
    if version < 2 {
        // 2: the streaming rows a turn end deletes (`compact_streaming`), without reading the
        // thread's other events.
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS events_streaming ON events(thread_id) WHERE streaming = 1;
             PRAGMA user_version = 2;",
        )
        .map_err(err)?;
    }
    Ok(())
}

/// Puts the final text of one message into `message_search`, replacing an older version.
fn index_message(
    conn: &Connection,
    thread_id: &str,
    message_id: &str,
    text: &str,
) -> StoreResult<()> {
    conn.execute(
        "INSERT OR IGNORE INTO message_keys (thread_id, message_id) VALUES (?1, ?2)",
        params![thread_id, message_id],
    )
    .map_err(err)?;
    let id: i64 = conn
        .query_row(
            "SELECT id FROM message_keys WHERE thread_id = ?1 AND message_id = ?2",
            params![thread_id, message_id],
            |row| row.get(0),
        )
        .map_err(err)?;
    conn.execute("DELETE FROM message_search WHERE rowid = ?1", [id])
        .map_err(err)?;
    conn.execute(
        "INSERT INTO message_search (rowid, text) VALUES (?1, ?2)",
        params![id, text],
    )
    .map_err(err)?;
    Ok(())
}

/// Bounds the tables that only serve resumes and retries. Events and projections stay: they
/// are the history clients read.
fn prune(conn: &Connection) -> StoreResult<()> {
    conn.execute(
        "INSERT INTO meta (key, value)
         SELECT 'shell_pruned_through', seq FROM shell_changes ORDER BY seq DESC LIMIT 1 OFFSET ?1
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [SHELL_CHANGES_KEEP],
    )
    .map_err(err)?;
    conn.execute(
        "DELETE FROM shell_changes WHERE seq <= COALESCE(
           (SELECT value FROM meta WHERE key = 'shell_pruned_through'), 0)",
        [],
    )
    .map_err(err)?;
    conn.execute(
        "DELETE FROM receipts WHERE sequence < (
           SELECT sequence FROM receipts ORDER BY sequence DESC LIMIT 1 OFFSET ?1)",
        [RECEIPTS_KEEP],
    )
    .map_err(err)?;
    Ok(())
}

/// One event before it gets its sequence, id and time.
pub(crate) struct Draft {
    pub thread_id: String,
    pub event_type: &'static str,
    pub payload: Value,
    pub run_id: Option<String>,
    pub node_id: Option<String>,
    pub command_id: Option<String>,
}

impl Draft {
    pub(crate) fn new(thread_id: &str, event_type: &'static str, payload: Value) -> Self {
        Self {
            thread_id: thread_id.to_owned(),
            event_type,
            payload,
            run_id: None,
            node_id: None,
            command_id: None,
        }
    }

    pub(crate) fn run(mut self, run_id: Option<&str>) -> Self {
        self.run_id = run_id.map(str::to_owned);
        self
    }

    pub(crate) fn node(mut self, node_id: Option<&str>) -> Self {
        self.node_id = node_id.map(str::to_owned);
        self
    }

    pub(crate) fn command(mut self, command_id: Option<&str>) -> Self {
        self.command_id = command_id.map(str::to_owned);
        self
    }
}

fn thread(conn: &Connection, thread_id: &str) -> StoreResult<Option<Value>> {
    conn.query_row(
        "SELECT thread FROM threads WHERE id = ?1 AND deleted = 0",
        [thread_id],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(err)?
    .map(parse)
    .transpose()
}

fn entities(conn: &Connection, thread_id: &str, kind: &str) -> StoreResult<Vec<Value>> {
    let mut stmt = conn
        .prepare("SELECT body FROM entities WHERE thread_id = ?1 AND kind = ?2 ORDER BY first_seq")
        .map_err(err)?;
    let rows = json_rows(
        stmt.query_map(params![thread_id, kind], |row| row.get::<_, String>(0))
            .map_err(err)?,
    )?;
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A row the engine cannot read fails the read; it never turns into `null` or vanishes.
    #[test]
    fn a_broken_stored_row_is_an_error() {
        let dir =
            std::env::temp_dir().join(format!("conn-engine-{}-broken-row", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mut store = Store::open(&dir.join("engine.sqlite")).unwrap();
        store
            .conn
            .execute_batch(
                "INSERT INTO threads (id, project_id, activity_at, thread, shell)
                 VALUES ('t1', 'p', '', '{not json', '{\"id\":\"t1\"}');
                 INSERT INTO entities (thread_id, kind, id, first_seq, seq, body)
                 VALUES ('t1', 'runs', 'r1', 1, 1, '{\"id\":\"r1\"}'),
                        ('t1', 'runs', 'r2', 2, 2, 'broken');",
            )
            .unwrap();
        let tx = store.tx().unwrap();
        assert!(tx.thread("t1").is_err());
        assert!(
            tx.entities("t1", "runs").is_err(),
            "one bad row fails the list"
        );
        assert!(tx.entity("t1", "runs", "r2").is_err());
        assert_eq!(tx.entity("t1", "runs", "r1").unwrap().unwrap()["id"], "r1");
        tx.rollback();
        assert!(store.query_json("SELECT body FROM entities", []).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A commit that fails gives back the sequences its write took, as a rollback does, so the
    /// next write does not leave a gap.
    #[test]
    fn a_failed_commit_gives_its_sequences_back() {
        let dir =
            std::env::temp_dir().join(format!("conn-engine-{}-failed-commit", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mut store = Store::open(&dir.join("engine.sqlite")).unwrap();
        let before = store.high_water();
        store
            .conn
            .execute_batch(
                "CREATE TRIGGER fail_receipts BEFORE INSERT ON receipts
                 BEGIN SELECT RAISE(ABORT, 'test: no receipts'); END;",
            )
            .unwrap();
        let mut tx = store.tx().unwrap();
        tx.append(Draft::new("t1", "thread.activity-updated", json!({})))
            .unwrap();
        tx.append(Draft::new("t1", "thread.activity-updated", json!({})))
            .unwrap();
        assert!(
            tx.commit(Some(("c1", "test"))).is_err(),
            "the trigger fails it"
        );
        assert_eq!(
            store.high_water(),
            before,
            "the failed write took no sequence"
        );

        store
            .conn
            .execute_batch("DROP TRIGGER fail_receipts")
            .unwrap();
        let mut tx = store.tx().unwrap();
        let seq = tx
            .append(Draft::new("t1", "thread.activity-updated", json!({})))
            .unwrap();
        assert_eq!(seq, before + 1, "the next write continues without a gap");
        assert_eq!(tx.commit(Some(("c2", "test"))).unwrap(), before + 1);
        assert_eq!(store.high_water(), before + 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// In-thread find takes the client's `offset` from the current match. Any `i64` lands on a
    /// match: it never overflows (a panic in debug builds, a wrong index in release).
    #[test]
    fn an_extreme_find_offset_still_lands_on_a_match() {
        let dir =
            std::env::temp_dir().join(format!("conn-engine-{}-find-offset", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let store = Store::open(&dir.join("engine.sqlite")).unwrap();
        store
            .conn
            .execute_batch(
                r#"INSERT INTO entities (thread_id, kind, id, first_seq, seq, ordinal, body) VALUES
                 ('t1', 'turnItems', 'i1', 1, 1, 1,
                  '{"type":"user_message","status":"completed","text":"one fox, two fox","messageId":"m1","runId":"r1"}'),
                 ('t1', 'turnItems', 'i2', 2, 2, 2,
                  '{"type":"assistant_message","status":"completed","text":"three fox","messageId":"m2","runId":"r1"}');"#,
            )
            .unwrap();
        let find = |start: &str, offset: i64| {
            let found = store
                .search_thread(&json!({
                    "threadId": "t1",
                    "query": "fox",
                    "start": {"entryId": start, "occurrence": 0},
                    "offset": offset,
                }))
                .unwrap();
            assert_eq!(found["totalMatches"], 3, "{found}");
            found["activeIndex"].as_u64().unwrap()
        };
        assert_eq!(find("m1", 1), 1);
        assert_eq!(
            find("m1", -1),
            2,
            "back from the first match wraps to the last"
        );
        // From match 2 (the start of m2): i64::MAX is 1 more than a multiple of 3.
        assert_eq!(find("m2", 1), 0);
        assert_eq!(find("m2", i64::MAX), 0);
        // i64::MIN is 1 more than a multiple of 3 as well.
        assert_eq!(find("m1", i64::MIN), 1);
        assert_eq!(find("m2", i64::MIN), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A store from before the index gets it when it opens, and the turn-end delete uses it.
    #[test]
    fn the_streaming_index_serves_compaction_on_an_old_store() {
        let dir = std::env::temp_dir().join(format!(
            "conn-engine-{}-streaming-index",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("engine.sqlite");
        {
            let store = Store::open(&path).unwrap();
            store
                .conn
                .execute_batch("DROP INDEX IF EXISTS events_streaming; PRAGMA user_version = 1;")
                .unwrap();
        }
        let store = Store::open(&path).unwrap();
        let version: i64 = store
            .conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, 2);
        let plan = store.query_plan(
            "DELETE FROM events WHERE thread_id = ?1 AND streaming = 1",
            ["t1"],
        );
        assert!(
            plan.iter()
                .any(|step| step.contains("USING INDEX events_streaming")),
            "{plan:?}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
