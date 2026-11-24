//! The effect worker (T3's `EffectWorker.ts`, `OrchestrationEffectWorkerV2`): claims outbox
//! rows (`outbox.rs`), runs them, and settles them.
//!
//! T3 runs 4 worker slots, and after 30 s a slot leaves a slow effect to claim other work. Here
//! one loop on the runtime thread claims, and each claimed row runs as its own task (AGENTS
//! rule 2: one runtime thread, no worker pools). Each thread's lane holds one running row, so
//! the tasks in flight stay bounded by the threads with work. Titles run in their own lane, as
//! in T3, without T3's cap on running titles.
//!
//! Known deviation: T3 retries a failed effect up to 5 times with backoff (`maxAttempts`). Our
//! effects record their own failures (a failed start fails its run), so a row that ran is
//! settled `succeeded`. Porting T3's retries is a planned follow-up.
//!
//! The worker is bound to its engine: the engine's drop stops it, and the store refuses every
//! write of an engine that was dropped or replaced (`Store::take_ownership`). T3 gets the same
//! from the scope that owns its workers and the database.

use std::{
    sync::{Arc, atomic::Ordering},
    time::Duration,
};

use crate::engine::Inner;
use crate::outbox::{Claimed, Settled};

/// Rows claimed per pass; a full pass claims again at once.
const CLAIM_BATCH: usize = 64;
/// `DEFAULT_EFFECT_WORKER_LIVENESS_POLL_INTERVAL_MS`: a missed wake costs at most this.
const LIVENESS_POLL: Duration = Duration::from_secs(30);
/// `layerPruneWorker`: settled rows are pruned at start and every hour.
const PRUNE_EVERY: Duration = Duration::from_secs(60 * 60);
/// `lockRetrySchedule`: a settlement that met a locked store tries again after this.
const LOCK_RETRY: Duration = Duration::from_millis(100);

/// Test hooks: each fires once, then clears.
#[cfg(test)]
#[derive(Default)]
pub(crate) struct TestHooks {
    /// After an effect of this type ran, before its settlement: sends, then waits.
    pub(crate) settle_pause: Option<(
        &'static str,
        tokio::sync::oneshot::Sender<()>,
        tokio::sync::oneshot::Receiver<()>,
    )>,
    /// A rollback holds its workspace and is about to restore files: sends, then waits.
    pub(crate) restore_pause: Option<(
        tokio::sync::oneshot::Sender<()>,
        tokio::sync::oneshot::Receiver<()>,
    )>,
    /// A settlement met a locked store and will try again.
    pub(crate) settle_busy: Option<tokio::sync::oneshot::Sender<()>>,
    /// Between two prune batches, with the store let go: sends, then waits.
    pub(crate) prune_pause: Option<(
        tokio::sync::oneshot::Sender<()>,
        tokio::sync::oneshot::Receiver<()>,
    )>,
    /// Outbox rows that hold their lane until released, then settle without running.
    pub(crate) gates: std::collections::HashMap<i64, tokio::sync::oneshot::Receiver<()>>,
    /// Right after a rollback's result commit: sends, then waits (`rollback.rs`).
    pub(crate) rollback_committed: Option<(
        tokio::sync::oneshot::Sender<()>,
        tokio::sync::oneshot::Receiver<()>,
    )>,
    /// The next rollback failure writes fail (`rollback.rs`).
    pub(crate) rollback_result_faults: u32,
}

/// The wait before settlement try `failures + 1`: 100 ms, doubling, at most 30 s (the
/// backoff of T3's `retry`).
fn settle_backoff(failures: u32) -> Duration {
    let factor = 2u32.saturating_pow(failures.saturating_sub(1));
    LOCK_RETRY
        .saturating_mul(factor)
        .min(Duration::from_secs(30))
}

/// A store too busy to write now: try again, the effect itself is done.
fn locked(error: &rusqlite::Error) -> bool {
    matches!(
        error.sqlite_error_code(),
        Some(rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked)
    )
}

impl Inner {
    /// Starts the worker and the prune loop once, on the caller's runtime. Without a runtime
    /// nothing starts, and rows wait in the outbox for a later call.
    pub(crate) fn ensure_effect_worker(self: &Arc<Self>) {
        if tokio::runtime::Handle::try_current().is_err()
            || self.effects_held.load(Ordering::SeqCst)
            || self.effect_worker.swap(true, Ordering::SeqCst)
        {
            return;
        }
        let weak = Arc::downgrade(self);
        let wake = self.effects_wake.clone();
        tokio::spawn(async move {
            loop {
                // The engine is gone: stop. Another engine may own the store now.
                let Some(inner) = weak.upgrade() else { return };
                if inner.engine_dropped.load(Ordering::SeqCst) {
                    return;
                }
                let claimed = inner
                    .db(|store| store.claim_effects(CLAIM_BATCH))
                    .await
                    .unwrap_or_else(|e| {
                        eprintln!("conn-engine: could not claim effects: {e}");
                        vec![]
                    });
                // Dropped while the claim ran: leave the rows to the next engine's start.
                if inner.engine_dropped.load(Ordering::SeqCst) {
                    return;
                }
                let worked = !claimed.is_empty();
                for row in claimed {
                    tokio::spawn(inner.clone().run_claimed(row));
                }
                drop(inner);
                if worked {
                    continue;
                }
                tokio::select! {
                    () = wake.notified() => {}
                    () = tokio::time::sleep(LIVENESS_POLL) => {}
                }
            }
        });
        let weak = Arc::downgrade(self);
        tokio::spawn(async move {
            loop {
                let Some(inner) = weak.upgrade() else { return };
                if inner.engine_dropped.load(Ordering::SeqCst) {
                    return;
                }
                if let Err(e) = inner.prune_settled_effects().await {
                    eprintln!("conn-engine: could not prune settled effects: {e}");
                }
                drop(inner);
                tokio::time::sleep(PRUNE_EVERY).await;
            }
        });
    }

