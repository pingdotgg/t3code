//! UTC timestamps in the contract's `DateTimeUtc` wire form: `2026-11-13T08:49:41.123Z`.

use std::time::{SystemTime, UNIX_EPOCH};

pub(crate) use conn_support::time::{iso_from_millis, millis_from_iso};

/// A suffix no earlier call in this process returned: epoch nanoseconds, then a counter.
pub(crate) fn unique_suffix() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{nanos:x}-{}", COUNTER.fetch_add(1, Ordering::Relaxed))
}
