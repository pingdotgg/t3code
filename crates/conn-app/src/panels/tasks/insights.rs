//! The board's 2-row insights strip and expandable per-metric detail chart.
//!
//! Port of `apps/web/src/orbit/tasks/TasksInsights.tsx`.

use std::cell::Cell;
use std::rc::Rc;

use conn_desktop::orbit::insights::{
    ChangeTone, INSIGHTS, InsightId, InsightResult, InsightSpec, format_insight_value,
    insight_by_provider, insight_change_text, insight_change_tone, insight_change_trend,
    insight_result, insight_trend,
};
use conn_desktop::orbit::tasks::{InsightsPeriod, TaskInsights};
use conn_theme::Tokens;
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::*;
use gpui_kit::{
    AnyElement, App, Bounds, FontWeight, Pixels, ScrollHandle, SharedString, Window, div,
    linear_color_stop, linear_gradient, px,
};

use super::charts::{render_sparkline, render_trend_chart};
use super::format::{TasksSurfaceColors, insight_block_corners, insight_grid_layout, insight_hint};
use crate::panels::chrome::{self, ConnTooltipExt as _, UI_LINE_HEIGHT_PX, UI_TEXT_PX};
use crate::panels::color::to_hsla;
use crate::panels::header::superhero_icon;

/// Minimum width of each insight card (130px lets all 4 columns fit a standard right panel
/// without clipping while still enabling horizontal scrolling on narrower splits).
const CARD_MIN_WIDTH_PX: f32 = 130.0;
/// Gap between insight cards (`gap-0.5` = 2px).
const GRID_GAP_PX: f32 = 2.0;
/// Outer corner radius of the insights group (`12px`, matching lanes).
const GROUP_RADIUS_PX: f32 = 12.0;
/// Value font size (`text-lg leading-6` = 18px / 24px).
const VALUE_FONT_PX: f32 = 18.0;
const VALUE_LINE_HEIGHT_PX: f32 = 24.0;
/// Height of the expanded insight chart card (matches a 2-row strip so the board stays put).
const EXPANDED_HEIGHT_PX: f32 = 216.0;
/// Width of the horizontal edge fade overlays (`w-8` = 32px).
const EDGE_FADE_WIDTH_PX: f32 = 32.0;

/// Callbacks for user interactions inside the insights strip.
pub(super) struct InsightsCallbacks {
    pub(super) on_expand: Rc<dyn Fn(Option<InsightId>, &mut Window, &mut App)>,
    pub(super) on_hover_chart: Rc<dyn Fn(Option<usize>, &mut Window, &mut App)>,
}

