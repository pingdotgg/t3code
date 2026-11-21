//! Conn-styled bottom composer card built on `gpui-kit`'s `Textarea`.

use conn_theme::Tokens;
use gpui_kit::component::input::{Textarea, TextareaState};
use gpui_kit::{
    AnyElement, Context, Entity, InteractiveElement, IntoElement, ParentElement,
    StatefulInteractiveElement, Styled, div, px,
};

use super::ChatView;
use super::color::{hsla, hsla_alpha};
use super::icons;

pub(super) const COMPOSER_PLACEHOLDER: &str = "Ask anything. @ files, $ skills, / commands";
pub(super) const COMPOSER_MIN_LINES: usize = 1;
pub(super) const COMPOSER_MAX_LINES: usize = 8;

/// Renders the Conn rounded composer card inside the chat lane.
pub(super) fn render_composer(
    textarea: &Entity<TextareaState>,
    model_label: &str,
    has_text: bool,
    working: bool,
    tokens: &Tokens,
    cx: &mut Context<'_, ChatView>,
) -> AnyElement {
    let action_btn = if working {
        div()
            .id("chat-composer-stop")
            .flex()
            .items_center()
            .justify_center()
            .size(px(32.0))
            .rounded_full()
            .cursor_pointer()
            .bg(hsla(tokens.primary))
            .hover(|s| s.bg(hsla_alpha(tokens.primary, 0.88)))
            .on_click(cx.listener(|view, _, _, cx| {
                view.emit_stop(cx);
            }))
            .child(icons::icon(
                icons::SQUARE,
                13.0,
                hsla(tokens.primary_foreground),
            ))
            .into_any_element()
    } else if has_text {
        div()
            .id("chat-composer-send")
            .flex()
            .items_center()
            .justify_center()
            .size(px(32.0))
            .rounded_full()
            .cursor_pointer()
            .bg(hsla(tokens.primary))
            .hover(|s| s.bg(hsla_alpha(tokens.primary, 0.88)))
            .on_click(cx.listener(|view, _, window, cx| {
                view.submit_composer(window, cx);
            }))
            .child(icons::icon(
                icons::ARROW_UP,
                15.0,
                hsla(tokens.primary_foreground),
            ))
            .into_any_element()
    } else {
        div()
            .id("chat-composer-send-disabled")
            .flex()
            .items_center()
            .justify_center()
            .size(px(32.0))
            .rounded_full()
            .bg(hsla_alpha(tokens.primary, 0.35))
            .child(icons::icon(
                icons::ARROW_UP,
                15.0,
                hsla_alpha(tokens.primary_foreground, 0.65),
            ))
            .into_any_element()
    };

    let model_chip = div()
        .flex()
        .flex_row()
        .items_center()
        .gap(px(6.0))
        .px(px(8.0))
        .py(px(4.0))
        .rounded(px(8.0))
        .text_size(px(13.0))
        .line_height(px(20.0))
        .text_color(hsla(tokens.muted_foreground))
        .child(icons::icon(
            icons::SPARKLE,
            14.0,
            hsla(tokens.muted_foreground),
        ))
        .child(model_label.to_owned());

    div()
        .w_full()
        .rounded(px(18.0))
        .bg(hsla(tokens.shell_field))
        .border_1()
        .border_color(hsla(tokens.shell_divider_header))
        .overflow_hidden()
        .child(
            div().px(px(14.0)).pt(px(12.0)).pb(px(6.0)).child(
                Textarea::new(textarea)
                    .appearance(false)
                    .bordered(false)
                    .text_size(px(14.0))
                    .text_color(hsla(tokens.foreground)),
            ),
        )
        .child(
            div()
                .flex()
                .flex_row()
                .items_center()
                .justify_between()
                .px(px(10.0))
                .pb(px(10.0))
                .pt(px(2.0))
                .child(model_chip)
                .child(action_btn),
        )
        .into_any_element()
}
