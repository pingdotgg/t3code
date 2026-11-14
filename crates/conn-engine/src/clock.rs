//! The engine's clock: every stored timestamp and the idle release read it. The server uses
//! the system clock. A test or a replay sets [`ManualClock`], as T3's tests run its engine on
//! Effect's `TestClock` (`DeterministicRuntime.ts`): it starts at the epoch and moves only
//! when told.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

/// Milliseconds since the Unix epoch.
pub trait Clock: Send + Sync {
    fn now_millis(&self) -> u64;
}

/// The system's wall clock, as T3's Effect `Clock`.
#[derive(Clone, Copy, Debug, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_millis(&self) -> u64 {
        conn_support::time::now_ms()
    }
}

/// A clock that moves only on [`ManualClock::advance`]. Starts where it is made.
#[derive(Debug, Default)]
pub struct ManualClock {
    millis: AtomicU64,
}

impl ManualClock {
    /// A clock at `millis` since the epoch; T3's `TestClock` starts at 0.
    pub fn at(millis: u64) -> Self {
        Self {
            millis: AtomicU64::new(millis),
        }
    }

    pub fn advance(&self, by: Duration) {
        let by = u64::try_from(by.as_millis()).unwrap_or(u64::MAX);
        self.millis.fetch_add(by, Ordering::SeqCst);
    }
}

impl Clock for ManualClock {
    fn now_millis(&self) -> u64 {
        self.millis.load(Ordering::SeqCst)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_manual_clock_moves_only_when_advanced() {
        let clock = ManualClock::at(0);
        assert_eq!(clock.now_millis(), 0);
        clock.advance(Duration::from_millis(1));
        clock.advance(Duration::from_secs(31 * 60));
        assert_eq!(clock.now_millis(), 1 + 31 * 60 * 1000);
    }
}
