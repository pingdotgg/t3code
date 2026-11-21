//! Browser right-panel surface with Conn's ToolbarGroup navigation controls,
//! soft pill URL bar, and optional CEF-on-demand embedded Chromium view.

#[cfg(feature = "cef")]
use std::cell::{Cell, RefCell};
#[cfg(feature = "cef")]
use std::ffi::c_void;
use std::fmt;
#[cfg(feature = "cef")]
use std::rc::Rc;
#[cfg(feature = "cef")]
use std::time::Duration;

use conn_theme::Tokens;
#[cfg(feature = "cef")]
use conn_web::{BrowserView, Rect as WebRect, WebError, WebRuntime, WebRuntimeState};
#[cfg(feature = "cef")]
use futures::StreamExt as _;
#[cfg(feature = "cef")]
use gpui_kit::canvas;
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::*;
use gpui_kit::{
    Context, Entity, IntoElement, ParentElement, Render, Styled, Subscription, Window, div, px,
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
/// optional on-demand CEF child `NSView` (when compiled with feature `cef`).
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
    view: Rc<RefCell<Option<BrowserView>>>,
    #[cfg(feature = "cef")]
    last_bounds: Rc<Cell<Option<WebRect>>>,
    #[cfg(feature = "cef")]
    parent_view: Rc<Cell<Option<usize>>>,
    #[cfg(feature = "cef")]
    creating_view: Rc<Cell<bool>>,
    /// Whether the shell shows this panel (right panel open, Browser tab active, no GPUI
    /// overlay on top). The native view is hidden whenever this is false.
    #[cfg(feature = "cef")]
    visible: Rc<Cell<bool>>,
    /// Bounds last sent to the native view, so AppKit only hears about real changes.
    #[cfg(feature = "cef")]
    applied_bounds: Rc<Cell<Option<WebRect>>>,
    /// Hidden state last sent to the native view.
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
        let view: Rc<RefCell<Option<BrowserView>>> = Rc::new(RefCell::new(None));
        #[cfg(feature = "cef")]
        let last_bounds = Rc::new(Cell::new(None));
        #[cfg(feature = "cef")]
        let parent_view = Rc::new(Cell::new(native_ns_view(window).map(|p| p as usize)));
        #[cfg(feature = "cef")]
        let creating_view = Rc::new(Cell::new(false));

        Self {
            tokens,
            url_input,
            shown_url: initial_url.clone(),
            url: initial_url,
            _subscriptions: subscriptions,
            #[cfg(feature = "cef")]
            phase: initial_phase(),
            #[cfg(feature = "cef")]
            view,
            #[cfg(feature = "cef")]
            visible: Rc::new(Cell::new(false)),
            #[cfg(feature = "cef")]
            applied_bounds: Rc::new(Cell::new(None)),
            #[cfg(feature = "cef")]
            applied_hidden: Rc::new(Cell::new(None)),
            #[cfg(feature = "cef")]
            last_bounds,
            #[cfg(feature = "cef")]
            parent_view,
            #[cfg(feature = "cef")]
            creating_view,
        }
    }

    /// Shows or hides the native browser view. The shell calls this whenever the right
    /// panel opens or closes, the tab changes, or a GPUI overlay covers the panel.
    pub(crate) fn set_visible(&mut self, visible: bool, cx: &mut Context<'_, Self>) {
        #[cfg(feature = "cef")]
        {
            if self.visible.get() != visible {
                self.visible.set(visible);
                // Hide at once (the panel is going away), but show only from the panel's
                // own paint, so the native page appears in the same frame as its toolbar
                // instead of a frame early over another panel.
                if !visible {
                    apply_hidden(&self.view, &self.applied_hidden, true);
                }
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
                "parent": self.parent_view.get().is_some(),
                "visible": self.visible.get(),
                "nativeHidden": self.applied_hidden.get(),
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
            view.set_hidden(false);
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
        let Some(parent_ptr) = self.parent_view.get() else {
            return;
        };
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
        let entity = cx.entity().downgrade();

        // Defer BrowserView creation until after GPUI finishes the current frame,
        // matching Threadbear's `web_panels.rs` pattern.
        cx.defer(move |cx| {
            creating_flag.set(false);
            if view_slot.borrow().is_some() {
                return;
            }
            let rect = last_bounds.get().unwrap_or(bounds);
            let result = BrowserView::create(parent_ptr as *mut c_void, rect, &url);
            match result {
                Ok(browser_view) => {
                    let (load_tx, mut load_rx) = futures::channel::mpsc::unbounded::<()>();
                    browser_view.on_load_end(move |_loaded_url, _status| {
                        let _ = load_tx.unbounded_send(());
                    });
                    *view_slot.borrow_mut() = Some(browser_view);
                    if let Some(panel) = entity.upgrade() {
                        panel.update(cx, |panel, cx| {
                            panel.phase = RuntimePhase::Running;
                            cx.spawn(async move |this, cx| {
                                while load_rx.next().await.is_some() {
                                    if this.update(cx, |_panel, cx| cx.notify()).is_err() {
                                        break;
                                    }
                                }
                            })
                            .detach();
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
            if let Some(ns_view) = native_ns_view(window) {
                self.parent_view.set(Some(ns_view as usize));
            }
            let has_view = self.view.borrow().is_some();
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
            let parent_view = self.parent_view.clone();
            let should_create = matches!(self.phase, RuntimePhase::Running) && !has_view;
            let entity = cx.entity().downgrade();

            let visible = self.visible.clone();
            let applied_bounds = self.applied_bounds.clone();
            let applied_hidden = self.applied_hidden.clone();

            let host_canvas = canvas(
                move |bounds, window, cx| {
                    if let Some(ns_view) = native_ns_view(window) {
                        parent_view.set(Some(ns_view as usize));
                    }
                    let rect = WebRect {
                        x: f32::from(bounds.origin.x),
                        y: f32::from(bounds.origin.y),
                        width: f32::from(bounds.size.width),
                        height: f32::from(bounds.size.height),
                    };
                    last_bounds.set(Some(rect));

                    // `BrowserView::set_bounds` converts top-left logical points to AppKit's
                    // flipped coordinate space inside `conn_view_set_frame`.
                    if view_for_prepaint.borrow().is_some() {
                        let usable = rect.width >= 1.0 && rect.height >= 1.0;
                        if usable && applied_bounds.get() != Some(rect) {
                            applied_bounds.set(Some(rect));
                            if let Some(view) = view_for_prepaint.borrow().as_ref() {
                                view.set_bounds(rect);
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
                },
                |_, _, _, _| {},
            )
            .size_full();

            let mut container = div()
                .relative()
                .flex_1()
                .min_h_0()
                .w_full()
                .child(host_canvas);
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
                h_flex()
                    .w_full()
                    .pt(px(TOOLBAR_PAD_Y_PX))
                    .pb(px(TOOLBAR_PAD_Y_PX))
                    .pl(px(TOOLBAR_PAD_START_PX))
                    .pr(px(TOOLBAR_PAD_END_PX))
                    .gap(px(8.0))
                    .items_center()
                    .child(self.render_nav_toolbar_group(cx))
                    .child(
                        h_flex()
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

#[cfg(feature = "cef")]
fn native_ns_view(window: &Window) -> Option<*mut c_void> {
    #[cfg(target_os = "macos")]
    {
        use raw_window_handle::{HasWindowHandle, RawWindowHandle};
        let handle = HasWindowHandle::window_handle(window).ok()?;
        match handle.as_raw() {
            RawWindowHandle::AppKit(h) => Some(h.ns_view.as_ptr()),
            _ => None,
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
        None
    }
}

/// Sends the hidden state to the native view only when it changes.
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
