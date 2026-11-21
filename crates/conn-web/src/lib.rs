//! Embedded Chromium (CEF-on-demand) browser runtime for `conn-gpui`.
//!
//! Reference implementation: `.refs/threadbear/desktop/web/` (`cef-rs` + `dlopen` loader +
//! macOS AppKit host view).
//!
//! All CEF code is gated behind the optional `cef` Cargo feature (default OFF) so the
//! workspace builds and tests cleanly without downloading CEF. When `cef` is disabled (or on
//! non-macOS targets), the full public API remains available and returns
//! [`WebRuntimeState::NotInstalled`] / [`WebError::Unsupported`].

#[cfg(feature = "cef")]
mod archive;
#[cfg(feature = "cef")]
mod download;
#[cfg(all(feature = "cef", target_os = "macos"))]
mod mac;

use std::ffi::c_void;
use std::path::PathBuf;
use thiserror::Error;

/// Pinned CEF build version supported by this crate.
pub const CEF_VERSION: &str = "156.0.26+g8ea0c73+chromium-156.0.8078.88";

/// Lifecycle state of the on-demand CEF runtime.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WebRuntimeState {
    NotInstalled,
    Downloading { progress_percent: u8 },
    Starting,
    Running,
    Failed(String),
}

/// Errors returned by [`WebRuntime`] and [`BrowserView`].
#[derive(Debug, Error)]
pub enum WebError {
    #[error("embedded web runtime is unsupported: {0}")]
    Unsupported(&'static str),
    #[error("CEF runtime is not installed")]
    NotInstalled,
    #[error("CEF runtime is not running")]
    NotRunning,
    #[error("invalid argument: {0}")]
    InvalidArgument(String),
    #[error("failed to download CEF runtime: {0}")]
    Download(String),
    #[error("CEF archive verification failed: {0}")]
    Integrity(String),
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("CEF runtime error: {0}")]
    Runtime(String),
}

/// Window-relative rectangle in logical points (origin at top-left).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Rect {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

/// Optional configuration passed to [`WebRuntime::start_with_options`].
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct StartOptions {
    /// Optional TCP port for Chromium's remote debugging (CDP) endpoint.
    pub remote_debugging_port: Option<u16>,
    /// Optional override for the Chromium user profile directory.
    pub profile_dir: Option<PathBuf>,
}

/// Intercepts CEF helper subprocess invocations (`--type=...`).
///
/// Must be the **first** call in `main()` of any binary that hosts `conn-web`:
///
/// ```no_run
/// if let Some(code) = conn_web::maybe_run_subprocess() {
///     std::process::exit(code);
/// }
/// // Normal application startup...
/// ```
#[must_use]
pub fn maybe_run_subprocess() -> Option<i32> {
    #[cfg(all(feature = "cef", target_os = "macos"))]
    {
        mac::helper::maybe_run_subprocess()
    }
    #[cfg(not(all(feature = "cef", target_os = "macos")))]
    {
        None
    }
}

/// Process-wide handle to the on-demand CEF runtime.
#[derive(Clone, Copy, Debug, Default)]
pub struct WebRuntime;

static GLOBAL_RUNTIME: WebRuntime = WebRuntime;

