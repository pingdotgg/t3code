//! Dispatch locks retained only while their thread has holders or waiters.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};

#[derive(Default)]
pub(crate) struct ThreadLocks(Mutex<HashMap<String, Arc<Entry>>>);

#[derive(Default)]
struct Entry(Arc<AsyncMutex<()>>);

struct Lease<'a> {
    locks: &'a ThreadLocks,
    thread: String,
    entry: Option<Arc<Entry>>,
}

// Fields drop in order: unlock before retiring the map entry.
pub(crate) struct Guard<'a> {
    _guard: OwnedMutexGuard<()>,
    _lease: Lease<'a>,
}

impl ThreadLocks {
    pub(crate) async fn lock(&self, thread: &str) -> Guard<'_> {
        let entry = crate::lock(&self.0)
            .entry(thread.to_owned())
            .or_default()
            .clone();
        let gate = entry.0.clone();
        let lease = Lease {
            locks: self,
            thread: thread.to_owned(),
            entry: Some(entry),
        };
        let guard = gate.lock_owned().await;
        Guard {
            _guard: guard,
            _lease: lease,
        }
    }
}

impl Drop for Lease<'_> {
    fn drop(&mut self) {
        let mut locks = crate::lock(&self.locks.0);
        // Release the lease under the table lock, separately from a cancelled mutex future.
        drop(self.entry.take());
        if locks
            .get(&self.thread)
            .is_some_and(|entry| Arc::strong_count(entry) == 1)
        {
            locks.remove(&self.thread);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        future::Future,
        task::{Context, Waker},
    };

    #[tokio::test(flavor = "current_thread")]
    async fn holders_and_cancelled_waiters_release_their_entries() {
        let locks = ThreadLocks::default();
        let first = locks.lock("one").await;
        let mut waiting = Box::pin(locks.lock("one"));
        assert!(
            waiting
                .as_mut()
                .poll(&mut Context::from_waker(Waker::noop()))
                .is_pending()
        );
        let other = locks.lock("two").await;
        assert_eq!(crate::lock(&locks.0).len(), 2);
        drop(waiting);
        drop(first);
        assert_eq!(crate::lock(&locks.0).len(), 1);
        drop(other);
        assert!(crate::lock(&locks.0).is_empty());
    }
}
