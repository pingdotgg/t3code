//! Timing lines for the browser's start-up and navigation.
//!
//! With `CONN_WEB_TRACE=1` they go to stderr. Debug builds also append every line to
//! [`LOG_PATH`], so a supervised dev app whose environment cannot be changed can still be read.
//! Release builds write nothing unless the variable is set. Call it for steps, never per frame.

use std::time::{SystemTime, UNIX_EPOCH};

/// Where debug builds append the trace.
pub const LOG_PATH: &str = "/tmp/conn-web-trace.log";

/// Logs `what` for `source` (such as `"conn-web"`).
pub fn trace(source: &str, what: &str) {
    use std::sync::OnceLock;
    static TO_STDERR: OnceLock<bool> = OnceLock::new();
    let to_stderr = *TO_STDERR.get_or_init(|| std::env::var_os("CONN_WEB_TRACE").is_some());
    if !to_stderr && !cfg!(debug_assertions) {
        return;
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    if to_stderr {
        eprintln!("[{source} {:>5}] {what}", now.as_millis() % 100_000);
    }
    #[cfg(debug_assertions)]
    append_to_log(source, what, now);
}

#[cfg(debug_assertions)]
fn append_to_log(source: &str, what: &str, now: std::time::Duration) {
    use std::io::Write;
    use std::sync::{Mutex, OnceLock};
    static LOG: OnceLock<Option<Mutex<std::fs::File>>> = OnceLock::new();
    let log = LOG.get_or_init(|| {
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(LOG_PATH)
            .ok()
            .map(Mutex::new)
    });
    if let Some(file) = log
        && let Ok(mut file) = file.lock()
    {
        let _ = writeln!(file, "{} [{source}] {what}", clock(now));
    }
}

/// `HH:MM:SS.mmm` in UTC, which is enough to compare lines within one run.
#[cfg(debug_assertions)]
fn clock(now: std::time::Duration) -> String {
    let secs = now.as_secs() % 86_400;
    format!(
        "{:02}:{:02}:{:02}.{:03}Z",
        secs / 3_600,
        secs % 3_600 / 60,
        secs % 60,
        now.subsec_millis()
    )
}

#[cfg(all(test, debug_assertions))]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn the_clock_shows_hours_minutes_seconds_and_milliseconds() {
        let at = Duration::new(86_400 * 3 + 3_600 * 14 + 60 * 5 + 7, 42_000_000);
        assert_eq!(clock(at), "14:05:07.042Z");
    }
}