impl WebRuntime {
    /// Returns the process-wide [`WebRuntime`] singleton.
    #[must_use]
    pub fn global() -> &'static Self {
        &GLOBAL_RUNTIME
    }

    /// Creates a handle referencing the process-wide [`WebRuntime`] singleton.
    #[must_use]
    pub fn new() -> Self {
        Self
    }

    /// Returns the current lifecycle state of the runtime.
    #[must_use]
    pub fn state(&self) -> WebRuntimeState {
        #[cfg(all(feature = "cef", target_os = "macos"))]
        {
            mac::host::state()
        }
        #[cfg(not(all(feature = "cef", target_os = "macos")))]
        {
            WebRuntimeState::NotInstalled
        }
    }

    /// Returns `true` if the pinned CEF framework is already installed on disk.
    #[must_use]
    pub fn is_installed(&self) -> bool {
        #[cfg(all(feature = "cef", target_os = "macos"))]
        {
            let Some(archive) = archive::current_archive() else {
                return false;
            };
            let Ok(root) = archive::Layout::default_root() else {
                return false;
            };
            archive::is_installed(&archive::Layout::new(root), &archive.pin())
        }
        #[cfg(not(all(feature = "cef", target_os = "macos")))]
        {
            false
        }
    }

    /// Resolves the versioned CEF install directory (`<root>/<version>/`).
    ///
    /// Defaults to `~/Library/Application Support/conn-gpui/cef/<version>/` and
    /// honors the `CONN_GPUI_CEF_DIR` environment variable.
    ///
    /// # Errors
    ///
    /// Returns [`WebError::Unsupported`] when the `cef` feature is disabled, or
    /// [`WebError::Runtime`] if the home directory cannot be resolved.
    pub fn install_dir(&self) -> Result<PathBuf, WebError> {
        #[cfg(all(feature = "cef", target_os = "macos"))]
        {
            let root = archive::Layout::default_root()?;
            Ok(archive::Layout::new(root).version_dir())
        }
        #[cfg(not(all(feature = "cef", target_os = "macos")))]
        {
            Err(WebError::Unsupported(
                "enable the `cef` feature on macOS to use conn-web",
            ))
        }
    }

    /// Ensures the pinned CEF minimal distribution is downloaded, verified, and
    /// unpacked into [`WebRuntime::install_dir`].
    ///
    /// Blocking; invoke on a background thread when calling from a UI thread.
    ///
    /// # Errors
    ///
    /// Returns [`WebError::Unsupported`] without the `cef` feature on macOS, or
    /// download/integrity/I/O errors if fetching or unpacking fails.
    pub fn ensure_installed(&self, progress: impl Fn(u8)) -> Result<(), WebError> {
        #[cfg(all(feature = "cef", target_os = "macos"))]
        {
            let archive = archive::current_archive().ok_or(WebError::Unsupported(
                "no pinned CEF archive for this architecture",
            ))?;
            let layout = archive::Layout::new(archive::Layout::default_root()?);
            if archive::is_installed(&layout, &archive.pin()) {
                progress(100);
                return Ok(());
            }
            let result = download::install(archive, &layout, &mut |pct| {
                mac::host::set_state(WebRuntimeState::Downloading {
                    progress_percent: pct,
                });
                progress(pct);
            });
            match result {
                Ok(()) => {
                    if matches!(mac::host::state(), WebRuntimeState::Downloading { .. }) {
                        mac::host::set_state(WebRuntimeState::NotInstalled);
                    }
                    Ok(())
                }
                Err(err) => {
                    mac::host::set_state(WebRuntimeState::Failed(err.to_string()));
                    Err(err)
                }
            }
        }
        #[cfg(not(all(feature = "cef", target_os = "macos")))]
        {
            let _ = progress;
            Err(WebError::Unsupported(
                "enable the `cef` feature on macOS to install CEF",
            ))
        }
    }

    /// Loads the CEF framework via `dlopen` and initializes CEF on the main thread
    /// with default [`StartOptions`].
    ///
    /// # Errors
    ///
    /// Returns [`WebError::NotInstalled`] if CEF is not installed yet,
    /// [`WebError::Unsupported`] without the `cef` feature on macOS, or
    /// [`WebError::Runtime`] if framework loading or initialization fails.
    pub fn start(&self) -> Result<(), WebError> {
        self.start_with_options(StartOptions::default())
    }

    /// Loads the CEF framework via `dlopen` and initializes CEF with explicit
    /// [`StartOptions`] (including optional CDP `remote_debugging_port`).
    ///
    /// # Errors
    ///
    /// Returns [`WebError::NotInstalled`] if CEF is not installed yet,
    /// [`WebError::Unsupported`] without the `cef` feature on macOS, or
    /// [`WebError::Runtime`] if framework loading or initialization fails.
    pub fn start_with_options(&self, options: StartOptions) -> Result<(), WebError> {
        #[cfg(all(feature = "cef", target_os = "macos"))]
        {
            mac::host::start(options)
        }
        #[cfg(not(all(feature = "cef", target_os = "macos")))]
        {
            let _ = options;
            Err(WebError::Unsupported(
                "enable the `cef` feature on macOS to start CEF",
            ))
        }
    }

    /// Requests Chromium's nested message loop to exit, if running.
    pub fn quit(&self) {
        #[cfg(all(feature = "cef", target_os = "macos"))]
        {
            mac::host::quit();
        }
    }
}

