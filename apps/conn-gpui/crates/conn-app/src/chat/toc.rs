//! Left-edge message minimap / TOC scrubber (`TimelineMinimap.tsx` parity) and
//! "Jump to latest" pill for long chat threads.
//!
//! Matches Conn (`apps/web/src/components/chat/TimelineMinimap.tsx`):
//! - Anchored on the **left** edge of the chat card (`left: 12px`, vertically centered).
//! - Subtle `1px` vertical spine (`border/15`) behind left-aligned `2px` horizontal ticks.
//! - **Fisheye magnification wave** around the hovered (or active) tick:
//!   `distance 0 -> 24px`, `distance 1 -> 16px`, `distance 2 -> 10px`, `distance >= 3 -> 8px`.
//! - Hovering a tick reveals a single rounded `dropdown-glass` preview card directly beside
//!   that tick showing the prompt line (and optional assistant snippet), clicking teleports
//!   straight to that turn.
//! - Quiet `↑` / `↓` buttons above and below the rail step between adjacent user turns.

use conn_theme::Tokens;
use gpui_kit::{
    AnimationExt as _, AnyElement, Context, FontWeight, InteractiveElement, IntoElement,
    MouseButton, ParentElement, SharedString, SpringAnimation, SpringConfig,
    StatefulInteractiveElement, Styled, deferred, div, px,
};

use super::cache::TocEntry;
use super::color::{hsla, hsla_alpha};
use super::{BODY_FONT_PX, ChatView, icons};
use crate::a11y::ConnA11yExt as _;

/// Maximum ticks drawn on the rail so 200+ turn threads stay compact and legible.
const MAX_VISIBLE_TICKS: usize = 36;
/// Vertical spacing per tick row (px) so preview tooltip aligns vertically with the hovered tick.
const TICK_ROW_HEIGHT_PX: f32 = 10.0;

/// Tick length spring: critically damped (`damping = 2 * sqrt(stiffness * mass)`), natural
/// frequency 27 rad/s, so a length change settles in about 150 ms like web's `duration-150`.
const TICK_SPRING: SpringConfig = SpringConfig::new(729.0, 54.0, 1.0);

/// Fisheye width curve matching `TimelineMinimap.tsx` (`w-6` = 24px scaled by `1.0 / 0.667 / 0.417 / 0.333`).
#[must_use]
pub(super) fn tick_width_for_distance(distance: Option<usize>) -> f32 {
    match distance {
        Some(0) => 24.0,
        Some(1) => 16.0,
        Some(2) => 10.0,
        _ => 8.0,
    }
}

/// Computes which TOC indices appear as visual tick marks on the rail.
/// Always preserves the first turn, the last turn, and the currently active turn.
pub(super) fn sample_tick_indices(total: usize, active: Option<usize>) -> Vec<usize> {
    if total <= MAX_VISIBLE_TICKS {
        return (0..total).collect();
    }
    let mut indices = Vec::with_capacity(MAX_VISIBLE_TICKS + 1);
    let last = total - 1;
    let denom = MAX_VISIBLE_TICKS - 1;
    for slot in 0..MAX_VISIBLE_TICKS {
        let idx = (slot * last) / denom;
        if indices.last().copied() != Some(idx) {
            indices.push(idx);
        }
    }
    if let Some(active_idx) = active
        && active_idx < total
        && !indices.contains(&active_idx)
        && let Some((slot, _)) = indices
            .iter()
            .enumerate()
            .skip(1)
            .take(indices.len().saturating_sub(2))
            .min_by_key(|(_, idx)| idx.abs_diff(active_idx))
    {
        indices[slot] = active_idx;
    }
    indices.sort_unstable();
    indices.dedup();
    indices
}

