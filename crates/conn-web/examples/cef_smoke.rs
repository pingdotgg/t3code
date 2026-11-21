//! Smoke test for `conn-web`'s on-demand CEF runtime on macOS.
//!
//! Usage:
//!   cargo run -p conn-web --features cef --example cef_smoke -- http://127.0.0.1:8080/
//!
//! Downloads CEF if needed, opens a plain AppKit window, loads the requested URL,
//! prints the page title once loaded, and exits 0.

#[cfg(target_os = "macos")]
mod mac_smoke {
    use conn_web::{BrowserView, Rect, StartOptions, WebRuntime, WebRuntimeState};
    use std::cell::RefCell;
    use std::ffi::{CString, c_char, c_void};
    use std::time::{Duration, Instant};

    unsafe extern "C" {
        fn conn_smoke_init_window(width: f64, height: f64, title: *const c_char) -> *mut c_void;
        fn conn_smoke_schedule_timer(
            interval_seconds: f64,
            callback: extern "C" fn(*mut c_void),
            ctx: *mut c_void,
        );
        fn conn_smoke_run_app();
        fn conn_smoke_stop_app();
    }

    struct SmokeState {
        url: String,
        content_view: *mut c_void,
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
                match BrowserView::create(state.content_view, bounds, &state.url) {
                    Ok(view) => {
                        state.browser = Some(view);
                    }
                    Err(err) => {
                        eprintln!("cef_smoke: failed to create BrowserView: {err}");
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
                let loaded_at = *state.loaded_at.get_or_insert_with(Instant::now);
                // Wait briefly for `on_title_change` if it arrives right after `on_load_end`.
                if !title.is_empty() || loaded_at.elapsed() > Duration::from_millis(500) {
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
            WebRuntime::global().quit();
            // SAFETY: Stops the smoke NSApplication run loop on the main thread.
            unsafe { conn_smoke_stop_app() };
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

        let title = CString::new("conn-web cef_smoke").unwrap_or_default();
        // SAFETY: Called on the main thread; `title` is a valid NUL-terminated CString.
        let content_view = unsafe { conn_smoke_init_window(800.0, 600.0, title.as_ptr()) };
        if content_view.is_null() {
            eprintln!("cef_smoke: failed to create AppKit window");
            return 1;
        }

        let profile_dir = std::env::temp_dir().join(format!(
            "conn-web-smoke-profile-{}",
            std::process::id()
        ));
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
                content_view,
                browser: None,
                started_at: Instant::now(),
                loaded_at: None,
                done: false,
                exit_code: 1,
            });
        });

        // SAFETY: Registers a repeating main-thread CFRunLoopTimer with a valid function pointer.
        unsafe { conn_smoke_schedule_timer(0.05, on_tick, std::ptr::null_mut()) };
        // SAFETY: Runs NSApplication on the main thread until `conn_smoke_stop_app` is called.
        unsafe { conn_smoke_run_app() };

        let exit_code = SMOKE.with(|cell| {
            cell.borrow_mut()
                .take()
                .map_or(1, |state| state.exit_code)
        });
        let _ = std::fs::remove_dir_all(&profile_dir);
        exit_code
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