/// Handle to a native embedded Chromium view hosted inside a parent window view.
#[derive(Debug)]
pub struct BrowserView {
    #[cfg(all(feature = "cef", target_os = "macos"))]
    inner: mac::view::MacBrowserView,
    #[cfg(not(all(feature = "cef", target_os = "macos")))]
    _private: (),
}

impl BrowserView {
    /// Creates a new embedded Chromium view as a child of `parent_ns_view`.
    ///
    /// Must be called on the main thread after [`WebRuntime::state`] reaches
    /// [`WebRuntimeState::Running`].
    ///
    /// # Errors
    ///
    /// Returns [`WebError::Unsupported`] without the `cef` feature on macOS,
    /// [`WebError::NotRunning`] if the runtime is not running,
    /// [`WebError::InvalidArgument`] if `parent_ns_view` is null, or
    /// [`WebError::Runtime`] if CEF fails to create the browser.
    pub fn create(parent_ns_view: *mut c_void, bounds: Rect, url: &str) -> Result<Self, WebError> {
        #[cfg(all(feature = "cef", target_os = "macos"))]
        {
            let inner = mac::view::MacBrowserView::create(parent_ns_view, bounds, url)?;
            Ok(Self { inner })
        }
        #[cfg(not(all(feature = "cef", target_os = "macos")))]
        {
            let _ = (parent_ns_view, bounds, url);
            Err(WebError::Unsupported(
                "enable the `cef` feature on macOS to create a BrowserView",
            ))
        }
    }

    /// Updates the child view's position and size in top-left window points.
    pub fn set_bounds(&self, bounds: Rect) {
        #[cfg(all(feature = "cef", target_os = "macos"))]
        self.inner.set_bounds(bounds);
        #[cfg(not(all(feature = "cef", target_os = "macos")))]
        let _ = bounds;
    }

    /// Navigates the main frame to `url`.
    pub fn load_url(&self, url: &str) {
        #[cfg(all(feature = "cef", target_os = "macos"))]
        self.inner.load_url(url);
        #[cfg(not(all(feature = "cef", target_os = "macos")))]
        let _ = url;
    }

    /// Navigates back in session history, if possible.
    pub fn go_back(&self) {
        #[cfg(all(feature = "cef", target_os = "macos"))]
        self.inner.go_back();
    }

    /// Navigates forward in session history, if possible.
    pub fn go_forward(&self) {
        #[cfg(all(feature = "cef", target_os = "macos"))]
        self.inner.go_forward();
    }

    /// Reloads the current page.
    pub fn reload(&self) {
        #[cfg(all(feature = "cef", target_os = "macos"))]
        self.inner.reload();
    }

    /// Returns the current main-frame URL.
    #[must_use]
    pub fn url(&self) -> String {
        #[cfg(all(feature = "cef", target_os = "macos"))]
        {
            self.inner.url()
        }
        #[cfg(not(all(feature = "cef", target_os = "macos")))]
        {
            String::new()
        }
    }

    /// Returns the current document title.
    #[must_use]
    pub fn title(&self) -> String {
        #[cfg(all(feature = "cef", target_os = "macos"))]
        {
            self.inner.title()
        }
        #[cfg(not(all(feature = "cef", target_os = "macos")))]
        {
            String::new()
        }
    }