/// Renders the insights strip, or `None` when every insight is hidden in settings.
#[expect(
    clippy::too_many_arguments,
    reason = "view render function receiving read-only panel state slices"
)]
pub(super) fn render_insights_strip(
    tokens: &Tokens,
    insights: Option<&TaskInsights>,
    period: InsightsPeriod,
    searching: bool,
    hidden: &[InsightId],
    expanded: Option<InsightId>,
    chart_hover: Option<usize>,
    chart_bounds: Rc<Cell<Bounds<Pixels>>>,
    scroll: &ScrollHandle,
    callbacks: InsightsCallbacks,
) -> Option<AnyElement> {
    let shown: Vec<InsightSpec> = INSIGHTS
        .iter()
        .copied()
        .filter(|spec| !hidden.contains(&spec.id))
        .collect();
    if shown.is_empty() {
        return None;
    }

    let surface = TasksSurfaceColors::from_tokens(tokens);

    if let Some(open_spec) = expanded.and_then(|id| shown.iter().copied().find(|s| s.id == id)) {
        let result = insight_result(insights, open_spec.id);
        return Some(
            div()
                .w_full()
                .flex_shrink_0()
                .px(px(8.0))
                .child(render_insight_detail(
                    tokens,
                    &surface,
                    open_spec,
                    result,
                    insights,
                    chart_hover,
                    chart_bounds,
                    callbacks,
                ))
                .into_any_element(),
        );
    }

    let period_scope = match period {
        InsightsPeriod::Day => "Last 24 hours against the 24 before.",
        InsightsPeriod::Week => "Last 7 days against the 7 before.",
        InsightsPeriod::Month => "Last 30 days against the 30 before.",
    };
    let scope = if searching {
        format!("{period_scope} The search does not narrow these numbers.")
    } else {
        period_scope.to_owned()
    };

    let grid = insight_grid_layout(shown.len());
    let min_grid_width = grid.columns as f32 * CARD_MIN_WIDTH_PX
        + grid.columns.saturating_sub(1) as f32 * GRID_GAP_PX;

    let mut rows_col = v_flex()
        .w_full()
        .min_w(px(min_grid_width))
        .gap(px(GRID_GAP_PX));

    for row_idx in 0..grid.rows {
        let start = row_idx * grid.columns;
        let end = (start + grid.columns).min(shown.len());
        if start >= end {
            continue;
        }
        let mut row = h_flex().w_full().gap(px(GRID_GAP_PX));
        for (offset, spec) in shown[start..end].iter().copied().enumerate() {
            let index = start + offset;
            let span = if index + 1 == shown.len() {
                grid.last_span
            } else {
                1
            };
            let corners = insight_block_corners(grid, index, shown.len());
            let result = insight_result(insights, spec.id);
            let trend = insight_trend(insights, spec.id);
            let tooltip_text = format!("{} {scope}", insight_hint(spec.id, insights));
            row = row.child(render_insight_card(
                tokens,
                &surface,
                spec,
                result,
                trend,
                tooltip_text,
                span,
                corners,
                row_idx == 0,
                Rc::clone(&callbacks.on_expand),
            ));
        }
        rows_col = rows_col.child(row);
    }

    // Subtle edge fades while scrolled or scrollable horizontally (`TasksInsights.tsx:434-441`).
    let card_bg = to_hsla(tokens.shell_card);
    let offset_x = f32::from(scroll.offset().x);
    let max_scroll_x = f32::from(scroll.max_offset().x);
    let show_start_fade = offset_x < -1.0;
    let show_end_fade = max_scroll_x > 1.0 && (-offset_x) < max_scroll_x - 1.0;

    let mut section = div().relative().w_full().flex_shrink_0().child(
        div()
            .id("tasks-insights-scroll")
            .w_full()
            .overflow_x_scroll()
            .track_scroll(scroll)
            .px(px(8.0))
            .child(rows_col),
    );

    if show_start_fade {
        section = section.child(
            div()
                .absolute()
                .top_0()
                .bottom(px(1.0))
                .left_0()
                .w(px(EDGE_FADE_WIDTH_PX))
                .bg(linear_gradient(
                    90.0,
                    linear_color_stop(card_bg, 0.0),
                    linear_color_stop(card_bg.opacity(0.0), 1.0),
                )),
        );
    }
    if show_end_fade {
        section = section.child(
            div()
                .absolute()
                .top_0()
                .bottom(px(1.0))
                .right_0()
                .w(px(EDGE_FADE_WIDTH_PX))
                .bg(linear_gradient(
                    270.0,
                    linear_color_stop(card_bg, 0.0),
                    linear_color_stop(card_bg.opacity(0.0), 1.0),
                )),
        );
    }

    Some(section.into_any_element())
}

