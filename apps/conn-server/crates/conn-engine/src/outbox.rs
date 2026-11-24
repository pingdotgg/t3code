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
//! What a server process left `pending` or `running` when it stopped is cancelled at the next
//! start ([`Store::cancel_unsettled_effects`]); the restart decides again from the stored runs.

use rusqlite::{Connection, params};

use crate::commands::Effect;
use crate::store::{NOT_OWNER, Store, StoreResult, Tx, owns};

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

impl Tx<'_> {
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
                     RETURNING id, effect_type, payload"
                ))
                .map_err(err)?;
            let rows = stmt
                .query_map(params![limit as i64, now], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })
                .map_err(err)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(err)?;
            let mut claimed = vec![];
            let mut unreadable = false;
            for (id, effect_type, payload) in rows {
                match serde_json::from_str::<Effect>(&payload) {
                    Ok(effect) => claimed.push(Claimed { id, effect }),
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
        let epoch = match self.owner() {
            None => None,
            Some(owner) => match owner.epoch() {
                Some(epoch) => Some(epoch),
                None => return Ok(false),
            },
        };
        let now = self.now_iso();
        let changed = self.raw().execute(
            "UPDATE effect_outbox
             SET status = ?2, completed_at = ?3, updated_at = ?3, last_error = ?4
             WHERE id = ?1 AND status = 'running'
               AND (?5 IS NULL
                    OR ?5 = (SELECT value FROM meta WHERE key = 'engine_epoch'))",
            params![id, status.as_str(), now, error, epoch],
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

    /// Cancels what a previous process left `pending` or `running`, at start, before anything
    /// is claimed. Returns how many rows it cancelled. The ownership check and the cancel are
    /// one transaction: an engine whose open a newer one overtook gets [`NOT_OWNER`] and must
    /// not go on, or it would cancel the newer engine's rows.
    pub(crate) fn cancel_unsettled_effects(&self) -> StoreResult<usize> {
        let now = self.now_iso();
        let tx = rusqlite::Transaction::new_unchecked(
            self.raw(),
            rusqlite::TransactionBehavior::Immediate,
        )
        .map_err(err)?;
        if !owns(&tx, self.owner())? {
            return Err(NOT_OWNER.into());
        }
        let cancelled = tx
            .execute(
                "UPDATE effect_outbox
                 SET status = 'cancelled', completed_at = ?1, updated_at = ?1,
                     last_error = 'Cancelled because the server process ended before the effect completed.'
                 WHERE status IN ('pending', 'running')",
                [now],
            )
            .map_err(err)?;
        tx.commit().map_err(err)?;
        Ok(cancelled)
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