    /// `pruneSettled`, one batch per store visit: the store is let go and the runtime yields
    /// between batches, so other reads and writes get in. Returns how many rows went.
    pub(crate) async fn prune_settled_effects(&self) -> Result<usize, String> {
        let mut pruned = 0;
        loop {
            let deleted = self.db(|store| store.prune_settled_batch()).await?;
            pruned += deleted;
            if deleted < crate::outbox::PRUNE_BATCH {
                return Ok(pruned);
            }
            tokio::task::yield_now().await;
            #[cfg(test)]
            {
                let pause = crate::lock(&self.worker_hooks).prune_pause.take();
                if let Some((paused, release)) = pause {
                    let _ = paused.send(());
                    let _ = release.await;
                }
            }
        }
    }

    /// Runs one claimed row and settles it; its thread's next row may then run.
    async fn run_claimed(self: Arc<Self>, claimed: Claimed) {
        let Claimed {
            id,
            mut effect,
            progress,
        } = claimed;
        if let crate::commands::Effect::Rollback(request) = &mut effect {
            crate::rollback::resume_from(request, progress.as_ref());
        }
        #[cfg(test)]
        {
            let gate = crate::lock(&self.worker_hooks).gates.remove(&id);
            if let Some(release) = gate {
                let _ = release.await;
                self.settle_ran(id, None).await;
                self.effects_wake.notify_one();
                return;
            }
        }
        #[cfg(test)]
        let effect_type = effect.effect_type();
        let owns_settlement = matches!(effect, crate::commands::Effect::Rollback(_));
        let outcome = self.clone().run_effect(effect).await;
        #[cfg(test)]
        {
            let pause = {
                let mut hooks = crate::lock(&self.worker_hooks);
                match hooks.settle_pause.take() {
                    Some((ty, paused, release)) if ty == effect_type => Some((paused, release)),
                    other => {
                        hooks.settle_pause = other;
                        None
                    }
                }
            };
            if let Some((paused, release)) = pause {
                let _ = paused.send(());
                let _ = release.await;
            }
        }
        // A rollback's own result write settles its row (`Tx::settle_rollback`): settling it
        // here would mark a rollback whose result was never written as done.
        if !owns_settlement {
            self.settle_ran(id, outcome.err()).await;
        }
        self.effects_wake.notify_one();
    }

    /// Settles a row whose effect ran, so its lane frees without running it again.
    ///
    /// T3's recovery (`EffectWorker.ts`, `recoverPostSuccessSettlement`): a settlement that
    /// meets a locked store tries again (`retryWhileLocked`); one that fails otherwise settles
    /// the row `failed` instead (`terminalizeClaim`). T3 puts a replay-safe effect back in the
    /// queue there; we never run an effect twice (no worker retries yet), so every kind ends
    /// `failed`, with the reason. Where T3 gives up after one failed `fail`, the row would hold
    /// its thread until a restart; here the settlement is tried again with backoff for as long
    /// as this engine owns the store.
    async fn settle_ran(&self, id: i64, failure: Option<String>) {
        let (mut status, mut reason) = match failure {
            Some(error) => (Settled::Failed, Some(error)),
            None => (Settled::Succeeded, None),
        };
        let mut failures = 0;
        loop {
            let error = match self.settle(id, status, reason.clone()).await {
                Ok(()) => return,
                Err(e) => e,
            };
            // A newer engine took the store and decides the row; this one writes nothing more.
            if !self.still_owns().await {
                return;
            }
            eprintln!("conn-engine: could not settle effect {id}: {error}");
            if status == Settled::Succeeded {
                status = Settled::Failed;
                reason = Some(format!(
                    "Worker failed to settle the effect after execution started: {error}"
                ));
            }
            // The effect itself ran once; only its settlement is tried again, until it lands.
            failures += 1;
            tokio::time::sleep(settle_backoff(failures)).await;
        }
    }

    /// Whether this engine still owns the store, read from the durable epoch after a failed
    /// write. A read that fails too counts as owned: the next try asks again.
    pub(crate) async fn still_owns(&self) -> bool {
        !self.engine_dropped.load(Ordering::SeqCst)
            && self.db(|store| store.owns_store()).await.unwrap_or(true)
    }

    /// One settlement write, tried again while the store is locked. An engine that no longer
    /// owns the store settles nothing: the newer engine cancelled the row at its start.
    async fn settle(
        &self,
        id: i64,
        status: Settled,
        error: Option<String>,
    ) -> Result<(), rusqlite::Error> {
        loop {
            let reason = error.clone();
            let result = self
                .db(move |store| store.try_settle_effect(id, status, reason.as_deref()))
                .await;
            match result {
                Ok(_) => return Ok(()),
                Err(_) if !self.still_owns().await => return Ok(()),
                Err(e) if locked(&e) => {
                    #[cfg(test)]
                    if let Some(busy) = crate::lock(&self.worker_hooks).settle_busy.take() {
                        let _ = busy.send(());
                    }
                    tokio::time::sleep(LOCK_RETRY).await;
                }
                Err(e) => return Err(e),
            }
        }
    }
}
