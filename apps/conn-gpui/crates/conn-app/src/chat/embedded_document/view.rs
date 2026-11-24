//! The isolated CEF surface behind every embedded document and video.
//!
//! It reuses the app's CEF runtime and offscreen frame/input path, and deliberately nothing else
//! of the browser panel: no overlay, annotation, vault, Laravel toolbar, DevTools or context menu,
//! and no way to navigate away from the host page it was made with.
//!
//! The host page is served from a bounded loopback server ([`LocalPage`]), not a `data:` URL:
//! Chromium treats a page with no network address as public and, with its local-network
//! protections on, blocks it from loading a loopback or LAN `conn-server`. A loopback page may
//! load any address, so the protections stay on and the guest keeps its sandbox and CSP.
//!
//! The only channel from the page to the app is the console, and only lines that start with a
//! per-surface random prefix reach the owner. A guest inside the host page cannot read the prefix
//! (the host page's script holds it, and a sandboxed guest cannot reach the host page), so it
//! cannot forge those lines. The owner treats every line as untrusted data. The prefix never
//! leaves this process and the surface logs nothing about page contents or URLs.

use std::cell::{Cell, RefCell};
use std::fmt;
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

use conn_theme::Tokens;
use conn_web::{
    BrowserView, EditCommand, KeyEvent as WebKeyEvent, KeyEventKind, Rect as WebRect, WebRuntime,
    WebRuntimeState,
};
use gpui_kit::prelude::*;
use gpui_kit::{
    Context, Corners, CursorStyle, EventEmitter, FocusHandle, IntoElement, KeyDownEvent,
    KeyUpEvent, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, ParentElement, Pixels,
    Point, Render, RenderImage, ScrollDelta, ScrollEvent, SharedString, Styled, Task, Window,
    canvas, div, px,
};
use serde_json::Value;

use super::input::{gpui_key_to_windows_vk, map_cursor_style, map_modifiers, map_mouse_button};
use super::local_page::{LocalPage, random_hex};
use super::protocol::MAX_MESSAGE_BYTES;
use crate::a11y::ConnA11yExt as _;
use crate::chat::color::hsla;
use crate::runtime_warmup;

const SCROLL_LINE_PX: f32 = 40.0;
const UI_TEXT_PX: f32 = 13.0;
const UI_LINE_HEIGHT_PX: f32 = 20.0;
/// The most events waiting for the main thread; a flooding page loses the rest.
const EVENT_QUEUE: usize = 256;
/// A console line this long can only be abuse (the host page caps messages below it).
const MAX_CONSOLE_BYTES: usize = MAX_MESSAGE_BYTES + 1024;

/// Where the shared Chromium runtime is, as far as this surface can tell.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum SurfacePhase {
    Idle,
    Downloading(u8),
    Starting,
    Running,
    Failed(String),
    /// The loopback server for the host page could not start.
    PageUnavailable,
}

/// A signed URL: a secret, so it never prints.
pub(super) struct SecretUrl(pub(super) String);

impl fmt::Debug for SecretUrl {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SecretUrl(..)")
    }
}

/// What the page tells the owner.
#[derive(Debug)]
pub(super) enum SurfaceEvent {
    /// The host page finished loading; its script is ready for [`IsolatedSurface::run_js`].
    PageLoaded,
    /// One JSON line the host page wrote with the surface prefix. Untrusted.
    Message(Value),
    /// The reader pressed a mouse button or key in the surface. Owners use it to allow
    /// actions that need a recent user gesture, such as opening a link.
    UserInput,
}

pub(super) struct IsolatedSurface {
    tokens: Tokens,
    ax_id: SharedString,
    ax_label: SharedString,
    prefix: String,
    /// The loopback URL of the host page. Its path is a random token, so it stays out of logs;
    /// the page holds no signed URL.
    page_url: String,
    /// Serves the host page; dropping it stops the server.
    page_server: Option<LocalPage>,
    focus_handle: FocusHandle,
    view: Rc<RefCell<Option<BrowserView>>>,
    rendered_frame: Option<(u64, Arc<RenderImage>)>,
    last_bounds: Rc<Cell<Option<WebRect>>>,
    last_scale: Rc<Cell<f32>>,
    applied_size: Rc<Cell<Option<(i32, i32, u32)>>>,
    applied_hidden: Rc<Cell<Option<bool>>>,
    creating_view: Rc<Cell<bool>>,
    visible: Rc<Cell<bool>>,
    phase: SurfacePhase,
    polling_runtime: bool,
    wake_task: Option<Task<()>>,
    event_task: Option<Task<()>>,
}

impl fmt::Debug for IsolatedSurface {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("IsolatedSurface")
            .field("ax_id", &self.ax_id)
            .field("phase", &self.phase)
            .finish_non_exhaustive()
    }
}

