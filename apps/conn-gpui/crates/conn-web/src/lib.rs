//! Embedded Chromium (CEF-on-demand) browser runtime for `conn-gpui`.
//!
//! Reference implementation: `.refs/threadbear/desktop/web/` (`cef-rs` + `dlopen` loader +
//! CEF offscreen rendering).
//!
//! CEF is always compiled in. It is downloaded on first use at runtime (see
//! [`WebRuntime::ensure_installed`]), never during the build. On non-macOS targets the full
//! public API remains available and returns [`WebRuntimeState::NotInstalled`] /
//! [`WebError::Unsupported`].

mod archive;
#[cfg(any(target_os = "macos", test))]
mod context_menu;
mod download;
mod load_error;
#[cfg(target_os = "macos")]
mod mac;
mod menu;
mod trace;

pub use load_error::{LoadError, net_error_name};
pub use trace::{LOG_PATH as TRACE_LOG_PATH, trace};

pub use menu::{
    Answer as MenuAnswer, ContextMenuEvent, ContextMenuReply, ContextMenuRequest, MenuEntry,
};

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

/// Snapshot of the latest BGRA frame rendered by CEF offscreen rendering.
#[derive(Clone, Debug)]
pub struct FrameSnapshot {
    /// Monotonically increasing frame counter (0 before the first paint).
    pub generation: u64,
    /// Pixel width of `bgra` (scaled by the display's device scale factor).
    pub width: u32,
    /// Pixel height of `bgra` (scaled by the display's device scale factor).
    pub height: u32,
    /// Premultiplied 32-bit BGRA pixels in row-major top-to-bottom order (`width * height * 4` bytes).
    pub bgra: Vec<u8>,
}

/// Keyboard and mouse modifier flags forwarded to CEF.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct Modifiers {
    pub shift: bool,
    pub control: bool,
    pub alt: bool,
    pub command: bool,
    pub left_button: bool,
    pub middle_button: bool,
    pub right_button: bool,
    pub is_repeat: bool,
}

/// Mouse button forwarded to CEF.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum MouseButton {
    #[default]
    Left,
    Middle,
    Right,
}

/// Kind of keyboard event forwarded to CEF.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum KeyEventKind {
    #[default]
    RawKeyDown,
    KeyDown,
    KeyUp,
    Char,
}

/// Keyboard event forwarded to CEF.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct KeyEvent {
    pub kind: KeyEventKind,
    pub windows_key_code: i32,
    pub native_key_code: i32,
    pub character: u16,
    pub unmodified_character: u16,
    pub modifiers: Modifiers,
    pub is_system_key: bool,
}

/// Standard edit command dispatched directly to the focused frame.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum EditCommand {
    Copy,
    Cut,
    Paste,
    SelectAll,
    Undo,
    Redo,
}

/// Cursor kind requested by the rendered web page.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum CursorKind {
    #[default]
    Default,
    Pointer,
    Text,
    Crosshair,
    Move,
    Wait,
    NotAllowed,
    Grab,
    Grabbing,
    ResizeEW,
    ResizeNS,
    ResizeNESW,
    ResizeNWSE,
    ResizeCol,
    ResizeRow,
    VerticalText,
    ContextMenu,
    Alias,
    Copy,
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
    #[cfg(target_os = "macos")]
    {
        mac::helper::maybe_run_subprocess()
    }
    #[cfg(not(target_os = "macos"))]
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
        #[cfg(target_os = "macos")]
        {
            mac::host::state()
        }
        #[cfg(not(target_os = "macos"))]
        {
            WebRuntimeState::NotInstalled
        }
    }

    /// Returns `true` if the pinned CEF framework is already installed on disk.
    #[must_use]
    pub fn is_installed(&self) -> bool {
        #[cfg(target_os = "macos")]
        {
            let Some(archive) = archive::current_archive() else {
                return false;
            };
            let Ok(root) = archive::Layout::default_root() else {
                return false;
            };
            archive::is_installed(&archive::Layout::new(root), &archive.pin())
        }
        #[cfg(not(target_os = "macos"))]
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
        #[cfg(target_os = "macos")]
        {
            let root = archive::Layout::default_root()?;
            Ok(archive::Layout::new(root).version_dir())
        }
        #[cfg(not(target_os = "macos"))]
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
        #[cfg(target_os = "macos")]
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
        #[cfg(not(target_os = "macos"))]
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
        #[cfg(target_os = "macos")]
        {
            mac::host::start(options)
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = options;
            Err(WebError::Unsupported(
                "enable the `cef` feature on macOS to start CEF",
            ))
        }
    }

    /// Gets everything ready that [`WebRuntime::start`] needs and that can happen off the main
    /// thread: the helper apps are built and signed, which takes seconds after a new build. Does
    /// nothing, and returns [`WebError::NotInstalled`], until CEF has been downloaded.
    ///
    /// # Errors
    /// Returns [`WebError::NotInstalled`] before the download, or [`WebError::Runtime`] when the
    /// helpers cannot be built.
    pub fn prepare(&self) -> Result<(), WebError> {
        #[cfg(target_os = "macos")]
        {
            mac::host::prepare()
        }
        #[cfg(not(target_os = "macos"))]
        {
            Err(WebError::Unsupported(
                "CEF is not supported on this platform",
            ))
        }
    }

    /// Maps the CEF framework into the process ahead of [`WebRuntime::start`], so the main
    /// thread does not wait for the load. Safe on any thread, and repeatable.
    ///
    /// # Errors
    /// Returns [`WebError::NotInstalled`] before the download, or [`WebError::Runtime`] when the
    /// framework cannot be loaded.
    pub fn preload_framework(&self) -> Result<(), WebError> {
        #[cfg(target_os = "macos")]
        {
            mac::host::preload_framework()
        }
        #[cfg(not(target_os = "macos"))]
        {
            Err(WebError::Unsupported(
                "CEF is not supported on this platform",
            ))
        }
    }

    /// Requests Chromium's nested message loop to exit, if running.
    pub fn quit(&self) {
        #[cfg(target_os = "macos")]
        {
            mac::host::quit();
        }
    }
}

