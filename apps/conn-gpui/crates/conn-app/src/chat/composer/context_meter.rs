//! Context window meter (`ContextWindowMeter.tsx`, `ContextWindowMeter.logic.ts`,
//! `lib/contextWindow.ts` parity).
//!
//! A `28px` ghost button with a `20px` ring (`r=9.75` in a `24` viewBox, `3` stroke): the track is
//! `muted-foreground/24`, the arc `muted-foreground/72`, or the error color past `90%`. Hovering
//! opens a `side="top" align="end"` popover with the used/total tokens and percentage.

use conn_theme::Tokens;
use gpui_kit::{
    AnyElement, Context, FontWeight, Hsla, InteractiveElement as _, IntoElement,
    ParentElement as _, PathBuilder, StatefulInteractiveElement as _, Styled as _, canvas,
    deferred, div, point, px,
};

use super::super::color::{hsla, hsla_alpha};
use super::super::icons;
use super::Composer;
use super::footer::popover_surface;
use crate::a11y::ConnA11yExt as _;

/// Ring geometry in Conn's `0 0 24 24` viewBox.
const RING_RADIUS: f32 = 9.75;
const RING_STROKE: f32 = 3.0;
const RING_VIEWBOX: f32 = 24.0;
/// Ring box size (`size-5`).
const RING_SIZE_PX: f32 = 20.0;
/// Button size (`size-7`).
const BUTTON_SIZE_PX: f32 = 28.0;
/// Line segments used to approximate the ring.
const RING_SEGMENTS: usize = 72;

/// Context usage for the active thread (`ContextWindowSnapshot` subset the meter reads).
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct ContextWindowSnapshot {
    pub(crate) used_tokens: f64,
    pub(crate) max_tokens: Option<f64>,
    pub(crate) total_processed_tokens: Option<f64>,
    pub(crate) cost: Option<(f64, String)>,
    pub(crate) compacts_automatically: bool,
    pub(crate) auto_compact_threshold: Option<f64>,
}

impl ContextWindowSnapshot {
    /// `usedPercentage`: `used / max * 100`, capped at `100`, or `None` without a known max.
    #[must_use]
    pub(crate) fn used_percentage(&self) -> Option<f64> {
        self.max_tokens
            .filter(|max| *max > 0.0)
            .map(|max| (self.used_tokens / max * 100.0).min(100.0))
    }
}

/// `formatContextWindowTokens`: `950`, `1.2k`, `42k`, `1.5m`.
#[must_use]
pub(crate) fn format_context_window_tokens(value: Option<f64>) -> String {
    let Some(value) = value.filter(|v| v.is_finite()) else {
        return "0".to_owned();
    };
    if value < 1_000.0 {
        format!("{}", value.round())
    } else if value < 10_000.0 {
        format!("{}k", trim_zero_decimal(to_fixed_1(value / 1_000.0)))
    } else if value < 999_500.0 {
        format!("{}k", (value / 1_000.0).round())
    } else {
        format!("{}m", trim_zero_decimal(to_fixed_1(value / 1_000_000.0)))
    }
}

/// `formatPercentage`: one decimal under `10%`, else a rounded integer.
#[must_use]
pub(crate) fn format_percentage(value: Option<f64>) -> Option<String> {
    let value = value.filter(|v| v.is_finite())?;
    if value < 10.0 {
        Some(format!("{}%", trim_zero_decimal(to_fixed_1(value))))
    } else {
        Some(format!("{}%", value.round()))
    }
}

/// `formatContextWindowCost`: 4 decimals under `0.01`, else 2.
#[must_use]
pub(crate) fn format_cost(amount: f64, currency: &str) -> String {
    if amount.abs() > 0.0 && amount.abs() < 0.01 {
        format!("{currency} {amount:.4}")
    } else {
        format!("{currency} {amount:.2}")
    }
}

/// `formatContextWindowCompactionMessage`.
#[must_use]
pub(crate) fn compaction_message(model: Option<&str>, threshold: Option<f64>) -> String {
    if let Some(threshold) = threshold.filter(|t| *t > 0.0) {
        return format!(
            "Compacts automatically at about {} tokens.",
            format_thousands(threshold)
        );
    }
    match model {
        Some(name) => format!("Context for {name} compacts automatically when needed."),
        None => "Context compacts automatically when needed.".to_owned(),
    }
}

/// JS `toFixed(1)`: rounds half away from zero (Rust's `{:.1}` rounds half to even).
fn to_fixed_1(value: f64) -> String {
    format!("{:.1}", (value * 10.0).round() / 10.0)
}

fn trim_zero_decimal(text: String) -> String {
    match text.strip_suffix(".0") {
        Some(trimmed) => trimmed.to_owned(),
        None => text,
    }
}

/// `toLocaleString("en-US")` for whole token counts.
fn format_thousands(value: f64) -> String {
    let digits = format!("{}", value.round());
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    for (index, ch) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index) % 3 == 0 {
            out.push(',');
        }
        out.push(ch);
    }
    out
}

