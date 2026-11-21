//! Sparklines and expanded trend charts painted with GPUI `canvas` + `PathBuilder`.
//!
//! Port of `apps/web/src/orbit/tasks/InsightCharts.tsx`.

use std::cell::Cell;
use std::rc::Rc;

use conn_desktop::orbit::insights::{
    InsightId, TrendPoint, format_insight_value, nice_scale, sparkline_points,
};
use conn_theme::Tokens;
use gpui_kit::component::h_flex;
use gpui_kit::prelude::*;
use gpui_kit::{
    AnyElement, App, Background, Bounds, BoxShadow, FontWeight, Hsla, MouseMoveEvent, PathBuilder,
    Pixels, Point, Window, canvas, div, fill, linear_color_stop, linear_gradient, point, px, size,
};

/// SVG `linearGradient x1=0 x2=0 y1=0 y2=1` from `color` at `opacity` to transparent, as a
/// GPUI background (CSS angle 180° runs top to bottom).
fn vertical_fade(color: Hsla, opacity: f32) -> Background {
    linear_gradient(
        180.0,
        linear_color_stop(color.opacity(opacity), 0.0),
        linear_color_stop(color.opacity(0.0), 1.0),
    )
}

use super::format::{TasksSurfaceColors, format_chart_date_label};
use crate::panels::chrome::{UI_LINE_HEIGHT_PX, UI_TEXT_PX};
use crate::panels::color::to_hsla;

/// Height of a tile's sparkline (`h-7` = 28px).
const SPARKLINE_HEIGHT_PX: f32 = 28.0;
const AXIS_FONT_PX: f32 = 11.0;
const AXIS_LINE_HEIGHT_PX: f32 = 14.0;
const CHART_MARGIN_TOP_PX: f32 = 6.0;
const CHART_MARGIN_RIGHT_PX: f32 = 4.0;
const CHART_MARGIN_BOTTOM_PX: f32 = 24.0;

/// Snaps a pointer x coordinate inside the chart plot to the nearest data point index.
#[must_use]
pub(super) fn hover_index_from_x(
    mouse_x: f32,
    plot_left: f32,
    plot_width: f32,
    count: usize,
) -> Option<usize> {
    if count == 0 || plot_width <= 0.0 {
        return None;
    }
    if mouse_x < plot_left || mouse_x > plot_left + plot_width {
        return None;
    }
    if count == 1 {
        return Some(0);
    }
    let ratio = ((mouse_x - plot_left) / plot_width).clamp(0.0, 1.0);
    let idx = (ratio * (count - 1) as f32).round() as usize;
    Some(idx.min(count - 1))
}

/// Axis label indices shown along the bottom edge: first, middle, last (deduplicated).
#[must_use]
pub(super) fn x_axis_indices(count: usize) -> Vec<usize> {
    if count == 0 {
        return Vec::new();
    }
    let mut indices = vec![0];
    let mid = (count - 1) / 2;
    if !indices.contains(&mid) {
        indices.push(mid);
    }
    let last = count - 1;
    if !indices.contains(&last) {
        indices.push(last);
    }
    indices
}

/// Renders a 28px sparkline with a soft translucent area fill and a 1.5px muted polyline.
pub(super) fn render_sparkline(points: Vec<TrendPoint>, tokens: &Tokens) -> AnyElement {
    let base = to_hsla(tokens.muted_foreground);
    let stroke_color = base.opacity(0.70);
    // Conn's `<Fade opacity={0.22}>`: a vertical 22%→0% gradient under the line.
    let area_color = vertical_fade(base, 0.22);

    let inner: AnyElement = if points.len() < 2 {
        div().size_full().into_any_element()
    } else {
        canvas(
            |_, _, _| {},
            move |bounds, _, window, _| {
                paint_sparkline(bounds, &points, stroke_color, area_color, window);
            },
        )
        .size_full()
        .into_any_element()
    };

    div()
        .w_full()
        .h(px(SPARKLINE_HEIGHT_PX))
        .mt(px(4.0))
        .child(inner)
        .into_any_element()
}

