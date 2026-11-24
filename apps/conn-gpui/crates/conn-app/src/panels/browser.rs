//! Browser right-panel surface with Conn's ToolbarGroup navigation controls,
//! soft pill URL bar, and optional CEF-on-demand offscreen-rendered Chromium view.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::fmt;
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

use crate::a11y::ConnA11yExt as _;
use crate::runtime_warmup;
use conn_client::Connection;
use conn_desktop::vault::{
    VaultClient, VaultLoginField, VaultLoginFillLookup, VaultLoginItem, VaultLoginsStatus,
    https_origin,
};
use conn_state::AnnotationRecord;
use conn_theme::Tokens;
use conn_web::{
    BrowserView, ContextMenuEvent, CursorKind, EditCommand, KeyEvent as WebKeyEvent, KeyEventKind,
    Modifiers as WebModifiers, MouseButton as WebMouseButton, NewTabRequest, Rect as WebRect,
    WebRuntime, WebRuntimeState,
};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::*;
use gpui_kit::{
    Animation, AnimationExt as _, Context, Entity, EventEmitter, FontWeight, IntoElement,
    ParentElement, Render, Styled, Subscription, Transformation, Window, div, percentage, px,
};
use gpui_kit::{
    Corners, CursorStyle, FocusHandle, KeyDownEvent, KeyUpEvent, Modifiers as GpuiModifiers,
    MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, Pixels, Point, RenderImage,
    ScrollDelta, ScrollEvent, Task, canvas,
};

use super::annotations::{
    AnnotationAction, AnnotationSubject, AnnotationUiState, QueuePopoverAnchor,
    QueuePopoverCallbacks, render_queue_popover,
};
use super::browser_context_menu::{MenuActions, OpenMenu, render_context_menu};
use super::chrome::{self, ConnTooltipExt as _};
use super::color::to_hsla;
use super::header::superhero_icon;
use super::laravel_toolbar::{LaravelToolbar, host_script};

const UI_TEXT_PX: f32 = 13.0;
const UI_LINE_HEIGHT_PX: f32 = 20.0;
const TOOLBAR_PAD_Y_PX: f32 = 7.5;
const TOOLBAR_PAD_START_PX: f32 = 8.0;
const TOOLBAR_PAD_END_PX: f32 = TOOLBAR_PAD_START_PX;
const TOOLBAR_HEIGHT_PX: f32 = 32.0;
const TOOLBAR_INNER_PADDING_PX: f32 = 3.0;
const TOOLBAR_BUTTON_SIZE_PX: f32 = 24.0;
const NAV_ICON_SIZE_PX: f32 = 14.0;
const DEFAULT_URL_ENV: &str = "CONN_GPUI_BROWSER_URL";
const DEFAULT_FALLBACK_URL: &str = "about:blank";
/// `PreviewChromeRow`'s address placeholder.
const ADDRESS_PLACEHOLDER: &str = "Search or enter URL";
const SCROLL_LINE_PX: f32 = 40.0;
const OVERLAY_RPC_PREFIX: &str = "__CONN_OVERLAY_RPC__:";
const BROWSER_OVERLAY_BRIDGE_JS: &str = include_str!("browser_overlay_bridge.js");
const CONN_ANNOTATION_OVERLAY_JS: &str = include_str!("../../assets/annotation-overlay/inject.js");

#[derive(serde::Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum OverlayBridgeMessage {
    Rpc {
        #[serde(rename = "requestId")]
        request_id: String,
        op: String,
        #[serde(default)]
        payload: serde_json::Value,
    },
    Mode {
        active: bool,
    },
    LaravelToolbar {
        kind: String,
        #[serde(default)]
        data: serde_json::Value,
        #[serde(default)]
        url: String,
    },
    LaravelToolbarDetails {
        id: String,
        #[serde(default)]
        raw: serde_json::Value,
    },
    PreviewResult {
        #[serde(rename = "requestId")]
        request_id: String,
        ok: bool,
        #[serde(default)]
        value: serde_json::Value,
        #[serde(default)]
        error: Option<String>,
    },
}

enum BrowserOverlayEvent {
    Rpc {
        request_id: String,
        op: String,
        payload: serde_json::Value,
    },
    Mode(bool),
    LaravelToolbar {
        kind: String,
        data: serde_json::Value,
        url: String,
    },
    LaravelToolbarDetails {
        id: String,
        raw: serde_json::Value,
    },
    ToolbarResponse(conn_web::ToolbarResponse),
    LoadStart,
    PreviewResult {
        request_id: String,
        ok: bool,
        value: serde_json::Value,
        error: Option<String>,
    },
    LoadEnd,
    ContextMenu(ContextMenuEvent),
    OpenTab(NewTabRequest),
}

/// What a browser tab tells its host.
#[derive(Clone, Debug)]
pub(crate) enum BrowserTabEvent {
    /// The tab's title (page title or host) changed.
    TitleChanged,
    /// The page's committed address changed: typed, a link, a redirect, back or forward.
    AddressChanged,
    /// The page opened a link in a new tab (`target=_blank`, Cmd-click, middle click).
    OpenTab(NewTabRequest),
}

#[derive(Default)]
struct VaultLoginUiState {
    open: bool,
    loading: bool,
    status: Option<VaultLoginsStatus>,
    items: Vec<VaultLoginItem>,
    error: Option<String>,
    feedback: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum RuntimePhase {
    Idle,
    Downloading(u8),
    Starting,
    Running,
    Failed(String),
}

/// Browser right-panel surface with navigation toolbar, soft URL field, and
/// on-demand CEF offscreen-rendered view.
pub(crate) struct BrowserPanel {
    tokens: Tokens,
    connection: Option<Connection>,
    project_id: Option<String>,
    url_input: Entity<InputState>,
    url: String,
    /// The URL last written into the address field, so it follows navigation.
    shown_url: String,
    _subscriptions: Vec<Subscription>,
    phase: RuntimePhase,
    focus_handle: FocusHandle,
    view: Rc<RefCell<Option<BrowserView>>>,
    rendered_frame: Option<(u64, Arc<RenderImage>)>,
    wake_task: Option<Task<()>>,
    overlay_task: Option<Task<()>>,
    overlay_injected_load_count: Cell<Option<u32>>,
    last_bounds: Rc<Cell<Option<WebRect>>>,
    last_scale: Rc<Cell<f32>>,
    creating_view: Rc<Cell<bool>>,
    /// Whether the shell shows this panel (right panel open, Browser tab active).
    /// When false, CEF is marked hidden so it stops painting.
    visible: Rc<Cell<bool>>,
    /// Size and scale last sent to CEF (`(width_px, height_px, scale_bits)`).
    applied_size: Rc<Cell<Option<(i32, i32, u32)>>>,
    /// Hidden state last sent to CEF.
    applied_hidden: Rc<Cell<Option<bool>>>,
    /// Pending `preview_*` JS evaluations / snapshots / actions awaiting console reply.
    pending_preview:
        HashMap<String, tokio::sync::oneshot::Sender<Result<serde_json::Value, String>>>,
    #[cfg(feature = "automation")]
    preview_seq: u64,
    /// Shared project annotations queue & click-to-annotate state.
    annotations: AnnotationUiState,
    /// Vault login autofill popover state for HTTPS pages.
    vault_logins: VaultLoginUiState,
    /// The Laravel debug bar under the page (`x-toolbar` headers and `__LARAVEL_TOOLBAR_DATA__`).
    laravel_toolbar: Entity<LaravelToolbar>,
    /// The toolbar's overflow menu (`PreviewMoreMenu`) is open.
    more_menu_open: bool,
    /// A task follows the runtime warm-up and updates `phase`.
    polling_runtime: bool,
    /// The page's right-click menu while it is open. Dropping it cancels it.
    context_menu: Option<OpenMenu>,
    /// The user has asked for a page (typed an address, used back, forward or reload, or clicked
    /// in the page), so a load is theirs and the reload button may spin.
    user_load: bool,
    /// The tab title last reported with [`BrowserTabEvent::TitleChanged`].
    reported_title: String,
    /// The address last reported with [`BrowserTabEvent::AddressChanged`].
    reported_url: String,
    /// `__connAnnotationsChanged` calls, CEF view or not, so tests can count them.
    #[cfg(test)]
    annotation_scripts: Cell<usize>,
    /// A page loaded while hidden; its bridge and pins go in when it shows.
    load_injection_pending: bool,
    /// A page started loading while hidden; the debug bar's host script goes in when it shows.
    host_script_pending: bool,
    #[cfg(test)]
    host_scripts: Cell<usize>,
    /// The automation hook needs this page while it is hidden, so its view is made anyway.
    view_while_hidden: Rc<Cell<bool>>,
    /// Preview requests the automation hook sent this page, view or not.
    #[cfg(all(test, feature = "automation"))]
    preview_requests: Cell<usize>,
    #[cfg(test)]
    bridge_injections: Cell<usize>,
    #[cfg(test)]
    overlay_injections: Cell<usize>,
}

impl EventEmitter<AnnotationAction> for BrowserPanel {}
impl EventEmitter<BrowserTabEvent> for BrowserPanel {}

impl fmt::Debug for BrowserPanel {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("BrowserPanel")
            .field("url", &self.url)
            .finish_non_exhaustive()
    }
}

