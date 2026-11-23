//! Approvals of child threads (subagents, side chats, delegated tasks), shown above the
//! composer of their parent (`ChildThreadApprovals.tsx` + `ComposerPendingApprovalActions`
//! with `presentation="inline"`).

use conn_contract::{
    OrchestrationV2TurnItemApprovalRequestFullAccessOverride as FullAccessOverride,
    ProviderApprovalDecision,
};
use gpui_kit::{
    AnyElement, Context, FontWeight, InteractiveElement, IntoElement, MouseButton, ParentElement,
    SharedString, StatefulInteractiveElement, Styled, deferred, div, px,
};

use gpui_kit::prelude::FluentBuilder as _;

use super::color::hsla;
use super::{ChatEvent, ChatView, MONO_FONT_FAMILY, UI_FONT_PX, UI_LINE_HEIGHT_PX, icons};
use crate::a11y::ConnA11yExt as _;

/// `max-h-40` of the command block.
const COMMAND_MAX_HEIGHT_PX: f32 = 160.0;
/// `max-h-80` of the list of cards.
const LIST_MAX_HEIGHT_PX: f32 = 320.0;
const GONE_NOTE: &str =
    "Provider process is gone. Interrupt or restart the child thread to respond.";

/// One answer a card offers: the decision sent to the child and its label.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ApprovalChoice {
    pub decision: &'static str,
    pub label: String,
    pub warning: Option<String>,
}

/// One pending approval of a child thread, ready to draw.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ChildApprovalCard {
    pub thread_id: String,
    pub request_id: String,
    /// The child's title.
    pub title: String,
    /// The command (or request kind) to approve.
    pub detail: String,
    pub app_name: Option<String>,
    pub reason: Option<String>,
    pub full_access_note: Option<&'static str>,
    /// The provider session still waits for the answer.
    pub answerable: bool,
    pub responding: bool,
    pub error: Option<String>,
    pub choices: Vec<ApprovalChoice>,
}

impl ChildApprovalCard {
    pub(crate) fn new(
        approval: &conn_state::ChildApproval,
        responding: bool,
        error: Option<String>,
    ) -> Self {
        let details = &approval.details;
        let choices = match &details.options {
            Some(options) => options
                .iter()
                .map(|option| ApprovalChoice {
                    decision: decision_wire(option.decision),
                    label: option.label.clone(),
                    warning: option.warning.clone(),
                })
                .collect(),
            None => default_choices(),
        };
        Self {
            thread_id: approval.thread_id.clone(),
            request_id: approval.request_id.clone(),
            title: approval.title.clone(),
            detail: approval.detail.clone(),
            app_name: details.app_name.clone(),
            reason: details.reason.clone(),
            full_access_note: details.full_access_override.map(full_access_note),
            answerable: approval.answerable,
            responding,
            error,
            choices,
        }
    }

    /// The Decline and Approve answers, in the provider's order.
    fn primary(&self) -> impl Iterator<Item = &ApprovalChoice> {
        self.choices
            .iter()
            .filter(|c| matches!(c.decision, "decline" | "accept"))
    }

    /// Everything else, behind More.
    fn more(&self) -> Vec<&ApprovalChoice> {
        self.choices
            .iter()
            .filter(|c| !matches!(c.decision, "decline" | "accept"))
            .collect()
    }
}

/// `DEFAULT_APPROVAL_OPTIONS`.
fn default_choices() -> Vec<ApprovalChoice> {
    [
        ("cancel", "Cancel"),
        ("decline", "Decline"),
        ("acceptForSession", "Always allow this session"),
        ("accept", "Approve"),
    ]
    .into_iter()
    .map(|(decision, label)| ApprovalChoice {
        decision,
        label: label.to_owned(),
        warning: None,
    })
    .collect()
}

/// The decision as `runtime-request.respond` spells it.
fn decision_wire(decision: ProviderApprovalDecision) -> &'static str {
    match decision {
        ProviderApprovalDecision::Accept => "accept",
        ProviderApprovalDecision::AcceptForSession => "acceptForSession",
        ProviderApprovalDecision::AcceptAlways => "acceptAlways",
        ProviderApprovalDecision::Decline => "decline",
        ProviderApprovalDecision::Cancel => "cancel",
    }
}