/// Renders Conn's subtle left-edge `TimelineMinimap` with fisheye tick wave and floating preview card.
pub(super) fn render_toc_overlay(
    toc: &[TocEntry],
    active_toc_idx: Option<usize>,
    hovered_slot: Option<usize>,
    tokens: &Tokens,
    cx: &mut Context<'_, ChatView>,
) -> Option<AnyElement> {
    if toc.len() < 2 {
        return None;
    }

    let sampled = sample_tick_indices(toc.len(), active_toc_idx);
    let active_slot = active_toc_idx.and_then(|idx| sampled.iter().position(|&s| s == idx));
    let resolved_hover = hovered_slot.filter(|&slot| slot < sampled.len());
    // Fisheye centers on hovered tick while scrubbing, or subtly on the active in-view tick at rest.
    let wave_center = resolved_hover.or(active_slot);

    let fg = hsla(tokens.foreground);
    let muted = hsla(tokens.muted_foreground);
    let spine_color = hsla_alpha(tokens.border, 0.16);
    let tick_idle = hsla_alpha(tokens.muted_foreground, 0.25);
    let tick_near = hsla_alpha(tokens.muted_foreground, 0.42);
    let tick_focus = hsla_alpha(tokens.muted_foreground, 0.65);
    let tick_in_view = hsla_alpha(tokens.foreground, 0.58);
    let hover_bg = hsla(tokens.shell_highlight);

    let prev_item = active_toc_idx
        .and_then(|i| i.checked_sub(1))
        .and_then(|i| toc.get(i))
        .map(|e| e.item_index);
    let next_item = active_toc_idx
        .and_then(|i| toc.get(i + 1))
        .map(|e| e.item_index);

    let nav_btn = |id: &'static str,
                   ax_id: &'static str,
                   label: &'static str,
                   icon_path: &'static str,
                   target: Option<usize>,
                   cx: &mut Context<'_, ChatView>| {
        let mut btn = div()
            .id(id)
            .a11y_button(ax_id, label)
            .flex()
            .items_center()
            .justify_center()
            .size(px(20.0))
            .rounded(px(6.0))
            .child(icons::icon(
                icon_path,
                11.0,
                if target.is_some() {
                    hsla_alpha(tokens.muted_foreground, 0.55)
                } else {
                    hsla_alpha(tokens.muted_foreground, 0.18)
                },
            ));
        if let Some(item_idx) = target {
            btn = btn
                .cursor_pointer()
                .hover(move |s| s.bg(hover_bg))
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .on_click(cx.listener(move |view, _, _, cx| {
                    view.jump_to_toc_item(item_idx, cx);
                }));
        }
        btn
    };

    let rail_height = (sampled.len() as f32) * TICK_ROW_HEIGHT_PX;
    let mut ticks_stack = div()
        .id("chat-toc-rail")
        .a11y(
            gpui_kit::Role::Navigation,
            "chat.toc",
            format!("Message minimap ({} turns)", toc.len()),
        )
        .relative()
        .flex()
        .flex_col()
        .items_start()
        .w(px(30.0))
        .h(px(rail_height))
        .child(
            // Subtle 1px vertical guide behind the ticks (matching `left-3 w-px bg-border/15`).
            div()
                .absolute()
                .top_0()
                .bottom_0()
                .left(px(4.0))
                .w(px(1.0))
                .bg(spine_color),
        );

    for (slot, &toc_idx) in sampled.iter().enumerate() {
        let entry = &toc[toc_idx];
        let is_in_view = active_toc_idx == Some(toc_idx);
        let is_hovered = resolved_hover == Some(slot);
        let distance = wave_center.map(|center| center.abs_diff(slot));
        let bar_w = tick_width_for_distance(distance);
        let bar_color = if is_hovered {
            tick_focus
        } else if is_in_view {
            tick_in_view
        } else if matches!(distance, Some(1)) {
            tick_near
        } else {
            tick_idle
        };
        let item_index = entry.item_index;

        ticks_stack = ticks_stack.child(
            div()
                .id(SharedString::from(format!(
                    "chat-toc-tick-{}",
                    entry.turn_number
                )))
                .a11y_button(
                    SharedString::from(format!("chat.toc.tick.{}", entry.turn_number)),
                    format!("Turn {}: {}", entry.turn_number, entry.preview),
                )
                .aria_selected(is_in_view)
                .flex()
                .flex_row()
                .items_center()
                .justify_start()
                .w(px(30.0))
                .h(px(TICK_ROW_HEIGHT_PX))
                .cursor_pointer()
                .on_hover(cx.listener(move |view, hovered, _, cx| {
                    view.set_toc_hovered_slot(slot, *hovered, cx);
                }))
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .on_click(cx.listener(move |view, _, _, cx| {
                    view.jump_to_toc_item(item_index, cx);
                }))
                .child(
                    // Web's strip: `transition-transform duration-150` (ease `cubic-bezier(.4,0,.2,1)`).
                    // A critically damped spring settles in about the same 150 ms and, unlike a
                    // timed tween, picks up from the current length when the target changes mid-flight.
                    div().h(px(2.0)).rounded_full().bg(bar_color).with_spring(
                        SharedString::from(format!("chat-toc-bar-{}", entry.turn_number)),
                        SpringAnimation::new(TICK_SPRING).to(bar_w),
                        |bar, width| bar.w(px(width)),
                    ),
                ),
        );
    }

    // Floating single-message preview card positioned directly beside the hovered tick.
    if let Some(slot) = resolved_hover
        && let Some(&toc_idx) = sampled.get(slot)
        && let Some(entry) = toc.get(toc_idx)
    {
        let popover_bg = hsla(tokens.popover);
        let border = hsla(tokens.shell_inner_border);
        let card_top =
            ((slot as f32) * TICK_ROW_HEIGHT_PX - 14.0).clamp(0.0, (rail_height - 36.0).max(0.0));

        let mut card = div()
            .id("chat-toc-preview")
            .absolute()
            .left(px(34.0))
            .top(px(card_top))
            .w(px(300.0))
            .rounded(px(12.0))
            .bg(popover_bg)
            .border_1()
            .border_color(border)
            .shadow_md()
            .px(px(12.0))
            .py(px(9.0))
            .flex()
            .flex_col()
            .gap(px(4.0))
            .occlude()
            .child(
                div()
                    .w_full()
                    .min_w_0()
                    .overflow_hidden()
                    .text_ellipsis()
                    .whitespace_nowrap()
                    .text_size(px(BODY_FONT_PX))
                    .line_height(px(20.0))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(fg)
                    .child(entry.preview.clone()),
            );

        if let Some(ref reply) = entry.assistant_preview {
            card = card.child(
                div()
                    .w_full()
                    .min_w_0()
                    .max_h(px(40.0))
                    .overflow_hidden()
                    .text_size(px(12.5))
                    .line_height(px(18.0))
                    .text_color(muted)
                    .child(reply.clone()),
            );
        }

        ticks_stack = ticks_stack.child(card);
    }

    let column = div()
        .id("chat-toc-column")
        .flex()
        .flex_col()
        .items_start()
        .gap(px(6.0))
        .on_hover(cx.listener(|view, hovered: &bool, _, cx| {
            if !*hovered {
                view.clear_toc_hover(cx);
            }
        }))
        .child(nav_btn(
            "chat-toc-prev",
            "chat.toc.prev",
            "Previous turn",
            "superhero/chevron-up.svg",
            prev_item,
            cx,
        ))
        .child(ticks_stack)
        .child(nav_btn(
            "chat-toc-next",
            "chat.toc.next",
            "Next turn",
            "superhero/chevron-down.svg",
            next_item,
            cx,
        ));

    Some(
        deferred(
            div()
                .absolute()
                .top_0()
                .bottom_0()
                .left(px(12.0))
                .flex()
                .flex_col()
                .justify_center()
                .child(column),
        )
        .with_priority(2)
        .into_any_element(),
    )
}