impl BrowserPanel {
    pub(crate) fn new(
        tokens: Tokens,
        connection: Option<Connection>,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) -> Self {
        let initial_url = default_browser_url();
        let url_input = cx.new(|cx| {
            let mut input = InputState::new(window, cx).placeholder(ADDRESS_PLACEHOLDER);
            input.set_value(address_text(&initial_url), window, cx);
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
                    if address_text(&normalized) != raw {
                        let value = address_text(&normalized);
                        input.update(cx, |state, cx| state.set_value(value, window, cx));
                    }
                    this.navigate(normalized, cx);
                }
            },
        ));

        let focus_handle = cx.focus_handle();
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

        // A closed tab releases this panel: free its last frame from the sprite atlas (only a
        // newer frame frees the one before) and close its Chromium browser.
        cx.on_release(|this: &mut Self, cx| this.release(cx))
            .detach();

        let annotations = AnnotationUiState::new(AnnotationSubject::Page, window, cx, |_, _, _| {});
        let view = Rc::new(RefCell::new(None));
        let last_bounds = Rc::new(Cell::new(None));
        let laravel_toolbar =
            cx.new(|cx| LaravelToolbar::new(tokens.clone(), view.clone(), last_bounds.clone(), cx));

        Self {
            tokens,
            connection,
            project_id: None,
            url_input,
            shown_url: initial_url.clone(),
            url: initial_url,
            _subscriptions: subscriptions,
            phase: initial_phase(),
            focus_handle,
            view,
            rendered_frame: None,
            wake_task: None,
            overlay_task: None,
            overlay_injected_load_count: Cell::new(None),
            last_bounds,
            last_scale: Rc::new(Cell::new(window.scale_factor().max(1.0))),
            creating_view: Rc::new(Cell::new(false)),
            visible: Rc::new(Cell::new(false)),
            applied_size: Rc::new(Cell::new(None)),
            applied_hidden: Rc::new(Cell::new(None)),
            pending_preview: HashMap::new(),
            #[cfg(feature = "automation")]
            preview_seq: 0,
            annotations,
            vault_logins: VaultLoginUiState::default(),
            laravel_toolbar,
            more_menu_open: false,
            polling_runtime: false,
            context_menu: None,
            user_load: false,
            reported_title: String::new(),
            reported_url: String::new(),
            #[cfg(test)]
            annotation_scripts: Cell::new(0),
            load_injection_pending: false,
            host_script_pending: false,
            #[cfg(test)]
            host_scripts: Cell::new(0),
            view_while_hidden: Rc::new(Cell::new(false)),
            #[cfg(all(test, feature = "automation"))]
            preview_requests: Cell::new(0),
            #[cfg(test)]
            bridge_injections: Cell::new(0),
            #[cfg(test)]
            overlay_injections: Cell::new(0),
        }
        .with_reported_title()
    }

    fn release(&mut self, cx: &mut gpui_kit::App) {
        if let Some((_, image)) = self.rendered_frame.take() {
            cx.defer(move |cx| cx.drop_image(image, None));
        }
        self.wake_task = None;
        self.overlay_task = None;
        let view = self.view.borrow_mut().take();
        if let Some(view) = view {
            view.close();
        }
    }

    fn with_reported_title(mut self) -> Self {
        self.reported_title = self.tab_title();
        self
    }

    #[cfg(test)]
    pub(crate) fn target_url(&self) -> &str {
        &self.url
    }

    #[cfg(test)]
    pub(crate) fn visible_for_test(&self) -> bool {
        self.visible.get()
    }

    #[cfg(test)]
    pub(crate) fn annotation_scripts(&self) -> usize {
        self.annotation_scripts.get()
    }

    #[cfg(test)]
    pub(crate) fn project_for_test(&self) -> Option<&str> {
        self.project_id.as_deref()
    }

    /// The tab strip's title (`surfaceTitle`): the page title, else its host, else Browser.
    pub(crate) fn tab_title(&self) -> String {
        let view = self.view.borrow();
        match view.as_ref() {
            Some(view) => conn_state::browser_tab_title(&view.title(), &view.url()),
            None => conn_state::browser_tab_title("", &self.url),
        }
    }

    /// Tells the host when the tab title or the committed address changed. Cheap enough to run
    /// on every frame.
    fn report_title(&mut self, cx: &mut Context<'_, Self>) {
        let title = self.tab_title();
        if title != self.reported_title {
            self.reported_title = title;
            cx.emit(BrowserTabEvent::TitleChanged);
        }
        let url = self.current_url();
        if url != self.reported_url {
            self.reported_url = url;
            cx.emit(BrowserTabEvent::AddressChanged);
        }
    }

    /// A page the view committed while no frame ran, as the CEF view reports one in tests.
    #[cfg(test)]
    pub(crate) fn commit_url_for_test(&mut self, url: &str, cx: &mut Context<'_, Self>) {
        self.url = url.to_owned();
        self.report_title(cx);
    }

    pub(crate) fn set_connection(
        &mut self,
        connection: Option<Connection>,
        cx: &mut Context<'_, Self>,
    ) {
        self.connection = connection;
        cx.notify();
    }

    /// The Laravel debug bar entity, for the host to follow its events.
    pub(crate) fn laravel_toolbar(&self) -> Entity<LaravelToolbar> {
        self.laravel_toolbar.clone()
    }

    /// The Conn server the thread runs on: the debug bar changes only its Orbit Instance.
    pub(crate) fn set_environment(&mut self, environment_id: String, cx: &mut Context<'_, Self>) {
        self.laravel_toolbar
            .update(cx, |bar, cx| bar.set_environment(environment_id, cx));
    }

    /// The workspace root: the debug bar opens source files only inside it.
    pub(crate) fn set_workspace_root(&mut self, root: Option<String>, cx: &mut Context<'_, Self>) {
        self.laravel_toolbar.update(cx, |bar, cx| {
            bar.set_project_root(root.map(std::path::PathBuf::from), cx);
        });
    }

    pub(crate) fn set_project(&mut self, project_id: Option<String>, cx: &mut Context<'_, Self>) {
        if self.project_id != project_id {
            self.project_id = project_id;
            self.notify_overlay_annotations_changed();
            cx.notify();
        }
    }

    pub(crate) fn sync_annotations(
        &mut self,
        annotations: Vec<AnnotationRecord>,
        watching: bool,
        project_ready: bool,
        cx: &mut Context<'_, Self>,
    ) {
        if self.annotations.annotations == annotations
            && self.annotations.watching == watching
            && self.annotations.project_ready == project_ready
        {
            return;
        }
        self.annotations.sync(annotations, watching, project_ready);
        self.notify_overlay_annotations_changed();
        self.maybe_show_existing_pins();
        cx.notify();
    }

    /// Where the page is drawn, once it has been.
    #[cfg(feature = "automation")]
    pub(crate) fn web_bounds(&self) -> Option<WebRect> {
        self.last_bounds.get()
    }

    /// Makes this page's view while it is hidden, at `bounds` if it was never drawn, so the
    /// automation hook can act on a tab that is not on screen.
    #[cfg(feature = "automation")]
    pub(crate) fn make_view_while_hidden(
        &mut self,
        bounds: Option<WebRect>,
        cx: &mut Context<'_, Self>,
    ) {
        self.view_while_hidden.set(true);
        if self.last_bounds.get().is_none() {
            self.last_bounds.set(bounds);
        }
        self.maybe_create_view_deferred(cx);
    }

    #[cfg(all(test, feature = "automation"))]
    pub(crate) fn preview_requests(&self) -> usize {
        self.preview_requests.get()
    }

    /// The page's address now, else the one it was asked to load.
    pub(crate) fn page_url(&self) -> String {
        self.current_url()
    }

    fn current_url(&self) -> String {
        self.view
            .borrow()
            .as_ref()
            .map(BrowserView::url)
            .filter(|u| !u.is_empty())
            .unwrap_or_else(|| self.url.clone())
    }

    fn current_origin(&self) -> Option<String> {
        page_origin(&self.current_url())
    }

    fn toggle_annotating_mode(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        if !self.annotations.project_ready {
            return;
        }
        let next = !self.annotations.annotating;
        self.annotations.annotating = next;
        self.annotations.queue_open = false;
        self.annotations.confirming_remove = false;
        if next {
            window.focus(&self.focus_handle, cx);
            if let Some(view) = self.view.borrow().as_ref() {
                view.set_focus(true);
            }
            self.ensure_overlay_injected(false);
        }
        if let Some(view) = self.view.borrow().as_ref() {
            view.execute_javascript(&format!(
                "window.__CONN_GPUI_OVERLAY_BRIDGE__?.setMode({next});"
            ));
        }
        cx.notify();
    }

    /// A page finished loading. Its bridge and pins go in now only if it shows; a hidden tab
    /// takes them when it is shown, so a page in the background runs none of our scripts.
    fn on_load_end(&mut self, cx: &mut Context<'_, Self>) {
        self.overlay_injected_load_count.set(None);
        self.annotations.annotating = false;
        self.vault_logins.open = false;
        if self.visible.get() {
            self.inject_after_load();
        } else {
            self.load_injection_pending = true;
        }
        cx.notify();
    }

    /// A page started loading. The debug bar's host script goes in now only if it shows, as
    /// the bridge does on load end.
    fn on_load_start(&mut self, cx: &mut Context<'_, Self>) {
        if self.visible.get() {
            self.inject_host_script();
        } else {
            self.host_script_pending = true;
        }
        self.laravel_toolbar
            .update(cx, |bar, cx| bar.on_load_start(cx));
    }

    fn inject_host_script(&mut self) {
        self.host_script_pending = false;
        #[cfg(test)]
        self.host_scripts.set(self.host_scripts.get() + 1);
        if let Some(view) = self.view.borrow().as_ref() {
            view.execute_javascript(&host_script());
        }
    }

    #[cfg(test)]
    pub(crate) fn load_start_for_test(&mut self, cx: &mut Context<'_, Self>) {
        self.on_load_start(cx);
    }

    #[cfg(test)]
    pub(crate) fn host_scripts_for_test(&self) -> usize {
        self.host_scripts.get()
    }

    fn inject_after_load(&mut self) {
        self.load_injection_pending = false;
        self.ensure_bridge_injected();
        self.maybe_show_existing_pins();
    }

    #[cfg(test)]
    pub(crate) fn load_end_for_test(&mut self, cx: &mut Context<'_, Self>) {
        self.on_load_end(cx);
    }

    /// Bridge and overlay injections so far, CEF view or not.
    #[cfg(test)]
    pub(crate) fn injections_for_test(&self) -> (usize, usize) {
        (self.bridge_injections.get(), self.overlay_injections.get())
    }

    fn ensure_bridge_injected(&self) {
        #[cfg(test)]
        self.bridge_injections.set(self.bridge_injections.get() + 1);
        if let Some(view) = self.view.borrow().as_ref() {
            view.execute_javascript(BROWSER_OVERLAY_BRIDGE_JS);
        }
    }

    fn ensure_overlay_injected(&self, force: bool) {
        #[cfg(test)]
        self.overlay_injections
            .set(self.overlay_injections.get() + 1);
        let guard = self.view.borrow();
        let Some(view) = guard.as_ref() else {
            return;
        };
        let load_count = view.load_count();
        if !force && self.overlay_injected_load_count.get() == Some(load_count) {
            return;
        }
        view.execute_javascript(BROWSER_OVERLAY_BRIDGE_JS);
        view.execute_javascript(
            r#"window.__CONN_GPUI_OVERLAY_BRIDGE__?.configure({ floatingControl: false, dictation: { provider: "host", autoStart: true, stopOnNextElement: true } });"#,
        );
        view.execute_javascript(CONN_ANNOTATION_OVERLAY_JS);
        view.execute_javascript("window.__CONN_GPUI_OVERLAY_BRIDGE__?.attachModeSync();");
        self.overlay_injected_load_count.set(Some(load_count));
    }

    /// Evaluates JS in the active CEF page and returns its JSON result via the bridge.
    #[cfg(feature = "automation")]
    pub(crate) fn start_preview_eval(
        &mut self,
        expression: &str,
    ) -> Result<tokio::sync::oneshot::Receiver<Result<serde_json::Value, String>>, String> {
        #[cfg(test)]
        self.preview_requests.set(self.preview_requests.get() + 1);
        self.ensure_bridge_injected();
        let guard = self.view.borrow();
        let Some(view) = guard.as_ref() else {
            return Err("No active browser view.".to_owned());
        };
        self.preview_seq += 1;
        let req_id = format!("p{}", self.preview_seq);
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.pending_preview.insert(req_id.clone(), tx);
        let id_json = serde_json::to_string(&req_id).unwrap_or_else(|_| "\"\"".to_owned());
        let expr_json = serde_json::to_string(expression).unwrap_or_else(|_| "\"\"".to_owned());
        view.execute_javascript(&format!(
            "window.__CONN_GPUI_OVERLAY_BRIDGE__?.previewEval({id_json}, {expr_json});"
        ));
        Ok(rx)
    }

    /// Runs a structured `preview_*` helper (`snapshot` or `act`) in the active CEF page.
    #[cfg(feature = "automation")]
    pub(crate) fn start_preview_call(
        &mut self,
        op: &str,
        params: &serde_json::Value,
    ) -> Result<tokio::sync::oneshot::Receiver<Result<serde_json::Value, String>>, String> {
        #[cfg(test)]
        self.preview_requests.set(self.preview_requests.get() + 1);
        self.ensure_bridge_injected();
        let guard = self.view.borrow();
        let Some(view) = guard.as_ref() else {
            return Err("No active browser view.".to_owned());
        };
        self.preview_seq += 1;
        let req_id = format!("p{}", self.preview_seq);
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.pending_preview.insert(req_id.clone(), tx);
        let id_json = serde_json::to_string(&req_id).unwrap_or_else(|_| "\"\"".to_owned());
        let op_json = serde_json::to_string(op).unwrap_or_else(|_| "\"\"".to_owned());
        let params_json = serde_json::to_string(params).unwrap_or_else(|_| "{}".to_owned());
        view.execute_javascript(&format!(
            "window.__CONN_GPUI_OVERLAY_BRIDGE__?.previewCall({id_json}, {op_json}, {params_json});"
        ));
        Ok(rx)
    }

    /// Saves the active CEF view's latest BGRA frame as a PNG file.
    #[cfg(feature = "automation")]
    pub(crate) fn save_browser_screenshot(
        &self,
        path: &std::path::Path,
    ) -> Result<serde_json::Value, String> {
        use image::ImageEncoder as _;

        let frame = self
            .view
            .borrow()
            .as_ref()
            .and_then(BrowserView::latest_frame)
            .ok_or_else(|| "No browser frame available yet.".to_owned())?;
        if frame.width == 0 || frame.height == 0 {
            return Err("Empty browser frame.".to_owned());
        }
        let mut rgba = Vec::with_capacity((frame.width as usize) * (frame.height as usize) * 4);
        for px in frame.bgra.as_chunks::<4>().0 {
            rgba.extend_from_slice(&[px[2], px[1], px[0], px[3]]);
        }
        let mut png = Vec::new();
        image::codecs::png::PngEncoder::new(&mut png)
            .write_image(
                &rgba,
                frame.width,
                frame.height,
                image::ExtendedColorType::Rgba8,
            )
            .map_err(|e| e.to_string())?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(path, &png).map_err(|e| e.to_string())?;
        Ok(serde_json::json!({
            "path": path.display().to_string(),
            "width": frame.width,
            "height": frame.height,
            "bytes": png.len(),
        }))
    }

    fn toggle_vault_logins_popover(&mut self, allow_unlock: bool, cx: &mut Context<'_, Self>) {
        if !allow_unlock && self.vault_logins.open {
            self.vault_logins.open = false;
            cx.notify();
            return;
        }
        self.vault_logins.open = true;
        self.vault_logins.loading = true;
        self.vault_logins.error = None;
        self.vault_logins.feedback = None;
        self.annotations.queue_open = false;
        cx.notify();

        let url = self.current_url();

        let task = crate::live::RT
            .spawn(async move { VaultClient::new().list_logins(&url, allow_unlock).await });
        cx.spawn(async move |this, cx| {
            let outcome = task.await;
            let _ = this.update(cx, |panel, cx| {
                panel.vault_logins.loading = false;
                match outcome {
                    Ok(resp) => {
                        panel.vault_logins.status = Some(resp.status);
                        panel.vault_logins.items = resp.items;
                        panel.vault_logins.error = resp.error;
                    }
                    Err(err) => {
                        panel.vault_logins.status = Some(VaultLoginsStatus::Error);
                        panel.vault_logins.error = Some(err.to_string());
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn fill_vault_login(
        &mut self,
        item_id: String,
        field: VaultLoginField,
        cx: &mut Context<'_, Self>,
    ) {
        let page_url = self.current_url();

        let Some(expected_origin) = https_origin(&page_url) else {
            self.vault_logins.feedback = Some("Autofill requires an HTTPS page.".to_owned());
            cx.notify();
            return;
        };
        let expected_origin_after = expected_origin.clone();
        let task = crate::live::RT.spawn(async move {
            VaultClient::new()
                .login_credential(&page_url, &expected_origin, &item_id, field)
                .await
        });
        cx.spawn(async move |this, cx| {
            let outcome = task.await;
            let _ = this.update(cx, |panel, cx| {
                match outcome {
                    Ok(VaultLoginFillLookup::Value(secret)) => {
                        let live_url = panel.current_url();
                        if https_origin(&live_url).as_deref()
                            != Some(expected_origin_after.as_str())
                        {
                            panel.vault_logins.feedback =
                                Some("Page origin changed before fill.".to_owned());
                        } else {
                            panel.ensure_bridge_injected();
                            if let Some(view) = panel.view.borrow().as_ref() {
                                let field_json = serde_json::to_string(field.as_str())
                                    .unwrap_or_else(|_| "\"\"".to_owned());
                                let origin_json = serde_json::to_string(&expected_origin_after)
                                    .unwrap_or_else(|_| "\"\"".to_owned());
                                let val_json = serde_json::to_string(&secret)
                                    .unwrap_or_else(|_| "\"\"".to_owned());
                                view.execute_javascript(&format!(
                                    "window.__CONN_GPUI_OVERLAY_BRIDGE__?.fillCredential({field_json}, {origin_json}, {val_json});"
                                ));
                                panel.vault_logins.feedback =
                                    Some(format!("Filled {}.", field.as_str()));
                                panel.vault_logins.open = false;
                            }
                        }
                    }
                    Ok(VaultLoginFillLookup::OriginMismatch) => {
                        panel.vault_logins.feedback = Some("Page origin mismatch.".to_owned());
                    }
                    Ok(VaultLoginFillLookup::Denied) => {
                        panel.vault_logins.feedback = Some("Vault unlock cancelled.".to_owned());
                    }
                    Ok(VaultLoginFillLookup::NoValue) => {
                        panel.vault_logins.feedback =
                            Some(format!("Login has no {}.", field.as_str()));
                    }
                    Ok(VaultLoginFillLookup::ItemNotFound) => {
                        panel.vault_logins.feedback = Some("Login item not found.".to_owned());
                    }
                    Ok(_) | Err(_) => {
                        panel.vault_logins.feedback = Some("Could not fill from Vault.".to_owned());
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn notify_overlay_annotations_changed(&self) {
        #[cfg(test)]
        self.annotation_scripts
            .set(self.annotation_scripts.get() + 1);
        if let Some(view) = self.view.borrow().as_ref() {
            view.execute_javascript("window.__connAnnotationsChanged?.();");
        }
    }

    fn maybe_show_existing_pins(&self) {
        let Some(origin) = self.current_origin() else {
            return;
        };
        let has_pins = self
            .annotations
            .annotations
            .iter()
            .any(|record| annotation_belongs_to_origin(record, &origin));
        if has_pins {
            self.ensure_overlay_injected(false);
        }
    }

    fn reply_overlay_rpc(&self, request_id: &str, result: Result<serde_json::Value, String>) {
        let guard = self.view.borrow();
        let Some(view) = guard.as_ref() else {
            return;
        };
        let id_json = serde_json::to_string(request_id).unwrap_or_else(|_| "\"\"".to_owned());
        let script = match result {
            Ok(value) => {
                let val_json = serde_json::to_string(&value).unwrap_or_else(|_| "null".to_owned());
                format!("window.__CONN_OVERLAY_REPLY__?.({id_json}, true, {val_json});")
            }
            Err(err) => {
                let err_json =
                    serde_json::to_string(&err).unwrap_or_else(|_| "\"Error\"".to_owned());
                format!("window.__CONN_OVERLAY_REPLY__?.({id_json}, false, {err_json});")
            }
        };
        view.execute_javascript(&script);
    }

    fn handle_overlay_rpc(
        &mut self,
        request_id: String,
        op: String,
        payload: serde_json::Value,
        cx: &mut Context<'_, Self>,
    ) {
        match op.as_str() {
            "list" => {
                let origin = self.current_origin();
                let visible: Vec<&AnnotationRecord> = match origin.as_deref() {
                    Some(origin) => self
                        .annotations
                        .annotations
                        .iter()
                        .filter(|r| annotation_belongs_to_origin(r, origin))
                        .collect(),
                    None => Vec::new(),
                };
                let value = serde_json::to_value(visible).unwrap_or_else(|_| serde_json::json!([]));
                self.reply_overlay_rpc(&request_id, Ok(value));
            }
            "capture" => {
                let rect = (
                    payload.get("x").and_then(serde_json::Value::as_f64),
                    payload.get("y").and_then(serde_json::Value::as_f64),
                    payload.get("width").and_then(serde_json::Value::as_f64),
                    payload.get("height").and_then(serde_json::Value::as_f64),
                );
                let result = match rect {
                    (Some(x), Some(y), Some(w), Some(h)) => {
                        let frame = self
                            .view
                            .borrow()
                            .as_ref()
                            .and_then(BrowserView::latest_frame);
                        let scale = self.last_scale.get().max(1.0);
                        frame
                            .and_then(|f| encode_bgra_crop_png_data_url(&f, scale, x, y, w, h, 0.0))
                            .map(serde_json::Value::String)
                            .ok_or_else(|| "Could not capture browser frame.".to_owned())
                    }
                    _ => Err("Invalid capture rectangle.".to_owned()),
                };
                self.reply_overlay_rpc(&request_id, result);
            }
            "submit" => {
                let (Some(conn), Some(project_id)) =
                    (self.connection.clone(), self.project_id.clone())
                else {
                    self.reply_overlay_rpc(
                        &request_id,
                        Err("Select a thread to save annotations.".to_owned()),
                    );
                    return;
                };
                let capture: conn_contract::AnnotationCapture =
                    match serde_json::from_value(payload) {
                        Ok(c) => c,
                        Err(err) => {
                            self.reply_overlay_rpc(
                                &request_id,
                                Err(format!("Invalid annotation payload: {err}")),
                            );
                            return;
                        }
                    };
                let input = conn_contract::AnnotationCreateInput {
                    project_id,
                    annotation: capture,
                };
                cx.spawn(async move |this, cx| {
                    let outcome = crate::live::RT
                        .spawn(async move {
                            conn.call::<conn_contract::AnnotationCreateInput, conn_contract::AnnotationCreateResult>(
                                "annotations.create",
                                &input,
                            )
                            .await
                            .map_err(|e| e.to_string())
                            .and_then(|res| {
                                serde_json::to_value(&res.annotation).map_err(|e| e.to_string())
                            })
                        })
                        .await
                        .unwrap_or_else(|e| Err(e.to_string()));
                    let _ = this.update(cx, |panel, _| {
                        panel.reply_overlay_rpc(&request_id, outcome);
                    });
                })
                .detach();
            }
            "remove" => {
                let (Some(conn), Some(project_id)) =
                    (self.connection.clone(), self.project_id.clone())
                else {
                    self.reply_overlay_rpc(
                        &request_id,
                        Err("Select a thread to remove annotations.".to_owned()),
                    );
                    return;
                };
                let ids: Vec<String> = payload
                    .get("ids")
                    .and_then(serde_json::Value::as_array)
                    .map(|arr| {
                        arr.iter()
                            .filter_map(serde_json::Value::as_str)
                            .map(ToOwned::to_owned)
                            .collect()
                    })
                    .unwrap_or_default();
                if ids.is_empty() {
                    self.reply_overlay_rpc(&request_id, Ok(serde_json::Value::Null));
                    return;
                }
                let input = conn_contract::AnnotationRemoveInput {
                    project_id,
                    ids: Some(ids),
                    scope: None,
                };
                cx.spawn(async move |this, cx| {
                    let outcome = crate::live::RT
                        .spawn(async move {
                            conn.call::<conn_contract::AnnotationRemoveInput, conn_contract::AnnotationRemoveResult>(
                                "annotations.remove",
                                &input,
                            )
                            .await
                            .map(|_| serde_json::Value::Null)
                            .map_err(|e| e.to_string())
                        })
                        .await
                        .unwrap_or_else(|e| Err(e.to_string()));
                    let _ = this.update(cx, |panel, _| {
                        panel.reply_overlay_rpc(&request_id, outcome);
                    });
                })
                .detach();
            }
            "dictation" => {
                let origin = self.current_origin();
                cx.spawn(async move |this, cx| {
                    let ok = crate::live::RT
                        .spawn(async move {
                            let Ok(mut client) =
                                conn_desktop::operator::OperatorClient::from_config()
                            else {
                                return false;
                            };
                            if let Some(origin) = origin {
                                client = client.with_origin(origin);
                            }
                            client.legacy_toggle().await.is_ok()
                        })
                        .await
                        .unwrap_or(false);
                    let _ = this.update(cx, |panel, _| {
                        panel.reply_overlay_rpc(&request_id, Ok(serde_json::Value::Bool(ok)));
                    });
                })
                .detach();
            }
            "dictationSession" => {
                let action = payload
                    .get("action")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("")
                    .to_owned();
                let session = payload
                    .get("session")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("")
                    .to_owned();
                let origin = self.current_origin();
                cx.spawn(async move |this, cx| {
                    let value = crate::live::RT
                        .spawn(async move {
                            use conn_desktop::operator::{
                                DictationStart, DictationWait, OperatorClient,
                            };
                            let Ok(mut client) = OperatorClient::from_config() else {
                                return serde_json::json!(false);
                            };
                            if let Some(origin) = origin {
                                client = client.with_origin(origin);
                            }
                            match action.as_str() {
                                "start" => match client.start(&session).await {
                                    Ok(DictationStart::Started) => serde_json::json!(true),
                                    Ok(DictationStart::Unsupported) => {
                                        serde_json::json!({ "unsupported": true })
                                    }
                                    Err(_) => serde_json::json!(false),
                                },
                                "stop" => match client.stop(&session).await {
                                    Ok(text) => serde_json::json!({ "text": text }),
                                    Err(_) => serde_json::json!(false),
                                },
                                "wait" => match client.wait(&session).await {
                                    Ok(DictationWait::Transcript(text)) => {
                                        serde_json::json!({ "text": text })
                                    }
                                    Ok(DictationWait::StillWaiting) => {
                                        serde_json::json!({ "waiting": true })
                                    }
                                    Ok(DictationWait::Unsupported) => {
                                        serde_json::json!({ "unsupported": true })
                                    }
                                    Err(_) => serde_json::json!(false),
                                },
                                "cancel" => {
                                    serde_json::json!(client.cancel(&session).await.is_ok())
                                }
                                _ => serde_json::json!(false),
                            }
                        })
                        .await
                        .unwrap_or_else(|_| serde_json::json!(false));
                    let _ = this.update(cx, |panel, _| {
                        panel.reply_overlay_rpc(&request_id, Ok(value));
                    });
                })
                .detach();
            }
            _ => {
                self.reply_overlay_rpc(&request_id, Err(format!("Unknown overlay op: {op}")));
            }
        }
    }

    /// Shows or hides the browser panel. When hidden, CEF stops painting; when
    /// shown again, painting resumes without reloading.
    pub(crate) fn set_visible(&mut self, visible: bool, cx: &mut Context<'_, Self>) {
        if self.visible.get() != visible {
            self.visible.set(visible);
            apply_hidden(&self.view, &self.applied_hidden, !visible);
            if visible {
                self.prewarm_runtime(cx);
                if self.host_script_pending {
                    self.inject_host_script();
                }
                if self.load_injection_pending {
                    self.inject_after_load();
                }
            } else {
                self.context_menu = None;
            }
            cx.notify();
        }
    }

    pub(crate) fn set_tokens(&mut self, tokens: Tokens, cx: &mut Context<'_, Self>) {
        self.laravel_toolbar
            .update(cx, |bar, cx| bar.set_tokens(tokens.clone(), cx));
        self.tokens = tokens;
        cx.notify();
    }

    /// Navigates the embedded browser to `url`, lazily installing and starting
    /// the CEF runtime on first use.
    pub(crate) fn navigate(&mut self, url: impl Into<String>, cx: &mut Context<'_, Self>) {
        let target = normalize_url(&url.into());
        trace_browser(&format!(
            "navigate to {target} (runtime {:?}, view {})",
            WebRuntime::global().state(),
            if self.view.borrow().is_some() {
                "ready"
            } else {
                "not yet"
            }
        ));
        self.url = target;
        self.user_load = true;
        self.context_menu = None;
        self.ensure_runtime_and_load(cx);
        self.report_title(cx);
    }

    /// Diagnostic state for the automation hook.
    #[cfg(feature = "automation")]
    pub(crate) fn automation_state(&self) -> serde_json::Value {
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
            "annotating": self.annotations.annotating,
            "overlayInjected": self.overlay_injected_load_count.get().is_some(),
        })
    }

    /// Returns the active document title reported by CEF, or an empty string
    /// when no page is loaded.
    #[cfg_attr(
        not(feature = "automation"),
        expect(dead_code, reason = "read by the automation hook")
    )]
    #[must_use]
    pub(crate) fn title(&self) -> String {
        self.view
            .borrow()
            .as_ref()
            .map_or_else(String::new, BrowserView::title)
    }

    fn go_back(&mut self, cx: &mut Context<'_, Self>) {
        self.user_load = true;
        if let Some(view) = self.view.borrow().as_ref() {
            view.go_back();
            cx.notify();
        }
    }

    fn go_forward(&mut self, cx: &mut Context<'_, Self>) {
        self.user_load = true;
        if let Some(view) = self.view.borrow().as_ref() {
            view.go_forward();
            cx.notify();
        }
    }

    fn reload(&mut self, cx: &mut Context<'_, Self>) {
        self.user_load = true;
        if let Some(view) = self.view.borrow().as_ref() {
            view.reload();
            cx.notify();
        } else {
            self.ensure_runtime_and_load(cx);
        }
    }

    /// Whether a page the user asked for is loading, from CEF's loading state. The first
    /// `about:blank` and the page of a warm start are not: the warm-up shows in the page area and
    /// never on the reload button.
    fn is_loading(&self) -> bool {
        self.user_load
            && self
                .view
                .borrow()
                .as_ref()
                .is_some_and(|view| view.is_loading() && !is_blank_page(&view.url()))
    }

    fn can_go_back(&self) -> bool {
        self.view
            .borrow()
            .as_ref()
            .is_some_and(BrowserView::can_go_back)
    }

    fn can_go_forward(&self) -> bool {
        self.view
            .borrow()
            .as_ref()
            .is_some_and(BrowserView::can_go_forward)
    }

    /// Loads `self.url`. Before the view exists this only keeps the address: the view is made on
    /// it as soon as Chromium runs, so typing never waits for the runtime.
    fn ensure_runtime_and_load(&mut self, cx: &mut Context<'_, Self>) {
        if let Some(view) = self.view.borrow().as_ref() {
            view.load_url(&self.url);
            if self.visible.get() {
                apply_hidden(&self.view, &self.applied_hidden, false);
            }
            cx.notify();
            return;
        }
        if runtime_warmup::disabled() {
            self.phase = RuntimePhase::Failed("Chromium is turned off in this run".into());
            cx.notify();
            return;
        }

        if WebRuntime::global().state() == WebRuntimeState::Running {
            self.phase = RuntimePhase::Running;
            self.maybe_create_view_deferred(cx);
        } else {
            // The launch warm-up is normally under way; this joins it, or retries after a failure.
            runtime_warmup::begin(cx);
            self.phase = runtime_phase(&WebRuntime::global().state());
            self.poll_runtime_ready(cx);
        }
        cx.notify();
    }

    /// Joins the runtime warm-up when the Browser tab shows, so the view exists by the first
    /// address typed. Tests never show this panel, and `CONN_GPUI_NO_CEF=1` keeps CEF off.
    fn prewarm_runtime(&mut self, cx: &mut Context<'_, Self>) {
        if runtime_warmup::disabled() || self.view.borrow().is_some() {
            return;
        }
        self.ensure_runtime_and_load(cx);
    }

    /// Follows the warm-up (download, helpers, start) until Chromium runs or fails, showing its
    /// progress in the page area. The toolbar is never gated by this.
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
                    (WebRuntimeState::Running, _) => Some(RuntimePhase::Running),
                    (_, Some(why)) => Some(RuntimePhase::Failed(why)),
                    (WebRuntimeState::Failed(why), None) if !runtime_warmup::active() => {
                        Some(RuntimePhase::Failed(why.clone()))
                    }
                    (WebRuntimeState::Starting, None)
                        if starting_since
                            .get_or_insert_with(std::time::Instant::now)
                            .elapsed()
                            > Duration::from_secs(60) =>
                    {
                        Some(RuntimePhase::Failed(
                            "timed out waiting for Chromium to start".into(),
                        ))
                    }
                    _ => None,
                };
                let alive = this.update(cx, |panel, cx| {
                    let phase = finished.clone().unwrap_or_else(|| runtime_phase(&state));
                    let ready = matches!(phase, RuntimePhase::Running);
                    if panel.phase != phase {
                        panel.phase = phase;
                        cx.notify();
                    }
                    if finished.is_some() {
                        panel.polling_runtime = false;
                        if ready {
                            panel.maybe_create_view_deferred(cx);
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
        let url = self.url.clone();
        let view_slot = self.view.clone();
        let creating_flag = self.creating_view.clone();
        let last_bounds = self.last_bounds.clone();
        let last_scale = self.last_scale.clone();
        let visible = self.visible.clone();
        let view_while_hidden = self.view_while_hidden.clone();
        let applied_hidden = self.applied_hidden.clone();
        let entity = cx.entity().downgrade();

        // Defer BrowserView creation until after GPUI finishes the current frame.
        cx.defer(move |cx| {
            creating_flag.set(false);
            // A tab closed or hidden since the frame gets no Chromium view: nothing would close it.
            // The automation hook's page is the exception; the cap closes it like any other.
            let wanted = visible.get() || view_while_hidden.get();
            if view_slot.borrow().is_some() || entity.upgrade().is_none() || !wanted {
                return;
            }
            let rect = last_bounds.get().unwrap_or(bounds);
            let scale = last_scale.get().max(1.0);
            let began = std::time::Instant::now();
            let result = BrowserView::create(rect, scale, &url);
            trace_browser(&format!("view created in {:?}", began.elapsed()));
            match result {
                Ok(browser_view) => {
                    // Bounded channel (capacity 1) coalesces frame bursts into a
                    // single GPUI repaint with no busy loop when the page is idle.
                    let (wake_tx, mut wake_rx) = tokio::sync::mpsc::channel::<()>(1);
                    let wake_cb = move || {
                        let _ = wake_tx.try_send(());
                    };
                    browser_view.on_frame(wake_cb);

                    // Console + load-end bridge for Conn's `@t3tools/annotation-overlay`.
                    let (overlay_tx, mut overlay_rx) =
                        tokio::sync::mpsc::unbounded_channel::<BrowserOverlayEvent>();
                    let console_tx = overlay_tx.clone();
                    browser_view.on_console_message(move |msg| {
                        let Some(json) = msg.strip_prefix(OVERLAY_RPC_PREFIX) else {
                            return false;
                        };
                        if let Ok(parsed) = serde_json::from_str::<OverlayBridgeMessage>(json) {
                            let ev = match parsed {
                                OverlayBridgeMessage::Rpc {
                                    request_id,
                                    op,
                                    payload,
                                } => BrowserOverlayEvent::Rpc {
                                    request_id,
                                    op,
                                    payload,
                                },
                                OverlayBridgeMessage::Mode { active } => {
                                    BrowserOverlayEvent::Mode(active)
                                }
                                OverlayBridgeMessage::LaravelToolbar { kind, data, url } => {
                                    BrowserOverlayEvent::LaravelToolbar { kind, data, url }
                                }
                                OverlayBridgeMessage::LaravelToolbarDetails { id, raw } => {
                                    BrowserOverlayEvent::LaravelToolbarDetails { id, raw }
                                }
                                OverlayBridgeMessage::PreviewResult {
                                    request_id,
                                    ok,
                                    value,
                                    error,
                                } => BrowserOverlayEvent::PreviewResult {
                                    request_id,
                                    ok,
                                    value,
                                    error,
                                },
                            };
                            let _ = console_tx.send(ev);
                        }
                        true
                    });
                    let menu_tx = overlay_tx.clone();
                    browser_view.on_context_menu(move |event| {
                        let _ = menu_tx.send(BrowserOverlayEvent::ContextMenu(event));
                    });
                    let tab_tx = overlay_tx.clone();
                    browser_view.on_open_tab(move |request| {
                        let _ = tab_tx.send(BrowserOverlayEvent::OpenTab(request));
                    });
                    let start_tx = overlay_tx.clone();
                    let response_tx = overlay_tx.clone();
                    browser_view.on_load_start(move |_url| {
                        let _ = start_tx.send(BrowserOverlayEvent::LoadStart);
                    });
                    browser_view.on_toolbar_response(move |response| {
                        let _ = response_tx.send(BrowserOverlayEvent::ToolbarResponse(response));
                    });
                    browser_view.on_load_end(move |_url, _status| {
                        let _ = overlay_tx.send(BrowserOverlayEvent::LoadEnd);
                    });

                    let hidden = !visible.get();
                    browser_view.set_hidden(hidden);
                    applied_hidden.set(Some(hidden));

                    *view_slot.borrow_mut() = Some(browser_view);
                    if let Some(panel) = entity.upgrade() {
                        panel.update(cx, |panel, cx| {
                            panel.phase = RuntimePhase::Running;
                            panel.wake_task = Some(cx.spawn(async move |this, cx| {
                                while wake_rx.recv().await.is_some() {
                                    let alive = this.update(cx, |panel, cx| {
                                        panel.report_title(cx);
                                        cx.notify();
                                    });
                                    if alive.is_err() {
                                        break;
                                    }
                                }
                            }));
                            panel.overlay_task = Some(cx.spawn(async move |this, cx| {
                                while let Some(ev) = overlay_rx.recv().await {
                                    let alive = this.update(cx, |panel, cx| match ev {
                                        BrowserOverlayEvent::Rpc {
                                            request_id,
                                            op,
                                            payload,
                                        } => {
                                            panel.handle_overlay_rpc(request_id, op, payload, cx);
                                        }
                                        BrowserOverlayEvent::Mode(active) => {
                                            if panel.annotations.annotating != active {
                                                panel.annotations.annotating = active;
                                                cx.notify();
                                            }
                                        }
                                        BrowserOverlayEvent::LaravelToolbar { kind, data, url } => {
                                            let map = data.as_object().cloned();
                                            panel.laravel_toolbar.update(cx, |bar, cx| {
                                                match (kind.as_str(), map) {
                                                    ("page", Some(map)) => {
                                                        bar.on_page_data(Some(map), &url, cx)
                                                    }
                                                    ("ready", _) => {
                                                        bar.on_page_data(None, &url, cx)
                                                    }
                                                    ("update", Some(map)) => {
                                                        bar.on_page_update(map, cx)
                                                    }
                                                    _ => {}
                                                }
                                            });
                                            cx.notify();
                                        }
                                        BrowserOverlayEvent::LaravelToolbarDetails { id, raw } => {
                                            if let Some(map) = raw.as_object().cloned() {
                                                panel.laravel_toolbar.update(cx, |bar, cx| {
                                                    bar.on_details(&id, map, cx)
                                                });
                                            }
                                        }
                                        BrowserOverlayEvent::ToolbarResponse(response) => {
                                            panel.laravel_toolbar.update(cx, |bar, cx| {
                                                bar.on_response(response, cx)
                                            });
                                        }
                                        BrowserOverlayEvent::LoadStart => {
                                            panel.on_load_start(cx);
                                        }
                                        BrowserOverlayEvent::PreviewResult {
                                            request_id,
                                            ok,
                                            value,
                                            error,
                                        } => {
                                            if let Some(tx) =
                                                panel.pending_preview.remove(&request_id)
                                            {
                                                let reply = if ok {
                                                    Ok(value)
                                                } else {
                                                    Err(error.unwrap_or_else(|| {
                                                        "Preview script failed.".to_owned()
                                                    }))
                                                };
                                                let _ = tx.send(reply);
                                            }
                                        }
                                        BrowserOverlayEvent::ContextMenu(
                                            ContextMenuEvent::Open(request),
                                        ) => {
                                            // A menu still open is replaced, which cancels it.
                                            panel.context_menu = Some(OpenMenu::new(request));
                                            cx.notify();
                                        }
                                        BrowserOverlayEvent::ContextMenu(
                                            ContextMenuEvent::Dismissed,
                                        ) => {
                                            if panel.context_menu.take().is_some() {
                                                cx.notify();
                                            }
                                        }
                                        BrowserOverlayEvent::OpenTab(request) => {
                                            cx.emit(BrowserTabEvent::OpenTab(request));
                                        }
                                        BrowserOverlayEvent::LoadEnd => {
                                            panel.on_load_end(cx);
                                        }
                                    });
                                    if alive.is_err() {
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
        if self.annotations.queue_open {
            self.annotations.queue_open = false;
            self.annotations.confirming_remove = false;
            cx.notify();
        }
        window.focus(&self.focus_handle, cx);
        self.user_load = true;
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

    /// Escape cancels the open menu; Up and Down move through it; Enter runs the highlighted row.
    fn handle_context_menu_key(&mut self, key: &str, cx: &mut Context<'_, Self>) {
        match key {
            "escape" => self.context_menu = None,
            "down" | "up" => {
                if let Some(menu) = self.context_menu.as_mut() {
                    menu.step(key == "down");
                }
            }
            "enter" => {
                if self
                    .context_menu
                    .as_ref()
                    .is_some_and(OpenMenu::choose_cursor)
                {
                    self.context_menu = None;
                }
            }
            _ => return,
        }
        cx.notify();
    }

    fn choose_context_row(
        &mut self,
        index: usize,
        _window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        if self
            .context_menu
            .as_ref()
            .is_some_and(|menu| menu.choose(index))
        {
            self.context_menu = None;
            cx.notify();
        }
    }

    fn hover_context_row(&mut self, index: usize, cx: &mut Context<'_, Self>) {
        if let Some(menu) = self.context_menu.as_mut() {
            menu.hover(index);
            cx.notify();
        }
    }

    fn dismiss_context_menu(&mut self, _window: &mut Window, cx: &mut Context<'_, Self>) {
        if self.context_menu.take().is_some() {
            cx.notify();
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
        if self.context_menu.is_some() {
            // The open menu takes the keyboard; nothing reaches the page.
            self.handle_context_menu_key(event.keystroke.key.as_str(), cx);
            cx.stop_propagation();
            return;
        }
        let guard = self.view.borrow();
        let Some(view) = guard.as_ref() else {
            return;
        };

        let ks = &event.keystroke;
        let mods = map_modifiers(ks.modifiers, None, event.is_held);

        // Toggle Developer Tools (`Alt+Command+I`, as in Conn desktop's View menu).
        if ks.modifiers.platform && ks.modifiers.alt && !ks.modifiers.control && ks.key == "i" {
            if view.has_dev_tools() {
                view.close_dev_tools();
            } else {
                view.show_dev_tools(None);
            }
            cx.stop_propagation();
            return;
        }

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
                "superhero/arrow-left.svg",
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
                "superhero/arrow-right.svg",
                NAV_ICON_SIZE_PX,
                forward_color,
            ));

        // Web's `RefreshIcon` spins while the page loads (`motion-safe:visible-animate-spin`,
        // one linear turn per second). GPUI's animation stays still under Reduce Motion.
        let loading = self.is_loading();
        let reload_icon = superhero_icon("superhero/refresh.svg", NAV_ICON_SIZE_PX, fg);
        let reload_icon = if loading {
            reload_icon
                .with_animation(
                    "browser-reload-spin",
                    Animation::new(Duration::from_secs(1)).repeat(),
                    |icon, delta| {
                        icon.with_transformation(Transformation::rotate(percentage(delta)))
                    },
                )
                .into_any_element()
        } else {
            reload_icon.into_any_element()
        };

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
            .child(reload_icon);

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

    fn render_vault_logins_popover(
        &self,
        cx: &mut Context<'_, Self>,
    ) -> Option<gpui_kit::AnyElement> {
        if !self.vault_logins.open {
            return None;
        }
        let fg = to_hsla(self.tokens.foreground);
        let muted = to_hsla(self.tokens.muted_foreground);
        let bg = to_hsla(self.tokens.popover);
        let border = to_hsla(self.tokens.shell_inner_border);
        let hover = to_hsla(self.tokens.shell_highlight);
        let btn_bg = to_hsla(self.tokens.shell_control_raised);
        let btn_border = to_hsla(self.tokens.shell_control_raised_border);

        let mut list = v_flex()
            .id("browser-vault-popover")
            .a11y_group("browser.vault.popover", "Vault logins")
            .w(px(280.0))
            .max_h(px(320.0))
            .p(px(8.0))
            .gap(px(6.0))
            .rounded(px(12.0))
            .bg(bg)
            .border_1()
            .border_color(border)
            .shadow_lg()
            .child(
                h_flex()
                    .items_center()
                    .justify_between()
                    .px(px(4.0))
                    .child(
                        h_flex()
                            .items_center()
                            .gap(px(6.0))
                            .child(superhero_icon("superhero/key.svg", 13.0, fg))
                            .child(
                                div()
                                    .text_size(px(12.0))
                                    .font_weight(FontWeight::MEDIUM)
                                    .text_color(fg)
                                    .child("Vault logins"),
                            ),
                    )
                    .child(
                        div()
                            .id("browser-vault-close")
                            .a11y_button("browser.vault.close", "Close Vault logins")
                            .px(px(5.0))
                            .py(px(2.0))
                            .rounded(px(5.0))
                            .cursor_pointer()
                            .hover(move |s| s.bg(hover))
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.vault_logins.open = false;
                                cx.notify();
                            }))
                            .child(superhero_icon("superhero/close.svg", 11.0, muted)),
                    ),
            );

        if let Some(feedback) = &self.vault_logins.feedback {
            list = list.child(
                div()
                    .px(px(6.0))
                    .text_size(px(11.0))
                    .text_color(muted)
                    .child(feedback.clone()),
            );
        }

        if self.vault_logins.loading {
            list = list.child(
                div()
                    .px(px(6.0))
                    .py(px(8.0))
                    .text_size(px(12.0))
                    .text_color(muted)
                    .child("Checking Vault…"),
            );
        } else if self.vault_logins.status == Some(VaultLoginsStatus::Locked) {
            list = list.child(
                v_flex()
                    .gap(px(6.0))
                    .px(px(4.0))
                    .py(px(4.0))
                    .child(
                        div()
                            .text_size(px(12.0))
                            .text_color(muted)
                            .child("Vault is locked."),
                    )
                    .child(
                        div()
                            .id("browser-vault-unlock")
                            .a11y_button("browser.vault.unlock", "Unlock Vault")
                            .px(px(10.0))
                            .py(px(5.0))
                            .rounded(px(6.0))
                            .bg(btn_bg)
                            .border_1()
                            .border_color(btn_border)
                            .text_size(px(12.0))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(fg)
                            .cursor_pointer()
                            .hover(move |s| s.bg(hover))
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.toggle_vault_logins_popover(true, cx);
                            }))
                            .child("Unlock Vault…"),
                    ),
            );
        } else if let Some(err) = &self.vault_logins.error {
            list = list.child(
                div()
                    .px(px(6.0))
                    .py(px(4.0))
                    .text_size(px(12.0))
                    .text_color(muted)
                    .child(err.clone()),
            );
        } else if self.vault_logins.items.is_empty() {
            list = list.child(
                div()
                    .px(px(6.0))
                    .py(px(6.0))
                    .text_size(px(12.0))
                    .text_color(muted)
                    .child("No saved Vault logins for this HTTPS origin."),
            );
        } else {
            for item in &self.vault_logins.items {
                let id_u = item.id.clone();
                let id_p = item.id.clone();
                let id_o = item.id.clone();
                let pill =
                    |id: String, label: &'static str, field: VaultLoginField, item_id: String| {
                        div()
                            .id(gpui_kit::SharedString::from(id))
                            .a11y_button(
                                gpui_kit::SharedString::from(format!(
                                    "browser.vault.fill.{}.{}",
                                    item_id,
                                    field.as_str()
                                )),
                                format!("Fill {label}"),
                            )
                            .px(px(6.0))
                            .py(px(2.0))
                            .rounded(px(5.0))
                            .bg(btn_bg)
                            .border_1()
                            .border_color(btn_border)
                            .text_size(px(11.0))
                            .text_color(fg)
                            .cursor_pointer()
                            .hover(move |s| s.bg(hover))
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.fill_vault_login(item_id.clone(), field, cx);
                            }))
                            .child(label)
                    };
                list = list.child(
                    v_flex()
                        .gap(px(4.0))
                        .px(px(6.0))
                        .py(px(6.0))
                        .rounded(px(8.0))
                        .bg(to_hsla(self.tokens.shell_settings_card))
                        .border_1()
                        .border_color(to_hsla(self.tokens.shell_settings_card_border))
                        .child(
                            div()
                                .text_size(px(12.0))
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(fg)
                                .truncate()
                                .child(item.title.clone()),
                        )
                        .children(item.username.as_ref().map(|u| {
                            div()
                                .text_size(px(11.0))
                                .text_color(muted)
                                .truncate()
                                .child(u.clone())
                        }))
                        .child(
                            h_flex()
                                .gap(px(4.0))
                                .pt(px(2.0))
                                .child(pill(
                                    format!("vault-fill-user-{}", item.id),
                                    "User",
                                    VaultLoginField::Username,
                                    id_u,
                                ))
                                .child(pill(
                                    format!("vault-fill-pass-{}", item.id),
                                    "Password",
                                    VaultLoginField::Password,
                                    id_p,
                                ))
                                .child(pill(
                                    format!("vault-fill-otp-{}", item.id),
                                    "OTP",
                                    VaultLoginField::Otp,
                                    id_o,
                                )),
                        ),
                );
            }
        }

        Some(
            div()
                .absolute()
                .top(px(42.0))
                .right(px(72.0))
                .child(list)
                .into_any_element(),
        )
    }

    /// The overflow menu (`PreviewMoreMenu`), below the right edge of the toolbar. It lists only
    /// what the embedded browser can do today; see the report for the items still missing.
    fn render_more_menu(&self, cx: &mut Context<'_, Self>) -> gpui_kit::AnyElement {
        let tokens = &self.tokens;
        let hover = to_hsla(tokens.shell_highlight);
        let text_color = to_hsla(tokens.popover_foreground);
        let muted = to_hsla(tokens.muted_foreground);
        let page = self.shown_url.clone();
        let can_open_external = page.starts_with("http://") || page.starts_with("https://");

        // Web's `PreviewMoreMenu` has one DevTools item, "Open DevTools": it opens Chrome's
        // DevTools in a separate window, or focuses it when it is already open.
        let has_view = self.view.borrow().is_some();
        let dev_tools = div()
            .id("browser-more-devtools")
            .a11y_button("browser.more.devtools", "Open DevTools")
            .flex()
            .flex_row()
            .items_center()
            .gap(px(8.0))
            .min_h(px(28.0))
            .px(px(8.0))
            .py(px(4.0))
            .rounded(px(8.0))
            .text_size(px(UI_TEXT_PX))
            .line_height(px(UI_LINE_HEIGHT_PX))
            .text_color(text_color)
            .when(has_view, |el| {
                el.cursor_pointer()
                    .hover(move |s| s.bg(hover))
                    .on_click(cx.listener(|this, _, _, cx| {
                        if let Some(view) = this.view.borrow().as_ref() {
                            view.show_dev_tools(None);
                        }
                        this.more_menu_open = false;
                        cx.notify();
                    }))
            })
            .when(!has_view, |el| el.opacity(0.5))
            .child(superhero_icon("superhero/code.svg", 14.0, muted))
            .child("Open DevTools");

        let open_external = div()
            .id("browser-more-open-external")
            .a11y_button("browser.more.open-external", "Open in system browser")
            .flex()
            .flex_row()
            .items_center()
            .gap(px(8.0))
            .min_h(px(28.0))
            .px(px(8.0))
            .py(px(4.0))
            .rounded(px(8.0))
            .text_size(px(UI_TEXT_PX))
            .line_height(px(UI_LINE_HEIGHT_PX))
            .text_color(text_color)
            .when(can_open_external, |el| {
                el.cursor_pointer()
                    .hover(move |s| s.bg(hover))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        cx.open_url(&page);
                        this.more_menu_open = false;
                        cx.notify();
                    }))
            })
            .when(!can_open_external, |el| el.opacity(0.5))
            .child(superhero_icon("superhero/external-link.svg", 14.0, muted))
            .child("Open in system browser");

        let menu = v_flex()
            .id("browser-more-menu-popup")
            .a11y(gpui_kit::Role::Menu, "browser.more.menu", "Browser menu")
            .min_w(px(200.0))
            .p(px(4.0))
            .rounded(px(12.0))
            .bg(to_hsla(tokens.popover))
            .border_1()
            .border_color(to_hsla(tokens.foreground.with_alpha(0.08)))
            .shadow(vec![super::header::dropdown_glass_shadow(tokens)])
            .on_mouse_down(gpui_kit::MouseButton::Left, |_, _, cx| {
                cx.stop_propagation();
            })
            .on_mouse_down_out(cx.listener(|this, _, _, cx| {
                this.more_menu_open = false;
                cx.notify();
            }))
            .child(dev_tools)
            .child(open_external);

        gpui_kit::deferred(
            div()
                .absolute()
                .top(px(TOOLBAR_HEIGHT_PX + 6.0))
                .right(px(0.0))
                .child(menu),
        )
        .with_priority(3)
        .into_any_element()
    }

    fn render_annotations_toolbar_group(&self, cx: &mut Context<'_, Self>) -> gpui_kit::Div {
        let fg = to_hsla(self.tokens.foreground);
        let muted = to_hsla(self.tokens.muted_foreground);
        let hover_bg = to_hsla(self.tokens.shell_highlight);
        let control_bg = to_hsla(self.tokens.shell_control);
        let border = to_hsla(self.tokens.shell_divider_header);
        let primary = to_hsla(self.tokens.primary);
        let primary_fg = to_hsla(self.tokens.primary_foreground);

        let counts = self.annotations.counts();
        let annotating = self.annotations.annotating;
        let project_ready = self.annotations.project_ready;
        let entity = cx.entity();

        let annotate_btn = div()
            .id("browser-annotate-toggle")
            .a11y_button(
                "browser.annotations.toggle",
                if annotating {
                    "Stop annotating page"
                } else {
                    "Annotate page"
                },
            )
            .size(px(TOOLBAR_BUTTON_SIZE_PX))
            .rounded(px(9999.0))
            .flex()
            .items_center()
            .justify_center()
            .when(annotating, |el| {
                el.bg(chrome::alpha(self.tokens.primary, 0.22))
            })
            .when(project_ready, |el| {
                el.cursor_pointer()
                    .hover(move |s| s.bg(hover_bg))
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.toggle_annotating_mode(window, cx);
                    }))
            })
            .when(!project_ready, |el| el.opacity(0.45))
            .conn_tooltip(
                if annotating {
                    "Stop annotating page"
                } else {
                    "Annotate page"
                },
                &self.tokens,
            )
            .child(superhero_icon(
                "superhero/comment-text.svg",
                NAV_ICON_SIZE_PX,
                if annotating { primary } else { fg },
            ));

        let queue_btn = div()
            .id("browser-annotations-queue")
            .a11y_button(
                "browser.annotations.queue",
                format!("Annotations queue ({} waiting)", counts.waiting),
            )
            .h(px(TOOLBAR_BUTTON_SIZE_PX))
            .px(px(6.0))
            .rounded(px(9999.0))
            .flex()
            .flex_row()
            .items_center()
            .gap(px(4.0))
            .cursor_pointer()
            .when(self.annotations.queue_open, |el| el.bg(hover_bg))
            .hover(move |s| s.bg(hover_bg))
            .conn_tooltip(
                if counts.waiting > 0 {
                    format!("Annotations queue ({} waiting)", counts.waiting)
                } else {
                    "Annotations queue".to_owned()
                },
                &self.tokens,
            )
            .on_click(cx.listener(|this, _, _, cx| {
                this.annotations.toggle_queue();
                cx.notify();
            }))
            .child(superhero_icon(
                "superhero/checklist.svg",
                13.0,
                if self.annotations.watching {
                    to_hsla(self.tokens.success_foreground)
                } else if counts.waiting > 0 {
                    fg
                } else {
                    muted
                },
            ))
            .when(counts.waiting > 0, |el| {
                el.child(
                    div()
                        .min_w(px(16.0))
                        .h(px(16.0))
                        .px(px(4.0))
                        .rounded(px(9999.0))
                        .bg(primary)
                        .text_color(primary_fg)
                        .flex()
                        .items_center()
                        .justify_center()
                        .text_size(px(10.0))
                        .font_weight(FontWeight::SEMIBOLD)
                        .child(counts.waiting.to_string()),
                )
            });

        let more_open = self.more_menu_open;
        let more_btn = div()
            .id("browser-more-menu")
            .a11y_button("browser.more", "Browser menu")
            .size(px(TOOLBAR_BUTTON_SIZE_PX))
            .rounded(px(9999.0))
            .flex()
            .items_center()
            .justify_center()
            .cursor_pointer()
            .when(more_open, |el| el.bg(hover_bg))
            .hover(move |s| s.bg(hover_bg))
            .conn_tooltip("More", &self.tokens)
            .on_click(cx.listener(|this, _, _, cx| {
                this.more_menu_open = !this.more_menu_open;
                cx.notify();
            }))
            .child(superhero_icon(
                "superhero/more-vertical.svg",
                NAV_ICON_SIZE_PX,
                if more_open { fg } else { muted },
            ));

        let mut anchor = div().relative().flex_shrink_0().child(
            h_flex()
                .h(px(TOOLBAR_HEIGHT_PX))
                .px(px(TOOLBAR_INNER_PADDING_PX))
                .gap(px(2.0))
                .items_center()
                .rounded(px(9999.0))
                .bg(control_bg)
                .border_1()
                .border_color(if annotating { primary } else { border })
                .child(annotate_btn)
                .child(queue_btn)
                .child(more_btn),
        );

        if more_open {
            anchor = anchor.child(self.render_more_menu(cx));
        }

        if self.annotations.queue_open {
            let callbacks = QueuePopoverCallbacks {
                on_toggle_annotating: {
                    let entity = entity.clone();
                    Rc::new(move |window, cx| {
                        entity.update(cx, |this, cx| {
                            this.toggle_annotating_mode(window, cx);
                        });
                    })
                },
                on_send_waiting: {
                    let entity = entity.clone();
                    Rc::new(move |_, cx| {
                        entity.update(cx, |this, cx| {
                            this.annotations.queue_open = false;
                            cx.emit(AnnotationAction::SendWaiting);
                            cx.notify();
                        });
                    })
                },
                on_toggle_watch: {
                    let entity = entity.clone();
                    Rc::new(move |_, cx| {
                        entity.update(cx, |_, cx| {
                            cx.emit(AnnotationAction::ToggleWatch);
                        });
                    })
                },
                on_remove_ids: {
                    let entity = entity.clone();
                    Rc::new(move |ids, _, cx| {
                        entity.update(cx, |this, cx| {
                            this.annotations.confirming_remove = false;
                            cx.emit(AnnotationAction::Remove { ids });
                            cx.notify();
                        });
                    })
                },
                on_set_confirming_remove: {
                    let entity = entity.clone();
                    Rc::new(move |confirming, _, cx| {
                        entity.update(cx, |this, cx| {
                            this.annotations.confirming_remove = confirming;
                            cx.notify();
                        });
                    })
                },
                on_close: Rc::new(move |_, cx| {
                    entity.update(cx, |this, cx| {
                        this.annotations.queue_open = false;
                        this.annotations.confirming_remove = false;
                        cx.notify();
                    });
                }),
            };
            anchor = anchor.child(render_queue_popover(
                &self.annotations,
                &self.tokens,
                QueuePopoverAnchor::BelowRight,
                callbacks,
            ));
        }

        anchor
    }
}

impl Render for BrowserPanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) -> impl IntoElement {
        // Keep the address field on the page's URL (navigation, redirects, links).
        let current_url = self
            .view
            .borrow()
            .as_ref()
            .map(BrowserView::url)
            .filter(|u| !u.is_empty())
            .unwrap_or_else(|| self.url.clone());
        if current_url != self.shown_url {
            self.shown_url = current_url.clone();
            self.url_input.update(cx, |input, cx| {
                input.set_value(address_text(&current_url), window, cx);
            });
            self.report_title(cx);
        }

        let field_bg = to_hsla(self.tokens.shell_field);
        let field_border = to_hsla(self.tokens.shell_divider_header);
        let divider = to_hsla(self.tokens.shell_divider);
        let muted = to_hsla(self.tokens.muted_foreground);
        let fg = to_hsla(self.tokens.foreground);
        let tile_bg = to_hsla(self.tokens.shell_tile);
        let tile_border = to_hsla(self.tokens.shell_tile_border);

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

            // A page that failed to load: say why, in the page area, with a way to try again.
            let load_error = self
                .view
                .borrow()
                .as_ref()
                .and_then(BrowserView::load_error);
            if let Some(error) = load_error {
                let retry_url = error.url.clone();
                container = container.child(
                    v_flex()
                        .id("browser-load-error")
                        .a11y_group("browser.load-error", "Page failed to load")
                        .absolute()
                        .inset_0()
                        .items_center()
                        .justify_center()
                        .gap(px(10.0))
                        .bg(to_hsla(self.tokens.background))
                        .child(
                            div()
                                .text_size(px(UI_TEXT_PX))
                                .line_height(px(UI_LINE_HEIGHT_PX))
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(fg)
                                .child(error.message()),
                        )
                        .child(
                            div()
                                .text_size(px(UI_TEXT_PX))
                                .line_height(px(UI_LINE_HEIGHT_PX))
                                .text_color(muted)
                                .child(error.name()),
                        )
                        .child(
                            div()
                                .id("browser-load-error-retry")
                                .a11y_button("browser.load-error.retry", "Retry")
                                .h(px(28.0))
                                .px(px(12.0))
                                .flex()
                                .items_center()
                                .rounded(px(9999.0))
                                .bg(tile_bg)
                                .border_1()
                                .border_color(tile_border)
                                .text_size(px(UI_TEXT_PX))
                                .text_color(fg)
                                .cursor_pointer()
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.user_load = true;
                                    if let Some(view) = this.view.borrow().as_ref() {
                                        view.load_url(&retry_url);
                                    }
                                    cx.notify();
                                }))
                                .child("Retry"),
                        ),
                );
            }

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

        let is_https = https_origin(&self.url).is_some();
        let vault_hover = to_hsla(self.tokens.shell_highlight);
        let vault_btn = is_https.then(|| {
            div()
                .id("browser-vault-logins-btn")
                .a11y_button("browser.vault.open", "Vault logins")
                .size(px(22.0))
                .rounded(px(9999.0))
                .flex()
                .items_center()
                .justify_center()
                .cursor_pointer()
                .when(self.vault_logins.open, |el| el.bg(vault_hover))
                .hover(move |s| s.bg(vault_hover))
                .conn_tooltip("Fill login from Vault", &self.tokens)
                .on_click(cx.listener(|this, _, _, cx| {
                    this.toggle_vault_logins_popover(false, cx);
                }))
                .child(superhero_icon(
                    "superhero/key.svg",
                    13.0,
                    if self.vault_logins.open { fg } else { muted },
                ))
        });

        let vault_popover = self.render_vault_logins_popover(cx);
        let laravel_bar = self
            .laravel_toolbar
            .read(cx)
            .is_visible()
            .then(|| self.laravel_toolbar.clone());
        let context_menu = self.context_menu.as_ref().and_then(|menu| {
            let bounds = self.last_bounds.get()?;
            let (x, y) = menu.position();
            let origin = gpui_kit::point(px(bounds.x + x as f32), px(bounds.y + y as f32));
            let actions = MenuActions {
                choose: Self::choose_context_row,
                hover: Self::hover_context_row,
                dismiss: Self::dismiss_context_menu,
            };
            Some(render_context_menu(
                menu,
                origin,
                &self.tokens,
                &actions,
                cx,
            ))
        });

        v_flex()
            .relative()
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
                            .pr(px(6.0))
                            .gap(px(6.0))
                            .items_center()
                            .child(superhero_icon("superhero/globe.svg", 14.0, muted))
                            .child(
                                div().flex_1().min_w_0().child(
                                    Input::new(&self.url_input)
                                        .appearance(false)
                                        .px_0()
                                        .text_size(px(UI_TEXT_PX)),
                                ),
                            )
                            .children(vault_btn),
                    )
                    .child(self.render_annotations_toolbar_group(cx)),
            )
            .child(div().w_full().h(px(1.0)).bg(divider))
            .child(body)
            .children(laravel_bar)
            .children(vault_popover)
            .children(context_menu)
    }
}

/// Logs the browser panel's start-up steps: to stderr with `CONN_WEB_TRACE=1`, and in debug
/// builds to `/tmp/conn-web-trace.log`.
fn trace_browser(what: &str) {
    conn_web::trace("conn-browser", what);
}

fn default_browser_url() -> String {
    std::env::var(DEFAULT_URL_ENV)
        .ok()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_FALLBACK_URL.to_owned())
}

