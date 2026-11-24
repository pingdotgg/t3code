//! The Laravel debug bar under the browser page (`apps/web/src/laravelToolbar/ui/ToolbarBar.tsx`):
//! a bar of counters with eight flyout panels. The data logic lives in
//! `conn_desktop::laravel_toolbar` (model, store, feed, layout); this module draws it.
//!
//! Hover opens a panel, click pins it, and a pinned panel stays until it is clicked again.

mod orbit;
mod panels;
mod parts;
#[cfg(test)]
mod render_tests;
mod requests;

use std::cell::{Cell, RefCell};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::time::Duration;

use conn_desktop::laravel_toolbar::feed::{
    self, HIDE_PAGE_TOOLBAR_CSS, ResponseKind, TOOLBAR_HOST_NAME, ToolbarFeed, ToolbarMessage,
};
use conn_desktop::laravel_toolbar::layout::{
    PanelResize, TOOLBAR_SHEET_INSET, TableSort, panel_height_path, read_panel_height,
    save_panel_height,
};
use conn_desktop::laravel_toolbar::model::{
    self, ToolbarData, format_count, format_ms, has_query_issues, model_count, summarize,
};
use conn_desktop::laravel_toolbar::store::ToolbarStore;
use conn_theme::Tokens;
use conn_web::{BrowserView, Rect as WebRect, ToolbarResponse};
use gpui_kit::component::h_flex;
use gpui_kit::component::input::{InputEvent, InputState};
use gpui_kit::prelude::*;
use gpui_kit::{
    ClickEvent, Context, Entity, EventEmitter, FontWeight, IntoElement, MouseButton,
    MouseDownEvent, MouseMoveEvent, MouseUpEvent, ParentElement, Render, Styled, Subscription,
    Task, Window, canvas, deferred, div, px, relative,
};

use self::parts::TEXT_PX;
use super::chrome;
use super::color::to_hsla;
use crate::a11y::ConnA11yExt as _;
use crate::header::details_card::EditorTarget;
use crate::icons;
use crate::theme::hsla_alpha;
use gpui_kit::TestSupportExt as _;

pub(crate) use self::orbit::OrbitTool;
pub(crate) use self::requests::RequestTab;

/// The tab a browser panel's store uses: the page's own requests.
const PAGE_TAB: &str = "page";
/// `OPEN_DELAY_MS` / `CLOSE_DELAY_MS`.
const OPEN_DELAY: Duration = Duration::from_millis(75);
const CLOSE_DELAY: Duration = Duration::from_millis(120);
/// The bar's height: a 1px top border, 7.5px padding twice and the 32px group.
const BAR_HEIGHT_PX: f32 = 48.0;
/// `@2xl`, `@3xl`, `@4xl` container widths of the bar.
pub(crate) const WIDTH_2XL: f32 = 672.0;
pub(crate) const WIDTH_3XL: f32 = 768.0;
pub(crate) const WIDTH_4XL: f32 = 896.0;

/// The panels the bar opens (`PANEL_IDS`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum PanelId {
    Requests,
    Request,
    Timings,
    Memory,
    Database,
    Models,
    Orbit,
    Environment,
}

impl PanelId {
    pub(crate) const fn key(self) -> &'static str {
        match self {
            Self::Requests => "requests",
            Self::Request => "request",
            Self::Timings => "timings",
            Self::Memory => "memory",
            Self::Database => "database",
            Self::Models => "models",
            Self::Orbit => "orbit",
            Self::Environment => "environment",
        }
    }
}

/// What the bar asks of the app around it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum LaravelToolbarEvent {
    /// A query's SQL for the Database panel (`openDatabaseQuery`).
    OpenQuery(String),
}

impl EventEmitter<LaravelToolbarEvent> for LaravelToolbar {}

/// Which sorted table a sort belongs to.
#[derive(Default)]
pub(crate) struct Sorts {
    pub(crate) requests: Option<TableSort>,
    pub(crate) cookies: Option<TableSort>,
    pub(crate) queries: Option<TableSort>,
    pub(crate) models: Option<TableSort>,
}