fn paint_sparkline(
    bounds: Bounds<Pixels>,
    points: &[TrendPoint],
    stroke_color: Hsla,
    area_color: Background,
    window: &mut Window,
) {
    let width = f32::from(bounds.size.width);
    let height = f32::from(bounds.size.height);
    if width <= 2.0 || height <= 2.0 {
        return;
    }
    let placed = sparkline_points(points, f64::from(width));
    if placed.len() < 2 {
        return;
    }
    let scale_y = height / SPARKLINE_HEIGHT_PX;
    let to_pt = |(x, y): (f64, f64)| {
        point(
            bounds.origin.x + px(x as f32),
            bounds.origin.y + px((y as f32) * scale_y),
        )
    };
    let baseline = bounds.origin.y + bounds.size.height;

    let mut area = PathBuilder::fill();
    let first = to_pt(placed[0]);
    area.move_to(first);
    for &p in &placed[1..] {
        area.line_to(to_pt(p));
    }
    let last = to_pt(placed[placed.len() - 1]);
    area.line_to(point(last.x, baseline));
    area.line_to(point(first.x, baseline));
    area.close();
    if let Ok(path) = area.build() {
        window.paint_path(path, area_color);
    }

    let mut line = PathBuilder::stroke(px(1.5));
    line.move_to(first);
    for &p in &placed[1..] {
        line.line_to(to_pt(p));
    }
    if let Ok(path) = line.build() {
        window.paint_path(path, stroke_color);
    }
}

