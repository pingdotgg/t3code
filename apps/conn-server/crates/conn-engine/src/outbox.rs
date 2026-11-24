//! The effect outbox (T3's `EffectOutbox.ts`, the `orchestration_v2_effect_outbox` table).
//!
//! A command's effects are rows written in the transaction that commits the command, so work
//! the store holds never depends on the caller that asked for it. A worker claims the rows
//! later and runs them (`EffectWorker.ts`).
//!
//! Rows of one thread run one at a time, in commit order, in their lane. T3 keeps title
//! generation apart from the thread's other work (`claimableCandidatePredicate`); so does
//! [`Lane::Title`]. [`Lane::Free`] is ours: a Stop's `AbandonStart` must reach the provider while
//! the start it abandons still runs, where T3 signals the running effect's cancellation instead,
//! and `RemoteTaskChanged` only wakes a follower.
//!
//! What a server process left `pending` or `running` when it stopped is reconciled at the next
//! start (`reconcileAfterProcessLoss`): see [`PROCESS_BOUND`].
//!
//! A rollback keeps its phase in its row's `progress` (`rollback.rs`): T3 has no such journal;
//! it lets a restart tell whether the provider was asked to roll back.

use rusqlite::{Connection, params};
use serde_json::{Value, json};

use crate::commands::Effect;
use crate::store::{Lease, NOT_OWNER, Store, StoreResult, Tx, lease_guard, owns};

/// The outbox table. `progress` is what a running effect recorded so a later process can go on
/// from there (a rollback's phase and the provider's answer).
pub(crate) const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS effect_outbox (
  id            INTEGER PRIMARY KEY,
  command_id    TEXT,
  thread_id     TEXT NOT NULL,
  lane          TEXT NOT NULL,
  effect_type   TEXT NOT NULL,
  payload       TEXT NOT NULL,
  status        TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  progress      TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  completed_at  TEXT,
  last_error    TEXT
);
-- The claim: pending rows in commit order, and what holds each thread's lane.
CREATE INDEX IF NOT EXISTS effect_outbox_pending ON effect_outbox(id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS effect_outbox_unsettled ON effect_outbox(thread_id, lane, id)
WHERE status IN ('pending', 'running');
-- Retention.
CREATE INDEX IF NOT EXISTS effect_outbox_settled ON effect_outbox(completed_at)
WHERE status IN ('succeeded', 'cancelled');
-- The settlements whose settle script started. A settle close a restart runs again finds its
-- row and starts no second script.
CREATE TABLE IF NOT EXISTS settle_scripts (
  thread_id  TEXT NOT NULL,
  settled_at TEXT NOT NULL,
  PRIMARY KEY (thread_id, settled_at)
);
";

/// `SETTLED_EFFECT_RETENTION`: settled rows are kept 7 days. Failed rows stay, as in T3.
pub(crate) const SETTLED_RETENTION_MS: u64 = 7 * 24 * 60 * 60 * 1000;
/// `PRUNE_BATCH_SIZE`: each delete is its own statement, and the worker lets the store go
/// between batches.
pub(crate) const PRUNE_BATCH: usize = 500;

/// Which rows of a thread wait for each other.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Lane {
    /// Every effect that changes the provider or the thread: one at a time, in commit order.
    Thread,
    /// Title generation, beside the thread's other work and one at a time.
    Title,
    /// Runs as soon as it is claimed.
    Free,
}

impl Lane {
    fn as_str(self) -> &'static str {
        match self {
            Self::Thread => "thread",
            Self::Title => "title",
            Self::Free => "free",
        }
    }
}

/// `PROCESS_BOUND_EFFECT_TYPES`: effects that act on a provider session of the process that
/// made them. After a process loss they are cancelled, and the restart decides again from the
/// stored runs (`restart.rs`). Every other effect is replay-safe and runs again
/// (`REPLAY_SAFE_EFFECT_TYPES_AFTER_PROCESS_LOSS`).
pub(crate) const PROCESS_BOUND: [&str; 7] = [
    "provider-turn.start",
    "provider-turn.steer",
    "provider-turn.interrupt",
    "provider-turn.abandon-start",
    "provider-turn.stop-background-work",
    "runtime-request.respond",
    "provider-session.apply-model-selection",
];