/// A response that may carry the Laravel Toolbar's data (`x-toolbar`, `x-toolbar-summary`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolbarResponse {
    /// The main frame's document; otherwise a fetch or XHR.
    pub document: bool,
    pub method: String,
    pub url: String,
    pub full: Option<String>,
    pub summary: Option<String>,
}

/// Handle to an offscreen-rendered embedded Chromium view.
#[derive(Debug)]
pub struct BrowserView {
    #[cfg(target_os = "macos")]
    inner: mac::view::MacBrowserView,
    #[cfg(not(target_os = "macos"))]
    _private: (),
}

impl BrowserView {
    /// Creates a new offscreen-rendered Chromium view sized to `bounds` at `scale`.
    ///
    /// Must be called on the main thread after [`WebRuntime::state`] reaches
    /// [`WebRuntimeState::Running`].
    ///
    /// # Errors
    ///
    /// Returns [`WebError::Unsupported`] without the `cef` feature on macOS,
    /// [`WebError::NotRunning`] if the runtime is not running, or
    /// [`WebError::Runtime`] if CEF fails to create the browser.
    pub fn create(bounds: Rect, scale: f32, url: &str) -> Result<Self, WebError> {
        #[cfg(target_os = "macos")]
        {
            let inner = mac::view::MacBrowserView::create(bounds, scale, url)?;
            Ok(Self { inner })
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (bounds, scale, url);
            Err(WebError::Unsupported(
                "enable the `cef` feature on macOS to create a BrowserView",
            ))
        }
    }

    /// Updates the offscreen viewport size in logical points and device scale factor.
    pub fn set_size(&self, width: f32, height: f32, scale: f32) {
        #[cfg(target_os = "macos")]
        self.inner.set_size(width, height, scale);
        #[cfg(not(target_os = "macos"))]
        let _ = (width, height, scale);
    }

    /// Navigates the main frame to `url`.
    pub fn load_url(&self, url: &str) {
        #[cfg(target_os = "macos")]
        self.inner.load_url(url);
        #[cfg(not(target_os = "macos"))]
        let _ = url;
    }

    /// Navigates back in session history, if possible.
    pub fn go_back(&self) {
        #[cfg(target_os = "macos")]
        self.inner.go_back();
    }

    /// Navigates forward in session history, if possible.
    pub fn go_forward(&self) {
        #[cfg(target_os = "macos")]
        self.inner.go_forward();
    }

    /// Reloads the current page.
    pub fn reload(&self) {
        #[cfg(target_os = "macos")]
        self.inner.reload();
    }

    /// Returns the current main-frame URL.
    #[must_use]
    pub fn url(&self) -> String {
        #[cfg(target_os = "macos")]
        {
            self.inner.url()
        }
        #[cfg(not(target_os = "macos"))]
        {
            String::new()
        }
    }

    /// Returns the current document title.
    #[must_use]
    pub fn title(&self) -> String {
        #[cfg(target_os = "macos")]
        {
            self.inner.title()
        }
        #[cfg(not(target_os = "macos"))]
        {
            String::new()
        }
    }

    /// Returns `true` if the browser can navigate back.
    #[must_use]
    pub fn can_go_back(&self) -> bool {
        #[cfg(target_os = "macos")]
        {
            self.inner.can_go_back()
        }
        #[cfg(not(target_os = "macos"))]
        {
            false
        }
    }