/// Renders the compact `↓ Latest` capsule when scrolled up away from the tail.
pub(super) fn render_scroll_to_bottom_pill(
    tokens: &Tokens,
    cx: &mut Context<'_, ChatView>,
) -> AnyElement {
    // Web's `Button variant="glass"` (`surface-glass`): `--background` at `--glass-opacity` (80%),
    // `border-border/60`, and on hover only the border firms up. The fill must not change on
    // hover, or the text behind shows through more than at rest. GPUI has no per-element backdrop
    // blur (gpui-kit#3598), so the fill stays opaque until it lands (Nick, 2026-11-23).
    let bg = hsla(tokens.background);
    let border = hsla_alpha(tokens.border, 0.60);
    let hover_border = hsla(tokens.border);
    let fg = hsla(tokens.foreground);
    let muted = hsla(tokens.muted_foreground);

    deferred(
        div()
            .absolute()
            .left_0()
            .right_0()
            .bottom(px(12.0))
            .flex()
            .flex_row()
            .justify_center()
            .child(
                div()
                    .id("chat-scroll-to-bottom")
                    .a11y_button("chat.scroll-to-bottom", "Jump to latest message")
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(5.0))
                    .h(px(28.0))
                    .px(px(11.0))
                    .rounded_full()
                    .bg(bg)
                    .border_1()
                    .border_color(border)
                    .shadow_md()
                    .cursor_pointer()
                    .text_size(px(12.0))
                    .line_height(px(16.0))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(fg)
                    .hover(move |s| s.border_color(hover_border))
                    .occlude()
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .on_click(cx.listener(|view, _, _, cx| {
                        view.scroll_to_latest(cx);
                    }))
                    .child(icons::icon("superhero/chevron-down.svg", 12.0, muted))
                    .child("Latest"),
            ),
    )
    .with_priority(2)
    .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sample_ticks_keeps_all_when_small_and_preserves_endpoints_and_active_when_large() {
        assert_eq!(sample_tick_indices(5, Some(2)), vec![0, 1, 2, 3, 4]);

        let sampled = sample_tick_indices(120, Some(37));
        assert_eq!(sampled.first().copied(), Some(0));
        assert_eq!(sampled.last().copied(), Some(119));
        assert!(sampled.contains(&37), "active turn must be visible on rail");
        assert!(sampled.len() <= MAX_VISIBLE_TICKS);
    }

    #[test]
    fn fisheye_tick_widths_match_conn_curve() {
        assert_eq!(tick_width_for_distance(Some(0)), 24.0);
        assert_eq!(tick_width_for_distance(Some(1)), 16.0);
        assert_eq!(tick_width_for_distance(Some(2)), 10.0);
        assert_eq!(tick_width_for_distance(Some(3)), 8.0);
        assert_eq!(tick_width_for_distance(None), 8.0);
    }
}
