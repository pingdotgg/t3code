//! The request stack above the composer: every request that waits for an answer (approvals of the
//! thread and of its children, questions, secret requests) as one card, with up to two cards
//! showing behind it for the requests that wait their turn. Styled after the mobile composer
//! panels of the approved desktop lab, with the desktop's 16px radius.
//!
//! The order is stable: a request keeps its slot until it is answered, and a new one joins at the
//! back, so the card under the pointer never changes into another request.

use conn_theme::{Appearance, Rgba, Tokens, color_mix_oklab};
use gpui_kit::TestSupportExt as _;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    AnyElement, Context, FontWeight, Hsla, InteractiveElement, IntoElement, MouseButton,
    ParentElement, SharedString, StatefulInteractiveElement, Styled, Window, deferred, div, px,
};

use super::approval_state::ApprovalView;
use super::child_approvals::{ApprovalChoice, ChildApprovalCard, GONE_NOTE};
use super::color::{chat_page, composite_over, hsla, hsla_alpha};
use super::{ChatEvent, ChatView, MONO_FONT_FAMILY, UI_FONT_PX, UI_LINE_HEIGHT_PX, icons};
use crate::a11y::ConnA11yExt as _;

/// The desktop composer's corner radius, which the panels share.
const PANEL_RADIUS_PX: f32 = 16.0;
/// Space between the panel's edge and its header, body and actions.
const PANEL_INSET_PX: f32 = 3.0;
/// How far each card behind the current one shows above it.
const LAYER_STEP_PX: f32 = 6.0;
/// Most cards that show behind the current one.
const MAX_BACK_LAYERS: usize = 2;
/// Height a panel's header, footer and padding take from its share of the window.
const PANEL_CHROME_PX: f32 = 120.0;

/// One request in the stack.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum RequestKey {
    /// An approval of the open thread, by timeline entry.
    Approval(String),
    /// A question of the open thread, by timeline entry.
    Question(String),
    /// A secret request of the open thread, by timeline entry.
    Secret(String),
    /// An approval of a child thread, by request id.
    Child(String),
}

/// Keeps the requests in the order they arrived.
#[derive(Debug, Default)]
pub(super) struct RequestOrder {
    known: Vec<RequestKey>,
}

impl RequestOrder {
    /// Takes the requests that wait now, in any order. Answered ones leave, new ones join at the
    /// back in the order given, and the rest keep their places.
    pub(super) fn sync(&mut self, present: &[RequestKey]) -> Vec<RequestKey> {
        self.known.retain(|key| present.contains(key));
        for key in present {
            if !self.known.contains(key) {
                self.known.push(key.clone());
            }
        }
        self.known.clone()
    }
}

/// Cards that show behind the current one for `total` waiting requests.
pub(super) fn back_layers(total: usize) -> usize {
    total.saturating_sub(1).min(MAX_BACK_LAYERS)
}

/// True when `cards` holds the approval of timeline entry `entry_id`.
pub(super) fn has_own_approval(cards: &[ChildApprovalCard], entry_id: &str) -> bool {
    cards
        .iter()
        .any(|card| card.entry_id.as_deref() == Some(entry_id))
}

/// Room the composer and the window's top edge keep from the stack.
const COMPOSER_ALLOWANCE_PX: f32 = 240.0;
/// Smallest body a panel keeps, so a compact window still shows some content.
const MIN_BODY_PX: f32 = 80.0;

/// How tall a panel's scrolling body may grow: the panel stays within 65% of the window, and in
/// a compact window it leaves room for the composer, so the header stays on screen.
pub(super) fn request_body_max(window: &Window) -> f32 {
    body_max_for(f32::from(window.viewport_size().height))
}

fn body_max_for(viewport_height: f32) -> f32 {
    let share = viewport_height * 0.65 - PANEL_CHROME_PX;
    let free = viewport_height - COMPOSER_ALLOWANCE_PX - PANEL_CHROME_PX;
    share.min(free).clamp(MIN_BODY_PX, 520.0)
}

#[cfg(test)]
impl ChatView {
    /// The requests waiting, and how many cards show behind the current one.
    pub(crate) fn request_stack_for_test(&self) -> (usize, usize) {
        (
            self.request_stack.len(),
            back_layers(self.request_stack.len()),
        )
    }
}

/// The surfaces of a panel.
#[derive(Clone, Copy)]
pub(super) struct PanelColors {
    pub page: Rgba,
    pub surface: Rgba,
    /// Fill of the body that holds the content.
    pub inner: Rgba,
    pub edge: Hsla,
}

