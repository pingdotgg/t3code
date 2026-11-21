//! Browser right-panel surface with Conn's ToolbarGroup navigation controls,
//! soft pill URL bar, and optional CEF-on-demand offscreen-rendered Chromium view.

#[cfg(feature = "cef")]
use std::cell::{Cell, RefCell};
use std::fmt;
#[cfg(feature = "cef")]
use std::rc::Rc;
#[cfg(feature = "cef")]
use std::sync::Arc;
#[cfg(feature = "cef")]
use std::time::Duration;

use crate::a11y::ConnA11yExt as _;
use conn_theme::Tokens;
#[cfg(feature = "cef")]
use conn_web::{
    BrowserView, CursorKind, EditCommand, KeyEvent as WebKeyEvent, KeyEventKind,
    Modifiers as WebModifiers, MouseButton as WebMouseButton, Rect as WebRect, WebError,
    WebRuntime, WebRuntimeState,
};
#[cfg(feature = "cef")]
use futures::StreamExt as _;
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::*;
use gpui_kit::{
    Context, Entity, IntoElement, ParentElement, Render, Styled, Subscription, Window, div, px,
};
#[cfg(feature = "cef")]
use gpui_kit::{
    Corners, CursorStyle, FocusHandle, KeyDownEvent, KeyUpEvent, Modifiers as GpuiModifiers,
    MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, Pixels, Point, RenderImage,
    ScrollDelta, ScrollEvent, Task, canvas,
};

use super::color::to_hsla;
use super::header::superhero_icon;

const UI_TEXT_PX: f32 = 13.0;
const UI_LINE_HEIGHT_PX: f32 = 20.0;
const TOOLBAR_PAD_Y_PX: f32 = 7.5;
const TOOLBAR_PAD_START_PX: f32 = 8.0;
const TOOLBAR_PAD_END_PX: f32 = 11.5;
const TOOLBAR_HEIGHT_PX: f32 = 32.0;
const TOOLBAR_INNER_PADDING_PX: f32 = 3.0;
const TOOLBAR_BUTTON_SIZE_PX: f32 = 24.0;
const NAV_ICON_SIZE_PX: f32 = 14.0;
const DEFAULT_URL_ENV: &str = "CONN_GPUI_BROWSER_URL";
const DEFAULT_FALLBACK_URL: &str = "about:blank";
#[cfg(feature = "cef")]
const SCROLL_LINE_PX: f32 = 40.0;

#[cfg(feature = "cef")]
#[derive(Clone, Debug, PartialEq, Eq)]
enum RuntimePhase {
    Idle,
    Downloading(u8),
    Starting,
    Running,
    Failed(String),
}

#[cfg(feature = "cef")]
enum InstallUpdate {
    Progress(u8),
    Done(Result<(), WebError>),
}

/// Browser right-panel surface with navigation toolbar, soft URL field, and
/// optional on-demand CEF offscreen-rendered view (when compiled with feature `cef`).
pub(crate) struct BrowserPanel {
    tokens: Tokens,
    url_input: Entity<InputState>,
    url: String,
    /// The URL last written into the address field, so it follows navigation.
    shown_url: String,
    _subscriptions: Vec<Subscription>,
    #[cfg(feature = "cef")]
    phase: RuntimePhase,
    #[cfg(feature = "cef")]
    focus_handle: FocusHandle,
    #[cfg(feature = "cef")]
    view: Rc<RefCell<Option<BrowserView>>>,
    #[cfg(feature = "cef")]
    rendered_frame: Option<(u64, Arc<RenderImage>)>,
    #[cfg(feature = "cef")]
    wake_task: Option<Task<()>>,
    #[cfg(feature = "cef")]
    last_bounds: Rc<Cell<Option<WebRect>>>,
    #[cfg(feature = "cef")]
    last_scale: Rc<Cell<f32>>,
    #[cfg(feature = "cef")]
    creating_view: Rc<Cell<bool>>,
    /// Whether the shell shows this panel (right panel open, Browser tab active).
    /// When false, CEF is marked hidden so it stops painting.
    #[cfg(feature = "cef")]
    visible: Rc<Cell<bool>>,
    /// Size and scale last sent to CEF (`(width_px, height_px, scale_bits)`).
    #[cfg(feature = "cef")]
    applied_size: Rc<Cell<Option<(i32, i32, u32)>>>,
    /// Hidden state last sent to CEF.
    #[cfg(feature = "cef")]
    applied_hidden: Rc<Cell<Option<bool>>>,
}

impl fmt::Debug for BrowserPanel {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("BrowserPanel")
            .field("url", &self.url)
            .finish_non_exhaustive()
    }
}