/// Renders the meter button and, while hovered, its popover.
pub(super) fn render_context_meter(
    usage: &ContextWindowSnapshot,
    model_display_name: Option<&str>,
    show_compact: bool,
    open: bool,
    tokens: &Tokens,
    cx: &mut Context<'_, Composer>,
) -> AnyElement {
    let percentage = usage.used_percentage();
    let normalized = percentage.unwrap_or(0.0).clamp(0.0, 100.0);
    let used_label = format_percentage(percentage);
    let overloaded = normalized > 90.0;
    let usage_color = if overloaded {
        hsla(tokens.destructive)
    } else {
        hsla_alpha(tokens.muted_foreground, 0.72)
    };
    let track_color = hsla_alpha(tokens.muted_foreground, 0.24);
    let aria = match (&usage.max_tokens, &used_label) {
        (Some(_), Some(pct)) => format!("Context window {pct} used"),
        _ => format!(
            "Context window {} tokens used",
            format_context_window_tokens(Some(usage.used_tokens))
        ),
    };
    let fraction = (normalized / 100.0) as f32;
    let highlight = hsla(tokens.shell_highlight);

    let ring = canvas(
        |_, _, _| {},
        move |bounds, _, window, _| {
            let scale = f32::from(bounds.size.width) / RING_VIEWBOX;
            let radius = RING_RADIUS * scale;
            let stroke = RING_STROKE * scale;
            let center = bounds.center();
            let at = |t: f32| {
                // Starts at 12 o'clock (`-rotate-90`) and runs clockwise.
                let angle = -std::f32::consts::FRAC_PI_2 + t * std::f32::consts::TAU;
                point(
                    center.x + px(radius * angle.cos()),
                    center.y + px(radius * angle.sin()),
                )
            };
            let mut paint = |from: f32, to: f32, color: Hsla| {
                if to <= from {
                    return;
                }
                let steps = ((to - from) * RING_SEGMENTS as f32).ceil().max(1.0) as usize;
                let mut path = PathBuilder::stroke(px(stroke));
                path.move_to(at(from));
                for step in 1..=steps {
                    path.line_to(at(from + (to - from) * step as f32 / steps as f32));
                }
                if let Ok(built) = path.build() {
                    window.paint_path(built, color);
                }
            };
            paint(0.0, 1.0, track_color);
            paint(0.0, fraction, usage_color);
        },
    )
    .size(px(RING_SIZE_PX));

    let mut slot = div().relative().flex_none().child(
        div()
            .id("composer-context-meter")
            .a11y_button("composer.context-meter", aria)
            .flex()
            .items_center()
            .justify_center()
            .size(px(BUTTON_SIZE_PX))
            .rounded(px(8.0))
            .cursor_pointer()
            .hover(move |s| s.bg(highlight))
            // Hover opens (`openOnHover`). With a Compact button the popover stays open after
            // the pointer leaves so it can be reached; click or Escape closes it.
            .on_hover(cx.listener(move |composer, hovered: &bool, _, cx| {
                if *hovered || !show_compact {
                    composer.set_context_meter_open(*hovered, cx);
                }
            }))
            .on_click(cx.listener(|composer, _, _, cx| {
                let next = !composer.context_meter_open;
                composer.set_context_meter_open(next, cx);
            }))
            .child(ring),
    );

    if open {
        slot = slot.child(
            deferred(
                div().absolute().bottom_full().right_0().mb(px(6.0)).child(
                    popover_surface("composer-context-meter-popup", tokens)
                        .w(px(240.0))
                        .child(render_popover_body(
                            usage,
                            model_display_name,
                            show_compact,
                            used_label.as_deref(),
                            normalized,
                            usage_color,
                            tokens,
                            cx,
                        )),
                ),
            )
            .with_priority(3),
        );
    }
    slot.into_any_element()
}