/// `fullAccessOverrideExplanation`, with the app name filled in.
fn full_access_note(override_kind: FullAccessOverride) -> &'static str {
    match override_kind {
        FullAccessOverride::AskRule => {
            "Full access skips approvals, but an ask rule in the agent's own settings matches this action, so it still asks. Remove or narrow that rule to stop these prompts."
        }
        FullAccessOverride::ProviderCheck => {
            "Full access skips approvals, but the agent still stops for a few safety checks of its own that no setting can skip, such as a delete whose path it can't verify. Conn can't turn these off, so check the request and approve it if it's what you expect."
        }
    }
}

impl ChatView {
    /// The cards of the open thread's children, replaced whole on every sync.
    pub(crate) fn set_child_approvals(
        &mut self,
        cards: Vec<ChildApprovalCard>,
        cx: &mut Context<'_, Self>,
    ) {
        if self.child_approvals == cards {
            return;
        }
        let open: std::collections::HashSet<&str> =
            cards.iter().map(|c| c.request_id.as_str()).collect();
        self.expanded_ids.retain(|id| {
            id.strip_prefix("child-approval-more:")
                .is_none_or(|request_id| open.contains(request_id))
        });
        self.child_approvals = cards;
        cx.notify();
    }

    /// `ChildThreadApprovals`: one card per pending approval, above the composer.
    pub(super) fn render_child_approvals(&self, cx: &mut Context<'_, Self>) -> Option<AnyElement> {
        if self.child_approvals.is_empty() {
            return None;
        }
        let mut list = div()
            .id("child-approvals")
            .a11y_group("chat.child-approvals", "Approvals from child threads")
            .flex()
            .flex_col()
            .gap(px(8.0))
            .w_full()
            .max_h(px(LIST_MAX_HEIGHT_PX))
            .mb(px(8.0))
            .overflow_y_scroll();
        for card in &self.child_approvals {
            list = list.child(self.render_child_approval(card, cx));
        }
        Some(list.into_any_element())
    }

    fn render_child_approval(
        &self,
        card: &ChildApprovalCard,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let fg = hsla(self.tokens.foreground);
        let muted = hsla(self.tokens.muted_foreground);
        let request = card.request_id.as_str();
        let enabled = card.answerable && !card.responding;

        let mut section = div()
            .id(SharedString::from(format!("child-approval-{request}")))
            .a11y_group(
                format!("chat.child-approval.{request}"),
                format!("Approval from {}", card.title),
            )
            .flex()
            .flex_col()
            .flex_none()
            .w_full()
            .min_w_0()
            .rounded(px(8.0))
            .border_1()
            .border_color(hsla(self.tokens.shell_divider))
            .bg(hsla(self.tokens.background))
            .p(px(12.0))
            .text_size(px(UI_FONT_PX))
            .line_height(px(UI_LINE_HEIGHT_PX))
            .text_color(fg)
            .child(
                div()
                    .mb(px(8.0))
                    .font_weight(FontWeight::MEDIUM)
                    .child(format!("Approval needed from {}", card.title)),
            )
            .child(
                div()
                    .id(SharedString::from(format!(
                        "child-approval-command-{request}"
                    )))
                    .a11y_group(
                        format!("chat.child-approval.{request}.command"),
                        "Command awaiting approval",
                    )
                    .max_h(px(COMMAND_MAX_HEIGHT_PX))
                    .overflow_y_scroll()
                    .font_family(MONO_FONT_FAMILY)
                    .child(card.detail.clone()),
            );

        let note = |text: String| div().mt(px(8.0)).text_color(muted).child(text);
        if let Some(app_name) = &card.app_name {
            section = section.child(note(app_name.clone()));
        }
        if !card.answerable {
            section = section.child(
                div()
                    .mt(px(8.0))
                    // `warning` is too light for text on the light surface.
                    .text_color(hsla(self.tokens.warning_foreground))
                    .child(GONE_NOTE),
            );
        }
        if let Some(reason) = &card.reason {
            section = section.child(note(reason.clone()));
        }
        if let Some(text) = card.full_access_note {
            section = section.child(note(text.to_owned()));
        }

        let mut actions = div().flex().flex_row().flex_wrap().gap(px(8.0)).mt(px(8.0));
        for choice in card.primary() {
            actions = actions.child(self.child_approval_button(card, choice, enabled, cx));
        }
        let more = card.more();
        if !more.is_empty() {
            let key = format!("child-approval-more:{request}");
            let open = self.expanded_ids.contains(&key);
            let toggle = cx.listener(move |view, _, _, cx| view.toggle_expanded(&key, cx));
            let mut menu_anchor = div().relative().flex_none().child(
                self.inline_button(
                    format!("child-approval-more-{request}"),
                    format!("chat.child-approval.{request}.more"),
                    "More",
                    true,
                    enabled,
                )
                .when(enabled, move |button| button.on_click(toggle)),
            );
            if open && enabled {
                menu_anchor = menu_anchor.child(
                    deferred(
                        div()
                            .absolute()
                            .bottom_full()
                            .right_0()
                            .mb(px(4.0))
                            .child(self.render_child_approval_menu(card, &more, cx)),
                    )
                    .with_priority(2),
                );
            }
            actions = actions.child(menu_anchor);
        }
        section = section.child(actions);

        if let Some(error) = &card.error {
            section = section.child(
                div()
                    .id(SharedString::from(format!(
                        "child-approval-error-{request}"
                    )))
                    .a11y_group(
                        format!("chat.child-approval.{request}.error"),
                        error.clone(),
                    )
                    .mt(px(8.0))
                    .text_color(hsla(self.tokens.destructive))
                    .child(error.clone()),
            );
        }
        section.into_any_element()
    }