#[expect(
    clippy::too_many_arguments,
    reason = "renders one insight tile with explicit grid layout metrics"
)]
fn render_insight_card(
    tokens: &Tokens,
    surface: &TasksSurfaceColors,
    spec: InsightSpec,
    result: InsightResult,
    trend: Option<Vec<conn_desktop::orbit::insights::TrendPoint>>,
    tooltip_text: String,
    span: usize,
    corners: [bool; 4],
    top_row: bool,
    on_expand: Rc<dyn Fn(Option<InsightId>, &mut Window, &mut App)>,
) -> AnyElement {
    let fg = to_hsla(tokens.foreground);
    let muted = to_hsla(tokens.muted_foreground);
    let card_bg = to_hsla(surface.card_bg);
    let card_hover = to_hsla(surface.card_hover_bg);
    let top_edge = to_hsla(surface.shell_card_edge);

    let formatted_value = result.value.map(|v| format_insight_value(spec.id, v));
    let min_w = span as f32 * CARD_MIN_WIDTH_PX + span.saturating_sub(1) as f32 * GRID_GAP_PX;

    let mut card = v_flex()
        .id(SharedString::from(format!("tasks-insight-{:?}", spec.id)))
        .min_w(px(min_w))
        .flex_grow(span as f32)
        .flex_shrink(1.0)
        .flex_basis(px(0.0))
        .gap(px(4.0))
        .px(px(10.0))
        .pt(px(10.0))
        .pb(px(8.0))
        .bg(card_bg)
        .cursor_pointer()
        .hover(move |s| s.bg(card_hover))
        .on_click(move |_, window, cx| on_expand(Some(spec.id), window, cx))
        .conn_tooltip(tooltip_text, tokens);

    if top_row {
        card = card.border_t_1().border_color(top_edge);
    } else {
        card = card
            .border_t_1()
            .border_color(gpui_kit::transparent_black());
    }
    if corners[0] {
        card = card.rounded_tl(px(GROUP_RADIUS_PX));
    }
    if corners[1] {
        card = card.rounded_tr(px(GROUP_RADIUS_PX));
    }
    if corners[2] {
        card = card.rounded_br(px(GROUP_RADIUS_PX));
    }
    if corners[3] {
        card = card.rounded_bl(px(GROUP_RADIUS_PX));
    }

    let value_color = if formatted_value.is_some() {
        fg
    } else {
        muted.opacity(0.60)
    };

    card.child(
        div()
            .truncate()
            .text_size(px(UI_TEXT_PX))
            .line_height(px(UI_LINE_HEIGHT_PX))
            .text_color(muted)
            .child(spec.label),
    )
    .child(
        h_flex()
            .min_w_0()
            .items_baseline()
            .gap(px(8.0))
            .child(
                div()
                    .flex_shrink_0()
                    .text_size(px(VALUE_FONT_PX))
                    .line_height(px(VALUE_LINE_HEIGHT_PX))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(value_color)
                    .child(formatted_value.unwrap_or_else(|| "\u{2013}".to_owned())),
            )
            .when_some(render_insight_change(tokens, spec, result), |el, change| {
                el.child(change)
            }),
    )
    .child(render_sparkline(trend.unwrap_or_default(), tokens))
    .into_any_element()
}

/// Renders the change indicator (`↘ −28%`, `↗ +39 pts`, or `No earlier data`).
fn render_insight_change(
    tokens: &Tokens,
    spec: InsightSpec,
    result: InsightResult,
) -> Option<AnyElement> {
    let text = insight_change_text(spec, result)?;
    let tone = insight_change_tone(spec, result.change);
    let color = match tone {
        ChangeTone::Good => to_hsla(tokens.success_foreground),
        ChangeTone::Bad => to_hsla(tokens.destructive_foreground),
        ChangeTone::Neutral => {
            if result.change.is_none() {
                to_hsla(tokens.muted_foreground).opacity(0.70)
            } else {
                to_hsla(tokens.muted_foreground)
            }
        }
    };
    let arrow = insight_change_trend(result.change).map(|is_down| {
        if is_down {
            "superhero/trend-down.svg"
        } else {
            "superhero/trend-up.svg"
        }
    });

    Some(
        h_flex()
            .flex_shrink_0()
            .items_center()
            .gap(px(4.0))
            .text_size(px(UI_TEXT_PX))
            .line_height(px(UI_LINE_HEIGHT_PX))
            .text_color(color)
            .when_some(arrow, |el, icon| {
                el.child(superhero_icon(icon, 14.0, color))
            })
            .child(text)
            .into_any_element(),
    )
}