pub(crate) struct LaravelToolbar {
    pub(crate) tokens: Tokens,
    pub(crate) store: ToolbarStore,
    /// The store's tab of this bar: the page, or an API panel's project.
    tab_key: String,
    /// Where each request came from, so its payload loads from that app (API panel).
    origins: std::collections::HashMap<String, String>,
    feed: ToolbarFeed,
    /// The page's browser, to run the in-page details fetch.
    view: Rc<RefCell<Option<BrowserView>>>,
    /// The page area above the bar: the flyout may use its height.
    page_bounds: Rc<Cell<Option<WebRect>>>,
    bar_width: Rc<Cell<f32>>,
    pinned: Option<PanelId>,
    hovered: Option<PanelId>,
    hover_task: Option<Task<()>>,
    resize: PanelResize,
    height_path: PathBuf,
    /// A resize drag: the pointer's start `y` and the height it began at.
    drag: Option<(f32, f32)>,
    pub(crate) request_tab: RequestTab,
    pub(crate) env_tab: panels::EnvironmentTab,
    pub(crate) query_filter: panels::QueryFilter,
    pub(crate) sorts: Sorts,
    pub(crate) search: Option<Entity<InputState>>,
    pub(crate) search_open: bool,
    pub(crate) props_open: HashSet<String>,
    /// Details already asked of the page, so a summary is fetched once.
    details_requested: HashSet<String>,
    project_root: Option<PathBuf>,
    pub(crate) orbit: OrbitTool,
    _subscriptions: Vec<Subscription>,
}

fn config_dir() -> PathBuf {
    std::env::var_os("CONN_GPUI_CONFIG_DIR").map_or_else(
        || {
            PathBuf::from(std::env::var_os("HOME").unwrap_or_default())
                .join("Library")
                .join("Application Support")
                .join("conn-gpui")
        },
        PathBuf::from,
    )
}

impl LaravelToolbar {
    pub(crate) fn new(
        tokens: Tokens,
        view: Rc<RefCell<Option<BrowserView>>>,
        page_bounds: Rc<Cell<Option<WebRect>>>,
        cx: &mut Context<'_, Self>,
    ) -> Self {
        let height_path = panel_height_path(&config_dir());
        let preferred = read_panel_height(&height_path);
        let orbit = OrbitTool::new(cx);
        Self {
            tokens,
            store: ToolbarStore::default(),
            tab_key: PAGE_TAB.to_owned(),
            origins: std::collections::HashMap::new(),
            feed: ToolbarFeed::default(),
            view,
            page_bounds,
            bar_width: Rc::new(Cell::new(0.0)),
            pinned: None,
            hovered: None,
            hover_task: None,
            resize: PanelResize {
                preferred,
                available: preferred,
            },
            height_path,
            drag: None,
            request_tab: RequestTab::Route,
            env_tab: panels::EnvironmentTab::Framework,
            query_filter: panels::QueryFilter::All,
            sorts: Sorts::default(),
            search: None,
            search_open: false,
            props_open: HashSet::new(),
            details_requested: HashSet::new(),
            project_root: None,
            orbit,
            _subscriptions: Vec::new(),
        }
    }

    /// Shows another tab of the store (the API panel keeps one per project).
    pub(crate) fn set_tab_key(&mut self, key: &str, cx: &mut Context<'_, Self>) {
        if self.tab_key != key {
            key.clone_into(&mut self.tab_key);
            self.close_panel();
            cx.notify();
        }
    }

    /// The response of an API-panel request: its toolbar data goes to the bar under the response
    /// (`receiveToolbarData` of `ApiPanel.tsx`). A response without toolbar data changes nothing.
    pub(crate) fn receive_api_response(
        &mut self,
        request: &conn_desktop::api_request::store::ApiRequestDraft,
        response: &conn_desktop::api_request::ApiResponse,
        cx: &mut Context<'_, Self>,
    ) {
        let Some(receipt) = conn_desktop::api_request::toolbar::toolbar_receipt(request, response)
        else {
            return;
        };
        self.origins
            .insert(receipt.id.clone(), receipt.origin.clone());
        self.store
            .tab_mut(&self.tab_key)
            .receive_request(receipt.row, receipt.data);
        self.orbit_page_changed(&response.url, cx);
        self.request_missing_details(cx);
        cx.notify();
    }

    pub(crate) fn set_tokens(&mut self, tokens: Tokens, cx: &mut Context<'_, Self>) {
        self.tokens = tokens;
        cx.notify();
    }

    /// The project's root: a source link only opens files inside it.
    pub(crate) fn set_project_root(&mut self, root: Option<PathBuf>, cx: &mut Context<'_, Self>) {
        if self.project_root != root {
            self.project_root = root;
            cx.notify();
        }
    }

    /// Whether the bar has anything to show.
    pub(crate) fn is_visible(&self) -> bool {
        self.store
            .tab(&self.tab_key)
            .is_some_and(|tab| !tab.is_empty())
    }

    // ─── Data intake ────────────────────────────────────────────────────────