impl Effect {
    /// The row's `effect_type`: T3's name where T3 has the effect.
    pub(crate) fn effect_type(&self) -> &'static str {
        match self {
            Self::Rollback(_) => "provider-thread.rollback",
            Self::CaptureCheckpoint { .. } => "checkpoint.capture",
            Self::StartTurn { .. } => "provider-turn.start",
            Self::Steer { .. } => "provider-turn.steer",
            Self::Interrupt { .. } => "provider-turn.interrupt",
            Self::AbandonStart { .. } => "provider-turn.abandon-start",
            Self::StopBackgroundWork { .. } => "provider-turn.stop-background-work",
            Self::Respond { .. } => "runtime-request.respond",
            Self::CloseSession { .. } => "provider-session.detach",
            Self::CloseThreadSessions { .. } => "provider-session.detach-thread",
            Self::ApplyModelSelection { .. } => "provider-session.apply-model-selection",
            Self::CleanupHtmlAttachments { .. } => "attachment.cleanup",
            Self::RemoteTaskChanged { .. } => "delegated-task.remote-changed",
            Self::ThreadClosed { .. } => "thread.closed",
            Self::GenerateTitle { .. } => "thread-title.generate",
        }
    }

    pub(crate) fn thread_id(&self) -> &str {
        match self {
            Self::Rollback(request) => &request.thread_id,
            Self::CaptureCheckpoint { thread_id, .. }
            | Self::StartTurn { thread_id, .. }
            | Self::Steer { thread_id, .. }
            | Self::Interrupt { thread_id, .. }
            | Self::AbandonStart { thread_id, .. }
            | Self::StopBackgroundWork { thread_id, .. }
            | Self::Respond { thread_id, .. }
            | Self::CloseSession { thread_id }
            | Self::CloseThreadSessions { thread_id }
            | Self::ApplyModelSelection { thread_id, .. }
            | Self::CleanupHtmlAttachments { thread_id, .. }
            | Self::RemoteTaskChanged { thread_id, .. }
            | Self::ThreadClosed { thread_id, .. }
            | Self::GenerateTitle { thread_id, .. } => thread_id,
        }
    }

    pub(crate) fn outbox_lane(&self) -> Lane {
        match self {
            Self::GenerateTitle { .. } => Lane::Title,
            Self::AbandonStart { .. } | Self::RemoteTaskChanged { .. } => Lane::Free,
            _ => Lane::Thread,
        }
    }
}

/// A row the worker claimed: it is `running` until [`Store::settle_effect`].
#[derive(Debug)]
pub(crate) struct Claimed {
    pub(crate) id: i64,
    pub(crate) effect: Effect,
    /// What the effect recorded before a previous process stopped (`progress`).
    pub(crate) progress: Option<Value>,
}

/// A rollback row a previous process left unsettled, with the phase it recorded.
#[derive(Debug, PartialEq)]
pub(crate) struct UnsettledRollback {
    pub(crate) command_id: String,
    pub(crate) thread_id: String,
    /// `admitted` when the row recorded none.
    pub(crate) phase: String,
    pub(crate) snapshot: Option<Value>,
}

/// How an effect ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Settled {
    Succeeded,
    Failed,
}

impl Settled {
    fn as_str(self) -> &'static str {
        match self {
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
        }
    }
}

fn err(e: rusqlite::Error) -> String {
    format!("store: {e}")
}

