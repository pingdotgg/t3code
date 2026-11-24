//! The Timings, Memory, Database, Models and Environment panels
//! (`apps/web/src/laravelToolbar/ui/panels.tsx`).

use conn_desktop::laravel_toolbar::layout::{SortValue, next_table_sort, sort_table_rows};
use conn_desktop::laravel_toolbar::model::{
    self, ToolbarData, error_reporting_label, format_bytes, format_count, format_ms, format_uptime,
    ini_switch, inline_bindings, php_limit, queries, short_location, stages, toolbar_models,
    wall_time_ms,
};
use conn_desktop::laravel_toolbar::sql::{SqlKind, sql_fragments};
use gpui_kit::component::h_flex;
use gpui_kit::prelude::*;
use gpui_kit::{
    AnyElement, ClickEvent, Context, FontWeight, IntoElement, SharedString, Window, div, px,
    relative,
};
use serde_json::Value;

use super::parts::{
    Align, MONO, SMALL_PX, TEXT_PX, Tone, Value as Cell, Width, badge, body_row, cell, css_color,
    empty_row, head_row, key_value_rows, row_marker, section, sort_header, source_link, stage_bar,
    stat, stat_strip, underline_tabs,
};
use super::{LaravelToolbar, PanelId};
use crate::a11y::ConnA11yExt as _;
use crate::panels::color::to_hsla;
use crate::theme::hsla_alpha;
use gpui_kit::TestSupportExt as _;

/// The Database panel's filter tabs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum QueryFilter {
    All,
    Duplicates,
    Slow,
}

/// The Environment panel's tabs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum EnvironmentTab {
    Framework,
    Php,
    Fpm,
}

/// PHP's memory_limit ("128M", "1G", "-1") in bytes; none when unlimited or unknown.
fn limit_bytes(limit: Option<&str>) -> Option<f64> {
    let limit = limit?.trim();
    let (digits, unit) = match limit.chars().last()? {
        c if c.is_ascii_digit() => (limit, 1.0),
        'K' | 'k' => (&limit[..limit.len() - 1], 1024.0),
        'M' | 'm' => (&limit[..limit.len() - 1], 1024.0 * 1024.0),
        'G' | 'g' => (&limit[..limit.len() - 1], 1024.0 * 1024.0 * 1024.0),
        _ => return None,
    };
    digits
        .parse::<f64>()
        .ok()
        .filter(|_| digits.chars().all(|c| c.is_ascii_digit()))
        .map(|n| n * unit)
}

fn text_or_dash(value: Option<String>) -> String {
    value.unwrap_or_else(|| "–".to_owned())
}

impl LaravelToolbar {
    fn selected_data(&self) -> Option<ToolbarData> {
        self.store
            .tab(&self.tab_key)
            .and_then(|tab| tab.shown_data().cloned())
    }

    fn loading_row(&self) -> AnyElement {
        empty_row(&self.tokens, "loading", "Loading request…")
    }

