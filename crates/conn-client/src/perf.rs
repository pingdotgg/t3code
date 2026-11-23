//! Opt-in thread-open latency log (`CONN_GPUI_PERF_LOG=1`).
//!
//! Each line goes to stderr as `[perf] <stage> thread=<id> ... +<ms>ms`, where `+<ms>` is the
//! time since that thread was opened (or subscribed, for the client's own stages). The check
//! is one cached atomic load, so the disabled path costs nothing measurable.

use std::sync::OnceLock;
use std::time::Instant;

/// Whether `CONN_GPUI_PERF_LOG=1` (or `true`) was set when the process first asked.
#[must_use]
pub fn enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| {
        std::env::var("CONN_GPUI_PERF_LOG")
            .is_ok_and(|v| v == "1" || v.eq_ignore_ascii_case("true"))
    })
}

/// Milliseconds elapsed since `start`, for log lines.
#[must_use]
pub fn ms_since(start: Instant) -> f64 {
    start.elapsed().as_secs_f64() * 1000.0
}

/// Writes one `[perf]` line when the log is enabled. Prefer the [`perf_log!`] macro, which
/// skips formatting entirely when the log is off.
pub fn write(line: std::fmt::Arguments<'_>) {
    eprintln!("[perf] {line}");
}

/// Logs a `[perf]` line when `CONN_GPUI_PERF_LOG=1`; formats nothing otherwise.
#[macro_export]
macro_rules! perf_log {
    ($($arg:tt)*) => {
        if $crate::perf::enabled() {
            $crate::perf::write(format_args!($($arg)*));
        }
    };
}