/// `EffectOutbox.enqueue`: writes the rows in `conn`'s open transaction. The commit wakes the
/// worker ([`Tx::enqueue`]).
pub(crate) fn insert(
    conn: &Connection,
    now: &str,
    command_id: Option<&str>,
    effects: &[Effect],
) -> StoreResult<()> {
    let mut stmt = conn
        .prepare_cached(
            "INSERT INTO effect_outbox
               (command_id, thread_id, lane, effect_type, payload, status, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6, ?6)",
        )
        .map_err(err)?;
    for effect in effects {
        let payload = serde_json::to_string(effect)
            .map_err(|e| format!("store: an effect does not serialize: {e}"))?;
        stmt.execute(params![
            command_id,
            effect.thread_id(),
            effect.outbox_lane().as_str(),
            effect.effect_type(),
            payload,
            now,
        ])
        .map_err(err)?;
    }
    Ok(())
}

/// Pending rows that may run now: the oldest of their thread's lane, with nothing of that lane
/// running (`claimableCandidatePredicate`). A free row may always run.
const CLAIMABLE: &str = "
SELECT candidate.id FROM effect_outbox AS candidate
WHERE candidate.status = 'pending'
  AND (candidate.lane = 'free' OR NOT EXISTS (
    SELECT 1 FROM effect_outbox AS active
    WHERE active.thread_id = candidate.thread_id
      AND active.lane = candidate.lane
      AND active.status IN ('pending', 'running')
      AND (active.status = 'running' OR active.id < candidate.id)))
ORDER BY candidate.id
LIMIT ?1";

/// The unsettled row of rollback `?2` on thread `?1`. Rows match on the payload's command id:
/// a rollback the previous build enqueued again at start has no outer `command_id`.
const ROLLBACK_ROW: &str = "thread_id = ?1 AND effect_type = 'provider-thread.rollback'
  AND status IN ('pending', 'running') AND json_extract(payload, '$.commandId') = ?2";

impl Tx<'_> {
    /// Whether the run's `provider-turn.start` returned: `Some(true)` when one of its start rows
    /// settled after running, `Some(false)` when it has rows and none did (a start the previous
    /// process was running is cancelled at start), `None` when it has none (an older store).
    pub(crate) fn start_settled(&self, run_id: &str) -> StoreResult<Option<bool>> {
        self.sql()
            .query_row(
                "SELECT COUNT(*), COALESCE(SUM(status IN ('succeeded', 'failed')), 0)
                 FROM effect_outbox
                 WHERE effect_type = 'provider-turn.start'
                   AND json_extract(payload, '$.runId') = ?1",
                [run_id],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
            )
            .map(|(rows, settled)| (rows > 0).then_some(settled > 0))
            .map_err(err)
    }

    /// Settles a rollback's row as `outcome`, with `error`, in the write that records its
    /// result, so a restart after that commit never runs it again and a failure stays on
    /// record (pruning takes only succeeded rows). Only this write settles a rollback row: the
    /// worker leaves it alone (`effect_worker.rs`).
    pub(crate) fn settle_rollback(
        &self,
        thread_id: &str,
        command_id: &str,
        outcome: Settled,
        error: Option<&str>,
    ) -> StoreResult<()> {
        self.sql()
            .execute(
                &format!(
                    "UPDATE effect_outbox SET status = ?3, completed_at = ?4, updated_at = ?4,
                       last_error = ?5
                     WHERE {ROLLBACK_ROW}"
                ),
                params![thread_id, command_id, outcome.as_str(), self.now(), error],
            )
            .map(drop)
            .map_err(err)
    }

    /// How many rows of `command_id` a worker claimed: a restart's resends of one prompt.
    pub(crate) fn resends(&self, command_id: &str) -> StoreResult<usize> {
        self.sql()
            .query_row(
                "SELECT COUNT(*) FROM effect_outbox WHERE command_id = ?1 AND attempt_count > 0",
                [command_id],
                |row| row.get::<_, i64>(0),
            )
            .map(|n| n.max(0) as usize)
            .map_err(err)
    }

    /// The run's end (the parent's wake) is written already: its capture row says so in
    /// `progress`, which a replay of that row keeps. A run with no capture row had its end
    /// written by `end_run`.
    pub(crate) fn run_end_recorded(&self, run_id: &str) -> StoreResult<bool> {
        self.sql()
            .query_row(
                "SELECT NOT EXISTS(SELECT 1 FROM effect_outbox
                   WHERE effect_type = 'checkpoint.capture'
                     AND json_extract(payload, '$.runId') = ?1)
                 OR EXISTS(SELECT 1 FROM effect_outbox
                   WHERE effect_type = 'checkpoint.capture'
                     AND json_extract(payload, '$.runId') = ?1
                     AND json_extract(progress, '$.runEnded') = 1)",
                [run_id],
                |row| row.get(0),
            )
            .map_err(err)
    }

    /// Marks the run's capture row: its end is written, in this transaction.
    pub(crate) fn record_run_end(&self, run_id: &str) -> StoreResult<()> {
        self.sql()
            .execute(
                "UPDATE effect_outbox
                 SET progress = json_set(COALESCE(progress, '{}'), '$.runEnded', json('true'))
                 WHERE effect_type = 'checkpoint.capture'
                   AND json_extract(payload, '$.runId') = ?1
                   AND status IN ('pending', 'running')",
                [run_id],
            )
            .map(drop)
            .map_err(err)
    }

    /// An unsettled `checkpoint.capture` row for this run: the restart leaves the capture to it.
    pub(crate) fn capture_queued(&self, run_id: &str) -> StoreResult<bool> {
        self.sql()
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM effect_outbox
                 WHERE effect_type = 'checkpoint.capture' AND status IN ('pending', 'running')
                   AND json_extract(payload, '$.runId') = ?1)",
                [run_id],
                |row| row.get(0),
            )
            .map_err(err)
    }

    /// Writes `effects` to the outbox in this transaction. The worker hears of them once it
    /// commits; a rolled back write leaves nothing.
    pub(crate) fn enqueue(
        &mut self,
        command_id: Option<&str>,
        effects: &[Effect],
    ) -> StoreResult<()> {
        if effects.is_empty() {
            return Ok(());
        }
        insert(self.sql(), self.now(), command_id, effects)?;
        self.mark_effects_written();
        Ok(())
    }
}