/// Renders the expanded full-width trend chart with dashed Y-axis gridlines, axis labels,
/// hover crosshair, active point marker, and floating tooltip popover.
pub(super) fn render_trend_chart(
    spec_id: InsightId,
    points: Vec<TrendPoint>,
    hover_index: Option<usize>,
    bounds_cell: Rc<Cell<Bounds<Pixels>>>,
    tokens: &Tokens,
    on_hover: Rc<dyn Fn(Option<usize>, &mut Window, &mut App)>,
) -> AnyElement {
    let surface = TasksSurfaceColors::from_tokens(tokens);
    let count = points.len();
    let (min_v, max_v) = if count == 0 {
        (0.0, 1.0)
    } else {
        let min = points.iter().map(|p| p.value).fold(f64::INFINITY, f64::min);
        let max = points
            .iter()
            .map(|p| p.value)
            .fold(f64::NEG_INFINITY, f64::max);
        (min, max)
    };
    let scale = nice_scale(min_v, max_v);
    let tick_labels: Vec<(f64, String)> = scale
        .ticks
        .iter()
        .map(|&t| (t, format_insight_value(spec_id, t)))
        .collect();
    let max_chars = tick_labels
        .iter()
        .map(|(_, s)| s.chars().count())
        .max()
        .unwrap_or(2);
    let label_col_w = ((max_chars as f32) * 6.8).ceil().max(24.0);
    let margin_left = label_col_w + 10.0;

    let series_color = to_hsla(tokens.info);
    // Conn's `<Fade opacity={0.18}>` per series.
    let area_color = vertical_fade(series_color, 0.18);
    let grid_color = to_hsla(surface.shell_chart_grid);
    let crosshair_color = to_hsla(tokens.muted_foreground).opacity(0.50);
    let ring_color = to_hsla(tokens.shell_card);
    let muted = to_hsla(tokens.muted_foreground);

    let paint_points = points.clone();
    let paint_ticks = scale.ticks.clone();
    let paint_bounds_cell = Rc::clone(&bounds_cell);
    let low = scale.low;
    let high = scale.high;

    let chart_canvas = canvas(
        move |bounds, _, _| {
            paint_bounds_cell.set(bounds);
        },
        move |bounds, _, window, _| {
            paint_trend_chart(
                bounds,
                &paint_points,
                low,
                high,
                &paint_ticks,
                margin_left,
                hover_index,
                series_color,
                area_color,
                grid_color,
                crosshair_color,
                ring_color,
                window,
            );
        },
    )
    .size_full();

    // Y-axis tick labels positioned alongside the canvas left column.
    let y_labels = {
        let mut col = div()
            .absolute()
            .top(px(CHART_MARGIN_TOP_PX))
            .bottom(px(CHART_MARGIN_BOTTOM_PX))
            .left_0()
            .w(px(label_col_w));
        let span = (high - low).max(f64::EPSILON);
        for (tick, text) in &tick_labels {
            let frac = 1.0 - ((*tick - low) / span) as f32;
            col = col.child(
                div()
                    .absolute()
                    .left_0()
                    .right_0()
                    .top(gpui_kit::relative(frac))
                    .mt(px(-7.0))
                    .flex()
                    .justify_end()
                    .text_size(px(AXIS_FONT_PX))
                    .line_height(px(AXIS_LINE_HEIGHT_PX))
                    .text_color(muted)
                    .child(text.clone()),
            );
        }
        col
    };

    // X-axis date labels (first, middle, last).
    let x_labels = {
        let indices = x_axis_indices(count);
        let mut row = h_flex()
            .absolute()
            .left(px(margin_left))
            .right(px(CHART_MARGIN_RIGHT_PX))
            .bottom(px(2.0))
            .h(px(16.0))
            .items_center()
            .justify_between()
            .text_size(px(AXIS_FONT_PX))
            .line_height(px(AXIS_LINE_HEIGHT_PX))
            .text_color(muted);
        for idx in indices {
            if let Some(pt) = points.get(idx) {
                row = row.child(div().child(format_chart_date_label(&pt.date)));
            }
        }
        row
    };

    // Hover tooltip card (`InsightCharts.tsx:309-342`).
    let tooltip: Option<AnyElement> = hover_index.and_then(|idx| {
        let pt = points.get(idx)?;
        let bounds = bounds_cell.get();
        let width = f32::from(bounds.size.width);
        let plot_w = (width - margin_left - CHART_MARGIN_RIGHT_PX).max(1.0);
        let x_pos = margin_left + (idx as f32 / (count.saturating_sub(1).max(1)) as f32) * plot_w;
        let on_left = x_pos > width * 0.5;
        let formatted = format_insight_value(spec_id, pt.value);
        let fg = to_hsla(tokens.foreground);
        let rule = to_hsla(surface.popover_rule);
        let shadow = BoxShadow {
            color: gpui_kit::hsla(0.0, 0.0, 0.0, 0.22),
            offset: point(px(0.0), px(6.0)),
            blur_radius: px(16.0),
            spread_radius: px(-4.0),
            inset: false,
        };
        let mut card = div()
            .absolute()
            .top(px(4.0))
            .min_w(px(144.0))
            .rounded(px(8.0))
            .border_1()
            .border_color(to_hsla(tokens.shell_divider))
            .bg(to_hsla(tokens.popover))
            .px(px(10.0))
            .py(px(8.0))
            .shadow(vec![shadow])
            .text_size(px(UI_TEXT_PX))
            .line_height(px(UI_LINE_HEIGHT_PX))
            .child(
                div()
                    .mb(px(4.0))
                    .text_color(muted)
                    .child(format_chart_date_label(&pt.date)),
            )
            .child(
                h_flex()
                    .items_center()
                    .gap(px(8.0))
                    .child(div().size(px(8.0)).rounded_full().bg(series_color))
                    .child(div().flex_1().text_color(fg).child("All providers"))
                    .child(div().text_color(fg).child(formatted.clone())),
            )
            .child(
                h_flex()
                    .mt(px(4.0))
                    .pt(px(4.0))
                    .border_t_1()
                    .border_color(rule)
                    .items_center()
                    .gap(px(8.0))
                    .child(div().w(px(8.0)).flex_shrink_0())
                    .child(
                        div()
                            .flex_1()
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(fg)
                            .child("Total"),
                    )
                    .child(
                        div()
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(fg)
                            .child(formatted),
                    ),
            );
        card = if on_left {
            card.right(px((width - x_pos + 10.0).max(4.0)))
        } else {
            card.left(px((x_pos + 10.0).min((width - 150.0).max(4.0))))
        };
        Some(card.into_any_element())
    });

    let move_bounds = Rc::clone(&bounds_cell);
    let move_hover = Rc::clone(&on_hover);
    let leave_hover = on_hover;

    div()
        .id("tasks-insight-trend-chart")
        .relative()
        .size_full()
        .min_h_0()
        .on_mouse_move(move |event: &MouseMoveEvent, window, cx| {
            let bounds = move_bounds.get();
            let plot_left = f32::from(bounds.origin.x) + margin_left;
            let plot_w =
                (f32::from(bounds.size.width) - margin_left - CHART_MARGIN_RIGHT_PX).max(0.0);
            let next = hover_index_from_x(f32::from(event.position.x), plot_left, plot_w, count);
            move_hover(next, window, cx);
        })
        .on_hover(move |hovered, window, cx| {
            if !hovered {
                leave_hover(None, window, cx);
            }
        })
        .child(chart_canvas)
        .child(y_labels)
        .child(x_labels)
        .when_some(tooltip, |el, tip| el.child(tip))
        .into_any_element()
}