/// A page that shows nothing: the first load and an empty tab.
fn is_blank_page(url: &str) -> bool {
    url.is_empty() || url == DEFAULT_FALLBACK_URL
}

/// What the address field shows for `url`: a blank page shows the placeholder, not `about:blank`.
fn address_text(url: &str) -> String {
    if url == DEFAULT_FALLBACK_URL {
        String::new()
    } else {
        url.to_owned()
    }
}

fn normalize_url(raw: &str) -> String {
    super::address::resolve_address(raw)
}

/// The page-area status for the runtime's state.
fn runtime_phase(state: &WebRuntimeState) -> RuntimePhase {
    match state {
        WebRuntimeState::Running => RuntimePhase::Running,
        WebRuntimeState::Downloading { progress_percent } => {
            RuntimePhase::Downloading(*progress_percent)
        }
        WebRuntimeState::Failed(why) => RuntimePhase::Failed(why.clone()),
        WebRuntimeState::Starting | WebRuntimeState::NotInstalled => RuntimePhase::Starting,
    }
}

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

fn map_mouse_button(button: MouseButton) -> Option<WebMouseButton> {
    match button {
        MouseButton::Left => Some(WebMouseButton::Left),
        MouseButton::Middle => Some(WebMouseButton::Middle),
        MouseButton::Right => Some(WebMouseButton::Right),
        MouseButton::Navigate(_) => None,
    }
}

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