impl Store {
    fn now_iso(&self) -> String {
        conn_support::time::iso_from_ms(self.now_millis())
    }

    /// `EffectOutbox.claimNext`, for up to `limit` rows at once: each becomes `running`, in
    /// one statement, so no row is claimed twice. A row this build cannot read fails, and the
    /// next row of its thread may run.
    ///
    /// Ownership is checked while the write lock is held: a dropped or replaced engine claims
    /// nothing, so it cannot take a row that a newer engine on the same store committed.
    pub(crate) fn claim_effects(&self, limit: usize) -> StoreResult<Vec<Claimed>> {
        let conn = self.raw();
        conn.execute_batch("BEGIN IMMEDIATE").map_err(err)?;
        let claimed = match owns(conn, self.owner()) {
            Ok(true) => self.claim_rows(limit),
            Ok(false) => Ok(vec![]),
            Err(e) => Err(e),
        };
        let end = if claimed.is_ok() {
            "COMMIT"
        } else {
            "ROLLBACK"
        };
        conn.execute_batch(end).map_err(err)?;
        claimed
    }

    fn claim_rows(&self, limit: usize) -> StoreResult<Vec<Claimed>> {
        let now = self.now_iso();
        let conn = self.raw();
        loop {
            let mut stmt = conn
                .prepare_cached(&format!(
                    "UPDATE effect_outbox
                     SET status = 'running', attempt_count = attempt_count + 1,
                         updated_at = ?2, last_error = NULL
                     WHERE id IN ({CLAIMABLE})
                     RETURNING id, effect_type, payload, progress"
                ))
                .map_err(err)?;
            let rows = stmt
                .query_map(params![limit as i64, now], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<String>>(3)?,
                    ))
                })
                .map_err(err)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(err)?;
            let mut claimed = vec![];
            let mut unreadable = false;
            for (id, effect_type, payload, progress) in rows {
                match serde_json::from_str::<Effect>(&payload) {
                    Ok(effect) => claimed.push(Claimed {
                        id,
                        effect,
                        progress: progress.and_then(|p| serde_json::from_str(&p).ok()),
                    }),
                    Err(e) => {
                        eprintln!("conn-engine: failing effect {id} ({effect_type}): {e}");
                        self.settle_effect(
                            id,
                            Settled::Failed,
                            Some(&format!(
                                "This server build cannot decode the {effect_type} effect."
                            )),
                        )?;
                        unreadable = true;
                    }
                }
            }
            claimed.sort_by_key(|c| c.id);
            // A failed row frees its lane: claim again, as T3's claim loop does.
            if claimed.is_empty() && unreadable {
                continue;
            }
            return Ok(claimed);
        }
    }

    /// `succeed` / `fail` / a cancel: settles a running row. `false` when the row is not
    /// running (already settled) or this engine no longer owns the store.
    pub(crate) fn settle_effect(
        &self,
        id: i64,
        status: Settled,
        error: Option<&str>,
    ) -> StoreResult<bool> {
        self.try_settle_effect(id, status, error).map_err(err)
    }

    /// [`Self::settle_effect`] with SQLite's own error, so the worker can tell a busy store
    /// from a failed write.
    pub(crate) fn try_settle_effect(
        &self,
        id: i64,
        status: Settled,
        error: Option<&str>,
    ) -> rusqlite::Result<bool> {
        #[cfg(test)]
        if self.settle_faults.get() > 0 {
            self.settle_faults.set(self.settle_faults.get() - 1);
            return Err(rusqlite::Error::SqliteFailure(
                rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_IOERR),
                Some("injected settlement fault".into()),
            ));
        }
        let lease = self.lease();
        if matches!(lease, Lease::Released) {
            return Ok(false);
        }
        let now = self.now_iso();
        let changed = self.raw().execute(
            &format!(
                "UPDATE effect_outbox
                 SET status = ?2, completed_at = ?3, updated_at = ?3, last_error = ?4
                 WHERE id = ?1 AND status = 'running' AND {}",
                lease_guard(5)
            ),
            params![id, status.as_str(), now, error, lease.guard()],
        )?;
        Ok(changed == 1)
    }

    /// One batch of `pruneSettled`: deletes up to [`PRUNE_BATCH`] succeeded and cancelled rows
    /// that settled more than [`SETTLED_RETENTION_MS`] ago. Returns how many went; the worker
    /// calls again while a batch is full, and lets the store go in between.
    pub(crate) fn prune_settled_batch(&self) -> StoreResult<usize> {
        if !owns(self.raw(), self.owner())? {
            return Ok(0);
        }
        let cutoff =
            conn_support::time::iso_from_ms(self.now_millis().saturating_sub(SETTLED_RETENTION_MS));
        self.raw()
            .execute(
                "DELETE FROM effect_outbox WHERE id IN (
                   SELECT id FROM effect_outbox
                   WHERE status IN ('succeeded', 'cancelled') AND completed_at < ?1
                   LIMIT ?2)",
                params![cutoff, PRUNE_BATCH as i64],
            )
            .map_err(err)
    }

    /// `reconcileAfterProcessLoss`, at start, before anything is claimed. A process-bound
    /// row the previous process left unsettled is cancelled; a replay-safe row it was running
    /// becomes pending again and runs once more. With `replay` off (an inert copy, no
    /// recovery) every unsettled row is cancelled. Returns `(requeued, cancelled)`.
    ///
    /// The ownership check and the writes are one transaction: an engine whose open a newer
    /// one overtook gets [`NOT_OWNER`] and must not go on, or it would cancel the newer
    /// engine's rows.
    pub(crate) fn reconcile_after_process_loss(&self, replay: bool) -> StoreResult<(usize, usize)> {
        let now = self.now_iso();
        let bound = if replay {
            format!(
                "effect_type IN ({})",
                PROCESS_BOUND
                    .iter()
                    .map(|t| format!("'{t}'"))
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        } else {
            "1 = 1".to_owned()
        };
        let tx = rusqlite::Transaction::new_unchecked(
            self.raw(),
            rusqlite::TransactionBehavior::Immediate,
        )
        .map_err(err)?;
        if !owns(&tx, self.owner())? {
            return Err(NOT_OWNER.into());
        }
        // Only the owner migrates, inside its own write: a stale opener leaves the journal.
        self.migrate_pending_rollbacks(&tx)?;
        let cancelled = tx
            .execute(
                &format!(
                    "UPDATE effect_outbox
                     SET status = 'cancelled', completed_at = ?1, updated_at = ?1,
                         last_error = 'Cancelled because the server process ended before the effect completed.'
                     WHERE status IN ('pending', 'running') AND {bound}"
                ),
                [&now],
            )
            .map_err(err)?;
        let requeued = tx
            .execute(
                "UPDATE effect_outbox
                 SET status = 'pending', updated_at = ?1,
                     last_error = 'Requeued after the previous server process ended.'
                 WHERE status = 'running'",
                [&now],
            )
            .map_err(err)?;
        tx.commit().map_err(err)?;
        Ok((requeued, cancelled))
    }

    /// Moves the rollbacks an older build kept in `pending_rollbacks` into the outbox, then
    /// drops that table, in `tx`: the start's write, after it checked ownership. That build may
    /// have left rows of its own, so each
    /// journal entry is reconciled with them, matched on the payload's command id:
    /// - an unsettled row takes the entry's phase, and no second row is written;
    /// - an entry with no unsettled row becomes a row the previous process was running;
    /// - an unsettled row with no entry committed its result already (the result cleared the
    ///   entry), so it settles and never runs again.
    fn migrate_pending_rollbacks(&self, tx: &Connection) -> StoreResult<()> {
        let exists: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pending_rollbacks')",
                [],
                |row| row.get(0),
            )
            .map_err(err)?;
        if !exists {
            return Ok(());
        }
        let now = self.now_iso();
        tx.execute_batch(
            "CREATE TEMP VIEW legacy_rollback_rows AS
               SELECT id, json_extract(payload, '$.commandId') AS rollback_id FROM effect_outbox
               WHERE effect_type = 'provider-thread.rollback' AND status IN ('pending', 'running');",
        )
        .map_err(err)?;
        tx.execute(
            "INSERT INTO effect_outbox (command_id, thread_id, lane, effect_type, payload, status,
               progress, created_at, updated_at)
             SELECT command_id, thread_id, 'thread', 'provider-thread.rollback',
               json_object('type', 'provider-thread.rollback', 'threadId', thread_id,
                 'commandId', command_id,
                 'providerThreadId', json_extract(request, '$.providerThreadId'),
                 'checkpointId', json_extract(request, '$.checkpointId'),
                 'scopeId', json_extract(request, '$.scopeId'),
                 'restoreFiles', json(request -> '$.restoreFiles')),
               'running',
               CASE WHEN phase = 'admitted' THEN NULL
                    ELSE json_object('phase', phase, 'snapshot', json(snapshot)) END,
               ?1, ?1
             FROM pending_rollbacks AS journal
             WHERE NOT EXISTS (SELECT 1 FROM legacy_rollback_rows
                               WHERE rollback_id = journal.command_id)
             ORDER BY rowid",
            [&now],
        )
        .map_err(err)?;
        tx.execute(
            "UPDATE effect_outbox SET updated_at = ?1,
               progress = (SELECT CASE WHEN phase = 'admitted' THEN NULL
                                  ELSE json_object('phase', phase, 'snapshot', json(snapshot)) END
                           FROM pending_rollbacks
                           WHERE command_id = json_extract(effect_outbox.payload, '$.commandId'))
             WHERE id IN (SELECT id FROM legacy_rollback_rows
                          WHERE rollback_id IN (SELECT command_id FROM pending_rollbacks))",
            [&now],
        )
        .map_err(err)?;
        tx.execute(
            "UPDATE effect_outbox
             SET status = 'succeeded', completed_at = ?1, updated_at = ?1,
                 last_error = 'Its result was committed before the upgrade.'
             WHERE id IN (SELECT id FROM legacy_rollback_rows
                          WHERE rollback_id NOT IN (SELECT command_id FROM pending_rollbacks))",
            [&now],
        )
        .map_err(err)?;
        tx.execute_batch("DROP VIEW legacy_rollback_rows; DROP TABLE pending_rollbacks;")
            .map_err(err)
    }

    /// Moves a rollback's row from phase `from` to `to` (`provider` once the provider rollback
    /// is sent, `provider_done` with the provider's answer once it is back), in one write that
    /// also checks the engine's lease. A row with no phase is `admitted`. `false` when nothing
    /// moved: another engine owns the store, or the row is not in `from`. A caller then must
    /// not contact the provider.
    pub(crate) fn advance_rollback(
        &self,
        thread_id: &str,
        command_id: &str,
        from: &str,
        to: &str,
        snapshot: Option<&Value>,
    ) -> StoreResult<bool> {
        let lease = self.lease();
        if matches!(lease, Lease::Released) {
            return Ok(false);
        }
        let progress = json!({"phase": to, "snapshot": snapshot});
        self.raw()
            .execute(
                &format!(
                    "UPDATE effect_outbox SET progress = ?3
                     WHERE {ROLLBACK_ROW}
                       AND COALESCE(json_extract(progress, '$.phase'), 'admitted') = ?5
                       AND {}",
                    lease_guard(4)
                ),
                params![
                    thread_id,
                    command_id,
                    progress.to_string(),
                    lease.guard(),
                    from
                ],
            )
            .map(|changed| changed == 1)
            .map_err(err)
    }

    /// Unsettled rollbacks with the phase each recorded, in commit order.
    pub(crate) fn unsettled_rollbacks(&self) -> StoreResult<Vec<UnsettledRollback>> {
        let mut stmt = self
            .raw()
            .prepare(
                "SELECT json_extract(payload, '$.commandId'), thread_id, progress FROM effect_outbox
                 WHERE effect_type = 'provider-thread.rollback' AND status IN ('pending', 'running')
                 ORDER BY id",
            )
            .map_err(err)?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            })
            .map_err(err)?;
        let mut out = vec![];
        for row in rows {
            let (command_id, thread_id, progress) = row.map_err(err)?;
            let progress: Value = progress
                .and_then(|p| serde_json::from_str(&p).ok())
                .unwrap_or(Value::Null);
            let phase = progress["phase"].as_str().unwrap_or("admitted").to_owned();
            let snapshot = Some(progress["snapshot"].clone()).filter(|s| !s.is_null());
            out.push(UnsettledRollback {
                command_id: command_id.unwrap_or_default(),
                thread_id,
                phase,
                snapshot,
            });
        }
        Ok(out)
    }

    /// Records that the settle script of `thread_id`'s settlement `settled_at` starts: `true`
    /// the first time, `false` when this or an earlier process recorded it already.
    pub(crate) fn claim_settle_script(
        &self,
        thread_id: &str,
        settled_at: &str,
    ) -> StoreResult<bool> {
        let tx = rusqlite::Transaction::new_unchecked(
            self.raw(),
            rusqlite::TransactionBehavior::Immediate,
        )
        .map_err(err)?;
        if !owns(&tx, self.owner())? {
            return Err(NOT_OWNER.into());
        }
        let taken = tx
            .execute(
                "INSERT INTO settle_scripts (thread_id, settled_at) VALUES (?1, ?2)
                 ON CONFLICT DO NOTHING",
                params![thread_id, settled_at],
            )
            .map_err(err)?
            == 1;
        tx.commit().map_err(err)?;
        Ok(taken)
    }

    /// The status of an outbox row.
    #[cfg(test)]
    pub(crate) fn effect_status(&self, id: i64) -> StoreResult<Option<String>> {
        self.raw()
            .query_row(
                "SELECT status FROM effect_outbox WHERE id = ?1",
                [id],
                |row| row.get(0),
            )
            .map(Some)
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                e => Err(err(e)),
            })
    }
}

#[cfg(test)]
mod tests;
