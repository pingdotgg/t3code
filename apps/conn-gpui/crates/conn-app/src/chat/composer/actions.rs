//! Composer primary action state machine (`ComposerPrimaryActions.tsx` parity).
//!
//! The pure resolver ([`resolve_primary_action`]) mirrors Conn's branch order:
//! plan follow-up (`Refine` / split `Implement`) -> running with an empty draft (`Stop`) ->
//! the round send button (`Resume thread`, `Update queued message`, `Queue message`,
//! `Steer message`, or `Submit message`) with Conn's exact status and tooltip strings.
//! Steer vs queue dispatch follows `composerDispatch.ts` (`resolveComposerDispatchMode`).

use conn_theme::Tokens;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    AnyElement, Context, FontWeight, InteractiveElement as _, IntoElement, MouseButton,
    ParentElement as _, StatefulInteractiveElement as _, Styled as _, deferred, div, px,
};

use super::super::color::{hsla, hsla_alpha};
use super::super::icons;
use super::super::spinner::TurningArc;
use super::Composer;
use crate::a11y::ConnA11yExt as _;
use crate::panels::chrome::ConnTooltipExt as _;

/// Primary send/stop button size matching `sm:h-8 sm:w-8` (`32px`).
const PRIMARY_ACTION_SIZE_PX: f32 = 32.0;
/// Plan follow-up pill height matching `sm:h-8` (`32px`).
const PILL_HEIGHT_PX: f32 = 32.0;
/// Superheroicons concept for Lucide `ListPlus` (queue a follow-up).
const ICON_QUEUE: &str = "superhero/list-add.svg";
/// Superheroicons concept for Lucide `PlayIcon` (resume thread).
const ICON_PLAY: &str = "superhero/play.svg";
/// Alternate send shortcut label (`composer.sendAlternate`, `Mod+Enter` on macOS).
const ALTERNATE_SHORTCUT_LABEL: &str = "⌘Enter";

/// Conn's `settings.followUpBehavior`: what a send does while a turn is running.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum FollowUpBehavior {
    /// Send into the running turn (`steer_active`). Conn's default.
    #[default]
    Steer,
    /// Wait until the running turn ends (`queue_after_active`).
    Queue,
}

impl FollowUpBehavior {
    /// Verb used in Conn's tooltip (`"Click to steer, ..."`).
    #[must_use]
    pub(crate) const fn verb(self) -> &'static str {
        match self {
            Self::Steer => "steer",
            Self::Queue => "queue",
        }
    }

    /// Segment label in the model picker footer.
    #[must_use]
    pub(crate) const fn label(self) -> &'static str {
        match self {
            Self::Steer => "Steer",
            Self::Queue => "Queue",
        }
    }

    /// `alternateComposerDispatchAction`: what `⌘`-click does instead.
    #[must_use]
    pub(crate) const fn alternate(self) -> Self {
        match self {
            Self::Steer => Self::Queue,
            Self::Queue => Self::Steer,
        }
    }
}

/// How a send is dispatched (`ComposerDispatchMode` without `restart`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum SendDispatch {
    /// No turn is running: start immediately.
    #[default]
    Auto,
    /// Queue after the running turn.
    Queue,
    /// Steer the running turn.
    Steer,
}

/// `resolveComposerDispatchMode`: the dispatch for a send right now.
#[must_use]
pub(crate) fn resolve_dispatch_mode(
    running: bool,
    follow_up: FollowUpBehavior,
    can_steer: bool,
    alternate_modifier: bool,
) -> SendDispatch {
    if !running {
        return SendDispatch::Auto;
    }
    if !can_steer {
        return SendDispatch::Queue;
    }
    let behavior = if alternate_modifier {
        follow_up.alternate()
    } else {
        follow_up
    };
    match behavior {
        FollowUpBehavior::Steer => SendDispatch::Steer,
        FollowUpBehavior::Queue => SendDispatch::Queue,
    }
}

/// Every input `ComposerPrimaryActions` reads.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(super) struct PrimaryActionInput {
    pub(super) can_operate_thread: bool,
    pub(super) is_running: bool,
    pub(super) can_interrupt: bool,
    pub(super) follow_up: FollowUpBehavior,
    pub(super) can_steer: bool,
    pub(super) alternate_modifier: bool,
    pub(super) show_plan_follow_up: bool,
    pub(super) prompt_has_text: bool,
    pub(super) is_send_busy: bool,
    pub(super) send_disabled_reason: Option<String>,
    pub(super) environment_unavailable: bool,
    pub(super) preparing_worktree: bool,
    pub(super) has_sendable_content: bool,
    pub(super) can_resume: bool,
    pub(super) editing_queued: bool,
}