impl BrowserPanel {
    pub(crate) fn new(tokens: Tokens, window: &mut Window, cx: &mut Context<'_, Self>) -> Self {
        let initial_url = default_browser_url();
        let url_input = cx.new(|cx| {
            let mut input = InputState::new(window, cx).placeholder("Enter URL...");
            input.set_value(initial_url.clone(), window, cx);
            input
        });

        let mut subscriptions = Vec::new();
        subscriptions.push(cx.subscribe_in(
            &url_input,
            window,
            |this, input, event: &InputEvent, window, cx| {
                if matches!(event, InputEvent::PressEnter { .. }) {
                    let raw = input.read(cx).value().to_string();
                    let normalized = normalize_url(&raw);
                    if normalized != raw {
                        let value = normalized.clone();
                        input.update(cx, |state, cx| state.set_value(value, window, cx));
                    }
                    this.navigate(normalized, cx);
                }
            },
        ));

        #[cfg(feature = "cef")]
        let focus_handle = cx.focus_handle();
        #[cfg(feature = "cef")]
        {
            subscriptions.push(cx.on_focus(&focus_handle, window, |this, _window, _cx| {
                if let Some(view) = this.view.borrow().as_ref() {
                    view.set_focus(true);
                }
            }));
            subscriptions.push(cx.on_blur(&focus_handle, window, |this, _window, _cx| {
                if let Some(view) = this.view.borrow().as_ref() {
                    view.set_focus(false);
                }
            }));
        }

        Self {
            tokens,
            url_input,
            shown_url: initial_url.clone(),
            url: initial_url,
            _subscriptions: subscriptions,
            #[cfg(feature = "cef")]
            phase: initial_phase(),
            #[cfg(feature = "cef")]
            focus_handle,
            #[cfg(feature = "cef")]
            view: Rc::new(RefCell::new(None)),
            #[cfg(feature = "cef")]
            rendered_frame: None,
            #[cfg(feature = "cef")]
            wake_task: None,
            #[cfg(feature = "cef")]
            last_bounds: Rc::new(Cell::new(None)),
            #[cfg(feature = "cef")]
            last_scale: Rc::new(Cell::new(window.scale_factor().max(1.0))),
            #[cfg(feature = "cef")]
            creating_view: Rc::new(Cell::new(false)),
            #[cfg(feature = "cef")]
            visible: Rc::new(Cell::new(false)),
            #[cfg(feature = "cef")]
            applied_size: Rc::new(Cell::new(None)),
            #[cfg(feature = "cef")]
            applied_hidden: Rc::new(Cell::new(None)),
        }
    }

    /// Shows or hides the browser panel. When hidden, CEF stops painting; when
    /// shown again, painting resumes without reloading.
    pub(crate) fn set_visible(&mut self, visible: bool, cx: &mut Context<'_, Self>) {
        #[cfg(feature = "cef")]
        {
            if self.visible.get() != visible {
                self.visible.set(visible);
                apply_hidden(&self.view, &self.applied_hidden, !visible);
                cx.notify();
            }
        }
        #[cfg(not(feature = "cef"))]
        {
            let _ = (visible, cx);
        }
    }

    pub(crate) fn set_tokens(&mut self, tokens: Tokens, cx: &mut Context<'_, Self>) {
        self.tokens = tokens;
        cx.notify();
    }

    /// Navigates the embedded browser to `url`, lazily installing and starting
    /// the CEF runtime on first use when compiled with feature `cef`.
    pub(crate) fn navigate(&mut self, url: impl Into<String>, cx: &mut Context<'_, Self>) {
        let target = normalize_url(&url.into());
        self.url = target;
        #[cfg(feature = "cef")]
        {
            self.ensure_runtime_and_load(cx);
        }
        #[cfg(not(feature = "cef"))]
        {
            cx.notify();
        }
    }

    /// Diagnostic state for the automation hook.
    #[cfg(feature = "automation")]
    pub(crate) fn automation_state(&self) -> serde_json::Value {
        #[cfg(feature = "cef")]
        {
            let view = self.view.borrow();
            serde_json::json!({
                "phase": format!("{:?}", self.phase),
                "hasView": view.is_some(),
                "target": self.url,
                "url": view.as_ref().map(BrowserView::url),
                "title": view.as_ref().map(BrowserView::title),
                "visible": self.visible.get(),
                "frameGeneration": view.as_ref().map(BrowserView::frame_generation),
                "bounds": self.last_bounds.get().map(|b| [b.x, b.y, b.width, b.height]),
            })
        }
        #[cfg(not(feature = "cef"))]
        {
            serde_json::json!({ "cef": false, "target": self.url })
        }
    }