#[expect(
    clippy::too_many_arguments,
    reason = "mirrors ContextWindowMeter's popover inputs"
)]
fn render_popover_body(
    usage: &ContextWindowSnapshot,
    model_display_name: Option<&str>,
    show_compact: bool,
    used_label: Option<&str>,
    normalized: f64,
    usage_color: Hsla,
    tokens: &Tokens,
    cx: &mut Context<'_, Composer>,
) -> AnyElement {
    let muted = hsla(tokens.muted_foreground);
    let secondary = hsla(tokens.muted_foreground_raised);
    let summary = match (usage.max_tokens, used_label) {
        (Some(max), Some(pct)) => format!(
            "{pct} · {}/{}",
            format_context_window_tokens(Some(usage.used_tokens)),
            format_context_window_tokens(Some(max))
        ),
        _ => format_context_window_tokens(Some(usage.used_tokens)),
    };
    let row = |label: &'static str, value: String| {
        div()
            .flex()
            .flex_row()
            .items_center()
            .justify_between()
            .gap(px(12.0))
            .text_size(px(11.0))
            .line_height(px(16.0))
            .text_color(secondary)
            .child(label)
            .child(div().font_weight(FontWeight::MEDIUM).child(value))
    };

    let mut body = div().flex().flex_col().gap(px(8.0)).p(px(8.0)).child(
        div()
            .flex()
            .flex_row()
            .items_center()
            .justify_between()
            .gap(px(12.0))
            .child(
                div()
                    .text_size(px(12.0))
                    .line_height(px(16.0))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(muted)
                    .child("Context Window"),
            )
            .child(
                div()
                    .text_size(px(11.0))
                    .line_height(px(16.0))
                    .text_color(secondary)
                    .child(summary),
            ),
    );
    if usage.max_tokens.is_some() {
        body = body.child(
            div()
                .h(px(6.0))
                .w_full()
                .rounded_full()
                .overflow_hidden()
                .bg(hsla_alpha(tokens.muted, 0.60))
                .child(
                    div()
                        .h_full()
                        .rounded_full()
                        .w(gpui_kit::relative((normalized / 100.0) as f32))
                        .bg(usage_color),
                ),
        );
    }
    if let Some(total) = usage.total_processed_tokens.filter(|t| *t > 0.0) {
        body = body.child(row(
            "Total processed",
            format_context_window_tokens(Some(total)),
        ));
    }
    if let Some((amount, currency)) = &usage.cost {
        body = body.child(row("Cost", format_cost(*amount, currency)));
    }
    if usage.compacts_automatically {
        body = body.child(
            div()
                .mt(px(4.0))
                .text_size(px(11.0))
                .line_height(px(16.0))
                .font_weight(FontWeight::MEDIUM)
                .text_color(secondary)
                .child(compaction_message(
                    model_display_name,
                    usage.auto_compact_threshold,
                )),
        );
    }
    if show_compact {
        let fg = hsla(tokens.foreground);
        let highlight = hsla(tokens.shell_highlight);
        body = body.child(
            div()
                .id("composer-context-compact")
                .a11y_button("composer.context-compact", "Compact context")
                .mt(px(4.0))
                .flex()
                .flex_row()
                .items_center()
                .justify_center()
                .gap(px(6.0))
                .h(px(24.0))
                .w_full()
                .rounded(px(6.0))
                .border_1()
                .border_color(hsla(tokens.border))
                .cursor_pointer()
                .text_size(px(12.0))
                .line_height(px(16.0))
                .text_color(fg)
                .hover(move |s| s.bg(highlight))
                .on_click(cx.listener(|composer, _, _, cx| {
                    composer.set_context_meter_open(false, cx);
                    cx.emit(super::ComposerEvent::SlashCommand("compact".to_owned()));
                }))
                .child(icons::icon("superhero/minimize.svg", 14.0, fg))
                .child("Compact context"),
        );
    }
    body.into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_formatting_matches_conn() {
        assert_eq!(format_context_window_tokens(None), "0");
        assert_eq!(format_context_window_tokens(Some(950.0)), "950");
        assert_eq!(format_context_window_tokens(Some(1_000.0)), "1k");
        assert_eq!(format_context_window_tokens(Some(1_250.0)), "1.3k");
        assert_eq!(format_context_window_tokens(Some(42_400.0)), "42k");
        assert_eq!(format_context_window_tokens(Some(200_000.0)), "200k");
        assert_eq!(format_context_window_tokens(Some(1_000_000.0)), "1m");
        assert_eq!(format_context_window_tokens(Some(1_500_000.0)), "1.5m");
    }

    #[test]
    fn percentage_and_cost_formatting_match_conn() {
        assert_eq!(format_percentage(Some(4.25)).as_deref(), Some("4.3%"));
        assert_eq!(format_percentage(Some(5.0)).as_deref(), Some("5%"));
        assert_eq!(format_percentage(Some(42.6)).as_deref(), Some("43%"));
        assert_eq!(format_percentage(None), None);
        assert_eq!(format_cost(0.004, "USD"), "USD 0.0040");
        assert_eq!(format_cost(1.5, "USD"), "USD 1.50");
    }

    #[test]
    fn used_percentage_caps_and_needs_max() {
        let mut usage = ContextWindowSnapshot {
            used_tokens: 50_000.0,
            max_tokens: Some(200_000.0),
            ..ContextWindowSnapshot::default()
        };
        assert_eq!(usage.used_percentage(), Some(25.0));
        usage.used_tokens = 300_000.0;
        assert_eq!(usage.used_percentage(), Some(100.0));
        usage.max_tokens = None;
        assert_eq!(usage.used_percentage(), None);
    }

    #[test]
    fn compaction_message_matches_conn() {
        assert_eq!(
            compaction_message(Some("Sonnet 4.6"), Some(160_000.0)),
            "Compacts automatically at about 160,000 tokens."
        );
        assert_eq!(
            compaction_message(Some("Sonnet 4.6"), None),
            "Context for Sonnet 4.6 compacts automatically when needed."
        );
        assert_eq!(
            compaction_message(None, None),
            "Context compacts automatically when needed."
        );
    }
}