impl EventEmitter<SurfaceEvent> for IsolatedSurface {}

fn runtime_phase(state: &WebRuntimeState) -> SurfacePhase {
    match state {
        WebRuntimeState::Running => SurfacePhase::Running,
        WebRuntimeState::Downloading { progress_percent } => {
            SurfacePhase::Downloading(*progress_percent)
        }
        WebRuntimeState::Failed(why) => SurfacePhase::Failed(why.clone()),
        WebRuntimeState::Starting | WebRuntimeState::NotInstalled => SurfacePhase::Starting,
    }
}

fn initial_phase() -> SurfacePhase {
    match WebRuntime::global().state() {
        WebRuntimeState::Running => SurfacePhase::Running,
        WebRuntimeState::Starting => SurfacePhase::Starting,
        WebRuntimeState::Downloading { progress_percent } => {
            SurfacePhase::Downloading(progress_percent)
        }
        WebRuntimeState::Failed(why) => SurfacePhase::Failed(why),
        WebRuntimeState::NotInstalled => SurfacePhase::Idle,
    }
}

/// Sends the hidden state to CEF only when it changes.
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

impl IsolatedSurface {
    /// `page` builds the host page's HTML from the surface prefix, which the page's script must
    /// put in front of every line it writes to the console for the owner.
    pub(super) fn new(
        page: impl FnOnce(&str) -> String,
        ax_id: impl Into<SharedString>,
        ax_label: impl Into<SharedString>,
        tokens: Tokens,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) -> Self {
        // The console prefix and the page's path are capabilities from the OS random source. If
        // it fails the surface stays unavailable; nothing weaker takes its place.
        let served = random_hex().and_then(|secret| {
            let prefix = format!("__CONN_DOC_{secret}__:");
            LocalPage::serve(page(&prefix)).map(|server| (prefix, server))
        });
        let (prefix, page_server, page_url, phase) = match served {
            Ok((prefix, server)) => {
                let url = server.url();
                (prefix, Some(server), url, initial_phase())
            }
            Err(_) => (
                String::new(),
                None,
                String::new(),
                SurfacePhase::PageUnavailable,
            ),
        };
        let mut surface = Self {
            tokens,
            ax_id: ax_id.into(),
            ax_label: ax_label.into(),
            prefix,
            page_url,
            page_server,
            focus_handle: cx.focus_handle(),
            view: Rc::new(RefCell::new(None)),
            rendered_frame: None,
            last_bounds: Rc::new(Cell::new(None)),
            last_scale: Rc::new(Cell::new(window.scale_factor().max(1.0))),
            applied_size: Rc::new(Cell::new(None)),
            applied_hidden: Rc::new(Cell::new(None)),
            creating_view: Rc::new(Cell::new(false)),
            visible: Rc::new(Cell::new(true)),
            phase,
            polling_runtime: false,
            wake_task: None,
            event_task: None,
        };
        surface.start_runtime(cx);
        surface
    }

    pub(super) fn set_tokens(&mut self, tokens: Tokens, cx: &mut Context<'_, Self>) {
        self.tokens = tokens;
        cx.notify();
    }

    /// Hidden surfaces stop painting and mute; showing one starts the runtime if it had not.
    pub(super) fn set_visible(&mut self, visible: bool, cx: &mut Context<'_, Self>) {
        if self.visible.get() == visible {
            return;
        }
        self.visible.set(visible);
        if visible {
            self.start_runtime(cx);
        } else {
            apply_hidden(&self.view, &self.applied_hidden, true);
        }
        cx.notify();
    }

    pub(super) fn has_view(&self) -> bool {
        self.view.borrow().is_some()
    }

    /// Runs `code` in the host page. The owner builds it from trusted text and JSON only.
    pub(super) fn run_js(&self, code: &str) {
        if let Some(view) = self.view.borrow().as_ref() {
            view.execute_javascript(code);
        }
    }

    /// Loads the host page again, which replaces everything the previous one held.
    pub(super) fn reload_page(&self) {
        if let Some(view) = self.view.borrow().as_ref() {
            view.load_url(&self.page_url);
        }
    }

    fn start_runtime(&mut self, cx: &mut Context<'_, Self>) {
        // Without its server there is no page to load, so Chromium has nothing to start for.
        if self.page_server.is_none() {
            return;
        }
        if self.view.borrow().is_some() {
            apply_hidden(&self.view, &self.applied_hidden, !self.visible.get());
            return;
        }
        if runtime_warmup::disabled() {
            self.phase = SurfacePhase::Failed("Chromium is turned off in this run".into());
            cx.notify();
            return;
        }
        if WebRuntime::global().state() == WebRuntimeState::Running {
            self.phase = SurfacePhase::Running;
            self.maybe_create_view_deferred(cx);
        } else {
            // The launch warm-up is normally under way; this joins it, or retries after a failure.
            runtime_warmup::begin(cx);
            self.phase = runtime_phase(&WebRuntime::global().state());
            self.poll_runtime_ready(cx);
        }
        cx.notify();
    }

