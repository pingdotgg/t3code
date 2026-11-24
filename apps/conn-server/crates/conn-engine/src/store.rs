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
use crate::transcript::{ProjectedRows, RowSink};

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
-- Threads that own a task in a linked environment (`has_remote_tasks`), for the shell trim.
CREATE INDEX IF NOT EXISTS remote_task_owners ON entities(thread_id)
WHERE kind = 'subagents' AND json_type(body, '$.remoteChild') = 'object';
CREATE TABLE IF NOT EXISTS projects (
  id             TEXT PRIMARY KEY,
  workspace_root TEXT NOT NULL UNIQUE,
  body           TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS shell_changes (
  seq  INTEGER PRIMARY KEY,
  item TEXT NOT NULL
);
-- Final message texts for `searchThreads` as they read (`readable_search_text`), case and
-- accents folded (`fold.rs`). Trigram tokens
-- make LIKE '%q%' an index lookup for queries of three or more characters. `message_keys`
-- gives each message a stable rowid.
CREATE VIRTUAL TABLE IF NOT EXISTS message_search USING fts5(text, tokenize = 'trigram');
CREATE TABLE IF NOT EXISTS message_keys (
  id          INTEGER PRIMARY KEY,
  thread_id   TEXT NOT NULL,
  message_id  TEXT NOT NULL,
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
-- The store's high-water mark reads the newest receipt at open.
CREATE INDEX IF NOT EXISTS receipts_by_sequence ON receipts(sequence);
";

/// A command's receipt: a key lookup, never a scan of the event log.
pub(crate) const RECEIPT_SQL: &str = "SELECT sequence, owner_kind, owner_id, error, command_type FROM receipts WHERE command_id = ?1";

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
/// A committed command or run event: `(sequence, thread id, event)`.
pub(crate) type CommandEvent = (u64, String, Value);

/// Shell changes kept for resuming streams. An older cursor gets a fresh snapshot instead.
pub(crate) const SHELL_CHANGES_KEEP: i64 = 1024;
/// `SHELL_RESUME_MAX_GAP`: past this many events a snapshot is cheaper than the replay.
const SHELL_RESUME_MAX_GAP: u64 = 1_000;
/// `SHELL_REPLAY_PAYLOAD_BUDGET_BYTES`: raw event bytes a shell resume may replay.
const SHELL_REPLAY_BUDGET_BYTES: i64 = 8 * 1024 * 1024;
/// Retention runs when the sequence crosses a multiple of this, not on every commit.
const PRUNE_EVERY: u64 = 256;

fn err(e: rusqlite::Error) -> String {
    format!("store: {e}")
}

/// A stored JSON column. The engine wrote it, so bad JSON is a broken store, not a value.
/// The shell fields worktree cleanup reads; the rest is dropped as each row is read.
fn cleanup_fields(mut shell: Value) -> Value {
    const KEPT: [&str; 25] = [
        "id",
        "projectId",
        "title",
        "branch",
        "worktreePath",
        "lineage",
        "status",
        "activeRunId",
        "pendingBackgroundTasks",
        "pendingRuntimeRequest",
        "latestUserMessageAt",
        "latestRunId",
        "latestRunRequestedAt",
        "latestRunStartedAt",
        "latestRunCompletedAt",
        "createdAt",
        "updatedAt",
        "archivedAt",
        "settledAt",
        "settledOverride",
        "pinnedAt",
        "lastErrorClass",
        "usageLimitResetAt",
        "limitRecovery",
        "deletedAt",
    ];
    match shell.as_object_mut() {
        Some(map) => {
            map.retain(|key, _| KEPT.contains(&key.as_str()));
            shell
        }
        None => Value::Null,
    }
}

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

/// [`Tx::checkpoint_capture_folder`].
pub(crate) enum CaptureFolder {
    /// No capture event: the checkpoint came from the T3 server's import.
    Imported,
    /// Captured here, before any event recorded the scope's folder.
    Unknown,
    Known(String),
}

/// [`Store::thread_replay_stats`].
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct ReplayStats {
    pub(crate) events: u64,
    /// The bytes of the events' payload JSON.
    pub(crate) payload_bytes: u64,
    /// Whether one of them is `thread.created`.
    pub(crate) has_create: bool,
}

pub(crate) struct Store {
    conn: Connection,
    next_seq: u64,
    /// See [`Store::imported_through`].
    imported_through: u64,
    /// Every transaction's `now` (`EngineConfig::clock`).
    clock: std::sync::Arc<dyn crate::clock::Clock>,
    /// `EngineConfig::zone`.
    pub(crate) zone: jiff::tz::TimeZone,
    /// `EngineConfig::host`: the queue start asks it whether a run's provider is enabled.
    pub(crate) host: Option<std::sync::Arc<dyn crate::EngineHost>>,
    /// A title generator is configured, so commands may ask for titles.
    pub(crate) generates_titles: bool,
    /// The provider instances, so a command can tell an instance's driver ([`Tx::driver`]).
    pub(crate) providers: conn_provider::ProviderSet,
    /// Which runs' provider starts were accepted or abandoned. In memory: a restart starts
    /// every active run again, so nothing here outlives the process.
    starts: StartLedger,
    /// Set when attention events are on (`attention.rs`); raised after a commit that wrote one.
    pub(crate) attention: Option<std::sync::Arc<tokio::sync::Notify>>,
    /// Raised after a commit that wrote outbox rows (`outbox.rs`): the effect worker wakes.
    pub(crate) effects_wake: std::sync::Arc<tokio::sync::Notify>,
    /// The latest committed sequence, sent by the commit itself (T3's `EventSink` publishes
    /// after its transaction), so a caller that goes away cannot keep clients from seeing it.
    pub(crate) published: std::sync::Arc<tokio::sync::watch::Sender<u64>>,
    /// The engine that may write here ([`Store::take_ownership`]); `None` for a store opened
    /// without an engine.
    owner: Option<Owner>,
    /// Test hook: the next settlements fail with an I/O error.
    #[cfg(test)]
    pub(crate) settle_faults: std::cell::Cell<u32>,
}

/// An engine's lease on the store: the `engine_epoch` it took at open, and the flag its drop
/// raises. Every write checks both in its own transaction, so a dropped or replaced engine
/// never writes again (T3 scopes its workers to the runtime that owns the database).
#[derive(Clone)]
pub(crate) struct Owner {
    epoch: i64,
    released: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

impl Owner {
    pub(crate) fn epoch(&self) -> Option<i64> {
        (!self.released.load(std::sync::atomic::Ordering::SeqCst)).then_some(self.epoch)
    }
}

/// The last sequence the database holds.
fn stored_high(conn: &Connection) -> StoreResult<u64> {
    let high: i64 = conn
        .query_row(
            "SELECT MAX(COALESCE((SELECT MAX(seq) FROM events), 0),
                        COALESCE((SELECT MAX(seq) FROM shell_changes), 0),
                        COALESCE((SELECT MAX(sequence) FROM receipts), 0),
                        COALESCE((SELECT value FROM meta WHERE key = 'imported_through'), 0))",
            [],
            |row| row.get(0),
        )
        .map_err(err)?;
    Ok(high.max(0) as u64)
}

/// Whether a single-statement write may go ahead ([`Store::lease`]).
pub(crate) enum Lease {
    /// No engine took the store: write freely.
    Unowned,
    /// The statement checks this epoch against `meta.engine_epoch` itself.
    Held(i64),
    /// This engine was dropped: write nothing.
    Released,
}

impl Lease {
    /// The epoch a statement's [`lease_guard`] binds; `None` for a store no engine owns.
    pub(crate) fn guard(&self) -> Option<i64> {
        match self {
            Self::Held(epoch) => Some(*epoch),
            Self::Unowned | Self::Released => None,
        }
    }
}

/// The guard a single statement adds, with its epoch bound to `?{n}`.
pub(crate) fn lease_guard(n: usize) -> String {
    format!("(?{n} IS NULL OR ?{n} = (SELECT value FROM meta WHERE key = 'engine_epoch'))")
}

/// A start its caller gave up on before it took the store.
pub(crate) const ABANDONED: &str =
    "store: the engine's start was abandoned before it took the store";

/// A write by an engine that no longer owns the store.
pub(crate) const NOT_OWNER: &str = "store: this engine no longer owns the database";

/// Whether `owner` still holds the store, read in `conn`'s open transaction.
pub(crate) fn owns(conn: &Connection, owner: Option<&Owner>) -> StoreResult<bool> {
    let Some(owner) = owner else { return Ok(true) };
    let Some(epoch) = owner.epoch() else {
        return Ok(false);
    };
    let current: Option<i64> = conn
        .query_row(
            "SELECT value FROM meta WHERE key = 'engine_epoch'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(err)?;
    Ok(current == Some(epoch))
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
        conn.execute_batch(crate::attention::SCHEMA).map_err(err)?;
        conn.execute_batch(crate::outbox::SCHEMA).map_err(err)?;
        migrate(&conn)?;
        let high = stored_high(&conn)?;
        let imported_through: i64 = conn
            .query_row(
                "SELECT COALESCE((SELECT value FROM meta WHERE key = 'imported_through'), 0)",
                [],
                |row| row.get(0),
            )
            .map_err(err)?;
        Ok(Self {
            conn,
            imported_through: imported_through.max(0) as u64,
            next_seq: high + 1,
            clock: std::sync::Arc::new(crate::clock::SystemClock),
            zone: jiff::tz::TimeZone::UTC,
            host: None,
            generates_titles: false,
            providers: conn_provider::ProviderSet::default(),
            starts: StartLedger::default(),
            attention: None,
            effects_wake: std::sync::Arc::default(),
            published: std::sync::Arc::new(tokio::sync::watch::Sender::new(high)),
            owner: None,
            #[cfg(test)]
            settle_faults: std::cell::Cell::new(0),
        })
    }

    /// Makes this store's engine the one that may write: a newer epoch fences every engine
    /// that opened the database before. Returns the flag that releases the lease on drop.
    ///
    /// `abandoned` is read under the lease's write lock: a start its caller gave up on before
    /// that takes nothing, so it cannot fence an engine that opened after it.
    pub(crate) fn take_ownership(
        &mut self,
        abandoned: Option<&std::sync::atomic::AtomicBool>,
    ) -> StoreResult<std::sync::Arc<std::sync::atomic::AtomicBool>> {
        let tx = self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(err)?;
        if abandoned.is_some_and(|a| a.load(std::sync::atomic::Ordering::SeqCst)) {
            return Err(ABANDONED.into());
        }
        let epoch: i64 = tx
            .query_row(
                "INSERT INTO meta (key, value) VALUES ('engine_epoch', 1)
                 ON CONFLICT (key) DO UPDATE SET value = value + 1
                 RETURNING value",
                [],
                |row| row.get(0),
            )
            .map_err(err)?;
        // An older engine may have committed since `open` read the sequence; none can now.
        let high = stored_high(&tx)?;
        tx.commit().map_err(err)?;
        self.next_seq = high + 1;
        self.published.send_replace(high);
        let released = std::sync::Arc::default();
        self.owner = Some(Owner {
            epoch,
            released: std::sync::Arc::clone(&released),
        });
        Ok(released)
    }

    pub(crate) fn owner(&self) -> Option<&Owner> {
        self.owner.as_ref()
    }

    /// Whether this engine still holds the store, by the durable epoch and its drop flag.
    pub(crate) fn owns_store(&self) -> StoreResult<bool> {
        owns(&self.conn, self.owner())
    }

    /// What a write outside [`Tx`] must check (`Owner`).
    pub(crate) fn lease(&self) -> Lease {
        match &self.owner {
            None => Lease::Unowned,
            Some(owner) => owner.epoch().map_or(Lease::Released, Lease::Held),
        }
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

    /// The connection, outside any write: the attention outbox reads and deletes its own rows.
    pub(crate) fn raw(&self) -> &Connection {
        &self.conn
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

    /// The T3 import boundary (`t3_import.rs`), 0 when this store was never imported. A cursor
    /// at or below it may come from the T3 server, whose rows have no events here.
    pub(crate) fn imported_through(&self) -> u64 {
        self.imported_through
    }

    pub(crate) fn tx(&mut self) -> StoreResult<Tx<'_>> {
        let start = self.next_seq;
        let generates_titles = self.generates_titles;
        let now_ms = self.clock.now_millis();
        Ok(Tx {
            zone: self.zone.clone(),
            host: self.host.clone(),
            reserved: None,
            attention: self.attention.clone(),
            attention_written: false,
            effects_wake: self.effects_wake.clone(),
            effects_written: false,
            published: self.published.clone(),
            owner: self.owner.clone(),
            now_ms,
            generates_titles,
            providers: &self.providers,
            starts: &mut self.starts,
            starts_changed: None,
            tx: self.conn.transaction().map_err(err)?,
            store_seq: &mut self.next_seq,
            next_seq: start,
            start,
            now: conn_support::time::iso_from_ms(now_ms),
            touched: Vec::new(),
        })
    }

    /// The sequence a handled command answered with, accepted or refused.
    pub(crate) fn receipt(&self, command_id: &str) -> StoreResult<Option<u64>> {
        Ok(self.outcome(command_id)?.map(|receipt| receipt.sequence))
    }

    /// What a handled command's receipt recorded (`CommandReceiptStore.ts`).
    pub(crate) fn outcome(&self, command_id: &str) -> StoreResult<Option<Receipt>> {
        receipt_of(&self.conn, command_id)
    }

    /// Records a refused command, as T3's `commitRejectedCommand`, so a retry gets the same
    /// answer. A receipt already there stays.
    pub(crate) fn record_refusal(&self, key: &ReceiptKey<'_>, refusal: &str) -> StoreResult<()> {
        refuse(&self.conn, key, refusal)
    }

    /// Whether `command_id` was an accepted `message.dispatch` for `thread_id` that made a run:
    /// the proof of a launch's first message (T3: "Initial message was accepted without a
    /// durable run"). Both reads are key lookups.
    pub(crate) fn accepted_first_message(
        &self,
        command_id: &str,
        thread_id: &str,
    ) -> StoreResult<bool> {
        self.conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM receipts WHERE command_id = ?1
                     AND command_type = 'message.dispatch' AND owner_kind = 'thread'
                     AND owner_id = ?2 AND error IS NULL)
                 AND EXISTS(SELECT 1 FROM events WHERE command_id = ?1 AND thread_id = ?2
                     AND type = 'run.created')",
                params![command_id, thread_id],
                |row| row.get(0),
            )
            .map_err(err)
    }

    /// The checkout a launch's claim recorded: the `worktreePath` of the thread event that
    /// `command_id` wrote on `thread_id` (`thread.created`, or the reuse claim's
    /// `thread.metadata-updated`). `None` when no such event exists. Reads the thread's own
    /// events, through `events_by_thread`.
    pub(crate) fn claimed_checkout(
        &self,
        command_id: &str,
        thread_id: &str,
    ) -> StoreResult<Option<Value>> {
        let event: Option<String> = self
            .conn
            .query_row(
                "SELECT event FROM events WHERE thread_id = ?2 AND command_id = ?1
                   AND type IN ('thread.created', 'thread.metadata-updated')
                 ORDER BY seq LIMIT 1",
                params![command_id, thread_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(err)?;
        event
            .map(|event| parse(event).map(|e| e["payload"]["worktreePath"].clone()))
            .transpose()
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

    /// Whether the thread was ever created here, deleted or not.
    pub(crate) fn thread_known(&self, thread_id: &str) -> StoreResult<bool> {
        self.conn
            .query_row("SELECT 1 FROM threads WHERE id = ?1", [thread_id], |_| {
                Ok(())
            })
            .optional()
            .map(|row| row.is_some())
            .map_err(err)
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

    /// The stored shell row of a live thread.
    pub(crate) fn stored_shell(&self, thread_id: &str) -> StoreResult<Option<Value>> {
        self.conn
            .query_row(
                "SELECT shell FROM threads WHERE id = ?1 AND deleted = 0 AND shell IS NOT NULL",
                [thread_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(err)?
            .map(parse)
            .transpose()
    }

    /// A live thread's stored record, without its history.
    pub(crate) fn thread_record(&self, thread_id: &str) -> StoreResult<Option<Value>> {
        thread(&self.conn, thread_id)
    }

    /// The records idle compaction decides on (`IdleCompactionService.ts:56`), shaped as a
    /// projection: the thread, its latest run that ran, that run's user message, the active
    /// provider thread with its latest token usage, and pending requests and transfers.
    pub(crate) fn idle_compaction_records(&self, thread_id: &str) -> StoreResult<Option<Value>> {
        let Some(thread) = thread(&self.conn, thread_id)? else {
            return Ok(None);
        };
        let provider_thread = thread["activeProviderThreadId"]
            .as_str()
            .unwrap_or_default();
        let runs = self.query_json(
            "SELECT body FROM entities WHERE thread_id = ?1 AND kind = 'runs'
             AND NOT (json_extract(body, '$.status') = 'cancelled'
                      AND json_extract(body, '$.startedAt') IS NULL)
             ORDER BY ordinal DESC LIMIT 1",
            [thread_id],
        )?;
        let message = runs
            .first()
            .and_then(|run| run["userMessageId"].as_str())
            .unwrap_or_default();
        let one = |kind: &str, id: &str| -> StoreResult<Vec<Value>> {
            self.query_json(
                "SELECT body FROM entities WHERE thread_id = ?1 AND kind = ?2 AND id = ?3",
                params![thread_id, kind, id],
            )
        };
        let pending = |kind: &str| -> StoreResult<Vec<Value>> {
            self.query_json(
                "SELECT body FROM entities WHERE thread_id = ?1 AND kind = ?2
                 AND json_extract(body, '$.status') = 'pending'",
                params![thread_id, kind],
            )
        };
        Ok(Some(json!({
            "messages": one("messages", message)?,
            "providerThreads": one("providerThreads", provider_thread)?,
            "providerTurns": self.query_json(
                "SELECT body FROM entities WHERE thread_id = ?1 AND kind = 'providerTurns'
                 AND json_extract(body, '$.providerThreadId') = ?2
                 AND json_type(body, '$.tokenUsage') = 'object'
                 ORDER BY json_extract(body, '$.tokenUsage.updatedAt') DESC LIMIT 1",
                params![thread_id, provider_thread],
            )?,
            "runtimeRequests": pending("runtimeRequests")?,
            "contextTransfers": pending("contextTransfers")?,
            "runs": runs,
            "thread": thread,
        })))
    }

    /// See [`crate::settlement`].
    pub(crate) fn settlement_candidates(&self, thread_id: Option<&str>) -> StoreResult<Vec<Value>> {
        crate::settlement::candidates(&self.conn, thread_id)
    }

    /// What worktree cleanup weighs (T3 `storageCleanup.ts`): the shells of live and archived
    /// threads, and deleted threads that had a worktree and a branch, each
    /// with its project's root as `workspaceRoot`.
    pub(crate) fn cleanup_threads(&self) -> StoreResult<(Vec<Value>, Vec<Value>)> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT shell FROM threads WHERE deleted = 0 AND shell IS NOT NULL ORDER BY rowid",
            )
            .map_err(err)?;
        let live = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(err)?
            .map(|row| row.map_err(err).and_then(parse).map(cleanup_fields))
            .collect::<StoreResult<Vec<Value>>>()?;
        let mut stmt = self
            .conn
            .prepare(
                "SELECT p.workspace_root, t.thread FROM threads t JOIN projects p ON p.id = t.project_id
                 WHERE t.deleted = 1 AND json_extract(t.thread, '$.worktreePath') IS NOT NULL
                   AND json_extract(t.thread, '$.branch') IS NOT NULL ORDER BY t.rowid",
            )
            .map_err(err)?;
        let deleted = keyed_rows(
            stmt.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(err)?,
        )?
        .into_iter()
        .map(|(root, thread)| {
            let mut thread = cleanup_fields(thread);
            thread["workspaceRoot"] = Value::String(root);
            thread
        })
        .collect();
        Ok((live, deleted))
    }

    /// `getThreadWorktreePaths`: each live thread with a stored worktree path.
    pub(crate) fn worktree_bindings(&self) -> StoreResult<Vec<(String, String)>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT id, json_extract(shell, '$.worktreePath') FROM threads
                 WHERE deleted = 0 AND shell IS NOT NULL
                   AND json_extract(shell, '$.worktreePath') IS NOT NULL ORDER BY rowid",
            )
            .map_err(err)?;
        stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(err)?
            .map(|row| row.map_err(err))
            .collect()
    }

    /// The cleanup fields of the live shells of `ids` (`getThreadShell`).
    pub(crate) fn cleanup_shells(&self, ids: &[String]) -> StoreResult<Vec<Value>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT shell FROM threads WHERE id = ?1 AND deleted = 0 AND shell IS NOT NULL",
            )
            .map_err(err)?;
        let mut shells = Vec::with_capacity(ids.len());
        for id in ids {
            if let Some(text) = stmt
                .query_row([id], |row| row.get::<_, String>(0))
                .optional()
                .map_err(err)?
            {
                shells.push(cleanup_fields(parse(text)?));
            }
        }
        Ok(shells)
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

    /// The threads that own a task in a linked environment, which a trimmed shell keeps.
    pub(crate) fn remote_task_owners(&self) -> StoreResult<std::collections::HashSet<String>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT DISTINCT thread_id FROM entities
                 WHERE kind = 'subagents' AND json_type(body, '$.remoteChild') = 'object'
                   AND json_extract(body, '$.origin') = 'app_owned'
                   AND json_type(body, '$.childThreadId') IS NOT 'text'",
            )
            .map_err(err)?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(err)?;
        rows.map(|row| row.map_err(err)).collect()
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

    /// Whether a shell stream resumes from `after` with changes rather than a snapshot
    /// (`canResumeShellFrom`), for the socket's `afterSequence` and the HTTP `resumeFrom`: at
    /// most [`SHELL_RESUME_MAX_GAP`] events and [`SHELL_REPLAY_BUDGET_BYTES`] of them behind.
    pub(crate) fn shell_resumable(&self, after: u64) -> StoreResult<bool> {
        let high = self.high_water();
        if !crate::streams::can_replay(after, high, self.imported_through()) {
            return Ok(false);
        }
        if after == high {
            return Ok(true);
        }
        if high - after > SHELL_RESUME_MAX_GAP {
            return Ok(false);
        }
        let bytes: i64 = self
            .conn
            .query_row(
                "SELECT COALESCE(SUM(length(CAST(event AS BLOB))), 0) FROM events
                 WHERE seq > ?1 AND seq <= ?2",
                params![after as i64, high as i64],
                |row| row.get(0),
            )
            .map_err(err)?;
        if bytes > SHELL_REPLAY_BUDGET_BYTES {
            return Ok(false);
        }
        let pruned: i64 = self
            .conn
            .query_row(
                "SELECT COALESCE((SELECT value FROM meta WHERE key = 'shell_pruned_through'), 0)",
                [],
                |row| row.get(0),
            )
            .map_err(err)?;
        Ok(i64::try_from(after).is_ok_and(|after| after >= pruned))
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
        // A run fork shows the history it inherits first, then its own rows.
        let mut visible = ProjectedRows::default();
        self.inherited_rows(&projection["thread"], &mut visible)?;
        for item in shown.iter().filter_map(|at| items.get(*at)) {
            visible.push("local", json!(thread_id), item["id"].clone(), item.clone())?;
        }
        if let Some(Value::Array(messages)) = projection.get_mut("messages") {
            sort_messages_by_turn_items(messages, &items);
        }
        if omitted {
            items.drain(..shown.len());
        }
        projection.insert("turnItems".into(), Value::Array(items));
        projection.insert("visibleTurnItems".into(), Value::Array(visible.0));
        projection.insert("updatedAt".into(), Value::String(activity_at));
        Ok(Some((Value::Object(projection), omitted)))
    }

    /// The control projection of a live thread (no `messages`, `turnItems` or
    /// `visibleTurnItems`) and its timeline index: each visible row's selection fields and
    /// size, read one body at a time (`history::IndexRows`). `None` for an unknown or deleted
    /// thread.
    fn timeline_index(&self, thread_id: &str) -> StoreResult<Option<(Value, Vec<Value>)>> {
        let Some((thread, activity_at)) = self.live_thread(thread_id)? else {
            return Ok(None);
        };
        let mut projection = serde_json::Map::new();
        projection.insert("thread".into(), thread.clone());
        // Nodes, provider turns and subagents grow with every turn; a window reads its
        // cohort's only.
        for kind in COLLECTIONS {
            if !matches!(
                kind,
                "turnItems" | "messages" | "nodes" | "providerTurns" | "subagents"
            ) {
                projection.insert(
                    kind.into(),
                    Value::Array(entities(&self.conn, thread_id, kind)?),
                );
            }
        }
        projection.insert("updatedAt".into(), Value::String(activity_at));
        let mut index = crate::history::IndexRows::default();
        self.inherited_rows(&thread, &mut index)?;
        let rows = |kind: &str| {
            projection
                .get(kind)
                .and_then(Value::as_array)
                .map_or(&[][..], Vec::as_slice)
        };
        let rule = self.visibility(thread_id, rows("runs"), rows("attempts"))?;
        self.transcript_rows(thread_id, "local", &mut index, |item| rule.shows(item))?;
        Ok(Some((Value::Object(projection), index.0)))
    }

    /// Index rows with their stored items in place (T3's `materializeHistoryRows`).
    fn materialize_rows(&self, rows: Vec<Value>) -> StoreResult<Vec<Value>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT body FROM entities WHERE thread_id = ?1 AND kind = 'turnItems' AND id = ?2",
            )
            .map_err(err)?;
        rows.into_iter()
            .map(|mut row| {
                if !crate::history::is_generated(&row["item"]) {
                    let source = row["sourceThreadId"].as_str().unwrap_or_default();
                    let id = row["sourceItemId"].as_str().unwrap_or_default();
                    let body: String = stmt
                        .query_row(params![source, id], |r| r.get(0))
                        .map_err(err)?;
                    row["item"] = parse(body)?;
                }
                Ok(row)
            })
            .collect()
    }

    /// `buildBoundedThreadProjection` on indexed reads: the newest window of the thread and
    /// what it needs, with only the window's bodies, the open requests and the kept messages
    /// read. `None` for an unknown or deleted thread.
    pub(crate) fn bounded_thread(
        &self,
        thread_id: &str,
        sequence: u64,
    ) -> StoreResult<Option<crate::history::Bounded>> {
        use crate::history;
        let Some((control, index)) = self.timeline_index(thread_id)? else {
            return Ok(None);
        };
        let pending = history::pending_request_ids(&control);
        let dependencies: Vec<Value> = self
            .query_json(
                "SELECT body FROM entities WHERE thread_id = ?1 AND kind = 'turnItems'
                 AND json_extract(body, '$.type') IN
                   ('run_interrupt_request', 'user_input_request', 'approval_request')
                 ORDER BY ordinal, id",
                [thread_id],
            )?
            .into_iter()
            .filter(|item| history::is_retained_dependency(item, &pending))
            .collect();
        let window = history::select_window(&control, &index, &dependencies, sequence);
        drop(index);
        let mut control = control;
        let cohort = history::cohort_runs(&control, &window.rows);
        history::keep_cohort(&mut control, &cohort);
        let attempts: Vec<Value> = control["attempts"]
            .as_array()
            .map(|rows| rows.iter().map(|a| a["id"].clone()).collect())
            .unwrap_or_default();
        let nodes = self.query_json(
            "SELECT body FROM entities WHERE thread_id = ?1 AND kind = 'nodes' AND (
               json_extract(body, '$.runId') IN (SELECT value FROM json_each(?2))
               OR json_extract(body, '$.status') IN ('pending', 'starting', 'running', 'waiting'))
             ORDER BY first_seq",
            params![thread_id, Value::from(cohort.clone()).to_string()],
        )?;
        let provider_turns = self.query_json(
            "SELECT body FROM entities WHERE thread_id = ?1 AND kind = 'providerTurns' AND (
               json_extract(body, '$.runAttemptId') IN (SELECT value FROM json_each(?2))
               OR json_extract(body, '$.status') IN ('starting', 'running', 'waiting'))
             ORDER BY first_seq",
            params![thread_id, Value::from(attempts).to_string()],
        )?;
        // T3's windowed subagent read: the live ones, and those of the cohort's runs and nodes.
        let node_ids: Vec<Value> = nodes.iter().map(|node| node["id"].clone()).collect();
        let subagents = self.query_json(
            "SELECT body FROM entities WHERE thread_id = ?1 AND kind = 'subagents' AND (
               json_extract(body, '$.status') IN ('pending', 'starting', 'running', 'waiting')
               OR json_extract(body, '$.runId') IN (SELECT value FROM json_each(?2))
               OR json_extract(body, '$.parentNodeId') IN (SELECT value FROM json_each(?3)))
             ORDER BY first_seq",
            params![
                thread_id,
                Value::from(cohort).to_string(),
                Value::from(node_ids).to_string()
            ],
        )?;
        control["nodes"] = Value::Array(nodes);
        control["providerTurns"] = Value::Array(provider_turns);
        if let Value::Object(map) = &mut control {
            map.insert("subagents".into(), Value::Array(subagents));
            self.add_subagent_provider_threads(map)?;
        }
        let rows = self.materialize_rows(window.rows)?;
        let turn_items = history::window_turn_items(&control["thread"]["id"], &rows, dependencies);
        let (message_ids, run_ids) = history::message_scope(&control, &turn_items);
        let mut messages = self.query_json(
            "SELECT body FROM entities WHERE thread_id = ?1 AND kind = 'messages' AND (
               id IN (SELECT value FROM json_each(?2))
               OR json_extract(body, '$.runId') IN (SELECT value FROM json_each(?3))
               OR json_extract(body, '$.delegatedCompletion') IS NOT NULL
               OR json_extract(body, '$.workflowScript') = 1)
             ORDER BY first_seq",
            params![
                thread_id,
                Value::from(message_ids).to_string(),
                Value::from(run_ids).to_string()
            ],
        )?;
        sort_messages_by_turn_items(&mut messages, &turn_items);
        let latest_local_turn_ordinal = self
            .conn
            .query_row(
                "SELECT MAX(ordinal) FROM entities WHERE thread_id = ?1 AND kind = 'turnItems'",
                [thread_id],
                |row| row.get::<_, Option<i64>>(0),
            )
            .map_err(err)?
            .and_then(|n| u64::try_from(n).ok());
        Ok(Some(history::Bounded {
            projection: history::finish(control, rows, turn_items, messages),
            history_cursor: window.next_cursor,
            has_more_history: window.has_more_history,
            latest_local_turn_ordinal,
        }))
    }

    /// `getThreadHistoryPage` on indexed reads: only the page's bodies are read. `None` for an
    /// unknown or deleted thread.
    pub(crate) fn history_page(
        &self,
        thread_id: &str,
        sequence: u64,
        cursor: &crate::history::Cursor,
        through_entry_id: Option<&str>,
        conversation_only: bool,
    ) -> StoreResult<Option<Value>> {
        use crate::history;
        let Some((_, index)) = self.timeline_index(thread_id)? else {
            return Ok(None);
        };
        let mut page = history::page_rows(
            &index,
            sequence,
            cursor,
            through_entry_id,
            conversation_only,
        );
        drop(index);
        page.rows = self.materialize_rows(std::mem::take(&mut page.rows))?;
        let ids: Vec<Value> = page
            .rows
            .iter()
            .filter(|row| row["item"]["type"] == "subagent")
            .map(|row| row["item"]["subagentId"].clone())
            .collect();
        let subagents = self.query_json(
            "SELECT body FROM entities WHERE thread_id = ?1 AND kind = 'subagents'
             AND id IN (SELECT value FROM json_each(?2)) ORDER BY first_seq",
            params![thread_id, Value::from(ids).to_string()],
        )?;
        Ok(Some(history::page_body(
            thread_id, sequence, page, &subagents,
        )))
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
        if !self.visible_rows(&thread, &mut out)? {
            return Ok(ThreadTranscript::TooLarge);
        }
        Ok(ThreadTranscript::Body(out.finish(
            id,
            title,
            &updated_at,
        )?))
    }

    /// A thread's visible timeline rows, read one at a time into `out`: what a run fork
    /// inherits, then the thread's own visible rows. `false` when the sink is full.
    pub(crate) fn visible_rows(&self, thread: &Value, out: &mut impl RowSink) -> StoreResult<bool> {
        if !self.inherited_rows(thread, out)? {
            return Ok(false);
        }
        let thread_id = thread["id"].as_str().unwrap_or_default();
        let runs = entities(&self.conn, thread_id, "runs")?;
        let attempts = entities(&self.conn, thread_id, "attempts")?;
        let rule = self.visibility(thread_id, &runs, &attempts)?;
        self.transcript_rows(thread_id, "local", out, |item| rule.shows(item))
    }

    /// The rows a run fork that is not a side chat shows before its own, as T3's
    /// `buildVisibleTurnItems`: the source's rows through the fork run (recursively for a fork
    /// of a fork), then the synthetic fork marker. Nothing for any other thread. `false` when
    /// the sink is full.
    fn inherited_rows(&self, thread: &Value, out: &mut impl RowSink) -> StoreResult<bool> {
        let Some((source, run)) = inherited_run_fork(thread) else {
            return Ok(true);
        };
        let thread_id = thread["id"].as_str().unwrap_or_default();
        let created_at = thread["createdAt"].as_str().unwrap_or_default();
        let mut seen = vec![thread_id.to_owned()];
        if !self.transcript_inherited(&source, &run, created_at, &mut seen, out)? {
            return Ok(false);
        }
        let marker = fork_marker(thread, &source, &run);
        let marker_id = marker["id"].clone();
        out.push("synthetic", json!(source), marker_id, marker)
    }

    /// The thread record and `activity_at` of a thread that is not deleted.
    pub(crate) fn live_thread(&self, thread_id: &str) -> StoreResult<Option<(Value, String)>> {
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
        out: &mut impl RowSink,
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
        out: &mut impl RowSink,
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

    /// Stored events recorded for one command, in order.
    #[cfg(test)]
    pub(crate) fn command_events(&self, command_id: &str) -> StoreResult<Vec<Value>> {
        let mut stmt = self
            .conn
            .prepare("SELECT event FROM events WHERE command_id = ?1 ORDER BY seq")
            .map_err(err)?;
        let rows = stmt
            .query_map([command_id], |row| row.get::<_, String>(0))
            .map_err(err)?
            .map(|row| parse(row.map_err(err)?))
            .collect::<StoreResult<Vec<_>>>()?;
        Ok(rows)
    }

    /// What a resume from `after` would replay (`getAgentReplayStats`), read from at most the
    /// first `limit` events of the thread after it, in sequence order, without decoding them.
    pub(crate) fn thread_replay_stats(
        &self,
        thread_id: &str,
        after: u64,
        limit: usize,
    ) -> StoreResult<ReplayStats> {
        self.conn
            .query_row(
                "SELECT COUNT(*),
                        COALESCE(SUM(LENGTH(CAST(json_extract(event, '$.payload') AS BLOB))), 0),
                        COALESCE(MAX(type = 'thread.created'), 0)
                 FROM (SELECT event, type FROM events WHERE thread_id = ?1 AND seq > ?2
                       ORDER BY seq LIMIT ?3)",
                params![thread_id, after as i64, limit as i64],
                |row| {
                    Ok(ReplayStats {
                        events: row.get::<_, i64>(0)? as u64,
                        payload_bytes: row.get::<_, i64>(1)? as u64,
                        has_create: row.get(2)?,
                    })
                },
            )
            .map_err(err)
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

    /// Committed `command_execution` item updates and run updates of every thread after
    /// `after`, at most `limit`, as `(sequence, thread id, event)`, and the sequence the read
    /// covered: the high water for a short page, so rows that match nothing are read once.
    pub(crate) fn command_events_after(
        &self,
        after: u64,
        limit: usize,
    ) -> StoreResult<(Vec<CommandEvent>, u64)> {
        let high = self.high_water();
        let mut stmt = self
            .conn
            .prepare(
                "SELECT seq, thread_id, event FROM events WHERE seq > ?1 AND seq <= ?3
                 AND (type = 'run.updated' OR (type = 'turn-item.updated'
                   AND json_extract(event, '$.payload.type') = 'command_execution'))
                 ORDER BY seq LIMIT ?2",
            )
            .map_err(err)?;
        let rows = stmt
            .query_map(params![after as i64, limit as i64, high as i64], |row| {
                Ok((
                    row.get::<_, i64>(0)? as u64,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(err)?
            .map(|row| {
                let (seq, thread_id, text) = row.map_err(err)?;
                Ok((seq, thread_id, parse(text)?))
            })
            .collect::<StoreResult<Vec<_>>>()?;
        let through = match rows.last() {
            Some((seq, _, _)) if rows.len() == limit => *seq,
            _ => high.max(after),
        };
        Ok((rows, through))
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

    /// One text column per row.
    pub(crate) fn query_rows_text(&self, sql: &str) -> StoreResult<Vec<String>> {
        let mut stmt = self.conn.prepare(sql).map_err(err)?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(err)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(err)?;
        Ok(rows)
    }

    /// Moves the write-ahead log into the file and empties it.
    pub(crate) fn checkpoint(&self) -> StoreResult<()> {
        self.conn
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
            .map_err(err)
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

    /// Threads with a provider-native subagent still open: no process is left to end it.
    pub(crate) fn threads_with_live_native_subagents(&self) -> StoreResult<Vec<String>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT DISTINCT thread_id FROM entities WHERE kind = 'subagents'
                 AND json_extract(body, '$.origin') = 'provider_native'
                 AND json_extract(body, '$.status') IN ('pending','running','waiting')",
            )
            .map_err(err)?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(err)?;
        rows.collect::<Result<_, _>>().map_err(err)
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
    providers: &'a conn_provider::ProviderSet,
    starts: &'a mut StartLedger,
    /// The ledger as this write changed it; it replaces the store's on commit only.
    starts_changed: Option<StartLedger>,
    /// See [`Store::attention`].
    attention: Option<std::sync::Arc<tokio::sync::Notify>>,
    attention_written: bool,
    effects_wake: std::sync::Arc<tokio::sync::Notify>,
    effects_written: bool,
    published: std::sync::Arc<tokio::sync::watch::Sender<u64>>,
    owner: Option<Owner>,
    now_ms: u64,
    zone: jiff::tz::TimeZone,
    host: Option<std::sync::Arc<dyn crate::EngineHost>>,
    /// The command id [`Tx::reserve`] took, whose receipt the commit completes.
    reserved: Option<String>,
}

impl Tx<'_> {
    /// The open transaction, for a module that keeps its own tables (`outbox.rs`).
    pub(crate) fn sql(&self) -> &Connection {
        &self.tx
    }

    /// Outbox rows were written: the commit wakes the effect worker.
    pub(crate) fn mark_effects_written(&mut self) {
        self.effects_written = true;
    }

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

    /// Now, in milliseconds since the epoch, as [`Self::now`].
    pub(crate) fn now_ms(&self) -> u64 {
        self.now_ms
    }

    /// What `command_id`'s receipt recorded, read inside this write.
    pub(crate) fn outcome(&self, command_id: &str) -> StoreResult<Option<Receipt>> {
        receipt_of(&self.tx, command_id)
    }

    /// Takes the command's id for this write, as T3's `insertIfAbsent`: `false` when another
    /// command holds it. The commit then fills in the sequence.
    pub(crate) fn reserve(&mut self, key: &ReceiptKey<'_>) -> StoreResult<bool> {
        let taken = self
            .tx
            .execute(
                "INSERT INTO receipts (command_id, command_type, sequence, owner_kind, owner_id)
                 VALUES (?1, ?2, 0, ?3, ?4) ON CONFLICT(command_id) DO NOTHING",
                params![
                    key.command_id,
                    key.command_type,
                    key.owner.kind(),
                    key.owner.id()
                ],
            )
            .map_err(err)?
            == 1;
        if taken {
            self.reserved = Some(key.command_id.to_owned());
        }
        Ok(taken)
    }

    /// Whether a queued run may start on `instance` in `project`, by T3's queue rule (the
    /// server's settings; all, without a host).
    pub(crate) fn queue_enabled(&self, project: Option<&str>, instance: &str) -> bool {
        self.host
            .as_ref()
            .is_none_or(|host| host.queue_instance_enabled(project, instance))
    }

    /// Milliseconds since the epoch of a command's time string, as T3's `DateTime.make`.
    pub(crate) fn date_input_millis(&self, text: &str) -> Option<i64> {
        crate::time::date_input_millis(text, &self.zone)
    }

    /// The driver of a provider instance, found as a turn start finds the instance.
    pub(crate) fn driver(&self, instance: &str) -> Option<String> {
        self.providers
            .resolve(instance)
            .map(|provider| provider.driver().to_owned())
    }

    pub(crate) fn now(&self) -> &str {
        &self.now
    }

    fn alloc(&mut self) -> u64 {
        let seq = self.next_seq;
        self.next_seq += 1;
        seq
    }

    /// `attributePendingBackgroundTasks` (`ProjectionStore.ts:915`): adapters resend whole
    /// rosters without runs, so the projection's copy of a task keeps the run it first appeared
    /// under: the event's run, else the thread's active run. `None` when nothing changes; the
    /// event itself keeps the provider's roster.
    fn attributed_background_tasks(
        &self,
        thread_id: &str,
        payload: &Value,
        run_id: Option<&str>,
    ) -> StoreResult<Option<Value>> {
        let Some(tasks) = payload["pendingBackgroundTasks"].as_array() else {
            return Ok(None);
        };
        if tasks.iter().all(|task| task["runId"].is_string()) {
            return Ok(None);
        }
        let id = payload["id"].as_str().unwrap_or_default();
        let previous = self.entity(thread_id, "providerThreads", id)?;
        let known: Vec<(Value, Value)> = previous
            .as_ref()
            .and_then(|thread| thread["pendingBackgroundTasks"].as_array().cloned())
            .unwrap_or_default()
            .into_iter()
            .map(|task| (task["taskId"].clone(), task["runId"].clone()))
            .collect();
        let current = match run_id {
            Some(run) => Some(Value::String(run.to_owned())),
            None => crate::commands::active_run(self, thread_id)?.map(|run| run["id"].clone()),
        };
        let mut projected = payload.clone();
        if let Some(tasks) = projected["pendingBackgroundTasks"].as_array_mut() {
            for task in tasks.iter_mut().filter(|task| !task["runId"].is_string()) {
                let owner = match known.iter().find(|(id, _)| *id == task["taskId"]) {
                    Some((_, owner)) => Some(owner.clone()).filter(Value::is_string),
                    None => current.clone(),
                };
                if let Some(owner) = owner {
                    task["runId"] = owner;
                }
            }
        }
        Ok(Some(projected))
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
            provider_instance,
        } = draft;
        let projected = match event_type {
            "provider-thread.updated" => {
                self.attributed_background_tasks(&thread_id, &payload, run_id.as_deref())?
            }
            _ => None,
        };
        let provider_instance_id = match provider_instance {
            Instance::Given(id) => Some(id),
            Instance::Absent => None,
            // A run's own event carries it; any other reads the stored run.
            Instance::FromRun => match &run_id {
                Some(_)
                    if event_type.starts_with("run.")
                        && payload["providerInstanceId"].is_string() =>
                {
                    payload["providerInstanceId"].as_str().map(str::to_owned)
                }
                Some(run) => self
                    .entity(&thread_id, "runs", run)?
                    .and_then(|r| r["providerInstanceId"].as_str().map(str::to_owned)),
                None => None,
            },
        };
        let collection = collection_of(event_type);
        let mut inserted = false;
        let payload_sets_updated_at =
            conn_contract::PAYLOAD_UPDATED_AT_EVENTS.contains(&event_type);
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
                    params![thread_id, kind, id, first_seq, seq as i64, ordinal,
                        projected.as_ref().unwrap_or(&payload).to_string()],
                )
                .map_err(err)?;
        } else if event_type.starts_with("thread.") {
            // A visit carries only the read mark; T3's projection applies it to the thread
            // (`applyOrchestrationV2ThreadVisit`).
            let applied;
            let thread_row = if event_type == "thread.visit-recorded" {
                let mut thread = self.thread(&thread_id)?.unwrap_or(Value::Null);
                if thread.is_object() {
                    thread["lastVisitedAt"] = payload["lastVisitedAt"].clone();
                    if let Some(opens) = payload.get("opens") {
                        thread["opens"] = opens.clone();
                    }
                }
                applied = thread;
                &applied
            } else {
                &payload
            };
            let project_id = thread_row["projectId"]
                .as_str()
                .unwrap_or_default()
                .to_owned();
            let deleted = event_type == "thread.deleted";
            // T3's `ProjectionStore.ts`: a thread event writes its payload's `updatedAt`.
            let updated_at = match thread_row["updatedAt"].as_str() {
                Some(at) if payload_sets_updated_at => at.to_owned(),
                _ => self.now.clone(),
            };
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
                    params![thread_id, project_id, deleted, updated_at, thread_row.to_string()],
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
        if let Some(id) = provider_instance_id {
            event["providerInstanceId"] = json!(id);
        }
        let streaming = event["payload"]["streaming"] == json!(true);
        self.tx
            .execute(
                "INSERT INTO events (seq, thread_id, command_id, type, streaming, event) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![seq as i64, thread_id, command_id, event_type, streaming, event.to_string()],
            )
            .map_err(err)?;
        // Every other event moves the thread's `updatedAt` to its time, in the row and in the
        // stored thread, as T3's `writeThreadTouches`.
        if !payload_sets_updated_at {
            self.tx
                .execute(
                    "UPDATE threads SET activity_at = ?2, thread = json_set(thread, '$.updatedAt', ?2)
                     WHERE id = ?1",
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

    /// The ordinal of a thread's next run: one above its highest. A thread imported from T3
    /// can have gaps (T3 moves a queued run past newer ones when it starts it), so the count
    /// of runs would give an ordinal already taken.
    pub(crate) fn next_run_ordinal(&self, thread_id: &str) -> StoreResult<u64> {
        self.tx
            .query_row(
                "SELECT COALESCE(MAX(ordinal), 0) FROM entities WHERE thread_id = ?1 AND kind = 'runs'",
                [thread_id],
                |row| row.get::<_, i64>(0),
            )
            .map(|max| max.max(0) as u64 + 1)
            .map_err(err)
    }

    /// Marks a thread's shell row for the commit to recompute, at a new sequence.
    pub(crate) fn touch(&mut self, thread_id: &str) {
        let seq = self.alloc();
        match self.touched.iter_mut().find(|(id, _)| id == thread_id) {
            Some(entry) => entry.1 = seq,
            None => self.touched.push((thread_id.to_owned(), seq)),
        }
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

    /// Where the checkpoint was captured, by the log: the `cwd` of the last
    /// `checkpoint-scope.created` before its last capture that did not mark it `stale`.
    pub(crate) fn checkpoint_capture_folder(
        &self,
        thread_id: &str,
        checkpoint_id: &str,
    ) -> StoreResult<CaptureFolder> {
        let captured: Option<i64> = self
            .tx
            .query_row(
                "SELECT MAX(seq) FROM events
                 WHERE thread_id = ?1 AND type = 'checkpoint.captured'
                   AND json_extract(event, '$.payload.id') = ?2
                   AND json_extract(event, '$.payload.status') <> 'stale'",
                [thread_id, checkpoint_id],
                |row| row.get(0),
            )
            .map_err(err)?;
        let Some(captured) = captured else {
            return Ok(CaptureFolder::Imported);
        };
        let cwd: Option<String> = self
            .tx
            .query_row(
                "SELECT json_extract(event, '$.payload.cwd') FROM events
                 WHERE thread_id = ?1 AND type = 'checkpoint-scope.created' AND seq < ?2
                 ORDER BY seq DESC LIMIT 1",
                params![thread_id, captured],
                |row| row.get(0),
            )
            .optional()
            .map_err(err)?
            .flatten();
        Ok(cwd.map_or(CaptureFolder::Unknown, CaptureFolder::Known))
    }

    /// Whether the thread's log holds a `checkpoint-scope.created`. A scope imported from the
    /// T3 server has its row but none.
    pub(crate) fn has_scope_event(&self, thread_id: &str) -> StoreResult<bool> {
        self.tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM events
                 WHERE thread_id = ?1 AND type = 'checkpoint-scope.created')",
                [thread_id],
                |row| row.get(0),
            )
            .map_err(err)
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

    /// Remote delegated tasks a follower still owes something (`getOpenRemoteDelegatedTasks`):
    /// no result yet, a cancel or Stop not yet carried there, or a stop owed after the result.
    /// Returns `(parentThreadId, taskId)` pairs, at most `limit`.
    pub(crate) fn open_remote_tasks(&self, limit: usize) -> StoreResult<Vec<(String, String)>> {
        let mut statement = self
            .tx
            .prepare(
                "SELECT e.thread_id, e.id FROM entities e JOIN threads t ON t.id = e.thread_id
                 WHERE e.kind = 'subagents' AND t.deleted = 0
                   AND json_extract(e.body, '$.origin') = 'app_owned'
                   AND json_type(e.body, '$.remoteChild') = 'object'
                   AND (
                     json_type(e.body, '$.result') IS NOT 'text'
                     OR (json_extract(e.body, '$.status') IN ('cancelled', 'interrupted')
                         AND json_type(e.body, '$.remoteChild.stoppedThere') IS NOT 'true')
                     OR json_type(e.body, '$.remoteChild.stoppedThere') = 'false'
                   )
                 ORDER BY e.first_seq LIMIT ?1",
            )
            .map_err(err)?;
        let rows = statement
            .query_map([i64::try_from(limit).unwrap_or(i64::MAX)], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(err)?;
        rows.map(|row| row.map_err(err)).collect()
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

    /// Whether the thread has any record of `kind`: stops at the first row of the key range.
    pub(crate) fn has(&self, thread_id: &str, kind: &str) -> StoreResult<bool> {
        self.tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM entities WHERE thread_id = ?1 AND kind = ?2)",
                params![thread_id, kind],
                |row| row.get(0),
            )
            .map_err(err)
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

    /// The sequence of the thread's latest stored event, or 0.
    pub(crate) fn thread_latest_sequence(&self, thread_id: &str) -> StoreResult<u64> {
        self.tx
            .query_row(
                "SELECT COALESCE(MAX(seq), 0) FROM events WHERE thread_id = ?1",
                [thread_id],
                |row| row.get::<_, i64>(0),
            )
            .map(|seq| seq.max(0) as u64)
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

    /// The project row that owns `workspace_root`, deleted or not. Rows an older version stored
    /// unnormalized (`/work/repo/.`) are found by their normalized folder, a live one first.
    pub(crate) fn project_by_root(&self, workspace_root: &str) -> StoreResult<Option<Value>> {
        let exact = self
            .tx
            .query_row(
                "SELECT body FROM projects WHERE workspace_root = ?1",
                [workspace_root],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(err)?
            .map(parse)
            .transpose()?;
        if exact.as_ref().is_some_and(|p| p["deletedAt"].is_null()) {
            return Ok(exact);
        }
        let wanted = crate::projects::normalize_workspace_root(workspace_root);
        let mut statement = self.tx.prepare("SELECT body FROM projects").map_err(err)?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(err)?;
        let mut deleted = None;
        for row in rows {
            let project = parse(row.map_err(err)?)?;
            let root = project["workspaceRoot"].as_str().unwrap_or_default();
            if crate::projects::normalize_workspace_root(root) != wanted {
                continue;
            }
            if project["deletedAt"].is_null() {
                return Ok(Some(project));
            }
            deleted.get_or_insert(project);
        }
        Ok(exact.or(deleted))
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
    pub(crate) fn commit(mut self, receipt: Option<&ReceiptKey<'_>>) -> StoreResult<u64> {
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
                if self.attention.is_some() {
                    let before = previous
                        .as_deref()
                        .and_then(|p| serde_json::from_str(p).ok());
                    self.attention_written |= crate::attention::record(
                        &self.tx,
                        &thread_id,
                        before.as_ref(),
                        &row,
                        self.now_ms,
                        &self.now,
                    )?;
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
        // A command that wrote nothing answers its own thread's latest sequence, as T3's
        // `eventSink.latestSequence({ threadId })`, not whatever another thread wrote last.
        let mut answer = high;
        if let Some(key) = receipt {
            if self.next_seq == self.start {
                answer = latest_sequence(&self.tx, key.owner)?;
            }
            // A receipt is never replaced: one another command holds fails this write.
            if self.reserved.as_deref() == Some(key.command_id) {
                self.tx
                    .execute(
                        "UPDATE receipts SET sequence = ?2 WHERE command_id = ?1",
                        params![key.command_id, answer as i64],
                    )
                    .map_err(err)?;
            } else {
                self.tx
                    .execute(
                        "INSERT INTO receipts
                           (command_id, command_type, sequence, owner_kind, owner_id)
                         VALUES (?1, ?2, ?3, ?4, ?5)",
                        params![
                            key.command_id,
                            key.command_type,
                            answer as i64,
                            key.owner.kind(),
                            key.owner.id()
                        ],
                    )
                    .map_err(err)?;
            }
        }
        if high / PRUNE_EVERY != (self.start.saturating_sub(1)) / PRUNE_EVERY {
            prune(&self.tx)?;
        }
        // Last, after every write: the write lock is held, so no newer engine can take the
        // store between this check and the commit.
        if !owns(&self.tx, self.owner.as_ref())? {
            return Err(NOT_OWNER.into());
        }
        self.tx.commit().map_err(err)?;
        *self.store_seq = self.next_seq;
        self.published.send_if_modified(|published| {
            let newer = high > *published;
            if newer {
                *published = high;
            }
            newer
        });
        if self.attention_written
            && let Some(attention) = &self.attention
        {
            attention.notify_one();
        }
        if self.effects_written {
            self.effects_wake.notify_one();
        }
        if let Some(starts) = self.starts_changed.take() {
            *self.starts = starts;
        }
        Ok(answer)
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

/// Whether `table` has `column`; SQLite compares column names without case.
fn has_column(conn: &Connection, table: &str, column: &str) -> StoreResult<bool> {
    conn.prepare("SELECT 1 FROM pragma_table_info(?1) WHERE name = ?2 COLLATE NOCASE")
        .and_then(|mut stmt| stmt.exists([table, column]))
        .map_err(err)
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
    if version < 4 {
        // 4: backfill `subagentCount` on existing stored shells so idle parents show their
        // count immediately after an upgrade instead of waiting for their next write.
        conn.execute_batch(
            "UPDATE threads
             SET shell = json_set(
               shell,
               '$.subagentCount',
               (SELECT COUNT(*) FROM entities WHERE entities.thread_id = threads.id AND entities.kind = 'subagents')
             )
             WHERE deleted = 0
               AND shell IS NOT NULL
               AND EXISTS (
                 SELECT 1 FROM entities WHERE entities.thread_id = threads.id AND entities.kind = 'subagents'
               );
             PRAGMA user_version = 4;",
        )
        .map_err(err)?;
    }
    // A store a pre-merge build of the readable-search change wrote is at 6, with
    // `message_keys.search_text`. The index holds that text now, so the column goes and the
    // store is 5 again, and main's next step 6 runs on it. The refold below rebuilds its index.
    let version = if version == 6 && has_column(conn, "message_keys", "search_text")? {
        let tx = conn.unchecked_transaction().map_err(err)?;
        tx.execute_batch(
            "ALTER TABLE message_keys DROP COLUMN search_text;
             PRAGMA user_version = 5;",
        )
        .map_err(err)?;
        tx.commit().map_err(err)?;
        5
    } else {
        version
    };
    if version <= 5 {
        // 5: a receipt names what it answers for and records a refusal (T3's
        // `CommandReceiptV2`). A receipt from before names no owner, so a retry of it is
        // refused rather than replayed for a thread nothing proves. A store a pre-merge build
        // wrote may lack them at 5, so each column is added where it is missing. One
        // transaction: the columns and the version land together or not at all.
        let tx = conn.unchecked_transaction().map_err(err)?;
        for column in ["owner_kind", "owner_id", "error"] {
            if !has_column(&tx, "receipts", column)? {
                tx.execute_batch(&format!("ALTER TABLE receipts ADD COLUMN {column} TEXT"))
                    .map_err(err)?;
            }
        }
        if version < 5 {
            tx.execute_batch("PRAGMA user_version = 5").map_err(err)?;
        }
        tx.commit().map_err(err)?;
    }
    // The index holds folded text as it reads, so a search without accents finds an accented
    // message written before the upgrade (T3 indexes `remove_diacritics(readableSearchText)`).
    refold_message_search_once(conn, &mut |event| {
        eprintln!("conn-engine: {}", event.line())
    })?;
    Ok(())
}

/// `readableSearchText` in T3's `messageSearchIndex.ts`: a message as it reads, a citation as
/// its text and comment, and a link label without its markdown escapes (a file mention stores
/// `__init__.py` as `[\_\_init\_\_.py](...)`). `None` when that is the stored text.
pub(crate) fn readable_search_text(text: &str) -> Option<String> {
    let plain = crate::citations::to_plain_text(text);
    let readable = unescape_link_labels(&plain);
    (readable != text).then_some(readable)
}

/// T3's `LINK_LABEL` (`(!?\[)([^\]\n]*)(\]\([^)\s]*\))`), with `\*` and `\_` in each label
/// unescaped.
fn unescape_link_labels(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some((before, after)) = rest.split_once('[') {
        out.push_str(before);
        out.push('[');
        // `label](href)`: the label stops at `]` or a line end, the href at `)` or a space.
        let link = after.find([']', '\n']).and_then(|end| {
            let label = after.get(..end)?;
            let tail = after.get(end..)?.strip_prefix("](")?;
            let end = tail.find(|c: char| c == ')' || c.is_whitespace())?;
            let href = tail.get(..end)?;
            let rest = tail.get(end..)?.strip_prefix(')')?;
            Some((label, href, rest))
        });
        match link {
            Some((label, href, tail)) => {
                out.push_str(&label.replace("\\*", "*").replace("\\_", "_"));
                out.push_str("](");
                out.push_str(href);
                out.push(')');
                rest = tail;
            }
            None => rest = after,
        }
    }
    out.push_str(rest);
    out
}

/// Puts the final text of one message into `message_search` as it reads, replacing an older
/// version.
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
    write_search_entry(conn, id, text)
}

/// The index row of the keyed message `id`: its readable text, folded. Every message write
/// goes through here; the upgrade and the T3 import fold the same way
/// ([`refold_message_search`]).
fn write_search_entry(conn: &Connection, id: i64, text: &str) -> StoreResult<()> {
    let readable = readable_search_text(text);
    conn.execute("DELETE FROM message_search WHERE rowid = ?1", [id])
        .map_err(err)?;
    conn.execute(
        "INSERT INTO message_search (rowid, text) VALUES (?1, ?2)",
        params![id, crate::fold::fold(readable.as_deref().unwrap_or(text))],
    )
    .map_err(err)?;
    Ok(())
}

/// The fold the search index holds, in the `meta` row `message_search_folded`: 1 was the first
/// fold, which also took marks off other scripts' letters; 2 lowercased as Rust does; 3 folds
/// with SQLite's own table, as T3's index (`fold.rs`); 4 folds the message as it reads
/// ([`readable_search_text`]). A `meta` mark, not a schema version, so
/// this step composes with versioned steps in any order.
const MESSAGE_SEARCH_FOLD: i64 = 4;
/// Messages between two progress lines of a refold.
const REFOLD_REPORT_EVERY: u64 = 10_000;
/// The most text a refold batch holds before it writes, with `REFOLD_BATCH_ROWS` rows at most.
/// A row larger than this is folded alone.
const REFOLD_BATCH_BYTES: usize = 4 << 20;
const REFOLD_BATCH_ROWS: usize = 500;

/// What a refold of the search index reports. Its lines carry T3's migration messages, which the
/// desktop reads in the server's output: while a refold runs, it waits past its readiness limit
/// instead of reporting a failed start.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Refold {
    Started { messages: u64 },
    Progress { done: u64, messages: u64 },
    Finished,
}

impl Refold {
    pub(crate) fn line(self) -> String {
        use conn_contract::{
            DATABASE_MIGRATION_PROGRESS_MESSAGE, DATABASE_MIGRATIONS_FINISHED_MESSAGE,
            DATABASE_MIGRATIONS_STARTED_MESSAGE,
        };
        match self {
            Self::Started { messages } => format!(
                "{DATABASE_MIGRATIONS_STARTED_MESSAGE} to fold the message search index \
                 ({messages} messages, once)"
            ),
            Self::Progress { done, messages } => format!(
                "{DATABASE_MIGRATION_PROGRESS_MESSAGE}: message search index, {done} of \
                 {messages} messages"
            ),
            Self::Finished => {
                format!("{DATABASE_MIGRATIONS_FINISHED_MESSAGE} (message search index folded)")
            }
        }
    }
}

/// Folds the search index again from the messages when it holds an older fold, in one
/// transaction, and marks it done. Reports only when there is a message to fold.
pub(crate) fn refold_message_search_once(
    conn: &Connection,
    report: &mut dyn FnMut(Refold),
) -> StoreResult<()> {
    let folded: i64 = conn
        .query_row(
            "SELECT COALESCE((SELECT value FROM meta WHERE key = 'message_search_folded'), 0)",
            [],
            |row| row.get(0),
        )
        .map_err(err)?;
    if folded >= MESSAGE_SEARCH_FOLD {
        return Ok(());
    }
    let messages: i64 = conn
        .query_row("SELECT COUNT(*) FROM message_keys", [], |row| row.get(0))
        .map_err(err)?;
    let messages = u64::try_from(messages).unwrap_or(0);
    if messages > 0 {
        report(Refold::Started { messages });
    }
    let tx = conn.unchecked_transaction().map_err(err)?;
    let mut reported = 0;
    refold_message_search(&tx, &mut |done| {
        if done / REFOLD_REPORT_EVERY > reported / REFOLD_REPORT_EVERY {
            reported = done;
            report(Refold::Progress { done, messages });
        }
    })?;
    tx.execute(
        "INSERT OR REPLACE INTO meta (key, value) VALUES ('message_search_folded', ?1)",
        [MESSAGE_SEARCH_FOLD],
    )
    .map_err(err)?;
    tx.commit().map_err(err)?;
    if messages > 0 {
        report(Refold::Finished);
    }
    Ok(())
}

/// The index rows after `?1` with their message texts, read in id order without a sort, so a
/// batch reads only the rows it holds.
const REFOLD_ROWS_SQL: &str = "SELECT k.id, s.text, COALESCE(json_extract(e.body, '$.text'), '')
     FROM message_keys k
     CROSS JOIN message_search s ON s.rowid = k.id
     CROSS JOIN entities e ON e.thread_id = k.thread_id
       AND e.kind = 'messages' AND e.id = k.message_id
     WHERE k.id > ?1 ORDER BY k.id";

/// Folds every `message_search` text again from its message's readable text, so an older
/// fold is rebuilt. It reads rows in id order while their texts fit [`REFOLD_BATCH_BYTES`] and the row
/// cap, so a store of large messages never holds more than the budget at once. `progress` hears
/// the messages read so far after each batch. A row whose message is gone keeps its text.
pub(crate) fn refold_message_search(
    conn: &Connection,
    progress: &mut dyn FnMut(u64),
) -> StoreResult<()> {
    let mut stmt = conn.prepare(REFOLD_ROWS_SQL).map_err(err)?;
    let mut after = i64::MIN;
    let mut done = 0;
    loop {
        let mut batch: Vec<(i64, String, String)> = Vec::new();
        let mut bytes = 0;
        {
            let mut rows = stmt.query([after]).map_err(err)?;
            while batch.len() < REFOLD_BATCH_ROWS
                && let Some(row) = rows.next().map_err(err)?
            {
                let row: (i64, String, String) = (
                    row.get(0).map_err(err)?,
                    row.get(1).map_err(err)?,
                    row.get(2).map_err(err)?,
                );
                let size = row.1.len() + row.2.len();
                // A row that would pass the budget is read again as the next batch's first.
                if !batch.is_empty() && bytes + size > REFOLD_BATCH_BYTES {
                    break;
                }
                bytes += size;
                batch.push(row);
                if bytes >= REFOLD_BATCH_BYTES {
                    break;
                }
            }
        }
        let Some(&(last, ..)) = batch.last() else {
            return Ok(());
        };
        done += batch.len() as u64;
        for (rowid, stored, text) in batch {
            let readable = readable_search_text(&text);
            let folded = crate::fold::fold(readable.as_deref().unwrap_or(&text));
            if folded != stored {
                conn.execute(
                    "UPDATE message_search SET text = ?2 WHERE rowid = ?1",
                    params![rowid, folded],
                )
                .map_err(err)?;
            }
        }
        progress(done);
        after = last;
    }
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
    Ok(())
}

/// The command a receipt is for, and what it answers for: a receipt replays only for its own
/// owner (T3's `aggregateKind` and `aggregateId`).
pub(crate) struct ReceiptKey<'a> {
    pub command_id: &'a str,
    pub command_type: &'a str,
    pub owner: ReceiptOwner<'a>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ReceiptOwner<'a> {
    Thread(&'a str),
    Project(&'a str),
}

impl<'a> ReceiptOwner<'a> {
    fn kind(self) -> &'static str {
        match self {
            Self::Thread(_) => "thread",
            Self::Project(_) => "project",
        }
    }

    fn id(self) -> Option<&'a str> {
        match self {
            Self::Thread(id) | Self::Project(id) => Some(id),
        }
    }
}

/// A command's recorded outcome. Receipts are kept for good, as T3 keeps them: a retry long
/// after, or after an undo, must not run the command again.
#[derive(Debug)]
pub(crate) struct Receipt {
    pub sequence: u64,
    /// `None` on a receipt from before receipts named an owner, when no event proves it.
    pub owner: Option<StoredOwner>,
    /// The refusal, for a refused command.
    pub refusal: Option<String>,
    pub command_type: String,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum StoredOwner {
    Thread(String),
    /// `None` on a project receipt from before receipts named their project.
    Project(Option<String>),
}

/// A command's receipt, read on any connection or write.
fn receipt_of(conn: &Connection, command_id: &str) -> StoreResult<Option<Receipt>> {
    conn.query_row(RECEIPT_SQL, [command_id], |row| {
        let kind: Option<String> = row.get(1)?;
        let id: Option<String> = row.get(2)?;
        Ok(Receipt {
            sequence: row.get::<_, i64>(0)? as u64,
            owner: match (kind.as_deref(), id) {
                (Some("thread"), Some(id)) => Some(StoredOwner::Thread(id)),
                (Some("project"), id) => Some(StoredOwner::Project(id)),
                _ => None,
            },
            refusal: row.get(3)?,
            command_type: row.get(4)?,
        })
    })
    .optional()
    .map_err(err)
}

/// Records a refusal under the command's id, unless the id already has a receipt.
fn refuse(conn: &Connection, key: &ReceiptKey<'_>, refusal: &str) -> StoreResult<()> {
    conn.execute(
        "INSERT OR IGNORE INTO receipts
           (command_id, command_type, sequence, owner_kind, owner_id, error)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            key.command_id,
            key.command_type,
            latest_sequence(conn, key.owner)? as i64,
            key.owner.kind(),
            key.owner.id(),
            refusal
        ],
    )
    .map(|_| ())
    .map_err(err)
}

/// The sequence a command that wrote nothing answers: its thread's latest event.
fn latest_sequence(conn: &Connection, owner: ReceiptOwner<'_>) -> StoreResult<u64> {
    let ReceiptOwner::Thread(thread_id) = owner else {
        return Ok(0);
    };
    conn.query_row(
        "SELECT COALESCE(MAX(seq), 0) FROM events WHERE thread_id = ?1",
        [thread_id],
        |row| row.get::<_, i64>(0),
    )
    .map(|seq| seq.max(0) as u64)
    .map_err(err)
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
    pub provider_instance: Instance,
}

/// The envelope's top-level `providerInstanceId`. T3 sets it on most events: on a run's events
/// the run's instance, which is the default here. Some flows name another instance, and some
/// leave it out (a runtime request answered by message, a closed link request, the remote
/// delegation rows); those drafts say so.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) enum Instance {
    /// The instance of the draft's run, if it names one.
    #[default]
    FromRun,
    Given(String),
    Absent,
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
            provider_instance: Instance::FromRun,
        }
    }

    /// The envelope names this instance, as T3 does for this flow; `None` leaves it out.
    pub(crate) fn provider_instance(mut self, id: Option<&str>) -> Self {
        self.provider_instance = id.map_or(Instance::Absent, |id| Instance::Given(id.to_owned()));
        self
    }

    /// The envelope names the instance a row carries (a thread, run, session, provider thread
    /// or subagent row).
    pub(crate) fn instance_of(self, row: &Value) -> Self {
        let id = row["providerInstanceId"].as_str().map(str::to_owned);
        self.provider_instance(id.as_deref())
    }

    /// The envelope names the instance of the row this event carries.
    pub(crate) fn payload_instance(self) -> Self {
        let id = self.payload["providerInstanceId"]
            .as_str()
            .map(str::to_owned);
        self.provider_instance(id.as_deref())
    }

    /// The envelope leaves the instance out, as T3 does for this flow.
    pub(crate) fn without_instance(mut self) -> Self {
        self.provider_instance = Instance::Absent;
        self
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

    /// T3's `getAgentReplayStats`: the first 129 events after the cursor, in sequence order,
    /// and their payload JSON bytes; later events are never read.
    #[test]
    fn replay_stats_read_at_most_129_events() {
        let dir =
            std::env::temp_dir().join(format!("conn-engine-{}-replay-stats", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let store = Store::open(&dir.join("engine.sqlite")).unwrap();
        let payload = json!({"n": "x".repeat(10)}).to_string();
        for seq in 1..=300_i64 {
            // Events past the bound are larger, so reading them would change the sum.
            let payload = if seq > 129 {
                json!({"n": "y".repeat(1000)}).to_string()
            } else {
                payload.clone()
            };
            store
                .conn
                .execute(
                    "INSERT INTO events (seq, thread_id, type, event) VALUES (?1, 't1', 'thread.visited', ?2)",
                    params![seq, format!(r#"{{"type":"thread.visited","payload":{payload}}}"#)],
                )
                .unwrap();
        }
        let stats = store.thread_replay_stats("t1", 0, 129).unwrap();
        assert_eq!(
            stats,
            ReplayStats {
                events: 129,
                payload_bytes: 129 * payload.len() as u64,
                has_create: false,
            }
        );
        let _ = std::fs::remove_dir_all(&dir);
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

    /// A receipt is reserved, never replaced: a commit whose id another command already holds
    /// fails and leaves that receipt as it was (T3's `insertIfAbsent`).
    #[test]
    fn a_receipt_is_never_replaced() {
        let dir =
            std::env::temp_dir().join(format!("conn-engine-{}-receipt-kept", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mut store = Store::open(&dir.join("engine.sqlite")).unwrap();
        let thread = ReceiptKey {
            command_id: "x",
            command_type: "thread.archive",
            owner: ReceiptOwner::Thread("t1"),
        };
        store
            .record_refusal(&thread, "Thread t1 does not exist.")
            .unwrap();
        let project = ReceiptKey {
            command_id: "x",
            command_type: "project.create",
            owner: ReceiptOwner::Project("project:p1"),
        };
        let tx = store.tx().unwrap();
        assert!(tx.commit(Some(&project)).is_err(), "the id is taken");
        let kept = store.outcome("x").unwrap().unwrap();
        assert_eq!(kept.owner, Some(StoredOwner::Thread("t1".into())));
        assert_eq!(kept.refusal.as_deref(), Some("Thread t1 does not exist."));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Opening reads the receipts' high-water mark through an index, not a scan.
    #[test]
    fn the_receipt_high_water_reads_an_index() {
        let dir =
            std::env::temp_dir().join(format!("conn-engine-{}-receipt-index", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let store = Store::open(&dir.join("engine.sqlite")).unwrap();
        let plan = store.query_plan("SELECT MAX(sequence) FROM receipts", []);
        assert!(
            plan.iter()
                .any(|step| step.contains("USING COVERING INDEX")),
            "{plan:?}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// T3's `ProjectionStore.ts`: a thread event's payload sets the thread's `updatedAt`; every
    /// other event sets it to the event's `occurredAt`, in the row and in the stored thread.
    #[test]
    fn each_event_type_sets_the_thread_updated_at_as_t3() {
        let dir =
            std::env::temp_dir().join(format!("conn-engine-{}-updated-at", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mut store = Store::open(&dir.join("engine.sqlite")).unwrap();
        let (old, decided) = ("2000-01-01T00:00:00.000Z", "2001-02-03T04:05:06.007Z");
        let thread = |id: &str, updated_at: &str| json!({"id": id, "projectId": "p", "title": "T", "updatedAt": updated_at});
        for (n, event_type) in conn_contract::DOMAIN_EVENT_TYPES.into_iter().enumerate() {
            let id = format!("t{n}");
            let mut tx = store.tx().unwrap();
            tx.append(Draft::new(&id, "thread.created", thread(&id, old)))
                .unwrap();
            tx.commit(None).unwrap();
            let mut tx = store.tx().unwrap();
            let now = tx.now().to_owned();
            let from_payload = conn_contract::PAYLOAD_UPDATED_AT_EVENTS.contains(&event_type);
            // A visit carries only the read mark; applied, the thread keeps its `updatedAt`.
            let visit = event_type == "thread.visit-recorded";
            let payload = if visit {
                json!({"lastVisitedAt": decided})
            } else if event_type.starts_with("thread.") {
                thread(&id, decided)
            } else {
                json!({"id": format!("e{n}"), "threadId": id, "text": "", "status": "done"})
            };
            tx.append(Draft::new(&id, event_type, payload)).unwrap();
            tx.commit(None).unwrap();
            let (activity_at, stored): (String, String) = store
                .conn
                .query_row(
                    "SELECT activity_at, thread FROM threads WHERE id = ?1",
                    [&id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .unwrap();
            let expected = match (visit, from_payload) {
                (true, _) => old,
                (false, true) => decided,
                (false, false) => now.as_str(),
            };
            assert_eq!(activity_at, expected, "{event_type}: the row");
            assert_eq!(
                parse(stored).unwrap()["updatedAt"],
                expected,
                "{event_type}: the stored thread"
            );
        }
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
            tx.commit(Some(&ReceiptKey {
                command_id: "c1",
                command_type: "test",
                owner: ReceiptOwner::Thread("t1"),
            }))
            .is_err(),
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
        let key = ReceiptKey {
            command_id: "c2",
            command_type: "test",
            owner: ReceiptOwner::Thread("t1"),
        };
        assert_eq!(tx.commit(Some(&key)).unwrap(), before + 1);
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
                r#"INSERT INTO threads (id, project_id, activity_at, thread) VALUES
                 ('t1', 'p1', '2026-01-01T00:00:00.000Z', '{"id":"t1","title":"Fox"}');
                 INSERT INTO entities (thread_id, kind, id, first_seq, seq, ordinal, body) VALUES
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
                     ALTER TABLE receipts DROP COLUMN owner_kind;
                     ALTER TABLE receipts DROP COLUMN owner_id;
                     ALTER TABLE receipts DROP COLUMN error;
                     PRAGMA user_version = 2;",
                )
                .unwrap();
        }
        let mut store = Store::open(&path).unwrap();
        let version: i64 = store
            .conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, 5);
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

    #[test]
    fn migration_backfills_subagent_count_on_stored_shells() {
        let dir = std::env::temp_dir().join(format!(
            "conn-engine-{}-migrate-subagent-count",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("engine.sqlite");
        {
            let mut store = Store::open(&path).unwrap();
            let mut tx = store.tx().unwrap();
            tx.append(Draft::new(
                "parent",
                "thread.created",
                json!({"projectId": "p1", "title": "Parent"}),
            ))
            .unwrap();
            tx.append(Draft::new(
                "solo",
                "thread.created",
                json!({"projectId": "p1", "title": "Solo"}),
            ))
            .unwrap();
            for id in ["sa-1", "sa-2"] {
                tx.append(Draft::new(
                    "parent",
                    "subagent.updated",
                    json!({"id": id, "status": "completed"}),
                ))
                .unwrap();
            }
            tx.commit(None).unwrap();
            // Simulate a v3 database written before `subagentCount` existed on stored shells.
            store
                .conn
                .execute_batch(
                    "UPDATE threads SET shell = json_remove(shell, '$.subagentCount') WHERE id = 'parent';
                     ALTER TABLE receipts DROP COLUMN owner_kind;
                     ALTER TABLE receipts DROP COLUMN owner_id;
                     ALTER TABLE receipts DROP COLUMN error;
                     PRAGMA user_version = 3;",
                )
                .unwrap();
        }
        let store = Store::open(&path).unwrap();
        let version: i64 = store
            .conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, 5);
        let shell = store.shell_snapshot().unwrap();
        let threads = shell["threads"].as_array().unwrap();
        let parent = threads.iter().find(|t| t["id"] == "parent").unwrap();
        let solo = threads.iter().find(|t| t["id"] == "solo").unwrap();
        assert_eq!(parent["subagentCount"], json!(2));
        assert!(solo.get("subagentCount").is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A refold of a large index runs inside the engine's open, before the server listens, so
    /// it tells the desktop with T3's migration lines (`databaseMigrationLog.ts`): started, a
    /// progress line every 10,000 messages, finished. It folds from the message text and runs
    /// once.
    #[test]
    fn a_refold_reports_its_start_progress_and_end_once() {
        let dir = std::env::temp_dir().join(format!(
            "conn-engine-{}-refold-progress",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let store = Store::open(&dir.join("engine.sqlite")).unwrap();
        store
            .conn
            .execute_batch(
                "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10001)
                 INSERT INTO entities (thread_id, kind, id, first_seq, seq, ordinal, body)
                   SELECT 't1', 'messages', 'm' || i, i, i, NULL,
                          json_object('id', 'm' || i, 'text', 'École ' || i) FROM n;
                 INSERT INTO message_keys (thread_id, message_id)
                   SELECT thread_id, id FROM entities WHERE kind = 'messages';
                 INSERT INTO message_search (rowid, text) SELECT id, 'ecole' FROM message_keys;
                 UPDATE meta SET value = 2 WHERE key = 'message_search_folded';",
            )
            .unwrap();
        let mut events = vec![];
        refold_message_search_once(&store.conn, &mut |event| events.push(event)).unwrap();
        assert_eq!(
            events,
            [
                Refold::Started { messages: 10_001 },
                Refold::Progress {
                    done: 10_000,
                    messages: 10_001
                },
                Refold::Finished,
            ]
        );
        let text: String = store
            .conn
            .query_row(
                "SELECT text FROM message_search
                 WHERE rowid = (SELECT id FROM message_keys WHERE message_id = 'm10001')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(text, "ecole 10001", "folded again from the message");
        let lines: Vec<String> = events.iter().map(|event| event.line()).collect();
        assert!(
            lines[0].starts_with("Running database migrations"),
            "{lines:?}"
        );
        assert!(lines[1].starts_with("Upgrading database"), "{lines:?}");
        assert!(
            lines[2].starts_with("Migrations ran successfully"),
            "{lines:?}"
        );

        events.clear();
        refold_message_search_once(&store.conn, &mut |event| events.push(event)).unwrap();
        assert_eq!(events, [], "the mark holds");
        drop(store);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A refold reads its rows a byte budget at a time, so a store of large messages never
    /// holds more than the budget: a row that would pass it starts the next batch, and a row
    /// larger than the budget is folded alone.
    #[test]
    fn a_refold_batch_stays_within_its_byte_budget() {
        const MIB: usize = 1 << 20;
        // Message text in MiB per row; each index row adds its one-byte stale fold.
        const SIZES: [usize; 8] = [3, 2, 5, 1, 1, 1, 1, 1];
        let dir =
            std::env::temp_dir().join(format!("conn-engine-{}-refold-budget", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let store = Store::open(&dir.join("engine.sqlite")).unwrap();
        for (i, mib) in SIZES.iter().enumerate() {
            store
                .conn
                .execute(
                    "INSERT INTO entities (thread_id, kind, id, first_seq, seq, ordinal, body)
                     VALUES ('t1', 'messages', ?1, ?2, ?2, NULL, json_object('id', ?1,
                       'text', replace(printf('%.*c', ?3, 'x'), 'x', 'É')))",
                    params![format!("m{i}"), i as i64 + 1, (mib * MIB / 2) as i64],
                )
                .unwrap();
        }
        store
            .conn
            .execute_batch(
                "INSERT INTO message_keys (thread_id, message_id)
                   SELECT thread_id, id FROM entities WHERE kind = 'messages' ORDER BY seq;
                 INSERT INTO message_search (rowid, text) SELECT id, 'x' FROM message_keys;",
            )
            .unwrap();
        let mut batches: Vec<usize> = vec![];
        let mut read = 0;
        refold_message_search(&store.conn, &mut |done| {
            let rows = SIZES.get(read as usize..done as usize).unwrap_or_default();
            batches.push(rows.iter().map(|mib| mib * MIB + 1).sum());
            read = done;
        })
        .unwrap();
        assert_eq!(read, SIZES.len() as u64);
        assert_eq!(
            batches,
            [
                3 * MIB + 1,
                2 * MIB + 1,
                5 * MIB + 1,
                3 * MIB + 3,
                2 * MIB + 2
            ],
            "bytes per batch, budget {REFOLD_BATCH_BYTES}"
        );
        let plan = store.query_plan(REFOLD_ROWS_SQL, [0]);
        assert!(
            !plan.iter().any(|step| step.contains("TEMP B-TREE")),
            "{plan:?}"
        );
        let folded: String = store
            .conn
            .query_row(
                "SELECT text FROM message_search ORDER BY rowid LIMIT 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(folded, "e".repeat(SIZES[0] * MIB / 2));
        drop(store);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
