//! Starts Chromium once the app is up, so the Browser tab never waits for it. Everything that can
//! block runs on a background thread: the first-run download, building the helper apps, and
//! mapping the 1.3 GB framework into memory. The main thread only runs what CEF requires of it
//! (`execute_process`, then `cef_initialize` and the message loop), after the first window has
//! painted. Tests and `CONN_GPUI_NO_CEF=1` never start it.

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use conn_web::{WebError, WebRuntime};
use gpui_kit::App;

/// Pause after the window opens, so its first frames paint before CEF takes the main thread.
const AFTER_FIRST_PAINT: Duration = Duration::from_millis(400);

static BEGUN: AtomicBool = AtomicBool::new(false);
static FAILURE: Mutex<Option<String>> = Mutex::new(None);

/// Whether this process must never start CEF.
#[must_use]
pub(crate) fn disabled() -> bool {
    cfg!(test) || std::env::var_os("CONN_GPUI_NO_CEF").is_some()
}

/// Why the last start failed before CEF could report a state of its own (helpers, framework).
#[must_use]
pub(crate) fn failure() -> Option<String> {
    FAILURE.lock().ok().and_then(|f| f.clone())
}

/// Whether a warm-up is under way (download, helpers, framework, or the start itself).
#[must_use]
pub(crate) fn active() -> bool {
    BEGUN.load(Ordering::Acquire)
}

/// Starts the warm-up once after launch. The first call wins; later calls do nothing.
pub(crate) fn begin_after_launch(cx: &mut App) {
    if disabled() {
        return;
    }
    begin_inner(cx, AFTER_FIRST_PAINT);
}

/// Makes sure the warm-up runs: used when the Browser tab opens before (or after a failure of)
/// the launch warm-up. Does nothing while one is under way or CEF is up.
pub(crate) fn begin(cx: &mut App) {
    if disabled() {
        return;
    }
    begin_inner(cx, Duration::ZERO);
}

fn begin_inner(cx: &mut App, settle: Duration) {
    if BEGUN.swap(true, Ordering::AcqRel) {
        return;
    }
    if let Ok(mut failure) = FAILURE.lock() {
        *failure = None;
    }
    let began = std::time::Instant::now();
    let (tx, rx) = futures::channel::oneshot::channel();
    let spawned = std::thread::Builder::new()
        .name("conn-web-warmup".into())
        .spawn(move || {
            let _ = tx.send(prepare_off_main_thread());
        });
    if let Err(err) = spawned {
        fail(&format!(
            "could not start the Chromium warm-up thread: {err}"
        ));
        return;
    }
    cx.spawn(async move |cx| {
        let prepared = rx.await;
        // The window paints first. The timer runs off the main thread; we resume on it.
        let remaining = settle.saturating_sub(began.elapsed());
        if !remaining.is_zero() {
            cx.background_executor().timer(remaining).await;
        }
        match prepared {
            Ok(Ok(())) => {
                let started = std::time::Instant::now();
                let result = WebRuntime::global().start();
                log::debug!(
                    "CEF start returned on the main thread after {:?}",
                    started.elapsed()
                );
                if let Err(err) = result {
                    fail(&err.to_string());
                }
            }
            Ok(Err(err)) => fail(&err.to_string()),
            Err(_) => fail("the Chromium warm-up thread ended without a result"),
        }
    })
    .detach();
}

/// Download (first run), helper apps and framework mapping: all file work, off the main thread.
fn prepare_off_main_thread() -> Result<(), WebError> {
    let runtime = WebRuntime::global();
    runtime.ensure_installed(|_| {})?;
    runtime.prepare()?;
    runtime.preload_framework()
}

/// Records a failure the panel shows, and allows a later tab open to try again.
fn fail(why: &str) {
    log::error!("Chromium warm-up failed: {why}");
    if let Ok(mut failure) = FAILURE.lock() {
        *failure = Some(why.to_owned());
    }
    BEGUN.store(false, Ordering::Release);
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui_kit::TestAppContext;

    #[gpui_kit::test]
    fn tests_never_start_chromium(cx: &mut TestAppContext) {
        assert!(disabled());
        // Not even a direct call starts a warm-up, so nothing downloads or starts CEF in tests.
        cx.update(begin);
        cx.update(begin_after_launch);
        assert!(!active());
        assert_eq!(failure(), None);
    }
}