    /// Returns the active document title reported by CEF, or an empty string
    /// when no page is loaded or feature `cef` is disabled.
    #[cfg_attr(
        not(feature = "automation"),
        expect(dead_code, reason = "read by the automation hook")
    )]
    #[must_use]
    pub(crate) fn title(&self) -> String {
        #[cfg(feature = "cef")]
        {
            self.view
                .borrow()
                .as_ref()
                .map_or_else(String::new, BrowserView::title)
        }
        #[cfg(not(feature = "cef"))]
        {
            String::new()
        }
    }

    fn go_back(&mut self, cx: &mut Context<'_, Self>) {
        #[cfg(feature = "cef")]
        if let Some(view) = self.view.borrow().as_ref() {
            view.go_back();
            cx.notify();
        }
        #[cfg(not(feature = "cef"))]
        let _ = cx;
    }

    fn go_forward(&mut self, cx: &mut Context<'_, Self>) {
        #[cfg(feature = "cef")]
        if let Some(view) = self.view.borrow().as_ref() {
            view.go_forward();
            cx.notify();
        }
        #[cfg(not(feature = "cef"))]
        let _ = cx;
    }

    fn reload(&mut self, cx: &mut Context<'_, Self>) {
        #[cfg(feature = "cef")]
        {
            if let Some(view) = self.view.borrow().as_ref() {
                view.reload();
                cx.notify();
            } else {
                self.ensure_runtime_and_load(cx);
            }
        }
        #[cfg(not(feature = "cef"))]
        let _ = cx;
    }

    fn can_go_back(&self) -> bool {
        #[cfg(feature = "cef")]
        {
            self.view
                .borrow()
                .as_ref()
                .is_some_and(BrowserView::can_go_back)
        }
        #[cfg(not(feature = "cef"))]
        {
            false
        }
    }

    fn can_go_forward(&self) -> bool {
        #[cfg(feature = "cef")]
        {
            self.view
                .borrow()
                .as_ref()
                .is_some_and(BrowserView::can_go_forward)
        }
        #[cfg(not(feature = "cef"))]
        {
            false
        }
    }

    #[cfg(feature = "cef")]
    fn ensure_runtime_and_load(&mut self, cx: &mut Context<'_, Self>) {
        if let Some(view) = self.view.borrow().as_ref() {
            view.load_url(&self.url);
            if self.visible.get() {
                apply_hidden(&self.view, &self.applied_hidden, false);
            }
            cx.notify();
            return;
        }

        let runtime = WebRuntime::global();
        match runtime.state() {
            WebRuntimeState::Running => {
                self.phase = RuntimePhase::Running;
                self.maybe_create_view_deferred(cx);
                cx.notify();
                return;
            }
            WebRuntimeState::Starting => {
                self.phase = RuntimePhase::Starting;
                self.poll_runtime_ready(cx);
                cx.notify();
                return;
            }
            WebRuntimeState::Downloading { progress_percent } => {
                self.phase = RuntimePhase::Downloading(progress_percent);
                cx.notify();
                return;
            }
            WebRuntimeState::NotInstalled | WebRuntimeState::Failed(_) => {}
        }

        if runtime.is_installed() {
            self.start_runtime(cx);
            return;
        }

        if matches!(self.phase, RuntimePhase::Downloading(_)) {
            return;
        }

        self.phase = RuntimePhase::Downloading(0);
        cx.notify();

        let (tx, mut rx) = futures::channel::mpsc::unbounded::<InstallUpdate>();
        let spawned = std::thread::Builder::new()
            .name("conn-web-install".into())
            .spawn(move || {
                let progress_tx = tx.clone();
                let res = WebRuntime::global().ensure_installed(move |pct| {
                    let _ = progress_tx.unbounded_send(InstallUpdate::Progress(pct));
                });
                let _ = tx.unbounded_send(InstallUpdate::Done(res));
            });

        if let Err(err) = spawned {
            self.phase = RuntimePhase::Failed(format!("failed to start download thread: {err}"));
            cx.notify();
            return;
        }

        cx.spawn(async move |this, cx| {
            while let Some(update) = rx.next().await {
                let finished = matches!(update, InstallUpdate::Done(_));
                let alive = this.update(cx, |panel, cx| match update {
                    InstallUpdate::Progress(pct) => {
                        panel.phase = RuntimePhase::Downloading(pct);
                        cx.notify();
                    }
                    InstallUpdate::Done(Ok(())) => {
                        panel.start_runtime(cx);
                    }
                    InstallUpdate::Done(Err(err)) => {
                        panel.phase = RuntimePhase::Failed(err.to_string());
                        cx.notify();
                    }
                });
                if alive.is_err() || finished {
                    break;
                }
            }
        })
        .detach();
    }

    #[cfg(feature = "cef")]
    fn start_runtime(&mut self, cx: &mut Context<'_, Self>) {
        match WebRuntime::global().start() {
            Ok(()) => {
                if WebRuntime::global().state() == WebRuntimeState::Running {
                    self.phase = RuntimePhase::Running;
                    self.maybe_create_view_deferred(cx);
                } else {
                    self.phase = RuntimePhase::Starting;
                    self.poll_runtime_ready(cx);
                }
            }
            Err(err) => {
                self.phase = RuntimePhase::Failed(err.to_string());
            }
        }
        cx.notify();
    }

    #[cfg(feature = "cef")]
    fn poll_runtime_ready(&mut self, cx: &mut Context<'_, Self>) {
        cx.spawn(async move |this, cx| {
            let started = std::time::Instant::now();
            loop {
                cx.background_executor()
                    .timer(Duration::from_millis(50))
                    .await;
                let next = match WebRuntime::global().state() {
                    WebRuntimeState::Running => Some(RuntimePhase::Running),
                    WebRuntimeState::Failed(why) => Some(RuntimePhase::Failed(why)),
                    _ if started.elapsed() > Duration::from_secs(60) => Some(RuntimePhase::Failed(
                        "timed out waiting for Chromium to start".into(),
                    )),
                    _ => None,
                };
                if let Some(phase) = next {
                    let _ = this.update(cx, |panel, cx| {
                        let ready = matches!(phase, RuntimePhase::Running);
                        panel.phase = phase;
                        if ready {
                            panel.maybe_create_view_deferred(cx);
                        }
                        cx.notify();
                    });
                    break;
                }
            }
        })
        .detach();
    }

    #[cfg(feature = "cef")]
    fn maybe_create_view_deferred(&self, cx: &mut Context<'_, Self>) {
        if self.view.borrow().is_some() || self.creating_view.get() {
            return;
        }
        let Some(bounds) = self.last_bounds.get() else {
            return;
        };
        if bounds.width < 1.0 || bounds.height < 1.0 {
            return;
        }

        self.creating_view.set(true);
        let url = self.url.clone();
        let view_slot = self.view.clone();
        let creating_flag = self.creating_view.clone();
        let last_bounds = self.last_bounds.clone();
        let last_scale = self.last_scale.clone();
        let visible = self.visible.clone();
        let applied_hidden = self.applied_hidden.clone();
        let entity = cx.entity().downgrade();

        // Defer BrowserView creation until after GPUI finishes the current frame.
        cx.defer(move |cx| {
            creating_flag.set(false);
            if view_slot.borrow().is_some() {
                return;
            }
            let rect = last_bounds.get().unwrap_or(bounds);
            let scale = last_scale.get().max(1.0);
            let result = BrowserView::create(rect, scale, &url);
            match result {
                Ok(browser_view) => {
                    // Bounded channel (capacity 1) coalesces frame bursts into a
                    // single GPUI repaint with no busy loop when the page is idle.
                    let (wake_tx, mut wake_rx) = tokio::sync::mpsc::channel::<()>(1);
                    let wake_cb = move || {
                        let _ = wake_tx.try_send(());
                    };
                    browser_view.on_frame(wake_cb);

                    let hidden = !visible.get();
                    browser_view.set_hidden(hidden);
                    applied_hidden.set(Some(hidden));

                    *view_slot.borrow_mut() = Some(browser_view);
                    if let Some(panel) = entity.upgrade() {
                        panel.update(cx, |panel, cx| {
                            panel.phase = RuntimePhase::Running;
                            panel.wake_task = Some(cx.spawn(async move |this, cx| {
                                while wake_rx.recv().await.is_some() {
                                    if this.update(cx, |_panel, cx| cx.notify()).is_err() {
                                        break;
                                    }
                                }
                            }));
                            cx.notify();
                        });
                    }
                }
                Err(err) => {
                    if let Some(panel) = entity.upgrade() {
                        panel.update(cx, |panel, cx| {
                            panel.phase = RuntimePhase::Failed(err.to_string());
                            cx.notify();
                        });
                    }
                }
            }
        });
    }

    /// Pulls a new BGRA frame from CEF only when `frame_generation` advances,
    /// keeping the previous frame on screen across navigations so there is no
    /// blank flash or fade.
    #[cfg(feature = "cef")]
    fn refresh_frame(&mut self, cx: &mut Context<'_, Self>) {
        let last_gen = self
            .rendered_frame
            .as_ref()
            .map_or(0, |(generation, _)| *generation);
        let snapshot = {
            let guard = self.view.borrow();
            let Some(view) = guard.as_ref() else {
                return;
            };
            view.frame_if_newer(last_gen)
        };
        let Some(snapshot) = snapshot else {
            return;
        };
        // GPUI's `RenderImage` stores premultiplied 32-bit BGRA pixels directly
        // inside `image::RgbaImage`, matching CEF's `on_paint` buffer format.
        let Some(buffer) =
            image::RgbaImage::from_raw(snapshot.width, snapshot.height, snapshot.bgra)
        else {
            return;
        };
        let new_image = Arc::new(RenderImage::new(vec![image::Frame::new(buffer)]));
        let previous = self
            .rendered_frame
            .replace((snapshot.generation, new_image));
        if let Some((_, old_image)) = previous {
            cx.defer(move |cx| cx.drop_image(old_image, None));
        }
    }

    #[cfg(feature = "cef")]
    fn local_coords(&self, position: Point<Pixels>) -> Option<(i32, i32)> {
        let bounds = self.last_bounds.get()?;
        let x = (f32::from(position.x) - bounds.x).round() as i32;
        let y = (f32::from(position.y) - bounds.y).round() as i32;
        Some((x.max(0), y.max(0)))
    }

    #[cfg(feature = "cef")]
    fn handle_mouse_down(
        &mut self,
        event: &MouseDownEvent,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        window.focus(&self.focus_handle, cx);
        let Some((x, y)) = self.local_coords(event.position) else {
            return;
        };
        let Some(button) = map_mouse_button(event.button) else {
            return;
        };
        if let Some(view) = self.view.borrow().as_ref() {
            view.set_focus(true);
            let click_count = i32::try_from(event.click_count).unwrap_or(1).max(1);
            view.send_mouse_down(
                x,
                y,
                button,
                click_count,
                map_modifiers(event.modifiers, Some(event.button), false),
            );
        }
    }

    #[cfg(feature = "cef")]
    fn handle_mouse_up(&mut self, event: &MouseUpEvent) {
        let Some((x, y)) = self.local_coords(event.position) else {
            return;
        };
        let Some(button) = map_mouse_button(event.button) else {
            return;
        };
        if let Some(view) = self.view.borrow().as_ref() {
            let click_count = i32::try_from(event.click_count).unwrap_or(1).max(1);
            view.send_mouse_up(
                x,
                y,
                button,
                click_count,
                map_modifiers(event.modifiers, None, false),
            );
        }
    }

    #[cfg(feature = "cef")]
    fn handle_mouse_move(&mut self, event: &MouseMoveEvent) {
        let Some((x, y)) = self.local_coords(event.position) else {
            return;
        };
        if let Some(view) = self.view.borrow().as_ref() {
            view.send_mouse_move(
                x,
                y,
                map_modifiers(event.modifiers, event.pressed_button, false),
                false,
            );
        }
    }

    #[cfg(feature = "cef")]
    fn handle_scroll(&mut self, event: &ScrollEvent) {
        let Some((x, y)) = self.local_coords(event.position) else {
            return;
        };
        let (dx, dy) = match event.delta {
            ScrollDelta::Pixels(p) => {
                (f32::from(p.x).round() as i32, f32::from(p.y).round() as i32)
            }
            ScrollDelta::Lines(l) => (
                (l.x * SCROLL_LINE_PX).round() as i32,
                (l.y * SCROLL_LINE_PX).round() as i32,
            ),
        };
        if dx == 0 && dy == 0 {
            return;
        }
        if let Some(view) = self.view.borrow().as_ref() {
            view.send_mouse_wheel(x, y, dx, dy, map_modifiers(event.modifiers, None, false));
        }
    }

    #[cfg(feature = "cef")]
    fn handle_key_down(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        if !self.focus_handle.is_focused(window) {
            return;
        }
        let guard = self.view.borrow();
        let Some(view) = guard.as_ref() else {
            return;
        };

        let ks = &event.keystroke;
        let mods = map_modifiers(ks.modifiers, None, event.is_held);

        // Dispatch standard macOS Cmd+edit shortcuts directly to the focused frame.
        if ks.modifiers.platform && !ks.modifiers.control && !ks.modifiers.alt {
            let cmd = match ks.key.as_str() {
                "c" => Some(EditCommand::Copy),
                "x" => Some(EditCommand::Cut),
                "v" => Some(EditCommand::Paste),
                "a" => Some(EditCommand::SelectAll),
                "z" if ks.modifiers.shift => Some(EditCommand::Redo),
                "z" => Some(EditCommand::Undo),
                _ => None,
            };
            if let Some(edit_cmd) = cmd {
                view.execute_edit_command(edit_cmd);
                cx.stop_propagation();
                return;
            }
        }

        let windows_key_code = gpui_key_to_windows_vk(&ks.key);
        let first_char = ks
            .key_char
            .as_deref()
            .and_then(|s| s.encode_utf16().next())
            .unwrap_or(0);
        let unmodified_char = ks.key.encode_utf16().next().unwrap_or(0);

        view.send_key_event(WebKeyEvent {
            kind: KeyEventKind::RawKeyDown,
            windows_key_code,
            native_key_code: 0,
            character: first_char,
            unmodified_character: unmodified_char,
            modifiers: mods,
            is_system_key: ks.modifiers.alt,
        });

        if !ks.modifiers.platform && !ks.modifiers.control {
            if ks.key == "enter" {
                view.send_key_event(WebKeyEvent {
                    kind: KeyEventKind::Char,
                    windows_key_code: 0x0D,
                    native_key_code: 0,
                    character: u16::from(b'\r'),
                    unmodified_character: u16::from(b'\r'),
                    modifiers: mods,
                    is_system_key: false,
                });
            } else if let Some(text) = ks.key_char.as_deref() {
                for unit in text.encode_utf16() {
                    if unit >= 0x20 {
                        view.send_key_event(WebKeyEvent {
                            kind: KeyEventKind::Char,
                            windows_key_code: i32::from(unit),
                            native_key_code: 0,
                            character: unit,
                            unmodified_character: unit,
                            modifiers: mods,
                            is_system_key: false,
                        });
                    }
                }
            }
        }

        cx.stop_propagation();
    }

    #[cfg(feature = "cef")]
    fn handle_key_up(
        &mut self,
        event: &KeyUpEvent,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        if !self.focus_handle.is_focused(window) {
            return;
        }
        let guard = self.view.borrow();
        let Some(view) = guard.as_ref() else {
            return;
        };

        let ks = &event.keystroke;
        let mods = map_modifiers(ks.modifiers, None, false);
        let windows_key_code = gpui_key_to_windows_vk(&ks.key);
        let first_char = ks
            .key_char
            .as_deref()
            .and_then(|s| s.encode_utf16().next())
            .unwrap_or(0);
        let unmodified_char = ks.key.encode_utf16().next().unwrap_or(0);

        view.send_key_event(WebKeyEvent {
            kind: KeyEventKind::KeyUp,
            windows_key_code,
            native_key_code: 0,
            character: first_char,
            unmodified_character: unmodified_char,
            modifiers: mods,
            is_system_key: ks.modifiers.alt,
        });

        cx.stop_propagation();
    }

    fn render_nav_toolbar_group(&self, cx: &mut Context<'_, Self>) -> gpui_kit::Div {
        let fg = to_hsla(self.tokens.foreground);
        let muted = to_hsla(self.tokens.muted_foreground);
        let hover_bg = to_hsla(self.tokens.shell_highlight);
        let control_bg = to_hsla(self.tokens.shell_control);
        let border = to_hsla(self.tokens.shell_divider_header);

        let back_color = if self.can_go_back() { fg } else { muted };
        let forward_color = if self.can_go_forward() { fg } else { muted };

        let back_btn = div()
            .id("browser-nav-back")
            .a11y_button("browser.nav.back", "Back")
            .size(px(TOOLBAR_BUTTON_SIZE_PX))
            .rounded(px(9999.0))
            .flex()
            .items_center()
            .justify_center()
            .cursor_pointer()
            .hover(move |s| s.bg(hover_bg))
            .on_click(cx.listener(|this, _, _, cx| this.go_back(cx)))
            .child(superhero_icon(
                "superhero/chevron-left.svg",
                NAV_ICON_SIZE_PX,
                back_color,
            ));

        let forward_btn = div()
            .id("browser-nav-forward")
            .a11y_button("browser.nav.forward", "Forward")
            .size(px(TOOLBAR_BUTTON_SIZE_PX))
            .rounded(px(9999.0))
            .flex()
            .items_center()
            .justify_center()
            .cursor_pointer()
            .hover(move |s| s.bg(hover_bg))
            .on_click(cx.listener(|this, _, _, cx| this.go_forward(cx)))
            .child(superhero_icon(
                "superhero/chevron-right.svg",
                NAV_ICON_SIZE_PX,
                forward_color,
            ));

        let reload_btn = div()
            .id("browser-nav-reload")
            .a11y_button("browser.nav.reload", "Reload")
            .size(px(TOOLBAR_BUTTON_SIZE_PX))
            .rounded(px(9999.0))
            .flex()
            .items_center()
            .justify_center()
            .cursor_pointer()
            .hover(move |s| s.bg(hover_bg))
            .on_click(cx.listener(|this, _, _, cx| this.reload(cx)))
            .child(superhero_icon(
                "superhero/refresh.svg",
                NAV_ICON_SIZE_PX,
                fg,
            ));

        h_flex()
            .flex_shrink_0()
            .h(px(TOOLBAR_HEIGHT_PX))
            .px(px(TOOLBAR_INNER_PADDING_PX))
            .gap(px(2.0))
            .items_center()
            .rounded(px(9999.0))
            .bg(control_bg)
            .border_1()
            .border_color(border)
            .child(back_btn)
            .child(forward_btn)
            .child(reload_btn)
    }
}