    /// An answer button: Decline in muted text, Approve in foreground (`InlineButton`).
    fn child_approval_button(
        &self,
        card: &ChildApprovalCard,
        choice: &ApprovalChoice,
        enabled: bool,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let request = card.request_id.as_str();
        let listener = Self::child_approval_listener(card, choice.decision, cx);
        let mut button = self
            .inline_button(
                format!("child-approval-{}-{request}", choice.decision),
                format!("chat.child-approval.{request}.{}", choice.decision),
                &choice.label,
                choice.decision != "accept",
                enabled,
            )
            .when(enabled, move |button| button.on_click(listener));
        if choice.warning.is_some() {
            button = button.child(icons::icon(
                icons::SHIELD_WARNING,
                12.0,
                hsla(self.tokens.warning_foreground),
            ));
        }
        button.into_any_element()
    }

    /// Web's `InlineButton`: `font-medium` text, muted or foreground, underlined on hover.
    fn inline_button(
        &self,
        key: String,
        ax_id: String,
        label: &str,
        muted_tone: bool,
        enabled: bool,
    ) -> gpui_kit::Stateful<gpui_kit::Div> {
        let fg = hsla(self.tokens.foreground);
        let color = if muted_tone {
            hsla(self.tokens.muted_foreground)
        } else {
            fg
        };
        div()
            .id(SharedString::from(key))
            .a11y_button(ax_id, label.to_owned())
            .flex()
            .flex_row()
            .flex_none()
            .items_center()
            .gap(px(2.0))
            .font_weight(FontWeight::MEDIUM)
            .whitespace_nowrap()
            .text_color(color)
            .when(enabled, move |d| {
                d.cursor_pointer()
                    .hover(move |s| s.text_color(fg).underline())
            })
            .when(!enabled, |d| d.opacity(0.64))
            .child(label.to_owned())
    }