    /// Returns `true` if the browser can navigate back.
    #[must_use]
    pub fn can_go_back(&self) -> bool {
        #[cfg(all(feature = "cef", target_os = "macos"))]
        {
            self.inner.can_go_back()
        }
        #[cfg(not(all(feature = "cef", target_os = "macos")))]
        {
            false
        }
    }

    /// Returns `true` if the browser can navigate forward.
    #[must_use]
    pub fn can_go_forward(&self) -> bool {
        #[cfg(all(feature = "cef", target_os = "macos"))]
        {
            self.inner.can_go_forward()
        }
        #[cfg(not(all(feature = "cef", target_os = "macos")))]
        {
            false
        }
    }

    /// Returns `true` while the browser is loading.
    #[must_use]
    pub fn is_loading(&self) -> bool {
        #[cfg(all(feature = "cef", target_os = "macos"))]
        {
            self.inner.is_loading()
        }
        #[cfg(not(all(feature = "cef", target_os = "macos")))]
        {
            false
        }
    }

    /// Returns the number of completed main-frame loads.
    #[must_use]
    pub fn load_count(&self) -> u32 {
        #[cfg(all(feature = "cef", target_os = "macos"))]
        {
            self.inner.load_count()
        }
        #[cfg(not(all(feature = "cef", target_os = "macos")))]
        {
            0
        }
    }

    /// Registers a callback invoked whenever the main frame finishes loading,
    /// receiving `(url, http_status_code)`.
    pub fn on_load_end(&self, callback: impl Fn(&str, i32) + Send + Sync + 'static) {
        #[cfg(all(feature = "cef", target_os = "macos"))]
        self.inner.on_load_end(callback);
        #[cfg(not(all(feature = "cef", target_os = "macos")))]
        let _ = callback;
    }

    /// Hides or shows the native child view (used when GPUI popovers overlap).
    pub fn set_hidden(&self, hidden: bool) {
        #[cfg(all(feature = "cef", target_os = "macos"))]
        self.inner.set_hidden(hidden);
        #[cfg(not(all(feature = "cef", target_os = "macos")))]
        let _ = hidden;
    }

    /// Returns `true` if the view is currently hidden.
    #[must_use]
    pub fn is_hidden(&self) -> bool {
        #[cfg(all(feature = "cef", target_os = "macos"))]
        {
            self.inner.is_hidden()
        }
        #[cfg(not(all(feature = "cef", target_os = "macos")))]
        {
            true
        }
    }

    /// Closes the browser view and removes its native `NSView` from its parent.
    pub fn close(self) {
        #[cfg(all(feature = "cef", target_os = "macos"))]
        self.inner.close_inner();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_runtime_state_is_not_installed() {
        let runtime = WebRuntime::global();
        assert_eq!(
            runtime.state(),
            WebRuntimeState::NotInstalled,
            "fresh runtime should start in NotInstalled state"
        );
        assert_eq!(
            maybe_run_subprocess(),
            None,
            "test runner without --type= should not trigger subprocess path"
        );
    }

    #[cfg(not(feature = "cef"))]
    #[test]
    fn stub_api_returns_unsupported_without_cef_feature() {
        let runtime = WebRuntime::new();
        assert!(
            !runtime.is_installed(),
            "stub runtime should report not installed"
        );
        assert!(
            matches!(
                runtime.ensure_installed(|_| {}),
                Err(WebError::Unsupported(_))
            ),
            "ensure_installed should return Unsupported without cef feature"
        );
        assert!(
            matches!(runtime.start(), Err(WebError::Unsupported(_))),
            "start should return Unsupported without cef feature"
        );
        assert!(
            matches!(
                BrowserView::create(std::ptr::null_mut(), Rect::default(), "http://127.0.0.1"),
                Err(WebError::Unsupported(_))
            ),
            "BrowserView::create should return Unsupported without cef feature"
        );
    }
}