pub(super) fn panel_colors(tokens: &Tokens) -> PanelColors {
    let white = Rgba::new(1.0, 1.0, 1.0, 1.0);
    let page = chat_page(tokens);
    match tokens.appearance {
        Appearance::Dark => {
            let surface = composite_over(tokens.shell_raised, page);
            PanelColors {
                page,
                surface,
                inner: color_mix_oklab(surface, 0.94, white),
                edge: hsla_alpha(tokens.foreground, 0.05),
            }
        }
        Appearance::Light => PanelColors {
            page,
            surface: color_mix_oklab(page, 0.94, tokens.foreground),
            inner: color_mix_oklab(white, 0.97, tokens.foreground),
            edge: hsla(white.with_alpha(0.45)),
        },
    }
}

impl ChatView {
    /// Reads the thread's own requests and approval cards after a sync.
    pub(super) fn sync_incoming_requests(&mut self, thread: &conn_state::ThreadState) {
        let pending = thread.pending_approvals();
        self.own_approvals = pending
            .iter()
            .filter_map(|approval| {
                let (command, hint) = thread.entries.iter().find_map(|entry| match entry {
                    conn_state::TimelineEntry::Approval { id, title, detail }
                        if *id == approval.entry_id =>
                    {
                        Some((title.as_str(), detail.as_deref()))
                    }
                    _ => None,
                })?;
                Some(ChildApprovalCard::own(
                    &thread.thread_id,
                    approval,
                    command,
                    hint,
                    thread.approval_details(&approval.entry_id),
                ))
            })
            .collect();
        self.incoming_requests = thread
            .entries
            .iter()
            .filter_map(|entry| match entry {
                conn_state::TimelineEntry::Approval { id, .. } => pending
                    .iter()
                    .find(|approval| approval.entry_id == *id)
                    .map(|approval| {
                        (
                            RequestKey::Approval(id.clone()),
                            Some(approval.request_id.clone()),
                        )
                    }),
                conn_state::TimelineEntry::UserInputRequest {
                    id,
                    request_id,
                    pending: true,
                    ..
                } => Some((RequestKey::Question(id.clone()), Some(request_id.clone()))),
                conn_state::TimelineEntry::SecretRequest {
                    id, pending: true, ..
                } => Some((RequestKey::Secret(id.clone()), None)),
                _ => None,
            })
            .collect();
        self.approval_responding
            .retain(|entry_id| has_own_approval(&self.own_approvals, entry_id));
        self.approval_errors
            .retain(|entry_id, _| has_own_approval(&self.own_approvals, entry_id));
    }

    /// Lays the stack out again from the waiting requests, and tells the composer whether the
    /// current request is a question, so a send answers only a question the user sees.
    pub(super) fn refresh_request_stack(&mut self) {
        let held = self.typing_guard.held();
        let mut present: Vec<RequestKey> = self
            .incoming_requests
            .iter()
            .filter(|(_, request_id)| request_id.as_ref().is_none_or(|id| !held.contains(id)))
            .map(|(key, _)| key.clone())
            .collect();
        present.extend(
            self.child_approvals
                .iter()
                .map(|card| RequestKey::Child(card.request_id.clone())),
        );
        self.request_stack = self.request_order.sync(&present);
        self.pending_question_id = match self.request_stack.first() {
            Some(RequestKey::Question(entry_id)) => Some(entry_id.clone()),
            _ => None,
        };
        let open: Vec<&str> = self
            .own_approvals
            .iter()
            .chain(self.child_approvals.iter())
            .map(|card| card.request_id.as_str())
            .collect();
        self.expanded_ids.retain(|id| {
            id.strip_prefix(APPROVAL_MORE_PREFIX)
                .is_none_or(|request_id| open.contains(&request_id))
        });
    }

    /// The stack above the composer: the current request as a card with the waiting ones behind
    /// it. `None` while nothing waits for an answer.
    pub(super) fn render_request_stack(
        &mut self,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) -> Option<AnyElement> {
        let current = self.request_stack.first()?.clone();
        let total = self.request_stack.len();
        let body_max = request_body_max(window);
        let panel = match &current {
            RequestKey::Approval(entry_id) => {
                let card = self
                    .own_approvals
                    .iter()
                    .find(|card| card.entry_id.as_deref() == Some(entry_id.as_str()))?
                    .clone();
                self.render_approval_panel(&card, body_max, cx)
            }
            RequestKey::Child(request_id) => {
                let card = self
                    .child_approvals
                    .iter()
                    .find(|card| card.request_id == *request_id)?
                    .clone();
                self.render_approval_panel(&card, body_max, cx)
            }
            RequestKey::Question(_) => self.render_question_panel(window, body_max, cx)?,
            RequestKey::Secret(entry_id) => self.render_secret_panel(entry_id, body_max, cx)?,
        };
        Some(self.request_deck(panel, total))
    }