    /// A response read natively by the browser: a document or a fetch/XHR.
    pub(crate) fn on_response(&mut self, response: ToolbarResponse, cx: &mut Context<'_, Self>) {
        let payload = feed::payload_from_response(
            response.full.as_deref(),
            response.summary.as_deref(),
            &response.method,
            &response.url,
        );
        let kind = if response.document {
            ResponseKind::Document
        } else {
            ResponseKind::Fetch
        };
        let messages = self.feed.response(kind, &response.url, payload);
        self.apply(messages, cx);
    }

    /// The main frame started loading a new document.
    pub(crate) fn on_load_start(&mut self, cx: &mut Context<'_, Self>) {
        self.feed.new_document();
        // The page's old data stays until the new page says what it has (`none` or a payload).
        cx.notify();
    }

    /// The page's own data on DOMContentLoaded, or that it has none.
    pub(crate) fn on_page_data(
        &mut self,
        data: Option<ToolbarData>,
        url: &str,
        cx: &mut Context<'_, Self>,
    ) {
        self.orbit_page_changed(url, cx);
        let messages = match data {
            Some(data) => self.feed.page_data(data),
            None => self.feed.page_ready(url),
        };
        self.apply(messages, cx);
    }

    /// A `laravel-toolbar:update` event of the page.
    pub(crate) fn on_page_update(&mut self, data: ToolbarData, cx: &mut Context<'_, Self>) {
        self.apply(vec![ToolbarFeed::page_update(data)], cx);
    }

    /// The payload of a request, from the in-page details fetch.
    pub(crate) fn on_details(&mut self, id: &str, raw: ToolbarData, cx: &mut Context<'_, Self>) {
        self.store.tab_mut(&self.tab_key).receive_details(id, raw);
        cx.notify();
    }

    fn apply(&mut self, messages: Vec<ToolbarMessage>, cx: &mut Context<'_, Self>) {
        for message in messages {
            let cleared = matches!(message, ToolbarMessage::None);
            feed::apply_message(&mut self.store, &self.tab_key, message);
            if cleared {
                self.details_requested.clear();
                self.close_panel();
            }
        }
        self.request_missing_details(cx);
        cx.notify();
    }

    /// A summary has a row only: the page's `/_toolbar/requests/{id}` has the payload.
    fn request_missing_details(&mut self, cx: &mut Context<'_, Self>) {
        let Some(tab) = self.store.tab(&self.tab_key) else {
            return;
        };
        let Some(id) = tab.shown_id().map(ToOwned::to_owned) else {
            return;
        };
        if tab.shown_data().is_some() || !self.details_requested.insert(id.clone()) {
            return;
        }
        // A request an API response reported loads from the app that served it; a page's loads
        // in the page, with its cookies.
        if let Some(origin) = self.origins.get(&id).cloned() {
            let request = conn_desktop::api_request::toolbar::toolbar_details_request(&origin, &id);
            let task = crate::live::RT
                .spawn(async move { conn_desktop::api_request::send(&request).await });
            cx.spawn(async move |this, cx| {
                if let Some(raw) = task.await.ok().and_then(|response| {
                    conn_desktop::api_request::toolbar::parse_toolbar_details(&response)
                }) {
                    let _ = this.update(cx, |this, cx| this.on_details(&id, raw, cx));
                }
            })
            .detach();
        } else if let Some(view) = self.view.borrow().as_ref() {
            view.execute_javascript(&details_script(&id));
        }
    }

    /// Picks a request in the Requests panel and loads its details.
    pub(crate) fn select_request(&mut self, id: &str, cx: &mut Context<'_, Self>) {
        self.store.tab_mut(&self.tab_key).select(Some(id));
        // A request the page cannot be asked about again has no details to fetch.
        self.request_missing_details(cx);
        cx.notify();
    }

    // ─── Panels ─────────────────────────────────────────────────────────────

    pub(crate) fn active(&self) -> Option<PanelId> {
        self.hovered.or(self.pinned)
    }

    fn close_panel(&mut self) {
        self.pinned = None;
        self.hovered = None;
        self.hover_task = None;
    }