#[expect(
    clippy::too_many_arguments,
    reason = "single canvas paint helper passing geometry and theme colors"
)]
fn paint_trend_chart(
    bounds: Bounds<Pixels>,
    points: &[TrendPoint],
    low: f64,
    high: f64,
    ticks: &[f64],
    margin_left: f32,
    hover_index: Option<usize>,
    series_color: Hsla,
    area_color: Background,
    grid_color: Hsla,
    crosshair_color: Hsla,
    ring_color: Hsla,
    window: &mut Window,
) {
    let width = f32::from(bounds.size.width);
    let height = f32::from(bounds.size.height);
    if width <= margin_left + 8.0 || height <= 40.0 {
        return;
    }
    let plot_left = f32::from(bounds.origin.x) + margin_left;
    let plot_top = f32::from(bounds.origin.y) + CHART_MARGIN_TOP_PX;
    let plot_w = (width - margin_left - CHART_MARGIN_RIGHT_PX).max(1.0);
    let plot_h = (height - CHART_MARGIN_TOP_PX - CHART_MARGIN_BOTTOM_PX).max(1.0);
    let span = (high - low).max(f64::EPSILON);

    let y_of = |value: f64| -> f32 { plot_top + plot_h - (((value - low) / span) as f32) * plot_h };
    let count = points.len();
    let x_of = |index: usize| -> f32 {
        if count <= 1 {
            plot_left
        } else {
            plot_left + (index as f32 / (count - 1) as f32) * plot_w
        }
    };

    // Dashed horizontal gridlines (`strokeDasharray="3 3"`).
    for &tick in ticks {
        let y = y_of(tick);
        let mut grid = PathBuilder::stroke(px(1.0)).dash_array(&[px(3.0), px(3.0)]);
        grid.move_to(point(px(plot_left), px(y)));
        grid.line_to(point(px(plot_left + plot_w), px(y)));
        if let Ok(path) = grid.build() {
            window.paint_path(path, grid_color);
        }
    }

    // Hover crosshair.
    if let Some(idx) = hover_index.filter(|&i| i < count) {
        let hx = x_of(idx);
        let mut cross = PathBuilder::stroke(px(1.0));
        cross.move_to(point(px(hx), px(plot_top)));
        cross.line_to(point(px(hx), px(plot_top + plot_h)));
        if let Ok(path) = cross.build() {
            window.paint_path(path, crosshair_color);
        }
    }

    if count >= 2 {
        let placed: Vec<Point<Pixels>> = points
            .iter()
            .enumerate()
            .map(|(i, p)| point(px(x_of(i)), px(y_of(p.value))))
            .collect();
        let baseline = px(plot_top + plot_h);

        let mut area = PathBuilder::fill();
        area.move_to(placed[0]);
        for &pt in &placed[1..] {
            area.line_to(pt);
        }
        area.line_to(point(placed[placed.len() - 1].x, baseline));
        area.line_to(point(placed[0].x, baseline));
        area.close();
        if let Ok(path) = area.build() {
            window.paint_path(path, area_color);
        }

        let mut line = PathBuilder::stroke(px(2.0));
        line.move_to(placed[0]);
        for &pt in &placed[1..] {
            line.line_to(pt);
        }
        if let Ok(path) = line.build() {
            window.paint_path(path, series_color);
        }
    }

    // Active hovered point marker (`r=4.5` with `2px` card ring).
    if let Some(pt) = hover_index.and_then(|i| points.get(i).map(|p| (i, p))) {
        let cx = x_of(pt.0);
        let cy = y_of(pt.1.value);
        let outer = Bounds {
            origin: point(px(cx - 5.5), px(cy - 5.5)),
            size: size(px(11.0), px(11.0)),
        };
        window.paint_quad(fill(outer, ring_color).corner_radii(px(5.5)));
        let inner = Bounds {
            origin: point(px(cx - 3.5), px(cy - 3.5)),
            size: size(px(7.0), px(7.0)),
        };
        window.paint_quad(fill(inner, series_color).corner_radii(px(3.5)));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_mouse_x_to_nearest_point_and_clamps() {
        assert_eq!(
            hover_index_from_x(10.0, 20.0, 100.0, 5),
            None,
            "left of plot yields None"
        );
        assert_eq!(
            hover_index_from_x(125.0, 20.0, 100.0, 5),
            None,
            "right of plot yields None"
        );
        assert_eq!(
            hover_index_from_x(20.0, 20.0, 100.0, 5),
            Some(0),
            "left edge maps to first point"
        );
        assert_eq!(
            hover_index_from_x(70.0, 20.0, 100.0, 5),
            Some(2),
            "midpoint maps to center point"
        );
        assert_eq!(
            hover_index_from_x(120.0, 20.0, 100.0, 5),
            Some(4),
            "right edge maps to last point"
        );
        assert_eq!(
            hover_index_from_x(50.0, 20.0, 100.0, 1),
            Some(0),
            "single point always maps to 0"
        );
    }

    #[test]
    fn picks_unique_x_axis_indices() {
        assert_eq!(x_axis_indices(0), Vec::<usize>::new(), "empty series");
        assert_eq!(x_axis_indices(1), vec![0], "single point");
        assert_eq!(x_axis_indices(2), vec![0, 1], "two points");
        assert_eq!(x_axis_indices(7), vec![0, 3, 6], "seven points");
    }
}
