//! Offscreen-rendered (OSR) CEF browser view on macOS.
//!
//! Renders pages into an in-memory 32-bit BGRA frame buffer at the display's
//! device scale factor and forwards mouse, wheel, keyboard, and focus events
//! explicitly from GPUI.

use crate::context_menu::{self, ContextCommand, Entry, LinkTarget, MenuParams};
use crate::load_error::{self, LoadError};
use crate::menu::{
    self, Answer, ContextMenuEvent, ContextMenuReply, ContextMenuRequest, RawKind, RawMenuItem,
};
use crate::{
    CursorKind, EditCommand, FrameSnapshot, KeyEvent, KeyEventKind, Modifiers, MouseButton, Rect,
    WebError, WebRuntimeState,
};
use cef::*;
use std::cell::Cell;
use std::ffi::{CString, c_char};
use std::fmt;
use std::os::raw::c_int;
use std::sync::atomic::{AtomicBool, AtomicU8, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

const MAX_FRAME_RATE_FPS: i32 = 60;

type FrameCallback = Arc<dyn Fn() + Send + Sync>;
type LoadEndCallback = Arc<dyn Fn(&str, i32) + Send + Sync>;
type LoadStartCallback = Arc<dyn Fn(&str) + Send + Sync>;
type ConsoleMessageCallback = Arc<dyn Fn(&str) -> bool + Send + Sync>;
type ContextMenuCallback = Arc<dyn Fn(ContextMenuEvent) + Send + Sync>;

struct FrameBuffer {
    generation: u64,
    width: u32,
    height: u32,
    bgra: Vec<u8>,
}

struct Shared {
    size: Mutex<(i32, i32)>,
    scale: Mutex<f32>,
    frame: Mutex<FrameBuffer>,
    frame_generation: AtomicU64,
    cursor: AtomicU8,
    url: Mutex<String>,
    title: Mutex<String>,
    can_go_back: AtomicBool,
    can_go_forward: AtomicBool,
    load_count: AtomicU32,
    on_frame: Mutex<Option<FrameCallback>>,
    on_load_end: Mutex<Option<LoadEndCallback>>,
    on_load_start: Mutex<Option<LoadStartCallback>>,
    /// The Laravel Toolbar's response headers (`toolbar_hooks`); shared with the request handler.
    toolbar_response: super::toolbar_hooks::ToolbarResponseSlot,
    on_console_message: Mutex<Option<ConsoleMessageCallback>>,
    on_context_menu: Mutex<Option<ContextMenuCallback>>,
    /// When the last `load_url` was called, and how many paints came since (trace only).
    load_began: Mutex<Option<std::time::Instant>>,
    paints_since_load: AtomicU32,
    /// Why the last main-frame load failed, until the next load starts.
    load_error: Mutex<Option<LoadError>>,
}

impl Shared {
    /// Notes the start of a load, for the timings `CONN_WEB_TRACE=1` prints.
    fn mark_load_began(&self) {
        if let Ok(mut began) = self.load_began.lock() {
            *began = Some(std::time::Instant::now());
        }
        self.paints_since_load.store(0, Ordering::Release);
    }

    /// `"+123ms"` since the last `load_url`, or `"+?"` when none was made.
    fn since_load(&self) -> String {
        self.load_began
            .lock()
            .ok()
            .and_then(|began| *began)
            .map_or_else(
                || "+?".to_owned(),
                |t| format!("+{}ms", t.elapsed().as_millis()),
            )
    }

    fn notify_frame(&self) {
        let cb = self.on_frame.lock().ok().and_then(|slot| slot.clone());
        if let Some(callback) = cb {
            callback();
        }
    }
}

/// Handle to an offscreen-rendered CEF browser view.
pub(crate) struct MacBrowserView {
    browser: Browser,
    size: Cell<(i32, i32)>,
    scale: Cell<f32>,
    hidden: Cell<bool>,
    closed: Cell<bool>,
    shared: Arc<Shared>,
}

impl fmt::Debug for MacBrowserView {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("MacBrowserView")
            .field("url", &self.url())
            .field("title", &self.title())
            .field("size", &self.size.get())
            .field("scale", &self.scale.get())
            .field("hidden", &self.hidden.get())
            .field("closed", &self.closed.get())
            .field("frame_generation", &self.frame_generation())
            .finish()
    }
}