    fn enter(&mut self, id: PanelId, cx: &mut Context<'_, Self>) {
        self.hover_task = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(OPEN_DELAY).await;
            this.update(cx, |this, cx| {
                this.hovered = Some(id);
                cx.notify();
            })
            .ok();
        }));
    }

    fn leave(&mut self, cx: &mut Context<'_, Self>) {
        self.hover_task = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(CLOSE_DELAY).await;
            this.update(cx, |this, cx| {
                this.hovered = None;
                cx.notify();
            })
            .ok();
        }));
    }

    fn stay(&mut self) {
        self.hover_task = None;
    }

    /// `pin`: a resize starts: the open panel stays.
    fn pin(&mut self) {
        self.hover_task = None;
        self.pinned = self.hovered.or(self.pinned);
        self.hovered = None;
    }

    fn toggle(&mut self, id: PanelId, cx: &mut Context<'_, Self>) {
        self.hover_task = None;
        self.hovered = None;
        self.pinned = if self.pinned == Some(id) {
            None
        } else {
            Some(id)
        };
        cx.notify();
    }

    // ─── Flyout resize ──────────────────────────────────────────────────────

    fn sync_available(&mut self) {
        let page = self.page_bounds.get().map_or(0.0, |bounds| bounds.height);
        let available = (page - 2.0 * TOOLBAR_SHEET_INSET).floor().max(0.0);
        if available > 0.0 {
            self.resize.available = available;
        }
    }

    fn begin_drag(&mut self, y: f32, cx: &mut Context<'_, Self>) {
        self.pin();
        self.drag = Some((y, self.resize.height()));
        cx.notify();
    }

    fn drag_to(&mut self, y: f32, cx: &mut Context<'_, Self>) {
        if let Some((from, start)) = self.drag {
            self.resize.drag_to(start + (from - y));
            cx.notify();
        }
    }

    fn end_drag(&mut self, cx: &mut Context<'_, Self>) {
        if self.drag.take().is_some() {
            save_panel_height(&self.height_path, self.resize.preferred);
            cx.notify();
        }
    }

    fn resize_key(&mut self, key: &str, shift: bool, cx: &mut Context<'_, Self>) -> bool {
        self.pin();
        let handled = self.resize.key(key, shift).is_some();
        if handled {
            save_panel_height(&self.height_path, self.resize.preferred);
            cx.notify();
        }
        handled
    }

    // ─── Actions ────────────────────────────────────────────────────────────

    /// Opens `file[:line]` in the editor, only inside the project root.
    pub(crate) fn open_source(&mut self, target: &str, cx: &mut Context<'_, Self>) {
        let Some(root) = self.project_root.as_deref() else {
            return;
        };
        if let Some(command) = source_open_command(root, target) {
            std::thread::spawn(move || {
                let _ = std::process::Command::new(&command.0)
                    .args(&command.1)
                    .status();
            });
        }
        cx.notify();
    }

    /// "Open in Database": the query goes to the Database panel with its bindings inlined.
    pub(crate) fn open_query(&mut self, sql: String, cx: &mut Context<'_, Self>) {
        cx.emit(LaravelToolbarEvent::OpenQuery(sql));
    }

    pub(crate) fn can_open_source(&self) -> bool {
        self.project_root.is_some()
    }

    // ─── Render ─────────────────────────────────────────────────────────────

    /// A bar item: flat inside its group, a light fill on hover, a stronger one while open.
    fn bar_item(
        &self,
        id: PanelId,
        label: &str,
        left_pad: f32,
        shrink: bool,
        children: Vec<gpui_kit::AnyElement>,
        cx: &mut Context<'_, Self>,
    ) -> gpui_kit::AnyElement {
        let active = self.active() == Some(id);
        let fg = to_hsla(self.tokens.foreground);
        let hover = hsla_alpha(self.tokens.foreground, 0.06);
        let pressed = hsla_alpha(self.tokens.foreground, 0.10);
        let mut item = h_flex()
            .id(gpui_kit::SharedString::from(format!(
                "laravel-toolbar-item-{}",
                id.key()
            )))
            .test_support()
            .a11y_button(
                format!("browser.laravel-toolbar.item.{}", id.key()),
                label.to_owned(),
            )
            .h(px(24.0))
            .min_w_0()
            .items_center()
            .gap(px(4.0))
            .pl(px(left_pad))
            .pr(px(8.0))
            .rounded_full()
            .cursor_pointer()
            .text_size(px(TEXT_PX))
            .font_weight(FontWeight::MEDIUM)
            .text_color(fg)
            .hover(move |s| s.bg(hover))
            .on_hover(cx.listener(move |this, hovered: &bool, _window, cx| {
                if *hovered {
                    this.enter(id, cx);
                } else {
                    this.leave(cx);
                }
            }))
            .on_click(cx.listener(move |this, _: &ClickEvent, _window, cx| {
                this.toggle(id, cx);
            }));
        if active {
            item = item.bg(pressed);
        }
        item = if shrink { item } else { item.flex_shrink_0() };
        item.children(children).into_any_element()
    }

    fn bar_icon(&self, concept: &'static str) -> gpui_kit::AnyElement {
        icons::concept(concept, 14.0, to_hsla(self.tokens.muted_foreground)).into_any_element()
    }

    fn bar_text(
        &self,
        text: impl Into<gpui_kit::SharedString>,
        muted: bool,
    ) -> gpui_kit::AnyElement {
        let color = if muted {
            to_hsla(self.tokens.muted_foreground)
        } else {
            to_hsla(self.tokens.foreground)
        };
        div()
            .truncate()
            .text_color(color)
            .child(text.into())
            .into_any_element()
    }

    fn render_bar(&self, cx: &mut Context<'_, Self>) -> gpui_kit::AnyElement {
        let tokens = &self.tokens;
        let tab = self.store.tab(&self.tab_key);
        let selected = tab.and_then(|tab| tab.shown_data());
        let history_len = tab.map_or(0, |tab| tab.history.len());
        let summary = tab.and_then(|tab| {
            let row = tab.shown_row()?;
            Some(summarize(row, selected))
        });
        let wide = self.bar_width.get() >= WIDTH_2XL;

        let mut left = chrome::toolbar_group(tokens).min_w_0();
        left = left.child(self.bar_item(
            PanelId::Requests,
            "Requests on this page",
            8.0,
            false,
            vec![
                self.bar_icon("superhero/list.svg"),
                self.bar_text(format_count(history_len as f64), false),
            ],
            cx,
        ));
        if let Some(summary) = &summary {
            left = left.child(self.bar_item(
                PanelId::Request,
                "Request details",
                4.0,
                true,
                vec![
                    parts::status_badge(tokens, summary.status),
                    parts::method_badge(tokens, &summary.method),
                    self.bar_text(
                        summary.route_name.clone().unwrap_or_else(|| "Unnamed route".to_owned()),
                        true,
                    ),
                ],
                cx,
            ));
        }

        let mut row = h_flex()
            .id("laravel-toolbar-bar")
            .test_support()
            .a11y_group("browser.laravel-toolbar.bar", "Laravel toolbar")
            .w_full()
            .overflow_hidden()
            .items_center()
            .gap(px(8.0))
            .px(px(6.0))
            .py(px(7.5))
            .border_t_1()
            .border_color(to_hsla(tokens.shell_divider))
            .bg(to_hsla(tokens.shell_card))
            .child(left);

        if let Some(data) = selected {
            let issues = has_query_issues(data);
            let database_icon = div()
                .relative()
                .child(self.bar_icon("superhero/database.svg"))
                .children(issues.then(|| {
                    div()
                        .absolute()
                        .top(px(-2.0))
                        .right(px(-2.0))
                        .size(px(6.0))
                        .rounded_full()
                        .bg(to_hsla(tokens.warning))
                }))
                .into_any_element();
            let stats = chrome::toolbar_group(tokens)
                .flex_shrink_0()
                .child(self.bar_item(
                    PanelId::Timings,
                    "Timings",
                    8.0,
                    false,
                    vec![
                        self.bar_icon("superhero/timer.svg"),
                        self.bar_text(format_ms(model::wall_time_ms(data)), false),
                    ],
                    cx,
                ))
                .child(self.bar_item(
                    PanelId::Memory,
                    "Memory",
                    8.0,
                    false,
                    vec![
                            self.bar_icon("superhero/memory.svg"),
                            self.bar_text(
                                model::str_at(
                                    data,
                                    &["profiler", "total_allocated_memory", "formattedValue"],
                                )
                                .unwrap_or("–")
                                .to_owned(),
                                false,
                            ),
                        ],
                    cx,
                ))
                .child(self.bar_item(
                    PanelId::Database,
                    "Database queries",
                    8.0,
                    false,
                    vec![
                        database_icon,
                        self.bar_text(
                            format_count(
                                model::at(data, &["queries", "queries"])
                                    .and_then(serde_json::Value::as_array)
                                    .map_or(0, Vec::len) as f64,
                            ),
                            false,
                        ),
                    ],
                    cx,
                ))
                .child(self.bar_item(
                    PanelId::Models,
                    "Eloquent models",
                    8.0,
                    false,
                    vec![
                        self.bar_icon("superhero/package.svg"),
                        self.bar_text(format_count(model_count(data) as f64), false),
                    ],
                    cx,
                ));
            row = row.child(stats);
        }

        let mut right = h_flex()
            .ml_auto()
            .flex_shrink_0()
            .items_center()
            .gap(px(8.0));
        if self.orbit.is_ready() {
            let warned = self.orbit.has_warnings();
            let icon = div()
                .relative()
                .child(orbit::orbit_icon(tokens))
                .children(warned.then(|| {
                    div()
                        .absolute()
                        .top(px(-2.0))
                        .right(px(-2.0))
                        .size(px(6.0))
                        .rounded_full()
                        .bg(to_hsla(tokens.warning))
                }))
                .into_any_element();
            right = right.child(chrome::toolbar_group(tokens).child(self.bar_item(
                PanelId::Orbit,
                "Orbit",
                8.0,
                false,
                vec![icon],
                cx,
            )));
        }
        if let (Some(data), true) = (selected, wide) {
            let app = model::framework(Some(data));
            let php_version = model::str_at(data, &["php", "version"]);
            let short = |version: Option<&str>| {
                version.map_or_else(
                    || "–".to_owned(),
                    |v| v.split('.').take(2).collect::<Vec<_>>().join("."),
                )
            };
            let mut content = Vec::new();
            if app.name == "Symfony" {
                content.push(parts::brand_icon(tokens, parts::Brand::Symfony));
            } else if app.is_laravel {
                content.push(parts::brand_icon(tokens, parts::Brand::Laravel));
            }
            content.push(self.bar_text(short(app.version.as_deref()), true));
            content.push(self.bar_text("·", true));
            content.push(parts::brand_icon(tokens, parts::Brand::Php));
            content.push(self.bar_text(short(php_version), true));
            right = right.child(chrome::toolbar_group(tokens).child(self.bar_item(
                PanelId::Environment,
                &format!("{} and PHP", app.name),
                8.0,
                false,
                content,
                cx,
            )));
        }
        row = row.child(right);

        let width = self.bar_width.clone();
        row.child(
            canvas(
                move |bounds, _window, _cx| width.set(f32::from(bounds.size.width)),
                |_, (), _, _| {},
            )
            .absolute()
            .size_full(),
        )
        .relative()
        .into_any_element()
    }

    /// The floating sheet over the page, inset like the bar's groups.
    fn render_sheet(
        &mut self,
        id: PanelId,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) -> gpui_kit::AnyElement {
        let tokens = self.tokens.clone();
        let height = self.resize.height();
        let body = match id {
            PanelId::Requests => self.render_requests_panel(window, cx),
            PanelId::Request => self.render_request_panel(window, cx),
            PanelId::Timings => self.render_timings_panel(window, cx),
            PanelId::Memory => self.render_memory_panel(window, cx),
            PanelId::Database => self.render_database_panel(window, cx),
            PanelId::Models => self.render_models_panel(window, cx),
            PanelId::Orbit => self.render_orbit_panel(window, cx),
            PanelId::Environment => self.render_environment_panel(window, cx),
        };
        let inset = TOOLBAR_SHEET_INSET;
        let sheet = div()
            .id("laravel-toolbar-sheet")
            .test_support()
            .a11y_group(
                format!("browser.laravel-toolbar.panel.{}", id.key()),
                format!("{} panel", id.key()),
            )
            .occlude()
            .absolute()
            .left(px(inset))
            .right(px(inset))
            .bottom(px(inset))
            .h(px(height))
            .overflow_hidden()
            .rounded(px(12.0))
            .border_1()
            .border_color(to_hsla(tokens.shell_divider_header))
            .bg(to_hsla(tokens.shell_card))
            .text_color(to_hsla(tokens.foreground))
            .shadow_lg()
            .on_hover(cx.listener(|this, hovered: &bool, _window, cx| {
                if *hovered {
                    this.stay();
                } else if this.pinned.is_none() {
                    this.leave(cx);
                }
            }))
            .child(body);
        // The sheet's band reaches from the page's top edge to the bar; the page behind stays
        // visible around the sheet.
        deferred(
            div()
                .absolute()
                .left_0()
                .right_0()
                .bottom(relative(1.0))
                .h(px(height + 2.0 * inset))
                .child(sheet),
        )
        .with_priority(3)
        .into_any_element()
    }

    /// While a resize drag runs, a transparent layer over the window follows the pointer.
    fn render_drag_layer(&self, cx: &mut Context<'_, Self>) -> Option<gpui_kit::AnyElement> {
        self.drag?;
        Some(
            deferred(
                div()
                    .id("laravel-toolbar-drag")
                    .absolute()
                    .top(px(-4000.0))
                    .left(px(-4000.0))
                    .w(px(9000.0))
                    .h(px(9000.0))
                    .cursor_row_resize()
                    .on_mouse_move(cx.listener(|this, event: &MouseMoveEvent, _window, cx| {
                        this.drag_to(f32::from(event.position.y), cx);
                    }))
                    .on_mouse_up(
                        MouseButton::Left,
                        cx.listener(|this, _: &MouseUpEvent, _window, cx| this.end_drag(cx)),
                    ),
            )
            .with_priority(4)
            .into_any_element(),
        )
    }

    /// The panel's header row, which is also the resize handle (`PanelShell`).
    pub(crate) fn panel_header(
        &self,
        icon: &'static str,
        title: String,
        meta: Option<gpui_kit::AnyElement>,
        actions: Option<gpui_kit::AnyElement>,
        has_tabs: bool,
        cx: &mut Context<'_, Self>,
    ) -> gpui_kit::AnyElement {
        let glyph =
            icons::concept(icon, 14.0, to_hsla(self.tokens.muted_foreground)).into_any_element();
        self.panel_header_with_icon(glyph, title, meta, actions, has_tabs, cx)
    }

    /// The header with any mark in front of the title (the Orbit tool draws its own).
    pub(crate) fn panel_header_with_icon(
        &self,
        icon: gpui_kit::AnyElement,
        title: String,
        meta: Option<gpui_kit::AnyElement>,
        actions: Option<gpui_kit::AnyElement>,
        has_tabs: bool,
        cx: &mut Context<'_, Self>,
    ) -> gpui_kit::AnyElement {
        let tokens = &self.tokens;
        let height = self.resize.height();
        let focus_ring = to_hsla(tokens.ring);
        let mut header = h_flex()
            .id("laravel-toolbar-panel-header")
            .relative()
            .h(px(44.0))
            .flex_shrink_0()
            .items_center()
            .gap(px(12.0))
            .pl(px(12.0))
            .pr(px(6.0))
            .cursor_row_resize()
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, event: &MouseDownEvent, _window, cx| {
                    this.begin_drag(f32::from(event.position.y), cx);
                }),
            )
            .child(
                div()
                    .id("laravel-toolbar-resize")
                    .test_support()
                    .a11y(
                        gpui_kit::Role::Splitter,
                        "browser.laravel-toolbar.resize",
                        format!("Resize toolbar panel, {} px", height.round()),
                    )
                    .absolute()
                    .left_0()
                    .right_0()
                    .top_0()
                    .h(px(4.0))
                    .focus_visible(move |s| s.bg(focus_ring))
                    .on_key_down(cx.listener(
                        |this, event: &gpui_kit::KeyDownEvent, _window, cx| {
                            let key = event.keystroke.key.as_str();
                            if this.resize_key(key, event.keystroke.modifiers.shift, cx) {
                                cx.stop_propagation();
                            }
                        },
                    )),
            )
            .child(
                h_flex()
                    .min_w_0()
                    .items_center()
                    .gap(px(8.0))
                    .child(icon)
                    .child(
                        div()
                            .truncate()
                            .text_size(px(TEXT_PX))
                            .font_weight(FontWeight::MEDIUM)
                            .child(title),
                    ),
            );
        if let Some(meta) = meta {
            header = header.child(
                h_flex()
                    .min_w_0()
                    .items_center()
                    .gap(px(8.0))
                    .text_size(px(TEXT_PX))
                    .text_color(to_hsla(tokens.muted_foreground))
                    .child(meta),
            );
        }
        if let Some(actions) = actions {
            header = header.child(
                h_flex()
                    .ml_auto()
                    .flex_shrink_0()
                    .items_center()
                    .gap(px(8.0))
                    .child(actions),
            );
        }
        if !has_tabs {
            header = header.border_b_1().border_color(to_hsla(tokens.border));
        }
        header.into_any_element()
    }

    /// `PanelShell`: the header over a body that scrolls (`flush` lays itself out).
    pub(crate) fn panel_shell(
        &self,
        panel: PanelId,
        header: gpui_kit::AnyElement,
        flush: bool,
        body: gpui_kit::AnyElement,
    ) -> gpui_kit::AnyElement {
        let scroller = if flush {
            div()
                .id(gpui_kit::SharedString::from(format!(
                    "laravel-toolbar-flush-{}",
                    panel.key()
                )))
                .flex()
                .flex_col()
                .flex_1()
                .min_h_0()
                .child(body)
        } else {
            div()
                .id(gpui_kit::SharedString::from(format!(
                    "laravel-toolbar-scroll-{}",
                    panel.key()
                )))
                .flex_1()
                .min_h_0()
                .overflow_y_scroll()
                .child(div().flex().flex_col().min_h(px(0.0)).child(body))
        };
        div()
            .flex()
            .flex_col()
            .size_full()
            .min_h_0()
            .child(header)
            .child(scroller)
            .into_any_element()
    }

    /// The search field of the Requests panel, once opened.
    pub(crate) fn ensure_search(
        &mut self,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) -> Entity<InputState> {
        if let Some(search) = &self.search {
            return search.clone();
        }
        let input = cx.new(|cx| InputState::new(window, cx).placeholder("Search URL or component"));
        let subscription = cx.subscribe_in(
            &input,
            window,
            |_this, _input, event: &InputEvent, _window, cx| {
                if matches!(event, InputEvent::Change) {
                    cx.notify();
                }
            },
        );
        self._subscriptions.push(subscription);
        self.search = Some(input.clone());
        input
    }
}

