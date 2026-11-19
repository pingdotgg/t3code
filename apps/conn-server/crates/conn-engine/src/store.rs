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

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS mcp_app_model_context (
 thread_id TEXT NOT NULL, item_id TEXT NOT NULL, server TEXT NOT NULL, tool TEXT NOT NULL, text TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(thread_id,item_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS events (
  seq       INTEGER PRIMARY KEY,
  thread_id TEXT NOT NULL,
  command_id TEXT,
  type      TEXT NOT NULL,
  streaming INTEGER NOT NULL DEFAULT 0,
  event     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_by_thread ON events(thread_id, seq);
CREATE INDEX IF NOT EXISTS created_runs_by_command ON events(command_id, seq) WHERE type = 'run.created';
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
CREATE INDEX IF NOT EXISTS entities_waiting_secrets
ON entities(thread_id, json_extract(body, '$.updatedAt') DESC, id DESC)
WHERE kind = 'turnItems' AND json_extract(body, '$.type') = 'secret_request'
  AND json_extract(body, '$.status') = 'waiting';
CREATE INDEX IF NOT EXISTS mcp_app_items ON entities(id, thread_id) WHERE kind='turnItems';
-- A thread's turn items in timeline order, read row by row (the transcript, projections).
CREATE INDEX IF NOT EXISTS turn_items_in_order ON entities(thread_id, ordinal, id)
WHERE kind = 'turnItems';
-- The runs with a Stop request, for the visibility rule.
CREATE INDEX IF NOT EXISTS turn_item_interrupts ON entities(thread_id, json_extract(body, '$.runId'))
WHERE kind = 'turnItems' AND json_extract(body, '$.type') = 'run_interrupt_request';
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
CREATE TABLE IF NOT EXISTS turn_item_positions (
  thread_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (thread_id, item_id)
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
-- Rollbacks admitted and not yet committed or failed, so a restart can finish them (T3 keeps
-- `provider-thread.rollback` in its effect outbox). `phase`: `admitted`; `provider`, the
-- provider rollback was sent; `provider_done`, its answer is in `snapshot`.
CREATE TABLE IF NOT EXISTS pending_rollbacks (
  command_id TEXT PRIMARY KEY,
  thread_id  TEXT NOT NULL,
  request    TEXT NOT NULL,
  phase      TEXT NOT NULL,
  snapshot   TEXT
);
";

/// A thread's turn items in timeline order; served by `turn_items_in_order`.
pub(crate) const TRANSCRIPT_ITEMS_SQL: &str =
    "SELECT body FROM entities WHERE thread_id = ?1 AND kind = 'turnItems' ORDER BY ordinal, id";
/// The runs of a thread with a Stop request; served by `turn_item_interrupts`.
pub(crate) const TRANSCRIPT_INTERRUPTS_SQL: &str = "SELECT DISTINCT json_extract(body, '$.runId')
     FROM entities WHERE thread_id = ?1 AND kind = 'turnItems'
     AND json_extract(body, '$.type') = 'run_interrupt_request'
     AND json_extract(body, '$.runId') IS NOT NULL";

/// `inheritedRunFork`: the source thread and run of a run fork that is not a side chat.
fn inherited_run_fork(thread: &Value) -> Option<(String, String)> {
    let forked = &thread["forkedFrom"];
    if forked["type"] != "run" || thread["lineage"]["sideChat"] == true {
        return None;
    }
    Some((
        forked["threadId"].as_str()?.to_owned(),
        forked["runId"].as_str()?.to_owned(),
    ))
}

/// `makeForkMarkerTurnItem`: the synthetic "Forked from conversation" item of a fork.
fn fork_marker(thread: &Value, source_id: &str, run_id: &str) -> Value {
    let id = thread["id"].as_str().unwrap_or_default();
    let created_at = thread["createdAt"].clone();
    json!({
        "id": format!("turn-item:fork:{id}"),
        "threadId": id,
        "runId": null,
        "nodeId": null,
        "providerTurnId": null,
        "nativeItemRef": null,
        "parentItemId": null,
        "ordinal": 0,
        "status": "completed",
        "title": "Forked from conversation",
        "startedAt": null,
        "completedAt": created_at,
        "updatedAt": created_at,
        "type": "fork",
        "source": {"type": "run", "threadId": source_id, "runId": run_id},
        "targetThreadId": id,
    })
}

/// A rollback a previous process left pending (`pending_rollbacks`).
pub(crate) struct PendingRollback {
    pub(crate) command_id: String,
    pub(crate) thread_id: String,
    pub(crate) request: Value,
    pub(crate) phase: String,
    pub(crate) snapshot: Option<Value>,
}

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
fn streams_only(event_type: &str, payload: &Value) -> bool {
    if event_type == "turn-item.updated"
        && matches!(
            payload.get("type").and_then(Value::as_str),
            Some("secret_request" | "link_request" | "user_message")
        )
    {
        return false;
    }

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
    /// Every transaction's `now` (`EngineConfig::clock`).
    clock: std::sync::Arc<dyn crate::clock::Clock>,
    /// A title generator is configured, so commands may ask for titles.
    pub(crate) generates_titles: bool,
    /// Which runs' provider starts were accepted or abandoned. In memory: a restart starts
    /// every active run again, so nothing here outlives the process.
    starts: StartLedger,
}

/// The turn starts a Stop must know about, kept beside the store so a command decides under
/// the store lock (T3's Stop plans under the thread lock from the stored provider turns).
///
/// A run's provider turn is *accepted* once `Session::start_turn` returned for it; before
/// that, Stop ends the run at once and abandons the start ("before provider start" in T3's
/// `dispatchRunInterrupt`). Each set holds only runs of threads whose start is in flight or
/// whose run is still active, and each is capped at [`START_LEDGER_CAP`].
#[derive(Clone, Default)]
pub(crate) struct StartLedger {
    /// Run id to its thread id.
    accepted: std::collections::HashMap<String, String>,
    abandoned: std::collections::HashSet<String>,
}

/// More entries than this means runs ended on a path that did not forget them; the oldest
/// cannot be told apart, so the set is pruned to the runs that are still active.
const START_LEDGER_CAP: usize = 1024;

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
            clock: std::sync::Arc::new(crate::clock::SystemClock),
            generates_titles: false,
            starts: StartLedger::default(),
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

    pub(crate) fn set_clock(&mut self, clock: std::sync::Arc<dyn crate::clock::Clock>) {
        self.clock = clock;
    }

    /// Now, by the engine's clock, in milliseconds since the epoch.
    pub(crate) fn now_millis(&self) -> u64 {
        self.clock.now_millis()
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
            starts: &mut self.starts,
            starts_changed: None,
            tx: self.conn.transaction().map_err(err)?,
            store_seq: &mut self.next_seq,
            next_seq: start,
            start,
            now: conn_support::time::iso_from_ms(self.clock.now_millis()),
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

    pub(crate) fn created_run_status(&self, command_id: &str) -> StoreResult<Option<String>> {
        let event: Option<String> = self.conn.query_row(
            "SELECT event FROM events WHERE command_id = ?1 AND type = 'run.created' ORDER BY seq DESC LIMIT 1",
            [command_id], |row| row.get(0),
        ).optional().map_err(err)?;
        event
            .map(|event| {
                parse(event).map(|e| {
                    e["payload"]["status"]
                        .as_str()
                        .unwrap_or_default()
                        .to_owned()
                })
            })
            .transpose()
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
        let projects = self.projects_snapshot()?;
        Ok(json!({
            "schemaVersion": 2,
            "snapshotSequence": self.high_water(),
            "threads": threads,
            "archivedThreads": [],
            "projects": projects,
        }))
    }

    pub(crate) fn projects_snapshot(&self) -> StoreResult<Vec<Value>> {
        let mut stmt = self
            .conn
            .prepare("SELECT body FROM projects ORDER BY rowid")
            .map_err(err)?;
        let projects = json_rows(
            stmt.query_map([], |row| row.get::<_, String>(0))
                .map_err(err)?,
        )?
        .into_iter()
        .filter(|project| project["deletedAt"].is_null())
        .map(|project| shell_project(&project))
        .collect();
        Ok(projects)
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

    /// T3's projection also lists the provider threads this thread's subagents run on
    /// (`provider_thread_id IN (SELECT provider_thread_id FROM subagents WHERE thread_id =
    /// …)` in `ProjectionStore`). Those rows live on the child threads; each is read by key.
    fn add_subagent_provider_threads(
        &self,
        projection: &mut serde_json::Map<String, Value>,
    ) -> StoreResult<()> {
        let wanted: Vec<(String, String)> = projection
            .get("subagents")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|s| {
                Some((
                    s["childThreadId"].as_str()?.to_owned(),
                    s["providerThreadId"].as_str()?.to_owned(),
                ))
            })
            .collect();
        let Some(Value::Array(rows)) = projection.get_mut("providerThreads") else {
            return Ok(());
        };
        for (child, id) in wanted {
            if rows.iter().any(|row| row["id"] == id.as_str()) {
                continue;
            }
            let row = self
                .conn
                .query_row(
                    "SELECT body FROM entities
                     WHERE thread_id = ?1 AND kind = 'providerThreads' AND id = ?2",
                    params![child, id],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(err)?;
            if let Some(row) = row {
                rows.push(parse(row)?);
            }
        }
        Ok(())
    }

    /// `OrchestrationV2ThreadProjection`, or `None` for an unknown or deleted thread.
    pub(crate) fn thread_projection(&self, thread_id: &str) -> StoreResult<Option<Value>> {
        Ok(self
            .thread_projection_with(thread_id, false)?
            .map(|(projection, _)| projection))
    }

    /// The projection, built with one copy of each turn item where it can: when the visible
    /// local rows are exactly the first turn items, `omit_local_items` leaves them out of
    /// `turnItems` (the client restores them from `visibleTurnItems` when the snapshot says
    /// `turnItemsOmitLocalVisible`) and the flag is `true`. Otherwise `turnItems` is whole, as
    /// T3's `omitLocalVisibleTurnItems` returns nothing then.
    pub(crate) fn thread_projection_with(
        &self,
        thread_id: &str,
        omit_local_items: bool,
    ) -> StoreResult<Option<(Value, bool)>> {
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
        self.add_subagent_provider_threads(&mut projection)?;
        // Turn items in timeline order, read once and moved into their rows.
        let mut items = self.query_json(
            "SELECT body FROM entities WHERE thread_id = ?1 AND kind = 'turnItems'
             ORDER BY ordinal, id",
            [thread_id],
        )?;
        let shown = crate::visibility::visible_items(
            projection["runs"].as_array().map_or(&[], Vec::as_slice),
            projection["attempts"].as_array().map_or(&[], Vec::as_slice),
            &items,
        );
        let prefix = shown.iter().enumerate().all(|(at, shown)| at == *shown);
        let omitted = omit_local_items && prefix && !shown.is_empty();
        let visible: Vec<Value> = shown
            .iter()
            .enumerate()
            .filter_map(|(position, at)| {
                let item = items.get(*at)?;
                Some(json!({
                    "position": position,
                    "visibility": "local",
                    "sourceThreadId": thread_id,
                    "sourceItemId": item["id"].clone(),
                    "item": item,
                }))
            })
            .collect();
        if let Some(Value::Array(messages)) = projection.get_mut("messages") {
            sort_messages_by_turn_items(messages, &items);
        }
        if omitted {
            items.drain(..shown.len());
        }
        projection.insert("turnItems".into(), Value::Array(items));
        projection.insert("visibleTurnItems".into(), Value::Array(visible));
        projection.insert("updatedAt".into(), Value::String(activity_at));
        Ok(Some((Value::Object(projection), omitted)))
    }

    /// `GET /api/orchestration/threads/:threadId/transcript`, encoded: the thread's visible
    /// turn items read one at a time in timeline order, written straight into the JSON body.
    /// It stops at the first row that would make the file the client builds (the header line
    /// plus one line per item, T3's `getThreadTranscript`) pass `limit` bytes, so a long
    /// thread never sits in memory whole. Only runs and attempts are read as a whole.
    ///
    /// A run fork that is not a side chat starts with the history it inherits, as T3's
    /// `buildVisibleTurnItems`: the source's rows through the fork run (recursively for a fork
    /// of a fork), then the synthetic fork marker, then its own rows.
    pub(crate) fn thread_transcript(
        &self,
        thread_id: &str,
        environment_id: &str,
        limit: u64,
    ) -> StoreResult<crate::ThreadTranscript> {
        use crate::ThreadTranscript;
        let Some((thread, updated_at)) = self.live_thread(thread_id)? else {
            return Ok(ThreadTranscript::NotFound);
        };
        let (Some(id), Some(title)) = (thread["id"].as_str(), thread["title"].as_str()) else {
            return Err(format!("store: thread {thread_id} has no id or title"));
        };
        let header = crate::transcript::header_bytes([title, environment_id, id, &updated_at]);
        let mut out = crate::transcript::Rows::new(header, limit);
        if !out.fits() {
            return Ok(ThreadTranscript::TooLarge);
        }
        if let Some((source, run)) = inherited_run_fork(&thread) {
            let created_at = thread["createdAt"].as_str().unwrap_or_default();
            let mut seen = vec![thread_id.to_owned()];
            if !self.transcript_inherited(&source, &run, created_at, &mut seen, &mut out)? {
                return Ok(ThreadTranscript::TooLarge);
            }
            let marker = fork_marker(&thread, &source, &run);
            let marker_id = marker["id"].clone();
            if !out.push("synthetic", json!(source), marker_id, marker)? {
                return Ok(ThreadTranscript::TooLarge);
            }
        }
        let runs = entities(&self.conn, thread_id, "runs")?;
        let attempts = entities(&self.conn, thread_id, "attempts")?;
        let rule = self.visibility(thread_id, &runs, &attempts)?;
        if !self.transcript_rows(thread_id, "local", &mut out, |item| rule.shows(item))? {
            return Ok(ThreadTranscript::TooLarge);
        }
        Ok(ThreadTranscript::Body(out.finish(
            id,
            title,
            &updated_at,
        )?))
    }

    /// The thread record and `activity_at` of a thread that is not deleted.
    fn live_thread(&self, thread_id: &str) -> StoreResult<Option<(Value, String)>> {
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
        match row {
            Some((thread, activity_at, false)) => Ok(Some((parse(thread)?, activity_at))),
            _ => Ok(None),
        }
    }

    /// The thread record, deleted or not: a fork inherits from a deleted source.
    fn stored_thread(&self, thread_id: &str) -> StoreResult<Option<Value>> {
        self.conn
            .query_row(
                "SELECT thread FROM threads WHERE id = ?1",
                [thread_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(err)?
            .map(parse)
            .transpose()
    }

    /// The visibility rule of a thread, with its Stop requests when the rule needs them.
    fn visibility(
        &self,
        thread_id: &str,
        runs: &[Value],
        attempts: &[Value],
    ) -> StoreResult<crate::visibility::Visibility> {
        let mut rule = crate::visibility::Visibility::new(runs, attempts);
        if rule.needs_interrupts() {
            let mut stmt = self.conn.prepare(TRANSCRIPT_INTERRUPTS_SQL).map_err(err)?;
            let runs = stmt
                .query_map([thread_id], |row| row.get::<_, String>(0))
                .map_err(err)?
                .collect::<rusqlite::Result<_>>()
                .map_err(err)?;
            rule.set_interrupted(runs);
        }
        Ok(rule)
    }

    /// Writes a thread's turn items that `keep` accepts, in timeline order, one at a time.
    /// `false` when the limit stopped it.
    fn transcript_rows(
        &self,
        thread_id: &str,
        visibility: &str,
        out: &mut crate::transcript::Rows,
        keep: impl Fn(&Value) -> bool,
    ) -> StoreResult<bool> {
        let mut stmt = self.conn.prepare(TRANSCRIPT_ITEMS_SQL).map_err(err)?;
        let mut rows = stmt.query([thread_id]).map_err(err)?;
        while let Some(row) = rows.next().map_err(err)? {
            let text = row
                .get_ref(0)
                .map_err(err)?
                .as_str()
                .map_err(|e| format!("store: a stored row is not text: {e}"))?;
            let item: Value = serde_json::from_str(text)
                .map_err(|e| format!("store: a stored row is not JSON: {e}"))?;
            if !keep(&item) {
                continue;
            }
            // The stored text is the item's compact JSON; its line in the file is longer. A
            // row that cannot fit is refused before it is encoded.
            if !out.has_room(text.len() as u64) {
                return Ok(false);
            }
            let source_thread = item["threadId"].clone();
            let source_item = item["id"].clone();
            if !out.push(visibility, source_thread, source_item, item)? {
                return Ok(false);
            }
        }
        Ok(true)
    }

    /// `visibleTurnItemsThroughRun`: what a fork of `source` at `run_id`, made at
    /// `fork_created_at`, inherits. `seen` guards against a cycle, as T3's `seenThreadIds`.
    /// `false` when the limit stopped it.
    fn transcript_inherited(
        &self,
        source_id: &str,
        run_id: &str,
        fork_created_at: &str,
        seen: &mut Vec<String>,
        out: &mut crate::transcript::Rows,
    ) -> StoreResult<bool> {
        // A deleted source keeps its rows, and T3 still shows them in the fork.
        let Some(source) = self.stored_thread(source_id)? else {
            return Ok(true);
        };
        let runs = entities(&self.conn, source_id, "runs")?;
        let Some(cutoff) = runs
            .iter()
            .find(|run| run["id"] == run_id)
            .and_then(|run| run["ordinal"].as_u64())
        else {
            return Ok(true);
        };
        // The source's own inherited rows and its marker come first.
        if let Some((parent, parent_run)) = inherited_run_fork(&source)
            && !seen.contains(&parent)
        {
            seen.push(source_id.to_owned());
            let created_at = source["createdAt"].as_str().unwrap_or_default();
            if !self.transcript_inherited(&parent, &parent_run, created_at, seen, out)? {
                return Ok(false);
            }
            let marker = fork_marker(&source, &parent, &parent_run);
            let marker_id = marker["id"].clone();
            if !out.push("inherited", json!(parent), marker_id, marker)? {
                return Ok(false);
            }
        }
        // `createInheritedTurnItemVisibility`: a later rollback does not hide inherited
        // history; a rolled-back run with a cancelled attempt counts as cancelled.
        let attempts = entities(&self.conn, source_id, "attempts")?;
        let cancelled: std::collections::HashSet<&str> = attempts
            .iter()
            .filter(|attempt| attempt["status"] == "cancelled")
            .filter_map(|attempt| attempt["runId"].as_str())
            .collect();
        let inherited_runs: Vec<Value> = runs
            .iter()
            .filter_map(|run| {
                if run["status"] != "rolled_back" {
                    return Some(run.clone());
                }
                let id = run["id"].as_str()?;
                cancelled.contains(id).then(|| {
                    let mut run = run.clone();
                    run["status"] = json!("cancelled");
                    run
                })
            })
            .collect();
        let rule = self.visibility(source_id, &inherited_runs, &attempts)?;
        // `forkInheritedRunOrdinals`: runs rolled back before the fork are not inherited.
        let ordinals: std::collections::HashMap<&str, u64> = runs
            .iter()
            .filter(|run| {
                !(run["status"] == "rolled_back"
                    && run["completedAt"]
                        .as_str()
                        .is_some_and(|at| at < fork_created_at))
            })
            .filter_map(|run| Some((run["id"].as_str()?, run["ordinal"].as_u64()?)))
            .collect();
        let v1_import = source["historyOrigin"] == "v1_import";
        self.transcript_rows(source_id, "inherited", out, |item| {
            let at_or_before = match item["runId"].as_str() {
                None => v1_import,
                Some(run) => ordinals.get(run).is_some_and(|ordinal| *ordinal <= cutoff),
            };
            at_or_before && rule.shows(item)
        })
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
            .prepare(
                "SELECT seq, command_id, event FROM events WHERE seq > ?1 ORDER BY seq LIMIT ?2",
            )
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

    /// Rollbacks admitted and not yet committed or failed, in admission order.
    pub(crate) fn pending_rollbacks(&self) -> StoreResult<Vec<PendingRollback>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT command_id, thread_id, request, phase, snapshot FROM pending_rollbacks
                 ORDER BY rowid",
            )
            .map_err(err)?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            })
            .map_err(err)?;
        rows.map(|row| {
            let (command_id, thread_id, request, phase, snapshot) = row.map_err(err)?;
            Ok(PendingRollback {
                command_id,
                thread_id,
                request: parse(request)?,
                phase,
                snapshot: snapshot.map(parse).transpose()?,
            })
        })
        .collect()
    }

    /// Moves a pending rollback to `phase`, with the provider's answer for `provider_done`.
    pub(crate) fn set_rollback_phase(
        &self,
        command_id: &str,
        phase: &str,
        snapshot: Option<&Value>,
    ) -> StoreResult<()> {
        self.conn
            .execute(
                "UPDATE pending_rollbacks SET phase = ?2, snapshot = ?3 WHERE command_id = ?1",
                rusqlite::params![command_id, phase, snapshot.map(Value::to_string)],
            )
            .map(drop)
            .map_err(err)
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
    starts: &'a mut StartLedger,
    /// The ledger as this write changed it; it replaces the store's on commit only.
    starts_changed: Option<StartLedger>,
}

impl Tx<'_> {
    fn starts(&self) -> &StartLedger {
        self.starts_changed.as_ref().unwrap_or(self.starts)
    }

    fn starts_mut(&mut self) -> &mut StartLedger {
        let base = &*self.starts;
        self.starts_changed.get_or_insert_with(|| base.clone())
    }

    /// The provider accepted this run's turn start (`Session::start_turn` returned).
    pub(crate) fn start_accepted(&self, run_id: &str) -> bool {
        self.starts().accepted.contains_key(run_id)
    }

    /// Records that the provider accepted the run's start, while the run is still active.
    pub(crate) fn accept_start(&mut self, thread_id: &str, run_id: &str) -> StoreResult<()> {
        if self
            .active_run(thread_id)?
            .is_none_or(|run| run["id"] != run_id)
        {
            return Ok(());
        }
        if self.starts().accepted.len() >= START_LEDGER_CAP {
            let mut keep = std::collections::HashMap::new();
            for (run, thread) in self.starts().accepted.clone() {
                if self.run_is_active(&thread, &run)? {
                    keep.insert(run, thread);
                }
            }
            self.starts_mut().accepted = keep;
        }
        self.starts_mut()
            .accepted
            .insert(run_id.to_owned(), thread_id.to_owned());
        Ok(())
    }

    /// A run ended: Stop no longer needs to know about its start.
    pub(crate) fn forget_start(&mut self, run_id: &str) {
        if self.starts().accepted.contains_key(run_id) {
            self.starts_mut().accepted.remove(run_id);
        }
    }

    /// Stop ended the run before the provider accepted it; its start is abandoned.
    pub(crate) fn abandon_start(&mut self, run_id: &str) {
        let ledger = self.starts_mut();
        ledger.accepted.remove(run_id);
        if ledger.abandoned.len() >= START_LEDGER_CAP {
            // Each entry is taken back when its start ends; a full set means starts that never
            // ran (a shutdown), and none of them can run any more.
            ledger.abandoned.clear();
        }
        ledger.abandoned.insert(run_id.to_owned());
    }

    /// Whether Stop abandoned the run's start. With `take`, the entry goes (the start ended).
    pub(crate) fn start_abandoned(&mut self, run_id: &str, take: bool) -> bool {
        let abandoned = self.starts().abandoned.contains(run_id);
        if abandoned && take {
            self.starts_mut().abandoned.remove(run_id);
        }
        abandoned
    }

    fn run_is_active(&self, thread_id: &str, run_id: &str) -> StoreResult<bool> {
        let status: Option<String> = self
            .tx
            .query_row(
                "SELECT json_extract(body, '$.status') FROM entities
                 WHERE thread_id = ?1 AND kind = 'runs' AND id = ?2",
                [thread_id, run_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(err)?
            .flatten();
        Ok(status.is_some_and(|s| crate::shell::ACTIVE_RUN_STATUSES.contains(&s.as_str())))
    }

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
                    // A held item's reserved position wins (`reserve_turn_item_position`).
                    let ordinal = match existing {
                        Some((_, Some(ordinal))) => ordinal,
                        _ => match take_reserved_position(&self.tx, &thread_id, &id)? {
                            Some(ordinal) => ordinal,
                            None => {
                                let wanted = payload["ordinal"].as_i64().unwrap_or(0);
                                wanted.max(next_turn_item_ordinal(&self.tx, &thread_id)?)
                            }
                        },
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
            if deleted {
                self.tx
                    .execute(
                        "DELETE FROM mcp_app_model_context WHERE thread_id=?1",
                        [&thread_id],
                    )
                    .map_err(err)?;
            }
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

        let affects_shell = inserted || !streams_only(event_type, &payload);
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
        if affects_shell {
            match self.touched.iter_mut().find(|(id, _)| *id == thread_id) {
                Some(entry) => entry.1 = seq,
                None => self.touched.push((thread_id, seq)),
            }
        }
        Ok(seq)
    }

    /// Takes the next turn item position for an item whose text is held and not stored yet
    /// (T3's `TurnItemPositionStore.allocate`). The item gets it when it is written; nothing
    /// changes when the item has a position already.
    pub(crate) fn reserve_turn_item_position(
        &mut self,
        thread_id: &str,
        item_id: &str,
    ) -> StoreResult<()> {
        if self.entity(thread_id, "turnItems", item_id)?.is_some() {
            return Ok(());
        }
        let next = next_turn_item_ordinal(&self.tx, thread_id)?;
        self.tx
            .execute(
                "INSERT OR IGNORE INTO turn_item_positions (thread_id, item_id, ordinal) VALUES (?1, ?2, ?3)",
                params![thread_id, item_id, next],
            )
            .map(|_| ())
            .map_err(err)
    }

    /// Drops the positions of a thread's held items that were never written (a run ended).
    pub(crate) fn release_turn_item_positions(&mut self, thread_id: &str) -> StoreResult<()> {
        self.tx
            .execute(
                "DELETE FROM turn_item_positions WHERE thread_id = ?1",
                [thread_id],
            )
            .map(|_| ())
            .map_err(err)
    }

    pub(crate) fn thread(&self, thread_id: &str) -> StoreResult<Option<Value>> {
        thread(&self.tx, thread_id)
    }

    /// Whether a thread with this ID was ever deleted. Its rows stay under the ID, so a
    /// thread created again with it would carry them.
    pub(crate) fn thread_ever_deleted(&self, thread_id: &str) -> StoreResult<bool> {
        self.tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM events WHERE thread_id = ?1 AND type = 'thread.deleted')",
                [thread_id],
                |row| row.get::<_, bool>(0),
            )
            .map_err(err)
    }

    /// Whether `thread_id` was ever used, deleted or not: a row in `threads` or any event.
    pub(crate) fn thread_id_used(&self, thread_id: &str) -> StoreResult<bool> {
        self.tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM threads WHERE id = ?1)
                     OR EXISTS(SELECT 1 FROM events WHERE thread_id = ?1)",
                [thread_id],
                |row| row.get::<_, bool>(0),
            )
            .map_err(err)
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

    pub(crate) fn html_cleanup_items(
        &self,
        thread_id: &str,
        mut visit: impl FnMut(String, Value, bool),
    ) -> StoreResult<()> {
        let mut stmt = self
            .tx
            .prepare(
                "WITH RECURSIVE sources(id) AS (
              SELECT ?1
              UNION
              SELECT json_extract(t.thread, '$.forkedFrom.threadId')
              FROM sources JOIN threads t USING(id)
              WHERE t.deleted = 1 AND json_extract(t.thread, '$.forkedFrom.type') = 'run'
                AND json_extract(t.thread, '$.lineage.sideChat') IS NOT 1
            ), showing(source, id, through) AS (
              SELECT sources.id, fork.id, run.ordinal
              FROM sources JOIN threads fork
                ON json_extract(fork.thread, '$.forkedFrom.threadId') = sources.id
              JOIN entities run ON run.thread_id = sources.id AND run.kind = 'runs'
                AND run.id = json_extract(fork.thread, '$.forkedFrom.runId')
              WHERE json_extract(fork.thread, '$.forkedFrom.type') = 'run'
                AND json_extract(fork.thread, '$.lineage.sideChat') IS NOT 1
                AND EXISTS (SELECT 1 FROM entities transfer WHERE transfer.thread_id = fork.id
                  AND transfer.kind = 'contextTransfers' AND json_extract(transfer.body, '$.type') = 'fork'
                  AND json_extract(transfer.body, '$.sourceThreadId') = sources.id
                  AND json_extract(transfer.body, '$.targetThreadId') = fork.id)
              UNION
              SELECT showing.source, child.id, showing.through
              FROM showing JOIN threads child
                ON json_extract(child.thread, '$.forkedFrom.threadId') = showing.id
              WHERE json_extract(child.thread, '$.forkedFrom.type') = 'run'
                AND json_extract(child.thread, '$.lineage.sideChat') IS NOT 1
                AND EXISTS (SELECT 1 FROM entities transfer WHERE transfer.thread_id = child.id
                  AND transfer.kind = 'contextTransfers' AND json_extract(transfer.body, '$.type') = 'fork'
                  AND json_extract(transfer.body, '$.sourceThreadId') = showing.id
                  AND json_extract(transfer.body, '$.targetThreadId') = child.id)
            ), retained(source, through) AS (
              SELECT showing.source, MAX(showing.through)
              FROM showing JOIN threads t ON t.id = showing.id
              WHERE t.deleted = 0 GROUP BY showing.source
            )
            SELECT t.id, item.body, COALESCE(run.ordinal, -1) <= retained.through
            FROM sources JOIN threads t USING(id)
            JOIN entities item ON item.thread_id = t.id AND item.kind = 'turnItems'
            LEFT JOIN entities run ON run.thread_id = t.id AND run.kind = 'runs'
              AND run.id = json_extract(item.body, '$.runId')
            LEFT JOIN retained ON retained.source = t.id
            WHERE t.deleted = 1 AND json_extract(item.body, '$.type') = 'dynamic_tool'",
            )
            .map_err(err)?;
        let mut rows = stmt.query([thread_id]).map_err(err)?;
        while let Some(row) = rows.next().map_err(err)? {
            let owner: String = row.get(0).map_err(err)?;
            let item = parse(row.get(1).map_err(err)?)?;
            let retained = row.get::<_, Option<bool>>(2).map_err(err)?.unwrap_or(false);
            visit(owner, item, retained);
        }
        Ok(())
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
        if let Some(starts) = self.starts_changed.take() {
            *self.starts = starts;
        }
        Ok(high)
    }

    /// Ends the write without committing. Sequences it took are given back: the store's
    /// counter only moves on a commit.
    pub(crate) fn rollback(self) {}

    /// Records an admitted rollback until it commits or fails.
    pub(crate) fn put_pending_rollback(
        &self,
        command_id: &str,
        thread_id: &str,
        request: &Value,
    ) -> StoreResult<()> {
        self.tx
            .execute(
                "INSERT OR REPLACE INTO pending_rollbacks (command_id, thread_id, request, phase)
                 VALUES (?1, ?2, ?3, 'admitted')",
                rusqlite::params![command_id, thread_id, request.to_string()],
            )
            .map(drop)
            .map_err(err)
    }

    /// Forgets a rollback that committed or failed.
    pub(crate) fn clear_pending_rollback(&self, command_id: &str) -> StoreResult<()> {
        self.tx
            .execute(
                "DELETE FROM pending_rollbacks WHERE command_id = ?1",
                [command_id],
            )
            .map(drop)
            .map_err(err)
    }

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

/// The position after every turn item of the thread and every reserved one.
fn next_turn_item_ordinal(conn: &Connection, thread_id: &str) -> StoreResult<i64> {
    let max: Option<i64> = conn
        .query_row(
            "SELECT MAX(ordinal) FROM (
               SELECT MAX(ordinal) AS ordinal FROM entities WHERE thread_id = ?1 AND kind = 'turnItems'
               UNION ALL
               SELECT MAX(ordinal) FROM turn_item_positions WHERE thread_id = ?1)",
            [thread_id],
            |row| row.get(0),
        )
        .map_err(err)?;
    Ok(max.unwrap_or(0) + 1)
}

/// A held item's reserved position, removed as the item takes it.
fn take_reserved_position(
    conn: &Connection,
    thread_id: &str,
    item_id: &str,
) -> StoreResult<Option<i64>> {
    let ordinal: Option<i64> = conn
        .query_row(
            "SELECT ordinal FROM turn_item_positions WHERE thread_id = ?1 AND item_id = ?2",
            params![thread_id, item_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(err)?;
    if ordinal.is_some() {
        conn.execute(
            "DELETE FROM turn_item_positions WHERE thread_id = ?1 AND item_id = ?2",
            params![thread_id, item_id],
        )
        .map_err(err)?;
    }
    Ok(ordinal)
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
    if version < 3 {
        // 3: streaming rows stay in the log (T3's buffered delivery), so the index for their
        // deletion goes. A log written before keeps its gaps; nothing reads it as dense.
        conn.execute_batch(
            "DROP INDEX IF EXISTS events_streaming;
             PRAGMA user_version = 3;",
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
#[derive(Clone, Debug)]
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

/// `sortMessagesByTurnItemOrder` in T3's `ProjectionStore`: a projection lists messages in
/// the order of the lowest turn item ordinal that shows each (a user or assistant message
/// item), then by `createdAt`, then by id. So a queued message sits after the answer before
/// it, whatever the clock stamped.
fn sort_messages_by_turn_items(messages: &mut [Value], items: &[Value]) {
    let mut ordinals: std::collections::HashMap<&str, i64> = std::collections::HashMap::new();
    for item in items {
        if !matches!(
            item["type"].as_str(),
            Some("user_message" | "assistant_message")
        ) {
            continue;
        }
        let (Some(id), Some(ordinal)) = (item["messageId"].as_str(), item["ordinal"].as_i64())
        else {
            continue;
        };
        let lowest = ordinals.entry(id).or_insert(ordinal);
        *lowest = (*lowest).min(ordinal);
    }
    let key = |message: &Value| {
        (
            message["id"]
                .as_str()
                .and_then(|id| ordinals.get(id).copied())
                .unwrap_or(i64::MAX),
            message["createdAt"]
                .as_str()
                .and_then(conn_support::time::millis_from_iso)
                .unwrap_or(0),
        )
    };
    messages.sort_by(|left, right| {
        key(left)
            .cmp(&key(right))
            .then_with(|| left["id"].as_str().cmp(&right["id"].as_str()))
    });
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

    /// T3's `sortMessagesByTurnItemOrder`: item ordinal first, so a queued message stamped
    /// before the first answer still follows it; no item sorts last; then time, then id.
    #[test]
    fn messages_follow_their_turn_items() {
        let message = |id: &str, at: &str| json!({"id": id, "createdAt": at});
        let item = |kind: &str, message: &str, ordinal: i64| json!({"type": kind, "messageId": message, "ordinal": ordinal});
        let mut messages = vec![
            message("u1", "1970-01-01T00:00:00.001Z"),
            message("u2", "1970-01-01T00:00:00.002Z"),
            message("wake", "1970-01-01T00:00:00.000Z"),
            message("a1", "2026-09-25T00:18:14.383Z"),
            message("a2", "2026-09-25T00:18:16.292Z"),
        ];
        let items = [
            item("user_message", "u1", 100),
            item("assistant_message", "a1", 101),
            item("user_message", "u2", 200),
            item("assistant_message", "a2", 201),
            item("notification", "wake", 0),
        ];
        sort_messages_by_turn_items(&mut messages, &items);
        let order: Vec<&str> = messages.iter().filter_map(|m| m["id"].as_str()).collect();
        assert_eq!(order, ["u1", "a1", "u2", "a2", "wake"]);
    }

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

    /// A store written by the engine before buffered delivery (version 2: streaming rows
    /// deleted at the turn end, so its log has gaps, and no position table) opens, loses the
    /// deletion index, and goes on writing.
    #[test]
    fn a_store_from_before_buffered_delivery_opens_and_goes_on() {
        let dir = std::env::temp_dir().join(format!(
            "conn-engine-{}-buffered-delivery-migration",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("engine.sqlite");
        {
            let mut store = Store::open(&path).unwrap();
            let mut tx = store.tx().unwrap();
            for n in 0..3 {
                let streaming = n == 1;
                tx.append(Draft::new(
                    "t1",
                    "message.updated",
                    json!({"id": "m1", "role": "assistant", "text": "x", "streaming": streaming}),
                ))
                .unwrap();
            }
            tx.commit(None).unwrap();
            store
                .conn
                .execute_batch(
                    "DELETE FROM events WHERE thread_id = 't1' AND streaming = 1;
                     DROP TABLE turn_item_positions;
                     CREATE INDEX IF NOT EXISTS events_streaming ON events(thread_id) WHERE streaming = 1;
                     PRAGMA user_version = 2;",
                )
                .unwrap();
        }
        let mut store = Store::open(&path).unwrap();
        let version: i64 = store
            .conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, 3);
        let index: i64 = store
            .conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name = 'events_streaming'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(index, 0);
        let seqs: Vec<i64> = store
            .conn
            .prepare("SELECT seq FROM events ORDER BY seq")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(seqs.len(), 2, "the old gap stays: {seqs:?}");
        let mut tx = store.tx().unwrap();
        tx.reserve_turn_item_position("t1", "held").unwrap();
        let seq = tx
            .append(Draft::new("t1", "thread.activity-updated", json!({})))
            .unwrap();
        tx.commit(None).unwrap();
        assert!(seq as i64 > *seqs.last().unwrap());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A held item keeps the place it took when its text was first held: an item that began
    /// after it, and was written first, still comes after it (T3's `TurnItemPositionStore`).
    #[test]
    fn a_held_turn_item_keeps_its_reserved_position() {
        let dir = std::env::temp_dir().join(format!(
            "conn-engine-{}-turn-item-positions",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mut store = Store::open(&dir.join("engine.sqlite")).unwrap();
        let mut tx = store.tx().unwrap();
        let item = |id: &str| {
            Draft::new(
                "t1",
                "turn-item.updated",
                json!({"id": id, "type": "assistant_message", "text": "", "ordinal": 0}),
            )
        };
        tx.append(item("first")).unwrap();
        tx.reserve_turn_item_position("t1", "held").unwrap();
        tx.reserve_turn_item_position("t1", "held").unwrap();
        tx.append(item("tool")).unwrap();
        tx.append(item("held")).unwrap();
        tx.reserve_turn_item_position("t1", "first").unwrap();
        let ordinal = |tx: &Tx<'_>, id: &str| {
            tx.entity("t1", "turnItems", id).unwrap().unwrap()["ordinal"]
                .as_i64()
                .unwrap()
        };
        assert_eq!(ordinal(&tx, "first"), 1);
        assert_eq!(ordinal(&tx, "held"), 2);
        assert_eq!(ordinal(&tx, "tool"), 3);
        tx.reserve_turn_item_position("t1", "never-written")
            .unwrap();
        tx.release_turn_item_positions("t1").unwrap();
        tx.append(item("next")).unwrap();
        assert_eq!(ordinal(&tx, "next"), 4);
        tx.commit(None).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