    fn poll_runtime_ready(&mut self, cx: &mut Context<'_, Self>) {
        if self.polling_runtime {
            return;
        }
        self.polling_runtime = true;
        cx.spawn(async move |this, cx| {
            let mut starting_since: Option<std::time::Instant> = None;
            loop {
                cx.background_executor()
                    .timer(Duration::from_millis(20))
                    .await;
                let state = WebRuntime::global().state();
                let failure = runtime_warmup::failure();
                let finished = match (&state, failure) {
                    (WebRuntimeState::Running, _) => Some(SurfacePhase::Running),
                    (_, Some(why)) => Some(SurfacePhase::Failed(why)),
                    (WebRuntimeState::Failed(why), None) if !runtime_warmup::active() => {
                        Some(SurfacePhase::Failed(why.clone()))
                    }
                    (WebRuntimeState::Starting, None)
                        if starting_since
                            .get_or_insert_with(std::time::Instant::now)
                            .elapsed()
                            > Duration::from_secs(60) =>
                    {
                        Some(SurfacePhase::Failed(
                            "timed out waiting for Chromium to start".into(),
                        ))
                    }
                    _ => None,
                };
                let alive = this.update(cx, |surface, cx| {
                    let phase = finished.clone().unwrap_or_else(|| runtime_phase(&state));
                    let ready = matches!(phase, SurfacePhase::Running);
                    if surface.phase != phase {
                        surface.phase = phase;
                        cx.notify();
                    }
                    if finished.is_some() {
                        surface.polling_runtime = false;
                        if ready {
                            surface.maybe_create_view_deferred(cx);
                        }
                    }
                });
                if alive.is_err() || finished.is_some() {
                    break;
                }
            }
        })
        .detach();
    }

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
        let page_url = self.page_url.clone();
        let prefix = self.prefix.clone();
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
            if view_slot.borrow().is_some() || entity.upgrade().is_none() || !visible.get() {
                return;
            }
            let rect = last_bounds.get().unwrap_or(bounds);
            let scale = last_scale.get().max(1.0);
            match BrowserView::create(rect, scale, &page_url) {
                Ok(browser_view) => {
                    // Capacity 1 coalesces frame bursts into one repaint without a busy loop.
                    let (wake_tx, mut wake_rx) = tokio::sync::mpsc::channel::<()>(1);
                    browser_view.on_frame(move || {
                        let _ = wake_tx.try_send(());
                    });

                    let (event_tx, mut event_rx) =
                        tokio::sync::mpsc::channel::<SurfaceEvent>(EVENT_QUEUE);
                    let console_tx = event_tx.clone();
                    browser_view.on_console_message(move |message| {
                        let Some(rest) = message.strip_prefix(prefix.as_str()) else {
                            return false;
                        };
                        if rest.len() <= MAX_CONSOLE_BYTES
                            && let Ok(value) = serde_json::from_str::<Value>(rest)
                        {
                            let _ = console_tx.try_send(SurfaceEvent::Message(value));
                        }
                        true
                    });
                    browser_view.on_load_end(move |_url, _status| {
                        let _ = event_tx.try_send(SurfaceEvent::PageLoaded);
                    });

                    let hidden = !visible.get();
                    browser_view.set_hidden(hidden);
                    applied_hidden.set(Some(hidden));
                    *view_slot.borrow_mut() = Some(browser_view);

                    if let Some(surface) = entity.upgrade() {
                        surface.update(cx, |surface, cx| {
                            surface.phase = SurfacePhase::Running;
                            surface.wake_task = Some(cx.spawn(async move |this, cx| {
                                while wake_rx.recv().await.is_some() {
                                    if this.update(cx, |_surface, cx| cx.notify()).is_err() {
                                        break;
                                    }
                                }
                            }));
                            surface.event_task = Some(cx.spawn(async move |this, cx| {
                                while let Some(event) = event_rx.recv().await {
                                    if this.update(cx, |_surface, cx| cx.emit(event)).is_err() {
                                        break;
                                    }
                                }
                            }));
                            cx.notify();
                        });
                    }
                }
                Err(err) => {
                    if let Some(surface) = entity.upgrade() {
                        surface.update(cx, |surface, cx| {
                            surface.phase = SurfacePhase::Failed(err.to_string());
                            cx.notify();
                        });
                    }
                }
            }
        });
    }

    /// Pulls a new BGRA frame from CEF only when its generation advances.
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

    fn local_coords(&self, position: Point<Pixels>) -> Option<(i32, i32)> {
        let bounds = self.last_bounds.get()?;
        let x = (f32::from(position.x) - bounds.x).round() as i32;
        let y = (f32::from(position.y) - bounds.y).round() as i32;
        Some((x.max(0), y.max(0)))
    }

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
        cx.emit(SurfaceEvent::UserInput);
    }

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

    fn handle_key_down(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        if !self.focus_handle.is_focused(window) {
            return;
        }
        cx.emit(SurfaceEvent::UserInput);
        let guard = self.view.borrow();
        let Some(view) = guard.as_ref() else {
            return;
        };
        let ks = &event.keystroke;
        let mods = map_modifiers(ks.modifiers, None, event.is_held);

        // Standard macOS Cmd+edit shortcuts go straight to the focused frame.
        if ks.modifiers.platform && !ks.modifiers.control && !ks.modifiers.alt {
            let command = match ks.key.as_str() {
                "c" => Some(EditCommand::Copy),
                "x" => Some(EditCommand::Cut),
                "v" => Some(EditCommand::Paste),
                "a" => Some(EditCommand::SelectAll),
                "z" if ks.modifiers.shift => Some(EditCommand::Redo),
                "z" => Some(EditCommand::Undo),
                _ => None,
            };
            if let Some(command) = command {
                view.execute_edit_command(command);
                cx.stop_propagation();
                return;
            }
        }

        let first_char = ks
            .key_char
            .as_deref()
            .and_then(|s| s.encode_utf16().next())
            .unwrap_or(0);
        view.send_key_event(WebKeyEvent {
            kind: KeyEventKind::RawKeyDown,
            windows_key_code: gpui_key_to_windows_vk(&ks.key),
            native_key_code: 0,
            character: first_char,
            unmodified_character: ks.key.encode_utf16().next().unwrap_or(0),
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
        view.send_key_event(WebKeyEvent {
            kind: KeyEventKind::KeyUp,
            windows_key_code: gpui_key_to_windows_vk(&ks.key),
            native_key_code: 0,
            character: ks
                .key_char
                .as_deref()
                .and_then(|s| s.encode_utf16().next())
                .unwrap_or(0),
            unmodified_character: ks.key.encode_utf16().next().unwrap_or(0),
            modifiers: map_modifiers(ks.modifiers, None, false),
            is_system_key: ks.modifiers.alt,
        });
        cx.stop_propagation();
    }
}

impl Render for IsolatedSurface {
    fn render(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) -> impl IntoElement {
        self.last_scale.set(window.scale_factor().max(1.0));
        if self.visible.get() {
            self.refresh_frame(cx);
        }

        let has_view = self.view.borrow().is_some();
        let cursor_style = self
            .view
            .borrow()
            .as_ref()
            .map_or(CursorStyle::Arrow, |view| map_cursor_style(view.cursor()));
        let current_image = self.rendered_frame.as_ref().map(|(_, image)| image.clone());
        let status_message = match &self.phase {
            SurfacePhase::Downloading(percent) => Some(format!("Downloading Chromium… {percent}%")),
            SurfacePhase::Starting | SurfacePhase::Idle => Some("Starting Chromium…".to_owned()),
            SurfacePhase::Failed(why) => Some(format!("Chromium failed: {why}")),
            SurfacePhase::PageUnavailable => Some("Couldn't start the local page.".to_owned()),
            SurfacePhase::Running => None,
        }
        .filter(|_| !has_view);

        let view_for_prepaint = self.view.clone();
        let last_bounds = self.last_bounds.clone();
        let last_scale = self.last_scale.clone();
        let should_create = matches!(self.phase, SurfacePhase::Running) && !has_view;
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
                } else if should_create && let Some(surface) = entity.upgrade() {
                    surface.update(cx, |surface, cx| surface.maybe_create_view_deferred(cx));
                }
                bounds
            },
            move |bounds, _, window, _cx| {
                if let Some(image) = current_image.as_ref() {
                    let _ = window.paint_image(
                        bounds,
                        bounds,
                        Corners::all(px(crate::chat::card_face::CARD_BODY_RADIUS_PX)),
                        image.clone(),
                        0,
                        false,
                    );
                }
            },
        )
        .size_full();

        let mut container = div()
            .id(self.ax_id.clone())
            .a11y(
                gpui_kit::Role::Document,
                self.ax_id.clone(),
                self.ax_label.clone(),
            )
            .relative()
            .size_full()
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
                div()
                    .absolute()
                    .inset_0()
                    .flex()
                    .items_center()
                    .justify_center()
                    .text_size(px(UI_TEXT_PX))
                    .line_height(px(UI_LINE_HEIGHT_PX))
                    .text_color(hsla(self.tokens.muted_foreground))
                    .child(message),
            );
        }
        container
    }
}