impl Render for LaravelToolbar {
    fn render(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) -> impl IntoElement {
        self.sync_available();
        let bar = self.render_bar(cx);
        let sheet = if self.is_visible() {
            self.active().map(|id| self.render_sheet(id, window, cx))
        } else {
            None
        };
        let drag = self.render_drag_layer(cx);
        div()
            .relative()
            .flex_shrink_0()
            .w_full()
            .h(px(BAR_HEIGHT_PX))
            .child(bar)
            .children(sheet)
            .children(drag)
    }
}

/// The script that asks the page for a request's payload (`/_toolbar/requests/{id}`) and
/// reports it through the console bridge. A same-origin fetch: the session cookie applies.
fn details_script(id: &str) -> String {
    let path = serde_json::to_string(&feed::details_path(id)).unwrap_or_default();
    let id = serde_json::to_string(id).unwrap_or_default();
    format!(
        r#"(()=>{{fetch({path},{{credentials:"same-origin",headers:{{Accept:"application/json"}}}}).then(r=>r.ok?r.json():null).then(j=>{{if(j&&j.raw)console.debug("{prefix}"+JSON.stringify({{type:"laravelToolbarDetails",id:{id},raw:j.raw}}));}}).catch(()=>{{}});}})();"#,
        prefix = RPC_PREFIX
    )
}

