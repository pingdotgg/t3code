//! Pending-approval card, in the subagent card's anatomy (`render_subagent_row`): header with
//! icon + heading + warning status, a compact command block, and a right-aligned action footer.

use conn_theme::Appearance;
use gpui_kit::{
    AnyElement, Context, FontWeight, InteractiveElement, IntoElement, MouseButton, ParentElement,
    SharedString, StatefulInteractiveElement, Styled, deferred, div, px,
};

use gpui_kit::prelude::FluentBuilder as _;

use super::approval_state::{ApprovalView, COLLAPSED_CHARS, COLLAPSED_LINES, clip};
use super::color::{hsla, muted_icon};
use super::{ChatEvent, ChatView, MONO_FONT_FAMILY, UI_FONT_PX, UI_LINE_HEIGHT_PX, icons};
use crate::a11y::ConnA11yExt as _;

/// Timeline code size (`WorkLogDetails` expanded body): `11.5px` / `18px` monospace.
const CODE_FONT_PX: f32 = 11.5;
const CODE_LINE_HEIGHT_PX: f32 = 18.0;

impl ChatView {
    /// Click handler that closes the More menu and answers the approval with `decision`.
    fn approval_listener(
        id: &str,
        decision: &'static str,
        cx: &mut Context<'_, Self>,
    ) -> impl Fn(&gpui_kit::ClickEvent, &mut gpui_kit::Window, &mut gpui_kit::App) + 'static {
        let entry_id = id.to_owned();
        cx.listener(move |view, _, _, cx| {
            view.expanded_ids
                .remove(&format!("{entry_id}:approval-more"));
            cx.emit(ChatEvent::Approval {
                entry_id: entry_id.clone(),
                decision: decision.to_owned(),
            });
        })
    }

    pub(super) fn render_approval_card(
        &self,
        id: &str,
        title: &str,
        detail: Option<&str>,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let view = ApprovalView::new(title, detail);
        let fg = hsla(self.tokens.foreground);
        let muted = hsla(self.tokens.muted_foreground);
        let warning = hsla(self.tokens.warning);
        // `warning` is too light for text on the light surface; the foreground variant reads in both.
        let warning_text = hsla(self.tokens.warning_foreground);
        let card_fill = match self.tokens.appearance {
            Appearance::Dark => hsla(
                self.tokens
                    .shell_highlight
                    .with_alpha(self.tokens.shell_highlight.a * 0.70),
            ),
            Appearance::Light => hsla(self.tokens.shell_card),
        };

        let header = div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(6.0))
            .w_full()
            .min_w_0()
            .child(icons::icon(icons::SHIELD_WARNING, 16.0, warning))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .text_size(px(UI_FONT_PX))
                    .line_height(px(UI_LINE_HEIGHT_PX))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(fg)
                    .child(view.heading),
            )
            .child(
                div()
                    .flex_none()
                    .text_size(px(UI_FONT_PX))
                    .line_height(px(16.0))
                    .text_color(warning_text)
                    .child("Needs approval"),
            );

        let mut card = div()
            .id(SharedString::from(format!("approval-{id}")))
            .a11y_group(
                format!("chat.approval.{id}"),
                format!("Needs approval: {}", title.trim()),
            )
            .flex()
            .flex_col()
            .gap(px(8.0))
            .w_full()
            .min_w_0()
            .rounded(px(8.0))
            .border_1()
            .border_color(hsla(self.tokens.shell_divider))
            .bg(card_fill)
            .px(px(9.0))
            .pt(px(10.0))
            .pb(px(9.0))
            .child(header);

        if let Some(command) = view.command.as_deref() {
            card =
                card.child(self.render_approval_command(id, command, view.wrapper.as_deref(), cx));
        }
        if let Some(note) = view.note.as_deref() {
            card = card.child(
                div()
                    .id(SharedString::from(format!("approval-note-{id}")))
                    .a11y_group(format!("chat.approval.{id}.note"), note.to_owned())
                    .pl(px(22.0))
                    .text_size(px(UI_FONT_PX))
                    .line_height(px(16.0))
                    .text_color(muted)
                    .child(note.to_owned()),
            );
        }

        let more_key = format!("{id}:approval-more");
        let more_open = self.expanded_ids.contains(&more_key);

        let mut more = div().relative().flex_none().child(
            self.ghost_button(&format!("approval-more-{id}"), "More", true, cx)
                .child(icons::icon(
                    icons::CARET_DOWN,
                    12.0,
                    muted_icon(&self.tokens),
                ))
                .on_click({
                    let key = more_key;
                    cx.listener(move |view, _, _, cx| view.toggle_expanded(&key, cx))
                }),
        );
        if more_open {
            more = more.child(
                deferred(
                    div()
                        .absolute()
                        .bottom_full()
                        .left_0()
                        .mb(px(4.0))
                        .child(self.render_approval_more_menu(id, cx)),
                )
                .with_priority(2),
            );
        }

        let footer = div()
            .flex()
            .flex_row()
            .flex_wrap()
            .items_center()
            .justify_end()
            .gap(px(8.0))
            .child(more)
            .child(
                self.outline_button(&format!("approval-decline-{id}"), "Decline")
                    .on_click(Self::approval_listener(id, "decline", cx)),
            )
            .child(
                self.primary_button(&format!("approval-approve-{id}"), "Approve", true)
                    .on_click(Self::approval_listener(id, "accept", cx)),
            );

        div()
            .w_full()
            .min_w_0()
            .pb(px(8.0))
            // A held approval is not answerable yet (`isVisiblePendingApproval`).
            .child(card.when(!self.approval_held(id), |card| card.child(footer)))
            .into_any_element()
    }

    /// Wrapper (muted) over the command in monospace, clipped to a few lines with show more/less.
    fn render_approval_command(
        &self,
        id: &str,
        command: &str,
        wrapper: Option<&str>,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let muted = hsla(self.tokens.muted_foreground);
        let key = format!("{id}:approval-command");
        let expanded = self.expanded_ids.contains(&key);
        let clipped = clip(command, COLLAPSED_LINES, COLLAPSED_CHARS);
        let shown = if expanded {
            command.to_owned()
        } else {
            clipped.text
        };

        let mut code = div()
            .flex()
            .flex_col()
            .gap(px(2.0))
            .font_family(MONO_FONT_FAMILY)
            .text_size(px(CODE_FONT_PX))
            .line_height(px(CODE_LINE_HEIGHT_PX));
        if let Some(wrapper) = wrapper {
            code = code.child(div().text_color(muted).child(wrapper.to_owned()));
        }
        code = code.child(div().text_color(hsla(self.tokens.foreground)).child(
            if clipped.truncated && !expanded {
                format!("{shown} …")
            } else {
                shown
            },
        ));
        let mut block = div()
            .flex()
            .flex_col()
            .gap(px(4.0))
            .flex_1()
            .min_w_0()
            .child(code);
        if clipped.truncated {
            let toggle = key;
            block = block.child(
                div()
                    .id(SharedString::from(format!("approval-command-toggle-{id}")))
                    .a11y_button(
                        SharedString::from(format!("chat.approval.command.{id}")),
                        if expanded {
                            "Show less"
                        } else {
                            "Show full command"
                        },
                    )
                    .text_size(px(12.0))
                    .line_height(px(16.0))
                    .text_color(muted)
                    .cursor_pointer()
                    .hover({
                        let fg = hsla(self.tokens.foreground);
                        move |s| s.text_color(fg)
                    })
                    .on_click(cx.listener(move |view, _, _, cx| view.toggle_expanded(&toggle, cx)))
                    .child(if expanded { "Show less" } else { "Show more" }),
            );
        }

        div()
            .id(SharedString::from(format!("approval-command-{id}")))
            .a11y_group(
                format!("chat.approval.{id}.command"),
                "Command awaiting approval",
            )
            .flex()
            .flex_row()
            .items_start()
            .gap(px(8.0))
            .w_full()
            .min_w_0()
            .px(px(10.0))
            .py(px(8.0))
            .rounded(px(8.0))
            .border_1()
            .border_color(hsla(self.tokens.shell_divider))
            .bg(hsla(self.tokens.code_background))
            .child(block)
            .child(self.render_copy_button(
                &format!("approval-{id}"),
                "Copy command",
                command.to_owned(),
                cx,
            ))
            .into_any_element()
    }

    /// Web's "More" items: everything except Approve and Decline.
    fn render_approval_more_menu(&self, id: &str, cx: &mut Context<'_, Self>) -> AnyElement {
        let fg = hsla(self.tokens.foreground);
        let hover_bg = hsla(self.tokens.shell_highlight);
        let item =
            |key: &str, label: &'static str, decision: &'static str, cx: &mut Context<'_, Self>| {
                div()
                    .id(SharedString::from(format!("approval-{key}-{id}")))
                    .a11y_button(
                        SharedString::from(format!("chat.approval.{key}.{id}")),
                        label,
                    )
                    .flex()
                    .items_center()
                    .h(px(28.0))
                    .px(px(8.0))
                    .rounded(px(6.0))
                    .whitespace_nowrap()
                    .text_size(px(UI_FONT_PX))
                    .text_color(fg)
                    .cursor_pointer()
                    .hover(move |s| s.bg(hover_bg))
                    .on_click(Self::approval_listener(id, decision, cx))
                    .child(label)
            };
        div()
            .id("approval-more-menu")
            .a11y(
                gpui_kit::Role::Menu,
                format!("chat.approval.{id}.more-menu"),
                "More approval options",
            )
            .rounded(px(10.0))
            .bg(hsla(self.tokens.popover))
            .border_1()
            .border_color(hsla(self.tokens.shell_inner_border))
            .shadow_md()
            .p(px(4.0))
            .occlude()
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .child(item(
                "session",
                "Always allow this session",
                "acceptForSession",
                cx,
            ))
            .child(item("cancel", "Cancel", "cancel", cx))
            .into_any_element()
    }
}
