//! The Requests and Request panels (`apps/web/src/laravelToolbar/ui/requests.tsx`).

use conn_desktop::laravel_toolbar::layout::{SortValue, next_table_sort, sort_table_rows};
use conn_desktop::laravel_toolbar::model::{
    self, PropBadge, PropRow, RequestKind, RequestSummary, clock_time, header_rows, prop_rows,
    route_uri, short_location, summarize,
};
use conn_desktop::laravel_toolbar::store::HistoryEntry;
use gpui_kit::component::h_flex;
use gpui_kit::component::input::Input;
use gpui_kit::prelude::*;
use gpui_kit::{
    AnyElement, ClickEvent, Context, IntoElement, KeyDownEvent, SharedString, Window, div, px,
};
use serde_json::Value;

use super::parts::{
    self, Align, MONO, TEXT_PX, Tone, Value as Cell, Width, badge, body_row, cell, empty_row,
    head_row, key_value_rows, section, sort_header, source_link, stat, stat_strip, status_badge,
    underline_tabs,
};
use super::{LaravelToolbar, PanelId, WIDTH_2XL, WIDTH_3XL, WIDTH_4XL};
use crate::a11y::ConnA11yExt as _;
use crate::panels::chrome;
use crate::panels::color::to_hsla;
use crate::theme::hsla_alpha;
use gpui_kit::TestSupportExt as _;

const KIND_LABEL: [(RequestKind, &str); 3] = [
    (RequestKind::Page, "page"),
    (RequestKind::Inertia, "inertia"),
    (RequestKind::Xhr, "xhr"),
];

fn kind_label(kind: RequestKind) -> &'static str {
    KIND_LABEL
        .iter()
        .find(|(k, _)| *k == kind)
        .map_or("page", |(_, label)| label)
}

/// The tabs of the Request panel.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RequestTab {
    Route,
    Props,
    Request,
    Response,
    Cookies,
}

/// A history row with the summary the panel draws.
#[derive(Clone)]
struct Listed {
    entry: HistoryEntry,
    summary: RequestSummary,
}

impl LaravelToolbar {
    fn loading(&self) -> AnyElement {
        empty_row(&self.tokens, "loading", "Loading request…")
    }

    // ─── Requests: every request this page made ─────────────────────────────