/// The console prefix the browser panel listens for.
pub(crate) const RPC_PREFIX: &str = "__CONN_OVERLAY_RPC__:";

/// The script run at the start and end of every load: the host flag and the CSS that hides the
/// page's own bar while the client draws it.
pub(crate) fn host_script() -> String {
    let css = serde_json::to_string(HIDE_PAGE_TOOLBAR_CSS).unwrap_or_default();
    format!(
        r#"(()=>{{try{{window.__LARAVEL_TOOLBAR_HOST__={host};if(!document.getElementById("conn-laravel-toolbar-hide")){{const s=document.createElement("style");s.id="conn-laravel-toolbar-hide";s.textContent={css};(document.head||document.documentElement).appendChild(s);}}}}catch(e){{}}}})();"#,
        host = serde_json::to_string(TOOLBAR_HOST_NAME).unwrap_or_default()
    )
}

/// The `open` command for `file[:line]`, only for a file inside `root`.
fn source_open_command(root: &Path, target: &str) -> Option<(String, Vec<String>)> {
    let (file, line) = split_location(target);
    let path = Path::new(file);
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        root.join(path)
    };
    let canonical = absolute.canonicalize().ok()?;
    let root = root.canonicalize().ok()?;
    if !canonical.starts_with(&root) {
        return None;
    }
    let editor = EditorTarget::ALL
        .into_iter()
        .find(|editor| editor.installed())?;
    let scheme = match editor {
        EditorTarget::Cursor => "cursor",
        EditorTarget::VsCode => "vscode",
        EditorTarget::Zed => "zed",
        EditorTarget::Finder => {
            return Some((
                "open".to_owned(),
                vec!["-R".to_owned(), canonical.display().to_string()],
            ));
        }
    };
    let url = format!(
        "{scheme}://file{}:{}",
        canonical.display(),
        line.unwrap_or(1)
    );
    Some(("open".to_owned(), vec![url]))
}