impl Render for BrowserPanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) -> impl IntoElement {
        // Keep the address field on the page's URL (navigation, redirects, links).
        #[cfg(feature = "cef")]
        let current_url = self
            .view
            .borrow()
            .as_ref()
            .map(BrowserView::url)
            .filter(|u| !u.is_empty())
            .unwrap_or_else(|| self.url.clone());
        #[cfg(not(feature = "cef"))]
        let current_url = self.url.clone();
        if current_url != self.shown_url {
            self.shown_url = current_url.clone();
            self.url_input
                .update(cx, |input, cx| input.set_value(current_url, window, cx));
        }

        let field_bg = to_hsla(self.tokens.shell_field);
        let field_border = to_hsla(self.tokens.shell_divider_header);
        let divider = to_hsla(self.tokens.shell_divider);
        let muted = to_hsla(self.tokens.muted_foreground);
        let fg = to_hsla(self.tokens.foreground);
        let tile_bg = to_hsla(self.tokens.shell_tile);
        let tile_border = to_hsla(self.tokens.shell_tile_border);

        #[cfg(feature = "cef")]
        let body = {
            self.last_scale.set(window.scale_factor().max(1.0));
            if self.visible.get() {
                self.refresh_frame(cx);
            }

            let has_view = self.view.borrow().is_some();
            let cursor_style = self
                .view
                .borrow()
                .as_ref()
                .map_or(CursorStyle::Arrow, |v| map_cursor_style(v.cursor()));
            let current_image = self.rendered_frame.as_ref().map(|(_, img)| img.clone());

            let status_message = match &self.phase {
                RuntimePhase::Downloading(pct) => Some(format!("Downloading Chromium… {pct}%")),
                RuntimePhase::Starting => Some("Starting Chromium…".to_owned()),
                RuntimePhase::Failed(err) => Some(format!("Chromium failed: {err}")),
                RuntimePhase::Idle if !has_view => {
                    Some("Press Enter in the URL bar to load a page.".to_owned())
                }
                RuntimePhase::Running | RuntimePhase::Idle => None,
            };

            let view_for_prepaint = self.view.clone();
            let last_bounds = self.last_bounds.clone();
            let last_scale = self.last_scale.clone();
            let should_create = matches!(self.phase, RuntimePhase::Running) && !has_view;
            let entity = cx.entity().downgrade();
            let visible = self.visible.clone();
            let applied_size = self.applied_size.clone();
            let applied_hidden = self.applied_hidden.clone();

            let page_canvas = canvas(
                move |bounds, window, cx| {
                    let scale = window.scale_factor().max(1.0);
                    last_scale.set(scale);
                    let rect = WebRect {
                        x: f32::from(bounds.origin.x),
                        y: f32::from(bounds.origin.y),
                        width: f32::from(bounds.size.width),
                        height: f32::from(bounds.size.height),
                    };
                    last_bounds.set(Some(rect));

                    if view_for_prepaint.borrow().is_some() {
                        let usable = rect.width >= 1.0 && rect.height >= 1.0;
                        if usable {
                            let size_key = (
                                rect.width.round() as i32,
                                rect.height.round() as i32,
                                scale.to_bits(),
                            );
                            if applied_size.get() != Some(size_key) {
                                applied_size.set(Some(size_key));
                                if let Some(view) = view_for_prepaint.borrow().as_ref() {
                                    view.set_size(rect.width, rect.height, scale);
                                }
                            }
                        }
                        apply_hidden(
                            &view_for_prepaint,
                            &applied_hidden,
                            !(usable && visible.get()),
                        );
                    } else if should_create && let Some(panel) = entity.upgrade() {
                        panel.update(cx, |panel, cx| panel.maybe_create_view_deferred(cx));
                    }
                    bounds
                },
                move |bounds, _, window, _cx| {
                    if let Some(image) = current_image.as_ref() {
                        let _ = window.paint_image(
                            bounds,
                            bounds,
                            Corners::default(),
                            image.clone(),
                            0,
                            false,
                        );
                    }
                },
            )
            .size_full();

            let mut container = div()
                .id("browser-page-viewport")
                .a11y(
                    gpui_kit::Role::Document,
                    "browser.viewport",
                    format!("Browser page {}", self.url),
                )
                .relative()
                .flex_1()
                .min_h_0()
                .w_full()
                .overflow_hidden()
                .track_focus(&self.focus_handle)
                .cursor(cursor_style)
                .on_mouse_down(
                    MouseButton::Left,
                    cx.listener(|this, event: &MouseDownEvent, window, cx| {
                        this.handle_mouse_down(event, window, cx);
                    }),
                )
                .on_mouse_down(
                    MouseButton::Right,
                    cx.listener(|this, event: &MouseDownEvent, window, cx| {
                        this.handle_mouse_down(event, window, cx);
                    }),
                )
                .on_mouse_down(
                    MouseButton::Middle,
                    cx.listener(|this, event: &MouseDownEvent, window, cx| {
                        this.handle_mouse_down(event, window, cx);
                    }),
                )
                .on_mouse_up(
                    MouseButton::Left,
                    cx.listener(|this, event: &MouseUpEvent, _window, _cx| {
                        this.handle_mouse_up(event);
                    }),
                )
                .on_mouse_up(
                    MouseButton::Right,
                    cx.listener(|this, event: &MouseUpEvent, _window, _cx| {
                        this.handle_mouse_up(event);
                    }),
                )
                .on_mouse_up(
                    MouseButton::Middle,
                    cx.listener(|this, event: &MouseUpEvent, _window, _cx| {
                        this.handle_mouse_up(event);
                    }),
                )
                .on_mouse_move(cx.listener(|this, event: &MouseMoveEvent, _window, _cx| {
                    this.handle_mouse_move(event);
                }))
                .on_scroll(cx.listener(|this, event: &ScrollEvent, _window, _cx| {
                    this.handle_scroll(event);
                }))
                .on_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| {
                    this.handle_key_down(event, window, cx);
                }))
                .on_key_up(cx.listener(|this, event: &KeyUpEvent, window, cx| {
                    this.handle_key_up(event, window, cx);
                }))
                .child(page_canvas);

            if let Some(message) = status_message {
                container = container.child(
                    v_flex()
                        .absolute()
                        .inset_0()
                        .items_center()
                        .justify_center()
                        .gap(px(10.0))
                        .child(
                            div()
                                .size(px(40.0))
                                .rounded(px(10.0))
                                .bg(tile_bg)
                                .border_1()
                                .border_color(tile_border)
                                .flex()
                                .items_center()
                                .justify_center()
                                .child(superhero_icon("superhero/globe.svg", 18.0, fg)),
                        )
                        .child(
                            div()
                                .text_size(px(UI_TEXT_PX))
                                .line_height(px(UI_LINE_HEIGHT_PX))
                                .text_color(muted)
                                .child(message),
                        ),
                );
            }
            container
        };

        #[cfg(not(feature = "cef"))]
        let body = {
            let _ = window;
            v_flex()
                .flex_1()
                .size_full()
                .items_center()
                .justify_center()
                .gap(px(10.0))
                .child(
                    div()
                        .size(px(40.0))
                        .rounded(px(10.0))
                        .bg(tile_bg)
                        .border_1()
                        .border_color(tile_border)
                        .flex()
                        .items_center()
                        .justify_center()
                        .child(superhero_icon("superhero/globe.svg", 18.0, fg)),
                )
                .child(
                    div()
                        .text_size(px(UI_TEXT_PX))
                        .line_height(px(UI_LINE_HEIGHT_PX))
                        .text_color(muted)
                        .child("Browser runtime not built (enable feature cef)"),
                )
        };

        v_flex()
            .size_full()
            .child(
                div()
                    .id("browser-toolbar")
                    .a11y(
                        gpui_kit::Role::Toolbar,
                        "browser.toolbar",
                        "Browser toolbar",
                    )
                    .flex()
                    .flex_row()
                    .w_full()
                    .pt(px(TOOLBAR_PAD_Y_PX))
                    .pb(px(TOOLBAR_PAD_Y_PX))
                    .pl(px(TOOLBAR_PAD_START_PX))
                    .pr(px(TOOLBAR_PAD_END_PX))
                    .gap(px(8.0))
                    .items_center()
                    .child(self.render_nav_toolbar_group(cx))
                    .child(
                        div()
                            .id("browser-url-bar")
                            .a11y_group("browser.url-bar", format!("Address bar: {}", self.url))
                            .flex()
                            .flex_row()
                            .flex_1()
                            .min_w_0()
                            .h(px(TOOLBAR_HEIGHT_PX))
                            .rounded(px(9999.0))
                            .bg(field_bg)
                            .border_1()
                            .border_color(field_border)
                            .pl(px(8.0))
                            .pr(px(10.0))
                            .gap(px(6.0))
                            .items_center()
                            .child(superhero_icon("superhero/globe.svg", 14.0, muted))
                            .child(
                                div().flex_1().min_w_0().child(
                                    Input::new(&self.url_input)
                                        .appearance(false)
                                        .text_size(px(UI_TEXT_PX)),
                                ),
                            ),
                    ),
            )
            .child(div().w_full().h(px(1.0)).bg(divider))
            .child(body)
    }
}