    /// One row of the Timings and Memory lists: a marker and label, a bar, a value and a share.
    #[expect(
        clippy::too_many_arguments,
        reason = "one row of a drawn list: every column is a value"
    )]
    fn waterfall_row(
        &self,
        key: &str,
        label: &str,
        color: gpui_kit::Hsla,
        left: f32,
        width: f32,
        value: String,
        value_color: gpui_kit::Hsla,
        value_width: f32,
        share: String,
    ) -> AnyElement {
        let tokens = &self.tokens;
        let hover = hsla_alpha(tokens.foreground, 0.04);
        h_flex()
            .id(SharedString::from(format!("waterfall-{key}-{label}")))
            .test_support()
            .a11y_group(
                format!("browser.laravel-toolbar.{key}.{label}"),
                format!("{label} {value}"),
            )
            .w_full()
            .items_center()
            .gap(px(12.0))
            .px(px(12.0))
            .py(px(12.0))
            .text_size(px(TEXT_PX))
            .border_b_1()
            .border_color(to_hsla(tokens.border))
            .hover(move |s| s.bg(hover))
            .child(
                h_flex()
                    .w(px(144.0))
                    .flex_shrink_0()
                    .items_center()
                    .gap(px(8.0))
                    .child(row_marker(color, 16.0))
                    .child(
                        div()
                            .truncate()
                            .font_weight(FontWeight::MEDIUM)
                            .child(label.to_owned()),
                    ),
            )
            .child(
                div().relative().h(px(4.0)).flex_1().child(
                    div()
                        .absolute()
                        .top_0()
                        .bottom_0()
                        .left(relative(left.clamp(0.0, 1.0)))
                        .w(relative(width.clamp(0.0, 1.0)))
                        .rounded_full()
                        .bg(color),
                ),
            )
            .child(
                div()
                    .w(px(value_width))
                    .flex_shrink_0()
                    .flex()
                    .justify_end()
                    .text_color(value_color)
                    .child(value),
            )
            .child(
                div()
                    .w(px(32.0))
                    .flex_shrink_0()
                    .flex()
                    .justify_end()
                    .text_color(to_hsla(tokens.muted_foreground))
                    .child(share),
            )
            .into_any_element()
    }

    fn stage_color(&self, css: &str) -> gpui_kit::Hsla {
        css_color(css).unwrap_or_else(|| to_hsla(self.tokens.muted_foreground))
    }

    // ─── Timings ────────────────────────────────────────────────────────────

    pub(super) fn render_timings_panel(
        &mut self,
        _window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let tokens = self.tokens.clone();
        let selected = self.selected_data();
        let total = selected.as_ref().map_or(0.0, wall_time_ms);
        let list = selected.as_ref().map(stages).unwrap_or_default();
        let actions = div()
            .text_size(px(TEXT_PX))
            .font_weight(FontWeight::MEDIUM)
            .child(format_ms(total))
            .into_any_element();
        let header = self.panel_header(
            "superhero/timer.svg",
            "Timings".to_owned(),
            None,
            Some(actions),
            false,
            cx,
        );
        let body = if selected.is_none() {
            self.loading_row()
        } else {
            let segments = list
                .iter()
                .map(|stage| {
                    (
                        self.stage_color(&stage.color),
                        if total > 0.0 {
                            (stage.duration_ms / total) as f32
                        } else {
                            0.0
                        },
                    )
                })
                .collect();
            let mut rows = div().flex().flex_col().w_full();
            for stage in &list {
                let color = self.stage_color(&stage.color);
                let (start, share) = if total > 0.0 {
                    (
                        (stage.start_ms / total) as f32,
                        (stage.duration_ms / total) as f32,
                    )
                } else {
                    (0.0, 0.0)
                };
                rows = rows.child(self.waterfall_row(
                    "timings",
                    &stage.label,
                    color,
                    start,
                    share.max(0.008),
                    format_ms(stage.duration_ms),
                    to_hsla(tokens.foreground),
                    64.0,
                    format!("{}%", (share * 100.0).round()),
                ));
            }
            div()
                .flex()
                .flex_col()
                .child(stage_bar(&tokens, segments))
                .child(rows)
                .into_any_element()
        };
        self.panel_shell(PanelId::Timings, header, false, body)
    }

    // ─── Memory ─────────────────────────────────────────────────────────────

    pub(super) fn render_memory_panel(
        &mut self,
        _window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let tokens = self.tokens.clone();
        let selected = self.selected_data();
        let list = selected.as_ref().map(stages).unwrap_or_default();
        let allocated = selected.as_ref().and_then(|d| {
            model::str_at(d, &["profiler", "total_allocated_memory", "formattedValue"])
                .map(ToOwned::to_owned)
        });
        let allocated_value = selected
            .as_ref()
            .and_then(|d| model::num_at(d, &["profiler", "total_allocated_memory", "value"]));
        let real = selected.as_ref().and_then(|d| {
            model::str_at(d, &["profiler", "total_real_memory", "formattedValue"])
                .map(ToOwned::to_owned)
        });
        let limit = selected
            .as_ref()
            .and_then(|d| model::str_at(d, &["php", "memory_limit"]).map(ToOwned::to_owned));
        let limit_value = limit_bytes(limit.as_deref());

        let growth: Vec<_> = list.iter().filter(|s| s.memory_bytes > 0.0).collect();
        let total_growth: f64 = growth.iter().map(|s| s.memory_bytes).sum();
        // Waterfall: each stage starts where memory stood after the stage before it.
        let mut steps = Vec::new();
        let mut at = 0.0_f64;
        for stage in &list {
            let from = at;
            at += stage.memory_bytes;
            steps.push((stage, from, at));
        }
        let low = steps.iter().map(|s| s.2).fold(0.0_f64, f64::min);
        let high = steps.iter().map(|s| s.2).fold(0.0_f64, f64::max);
        let span = if (high - low).abs() < f64::EPSILON {
            1.0
        } else {
            high - low
        };

        let muted = to_hsla(tokens.muted_foreground);
        let stat_pair = |label: &str, value: String, extra: Option<String>| {
            h_flex()
                .gap(px(4.0))
                .child(div().text_color(muted).child(label.to_owned()))
                .child(div().font_weight(FontWeight::MEDIUM).child(value))
                .children(extra.map(|extra| div().text_color(muted).child(extra)))
        };
        let actions = selected.as_ref().map(|_| {
            h_flex()
                .gap(px(16.0))
                .text_size(px(TEXT_PX))
                .child(stat_pair(
                    "Allocated",
                    text_or_dash(allocated.clone()),
                    None,
                ))
                .child(stat_pair("Real", text_or_dash(real.clone()), None))
                .children(limit.clone().map(|limit| {
                    let percent = limit_value
                        .zip(allocated_value)
                        .filter(|(_, used)| *used > 0.0)
                        .map(|(max, used)| format!("({:.1}%)", used / max * 100.0));
                    stat_pair("Limit", limit, percent)
                }))
                .into_any_element()
        });
        let header = self.panel_header(
            "superhero/memory.svg",
            "Memory".to_owned(),
            None,
            actions,
            false,
            cx,
        );
        let body = if selected.is_none() {
            self.loading_row()
        } else {
            let segments = growth
                .iter()
                .map(|s| {
                    (
                        self.stage_color(&s.color),
                        if total_growth > 0.0 {
                            (s.memory_bytes / total_growth) as f32
                        } else {
                            0.0
                        },
                    )
                })
                .collect();
            let mut rows = div().flex().flex_col().w_full();
            for (stage, from, to) in steps {
                let color = self.stage_color(&stage.color);
                let value_color = if stage.memory_bytes < 0.0 {
                    to_hsla(tokens.success_foreground)
                } else if stage.memory_bytes == 0.0 {
                    muted
                } else {
                    to_hsla(tokens.foreground)
                };
                let sign = if stage.memory_bytes > 0.0 { "+" } else { "" };
                let share = if stage.memory_bytes > 0.0 && total_growth > 0.0 {
                    format!("{}%", (stage.memory_bytes / total_growth * 100.0).round())
                } else {
                    "–".to_owned()
                };
                rows = rows.child(self.waterfall_row(
                    "memory",
                    &stage.label,
                    color,
                    ((from.min(to) - low) / span) as f32,
                    ((stage.memory_bytes.abs() / span) as f32).max(0.006),
                    format!("{sign}{}", format_bytes(stage.memory_bytes as i64)),
                    value_color,
                    80.0,
                    share,
                ));
            }
            div()
                .flex()
                .flex_col()
                .child(stage_bar(&tokens, segments))
                .child(rows)
                .into_any_element()
        };
        self.panel_shell(PanelId::Memory, header, false, body)
    }

    // ─── Database ───────────────────────────────────────────────────────────

    /// SQL with keywords muted, identifiers plain, strings green and numbers blue.
    fn sql_text(&self, sql: &str) -> AnyElement {
        let tokens = &self.tokens;
        let mut line = h_flex()
            .overflow_hidden()
            .whitespace_nowrap()
            .font_family(MONO)
            .text_size(px(TEXT_PX))
            .text_color(hsla_alpha(tokens.foreground, 0.8));
        for (kind, text) in sql_fragments(sql) {
            let color = match kind {
                SqlKind::Plain => None,
                SqlKind::String => Some(to_hsla(tokens.success_foreground)),
                SqlKind::Identifier => Some(to_hsla(tokens.foreground)),
                SqlKind::Number => Some(to_hsla(tokens.info_foreground)),
                SqlKind::Keyword => Some(to_hsla(tokens.muted_foreground)),
            };
            line = line.child(match color {
                Some(color) => div().text_color(color).child(text),
                None => div().child(text),
            });
        }
        line.into_any_element()
    }

    pub(super) fn render_database_panel(
        &mut self,
        _window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let tokens = self.tokens.clone();
        let selected = self.selected_data();
        let all = selected.as_ref().map(queries).unwrap_or_default();
        let recorded: f64 = all.iter().map(|q| q.duration_ms).sum();
        let duplicate_count = all.iter().filter(|q| q.is_duplicate).count();
        let slow_count = all.iter().filter(|q| q.is_slow).count();
        let filter = self.query_filter;
        let filtered: Vec<_> = all
            .iter()
            .filter(|q| match filter {
                QueryFilter::All => true,
                QueryFilter::Duplicates => q.is_duplicate,
                QueryFilter::Slow => q.is_slow,
            })
            .cloned()
            .collect();
        let visible = sort_table_rows(&filtered, self.sorts.queries.as_ref(), |q, column| {
            Some(if column == "duration" {
                SortValue::Number(q.duration_ms)
            } else {
                SortValue::Text(q.sql.clone())
            })
        });
        let duplicates = visible.iter().filter(|q| q.is_duplicate).count();
        let slow = visible.iter().filter(|q| q.is_slow).count();
        let total_time: f64 = visible.iter().map(|q| q.duration_ms).sum();
        let wall = selected.as_ref().map_or(0.0, wall_time_ms);
        let database = selected
            .as_ref()
            .and_then(|d| model::at(d, &["queries", "databases"]))
            .and_then(Value::as_array)
            .and_then(|list| list.first())
            .cloned();
        let driver = database
            .as_ref()
            .and_then(|d| d.get("driver"))
            .and_then(Value::as_str)
            .map(ToOwned::to_owned);
        let name = database
            .as_ref()
            .and_then(|d| d.get("name"))
            .and_then(Value::as_str)
            .map(ToOwned::to_owned);
        let muted = to_hsla(tokens.muted_foreground);
        let meta = (driver.is_some() || name.is_some()).then(|| {
            h_flex()
                .gap(px(8.0))
                .items_center()
                .children(driver.clone().map(|d| div().child(d)))
                .children((driver.is_some() && name.is_some()).then(|| {
                    div()
                        .size(px(2.0))
                        .rounded_full()
                        .bg(hsla_alpha(tokens.muted_foreground, 0.6))
                }))
                .children(name.clone().map(|n| {
                    div()
                        .font_family(MONO)
                        .text_color(to_hsla(tokens.foreground))
                        .child(n)
                }))
                .into_any_element()
        });
        let header = self.panel_header(
            "superhero/database.svg",
            "Queries".to_owned(),
            meta,
            None,
            true,
            cx,
        );
        let tabs = underline_tabs(
            &tokens,
            "database",
            filter,
            vec![
                (QueryFilter::All, "all", "All".to_owned()),
                (
                    QueryFilter::Duplicates,
                    "duplicates",
                    format!("Duplicates {duplicate_count}"),
                ),
                (QueryFilter::Slow, "slow", format!("Slow {slow_count}")),
            ],
            |this, filter, _cx| this.query_filter = filter,
            cx,
        );

        let content = if selected.is_none() {
            self.loading_row()
        } else {
            let stats = stat_strip(
                &tokens,
                vec![
                    stat(
                        &tokens,
                        "queries",
                        "Queries",
                        format_count(visible.len() as f64),
                        None,
                        Tone::Default,
                    ),
                    stat(
                        &tokens,
                        "query-time",
                        "Query time",
                        format_ms(total_time),
                        (wall > 0.0).then(|| {
                            format!("{}% of the request", (total_time / wall * 100.0).round())
                        }),
                        Tone::Default,
                    ),
                    stat(
                        &tokens,
                        "duplicates",
                        "Duplicates",
                        duplicates.to_string(),
                        Some("Same SQL and bindings".to_owned()),
                        if duplicates > 0 {
                            Tone::Warning
                        } else {
                            Tone::Default
                        },
                    ),
                    stat(
                        &tokens,
                        "slow",
                        "Slow",
                        slow.to_string(),
                        None,
                        Tone::Default,
                    ),
                ],
            );
            let table = if visible.is_empty() {
                empty_row(
                    &tokens,
                    "queries-empty",
                    if all.is_empty() {
                        "No queries in this request"
                    } else {
                        "No queries match"
                    },
                )
            } else {
                let sort = self.sorts.queries.clone();
                let sorter = |column: &'static str,
                              label: &'static str,
                              width: Width,
                              align: Align,
                              cx: &mut Context<'_, Self>| {
                    sort_header(
                        &tokens,
                        "queries",
                        column,
                        label,
                        sort.as_ref(),
                        width,
                        align,
                        move |this, _cx| {
                            this.sorts.queries =
                                next_table_sort(this.sorts.queries.as_ref(), column);
                        },
                        cx,
                    )
                };
                let head = vec![
                    sorter("query", "Query", Width::Flex, Align::Left, cx),
                    sorter(
                        "duration",
                        "Duration",
                        Width::Fixed(112.0),
                        Align::Right,
                        cx,
                    ),
                ];
                let mut list = div()
                    .flex()
                    .flex_col()
                    .w_full()
                    .child(head_row(&tokens, head));
                let can_open = self.can_open_source();
                let hover = hsla_alpha(tokens.foreground, 0.04);
                for (index, query) in visible.iter().enumerate() {
                    let marker = if query.is_slow {
                        to_hsla(tokens.info)
                    } else if query.is_duplicate {
                        to_hsla(tokens.warning)
                    } else {
                        hsla_alpha(tokens.muted_foreground, 0.3)
                    };
                    let location = short_location(query.file.as_deref(), query.line);
                    let mut meta_line = h_flex()
                        .items_center()
                        .gap(px(8.0))
                        .mt(px(2.0))
                        .text_size(px(SMALL_PX))
                        .text_color(muted);
                    if let Some(location) = location {
                        let target = (can_open && query.file.is_some()).then(|| {
                            format!(
                                "{}:{}",
                                query.file.clone().unwrap_or_default(),
                                query.line.unwrap_or(1)
                            )
                        });
                        meta_line = meta_line.child(source_link(
                            &tokens,
                            format!("query.{index}"),
                            location,
                            true,
                            target,
                            cx,
                        ));
                    }
                    let sql_for_db = inline_bindings(&query.sql, &query.bindings);
                    meta_line = meta_line.child(
                        div()
                            .id(SharedString::from(format!("open-query-{index}")))
                            .test_support()
                            .a11y_button(
                                format!("browser.laravel-toolbar.query.{index}.open"),
                                "Open in Database",
                            )
                            .cursor_pointer()
                            .underline()
                            .font_family(MONO)
                            .text_color(hsla_alpha(tokens.foreground, 0.8))
                            .child("Open in Database")
                            .on_click(cx.listener(move |this, _: &ClickEvent, _window, cx| {
                                this.open_query(sql_for_db.clone(), cx);
                            })),
                    );
                    if query.is_duplicate {
                        meta_line = meta_line.child(badge(
                            &tokens,
                            Some(Tone::Warning),
                            "Duplicate",
                            false,
                        ));
                    }
                    if query.is_slow {
                        meta_line =
                            meta_line.child(badge(&tokens, Some(Tone::Info), "Slow", false));
                    }
                    let row = div()
                        .id(SharedString::from(format!("query-{index}")))
                        .test_support()
                        .a11y_group(format!("browser.laravel-toolbar.query.{index}"), query.sql.clone())
                        .relative()
                        .flex()
                        .flex_row()
                        .w_full()
                        .items_center()
                        .border_b_1()
                        .border_color(to_hsla(tokens.border))
                        .text_size(px(TEXT_PX))
                        .hover(move |s| s.bg(hover))
                        .child(
                            h_flex()
                                .flex_1()
                                .min_w_0()
                                .items_center()
                                .gap(px(8.0))
                                .px(px(12.0))
                                .py(px(10.0))
                                .child(row_marker(marker, 32.0))
                                .child(
                                    div()
                                        .flex()
                                        .flex_col()
                                        .flex_1()
                                        .min_w_0()
                                        .child(self.sql_text(&query.sql))
                                        .child(meta_line),
                                ),
                        )
                        .child(
                            div()
                                .w(px(112.0))
                                .flex_shrink_0()
                                .px(px(12.0))
                                .py(px(10.0))
                                .flex()
                                .flex_col()
                                .items_end()
                                .font_family(MONO)
                                .child(format_ms(query.duration_ms))
                                .child(
                                    div()
                                        .text_size(px(SMALL_PX))
                                        .text_color(muted)
                                        .child(format!("+{}", format_ms(query.offset * recorded))),
                                ),
                        )
                        // Position within the cumulative recorded query time, drawn on the
                        // row's divider.
                        .child(
                            div()
                                .absolute()
                                .left(px(12.0))
                                .right(px(12.0))
                                .bottom(px(-1.0))
                                .h(px(1.0))
                                .child(
                                    div()
                                        .absolute()
                                        .top_0()
                                        .bottom_0()
                                        .left(relative(query.offset.clamp(0.0, 1.0) as f32))
                                        .w(relative((query.share as f32).clamp(0.004, 1.0)))
                                        .bg(hsla_alpha(tokens.primary, 0.6)),
                                ),
                        );
                    list = list.child(row);
                }
                list.into_any_element()
            };
            div()
                .flex()
                .flex_col()
                .child(stats)
                .child(table)
                .into_any_element()
        };
        let scroller = div()
            .id("laravel-toolbar-database-scroll")
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .child(content);
        let flush = div()
            .flex()
            .flex_col()
            .size_full()
            .min_h_0()
            .child(tabs)
            .child(scroller)
            .into_any_element();
        self.panel_shell(PanelId::Database, header, true, flush)
    }

    // ─── Models ─────────────────────────────────────────────────────────────

    pub(super) fn render_models_panel(
        &mut self,
        _window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let tokens = self.tokens.clone();
        let selected = self.selected_data();
        let all = selected.as_ref().map(toolbar_models).unwrap_or_default();
        let short = |fqcn: &str| fqcn.rsplit('\\').next().unwrap_or(fqcn).to_owned();
        let models = sort_table_rows(&all, self.sorts.models.as_ref(), |m, column| {
            Some(match column {
                "model" => SortValue::Text(short(&m.model)),
                "retrieved" => SortValue::Number(m.retrieved.unwrap_or(0) as f64),
                "created" => SortValue::Number(m.created.unwrap_or(0) as f64),
                "updated" => SortValue::Number(m.updated.unwrap_or(0) as f64),
                _ => SortValue::Number(m.deleted.unwrap_or(0) as f64),
            })
        });
        let total: i64 = models.iter().map(|m| m.retrieved.unwrap_or(0)).sum();
        let max = models
            .iter()
            .map(|m| m.retrieved.unwrap_or(0))
            .max()
            .unwrap_or(1)
            .max(1);
        let muted = to_hsla(tokens.muted_foreground);
        let actions = (!models.is_empty()).then(|| {
            h_flex()
                .items_center()
                .gap(px(8.0))
                .text_size(px(TEXT_PX))
                .text_color(muted)
                .child(format!("{total} retrieved"))
                .child(
                    div()
                        .size(px(2.0))
                        .rounded_full()
                        .bg(hsla_alpha(tokens.muted_foreground, 0.6)),
                )
                .child(format!("{} models", format_count(models.len() as f64)))
                .into_any_element()
        });
        let header = self.panel_header(
            "superhero/package.svg",
            "Models".to_owned(),
            None,
            actions,
            false,
            cx,
        );
        let body = if selected.is_none() {
            self.loading_row()
        } else if models.is_empty() {
            empty_row(
                &tokens,
                "models-empty",
                "No model events recorded. Model tracking needs Laravel Telescope.",
            )
        } else {
            let sort = self.sorts.models.clone();
            let sorter = |column: &'static str,
                          label: &'static str,
                          width: Width,
                          align: Align,
                          cx: &mut Context<'_, Self>| {
                sort_header(
                    &tokens,
                    "models",
                    column,
                    label,
                    sort.as_ref(),
                    width,
                    align,
                    move |this, _cx| {
                        this.sorts.models = next_table_sort(this.sorts.models.as_ref(), column);
                    },
                    cx,
                )
            };
            let head = vec![
                sorter("model", "Model", Width::Flex, Align::Left, cx),
                sorter(
                    "retrieved",
                    "Retrieved",
                    Width::Fixed(220.0),
                    Align::Left,
                    cx,
                ),
                sorter("created", "Created", Width::Fixed(80.0), Align::Right, cx),
                sorter("updated", "Updated", Width::Fixed(80.0), Align::Right, cx),
                sorter("deleted", "Deleted", Width::Fixed(80.0), Align::Right, cx),
            ];
            let mut list = div()
                .flex()
                .flex_col()
                .w_full()
                .child(head_row(&tokens, head));
            let count_cell = |count: Option<i64>| {
                let text = count
                    .filter(|c| *c != 0)
                    .map_or_else(|| "–".to_owned(), |c| format_count(c as f64));
                cell(
                    Width::Fixed(80.0),
                    Align::Right,
                    div()
                        .text_color(if count.unwrap_or(0) == 0 {
                            muted
                        } else {
                            to_hsla(tokens.foreground)
                        })
                        .child(text),
                )
            };
            for model in &models {
                let retrieved = model.retrieved.unwrap_or(0);
                let row = body_row(
                    &tokens,
                    vec![
                        cell(
                            Width::Flex,
                            Align::Left,
                            div()
                                .flex()
                                .flex_col()
                                .min_w_0()
                                .child(
                                    div()
                                        .truncate()
                                        .font_weight(FontWeight::MEDIUM)
                                        .child(short(&model.model)),
                                )
                                .child(
                                    div()
                                        .truncate()
                                        .font_family(MONO)
                                        .text_size(px(SMALL_PX))
                                        .text_color(muted)
                                        .child(model.model.clone()),
                                ),
                        ),
                        cell(
                            Width::Fixed(220.0),
                            Align::Left,
                            h_flex()
                                .w_full()
                                .items_center()
                                .gap(px(12.0))
                                .child(
                                    div()
                                        .w(px(24.0))
                                        .flex()
                                        .justify_end()
                                        .child(format_count(retrieved as f64)),
                                )
                                .child(
                                    div().relative().h(px(4.0)).flex_1().child(
                                        div()
                                            .absolute()
                                            .top_0()
                                            .bottom_0()
                                            .left_0()
                                            .w(relative(
                                                (retrieved as f32 / max as f32).clamp(0.0, 1.0),
                                            ))
                                            .rounded_full()
                                            .bg(hsla_alpha(tokens.primary, 0.7)),
                                    ),
                                ),
                        ),
                        count_cell(model.created),
                        count_cell(model.updated),
                        count_cell(model.deleted),
                    ],
                )
                .id(SharedString::from(format!("model-{}", model.model)))
                .test_support()
                .a11y_group(
                    format!("browser.laravel-toolbar.model.{}", model.model),
                    short(&model.model),
                );
                list = list.child(row);
            }
            list.into_any_element()
        };
        self.panel_shell(PanelId::Models, header, false, body)
    }

    // ─── Framework & PHP ────────────────────────────────────────────────────

    pub(super) fn render_environment_panel(
        &mut self,
        _window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let tokens = self.tokens.clone();
        let selected = self.selected_data();
        let app = model::framework(selected.as_ref());
        let php = selected
            .as_ref()
            .and_then(|d| d.get("php"))
            .and_then(Value::as_object)
            .cloned();
        let fpm = php
            .as_ref()
            .and_then(|p| p.get("fpm"))
            .filter(|f| f.is_object())
            .cloned();
        let tab = if self.env_tab == EnvironmentTab::Fpm && fpm.is_none() {
            EnvironmentTab::Framework
        } else {
            self.env_tab
        };
        let actions = app.host.clone().map(|host| {
            div()
                .text_size(px(TEXT_PX))
                .text_color(to_hsla(tokens.muted_foreground))
                .child(host)
                .into_any_element()
        });
        let header = self.panel_header(
            "superhero/server.svg",
            format!("{} & PHP", app.name),
            None,
            actions,
            true,
            cx,
        );
        let mut tab_list = vec![
            (EnvironmentTab::Framework, "framework", app.name.clone()),
            (EnvironmentTab::Php, "php", "PHP".to_owned()),
        ];
        if fpm.is_some() {
            tab_list.push((EnvironmentTab::Fpm, "fpm", "PHP-FPM".to_owned()));
        }
        let tabs = underline_tabs(
            &tokens,
            "environment",
            tab,
            tab_list,
            |this, tab, _cx| this.env_tab = tab,
            cx,
        );
        let content = match (&selected, tab) {
            (None, _) => self.loading_row(),
            (Some(data), EnvironmentTab::Framework) => self.framework_tab(data, &app),
            (Some(_), EnvironmentTab::Php) => match &php {
                Some(php) => self.php_tab(php),
                None => empty_row(&tokens, "php-empty", "No PHP details in this request"),
            },
            (Some(_), EnvironmentTab::Fpm) => match fpm.as_ref().and_then(Value::as_object) {
                Some(fpm) => self.fpm_tab(fpm),
                None => empty_row(&tokens, "fpm-empty", "No PHP details in this request"),
            },
        };
        let scroller = div()
            .id("laravel-toolbar-environment-scroll")
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .child(div().flex().flex_col().min_h(px(0.0)).child(content));
        let flush = div()
            .flex()
            .flex_col()
            .size_full()
            .min_h_0()
            .child(tabs)
            .child(scroller)
            .into_any_element();
        self.panel_shell(PanelId::Environment, header, true, flush)
    }

    fn framework_tab(&self, data: &ToolbarData, app: &model::Framework) -> AnyElement {
        let tokens = &self.tokens;
        let debug = matches!(app.debug.as_deref(), Some("true" | "1"));
        let mut stats = vec![
            stat(
                tokens,
                "version",
                &app.name,
                app.version.clone().unwrap_or_else(|| "–".to_owned()),
                None,
                Tone::Default,
            ),
            stat(
                tokens,
                "environment",
                "Environment",
                app.environment.clone().unwrap_or_else(|| "–".to_owned()),
                Some("APP_ENV".to_owned()),
                Tone::Default,
            ),
            stat(
                tokens,
                "debug",
                "Debug",
                if debug { "On" } else { "Off" }.to_owned(),
                Some("APP_DEBUG".to_owned()),
                if debug { Tone::Warning } else { Tone::Default },
            ),
        ];
        if app.is_laravel {
            stats.push(stat(
                tokens,
                "inertia",
                "Inertia",
                text_or_dash(model::str_at(data, &["inertia", "version"]).map(ToOwned::to_owned)),
                Some("Client".to_owned()),
                Tone::Default,
            ));
        }
        let mut rows = Vec::new();
        if app.is_laravel {
            rows.push((
                "Timezone".to_owned(),
                Cell::Text(text_or_dash(app.timezone.clone())),
            ));
            rows.push((
                "Locale".to_owned(),
                Cell::Text(text_or_dash(app.locale.clone())),
            ));
        }
        rows.push((
            "Host".to_owned(),
            Cell::Mono(text_or_dash(app.host.clone())),
        ));
        div()
            .flex()
            .flex_col()
            .child(stat_strip(tokens, stats))
            .child(key_value_rows(tokens, "framework", rows, false))
            .into_any_element()
    }

    /// Two titled columns of rows; the divider runs to the bottom of the panel.
    fn row_columns(&self, left: AnyElement, right: AnyElement) -> AnyElement {
        h_flex()
            .flex_1()
            .w_full()
            .child(div().flex_1().min_w_0().child(left))
            .child(
                div()
                    .w(px(1.0))
                    .flex_shrink_0()
                    .bg(to_hsla(self.tokens.border)),
            )
            .child(div().flex_1().min_w_0().child(right))
            .into_any_element()
    }

    fn php_tab(&self, php: &serde_json::Map<String, Value>) -> AnyElement {
        let tokens = &self.tokens;
        let text = |key: &str| {
            php.get(key).and_then(|v| match v {
                Value::String(s) => Some(s.clone()),
                Value::Number(n) => Some(n.to_string()),
                _ => None,
            })
        };
        let settings = php.get("settings").and_then(Value::as_object);
        let setting = |name: &str| {
            settings.and_then(|s| s.get(name)).and_then(|v| match v {
                Value::String(s) => Some(s.clone()),
                Value::Number(n) => Some(n.to_string()),
                Value::Bool(b) => Some(b.to_string()),
                _ => None,
            })
        };
        let dash_setting = |name: &str| text_or_dash(setting(name));
        let opcache = php.get("opcache").and_then(Value::as_object);
        let opcache_enabled = opcache
            .and_then(|o| o.get("enabled"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let hit_rate = opcache
            .and_then(|o| o.get("hit_rate"))
            .and_then(Value::as_f64);
        let used = opcache
            .and_then(|o| o.get("memory_used"))
            .and_then(Value::as_f64);
        let free = opcache
            .and_then(|o| o.get("memory_free"))
            .and_then(Value::as_f64);
        let opcache_total = used.zip(free).map(|(u, f)| u + f);
        let opcache_value = match (opcache, opcache_enabled, hit_rate) {
            (Some(_), true, Some(rate)) => format!("{}%", format_rate(rate)),
            (Some(_), true, None) => "On".to_owned(),
            (Some(_), false, _) => "Off".to_owned(),
            (None, _, _) => "–".to_owned(),
        };
        let stats = stat_strip(
            tokens,
            vec![
                stat(
                    tokens,
                    "php",
                    "PHP",
                    text_or_dash(text("version")),
                    Some(text("sapi").unwrap_or_else(|| "Runtime".to_owned())),
                    Tone::Default,
                ),
                stat(
                    tokens,
                    "memory-limit",
                    "Memory limit",
                    php_limit(text("memory_limit").as_deref(), ""),
                    Some("Per request".to_owned()),
                    Tone::Default,
                ),
                stat(
                    tokens,
                    "max-execution",
                    "Max execution",
                    php_limit(text("max_execution_time").as_deref(), "s"),
                    Some("Per request".to_owned()),
                    Tone::Default,
                ),
                stat(
                    tokens,
                    "opcache",
                    "OPcache",
                    opcache_value,
                    Some(
                        if opcache_enabled {
                            "Hit rate"
                        } else {
                            "Not loaded"
                        }
                        .to_owned(),
                    ),
                    if opcache.is_some() && !opcache_enabled {
                        Tone::Warning
                    } else {
                        Tone::Default
                    },
                ),
            ],
        );
        let version = text("version");
        let requests = vec![
            (
                "Post max size".to_owned(),
                Cell::Text(dash_setting("post_max_size")),
            ),
            (
                "Upload max filesize".to_owned(),
                Cell::Text(dash_setting("upload_max_filesize")),
            ),
            (
                "Max file uploads".to_owned(),
                Cell::Text(dash_setting("max_file_uploads")),
            ),
            (
                "Max input vars".to_owned(),
                Cell::Text(dash_setting("max_input_vars")),
            ),
            (
                "Max input time".to_owned(),
                Cell::Text(php_limit(setting("max_input_time").as_deref(), "s")),
            ),
            (
                "Socket timeout".to_owned(),
                Cell::Text(
                    setting("default_socket_timeout")
                        .filter(|v| !v.is_empty())
                        .map_or_else(|| "–".to_owned(), |v| format!("{v}s")),
                ),
            ),
        ];
        let errors = vec![
            (
                "Display errors".to_owned(),
                Cell::Text(ini_switch(setting("display_errors").as_deref()).to_owned()),
            ),
            (
                "Error reporting".to_owned(),
                Cell::Mono(error_reporting_label(
                    setting("error_reporting").as_deref(),
                    version.as_deref(),
                )),
            ),
            (
                "Log errors".to_owned(),
                Cell::Text(ini_switch(setting("log_errors").as_deref()).to_owned()),
            ),
            (
                "OPcache memory".to_owned(),
                Cell::Text(match (used, opcache_total) {
                    (Some(used), Some(total)) => format!(
                        "{} of {}",
                        format_bytes(used as i64),
                        format_bytes(total as i64)
                    ),
                    _ => "–".to_owned(),
                }),
            ),
            (
                "Validate timestamps".to_owned(),
                Cell::Text(
                    ini_switch(setting("opcache.validate_timestamps").as_deref()).to_owned(),
                ),
            ),
            ("JIT".to_owned(), Cell::Text(dash_setting("opcache.jit"))),
        ];
        let columns = self.row_columns(
            section(
                tokens,
                "requests-uploads",
                Some("Requests and uploads"),
                None,
                false,
                key_value_rows(tokens, "php-requests", requests, false),
            ),
            section(
                tokens,
                "errors-opcache",
                Some("Errors and OPcache"),
                None,
                false,
                key_value_rows(tokens, "php-errors", errors, false),
            ),
        );
        let extensions: Vec<String> = php
            .get("extensions")
            .and_then(Value::as_array)
            .map(|list| {
                list.iter()
                    .filter_map(|v| v.as_str().map(ToOwned::to_owned))
                    .collect()
            })
            .unwrap_or_default();
        let mut out = div().flex().flex_col().child(stats).child(columns);
        if !extensions.is_empty() {
            let mut wrap = h_flex().flex_wrap().gap(px(6.0));
            for extension in &extensions {
                wrap = wrap.child(badge(tokens, None, extension, true));
            }
            out = out.child(section(
                tokens,
                "extensions",
                Some("Extensions"),
                Some(format!("{} loaded", extensions.len())),
                true,
                wrap.into_any_element(),
            ));
        }
        out.into_any_element()
    }

    fn fpm_tab(&self, fpm: &serde_json::Map<String, Value>) -> AnyElement {
        let tokens = &self.tokens;
        let number = |key: &str| fpm.get(key).and_then(Value::as_f64);
        let count = |key: &str| number(key).map_or_else(|| "–".to_owned(), format_count);
        let pool = fpm.get("settings").and_then(Value::as_object);
        let pool_value = |key: &str| {
            pool.and_then(|p| p.get(key)).and_then(|v| match v {
                Value::String(s) if !s.is_empty() => Some(s.clone()),
                Value::Number(n) => Some(n.to_string()),
                _ => None,
            })
        };
        let max_children = pool_value("pm.max_children");
        let reached = number("max_children_reached").unwrap_or(0.0);
        let queue = number("listen_queue").unwrap_or(0.0);
        let stats = stat_strip(
            tokens,
            vec![
                stat(
                    tokens,
                    "active",
                    "Active workers",
                    count("active_processes"),
                    Some(
                        max_children
                            .as_ref()
                            .map_or_else(|| "Now".to_owned(), |m| format!("of {m} max children")),
                    ),
                    Tone::Default,
                ),
                stat(
                    tokens,
                    "idle",
                    "Idle workers",
                    count("idle_processes"),
                    Some("Now".to_owned()),
                    Tone::Default,
                ),
                stat(
                    tokens,
                    "queue",
                    "Listen queue",
                    count("listen_queue"),
                    Some(format!("Peak {}", count("max_listen_queue"))),
                    if queue > 0.0 {
                        Tone::Warning
                    } else {
                        Tone::Default
                    },
                ),
                stat(
                    tokens,
                    "reached",
                    "Max children reached",
                    format_count(reached),
                    Some("Since start".to_owned()),
                    if reached > 0.0 {
                        Tone::Warning
                    } else {
                        Tone::Default
                    },
                ),
            ],
        );
        // Settings the pool file leaves out do not apply to its process manager, so they are
        // left out here too.
        let dash = |v: Option<String>| v.unwrap_or_else(|| "–".to_owned());
        let spare = match (
            pool_value("pm.min_spare_servers"),
            pool_value("pm.max_spare_servers"),
        ) {
            (None, None) => "–".to_owned(),
            (min, max) => format!("{} to {}", dash(min), dash(max)),
        };
        let candidates: Vec<(&str, Cell)> = vec![
            (
                "Name",
                Cell::Mono(dash(
                    fpm.get("pool")
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned),
                )),
            ),
            (
                "Process manager",
                Cell::Text(dash(pool_value("pm").or_else(|| {
                    fpm.get("process_manager")
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned)
                }))),
            ),
            ("Max children", Cell::Text(dash(max_children))),
            (
                "Start servers",
                Cell::Text(dash(pool_value("pm.start_servers"))),
            ),
            ("Spare servers", Cell::Text(spare)),
            (
                "Max requests",
                Cell::Text(dash(pool_value("pm.max_requests"))),
            ),
            (
                "Idle timeout",
                Cell::Text(dash(pool_value("pm.process_idle_timeout"))),
            ),
            (
                "Terminate timeout",
                Cell::Text(dash(pool_value("request_terminate_timeout"))),
            ),
            (
                "Slowlog timeout",
                Cell::Text(dash(pool_value("request_slowlog_timeout"))),
            ),
            ("Listen", Cell::Mono(dash(pool_value("listen")))),
        ];
        let pool_rows: Vec<(String, Cell)> = candidates
            .into_iter()
            .filter(|(key, value)| {
                let empty = matches!(value, Cell::Text(t) | Cell::Mono(t) if t == "–");
                !empty || *key == "Name" || *key == "Process manager"
            })
            .map(|(key, value)| (key.to_owned(), value))
            .collect();
        let since = vec![
            (
                "Uptime".to_owned(),
                Cell::Text(format_uptime(number("start_since"))),
            ),
            (
                "Accepted connections".to_owned(),
                Cell::Text(count("accepted_conn")),
            ),
            (
                "Max active workers".to_owned(),
                Cell::Text(count("max_active_processes")),
            ),
            (
                "Total workers".to_owned(),
                Cell::Text(count("total_processes")),
            ),
            (
                "Slow requests".to_owned(),
                Cell::Text(count("slow_requests")),
            ),
        ];
        let columns = self.row_columns(
            section(
                tokens,
                "pool",
                Some("Pool"),
                None,
                false,
                key_value_rows(tokens, "fpm-pool", pool_rows, false),
            ),
            section(
                tokens,
                "since-start",
                Some("Since start"),
                None,
                false,
                key_value_rows(tokens, "fpm-since", since, false),
            ),
        );
        div()
            .flex()
            .flex_col()
            .child(stats)
            .child(columns)
            .into_any_element()
    }
}

fn format_rate(rate: f64) -> String {
    if (rate.fract()).abs() < f64::EPSILON {
        format!("{rate:.0}")
    } else {
        rate.to_string()
    }
}