/// Returns `http(s)://host[:port]` for HTTP/HTTPS URLs, matching Conn's `pageOrigin`.
fn page_origin(raw: &str) -> Option<String> {
    let parsed = url::Url::parse(raw.trim()).ok()?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return None;
    }
    Some(parsed.origin().ascii_serialization())
}

/// Only browser annotations belonging to `origin` are visible inside that site's overlay.
fn annotation_belongs_to_origin(record: &AnnotationRecord, origin: &str) -> bool {
    if record.source == Some(conn_state::AnnotationRecordSource::Device) {
        return false;
    }
    record
        .url
        .as_deref()
        .and_then(page_origin)
        .is_some_and(|rec_origin| rec_origin == origin)
}

/// Crops a region around `(x, y, w, h)` (CSS viewport points) out of CEF's BGRA frame
/// snapshot and encodes it as a `data:image/png;base64,...` string for `@t3tools/annotation-overlay`.
fn encode_bgra_crop_png_data_url(
    frame: &conn_web::FrameSnapshot,
    scale: f32,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    pad: f64,
) -> Option<String> {
    use image::ImageEncoder as _;

    if frame.width == 0 || frame.height == 0 {
        return None;
    }
    let s = f64::from(scale.max(1.0));
    let x0 = (((x - pad).max(0.0) * s).floor() as u32).min(frame.width.saturating_sub(1));
    let y0 = (((y - pad).max(0.0) * s).floor() as u32).min(frame.height.saturating_sub(1));
    let x1 = (((x + w + pad) * s).ceil() as u32).clamp(x0 + 1, frame.width);
    let y1 = (((y + h + pad) * s).ceil() as u32).clamp(y0 + 1, frame.height);
    let crop_w = x1.saturating_sub(x0);
    let crop_h = y1.saturating_sub(y0);
    if crop_w == 0 || crop_h == 0 {
        return None;
    }

    let mut rgba = Vec::with_capacity((crop_w as usize) * (crop_h as usize) * 4);
    let stride = (frame.width as usize) * 4;
    for row in y0..y1 {
        let row_start = (row as usize) * stride + (x0 as usize) * 4;
        let row_end = row_start + (crop_w as usize) * 4;
        let slice = frame.bgra.get(row_start..row_end)?;
        for px in slice.as_chunks::<4>().0 {
            // Convert BGRA -> RGBA.
            rgba.extend_from_slice(&[px[2], px[1], px[0], px[3]]);
        }
    }

    let mut png_bytes = Vec::new();
    let encoder = image::codecs::png::PngEncoder::new(&mut png_bytes);
    encoder
        .write_image(&rgba, crop_w, crop_h, image::ExtendedColorType::Rgba8)
        .ok()?;
    Some(format!(
        "data:image/png;base64,{}",
        encode_base64(&png_bytes)
    ))
}

fn encode_base64(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b0 = u32::from(chunk[0]);
        let b1 = chunk.get(1).copied().map_or(0, u32::from);
        let b2 = chunk.get(2).copied().map_or(0, u32::from);
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[((triple >> 18) & 0x3f) as usize] as char);
        out.push(TABLE[((triple >> 12) & 0x3f) as usize] as char);
        if chunk.len() > 1 {
            out.push(TABLE[((triple >> 6) & 0x3f) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(TABLE[(triple & 0x3f) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}