impl MacBrowserView {
    pub(crate) fn create(bounds: Rect, scale: f32, url: &str) -> Result<Self, WebError> {
        if super::host::state() != WebRuntimeState::Running {
            return Err(WebError::NotRunning);
        }

        let width = (bounds.width.max(1.0).round() as i32).max(1);
        let height = (bounds.height.max(1.0).round() as i32).max(1);
        let scale = if scale.is_finite() && scale >= 1.0 {
            scale
        } else {
            1.0
        };

        let shared = Arc::new(Shared {
            size: Mutex::new((width, height)),
            scale: Mutex::new(scale),
            frame: Mutex::new(FrameBuffer {
                generation: 0,
                width: 0,
                height: 0,
                bgra: Vec::new(),
            }),
            frame_generation: AtomicU64::new(0),
            cursor: AtomicU8::new(cursor_to_u8(CursorKind::Default)),
            url: Mutex::new(url.to_owned()),
            title: Mutex::new(String::new()),
            can_go_back: AtomicBool::new(false),
            can_go_forward: AtomicBool::new(false),
            load_count: AtomicU32::new(0),
            on_frame: Mutex::new(None),
            on_load_end: Mutex::new(None),
            on_load_start: Mutex::new(None),
            toolbar_response: Arc::new(Mutex::new(None)),
            on_console_message: Mutex::new(None),
            on_context_menu: Mutex::new(None),
            load_began: Mutex::new(None),
            paints_since_load: AtomicU32::new(0),
            load_error: Mutex::new(None),
        });

        let window_info = WindowInfo {
            runtime_style: RuntimeStyle::ALLOY,
            ..WindowInfo::default()
        }
        .set_as_windowless(std::ptr::null_mut());

        let settings = BrowserSettings {
            windowless_frame_rate: MAX_FRAME_RATE_FPS,
            javascript_access_clipboard: State::DISABLED,
            ..Default::default()
        };

        let mut client = ViewClient::new(
            ViewRenderHandler::new(shared.clone()),
            ViewLifeSpan::new(),
            ViewLoadHandler::new(shared.clone()),
            ViewDisplayHandler::new(shared.clone()),
            ViewContextMenu::new(shared.clone()),
            ViewDownloadHandler::new(),
            super::toolbar_hooks::ToolbarRequestHandler::new(shared.toolbar_response.clone()),
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
        .ok_or_else(|| WebError::Runtime("CEF failed to create offscreen browser view".into()))?;

        let host = browser
            .host()
            .ok_or_else(|| WebError::Runtime("created CEF browser has no host".into()))?;
        host.notify_screen_info_changed();
        host.was_resized();

        Ok(Self {
            browser,
            size: Cell::new((width, height)),
            scale: Cell::new(scale),
            hidden: Cell::new(false),
            closed: Cell::new(false),
            shared,
        })
    }

    pub(crate) fn set_size(&self, width: f32, height: f32, scale: f32) {
        if self.closed.get() {
            return;
        }
        let width = (width.max(1.0).round() as i32).max(1);
        let height = (height.max(1.0).round() as i32).max(1);
        let scale = if scale.is_finite() && scale >= 1.0 {
            scale
        } else {
            1.0
        };

        let size_changed = self.size.get() != (width, height);
        let scale_changed = (self.scale.get() - scale).abs() > f32::EPSILON;
        if !size_changed && !scale_changed {
            return;
        }

        self.size.set((width, height));
        self.scale.set(scale);

        if let Ok(mut shared_size) = self.shared.size.lock() {
            *shared_size = (width, height);
        }
        if let Ok(mut shared_scale) = self.shared.scale.lock() {
            *shared_scale = scale;
        }

        if let Some(host) = self.browser.host() {
            if scale_changed {
                host.notify_screen_info_changed();
            }
            host.was_resized();
        }
    }

    pub(crate) fn load_url(&self, url: &str) {
        trace(&format!("load_url {url}"));
        if self.closed.get() {
            return;
        }
        self.shared.mark_load_began();
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

    /// Whether the page is loading, as CEF says: a flag of our own began as `true` and stayed so
    /// for a page that never reported a loading state (such as the first `about:blank`), so the
    /// reload glyph kept spinning. `on_loading_state_change` still repaints on every change.
    pub(crate) fn is_loading(&self) -> bool {
        !self.closed.get() && self.browser.is_loading() == 1
    }

    pub(crate) fn load_count(&self) -> u32 {
        self.shared.load_count.load(Ordering::Acquire)
    }

    pub(crate) fn frame_generation(&self) -> u64 {
        self.shared.frame_generation.load(Ordering::Acquire)
    }

    pub(crate) fn frame_if_newer(&self, last_generation: u64) -> Option<FrameSnapshot> {
        let current = self.shared.frame_generation.load(Ordering::Acquire);
        if current == 0 || current <= last_generation {
            return None;
        }
        let guard = self.shared.frame.lock().ok()?;
        if guard.generation <= last_generation
            || guard.width == 0
            || guard.height == 0
            || guard.bgra.is_empty()
        {
            return None;
        }
        Some(FrameSnapshot {
            generation: guard.generation,
            width: guard.width,
            height: guard.height,
            bgra: guard.bgra.clone(),
        })
    }

    pub(crate) fn cursor(&self) -> CursorKind {
        cursor_from_u8(self.shared.cursor.load(Ordering::Acquire))
    }

    pub(crate) fn on_frame(&self, callback: impl Fn() + Send + Sync + 'static) {
        if let Ok(mut slot) = self.shared.on_frame.lock() {
            *slot = Some(Arc::new(callback));
        }
    }

    pub(crate) fn on_load_end(&self, callback: impl Fn(&str, i32) + Send + Sync + 'static) {
        if let Ok(mut slot) = self.shared.on_load_end.lock() {
            *slot = Some(Arc::new(callback));
        }
    }

    pub(crate) fn on_load_start(&self, callback: impl Fn(&str) + Send + Sync + 'static) {
        if let Ok(mut slot) = self.shared.on_load_start.lock() {
            *slot = Some(Arc::new(callback));
        }
    }

    pub(crate) fn on_toolbar_response(
        &self,
        callback: impl Fn(crate::ToolbarResponse) + Send + Sync + 'static,
    ) {
        if let Ok(mut slot) = self.shared.toolbar_response.lock() {
            *slot = Some(Arc::new(callback));
        }
    }

    pub(crate) fn load_error(&self) -> Option<LoadError> {
        self.shared.load_error.lock().ok().and_then(|e| e.clone())
    }

    pub(crate) fn on_context_menu(
        &self,
        callback: impl Fn(ContextMenuEvent) + Send + Sync + 'static,
    ) {
        if let Ok(mut slot) = self.shared.on_context_menu.lock() {
            *slot = Some(Arc::new(callback));
        }
    }

    pub(crate) fn on_console_message(
        &self,
        callback: impl Fn(&str) -> bool + Send + Sync + 'static,
    ) {
        if let Ok(mut slot) = self.shared.on_console_message.lock() {
            *slot = Some(Arc::new(callback));
        }
    }

    pub(crate) fn execute_javascript(&self, code: &str) {
        if self.closed.get() {
            return;
        }
        if let Some(frame) = self.browser.main_frame() {
            frame.execute_java_script(
                Some(&CefString::from(code)),
                Some(&CefString::from("conn://annotations")),
                0,
            );
        }
    }

    pub(crate) fn set_hidden(&self, hidden: bool) {
        trace(&format!("set_hidden {hidden}"));
        if self.closed.get() || self.hidden.get() == hidden {
            return;
        }
        self.hidden.set(hidden);
        if let Some(host) = self.browser.host() {
            host.was_hidden(i32::from(hidden));
            host.set_audio_muted(i32::from(hidden));
            if !hidden {
                host.invalidate(PaintElementType::VIEW);
            }
        }
    }

    pub(crate) fn is_hidden(&self) -> bool {
        self.hidden.get()
    }

    pub(crate) fn set_focus(&self, focused: bool) {
        if self.closed.get() {
            return;
        }
        if let Some(host) = self.browser.host() {
            host.set_focus(i32::from(focused));
        }
    }

    pub(crate) fn send_mouse_move(&self, x: i32, y: i32, modifiers: Modifiers, mouse_leave: bool) {
        if self.closed.get() {
            return;
        }
        if let Some(host) = self.browser.host() {
            let event = cef::MouseEvent {
                x,
                y,
                modifiers: modifiers_to_cef_flags(modifiers),
            };
            host.send_mouse_move_event(Some(&event), i32::from(mouse_leave));
        }
    }

    pub(crate) fn send_mouse_down(
        &self,
        x: i32,
        y: i32,
        button: MouseButton,
        click_count: i32,
        modifiers: Modifiers,
    ) {
        if self.closed.get() {
            return;
        }
        if let Some(host) = self.browser.host() {
            let event = cef::MouseEvent {
                x,
                y,
                modifiers: modifiers_to_cef_flags(modifiers),
            };
            host.send_mouse_click_event(
                Some(&event),
                mouse_button_to_cef(button),
                0,
                click_count.max(1),
            );
        }
    }

    pub(crate) fn send_mouse_up(
        &self,
        x: i32,
        y: i32,
        button: MouseButton,
        click_count: i32,
        modifiers: Modifiers,
    ) {
        if self.closed.get() {
            return;
        }
        if let Some(host) = self.browser.host() {
            let event = cef::MouseEvent {
                x,
                y,
                modifiers: modifiers_to_cef_flags(modifiers),
            };
            host.send_mouse_click_event(
                Some(&event),
                mouse_button_to_cef(button),
                1,
                click_count.max(1),
            );
        }
    }

    pub(crate) fn send_mouse_wheel(
        &self,
        x: i32,
        y: i32,
        delta_x: i32,
        delta_y: i32,
        modifiers: Modifiers,
    ) {
        if self.closed.get() {
            return;
        }
        if let Some(host) = self.browser.host() {
            let event = cef::MouseEvent {
                x,
                y,
                modifiers: modifiers_to_cef_flags(modifiers),
            };
            host.send_mouse_wheel_event(Some(&event), delta_x, delta_y);
        }
    }

    pub(crate) fn send_key_event(&self, event: KeyEvent) {
        if self.closed.get() {
            return;
        }
        if let Some(host) = self.browser.host() {
            let cef_event = cef::KeyEvent {
                type_: match event.kind {
                    KeyEventKind::RawKeyDown => KeyEventType::RAWKEYDOWN,
                    KeyEventKind::KeyDown => KeyEventType::KEYDOWN,
                    KeyEventKind::KeyUp => KeyEventType::KEYUP,
                    KeyEventKind::Char => KeyEventType::CHAR,
                },
                modifiers: modifiers_to_cef_flags(event.modifiers),
                windows_key_code: event.windows_key_code,
                native_key_code: event.native_key_code,
                is_system_key: i32::from(event.is_system_key),
                character: event.character,
                unmodified_character: event.unmodified_character,
                focus_on_editable_field: 0,
                ..Default::default()
            };
            host.send_key_event(Some(&cef_event));
        }
    }

    pub(crate) fn execute_edit_command(&self, command: EditCommand) {
        if self.closed.get() {
            return;
        }
        let frame = self
            .browser
            .focused_frame()
            .or_else(|| self.browser.main_frame());
        let Some(frame) = frame else {
            return;
        };
        match command {
            EditCommand::Copy => frame.copy(),
            EditCommand::Cut => frame.cut(),
            EditCommand::Paste => frame.paste(),
            EditCommand::SelectAll => frame.select_all(),
            EditCommand::Undo => frame.undo(),
            EditCommand::Redo => frame.redo(),
        }
    }

    pub(crate) fn close_inner(&self) {
        if self.closed.replace(true) {
            return;
        }
        if let Ok(mut slot) = self.shared.on_frame.lock() {
            slot.take();
        }
        if let Ok(mut slot) = self.shared.on_load_end.lock() {
            slot.take();
        }
        if let Ok(mut slot) = self.shared.on_console_message.lock() {
            slot.take();
        }
        if let Some(host) = self.browser.host() {
            host.close_dev_tools();
            host.close_browser(1);
        }
    }

    /// Opens Chrome DevTools in a separate window, inspecting the element at `inspect_at`
    /// (view coordinates) when given.
    pub(crate) fn show_dev_tools(&self, inspect_at: Option<(i32, i32)>) {
        if self.closed.get() {
            return;
        }
        open_dev_tools(&self.browser, inspect_at);
    }

    /// Closes the DevTools window, if open.
    pub(crate) fn close_dev_tools(&self) {
        if self.closed.get() {
            return;
        }
        if let Some(host) = self.browser.host() {
            host.close_dev_tools();
        }
    }

    /// Returns `true` while a DevTools window is open for this view.
    pub(crate) fn has_dev_tools(&self) -> bool {
        !self.closed.get()
            && self
                .browser
                .host()
                .is_some_and(|host| host.has_dev_tools() == 1)
    }
}

impl Drop for MacBrowserView {
    fn drop(&mut self) {
        self.close_inner();
    }
}

fn modifiers_to_cef_flags(modifiers: Modifiers) -> u32 {
    use cef::sys::cef_event_flags_t;
    let mut flags: u32 = 0;
    if modifiers.shift {
        flags |= cef_event_flags_t::EVENTFLAG_SHIFT_DOWN.0;
    }
    if modifiers.control {
        flags |= cef_event_flags_t::EVENTFLAG_CONTROL_DOWN.0;
    }
    if modifiers.alt {
        flags |= cef_event_flags_t::EVENTFLAG_ALT_DOWN.0;
    }
    if modifiers.command {
        flags |= cef_event_flags_t::EVENTFLAG_COMMAND_DOWN.0;
    }
    if modifiers.left_button {
        flags |= cef_event_flags_t::EVENTFLAG_LEFT_MOUSE_BUTTON.0;
    }
    if modifiers.middle_button {
        flags |= cef_event_flags_t::EVENTFLAG_MIDDLE_MOUSE_BUTTON.0;
    }
    if modifiers.right_button {
        flags |= cef_event_flags_t::EVENTFLAG_RIGHT_MOUSE_BUTTON.0;
    }
    if modifiers.is_repeat {
        flags |= cef_event_flags_t::EVENTFLAG_IS_REPEAT.0;
    }
    flags
}

fn mouse_button_to_cef(button: MouseButton) -> MouseButtonType {
    match button {
        MouseButton::Left => MouseButtonType::LEFT,
        MouseButton::Middle => MouseButtonType::MIDDLE,
        MouseButton::Right => MouseButtonType::RIGHT,
    }
}

fn cef_cursor_to_kind(cursor: CursorType) -> CursorKind {
    match cursor {
        CursorType::HAND => CursorKind::Pointer,
        CursorType::IBEAM => CursorKind::Text,
        CursorType::CROSS => CursorKind::Crosshair,
        CursorType::MOVE => CursorKind::Move,
        CursorType::WAIT => CursorKind::Wait,
        CursorType::NOTALLOWED | CursorType::NODROP => CursorKind::NotAllowed,
        CursorType::GRAB => CursorKind::Grab,
        CursorType::GRABBING => CursorKind::Grabbing,
        CursorType::EASTRESIZE | CursorType::WESTRESIZE | CursorType::EASTWESTRESIZE => {
            CursorKind::ResizeEW
        }
        CursorType::NORTHRESIZE | CursorType::SOUTHRESIZE | CursorType::NORTHSOUTHRESIZE => {
            CursorKind::ResizeNS
        }
        CursorType::NORTHEASTRESIZE
        | CursorType::SOUTHWESTRESIZE
        | CursorType::NORTHEASTSOUTHWESTRESIZE => CursorKind::ResizeNESW,
        CursorType::NORTHWESTRESIZE
        | CursorType::SOUTHEASTRESIZE
        | CursorType::NORTHWESTSOUTHEASTRESIZE => CursorKind::ResizeNWSE,
        CursorType::COLUMNRESIZE => CursorKind::ResizeCol,
        CursorType::ROWRESIZE => CursorKind::ResizeRow,
        CursorType::VERTICALTEXT => CursorKind::VerticalText,
        CursorType::CONTEXTMENU => CursorKind::ContextMenu,
        CursorType::ALIAS => CursorKind::Alias,
        CursorType::COPY => CursorKind::Copy,
        _ => CursorKind::Default,
    }
}

fn cursor_to_u8(kind: CursorKind) -> u8 {
    match kind {
        CursorKind::Default => 0,
        CursorKind::Pointer => 1,
        CursorKind::Text => 2,
        CursorKind::Crosshair => 3,
        CursorKind::Move => 4,
        CursorKind::Wait => 5,
        CursorKind::NotAllowed => 6,
        CursorKind::Grab => 7,
        CursorKind::Grabbing => 8,
        CursorKind::ResizeEW => 9,
        CursorKind::ResizeNS => 10,
        CursorKind::ResizeNESW => 11,
        CursorKind::ResizeNWSE => 12,
        CursorKind::ResizeCol => 13,
        CursorKind::ResizeRow => 14,
        CursorKind::VerticalText => 15,
        CursorKind::ContextMenu => 16,
        CursorKind::Alias => 17,
        CursorKind::Copy => 18,
    }
}

fn cursor_from_u8(raw: u8) -> CursorKind {
    match raw {
        1 => CursorKind::Pointer,
        2 => CursorKind::Text,
        3 => CursorKind::Crosshair,
        4 => CursorKind::Move,
        5 => CursorKind::Wait,
        6 => CursorKind::NotAllowed,
        7 => CursorKind::Grab,
        8 => CursorKind::Grabbing,
        9 => CursorKind::ResizeEW,
        10 => CursorKind::ResizeNS,
        11 => CursorKind::ResizeNESW,
        12 => CursorKind::ResizeNWSE,
        13 => CursorKind::ResizeCol,
        14 => CursorKind::ResizeRow,
        15 => CursorKind::VerticalText,
        16 => CursorKind::ContextMenu,
        17 => CursorKind::Alias,
        18 => CursorKind::Copy,
        _ => CursorKind::Default,
    }
}

/// Opens Chrome DevTools for `browser` in its own top-level window, inspecting the element at
/// `inspect_at` (view coordinates) when given. A DevTools window that is already open is
/// brought forward by CEF.
fn open_dev_tools(browser: &Browser, inspect_at: Option<(i32, i32)>) {
    let Some(host) = browser.host() else {
        return;
    };
    let window_info = WindowInfo {
        runtime_style: RuntimeStyle::ALLOY,
        window_name: CefString::from("Developer Tools"),
        ..WindowInfo::default()
    };
    let settings = BrowserSettings::default();
    let point = inspect_at.map(|(x, y)| Point { x, y });
    host.show_dev_tools(Some(&window_info), None, Some(&settings), point.as_ref());
}

wrap_client! {
    struct ViewClient {
        render: RenderHandler,
        life: LifeSpanHandler,
        loads: LoadHandler,
        display: DisplayHandler,
        menu: ContextMenuHandler,
        downloads: DownloadHandler,
        requests: RequestHandler,
    }

    impl Client {
        fn request_handler(&self) -> Option<RequestHandler> {
            Some(self.requests.clone())
        }
        fn context_menu_handler(&self) -> Option<ContextMenuHandler> {
            Some(self.menu.clone())
        }
        fn download_handler(&self) -> Option<DownloadHandler> {
            Some(self.downloads.clone())
        }
        fn render_handler(&self) -> Option<RenderHandler> {
            Some(self.render.clone())
        }
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

unsafe extern "C" {
    fn conn_web_pasteboard_set_string(utf8: *const c_char) -> bool;
    fn conn_web_pasteboard_set_png(bytes: *const u8, length: usize) -> bool;
    fn conn_web_open_url(utf8: *const c_char) -> bool;
}

/// Puts `text` on the macOS general pasteboard.
fn copy_text(text: &str) {
    let Ok(text) = CString::new(text) else {
        return;
    };
    // SAFETY: `text` is a valid NUL-terminated string alive through the call; the shim only
    // reads it.
    let _ = unsafe { conn_web_pasteboard_set_string(text.as_ptr()) };
}

/// Puts PNG image bytes on the macOS general pasteboard.
fn copy_png(png: &[u8]) {
    // SAFETY: `png` is a live slice, and the shim copies `length` bytes from it before returning.
    let _ = unsafe { conn_web_pasteboard_set_png(png.as_ptr(), png.len()) };
}

/// Opens an `http(s)` URL in the user's default browser. Other schemes are never handed to
/// the system.
fn open_external(url: &str) {
    if !context_menu::is_web_url(url) {
        return;
    }
    let Ok(url) = CString::new(url) else {
        return;
    };
    // SAFETY: `url` is a valid NUL-terminated string alive through the call; the shim only
    // reads it.
    let _ = unsafe { conn_web_open_url(url.as_ptr()) };
}

fn cef_string(value: &CefStringUserfree) -> String {
    CefString::from(value).to_string()
}

/// The parts of a right-click that decide which items Conn adds.
fn menu_params(params: &ContextMenuParams) -> MenuParams {
    MenuParams {
        link_url: cef_string(&params.link_url()),
        unfiltered_link_url: cef_string(&params.unfiltered_link_url()),
        source_url: cef_string(&params.source_url()),
        is_image: params.media_type() == ContextMenuMediaType::IMAGE
            || params.has_image_contents() == 1,
    }
}

wrap_download_image_callback! {
    struct CopyImageCallback;

    impl DownloadImageCallback {
        // Re-encodes the fetched image as PNG, which covers `data:` and `http(s)` sources alike.
        fn on_download_image_finished(
            &self,
            _image_url: Option<&CefString>,
            _http_status_code: c_int,
            image: Option<&mut Image>,
        ) {
            let Some(image) = image else {
                return;
            };
            let Some(png) = image.as_png(1.0, 1, None, None) else {
                return;
            };
            let mut bytes = vec![0_u8; png.size()];
            if png.data(Some(&mut bytes), 0) == bytes.len() && !bytes.is_empty() {
                copy_png(&bytes);
            }
        }
    }
}

wrap_download_handler! {
    struct ViewDownloadHandler;

    impl DownloadHandler {
        // CEF's default answer is "no", which cancels every download, "Save image as…" included.
        fn can_download(
            &self,
            _browser: Option<&mut Browser>,
            _url: Option<&CefString>,
            _request_method: Option<&CefString>,
        ) -> c_int {
            1
        }

        // "Save image as…" (and any other download) asks where to save, starting in Downloads.
        fn on_before_download(
            &self,
            _browser: Option<&mut Browser>,
            _download_item: Option<&mut DownloadItem>,
            suggested_name: Option<&CefString>,
            callback: Option<&mut BeforeDownloadCallback>,
        ) -> c_int {
            let Some(callback) = callback else {
                return 0;
            };
            let name = suggested_name.map(|n| n.to_string()).unwrap_or_default();
            let name = if name.is_empty() { "download".to_owned() } else { name };
            let folder = std::env::var_os("HOME")
                .map(|home| std::path::PathBuf::from(home).join("Downloads"))
                .unwrap_or_default();
            let path = folder.join(name);
            callback.cont(Some(&CefString::from(path.to_string_lossy().as_ref())), 1);
            1
        }
    }
}

/// Chromium's menu model as plain items, submenus included.
fn read_menu(model: &MenuModel) -> Vec<RawMenuItem> {
    (0..model.count())
        .map(|index| {
            let kind = match model.type_at(index) {
                kind if kind == MenuItemType::SEPARATOR => RawKind::Separator,
                kind if kind == MenuItemType::CHECK => RawKind::Check,
                kind if kind == MenuItemType::RADIO => RawKind::Radio,
                kind if kind == MenuItemType::SUBMENU => RawKind::Submenu,
                _ => RawKind::Command,
            };
            RawMenuItem {
                kind,
                command_id: model.command_id_at(index),
                label: cef_string(&model.label_at(index)),
                enabled: model.is_enabled_at(index) == 1,
                visible: model.is_visible_at(index) == 1,
                checked: model.is_checked_at(index) == 1,
                children: if kind == RawKind::Submenu {
                    model
                        .sub_menu_at(index)
                        .map(|sub| read_menu(&sub))
                        .unwrap_or_default()
                } else {
                    Vec::new()
                },
            }
        })
        .collect()
}

/// CEF's menu callback, answered from the host (on the main thread, which is also CEF's UI
/// thread here).
struct MenuCallback(RunContextMenuCallback);

// SAFETY: CEF's windowless browser runs its UI on the main thread (`multi_threaded_message_loop`
// is off), and the host answers menus on that same thread. The wrapper only crosses threads as
// a plain value inside the reply handle, which is never used elsewhere.
unsafe impl Send for MenuCallback {}

wrap_context_menu_handler! {
    struct ViewContextMenu {
        shared: Arc<Shared>,
    }

    impl ContextMenuHandler {
        // Chromium's own items stay (Back, Forward, Reload, edit items). Conn removes Print and
        // View Source (separate windows), puts link and image items on top in Chrome's order,
        // and ends the menu with "Inspect".
        fn on_before_context_menu(
            &self,
            _browser: Option<&mut Browser>,
            _frame: Option<&mut Frame>,
            params: Option<&mut ContextMenuParams>,
            model: Option<&mut MenuModel>,
        ) {
            let Some(model) = model else {
                return;
            };
            for id in context_menu::REMOVED_COMMAND_IDS {
                model.remove(id);
            }

            let leading = params
                .map(|p| context_menu::leading_entries(&menu_params(p)))
                .unwrap_or_default();
            for (index, entry) in leading.into_iter().enumerate() {
                match entry {
                    Entry::Item(command) => {
                        model.insert_item_at(
                            index,
                            command.id(),
                            Some(&CefString::from(command.label())),
                        );
                    }
                    Entry::Separator => {
                        model.insert_separator_at(index);
                    }
                }
            }

            model.add_separator();
            model.add_item(
                ContextCommand::Inspect.id(),
                Some(&CefString::from(ContextCommand::Inspect.label())),
            );

            let kinds: Vec<bool> = (0..model.count())
                .map(|i| model.type_at(i) == MenuItemType::SEPARATOR)
                .collect();
            for index in context_menu::separators_to_remove(&kinds) {
                model.remove_at(index);
            }
        }

        // The view is windowless, so Chromium cannot show a menu: it asks the host to, and waits
        // for one answer through `callback`. With no host menu registered, say "cancelled" so
        // later menus still work.
        fn run_context_menu(
            &self,
            _browser: Option<&mut Browser>,
            _frame: Option<&mut Frame>,
            params: Option<&mut ContextMenuParams>,
            model: Option<&mut MenuModel>,
            callback: Option<&mut RunContextMenuCallback>,
        ) -> c_int {
            let (Some(params), Some(model), Some(callback)) = (params, model, callback) else {
                return 0;
            };
            let host_menu = self
                .shared
                .on_context_menu
                .lock()
                .ok()
                .and_then(|slot| slot.clone());
            let Some(host_menu) = host_menu else {
                callback.cancel();
                return 1;
            };
            let entries = menu::menu_entries(&read_menu(model));
            if !entries.iter().any(menu::MenuEntry::is_actionable) {
                callback.cancel();
                return 1;
            }
            let cef_callback = MenuCallback(callback.clone());
            let reply = ContextMenuReply::new(move |answer| match answer {
                Answer::Choose(command_id) => cef_callback.0.cont(
                    command_id,
                    EventFlags::from(cef::sys::cef_event_flags_t::EVENTFLAG_NONE),
                ),
                Answer::Cancel => cef_callback.0.cancel(),
            });
            host_menu(ContextMenuEvent::Open(ContextMenuRequest {
                x: params.xcoord(),
                y: params.ycoord(),
                entries,
                reply,
            }));
            1
        }

        fn on_context_menu_dismissed(
            &self,
            _browser: Option<&mut Browser>,
            _frame: Option<&mut Frame>,
        ) {
            let host_menu = self
                .shared
                .on_context_menu
                .lock()
                .ok()
                .and_then(|slot| slot.clone());
            if let Some(host_menu) = host_menu {
                host_menu(ContextMenuEvent::Dismissed);
            }
        }

        fn on_context_menu_command(
            &self,
            browser: Option<&mut Browser>,
            _frame: Option<&mut Frame>,
            params: Option<&mut ContextMenuParams>,
            command_id: c_int,
            _event_flags: EventFlags,
        ) -> c_int {
            let Some(command) = ContextCommand::from_id(command_id) else {
                return 0;
            };
            let (Some(browser), Some(params)) = (browser, params) else {
                return 1;
            };
            let info = menu_params(params);
            match command {
                ContextCommand::Inspect => {
                    open_dev_tools(browser, Some((params.xcoord(), params.ycoord())));
                }
                ContextCommand::OpenLink => {
                    if let Some(LinkTarget::Web(url)) = context_menu::link_target(&info) {
                        open_external(&url);
                    }
                }
                ContextCommand::CopyLink => {
                    if let Some(LinkTarget::Web(text) | LinkTarget::Other(text)) =
                        context_menu::link_target(&info)
                    {
                        copy_text(&text);
                    }
                }
                ContextCommand::CopyEmail => {
                    if let Some(LinkTarget::Mail(address)) = context_menu::link_target(&info) {
                        copy_text(&address);
                    }
                }
                ContextCommand::OpenImage => open_external(&info.source_url),
                ContextCommand::SaveImage => {
                    if let Some(host) = browser.host() {
                        host.start_download(Some(&CefString::from(info.source_url.as_str())));
                    }
                }
                ContextCommand::CopyImage => {
                    if let Some(host) = browser.host() {
                        let mut callback = CopyImageCallback::new();
                        host.download_image(
                            Some(&CefString::from(info.source_url.as_str())),
                            0,
                            0,
                            0,
                            Some(&mut callback),
                        );
                    }
                }
                ContextCommand::CopyImageAddress => copy_text(&info.source_url),
            }
            1
        }
    }
}

wrap_render_handler! {
    struct ViewRenderHandler {
        shared: Arc<Shared>,
    }

    impl RenderHandler {
        fn view_rect(&self, _browser: Option<&mut Browser>, rect: Option<&mut cef::Rect>) {
            let (width, height) = self.shared.size.lock().map(|s| *s).unwrap_or((1, 1));
            if let Some(rect) = rect {
                *rect = cef::Rect {
                    x: 0,
                    y: 0,
                    width: width.max(1),
                    height: height.max(1),
                };
            }
        }

        fn screen_info(
            &self,
            _browser: Option<&mut Browser>,
            screen_info: Option<&mut ScreenInfo>,
        ) -> c_int {
            let Some(info) = screen_info else {
                return 0;
            };
            let (width, height) = self.shared.size.lock().map(|s| *s).unwrap_or((1, 1));
            let scale = self.shared.scale.lock().map(|s| *s).unwrap_or(1.0);
            info.device_scale_factor = scale;
            info.rect = cef::Rect {
                x: 0,
                y: 0,
                width: width.max(1),
                height: height.max(1),
            };
            info.available_rect = info.rect.clone();
            1
        }

        fn on_paint(
            &self,
            _browser: Option<&mut Browser>,
            type_: PaintElementType,
            _dirty_rects: Option<&[cef::Rect]>,
            buffer: *const u8,
            width: c_int,
            height: c_int,
        ) {
            if type_ != PaintElementType::VIEW || buffer.is_null() || width <= 0 || height <= 0 {
                return;
            }
            let Ok(w) = u32::try_from(width) else {
                return;
            };
            let Ok(h) = u32::try_from(height) else {
                return;
            };
            let Some(byte_len) = (w as usize)
                .checked_mul(h as usize)
                .and_then(|px| px.checked_mul(4))
            else {
                return;
            };

            // SAFETY: CEF guarantees `buffer` points to `width * height * 4` valid
            // readable bytes of 32-bit BGRA pixel data for the duration of `on_paint`.
            let src = unsafe { std::slice::from_raw_parts(buffer, byte_len) };

            let painted = self.shared.paints_since_load.fetch_add(1, Ordering::AcqRel);
            if painted < 3 {
                trace(&format!(
                    "on_paint #{} {w}x{h} {}",
                    painted + 1,
                    self.shared.since_load()
                ));
            }

            let next_gen = {
                let Ok(mut frame) = self.shared.frame.lock() else {
                    return;
                };
                // One copy per frame: the previous frame's buffer goes if the host never took it.
                frame.bgra = src.to_vec();
                frame.width = w;
                frame.height = h;
                frame.generation = frame.generation.saturating_add(1);
                frame.generation
            };

            self.shared
                .frame_generation
                .store(next_gen, Ordering::Release);
            self.shared.notify_frame();
        }
    }
}

wrap_life_span_handler! {
    struct ViewLifeSpan;

    impl LifeSpanHandler {
        // Suppress unmanaged native popup windows in OSR mode.
        fn on_before_popup(
            &self,
            _browser: Option<&mut Browser>,
            _frame: Option<&mut Frame>,
            _popup_id: c_int,
            _target_url: Option<&CefString>,
            _target_frame_name: Option<&CefString>,
            _target_disposition: WindowOpenDisposition,
            _user_gesture: c_int,
            _popup_features: Option<&PopupFeatures>,
            _window_info: Option<&mut WindowInfo>,
            _client: Option<&mut Option<Client>>,
            _settings: Option<&mut BrowserSettings>,
            _extra_info: Option<&mut Option<DictionaryValue>>,
            _no_javascript_access: Option<&mut c_int>,
        ) -> c_int {
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
            trace(&format!(
                "cef loading={is_loading} {}",
                self.shared.since_load()
            ));
            self.shared
                .can_go_back
                .store(can_go_back == 1, Ordering::Release);
            self.shared
                .can_go_forward
                .store(can_go_forward == 1, Ordering::Release);
            self.shared.notify_frame();
        }

        fn on_load_start(
            &self,
            _browser: Option<&mut Browser>,
            frame: Option<&mut Frame>,
            _transition_type: TransitionType,
        ) {
            // A new document of the main frame has begun: its scripts have not run yet.
            let Some(frame) = frame.filter(|f| f.is_main() == 1) else {
                return;
            };
            let url = CefString::from(&frame.url()).to_string();
            trace(&format!("on_load_start {url} {}", self.shared.since_load()));
            if let Ok(mut error) = self.shared.load_error.lock() {
                *error = None;
            }
            let callback = self
                .shared
                .on_load_start
                .lock()
                .ok()
                .and_then(|slot| slot.clone());
            if let Some(callback) = callback {
                callback(&url);
            }
        }

        // A main-frame load that fails: `ERR_ABORTED` is a navigation replaced or cancelled (and
        // is not an error to show); anything else is kept for the host to show.
        fn on_load_error(
            &self,
            _browser: Option<&mut Browser>,
            frame: Option<&mut Frame>,
            error_code: Errorcode,
            error_text: Option<&CefString>,
            failed_url: Option<&CefString>,
        ) {
            let main = frame.as_ref().is_some_and(|f| f.is_main() == 1);
            let code = error_code.get_raw();
            let text = error_text.map(ToString::to_string).unwrap_or_default();
            let url = failed_url.map(ToString::to_string).unwrap_or_default();
            trace(&format!(
                "on_load_error main={main} code={code} ({}) text={text:?} url={url} {}",
                load_error::net_error_name(code),
                self.shared.since_load()
            ));
            if main && code != load_error::ERR_ABORTED {
                if let Ok(mut error) = self.shared.load_error.lock() {
                    *error = Some(LoadError { url, code, text });
                }
                self.shared.notify_frame();
            }
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
            trace(&format!(
                "on_load_end status={http_status_code} {}",
                self.shared.since_load()
            ));
            self.shared.load_count.fetch_add(1, Ordering::AcqRel);
            let url = frame
                .map(|f| CefString::from(&f.url()).to_string())
                .unwrap_or_default();
            if let Ok(mut current) = self.shared.url.lock()
                && !url.is_empty()
            {
                *current = url.clone();
            }
            let cb = self
                .shared
                .on_load_end
                .lock()
                .ok()
                .and_then(|slot| slot.clone());
            if let Some(callback) = cb {
                callback(&url, http_status_code);
            }
            self.shared.notify_frame();
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
            self.shared.notify_frame();
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
            trace(&format!("address changed {}", self.shared.since_load()));
            self.shared.notify_frame();
        }

        fn on_cursor_change(
            &self,
            _browser: Option<&mut Browser>,
            _cursor: *mut u8,
            type_: CursorType,
            _custom_cursor_info: Option<&CursorInfo>,
        ) -> c_int {
            let next = cursor_to_u8(cef_cursor_to_kind(type_));
            let prev = self.shared.cursor.swap(next, Ordering::AcqRel);
            if prev != next {
                self.shared.notify_frame();
            }
            1
        }

        fn on_console_message(
            &self,
            _browser: Option<&mut Browser>,
            _level: LogSeverity,
            message: Option<&CefString>,
            _source: Option<&CefString>,
            _line: c_int,
        ) -> c_int {
            let Some(msg) = message.map(|m| m.to_string()) else {
                return 0;
            };
            let cb = self
                .shared
                .on_console_message
                .lock()
                .ok()
                .and_then(|slot| slot.clone());
            if let Some(callback) = cb
                && callback(&msg)
            {
                return 1;
            }
            0
        }
    }
}

/// Logs a browser step; see [`crate::trace`].
pub(crate) fn trace(what: &str) {
    crate::trace::trace("conn-web", what);
}