/// `path/to/file.php:42` as a file and a line.
fn split_location(target: &str) -> (&str, Option<u32>) {
    match target.rsplit_once(':') {
        Some((file, line)) if line.chars().all(|c| c.is_ascii_digit()) && !line.is_empty() => {
            (file, line.parse().ok())
        }
        _ => (target, None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_a_location_into_file_and_line() {
        assert_eq!(
            split_location("app/Http/X.php:42"),
            ("app/Http/X.php", Some(42))
        );
        assert_eq!(split_location("app/Http/X.php"), ("app/Http/X.php", None));
        assert_eq!(split_location("C:foo"), ("C:foo", None));
    }

    #[test]
    fn a_file_outside_the_project_does_not_open() {
        let root = std::env::temp_dir();
        assert!(source_open_command(&root, "/etc/hosts:1").is_none());
        assert!(source_open_command(&root, "../../etc/hosts").is_none());
    }

    #[test]
    fn the_details_script_fetches_the_request_path() {
        let script = details_script("a b/1");
        assert!(script.contains("/_toolbar/requests/a%20b%2F1"));
        assert!(script.contains("laravelToolbarDetails"));
    }

    #[test]
    fn the_host_script_names_the_host_and_hides_the_page_bar() {
        let script = host_script();
        assert!(script.contains("__LARAVEL_TOOLBAR_HOST__=\"Conn\""));
        assert!(script.contains("laravel-toolbar-shadow-host"));
    }
}