    pub(super) fn render_requests_panel(
        &mut self,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let tokens = self.tokens.clone();
        let width = self.bar_width.get();
        let (show_type, show_component, show_route) =
            (width >= WIDTH_2XL, width >= WIDTH_3XL, width >= WIDTH_4XL);
        let search = self.search_open.then(|| self.ensure_search(window, cx));
        let needle = search
            .as_ref()
            .map(|input| input.read(cx).value().trim().to_lowercase())
            .unwrap_or_default();

        let (history_len, selected_id, listed) = {
            let tab = self.store.tab(&self.tab_key);
            let history_len = tab.map_or(0, |tab| tab.history.len());
            let selected_id = tab.and_then(|tab| tab.shown_id().map(ToOwned::to_owned));
            let listed: Vec<Listed> = tab
                .map(|tab| {
                    tab.history
                        .iter()
                        .map(|entry| Listed {
                            summary: summarize(&entry.row, tab.details.get(&entry.row.id)),
                            entry: entry.clone(),
                        })
                        .filter(|item| {
                            needle.is_empty()
                                || item.summary.uri.to_lowercase().contains(&needle)
                                || item
                                    .summary
                                    .component
                                    .as_deref()
                                    .unwrap_or_default()
                                    .to_lowercase()
                                    .contains(&needle)
                                || item.summary.route.to_lowercase().contains(&needle)
                        })
                        .collect()
                })
                .unwrap_or_default();
            (history_len, selected_id, listed)
        };
        let rows = sort_table_rows(&listed, self.sorts.requests.as_ref(), |item, column| {
            let summary = &item.summary;
            match column {
                "duration" => summary.duration_ms.map(SortValue::Number),
                "time" => Some(SortValue::Number(item.entry.received_at as f64)),
                "status" => summary.status.map(|s| SortValue::Number(f64::from(s))),
                "method" => Some(SortValue::Text(summary.method.clone())),
                "uri" => Some(SortValue::Text(summary.uri.clone())),
                "component" => summary.component.clone().map(SortValue::Text),
                "route" => Some(SortValue::Text(summary.route.clone())),
                _ => Some(SortValue::Text(kind_label(summary.kind).to_owned())),
            }
        });

        // The search button and, when open, its field.
        let search_open = self.search_open;
        let search_button = chrome::icon_button(
            "laravel-toolbar-search",
            if search_open {
                "superhero/close.svg"
            } else {
                "superhero/search.svg"
            },
            &tokens,
            false,
            cx.listener(|this, _: &ClickEvent, _window, cx| {
                this.search_open = !this.search_open;
                if !this.search_open {
                    this.search = None;
                }
                cx.notify();
            }),
        )
        .test_support()
        .a11y_button(
            "browser.laravel-toolbar.requests.search",
            if search_open {
                "Close search"
            } else {
                "Search requests"
            },
        );
        let mut actions = h_flex().items_center().gap(px(8.0));
        if let Some(input) = &search {
            actions = actions.child(
                div()
                    .id("laravel-toolbar-search-field")
                    .test_support()
                    .a11y_group(
                        "browser.laravel-toolbar.requests.search-field",
                        "Search requests",
                    )
                    .w(px(256.0))
                    .on_key_down(cx.listener(|this, event: &KeyDownEvent, _window, cx| {
                        if event.keystroke.key == "escape" {
                            this.search_open = false;
                            this.search = None;
                            cx.stop_propagation();
                            cx.notify();
                        }
                    }))
                    .child(
                        Input::new(input)
                            .appearance(false)
                            .px_0()
                            .text_size(px(TEXT_PX)),
                    ),
            );
        }
        actions = actions.child(chrome::toolbar_group(&tokens).child(search_button));

        let header = self.panel_header(
            "superhero/list.svg",
            "Requests".to_owned(),
            None,
            Some(actions.into_any_element()),
            false,
            cx,
        );

        let body = if rows.is_empty() {
            empty_row(
                &tokens,
                "requests-empty",
                if history_len == 0 {
                    "No requests yet"
                } else {
                    "No requests match"
                },
            )
        } else {
            let sort = self.sorts.requests.clone();
            let sorter = |column: &'static str,
                          label: &'static str,
                          width: Width,
                          align: Align,
                          cx: &mut Context<'_, Self>| {
                sort_header(
                    &tokens,
                    "requests",
                    column,
                    label,
                    sort.as_ref(),
                    width,
                    align,
                    move |this, _cx| {
                        this.sorts.requests = next_table_sort(this.sorts.requests.as_ref(), column);
                    },
                    cx,
                )
            };
            let mut head = vec![
                sorter("status", "Status", Width::Fixed(80.0), Align::Left, cx),
                sorter("method", "Method", Width::Fixed(72.0), Align::Left, cx),
                sorter("uri", "URI", Width::Flex, Align::Left, cx),
            ];
            if show_component {
                head.push(sorter(
                    "component",
                    "Component",
                    Width::Fixed(144.0),
                    Align::Left,
                    cx,
                ));
            }
            if show_route {
                head.push(sorter(
                    "route",
                    "Route",
                    Width::Fixed(176.0),
                    Align::Left,
                    cx,
                ));
            }
            if show_type {
                head.push(sorter("type", "Type", Width::Fixed(72.0), Align::Left, cx));
            }
            head.push(sorter(
                "duration",
                "Duration",
                Width::Fixed(96.0),
                Align::Right,
                cx,
            ));
            head.push(sorter("time", "Time", Width::Fixed(96.0), Align::Right, cx));

            let muted = to_hsla(tokens.muted_foreground);
            let highlight = to_hsla(tokens.shell_highlight);
            let hover = hsla_alpha(tokens.foreground, 0.04);
            let mut list = div()
                .flex()
                .flex_col()
                .w_full()
                .child(head_row(&tokens, head));
            for item in rows {
                let summary = item.summary;
                let id = summary.id.clone();
                let click_id = id.clone();
                let is_selected = selected_id.as_deref() == Some(id.as_str());
                let follow_up = item.entry.row.follow_up.is_some();
                let mut cells = vec![
                    cell(
                        Width::Fixed(80.0),
                        Align::Left,
                        h_flex()
                            .items_center()
                            .gap(px(6.0))
                            .children(follow_up.then(|| {
                                crate::icons::concept(
                                    "superhero/arrow-right.svg",
                                    14.0,
                                    hsla_alpha(tokens.muted_foreground, 0.6),
                                )
                            }))
                            .child(status_badge(&tokens, summary.status)),
                    ),
                    cell(
                        Width::Fixed(72.0),
                        Align::Left,
                        div()
                            .font_family(MONO)
                            .text_color(muted)
                            .child(summary.method.clone()),
                    ),
                    cell(
                        Width::Flex,
                        Align::Left,
                        div()
                            .truncate()
                            .font_family(MONO)
                            .child(summary.uri.clone()),
                    ),
                ];
                if show_component {
                    cells.push(cell(
                        Width::Fixed(144.0),
                        Align::Left,
                        div()
                            .truncate()
                            .font_family(MONO)
                            .child(summary.component.clone().unwrap_or_else(|| "–".to_owned())),
                    ));
                }
                if show_route {
                    cells.push(cell(
                        Width::Fixed(176.0),
                        Align::Left,
                        div()
                            .truncate()
                            .text_color(muted)
                            .child(summary.route.clone()),
                    ));
                }
                if show_type {
                    cells.push(cell(
                        Width::Fixed(72.0),
                        Align::Left,
                        div().text_color(muted).child(kind_label(summary.kind)),
                    ));
                }
                cells.push(cell(
                    Width::Fixed(96.0),
                    Align::Right,
                    div().child(summary.duration.clone().unwrap_or_else(|| "–".to_owned())),
                ));
                cells.push(cell(
                    Width::Fixed(96.0),
                    Align::Right,
                    div()
                        .text_color(muted)
                        .child(clock_time(item.entry.received_at)),
                ));
                let mut row = body_row(&tokens, cells)
                    .id(SharedString::from(format!("request-row-{id}")))
                    .test_support()
                    .a11y_button(
                        format!("browser.laravel-toolbar.requests.row.{id}"),
                        format!(
                            "{} {} {}",
                            summary.method,
                            summary.uri,
                            summary.status.map_or_else(String::new, |s| s.to_string())
                        ),
                    )
                    .cursor_pointer()
                    .hover(move |s| s.bg(hover))
                    .on_click(cx.listener(move |this, _: &ClickEvent, _window, cx| {
                        this.select_request(&click_id, cx);
                    }));
                if is_selected {
                    row = row.bg(highlight);
                }
                list = list.child(row);
            }
            list.into_any_element()
        };
        self.panel_shell(PanelId::Requests, header, false, body)
    }

    // ─── Request: the selected request in detail ────────────────────────────

    pub(super) fn render_request_panel(
        &mut self,
        _window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let tokens = self.tokens.clone();
        let tab = self.request_tab;
        let (selected, row) = {
            let store = self.store.tab(&self.tab_key);
            (
                store.and_then(|tab| tab.shown_data().cloned()),
                store.and_then(|tab| tab.shown_row().cloned()),
            )
        };
        let summary = row.as_ref().map(|row| summarize(row, selected.as_ref()));
        let component_path = selected
            .as_ref()
            .and_then(|data| model::str_at(data, &["inertia", "component_path"]))
            .map(ToOwned::to_owned);

        let meta = summary.as_ref().map(|summary| {
            let target = component_path.clone().filter(|_| self.can_open_source());
            h_flex()
                .min_w_0()
                .items_center()
                .gap(px(8.0))
                .child(status_badge(&tokens, summary.status))
                .child(parts::method_badge(&tokens, &summary.method))
                .child(
                    div()
                        .truncate()
                        .font_family(MONO)
                        .text_color(to_hsla(tokens.foreground))
                        .child(summary.uri.clone()),
                )
                .children(summary.component.clone().map(|component| {
                    source_link(
                        &tokens,
                        "component".to_owned(),
                        component,
                        false,
                        target,
                        cx,
                    )
                }))
                .into_any_element()
        });
        let actions = summary.as_ref().map(|summary| {
            div()
                .text_size(px(TEXT_PX))
                .text_color(to_hsla(tokens.muted_foreground))
                .child(kind_label(summary.kind))
                .into_any_element()
        });
        let header = self.panel_header(
            "superhero/globe.svg",
            "Request".to_owned(),
            meta,
            actions,
            true,
            cx,
        );

        let tabs = underline_tabs(
            &tokens,
            "request",
            tab,
            vec![
                (RequestTab::Route, "route", "Route".to_owned()),
                (RequestTab::Props, "props", "Props".to_owned()),
                (RequestTab::Request, "request", "Request headers".to_owned()),
                (
                    RequestTab::Response,
                    "response",
                    "Response headers".to_owned(),
                ),
                (RequestTab::Cookies, "cookies", "Cookies".to_owned()),
            ],
            |this, tab, _cx| this.request_tab = tab,
            cx,
        );

        let body = match &selected {
            None => self.loading(),
            Some(data) => match tab {
                RequestTab::Route => self.request_route_tab(data, summary.as_ref()),
                RequestTab::Props => self.request_props_tab(data, cx),
                RequestTab::Cookies => self.request_cookies_tab(data, cx),
                RequestTab::Request | RequestTab::Response => {
                    let key = if tab == RequestTab::Request {
                        "request"
                    } else {
                        "response"
                    };
                    let rows = header_rows(model::at(data, &[key, "headers"]))
                        .into_iter()
                        .map(|(name, value)| (name, Cell::Text(value)))
                        .collect();
                    key_value_rows(&tokens, key, rows, true)
                }
            },
        };
        let scroller = div()
            .id("laravel-toolbar-request-scroll")
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .child(body);
        let flush = div()
            .flex()
            .flex_col()
            .size_full()
            .min_h_0()
            .child(tabs)
            .child(scroller)
            .into_any_element();
        self.panel_shell(PanelId::Request, header, true, flush)
    }

    fn request_route_tab(
        &self,
        data: &model::ToolbarData,
        summary: Option<&RequestSummary>,
    ) -> AnyElement {
        let tokens = &self.tokens;
        let status = summary.and_then(|s| s.status);
        let tone = match status.unwrap_or(0) {
            400.. => Tone::Warning,
            300..=399 => Tone::Default,
            _ => Tone::Success,
        };
        let method = summary
            .map(|s| s.method.clone())
            .or_else(|| model::str_at(data, &["request", "method"]).map(ToOwned::to_owned))
            .unwrap_or_else(|| "–".to_owned());
        let redirect = model::str_at(data, &["response", "redirect_to"])
            .map(|to| format!(" · Redirect to {to}"))
            .unwrap_or_default();
        let content_type = model::str_at(data, &["response", "content_type"]).unwrap_or_default();
        let response_kind = if model::bool_at(data, &["request", "is_inertia"]).unwrap_or(false) {
            "Inertia".to_owned()
        } else if content_type.contains("json") {
            "JSON".to_owned()
        } else if content_type.contains("html") {
            "HTML".to_owned()
        } else if content_type.is_empty() {
            "–".to_owned()
        } else {
            content_type.to_owned()
        };
        let dash = |value: Option<&str>| value.map_or_else(|| "–".to_owned(), ToOwned::to_owned);

        let stats = stat_strip(
            tokens,
            vec![
                stat(
                    tokens,
                    "status",
                    "Status",
                    status.map_or_else(|| "–".to_owned(), |s| s.to_string()),
                    Some(format!("{method}{redirect}")),
                    tone,
                ),
                stat(
                    tokens,
                    "duration",
                    "Duration",
                    summary
                        .and_then(|s| s.duration.clone())
                        .unwrap_or_else(|| "–".to_owned()),
                    Some("Wall time".to_owned()),
                    Tone::Default,
                ),
                stat(
                    tokens,
                    "memory",
                    "Memory",
                    dash(model::str_at(
                        data,
                        &["profiler", "total_allocated_memory", "formattedValue"],
                    )),
                    Some("Peak allocated".to_owned()),
                    Tone::Default,
                ),
                stat(
                    tokens,
                    "response",
                    "Response",
                    response_kind,
                    summary.and_then(|s| s.size.clone()),
                    Tone::Default,
                ),
            ],
        );

        // The middleware in the order they run, on one line with the other route values.
        let middleware: Vec<String> = model::at(data, &["request", "middleware"])
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.get("class").and_then(Value::as_str))
                    .map(|class| class.rsplit('\\').next().unwrap_or(class).to_owned())
                    .collect()
            })
            .unwrap_or_default();
        let chain = if middleware.is_empty() {
            Cell::Text("–".to_owned())
        } else {
            let mut line = h_flex().flex_wrap().items_center().gap(px(6.0));
            for (index, name) in middleware.iter().enumerate() {
                if index > 0 {
                    line = line.child(
                        div()
                            .text_color(to_hsla(tokens.muted_foreground))
                            .child("→"),
                    );
                }
                line = line.child(badge(tokens, None, name, true));
            }
            Cell::Element(line.into_any_element())
        };
        let rows = vec![
            (
                "Name".to_owned(),
                Cell::Mono(
                    summary
                        .and_then(|s| s.route_name.clone())
                        .unwrap_or_else(|| "–".to_owned()),
                ),
            ),
            (
                "URI".to_owned(),
                Cell::Mono(route_uri(Some(data)).unwrap_or_else(|| "–".to_owned())),
            ),
            (
                "Action".to_owned(),
                Cell::Mono(dash(model::str_at(data, &["request", "controller_action"]))),
            ),
            (
                "Client IP".to_owned(),
                Cell::Mono(dash(model::str_at(data, &["request", "ip_address"]))),
            ),
            ("Middleware".to_owned(), chain),
        ];
        div()
            .flex()
            .flex_col()
            .child(stats)
            .child(section(
                tokens,
                "route",
                None,
                None,
                false,
                key_value_rows(tokens, "route", rows, false),
            ))
            .into_any_element()
    }

    fn request_props_tab(
        &self,
        data: &model::ToolbarData,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let tokens = &self.tokens;
        let props = prop_rows(Some(data));
        if props.is_empty() {
            return empty_row(tokens, "props-empty", "No page props in this request");
        }
        let mut list = div().flex().flex_col().pl(px(6.0));
        for prop in props {
            let aside = self.prop_aside(&prop, cx);
            let value = if prop.loaded {
                prop.value.clone()
            } else {
                None
            };
            list = list.child(self.prop_node(
                &prop.name,
                &prop.name,
                value.as_ref(),
                0,
                Some(aside),
                cx,
            ));
        }
        list.into_any_element()
    }

    /// What Inertia knows about a top-level prop: its badges and where it is defined.
    fn prop_aside(&self, prop: &PropRow, cx: &mut Context<'_, Self>) -> AnyElement {
        let tokens = &self.tokens;
        let mut aside = h_flex()
            .ml_auto()
            .flex_shrink_0()
            .items_center()
            .gap(px(6.0));
        for prop_badge in &prop.badges {
            let tone = match prop_badge {
                PropBadge::Shared => Some(Tone::Info),
                PropBadge::Always => Some(Tone::Success),
                PropBadge::Deferred => Some(Tone::Warning),
                _ => None,
            };
            aside = aside.child(badge(tokens, tone, prop_badge.label(), false));
        }
        if let Some(source) = &prop.source {
            let target = self
                .can_open_source()
                .then(|| format!("{}:{}", source.file, source.line));
            aside = aside.child(source_link(
                tokens,
                format!("prop.{}", prop.name),
                short_location(Some(&source.file), Some(source.line)).unwrap_or_default(),
                false,
                target,
                cx,
            ));
        }
        aside.into_any_element()
    }

    /// One prop in the tree. Objects and arrays fold open with a chevron.
    fn prop_node(
        &self,
        key: &str,
        name: &str,
        value: Option<&Value>,
        depth: usize,
        aside: Option<AnyElement>,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let tokens = &self.tokens;
        let muted = to_hsla(tokens.muted_foreground);
        let branch = matches!(value, Some(Value::Object(_) | Value::Array(_)));
        let entries: Vec<(String, Value)> = match value {
            Some(Value::Object(map)) => map.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
            Some(Value::Array(items)) => items
                .iter()
                .enumerate()
                .map(|(i, v)| (i.to_string(), v.clone()))
                .collect(),
            _ => Vec::new(),
        };
        let open = self.props_open.contains(key);
        let count = match value {
            Some(Value::Array(_)) => format!("[{}]", entries.len()),
            _ => format!("{{{}}}", entries.len()),
        };
        let foldable = branch && !entries.is_empty();

        let mut line = h_flex()
            .items_center()
            .gap(px(6.0))
            .pr(px(12.0))
            .py(px(if depth == 0 { 10.0 } else { 6.0 }))
            .font_family(MONO)
            .text_size(px(TEXT_PX));
        if foldable {
            let toggle_key = key.to_owned();
            line = line.child(
                h_flex()
                    .id(SharedString::from(format!("prop-{key}")))
                    .test_support()
                    .a11y_button(
                        format!("browser.laravel-toolbar.prop.{key}"),
                        format!("{} {name}", if open { "Collapse" } else { "Expand" }),
                    )
                    .items_center()
                    .gap(px(6.0))
                    .cursor_pointer()
                    .on_click(cx.listener(move |this, _: &ClickEvent, _window, cx| {
                        if !this.props_open.remove(&toggle_key) {
                            this.props_open.insert(toggle_key.clone());
                        }
                        cx.notify();
                    }))
                    .child(crate::icons::concept(
                        if open {
                            "superhero/chevron-down.svg"
                        } else {
                            "superhero/chevron-right.svg"
                        },
                        14.0,
                        muted,
                    ))
                    .child(name.to_owned()),
            );
        } else {
            line = line.child(div().size(px(14.0))).child(
                h_flex()
                    .child(name.to_owned())
                    .children((!branch).then(|| div().text_color(muted).child(":"))),
            );
        }
        line = if branch {
            line.child(div().text_color(muted).child(count))
        } else {
            line.child(self.scalar(value))
        };
        if let Some(aside) = aside {
            line = line.child(aside);
        }

        let mut node = div().flex().flex_col();
        if depth == 0 {
            node = node.border_b_1().border_color(to_hsla(tokens.border));
        }
        node = node.child(line);
        if foldable && open {
            let mut children = div()
                .flex()
                .flex_col()
                .mb(px(6.0))
                .ml(px(16.0))
                .pl(px(12.0))
                .border_l_1()
                .border_color(to_hsla(tokens.border));
            for (child_name, child) in entries {
                let child_key = format!("{key}.{child_name}");
                children = children.child(self.prop_node(
                    &child_key,
                    &child_name,
                    Some(&child),
                    depth + 1,
                    None,
                    cx,
                ));
            }
            node = node.child(children);
        }
        node.into_any_element()
    }

    fn scalar(&self, value: Option<&Value>) -> AnyElement {
        let tokens = &self.tokens;
        let (text, color) = match value {
            Some(Value::String(text)) => {
                (format!("\"{text}\""), to_hsla(tokens.success_foreground))
            }
            Some(Value::Number(number)) => (number.to_string(), to_hsla(tokens.info_foreground)),
            Some(Value::Bool(flag)) => (flag.to_string(), to_hsla(tokens.warning_foreground)),
            None => (
                "not loaded yet".to_owned(),
                to_hsla(tokens.muted_foreground),
            ),
            Some(_) => ("null".to_owned(), to_hsla(tokens.muted_foreground)),
        };
        div().text_color(color).child(text).into_any_element()
    }

    fn request_cookies_tab(
        &self,
        data: &model::ToolbarData,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let tokens = self.tokens.clone();
        let cookies: Vec<Value> = model::at(data, &["response", "cookies"])
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if cookies.is_empty() {
            return empty_row(&tokens, "cookies-empty", "The response set no cookies");
        }
        let text = |cookie: &Value, key: &str| {
            cookie
                .get(key)
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        };
        let flag =
            |cookie: &Value, key: &str| cookie.get(key).and_then(Value::as_bool).unwrap_or(false);
        let rows =
            sort_table_rows(
                &cookies,
                self.sorts.cookies.as_ref(),
                |cookie, column| match column {
                    "name" => text(cookie, "name").map(SortValue::Text),
                    "value" => text(cookie, "value").map(SortValue::Text),
                    "path" => Some(SortValue::Text(
                        text(cookie, "path").unwrap_or_else(|| "/".to_owned()),
                    )),
                    "sameSite" => text(cookie, "same_site").map(SortValue::Text),
                    _ => Some(SortValue::Text(
                        [
                            flag(cookie, "secure").then_some("Secure"),
                            flag(cookie, "http_only").then_some("HttpOnly"),
                        ]
                        .into_iter()
                        .flatten()
                        .collect::<Vec<_>>()
                        .join(" "),
                    )),
                },
            );
        let sort = self.sorts.cookies.clone();
        let sorter = |column: &'static str,
                      label: &'static str,
                      width: Width,
                      cx: &mut Context<'_, Self>| {
            sort_header(
                &tokens,
                "cookies",
                column,
                label,
                sort.as_ref(),
                width,
                Align::Left,
                move |this, _cx| {
                    this.sorts.cookies = next_table_sort(this.sorts.cookies.as_ref(), column);
                },
                cx,
            )
        };
        let head = vec![
            sorter("name", "Name", Width::Fixed(150.0), cx),
            sorter("value", "Value", Width::Flex, cx),
            sorter("path", "Path", Width::Fixed(64.0), cx),
            sorter("sameSite", "SameSite", Width::Fixed(80.0), cx),
            sorter("flags", "Flags", Width::Fixed(150.0), cx),
        ];
        let muted = to_hsla(tokens.muted_foreground);
        let mut list = div()
            .flex()
            .flex_col()
            .w_full()
            .child(head_row(&tokens, head));
        for cookie in rows {
            let name = text(&cookie, "name").unwrap_or_default();
            let flags = h_flex()
                .gap(px(4.0))
                .children(flag(&cookie, "secure").then(|| badge(&tokens, None, "Secure", false)))
                .children(
                    flag(&cookie, "http_only").then(|| badge(&tokens, None, "HttpOnly", false)),
                );
            list = list.child(
                body_row(
                    &tokens,
                    vec![
                        cell(
                            Width::Fixed(150.0),
                            Align::Left,
                            div().truncate().font_family(MONO).child(name.clone()),
                        ),
                        cell(
                            Width::Flex,
                            Align::Left,
                            div()
                                .truncate()
                                .font_family(MONO)
                                .text_color(muted)
                                .child(text(&cookie, "value").unwrap_or_default()),
                        ),
                        cell(
                            Width::Fixed(64.0),
                            Align::Left,
                            div()
                                .font_family(MONO)
                                .text_color(muted)
                                .child(text(&cookie, "path").unwrap_or_else(|| "/".to_owned())),
                        ),
                        cell(
                            Width::Fixed(80.0),
                            Align::Left,
                            div().text_color(muted).child(
                                text(&cookie, "same_site").unwrap_or_else(|| "–".to_owned()),
                            ),
                        ),
                        cell(Width::Fixed(150.0), Align::Left, flags),
                    ],
                )
                .id(SharedString::from(format!("cookie-{name}")))
                .test_support()
                .a11y_group(format!("browser.laravel-toolbar.cookie.{name}"), name),
            );
        }
        list.into_any_element()
    }
}