fn default_browser_url() -> String {
    std::env::var(DEFAULT_URL_ENV)
        .ok()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_FALLBACK_URL.to_owned())
}

fn normalize_url(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return DEFAULT_FALLBACK_URL.to_owned();
    }
    if trimmed.contains("://") || trimmed.starts_with("about:") || trimmed.starts_with("data:") {
        trimmed.to_owned()
    } else {
        format!("http://{trimmed}")
    }
}

#[cfg(feature = "cef")]
fn initial_phase() -> RuntimePhase {
    match WebRuntime::global().state() {
        WebRuntimeState::Running => RuntimePhase::Running,
        WebRuntimeState::Starting => RuntimePhase::Starting,
        WebRuntimeState::Downloading { progress_percent } => {
            RuntimePhase::Downloading(progress_percent)
        }
        WebRuntimeState::Failed(why) => RuntimePhase::Failed(why),
        WebRuntimeState::NotInstalled => RuntimePhase::Idle,
    }
}

/// Sends the hidden state to CEF only when it changes.
#[cfg(feature = "cef")]
fn apply_hidden(
    view: &Rc<RefCell<Option<BrowserView>>>,
    applied: &Rc<Cell<Option<bool>>>,
    hidden: bool,
) {
    if applied.get() == Some(hidden) {
        return;
    }
    if let Some(view) = view.borrow().as_ref() {
        view.set_hidden(hidden);
        applied.set(Some(hidden));
    }
}

