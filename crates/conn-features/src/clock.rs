//! Wall time for the stores and the scheduler, and a clock tests can move.
//!
//! The scheduler sleeps on tokio's timer, so a test that pauses tokio's clock also moves
//! [`TestClock`]: its wall time is a base plus the tokio time that passed since it was made.

use std::sync::{
    Arc,
    atomic::{AtomicI64, Ordering},
};

/// Milliseconds since the Unix epoch.
pub trait Clock: Send + Sync + std::fmt::Debug {
    fn now_ms(&self) -> i64;
}

/// The system clock.
#[derive(Debug, Default, Clone, Copy)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> i64 {
        i64::try_from(conn_support::time::now_ms()).unwrap_or(i64::MAX)
    }
}

/// Wall time that follows tokio's clock: with `tokio::time::pause`, `advance` moves both.
/// [`TestClock::set`] jumps the wall time, as a server that was off for a while sees it.
#[derive(Debug, Clone)]
pub struct TestClock {
    base: Arc<AtomicI64>,
    start: tokio::time::Instant,
}

impl TestClock {
    pub fn new(now_ms: i64) -> Self {
        Self {
            base: Arc::new(AtomicI64::new(now_ms)),
            start: tokio::time::Instant::now(),
        }
    }

    /// Sets the wall time to `now_ms` from this moment on.
    pub fn set(&self, now_ms: i64) {
        let elapsed = self.elapsed_ms();
        self.base.store(now_ms - elapsed, Ordering::SeqCst);
    }

    fn elapsed_ms(&self) -> i64 {
        i64::try_from(self.start.elapsed().as_millis()).unwrap_or(i64::MAX)
    }
}

impl Clock for TestClock {
    fn now_ms(&self) -> i64 {
        self.base.load(Ordering::SeqCst) + self.elapsed_ms()
    }
}
