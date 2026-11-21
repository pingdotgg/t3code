//! Native macOS CEF child view (`NSView`) hosted inside a parent window view.

use super::host::{conn_view_remove, conn_view_set_frame, conn_view_set_hidden};
use crate::{Rect, WebError, WebRuntimeState};
use cef::*;
use std::cell::Cell;
use std::ffi::c_void;
use std::fmt;
use std::os::raw::c_int;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

type LoadEndCallback = Box<dyn Fn(&str, i32) + Send + Sync>;

struct Shared {
    url: Mutex<String>,
    title: Mutex<String>,
    loading: AtomicBool,
    can_go_back: AtomicBool,
    can_go_forward: AtomicBool,
    load_count: AtomicU32,
    on_load_end: Mutex<Option<LoadEndCallback>>,
}

/// Handle to a native CEF browser view embedded as a child `NSView`.
pub(crate) struct MacBrowserView {
    browser: Browser,
    view: *mut c_void,
    bounds: Cell<Rect>,
    hidden: Cell<bool>,
    closed: Cell<bool>,
    shared: Arc<Shared>,
}

impl fmt::Debug for MacBrowserView {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("MacBrowserView")
            .field("url", &self.url())
            .field("title", &self.title())
            .field("bounds", &self.bounds.get())
            .field("hidden", &self.hidden.get())
            .field("closed", &self.closed.get())
            .finish()
    }
}

impl MacBrowserView {
    pub(crate) fn create(
        parent_ns_view: *mut c_void,
        bounds: Rect,
        url: &str,
    ) -> Result<Self, WebError> {
        if super::host::state() != WebRuntimeState::Running {
            return Err(WebError::NotRunning);
        }
        if parent_ns_view.is_null() {
            return Err(WebError::InvalidArgument(
                "parent_ns_view must not be null".into(),
            ));
        }

        let shared = Arc::new(Shared {
            url: Mutex::new(url.to_owned()),
            title: Mutex::new(String::new()),
            loading: AtomicBool::new(true),
            can_go_back: AtomicBool::new(false),
            can_go_forward: AtomicBool::new(false),
            load_count: AtomicU32::new(0),
            on_load_end: Mutex::new(None),
        });

        let window_info = WindowInfo {
            runtime_style: RuntimeStyle::ALLOY,
            ..WindowInfo::default()
        }
        .set_as_child(
            parent_ns_view,
            &cef::Rect {
                x: bounds.x.round() as i32,
                y: bounds.y.round() as i32,
                width: bounds.width.max(1.0).round() as i32,
                height: bounds.height.max(1.0).round() as i32,
            },
        );

        let settings = BrowserSettings {
            javascript_access_clipboard: State::DISABLED,
            ..Default::default()
        };

        let mut client = ViewClient::new(
            ViewLifeSpan::new(),
            ViewLoadHandler::new(shared.clone()),
            ViewDisplayHandler::new(shared.clone()),
        );

        let mut context = request_context_get_global_context();
        let browser = browser_host_create_browser_sync(
            Some(&window_info),
            Some(&mut client),
            Some(&CefString::from(url)),
            Some(&settings),
            None,
            context.as_mut(),
        )
        .ok_or_else(|| WebError::Runtime("CEF failed to create browser view".into()))?;

        let host = browser
            .host()
            .ok_or_else(|| WebError::Runtime("created CEF browser has no host".into()))?;
        let view = host.window_handle();

        // SAFETY: `view` is the newly created CEF child `NSView` (or null, which
        // the shim ignores), alive inside `parent_ns_view` on the main thread.
        unsafe {
            conn_view_set_frame(
                view,
                f64::from(bounds.x),
                f64::from(bounds.y),
                f64::from(bounds.width),
                f64::from(bounds.height),
            );
        }
        host.was_resized();

        Ok(Self {
            browser,
            view,
            bounds: Cell::new(bounds),
            hidden: Cell::new(false),
            closed: Cell::new(false),
            shared,
        })
    }

    pub(crate) fn set_bounds(&self, bounds: Rect) {
        if self.closed.get() || self.bounds.get() == bounds {
            return;
        }
        self.bounds.set(bounds);
        // SAFETY: `self.view` is this browser's `NSView`, alive until `close_inner`
        // removes it; `MacBrowserView` is `!Send` so this runs on the main thread.
        unsafe {
            conn_view_set_frame(
                self.view,
                f64::from(bounds.x),
                f64::from(bounds.y),
                f64::from(bounds.width),
                f64::from(bounds.height),
            );
        }
        if let Some(host) = self.browser.host() {
            host.was_resized();
        }
    }

    pub(crate) fn load_url(&self, url: &str) {
        if self.closed.get() {
            return;
        }
        if let Ok(mut current) = self.shared.url.lock() {
            *current = url.to_owned();
        }
        if let Some(frame) = self.browser.main_frame() {
            frame.load_url(Some(&CefString::from(url)));
        }
    }

    pub(crate) fn go_back(&self) {
        if !self.closed.get() {
            self.browser.go_back();
        }
    }

    pub(crate) fn go_forward(&self) {
        if !self.closed.get() {
            self.browser.go_forward();
        }
    }

    pub(crate) fn reload(&self) {
        if !self.closed.get() {
            self.browser.reload();
        }
    }