#[cfg(feature = "cef")]
fn map_mouse_button(button: MouseButton) -> Option<WebMouseButton> {
    match button {
        MouseButton::Left => Some(WebMouseButton::Left),
        MouseButton::Middle => Some(WebMouseButton::Middle),
        MouseButton::Right => Some(WebMouseButton::Right),
        MouseButton::Navigate(_) => None,
    }
}

#[cfg(feature = "cef")]
fn map_modifiers(
    modifiers: GpuiModifiers,
    pressed_button: Option<MouseButton>,
    is_repeat: bool,
) -> WebModifiers {
    WebModifiers {
        shift: modifiers.shift,
        control: modifiers.control,
        alt: modifiers.alt,
        command: modifiers.platform,
        left_button: pressed_button == Some(MouseButton::Left),
        middle_button: pressed_button == Some(MouseButton::Middle),
        right_button: pressed_button == Some(MouseButton::Right),
        is_repeat,
    }
}

#[cfg(feature = "cef")]
fn map_cursor_style(kind: CursorKind) -> CursorStyle {
    match kind {
        CursorKind::Default | CursorKind::Wait => CursorStyle::Arrow,
        CursorKind::Pointer => CursorStyle::PointingHand,
        CursorKind::Text => CursorStyle::IBeam,
        CursorKind::Crosshair => CursorStyle::Crosshair,
        CursorKind::Move | CursorKind::Grab => CursorStyle::OpenHand,
        CursorKind::Grabbing => CursorStyle::ClosedHand,
        CursorKind::NotAllowed => CursorStyle::OperationNotAllowed,
        CursorKind::ResizeEW => CursorStyle::ResizeLeftRight,
        CursorKind::ResizeNS => CursorStyle::ResizeUpDown,
        CursorKind::ResizeNESW => CursorStyle::ResizeUpLeftDownRight,
        CursorKind::ResizeNWSE => CursorStyle::ResizeUpRightDownLeft,
        CursorKind::ResizeCol => CursorStyle::ResizeColumn,
        CursorKind::ResizeRow => CursorStyle::ResizeRow,
        CursorKind::VerticalText => CursorStyle::IBeamCursorForVerticalLayout,
        CursorKind::ContextMenu => CursorStyle::ContextualMenu,
        CursorKind::Alias => CursorStyle::DragLink,
        CursorKind::Copy => CursorStyle::DragCopy,
    }
}