    /// The current card with its back layers peeking out above it.
    fn request_deck(&self, panel: AnyElement, total: usize) -> AnyElement {
        let colors = panel_colors(&self.tokens);
        let layers = back_layers(total);
        let layer = |inset: f32, top: f32, bottom: f32, weight: f32| {
            div()
                .absolute()
                .left(px(inset))
                .right(px(inset))
                .top(px(top))
                .bottom(px(bottom))
                .rounded(px(PANEL_RADIUS_PX))
                .border_t_1()
                .border_color(colors.edge)
                .bg(hsla(color_mix_oklab(colors.surface, weight, colors.page)))
        };
        let mut deck = div()
            .id("request-stack")
            .a11y_group(
                "chat.request-stack",
                if total == 1 {
                    "1 request waiting".to_owned()
                } else {
                    format!("{total} requests waiting")
                },
            )
            .relative()
            .flex()
            .flex_col()
            .w_full()
            .min_w_0()
            .mb(px(8.0))
            .pt(px(LAYER_STEP_PX * layers as f32));
        if layers >= 2 {
            deck = deck.child(layer(16.0, 0.0, 2.0 * LAYER_STEP_PX, 0.70));
        }
        if layers >= 1 {
            let top = if layers == 1 { 0.0 } else { LAYER_STEP_PX };
            deck = deck.child(layer(8.0, top, LAYER_STEP_PX, 0.85));
        }
        deck.child(panel).into_any_element()
    }