#[expect(
    clippy::too_many_arguments,
    reason = "renders the expanded insight detail box"
)]
fn render_insight_detail(
    tokens: &Tokens,
    surface: &TasksSurfaceColors,
    spec: InsightSpec,
    result: InsightResult,
    insights: Option<&TaskInsights>,
    chart_hover: Option<usize>,
    chart_bounds: Rc<Cell<Bounds<Pixels>>>,
    callbacks: InsightsCallbacks,
) -> AnyElement {
    let fg = to_hsla(tokens.foreground);
    let muted = to_hsla(tokens.muted_foreground);
    let formatted_value = result
        .value
        .map(|v| format_insight_value(spec.id, v))
        .unwrap_or_else(|| "\u{2013}".to_owned());
    let trend = insight_trend(insights, spec.id);
    let providers = insight_by_provider(insights, spec.id);
    let on_close = callbacks.on_expand;

    let mut legend = h_flex()
        .ml_auto()
        .flex_wrap()
        .items_center()
        .gap_x(px(20.0))
        .gap_y(px(4.0))
        .text_size(px(UI_TEXT_PX))
        .line_height(px(UI_LINE_HEIGHT_PX));
    for entry in providers {
        let val = entry
            .value
            .map(|v| format_insight_value(spec.id, v))
            .unwrap_or_else(|| "\u{2013}".to_owned());
        legend = legend.child(
            h_flex()
                .items_baseline()
                .gap(px(6.0))
                .child(div().text_color(fg).child(entry.provider.name()))
                .child(div().text_color(muted).child(val)),
        );
    }

    let chart_body: AnyElement = match trend {
        Some(points) if !points.is_empty() => render_trend_chart(
            spec.id,
            points,
            chart_hover,
            chart_bounds,
            tokens,
            callbacks.on_hover_chart,
        ),
        _ => div()
            .size_full()
            .flex()
            .items_center()
            .justify_center()
            .text_size(px(UI_TEXT_PX))
            .line_height(px(UI_LINE_HEIGHT_PX))
            .text_color(muted)
            .child("Orbit reports no history for this number yet.")
            .into_any_element(),
    };

    v_flex()
        .relative()
        .w_full()
        .h(px(EXPANDED_HEIGHT_PX))
        .gap(px(4.0))
        .rounded(px(GROUP_RADIUS_PX))
        .border_t_1()
        .border_color(to_hsla(surface.shell_card_edge))
        .bg(to_hsla(surface.card_bg))
        .px(px(12.0))
        .pt(px(10.0))
        .pb(px(8.0))
        .child(
            div().absolute().top(px(4.0)).right(px(4.0)).child(
                chrome::icon_button(
                    "tasks-insight-close",
                    "superhero/close.svg",
                    tokens,
                    false,
                    move |_, window, cx| on_close(None, window, cx),
                )
                .conn_tooltip(format!("Close {} chart", spec.label), tokens),
            ),
        )
        .child(
            h_flex()
                .items_center()
                .gap(px(8.0))
                .pr(px(32.0))
                .child(
                    div()
                        .truncate()
                        .text_size(px(UI_TEXT_PX))
                        .line_height(px(UI_LINE_HEIGHT_PX))
                        .text_color(muted)
                        .child(spec.label),
                )
                .child(
                    div()
                        .min_w_0()
                        .flex_1()
                        .truncate()
                        .text_size(px(12.0))
                        .line_height(px(16.0))
                        .text_color(muted.opacity(0.65))
                        .child(insight_hint(spec.id, insights)),
                ),
        )
        .child(
            h_flex()
                .min_w_0()
                .items_baseline()
                .gap(px(8.0))
                .child(
                    div()
                        .flex_shrink_0()
                        .text_size(px(VALUE_FONT_PX))
                        .line_height(px(VALUE_LINE_HEIGHT_PX))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(fg)
                        .child(formatted_value),
                )
                .when_some(render_insight_change(tokens, spec, result), |el, change| {
                    el.child(change)
                })
                .child(legend),
        )
        .child(div().mt(px(12.0)).flex_1().min_h_0().child(chart_body))
        .into_any_element()
}
