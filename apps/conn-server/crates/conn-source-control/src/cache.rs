//! A bounded cache whose callers share one lookup per key, as Effect's `Cache.makeWith` with
//! a capacity and a time to live per answer. The T3 server keeps provider detection, unknown
//! remote verdicts and `gh` tokens in such caches.
//!
//! - At most `capacity` keys. A new key evicts expired keys first, then the oldest.
//! - Callers of a key that is being looked up wait for that lookup; the first caller's future
//!   runs it. If that caller is dropped, the next waiter runs its own.
//! - `ttl` decides per answer how long it stays; zero means it is not kept, as T3 keeps no
//!   failure.

use std::{
    collections::HashMap,
    hash::Hash,
    sync::{Arc, Mutex, MutexGuard, PoisonError},
    time::Duration,
};

use tokio::{sync::OnceCell, time::Instant};

#[derive(Debug)]
struct Entry<V> {
    cell: Arc<OnceCell<V>>,
    /// `None` while the lookup runs.
    expires: Option<Instant>,
    stamp: u64,
}

#[derive(Debug)]
struct Inner<K, V> {
    entries: HashMap<K, Entry<V>>,
    next_stamp: u64,
}

/// See the module documentation.
#[derive(Debug)]
pub struct TtlCache<K, V> {
    inner: Mutex<Inner<K, V>>,
    capacity: usize,
}

impl<K: Eq + Hash + Clone, V: Clone> TtlCache<K, V> {
    pub fn new(capacity: usize) -> Self {
        Self {
            inner: Mutex::new(Inner {
                entries: HashMap::new(),
                next_stamp: 0,
            }),
            capacity: capacity.max(1),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Inner<K, V>> {
        // A panic aborts the server, so a poisoned lock never outlives one.
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The cached answer for `key`, or the answer of `lookup`, shared with every caller that
    /// asks while it runs.
    pub async fn get_with<F, Fut>(&self, key: K, ttl: impl Fn(&V) -> Duration, lookup: F) -> V
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = V>,
    {
        let cell = {
            let mut inner = self.lock();
            let now = Instant::now();
            if inner
                .entries
                .get(&key)
                .is_some_and(|e| e.expires.is_some_and(|t| t <= now))
            {
                inner.entries.remove(&key);
            }
            if let Some(entry) = inner.entries.get(&key) {
                Arc::clone(&entry.cell)
            } else {
                if inner.entries.len() >= self.capacity {
                    inner
                        .entries
                        .retain(|_, e| e.expires.is_none_or(|t| t > now));
                }
                if inner.entries.len() >= self.capacity {
                    let oldest = inner
                        .entries
                        .iter()
                        .min_by_key(|(_, e)| e.stamp)
                        .map(|(k, _)| k.clone());
                    if let Some(oldest) = oldest {
                        inner.entries.remove(&oldest);
                    }
                }
                let cell = Arc::new(OnceCell::new());
                let stamp = inner.next_stamp;
                inner.next_stamp += 1;
                inner.entries.insert(
                    key.clone(),
                    Entry {
                        cell: Arc::clone(&cell),
                        expires: None,
                        stamp,
                    },
                );
                cell
            }
        };
        let value = cell.get_or_init(lookup).await.clone();
        let keep = ttl(&value);
        let mut inner = self.lock();
        let ours = inner
            .entries
            .get(&key)
            .is_some_and(|e| Arc::ptr_eq(&e.cell, &cell) && e.expires.is_none());
        if ours {
            if keep.is_zero() {
                inner.entries.remove(&key);
            } else if let Some(entry) = inner.entries.get_mut(&key) {
                entry.expires = Some(Instant::now() + keep);
            }
        }
        value
    }

    /// `Cache.invalidateAll`.
    pub fn invalidate_all(&self) {
        self.lock().entries.clear();
    }

    /// `Cache.invalidate` for one key.
    pub fn invalidate(&self, key: &K) {
        self.lock().entries.remove(key);
    }

    /// Invalidates a bounded set of related reads, including lookups still in flight.
    pub fn invalidate_where(&self, matches: impl Fn(&K) -> bool) {
        self.lock().entries.retain(|key, _| !matches(key));
    }

    /// Keeps the newest held answers whose weights fit in `budget` and evicts the rest, as
    /// T3's `diffCacheEvictions`. An answer heavier than the budget is never kept.
    pub fn evict_beyond(&self, budget: usize, weight: impl Fn(&V) -> usize) {
        let mut inner = self.lock();
        let mut held: Vec<(u64, usize)> = inner
            .entries
            .values()
            .filter_map(|entry| entry.cell.get().map(|value| (entry.stamp, weight(value))))
            .collect();
        held.sort_unstable_by_key(|(stamp, _)| std::cmp::Reverse(*stamp));
        let mut kept = 0usize;
        let mut evicted = Vec::new();
        for (stamp, size) in held {
            match kept.checked_add(size).filter(|total| *total <= budget) {
                Some(total) => kept = total,
                None => evicted.push(stamp),
            }
        }
        if !evicted.is_empty() {
            inner
                .entries
                .retain(|_, entry| !evicted.contains(&entry.stamp));
        }
    }

    /// How many keys are held, for tests.
    pub fn len(&self) -> usize {
        self.lock().entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use std::{cell::Cell, rc::Rc};

    use super::*;

    #[tokio::test(start_paused = true)]
    async fn callers_share_one_lookup_and_answers_expire() {
        let cache: TtlCache<&str, u32> = TtlCache::new(4);
        let calls = Rc::new(Cell::new(0));
        let lookup = || {
            let calls = Rc::clone(&calls);
            async move {
                calls.set(calls.get() + 1);
                tokio::time::sleep(Duration::from_millis(10)).await;
                7
            }
        };
        let ttl = |_: &u32| Duration::from_secs(5);
        let (a, b) = tokio::join!(
            cache.get_with("k", ttl, lookup),
            cache.get_with("k", ttl, lookup)
        );
        assert_eq!(
            (a, b, calls.get()),
            (7, 7, 1),
            "one lookup for both callers"
        );
        cache.get_with("k", ttl, lookup).await;
        assert_eq!(calls.get(), 1, "kept within its time");
        tokio::time::advance(Duration::from_secs(5)).await;
        cache.get_with("k", ttl, lookup).await;
        assert_eq!(calls.get(), 2, "asked again once expired");
    }

    #[tokio::test(start_paused = true)]
    async fn a_zero_ttl_keeps_nothing_and_capacity_bounds_keys() {
        let cache: TtlCache<u32, u32> = TtlCache::new(2);
        cache.get_with(1, |_| Duration::ZERO, || async { 1 }).await;
        assert!(cache.is_empty(), "a zero time to live keeps nothing");
        for key in 0..5 {
            cache
                .get_with(key, |_| Duration::from_secs(60), || async move { key })
                .await;
        }
        assert_eq!(cache.len(), 2, "bounded");
        cache.invalidate_where(|key| *key == 4);
        assert_eq!(cache.len(), 1, "matching keys invalidated");
        cache.invalidate_all();
        assert!(cache.is_empty(), "invalidated");
    }
}