    fn child_approval_listener(
        card: &ChildApprovalCard,
        decision: &'static str,
        cx: &mut Context<'_, Self>,
    ) -> impl Fn(&gpui_kit::ClickEvent, &mut gpui_kit::Window, &mut gpui_kit::App) + 'static {
        let thread_id = card.thread_id.clone();
        let request_id = card.request_id.clone();
        cx.listener(move |view, _, _, cx| {
            view.expanded_ids
                .remove(&format!("child-approval-more:{request_id}"));
            cx.emit(ChatEvent::ChildApproval {
                thread_id: thread_id.clone(),
                request_id: request_id.clone(),
                decision: decision.to_owned(),
            });
        })
    }

    /// Menu of the answers behind More.
    fn render_child_approval_menu(
        &self,
        card: &ChildApprovalCard,
        more: &[&ApprovalChoice],
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let request = card.request_id.as_str();
        let fg = hsla(self.tokens.foreground);
        let hover_bg = hsla(self.tokens.shell_highlight);
        let mut menu = div()
            .id(SharedString::from(format!("child-approval-menu-{request}")))
            .a11y(
                gpui_kit::Role::Menu,
                format!("chat.child-approval.{request}.more-menu"),
                "More approval options",
            )
            .rounded(px(10.0))
            .bg(hsla(self.tokens.popover))
            .border_1()
            .border_color(hsla(self.tokens.shell_inner_border))
            .shadow_md()
            .p(px(4.0))
            .occlude()
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation());
        for choice in more {
            menu = menu.child(
                div()
                    .id(SharedString::from(format!(
                        "child-approval-{}-{request}",
                        choice.decision
                    )))
                    .a11y_button(
                        format!("chat.child-approval.{request}.{}", choice.decision),
                        choice.label.clone(),
                    )
                    .flex()
                    .items_center()
                    .gap(px(4.0))
                    .min_h(px(28.0))
                    .px(px(8.0))
                    .rounded(px(6.0))
                    .whitespace_nowrap()
                    .text_size(px(UI_FONT_PX))
                    .text_color(fg)
                    .cursor_pointer()
                    .hover(move |s| s.bg(hover_bg))
                    .on_click(Self::child_approval_listener(card, choice.decision, cx))
                    .when(choice.warning.is_some(), |item| {
                        item.child(icons::icon(
                            icons::SHIELD_WARNING,
                            12.0,
                            hsla(self.tokens.warning_foreground),
                        ))
                    })
                    .child(choice.label.clone()),
            );
        }
        menu.into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use conn_state::ApprovalDetails;

    fn approval(details: ApprovalDetails) -> conn_state::ChildApproval {
        conn_state::ChildApproval {
            thread_id: "child".to_owned(),
            title: "Review #278".to_owned(),
            request_id: "req".to_owned(),
            detail: "rm -rf target".to_owned(),
            details,
            answerable: true,
        }
    }

    fn details(options: Option<Vec<conn_contract::ProviderApprovalOption>>) -> ApprovalDetails {
        ApprovalDetails {
            request_kind: conn_contract::ProviderRequestKind::Command,
            prompt: Some("rm -rf target".to_owned()),
            reason: None,
            full_access_override: None,
            app_name: None,
            options,
        }
    }

    #[test]
    fn default_options_show_decline_and_approve_with_the_rest_behind_more() {
        let card = ChildApprovalCard::new(&approval(details(None)), false, None);
        let primary: Vec<_> = card.primary().map(|c| c.label.as_str()).collect();
        let more: Vec<_> = card.more().iter().map(|c| c.label.clone()).collect();
        assert_eq!(primary, ["Decline", "Approve"]);
        assert_eq!(more, ["Cancel", "Always allow this session"]);
    }

    #[test]
    fn provider_options_keep_their_own_labels_and_wire_decisions() {
        let option = |decision, label: &str| conn_contract::ProviderApprovalOption {
            decision,
            label: label.to_owned(),
            warning: None,
        };
        let card = ChildApprovalCard::new(
            &approval(details(Some(vec![
                option(ProviderApprovalDecision::AcceptAlways, "Always"),
                option(ProviderApprovalDecision::Accept, "Yes"),
                option(ProviderApprovalDecision::Decline, "No"),
            ]))),
            false,
            Some("boom".to_owned()),
        );
        let primary: Vec<_> = card
            .primary()
            .map(|c| (c.decision, c.label.as_str()))
            .collect();
        assert_eq!(primary, [("accept", "Yes"), ("decline", "No")]);
        assert_eq!(card.more()[0].decision, "acceptAlways");
        assert_eq!(card.error.as_deref(), Some("boom"));
    }
}
