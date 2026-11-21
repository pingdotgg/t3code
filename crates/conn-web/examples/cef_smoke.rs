//! Smoke test for `conn-web`'s on-demand offscreen CEF runtime on macOS.
//!
//! Usage:
//!   cargo run -p conn-web --features cef --example cef_smoke -- http://127.0.0.1:8080/
//!
//! Downloads CEF if needed, creates an offscreen browser view, loads the
//! requested URL, waits for a painted frame and page title, prints the title,
//! and exits 0.

#[cfg(target_os = "macos")]
mod mac_smoke {
    use conn_web::{BrowserView, Rect, StartOptions, WebRuntime, WebRuntimeState};
    use std::cell::RefCell;
    use std::ffi::c_void;
    use std::path::PathBuf;
    use std::time::{Duration, Instant};

    unsafe extern "C" {
        fn conn_smoke_init_app();
        fn conn_smoke_schedule_timer(
            interval_seconds: f64,
            callback: extern "C" fn(*mut c_void),
            ctx: *mut c_void,
        );
        fn conn_smoke_run_app();
    }

    struct SmokeState {
        url: String,
        profile_dir: PathBuf,
        browser: Option<BrowserView>,
        started_at: Instant,
        loaded_at: Option<Instant>,
        done: bool,
        exit_code: i32,
    }

    thread_local! {
        static SMOKE: RefCell<Option<SmokeState>> = const { RefCell::new(None) };
    }

    extern "C" fn on_tick(_ctx: *mut c_void) {
        let mut should_stop = false;
        SMOKE.with(|cell| {
            let mut guard = cell.borrow_mut();
            let Some(state) = guard.as_mut() else {
                return;
            };
            if state.done {
                return;
            }
            if state.started_at.elapsed() > Duration::from_secs(45) {
                eprintln!("cef_smoke: timed out waiting for page load");
                state.done = true;
                state.exit_code = 1;
                should_stop = true;
                return;
            }

            let runtime = WebRuntime::global();
            match runtime.state() {
                WebRuntimeState::Failed(why) => {
                    eprintln!("cef_smoke: CEF runtime failed: {why}");
                    state.done = true;
                    state.exit_code = 1;
                    should_stop = true;
                    return;
                }
                WebRuntimeState::Running => {}
                _ => return,
            }

            if state.browser.is_none() {
                let bounds = Rect {
                    x: 0.0,
                    y: 0.0,
                    width: 800.0,
                    height: 600.0,
                };
                match BrowserView::create(bounds, 2.0, &state.url) {
                    Ok(view) => {
                        state.browser = Some(view);
                    }
                    Err(err) => {
                        eprintln!("cef_smoke: failed to create offscreen BrowserView: {err}");
                        state.done = true;
                        state.exit_code = 1;
                        should_stop = true;
                    }
                }
                return;
            }

            let Some(view) = state.browser.as_ref() else {
                return;
            };

            if view.load_count() > 0 && !view.is_loading() {
                let title = view.title();
                let has_frame = view.frame_generation() > 0;
                let loaded_at = *state.loaded_at.get_or_insert_with(Instant::now);
                // Wait briefly for `on_title_change` and first OSR `on_paint` after `on_load_end`.
                if (!title.is_empty() && has_frame) || loaded_at.elapsed() > Duration::from_secs(2)
                {
                    if let Some(frame) = view.frame_if_newer(0) {
                        eprintln!(
                            "cef_smoke: painted frame #{} ({}x{}, {} bytes)",
                            frame.generation,
                            frame.width,
                            frame.height,
                            frame.bgra.len()
                        );
                    }
                    println!("{title}");
                    if let Some(view) = state.browser.take() {
                        view.close();
                    }
                    state.done = true;
                    state.exit_code = 0;
                    should_stop = true;
                }
            }
        });

        if should_stop {
            let (exit_code, profile_dir) = SMOKE.with(|cell| {
                cell.borrow_mut().take().map_or((1, None), |state| {
                    (state.exit_code, Some(state.profile_dir))
                })
            });
            if let Some(dir) = profile_dir {
                let _ = std::fs::remove_dir_all(&dir);
            }
            let _ = std::io::Write::flush(&mut std::io::stdout());
            let _ = std::io::Write::flush(&mut std::io::stderr());
            // SAFETY: Flush completed and temp profile was removed; `_exit` avoids
            // Chromium's C++ `CefContext` atexit/runloop traps when exiting a
            // short-lived smoke test.
            unsafe { libc::_exit(exit_code) };
        }
    }

    pub(super) fn run() -> i32 {
        // Subprocess hook MUST run first before any AppKit or app state initializes.
        if let Some(code) = conn_web::maybe_run_subprocess() {
            return code;
        }

        let Some(url) = std::env::args().nth(1) else {
            eprintln!("usage: cef_smoke <url>");
            return 2;
        };

        let runtime = WebRuntime::global();
        if let Err(err) = runtime.ensure_installed(|pct| {
            eprintln!("cef_smoke: downloading CEF ({pct}%)");
        }) {
            eprintln!("cef_smoke: ensure_installed failed: {err}");
            return 1;
        }

        // SAFETY: Called on the main thread to initialize NSApplication for the run loop.
        unsafe { conn_smoke_init_app() };

        let profile_dir =
            std::env::temp_dir().join(format!("conn-web-smoke-profile-{}", std::process::id()));
        let options = StartOptions {
            remote_debugging_port: None,
            profile_dir: Some(profile_dir.clone()),
        };
        if let Err(err) = runtime.start_with_options(options) {
            eprintln!("cef_smoke: start failed: {err}");
            let _ = std::fs::remove_dir_all(&profile_dir);
            return 1;
        }

        SMOKE.with(|cell| {
            *cell.borrow_mut() = Some(SmokeState {
                url,
                profile_dir: profile_dir.clone(),
                browser: None,
                started_at: Instant::now(),
                loaded_at: None,
                done: false,
                exit_code: 1,
            });
        });

        // SAFETY: Registers a repeating main-thread CFRunLoopTimer with a valid function pointer.
        unsafe { conn_smoke_schedule_timer(0.05, on_tick, std::ptr::null_mut()) };
        // SAFETY: Runs NSApplication on the main thread until `on_tick` exits.
        unsafe { conn_smoke_run_app() };

        1
    }
}

fn main() {
    #[cfg(target_os = "macos")]
    std::process::exit(mac_smoke::run());
    #[cfg(not(target_os = "macos"))]
    {
        eprintln!("cef_smoke is only supported on macOS");
        std::process::exit(1);
    }
}
