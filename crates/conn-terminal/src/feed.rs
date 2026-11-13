//! A bounded queue between a terminal and one subscriber.
//!
//! The terminal never waits for a subscriber. It pushes events and moves on; a subscriber that
//! falls more than `max_bytes` behind loses its queue and is told to resynchronize from a fresh
//! snapshot, as `terminalOutputStream` in `apps/server/src/terminal/OutputProtocol.ts` does.

use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
};

use tokio::sync::Notify;

/// What T3 charges an event on top of its variable fields, so tiny events still count.
pub const EVENT_OVERHEAD: usize = 128;

pub struct Feed<T> {
    state: Mutex<FeedState<T>>,
    notify: Notify,
    max_bytes: usize,
}

struct FeedState<T> {
    items: VecDeque<(T, usize)>,
    bytes: usize,
    overflowed: bool,
}

pub enum Take<T> {
    Items(Vec<T>),
    /// The queue overflowed and was dropped; the subscriber must start again from a snapshot.
    Resync,
}

impl<T> Feed<T> {
    pub fn new(max_bytes: usize) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(FeedState {
                items: VecDeque::new(),
                bytes: 0,
                overflowed: false,
            }),
            notify: Notify::new(),
            max_bytes,
        })
    }

    pub fn push(&self, item: T, size: usize) {
        let mut state = self.state.lock().expect("feed lock");
        if state.overflowed {
            return;
        }
        // One item larger than the budget (a big snapshot) still fits on its own.
        if !state.items.is_empty() && state.bytes + size > self.max_bytes {
            state.items = VecDeque::new();
            state.bytes = 0;
            state.overflowed = true;
        } else {
            state.items.push_back((item, size));
            state.bytes += size;
        }
        drop(state);
        self.notify.notify_one();
    }

    /// Replaces everything queued with `item`, as a resync does.
    pub fn reset(&self, item: T, size: usize) {
        let mut state = self.state.lock().expect("feed lock");
        state.items = VecDeque::from([(item, size)]);
        state.bytes = size;
        state.overflowed = false;
        drop(state);
        self.notify.notify_one();
    }

    /// Waits for items. `merge` may fold the next item into the last one taken (consecutive
    /// output); it returns the item back when it cannot. Takes up to `max_bytes` per call.
    pub async fn take(&self, max_bytes: usize, merge: impl Fn(&mut T, T) -> Option<T>) -> Take<T> {
        loop {
            let notified = self.notify.notified();
            {
                let mut state = self.state.lock().expect("feed lock");
                if state.overflowed {
                    state.overflowed = false;
                    return Take::Resync;
                }
                if let Some((first, mut taken)) = state.items.pop_front() {
                    let mut out = vec![first];
                    while let Some((_, size)) = state.items.front() {
                        if taken + size > max_bytes {
                            break;
                        }
                        let (item, size) = state.items.pop_front().expect("front exists");
                        taken += size;
                        let last = out.last_mut().expect("one item");
                        if let Some(item) = merge(last, item) {
                            out.push(item);
                        }
                    }
                    state.bytes -= taken;
                    if state.items.is_empty() {
                        state.items = VecDeque::new();
                    }
                    return Take::Items(out);
                }
            }
            notified.await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn no_merge(_: &mut u32, b: u32) -> Option<u32> {
        Some(b)
    }

    #[tokio::test(flavor = "current_thread")]
    async fn bounds_bytes_and_resyncs_after_overflow() {
        let feed = Feed::new(100);
        feed.push(1, 60);
        feed.push(2, 30);
        let Take::Items(items) = feed.take(1000, no_merge).await else {
            panic!()
        };
        assert_eq!(items, vec![1, 2]);
        feed.push(3, 60);
        feed.push(4, 60);
        assert!(matches!(feed.take(1000, no_merge).await, Take::Resync));
        // Dropped while overflowed, until a reset.
        feed.push(5, 1);
        feed.reset(6, 500);
        let Take::Items(items) = feed.take(10, no_merge).await else {
            panic!()
        };
        assert_eq!(items, vec![6]);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn merges_and_limits_a_batch() {
        let feed = Feed::new(1000);
        for i in 0..5 {
            feed.push(i, 10);
        }
        let Take::Items(items) = feed
            .take(30, |a: &mut u32, b| {
                *a += b;
                None
            })
            .await
        else {
            panic!()
        };
        assert_eq!(items, vec![3]);
        let Take::Items(items) = feed.take(1000, no_merge).await else {
            panic!()
        };
        assert_eq!(items, vec![3, 4]);
    }
}