    /// Returns `true` if the browser can navigate forward.
    #[must_use]
    pub fn can_go_forward(&self) -> bool {
        #[cfg(target_os = "macos")]
        {
            self.inner.can_go_forward()
        }
        #[cfg(not(target_os = "macos"))]
        {
            false
        }
    }

    /// Returns `true` while the browser is loading.
    #[must_use]
    pub fn is_loading(&self) -> bool {
        #[cfg(target_os = "macos")]
        {
            self.inner.is_loading()
        }
        #[cfg(not(target_os = "macos"))]
        {
            false
        }
    }

    /// Returns the number of completed main-frame loads.
    #[must_use]
    pub fn load_count(&self) -> u32 {
        #[cfg(target_os = "macos")]
        {
            self.inner.load_count()
        }
        #[cfg(not(target_os = "macos"))]
        {
            0
        }
    }

    /// Returns the monotonically increasing frame generation (0 before the first paint).
    #[must_use]
    pub fn frame_generation(&self) -> u64 {
        #[cfg(target_os = "macos")]
        {
            self.inner.frame_generation()
        }
        #[cfg(not(target_os = "macos"))]
        {
            0
        }
    }

    /// Returns a copy of the latest BGRA frame if its generation is strictly greater than `last_generation`.
    #[must_use]
    pub fn frame_if_newer(&self, last_generation: u64) -> Option<FrameSnapshot> {
        #[cfg(target_os = "macos")]
        {
            self.inner.frame_if_newer(last_generation)
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = last_generation;
            None
        }
    }

    /// Returns the cursor style currently requested by the page.
    #[must_use]
    pub fn cursor(&self) -> CursorKind {
        #[cfg(target_os = "macos")]
        {
            self.inner.cursor()
        }
        #[cfg(not(target_os = "macos"))]
        {
            CursorKind::Default
        }
    }

    /// Registers a callback invoked when a new frame paints or browser UI state changes.
    pub fn on_frame(&self, callback: impl Fn() + Send + Sync + 'static) {
        #[cfg(target_os = "macos")]
        self.inner.on_frame(callback);
        #[cfg(not(target_os = "macos"))]
        let _ = callback;
    }

    /// Registers a callback invoked when the main frame starts a new document, before the page's
    /// own scripts run, receiving its URL.
    pub fn on_load_start(&self, callback: impl Fn(&str) + Send + Sync + 'static) {
        #[cfg(target_os = "macos")]
        self.inner.on_load_start(callback);
        #[cfg(not(target_os = "macos"))]
        let _ = callback;
    }

    /// Registers a callback for each document and fetch/XHR response (any thread), with the
    /// Laravel Toolbar headers it carries. Pages with a Content-Security-Policy get no inline
    /// toolbar data, so the host reads the headers instead.
    pub fn on_toolbar_response(&self, callback: impl Fn(ToolbarResponse) + Send + Sync + 'static) {
        #[cfg(target_os = "macos")]
        self.inner.on_toolbar_response(callback);
        #[cfg(not(target_os = "macos"))]
        let _ = callback;
    }

    /// Registers a callback invoked whenever the main frame finishes loading,
    /// receiving `(url, http_status_code)`.
    pub fn on_load_end(&self, callback: impl Fn(&str, i32) + Send + Sync + 'static) {
        #[cfg(target_os = "macos")]
        self.inner.on_load_end(callback);
        #[cfg(not(target_os = "macos"))]
        let _ = callback;
    }

    /// Why the last main-frame load failed, until the next load starts. A navigation that was
    /// only replaced (`ERR_ABORTED`) is not reported.
    #[must_use]
    pub fn load_error(&self) -> Option<LoadError> {
        #[cfg(target_os = "macos")]
        {
            self.inner.load_error()
        }
        #[cfg(not(target_os = "macos"))]
        {
            None
        }
    }

    /// Registers the host's right-click menu. The view is windowless, so Chromium draws no menu
    /// of its own: it sends [`ContextMenuEvent::Open`] with the finished rows and waits for the
    /// request's reply. Without a callback, right-clicking shows nothing. The callback runs on
    /// the main thread.
    pub fn on_context_menu(&self, callback: impl Fn(ContextMenuEvent) + Send + Sync + 'static) {
        #[cfg(target_os = "macos")]
        self.inner.on_context_menu(callback);
        #[cfg(not(target_os = "macos"))]
        let _ = callback;
    }

    /// Opens Chrome DevTools in a separate top-level window (a window that is already open is
    /// brought forward). With `inspect_at` (view coordinates in logical points), DevTools
    /// opens with the element at that point selected.
    pub fn show_dev_tools(&self, inspect_at: Option<(i32, i32)>) {
        #[cfg(target_os = "macos")]
        self.inner.show_dev_tools(inspect_at);
        #[cfg(not(target_os = "macos"))]
        let _ = inspect_at;
    }

    /// Closes the DevTools window, if open.
    pub fn close_dev_tools(&self) {
        #[cfg(target_os = "macos")]
        self.inner.close_dev_tools();
    }