    pub(crate) fn url(&self) -> String {
        self.shared
            .url
            .lock()
            .map(|u| u.clone())
            .unwrap_or_default()
    }

    pub(crate) fn title(&self) -> String {
        self.shared
            .title
            .lock()
            .map(|t| t.clone())
            .unwrap_or_default()
    }

    pub(crate) fn can_go_back(&self) -> bool {
        self.shared.can_go_back.load(Ordering::Acquire)
    }

    pub(crate) fn can_go_forward(&self) -> bool {
        self.shared.can_go_forward.load(Ordering::Acquire)
    }

    pub(crate) fn is_loading(&self) -> bool {
        self.shared.loading.load(Ordering::Acquire)
    }

    pub(crate) fn load_count(&self) -> u32 {
        self.shared.load_count.load(Ordering::Acquire)
    }

    pub(crate) fn on_load_end(&self, callback: impl Fn(&str, i32) + Send + Sync + 'static) {
        if let Ok(mut slot) = self.shared.on_load_end.lock() {
            *slot = Some(Box::new(callback));
        }
    }

    pub(crate) fn set_hidden(&self, hidden: bool) {
        if self.closed.get() || self.hidden.get() == hidden {
            return;
        }
        self.hidden.set(hidden);
        // SAFETY: `self.view` is this browser's `NSView`, alive until `close_inner`
        // removes it; `MacBrowserView` is `!Send` so this runs on the main thread.
        unsafe { conn_view_set_hidden(self.view, hidden) };
        if let Some(host) = self.browser.host() {
            host.was_hidden(i32::from(hidden));
            host.set_audio_muted(i32::from(hidden));
        }
    }

    pub(crate) fn is_hidden(&self) -> bool {
        self.hidden.get()
    }

    pub(crate) fn close_inner(&self) {
        if self.closed.replace(true) {
            return;
        }
        if let Ok(mut slot) = self.shared.on_load_end.lock() {
            slot.take();
        }
        // Removing the child NSView tears down the CEF browser via
        // CefBrowserHostView's dealloc without closing the host NSWindow.
        // SAFETY: `self.view` is this browser's `NSView`, alive in its parent
        // until removed here once on the main thread.
        unsafe { conn_view_remove(self.view) };
    }
}

impl Drop for MacBrowserView {
    fn drop(&mut self) {
        self.close_inner();
    }
}

wrap_client! {
    struct ViewClient {
        life: LifeSpanHandler,
        loads: LoadHandler,
        display: DisplayHandler,
    }

    impl Client {
        fn life_span_handler(&self) -> Option<LifeSpanHandler> {
            Some(self.life.clone())
        }
        fn load_handler(&self) -> Option<LoadHandler> {
            Some(self.loads.clone())
        }
        fn display_handler(&self) -> Option<DisplayHandler> {
            Some(self.display.clone())
        }
    }
}

wrap_life_span_handler! {
    struct ViewLifeSpan;

    impl LifeSpanHandler {
        // Prevent a page's `window.close()` or CEF's `CloseHostWindow` from
        // closing the parent GPUI/AppKit window.
        fn do_close(&self, _browser: Option<&mut Browser>) -> c_int {
            1
        }
    }
}

wrap_load_handler! {
    struct ViewLoadHandler {
        shared: Arc<Shared>,
    }

    impl LoadHandler {
        fn on_loading_state_change(
            &self,
            _browser: Option<&mut Browser>,
            is_loading: c_int,
            can_go_back: c_int,
            can_go_forward: c_int,
        ) {
            self.shared.loading.store(is_loading == 1, Ordering::Release);
            self.shared
                .can_go_back
                .store(can_go_back == 1, Ordering::Release);
            self.shared
                .can_go_forward
                .store(can_go_forward == 1, Ordering::Release);
        }

        fn on_load_end(
            &self,
            _browser: Option<&mut Browser>,
            frame: Option<&mut Frame>,
            http_status_code: c_int,
        ) {
            if !frame.as_ref().is_some_and(|f| f.is_main() == 1) {
                return;
            }
            self.shared.load_count.fetch_add(1, Ordering::AcqRel);
            let url = frame
                .map(|f| CefString::from(&f.url()).to_string())
                .unwrap_or_default();
            if let Ok(mut current) = self.shared.url.lock() {
                if !url.is_empty() {
                    *current = url.clone();
                }
            }
            if let Ok(cb) = self.shared.on_load_end.lock() {
                if let Some(callback) = cb.as_ref() {
                    callback(&url, http_status_code);
                }
            }
        }
    }
}

wrap_display_handler! {
    struct ViewDisplayHandler {
        shared: Arc<Shared>,
    }

    impl DisplayHandler {
        fn on_title_change(&self, _browser: Option<&mut Browser>, title: Option<&CefString>) {
            if let Ok(mut current) = self.shared.title.lock() {
                *current = title.map(|t| t.to_string()).unwrap_or_default();
            }
        }

        fn on_address_change(
            &self,
            _browser: Option<&mut Browser>,
            frame: Option<&mut Frame>,
            url: Option<&CefString>,
        ) {
            if !frame.is_some_and(|f| f.is_main() == 1) {
                return;
            }
            if let Ok(mut current) = self.shared.url.lock() {
                *current = url.map(|u| u.to_string()).unwrap_or_default();
            }
        }
    }
}