    /// A panel of the stack: header, scrolling body and actions, with the panel's surface and
    /// edge. `inner` is the fill of the body.
    #[expect(
        clippy::too_many_arguments,
        reason = "the panel's parts are its own values"
    )]
    pub(super) fn request_panel(
        &self,
        id: SharedString,
        ax_id: SharedString,
        ax_label: SharedString,
        icon: &'static str,
        title: &str,
        trailing: Option<AnyElement>,
        body: AnyElement,
        actions: AnyElement,
        inner: Hsla,
    ) -> gpui_kit::Stateful<gpui_kit::Div> {
        let colors = panel_colors(&self.tokens);
        let muted = hsla(self.tokens.muted_foreground);
        let header = div()
            .flex()
            .flex_row()
            .flex_none()
            .items_center()
            .gap(px(8.0))
            .min_h(px(30.0))
            .px(px(17.0))
            .py(px(10.0))
            .text_size(px(13.0))
            .line_height(px(16.0))
            .font_weight(FontWeight::MEDIUM)
            .text_color(muted)
            .child(icons::icon(icon, 14.0, muted))
            .child(div().flex_none().child(title.to_owned()))
            .when_some(trailing, |header, trailing| {
                header.child(
                    div()
                        .flex()
                        .flex_row()
                        .flex_1()
                        .min_w_0()
                        .justify_end()
                        .child(trailing),
                )
            });
        div()
            .id(id)
            .a11y_group(ax_id, ax_label)
            .flex()
            .flex_col()
            .gap(px(PANEL_INSET_PX))
            .w_full()
            .min_w_0()
            .min_h_0()
            .p(px(PANEL_INSET_PX))
            .rounded(px(PANEL_RADIUS_PX))
            .border_t_1()
            .border_color(colors.edge)
            .bg(hsla(colors.surface))
            .shadow_md()
            .child(header)
            .child(
                div()
                    .flex()
                    .flex_col()
                    .min_h_0()
                    .overflow_hidden()
                    .rounded(px(PANEL_RADIUS_PX - PANEL_INSET_PX))
                    .border_t_1()
                    .border_color(colors.edge)
                    .bg(inner)
                    .child(body),
            )
            .child(actions)
    }

    /// The row of buttons under a panel's body.
    pub(super) fn request_actions() -> gpui_kit::Div {
        div()
            .flex()
            .flex_row()
            .flex_none()
            .items_center()
            .gap(px(8.0))
            .px(px(8.0))
            .py(px(10.0))
    }

    /// A decision button of a panel: a pill, 32px high, with 13px text.
    pub(super) fn request_pill(
        &self,
        key: String,
        ax_id: String,
        label: &str,
        decision: &str,
        enabled: bool,
    ) -> gpui_kit::Stateful<gpui_kit::Div> {
        let tokens = &self.tokens;
        let (bg, text) = match decision {
            "decline" => (
                hsla(composite_over(
                    tokens.diff_removed_background,
                    chat_page(tokens),
                )),
                hsla(tokens.destructive_foreground),
            ),
            "accept" if !enabled => (hsla(tokens.shell_control), hsla(tokens.muted_foreground)),
            "accept" => (hsla(tokens.primary), hsla(tokens.primary_foreground)),
            _ => (hsla(tokens.secondary), hsla(tokens.secondary_foreground)),
        };
        div()
            .id(SharedString::from(key))
            .a11y_button(SharedString::from(ax_id), label.to_owned())
            .flex()
            .flex_row()
            .flex_none()
            .items_center()
            .justify_center()
            .gap(px(4.0))
            .h(px(32.0))
            .px(px(12.0))
            .rounded_full()
            .bg(bg)
            .text_color(text)
            .text_size(px(13.0))
            .line_height(px(18.0))
            .font_weight(FontWeight::MEDIUM)
            .whitespace_nowrap()
            .when(enabled, |pill| {
                pill.cursor_pointer().hover(|style| style.opacity(0.88))
            })
            .when(!enabled && decision != "accept", |pill| pill.opacity(0.5))
            .child(label.to_owned())
    }

    /// Whether an answer to `card` is on its way, and why the last one failed.
    fn approval_status(&self, card: &ChildApprovalCard) -> (bool, Option<String>) {
        match card.entry_id.as_deref() {
            Some(entry_id) => (
                self.approval_responding.contains(entry_id),
                self.approval_errors.get(entry_id).cloned(),
            ),
            None => (card.responding, card.error.clone()),
        }
    }

    /// Answers an approval of the open thread. A second click on a request already answered, or
    /// on one that is gone, does nothing.
    pub(super) fn answer_own_approval(
        &mut self,
        entry_id: &str,
        decision: &'static str,
        cx: &mut Context<'_, Self>,
    ) {
        if !has_own_approval(&self.own_approvals, entry_id)
            || !self.approval_responding.insert(entry_id.to_owned())
        {
            return;
        }
        self.approval_errors.remove(entry_id);
        cx.emit(ChatEvent::Approval {
            entry_id: entry_id.to_owned(),
            decision: decision.to_owned(),
        });
        cx.notify();
    }

    fn approval_listener(
        card: &ChildApprovalCard,
        decision: &'static str,
        cx: &mut Context<'_, Self>,
    ) -> impl Fn(&gpui_kit::ClickEvent, &mut gpui_kit::Window, &mut gpui_kit::App) + 'static {
        let entry_id = card.entry_id.clone();
        let thread_id = card.thread_id.clone();
        let request_id = card.request_id.clone();
        cx.listener(move |view, _, _, cx| {
            view.expanded_ids
                .remove(&format!("{APPROVAL_MORE_PREFIX}{request_id}"));
            match &entry_id {
                Some(entry_id) => view.answer_own_approval(entry_id, decision, cx),
                None => cx.emit(ChatEvent::ChildApproval {
                    thread_id: thread_id.clone(),
                    request_id: request_id.clone(),
                    decision: decision.to_owned(),
                }),
            }
        })
    }

    /// An approval of the open thread or of a child: the command in a scrolling body, then
    /// More, Decline and Approve. A child's card names where it comes from.
    fn render_approval_panel(
        &self,
        card: &ChildApprovalCard,
        body_max: f32,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let view = ApprovalView::new(&card.detail, card.hint.as_deref());
        let fg = hsla(self.tokens.foreground);
        let muted = hsla(self.tokens.muted_foreground);
        let request = card.request_id.as_str();
        let is_child = card.entry_id.is_none();
        let (responding, error) = self.approval_status(card);
        let enabled = card.answerable && !responding;

        let note = |text: String| {
            div()
                .text_size(px(UI_FONT_PX))
                .line_height(px(UI_LINE_HEIGHT_PX))
                .text_color(muted)
                .child(text)
        };
        let mut content = div()
            .flex()
            .flex_col()
            .gap(px(8.0))
            .px(px(21.0))
            .py(px(13.0));
        if is_child || view.command.is_none() {
            content = content.child(
                div()
                    .text_size(px(UI_FONT_PX))
                    .line_height(px(UI_LINE_HEIGHT_PX))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(fg)
                    .child(view.heading),
            );
        }
        if let Some(command) = view.command.as_deref() {
            let mut code = div()
                .flex()
                .flex_col()
                .gap(px(2.0))
                .flex_1()
                .min_w_0()
                .font_family(MONO_FONT_FAMILY)
                .text_size(px(12.0))
                .line_height(px(18.0));
            if let Some(wrapper) = view.wrapper.as_deref() {
                code = code.child(div().text_color(muted).child(wrapper.to_owned()));
            }
            code = code.child(div().text_color(fg).child(command.to_owned()));
            content = content.child(
                div()
                    .id(SharedString::from(format!("approval-command-{request}")))
                    .a11y_group(
                        format!("chat.approval.{request}.command"),
                        "Command awaiting approval",
                    )
                    .flex()
                    .flex_row()
                    .items_start()
                    .gap(px(8.0))
                    .w_full()
                    .min_w_0()
                    .child(code)
                    .child(self.render_copy_button(
                        &format!("approval-{request}"),
                        "Copy command",
                        command.to_owned(),
                        cx,
                    )),
            );
        }
        if let Some(text) = view.note.clone() {
            content = content.child(note(text));
        }
        if let Some(app_name) = &card.app_name {
            content = content.child(note(app_name.clone()));
        }
        if let Some(reason) = &card.reason {
            content = content.child(note(reason.clone()));
        }
        if let Some(text) = card.full_access_note {
            content = content.child(note(text.to_owned()));
        }
        if !card.answerable {
            content = content.child(
                div()
                    .text_size(px(UI_FONT_PX))
                    .line_height(px(UI_LINE_HEIGHT_PX))
                    // `warning` is too light for text on the light surface.
                    .text_color(hsla(self.tokens.warning_foreground))
                    .child(if is_child {
                        GONE_NOTE
                    } else {
                        "Provider process is gone. Interrupt or restart the thread to respond."
                    }),
            );
        }
        if let Some(error) = error {
            content = content.child(
                div()
                    .id(SharedString::from(format!("approval-error-{request}")))
                    .a11y_group(format!("chat.approval.{request}.error"), error.clone())
                    .text_size(px(UI_FONT_PX))
                    .line_height(px(UI_LINE_HEIGHT_PX))
                    .text_color(hsla(self.tokens.destructive))
                    .child(error),
            );
        }
        let body = div()
            .id(SharedString::from(format!("approval-scroll-{request}")))
            .max_h(px(body_max))
            .overflow_y_scroll()
            .child(content)
            .into_any_element();

        let mut actions = Self::request_actions();
        let more = card.more();
        if !more.is_empty() {
            let key = format!("{APPROVAL_MORE_PREFIX}{request}");
            let open = self.expanded_ids.contains(&key) && enabled;
            let toggle = cx.listener(move |view, _, _, cx| view.toggle_expanded(&key, cx));
            let mut anchor = div().relative().flex_none().child(
                div()
                    .id(SharedString::from(format!("approval-more-{request}")))
                    .a11y_button(format!("chat.approval.{request}.more"), "More")
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(4.0))
                    .h(px(32.0))
                    .px(px(8.0))
                    .rounded_full()
                    .text_size(px(13.0))
                    .line_height(px(18.0))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(muted)
                    .when(enabled, move |d| {
                        d.cursor_pointer()
                            .hover(move |s| s.text_color(fg))
                            .on_click(toggle)
                    })
                    .when(!enabled, |d| d.opacity(0.5))
                    .child("More")
                    .child(icons::icon(icons::CARET_DOWN, 12.0, muted)),
            );
            if open {
                anchor = anchor.child(
                    deferred(
                        div()
                            .absolute()
                            .bottom_full()
                            .left_0()
                            .mb(px(4.0))
                            .child(self.render_approval_menu(card, &more, cx)),
                    )
                    .with_priority(2),
                );
            }
            actions = actions.child(anchor);
        }
        actions = actions.child(div().flex_1());
        for choice in card.primary() {
            let listener = Self::approval_listener(card, choice.decision, cx);
            let mut pill = self
                .request_pill(
                    format!("approval-{}-{request}", choice.decision),
                    format!("chat.approval.{request}.{}", choice.decision),
                    &choice.label,
                    choice.decision,
                    enabled,
                )
                .when(enabled, move |pill| pill.on_click(listener));
            if choice.warning.is_some() {
                pill = pill.child(icons::icon(
                    icons::SHIELD_WARNING,
                    12.0,
                    hsla(self.tokens.warning_foreground),
                ));
            }
            // Observed for tests; the type is the observed element, so it ends the chain.
            actions = actions.child(pill.test_support());
        }

        let origin: Option<AnyElement> = if is_child {
            Some(
                div()
                    .min_w_0()
                    .truncate()
                    .font_weight(FontWeight::NORMAL)
                    .child(format!("From {}", card.title))
                    .into_any_element(),
            )
        } else if view.command.is_some() {
            Some(icons::icon(icons::TERMINAL, 16.0, muted).into_any_element())
        } else {
            None
        };
        let label = if is_child {
            format!("Approval needed from {}", card.title)
        } else {
            "Approval needed".to_owned()
        };
        self.request_panel(
            SharedString::from(format!("approval-{request}")),
            SharedString::from(format!("chat.approval.{request}")),
            SharedString::from(label),
            icons::SHIELD_WARNING,
            "Approval needed",
            origin,
            body,
            actions.into_any_element(),
            hsla(self.tokens.code_background),
        )
        .into_any_element()
    }

    /// Menu of the answers behind More.
    fn render_approval_menu(
        &self,
        card: &ChildApprovalCard,
        more: &[&ApprovalChoice],
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let request = card.request_id.as_str();
        let fg = hsla(self.tokens.foreground);
        let hover_bg = hsla(self.tokens.shell_highlight);
        let mut menu = div()
            .id(SharedString::from(format!("approval-menu-{request}")))
            .a11y(
                gpui_kit::Role::Menu,
                format!("chat.approval.{request}.more-menu"),
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
                        "approval-{}-{request}",
                        choice.decision
                    )))
                    .a11y_button(
                        format!("chat.approval.{request}.{}", choice.decision),
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
                    .on_click(Self::approval_listener(card, choice.decision, cx))
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

/// Prefix of the `expanded_ids` key that holds an approval's More menu open.
const APPROVAL_MORE_PREFIX: &str = "approval-more:";

#[cfg(test)]
mod tests {
    use super::*;

    fn approval(id: &str) -> RequestKey {
        RequestKey::Approval(id.to_owned())
    }

    fn child(id: &str) -> RequestKey {
        RequestKey::Child(id.to_owned())
    }

    #[test]
    fn the_body_shrinks_with_the_window_and_never_vanishes() {
        assert_eq!(body_max_for(2000.0), 520.0);
        assert!(body_max_for(900.0) > body_max_for(600.0));
        assert_eq!(body_max_for(400.0), MIN_BODY_PX);
        assert_eq!(body_max_for(0.0), MIN_BODY_PX);
        // The panel never takes more than 65% of the window while there is room.
        let viewport = 800.0;
        assert!(body_max_for(viewport) + PANEL_CHROME_PX <= viewport * 0.65 + 0.01);
    }

    #[test]
    fn layers_follow_the_waiting_count_up_to_two() {
        assert_eq!((0..5).map(back_layers).collect::<Vec<_>>(), [0, 0, 1, 2, 2]);
    }

    #[test]
    fn a_new_request_joins_at_the_back_and_never_takes_the_front() {
        let mut order = RequestOrder::default();
        assert_eq!(
            order.sync(&[child("c1"), approval("a1")]),
            [child("c1"), approval("a1")]
        );
        // The thread's own approval comes first in the timeline, but arrived later.
        assert_eq!(
            order.sync(&[approval("a2"), child("c1"), approval("a1")]),
            [child("c1"), approval("a1"), approval("a2")]
        );
    }

    #[test]
    fn an_answered_request_leaves_and_the_next_one_moves_up() {
        let mut order = RequestOrder::default();
        order.sync(&[approval("a1"), approval("a2"), child("c1")]);
        assert_eq!(
            order.sync(&[approval("a2"), child("c1")]),
            [approval("a2"), child("c1")]
        );
        assert_eq!(order.sync(&[child("c1")]), [child("c1")]);
        assert!(order.sync(&[]).is_empty());
    }

    #[test]
    fn a_released_request_waits_at_the_back_again() {
        let mut order = RequestOrder::default();
        order.sync(&[approval("a1"), approval("a2")]);
        // The typing guard holds a1 for a moment.
        assert_eq!(order.sync(&[approval("a2")]), [approval("a2")]);
        assert_eq!(
            order.sync(&[approval("a1"), approval("a2")]),
            [approval("a2"), approval("a1")]
        );
    }
}
