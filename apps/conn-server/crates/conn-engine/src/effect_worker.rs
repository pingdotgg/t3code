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

impl Inner {
    /// Starts the worker and the prune loop once, on the caller's runtime. Without a runtime
    /// nothing starts, and rows wait in the outbox for a later call.
    pub(crate) fn ensure_effect_worker(self: &Arc<Self>) {
        if tokio::runtime::Handle::try_current().is_err()
            || self.effect_worker.swap(true, Ordering::SeqCst)
        {
            return;
        }
        let weak = Arc::downgrade(self);
        let wake = self.effects_wake.clone();
        tokio::spawn(async move {
            loop {
                // The engine is gone: stop.
                let Some(inner) = weak.upgrade() else { return };
                let claimed = inner
                    .db(|store| store.claim_effects(CLAIM_BATCH))
                    .await
                    .unwrap_or_else(|e| {
                        eprintln!("conn-engine: could not claim effects: {e}");
                        vec![]
                    });
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
                if let Err(e) = inner.db(|store| store.prune_settled_effects()).await {
                    eprintln!("conn-engine: could not prune settled effects: {e}");
                }
                drop(inner);
                tokio::time::sleep(PRUNE_EVERY).await;
            }
        });
    }

    /// Runs one claimed row and settles it; its thread's next row may then run.
    async fn run_claimed(self: Arc<Self>, claimed: Claimed) {
        let Claimed { id, effect } = claimed;
        self.clone().run_effect(effect).await;
        if let Err(e) = self
            .db(move |store| store.settle_effect(id, Settled::Succeeded, None))
            .await
        {
            // The row stays running and holds its thread until the next start cancels it.
            eprintln!("conn-engine: could not settle effect {id}: {e}");
        }
        self.effects_wake.notify_one();
    }
}