    /// Returns `true` while a DevTools window is open for this view.
    #[must_use]
    pub fn has_dev_tools(&self) -> bool {
        #[cfg(target_os = "macos")]
        {
            self.inner.has_dev_tools()
        }
        #[cfg(not(target_os = "macos"))]
        {
            false
        }
    }

    /// Registers a callback invoked for the detector bridge's console messages. Returning `true`
    /// consumes a message so it stays out of Chromium's log; any message it does not consume
    /// (returns `false`) is left alone, and DevTools' Console shows every message either way.
    pub fn on_console_message(&self, callback: impl Fn(&str) -> bool + Send + Sync + 'static) {
        #[cfg(target_os = "macos")]
        self.inner.on_console_message(callback);
        #[cfg(not(target_os = "macos"))]
        let _ = callback;
    }

    /// Evaluates JavaScript in the main frame's V8 context.
    pub fn execute_javascript(&self, code: &str) {
        #[cfg(target_os = "macos")]
        self.inner.execute_javascript(code);
        #[cfg(not(target_os = "macos"))]
        let _ = code;
    }

    /// Returns a copy of the latest rendered BGRA frame, if at least one frame has painted.
    #[must_use]
    pub fn latest_frame(&self) -> Option<FrameSnapshot> {
        self.frame_if_newer(0)
    }

    /// Tells CEF whether the view is hidden so it pauses offscreen painting and mutes audio.
    pub fn set_hidden(&self, hidden: bool) {
        #[cfg(target_os = "macos")]
        self.inner.set_hidden(hidden);
        #[cfg(not(target_os = "macos"))]
        let _ = hidden;
    }

    /// Returns `true` if the view is currently hidden.
    #[must_use]
    pub fn is_hidden(&self) -> bool {
        #[cfg(target_os = "macos")]
        {
            self.inner.is_hidden()
        }
        #[cfg(not(target_os = "macos"))]
        {
            true
        }
    }

    /// Updates CEF's logical focus state.
    pub fn set_focus(&self, focused: bool) {
        #[cfg(target_os = "macos")]
        self.inner.set_focus(focused);
        #[cfg(not(target_os = "macos"))]
        let _ = focused;
    }

    /// Forwards a pointer move (or leave) event in logical viewport points.
    pub fn send_mouse_move(&self, x: i32, y: i32, modifiers: Modifiers, mouse_leave: bool) {
        #[cfg(target_os = "macos")]
        self.inner.send_mouse_move(x, y, modifiers, mouse_leave);
        #[cfg(not(target_os = "macos"))]
        let _ = (x, y, modifiers, mouse_leave);
    }

    /// Forwards a mouse button press in logical viewport points.
    pub fn send_mouse_down(
        &self,
        x: i32,
        y: i32,
        button: MouseButton,
        click_count: i32,
        modifiers: Modifiers,
    ) {
        #[cfg(target_os = "macos")]
        self.inner
            .send_mouse_down(x, y, button, click_count, modifiers);
        #[cfg(not(target_os = "macos"))]
        let _ = (x, y, button, click_count, modifiers);
    }

    /// Forwards a mouse button release in logical viewport points.
    pub fn send_mouse_up(
        &self,
        x: i32,
        y: i32,
        button: MouseButton,
        click_count: i32,
        modifiers: Modifiers,
    ) {
        #[cfg(target_os = "macos")]
        self.inner
            .send_mouse_up(x, y, button, click_count, modifiers);
        #[cfg(not(target_os = "macos"))]
        let _ = (x, y, button, click_count, modifiers);
    }

    /// Forwards a mouse wheel / trackpad scroll event in logical viewport points.
    pub fn send_mouse_wheel(
        &self,
        x: i32,
        y: i32,
        delta_x: i32,
        delta_y: i32,
        modifiers: Modifiers,
    ) {
        #[cfg(target_os = "macos")]
        self.inner
            .send_mouse_wheel(x, y, delta_x, delta_y, modifiers);
        #[cfg(not(target_os = "macos"))]
        let _ = (x, y, delta_x, delta_y, modifiers);
    }

    /// Forwards a keyboard event to CEF.
    pub fn send_key_event(&self, event: KeyEvent) {
        #[cfg(target_os = "macos")]
        self.inner.send_key_event(event);
        #[cfg(not(target_os = "macos"))]
        let _ = event;
    }

    /// Executes a standard edit command on the focused frame.
    pub fn execute_edit_command(&self, command: EditCommand) {
        #[cfg(target_os = "macos")]
        self.inner.execute_edit_command(command);
        #[cfg(not(target_os = "macos"))]
        let _ = command;
    }

    /// Closes the offscreen browser.
    pub fn close(self) {
        #[cfg(target_os = "macos")]
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
}