/// Which glyph the round send button shows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum SendGlyph {
    Spinner,
    Resume,
    UpdateQueued,
    Queue,
    Steer,
    Submit,
}

/// The round send button's resolved state.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct SendButtonState {
    pub(super) glyph: SendGlyph,
    /// `aria-label`: the status when one applies, else the action label.
    pub(super) label: String,
    pub(super) tooltip: String,
    pub(super) disabled: bool,
    /// True when clicking resumes the thread instead of submitting.
    pub(super) resume: bool,
}

/// The resolved primary action area.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum PrimaryAction {
    /// Plan follow-up with text: `Refine` (or `Sending...`).
    Refine { label: &'static str, disabled: bool },
    /// Plan follow-up with an empty draft: split `Implement` + `Implement in a new thread`.
    Implement { label: &'static str, disabled: bool },
    /// Running with nothing to send: red stop button (`Interrupt`).
    Stop { disabled: bool },
    /// The round send button.
    Send(SendButtonState),
}

/// Ports `ComposerPrimaryActions` branch-for-branch (minus pending questions and
/// compact-before-send, which have no data source in `conn-gpui` yet).
#[must_use]
pub(super) fn resolve_primary_action(input: &PrimaryActionInput) -> PrimaryAction {
    let dispatch = resolve_dispatch_mode(
        input.is_running,
        input.follow_up,
        input.can_steer,
        input.alternate_modifier,
    );
    let is_queuing = !input.editing_queued && dispatch == SendDispatch::Queue;
    let is_send_disabled = !input.can_operate_thread || input.send_disabled_reason.is_some();

    if input.show_plan_follow_up && (input.prompt_has_text || !input.can_resume) {
        let disabled = input.is_send_busy || is_send_disabled || input.environment_unavailable;
        return if input.prompt_has_text {
            PrimaryAction::Refine {
                label: if input.is_send_busy {
                    "Sending..."
                } else {
                    "Refine"
                },
                disabled,
            }
        } else {
            PrimaryAction::Implement {
                label: if input.is_send_busy {
                    "Sending..."
                } else {
                    "Implement"
                },
                disabled,
            }
        };
    }

    if input.can_interrupt && !input.has_sendable_content && !input.editing_queued {
        return PrimaryAction::Stop {
            disabled: !input.can_operate_thread,
        };
    }

    let show_resume = input.can_resume && !input.has_sendable_content && !input.editing_queued;
    let submit_label = if show_resume {
        "Resume thread"
    } else if input.editing_queued {
        "Update queued message"
    } else if is_queuing {
        "Queue message"
    } else if input.is_running {
        "Steer message"
    } else {
        "Submit message"
    };
    let submit_status: Option<String> = if input.environment_unavailable {
        Some("Environment disconnected".to_owned())
    } else if let Some(reason) = &input.send_disabled_reason {
        Some(reason.clone())
    } else if input.preparing_worktree {
        Some("Preparing worktree".to_owned())
    } else if input.is_send_busy {
        Some(if input.editing_queued {
            "Updating queued message".to_owned()
        } else {
            "Submitting message".to_owned()
        })
    } else {
        None
    };
    let tooltip = submit_status.clone().unwrap_or_else(|| {
        if input.is_running && !input.editing_queued && input.can_steer {
            format!(
                "Click to {}, ⌘-click or {ALTERNATE_SHORTCUT_LABEL} to {}",
                input.follow_up.verb(),
                input.follow_up.alternate().verb()
            )
        } else {
            submit_label.to_owned()
        }
    });
    let glyph = if input.is_send_busy {
        SendGlyph::Spinner
    } else if show_resume {
        SendGlyph::Resume
    } else if input.editing_queued {
        SendGlyph::UpdateQueued
    } else if input.is_running {
        if is_queuing {
            SendGlyph::Queue
        } else {
            SendGlyph::Steer
        }
    } else {
        SendGlyph::Submit
    };
    let disabled = input.is_send_busy
        || is_send_disabled
        || input.environment_unavailable
        || (!input.has_sendable_content && !show_resume);
    PrimaryAction::Send(SendButtonState {
        glyph,
        label: submit_status.unwrap_or_else(|| submit_label.to_owned()),
        tooltip,
        disabled,
        resume: show_resume,
    })
}

/// Renders the resolved primary action area.
pub(super) fn render_primary_action(
    action: &PrimaryAction,
    implement_menu_open: bool,
    tokens: &Tokens,
    cx: &mut Context<'_, Composer>,
) -> AnyElement {
    match action {
        PrimaryAction::Stop { disabled } => render_stop_button(*disabled, tokens, cx),
        PrimaryAction::Refine { label, disabled } => {
            message_action_pill("chat-composer-refine", *disabled, tokens)
                .a11y_button("composer.refine", *label)
                .child(*label)
                .px(px(16.0))
                .rounded_full()
                .when(!*disabled, |el| {
                    el.on_click(cx.listener(|composer, _, window, cx| {
                        composer.submit_with_dispatch(None, window, cx);
                    }))
                })
                .into_any_element()
        }
        PrimaryAction::Implement { label, disabled } => {
            render_implement_split(label, *disabled, implement_menu_open, tokens, cx)
        }
        PrimaryAction::Send(state) => render_send_button(state, tokens, cx),
    }
}

fn render_stop_button(
    disabled: bool,
    tokens: &Tokens,
    cx: &mut Context<'_, Composer>,
) -> AnyElement {
    div()
        .id("chat-composer-stop")
        .a11y_button("composer.stop", "Stop generation")
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .size(px(PRIMARY_ACTION_SIZE_PX))
        .rounded_full()
        .cursor_pointer()
        .bg(hsla_alpha(tokens.destructive, 0.90))
        .hover(|s| s.bg(hsla(tokens.destructive)))
        .when(!disabled, |el| {
            el.on_click(cx.listener(|_composer, _, _, cx| {
                cx.emit(super::ComposerEvent::Stop);
            }))
        })
        .conn_tooltip("Interrupt", tokens)
        // Solid white (`destructive_foreground`) while the run can be interrupted, in both themes;
        // dim only when it cannot (Nick, #324).
        .child(icons::icon(
            icons::SQUARE,
            12.0,
            if disabled {
                hsla_alpha(tokens.destructive_foreground, 0.60)
            } else {
                hsla(tokens.destructive_foreground)
            },
        ))
        .into_any_element()
}

/// `messageActionPillClassName`: `rounded-full bg-message-action font-medium text-sm`.
fn message_action_pill(
    id: &'static str,
    disabled: bool,
    tokens: &Tokens,
) -> gpui_kit::Stateful<gpui_kit::Div> {
    let bg = hsla(tokens.primary);
    let hover_bg = hsla_alpha(tokens.primary, 0.88);
    div()
        .id(id)
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .h(px(PILL_HEIGHT_PX))
        .text_size(px(13.0))
        .line_height(px(20.0))
        .font_weight(FontWeight::MEDIUM)
        .text_color(hsla(tokens.primary_foreground))
        .bg(bg)
        .when(disabled, |el| el.opacity(0.64))
        .when(!disabled, |el| {
            el.cursor_pointer().hover(move |s| s.bg(hover_bg))
        })
}

fn render_implement_split(
    label: &'static str,
    disabled: bool,
    menu_open: bool,
    tokens: &Tokens,
    cx: &mut Context<'_, Composer>,
) -> AnyElement {
    let primary_fg = hsla(tokens.primary_foreground);
    let left = message_action_pill("chat-composer-implement", disabled, tokens)
        .a11y_button("composer.implement", label)
        .child(label)
        .px(px(16.0))
        .rounded_l_full()
        .when(!disabled, |el| {
            el.on_click(cx.listener(|composer, _, window, cx| {
                composer.submit_with_dispatch(None, window, cx);
            }))
        });
    let right = message_action_pill("chat-composer-implement-menu", disabled, tokens)
        .a11y_button("composer.implement-actions", "Implementation actions")
        .px(px(8.0))
        .rounded_r_full()
        .border_l_1()
        .border_color(hsla_alpha(tokens.primary_foreground, 0.20))
        .child(icons::icon(icons::CARET_DOWN, 14.0, primary_fg))
        .when(!disabled, |el| {
            el.on_click(cx.listener(|composer, _, _, cx| {
                composer.implement_menu_open = !composer.implement_menu_open;
                cx.notify();
            }))
        });

    let mut slot = div()
        .relative()
        .flex()
        .flex_row()
        .items_center()
        .child(left)
        .child(right);
    if menu_open && !disabled {
        let pop_fg = hsla(tokens.popover_foreground);
        let highlight = hsla(tokens.shell_highlight);
        let menu = div()
            .id("chat-composer-implement-popup")
            .a11y_group("composer.implement-popup", "Implement plan")
            .absolute()
            .bottom_full()
            .right_0()
            .mb(px(4.0))
            .w(px(208.0))
            .p(px(4.0))
            .rounded(px(8.0))
            .bg(hsla(tokens.popover))
            .border_1()
            .border_color(hsla(tokens.shell_inner_border))
            .shadow_md()
            .occlude()
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .child(
                div()
                    .id("chat-composer-implement-new-thread")
                    .a11y_button("composer.implement-new-thread", "Implement in a new thread")
                    .flex()
                    .items_center()
                    .h(px(28.0))
                    .px(px(8.0))
                    .rounded(px(5.0))
                    .cursor_pointer()
                    .text_size(px(13.0))
                    .line_height(px(20.0))
                    .text_color(pop_fg)
                    .hover(move |s| s.bg(highlight))
                    .on_click(cx.listener(|composer, _, _, cx| {
                        composer.implement_in_new_thread(cx);
                    }))
                    .child("Implement in a new thread"),
            );
        slot = slot.child(deferred(menu).with_priority(3));
    }
    slot.into_any_element()
}

fn render_send_button(
    state: &SendButtonState,
    tokens: &Tokens,
    cx: &mut Context<'_, Composer>,
) -> AnyElement {
    // Conn: `disabled:bg-foreground/12 disabled:text-muted-foreground`.
    let (bg, fg) = if state.disabled {
        (
            hsla_alpha(tokens.foreground, 0.12),
            hsla(tokens.muted_foreground),
        )
    } else {
        (hsla(tokens.primary), hsla(tokens.primary_foreground))
    };
    let glyph: AnyElement = match state.glyph {
        SendGlyph::Spinner => TurningArc::new(16.0, fg).into_any_element(),
        SendGlyph::Resume => icons::icon(ICON_PLAY, 16.0, fg).into_any_element(),
        SendGlyph::UpdateQueued => icons::icon(icons::CHECK, 16.0, fg).into_any_element(),
        SendGlyph::Queue => icons::icon(ICON_QUEUE, 16.0, fg).into_any_element(),
        SendGlyph::Steer => icons::icon(icons::FORWARD, 16.0, fg).into_any_element(),
        SendGlyph::Submit => icons::icon(icons::ARROW_UP, 14.0, fg).into_any_element(),
    };
    let hover_bg = hsla_alpha(tokens.primary, 0.88);
    let resume = state.resume;
    div()
        .id(if state.disabled {
            "chat-composer-send-disabled"
        } else {
            "chat-composer-send"
        })
        .a11y_button("composer.send", state.label.clone())
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .size(px(PRIMARY_ACTION_SIZE_PX))
        .rounded_full()
        .bg(bg)
        .when(!state.disabled, |el| {
            el.cursor_pointer()
                .hover(move |s| s.bg(hover_bg))
                .on_click(
                    cx.listener(move |composer, event: &gpui_kit::ClickEvent, window, cx| {
                        if resume {
                            composer.resume_thread(cx);
                            return;
                        }
                        let modifiers = event.modifiers();
                        composer.submit_with_dispatch(
                            Some(modifiers.platform || modifiers.control),
                            window,
                            cx,
                        );
                    }),
                )
        })
        .conn_tooltip(state.tooltip.clone(), tokens)
        .child(glyph)
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn idle() -> PrimaryActionInput {
        PrimaryActionInput {
            can_operate_thread: true,
            can_steer: true,
            ..PrimaryActionInput::default()
        }
    }

    fn send_state(action: PrimaryAction) -> SendButtonState {
        match action {
            PrimaryAction::Send(state) => state,
            other => panic!("expected send button, got {other:?}"),
        }
    }

    #[test]
    fn dispatch_mode_matches_conn() {
        use FollowUpBehavior::{Queue, Steer};
        assert_eq!(
            resolve_dispatch_mode(false, Steer, true, true),
            SendDispatch::Auto
        );
        assert_eq!(
            resolve_dispatch_mode(true, Steer, true, false),
            SendDispatch::Steer
        );
        assert_eq!(
            resolve_dispatch_mode(true, Steer, true, true),
            SendDispatch::Queue
        );
        assert_eq!(
            resolve_dispatch_mode(true, Queue, true, true),
            SendDispatch::Steer
        );
        assert_eq!(
            resolve_dispatch_mode(true, Steer, false, false),
            SendDispatch::Queue,
            "cannot steer while compacting"
        );
    }

    #[test]
    fn running_with_empty_draft_shows_stop() {
        let input = PrimaryActionInput {
            is_running: true,
            can_interrupt: true,
            ..idle()
        };
        assert_eq!(
            resolve_primary_action(&input),
            PrimaryAction::Stop { disabled: false }
        );
    }

    #[test]
    fn running_with_text_steers_and_morphs_to_queue_on_modifier() {
        let mut input = PrimaryActionInput {
            is_running: true,
            can_interrupt: true,
            prompt_has_text: true,
            has_sendable_content: true,
            ..idle()
        };
        let steer = send_state(resolve_primary_action(&input));
        assert_eq!(steer.glyph, SendGlyph::Steer);
        assert_eq!(steer.label, "Steer message");
        assert_eq!(steer.tooltip, "Click to steer, ⌘-click or ⌘Enter to queue");

        input.alternate_modifier = true;
        let queue = send_state(resolve_primary_action(&input));
        assert_eq!(queue.glyph, SendGlyph::Queue);
        assert_eq!(queue.label, "Queue message");

        input.alternate_modifier = false;
        input.follow_up = FollowUpBehavior::Queue;
        let queue_default = send_state(resolve_primary_action(&input));
        assert_eq!(queue_default.glyph, SendGlyph::Queue);
        assert_eq!(
            queue_default.tooltip,
            "Click to queue, ⌘-click or ⌘Enter to steer"
        );
    }

    #[test]
    fn editing_queued_message_shows_check() {
        let input = PrimaryActionInput {
            is_running: true,
            can_interrupt: true,
            editing_queued: true,
            prompt_has_text: true,
            has_sendable_content: true,
            ..idle()
        };
        let state = send_state(resolve_primary_action(&input));
        assert_eq!(state.glyph, SendGlyph::UpdateQueued);
        assert_eq!(state.tooltip, "Update queued message");
        assert!(!state.disabled);
    }

    #[test]
    fn resume_shows_play_when_draft_empty() {
        let input = PrimaryActionInput {
            can_resume: true,
            ..idle()
        };
        let state = send_state(resolve_primary_action(&input));
        assert_eq!(state.glyph, SendGlyph::Resume);
        assert_eq!(state.label, "Resume thread");
        assert!(state.resume);
        assert!(!state.disabled);
    }

    #[test]
    fn plan_follow_up_refines_or_implements() {
        let mut input = PrimaryActionInput {
            show_plan_follow_up: true,
            ..idle()
        };
        assert_eq!(
            resolve_primary_action(&input),
            PrimaryAction::Implement {
                label: "Implement",
                disabled: false
            }
        );
        input.prompt_has_text = true;
        input.has_sendable_content = true;
        assert_eq!(
            resolve_primary_action(&input),
            PrimaryAction::Refine {
                label: "Refine",
                disabled: false
            }
        );
        input.is_send_busy = true;
        assert_eq!(
            resolve_primary_action(&input),
            PrimaryAction::Refine {
                label: "Sending...",
                disabled: true
            }
        );
    }

    #[test]
    fn disabled_status_priority_matches_conn() {
        let mut input = PrimaryActionInput {
            prompt_has_text: true,
            has_sendable_content: true,
            environment_unavailable: true,
            send_disabled_reason: Some("Messages loading".to_owned()),
            preparing_worktree: true,
            ..idle()
        };
        let state = send_state(resolve_primary_action(&input));
        assert_eq!(state.tooltip, "Environment disconnected");
        assert!(state.disabled);

        input.environment_unavailable = false;
        assert_eq!(
            send_state(resolve_primary_action(&input)).tooltip,
            "Messages loading"
        );
        input.send_disabled_reason = None;
        assert_eq!(
            send_state(resolve_primary_action(&input)).tooltip,
            "Preparing worktree"
        );
        input.preparing_worktree = false;
        input.is_send_busy = true;
        let busy = send_state(resolve_primary_action(&input));
        assert_eq!(busy.tooltip, "Submitting message");
        assert_eq!(busy.glyph, SendGlyph::Spinner);
        assert!(busy.disabled);
    }

    #[test]
    fn idle_empty_draft_is_disabled_submit() {
        let state = send_state(resolve_primary_action(&idle()));
        assert_eq!(state.glyph, SendGlyph::Submit);
        assert_eq!(state.tooltip, "Submit message");
        assert!(state.disabled);
    }
}