#[cfg(feature = "cef")]
fn gpui_key_to_windows_vk(key: &str) -> i32 {
    match key {
        "backspace" => 0x08,
        "tab" => 0x09,
        "enter" => 0x0D,
        "escape" => 0x1B,
        "space" | " " => 0x20,
        "pageup" => 0x21,
        "pagedown" => 0x22,
        "end" => 0x23,
        "home" => 0x24,
        "left" => 0x25,
        "up" => 0x26,
        "right" => 0x27,
        "down" => 0x28,
        "insert" => 0x2D,
        "delete" => 0x2E,
        "f1" => 0x70,
        "f2" => 0x71,
        "f3" => 0x72,
        "f4" => 0x73,
        "f5" => 0x74,
        "f6" => 0x75,
        "f7" => 0x76,
        "f8" => 0x77,
        "f9" => 0x78,
        "f10" => 0x79,
        "f11" => 0x7A,
        "f12" => 0x7B,
        ";" => 0xBA,
        "=" => 0xBB,
        "," => 0xBC,
        "-" => 0xBD,
        "." => 0xBE,
        "/" => 0xBF,
        "`" => 0xC0,
        "[" => 0xDB,
        "\\" => 0xDC,
        "]" => 0xDD,
        "'" => 0xDE,
        other => {
            let mut chars = other.chars();
            match (chars.next(), chars.next()) {
                (Some(ch), None) if ch.is_ascii_alphabetic() => {
                    i32::from(ch.to_ascii_uppercase() as u8)
                }
                (Some(ch), None) if ch.is_ascii_digit() => i32::from(ch as u8),
                _ => 0,
            }
        }
    }
}
