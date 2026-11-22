//! Pull request header, title editor, metadata key-value rows, actions menu,
//! loading skeleton (`PullRequestDetailGhost`), and empty/unavailable states
//! (`PullRequestsUnavailableState`).

use crate::a11y::ConnA11yExt as _;
use std::rc::Rc;

use conn_contract::{
    IssueActor, PullRequestAction, PullRequestActionInputUpdateMethod, PullRequestComment,
    PullRequestCommit, PullRequestDetail, PullRequestDetailAutoMergeMethod,
    PullRequestLabelCandidate, PullRequestReviewerCandidate, PullRequestState,
};
use conn_theme::{Appearance, Tokens, color_mix_srgb};
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::*;
use gpui_kit::{
    AnyElement, App, BoxShadow, ClipboardItem, Entity, FontWeight, Hsla, InteractiveElement,
    IntoElement, MouseButton, ParentElement, SharedString, StatefulInteractiveElement, Styled,
    Window, deferred, div, point, px, relative,
};

use super::super::chrome::{
    self, ConnTooltipExt as _, UI_LINE_HEIGHT_PX, UI_TEXT_PX, XS_LINE_HEIGHT_PX, XS_TEXT_PX,
    actor_tooltip_label,
};
use super::super::color::to_hsla;
use super::super::header::superhero_icon;
use super::logic::{
    ChecksState, DetailTab, PrimaryControl, ReviewOutcome, allowed_merge_methods, auto_merge_label,
    build_explain_pr_prompt, build_resolve_conflicts_prompt, build_reviewer_entries,
    can_delete_branch, can_edit_change_request, can_perform_action, checkout_command,
    format_grouped_count, format_relative_time, label_chip_colors, merge_method_label,
    open_on_host_label, parse_pull_request_url, resolve_base_freshness, resolve_merge_method,
    resolve_primary_control, resolve_state_presentation, review_outcome_color,
    review_outcome_label, state_tone_color,
};
use super::pickers::{render_base_branch_freshness, render_label_picker, render_reviewer_picker};
use crate::theme::MONO_FONT;

const HEADER_INSET_X_PX: f32 = 18.0; // `px-4.5`
const META_LABEL_WIDTH_PX: f32 = 120.0; // `7.5rem`
const PILL_RADIUS_PX: f32 = 9999.0;

/// Actions that use Conn's inline two-click confirmation (`useInlineActionConfirm`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ConfirmableAction {
    Merge,
    EnableAutoMerge,
    Close,
    Revert,
    DeleteBranch,
    ApproveWorkflows,
    CloseWithComment,
}

/// Callbacks wired from [`super::PullRequestPanel`] into the header and actions menu.
pub(super) struct HeaderCallbacks {
    pub(super) on_start_edit_title: Rc<dyn Fn(&mut Window, &mut App)>,
    pub(super) on_cancel_edit_title: Rc<dyn Fn(&mut Window, &mut App)>,
    pub(super) on_save_title: Rc<dyn Fn(&mut Window, &mut App)>,
    pub(super) on_toggle_actions_menu: Rc<dyn Fn(&mut Window, &mut App)>,
    pub(super) on_refresh_from_host: Rc<dyn Fn(&mut Window, &mut App)>,
    pub(super) on_perform_action: Rc<
        dyn Fn(
            PullRequestAction,
            Option<PullRequestDetailAutoMergeMethod>,
            Option<PullRequestActionInputUpdateMethod>,
            &mut Window,
            &mut App,
        ),
    >,
    pub(super) on_arm_confirm: Rc<dyn Fn(Option<ConfirmableAction>, &mut Window, &mut App)>,
    pub(super) on_select_merge_method:
        Rc<dyn Fn(PullRequestDetailAutoMergeMethod, &mut Window, &mut App)>,
    pub(super) on_copy_branch: Rc<dyn Fn(String, &mut Window, &mut App)>,
    pub(super) on_open_url: Rc<dyn Fn(String, &mut Window, &mut App)>,
    pub(super) on_toggle_reviewer_picker: Rc<dyn Fn(&mut Window, &mut App)>,
    pub(super) on_select_reviewer_candidate:
        Rc<dyn Fn(PullRequestReviewerCandidate, &mut Window, &mut App)>,
    pub(super) on_toggle_label_picker: Rc<dyn Fn(&mut Window, &mut App)>,
    pub(super) on_select_label_candidate:
        Rc<dyn Fn(PullRequestLabelCandidate, &mut Window, &mut App)>,
    pub(super) on_toggle_base_freshness_popover: Rc<dyn Fn(&mut Window, &mut App)>,
    pub(super) on_toggle_header_condensed: Rc<dyn Fn(&mut Window, &mut App)>,
    pub(super) on_send_prompt: Rc<dyn Fn(String, &mut Window, &mut App)>,
}

/// Picker & popover state passed into [`render_header_body`].
pub(super) struct HeaderPickerState<'a> {
    pub(super) reviewer_open: bool,
    pub(super) reviewer_search_input: &'a Entity<InputState>,
    pub(super) reviewer_query: &'a str,
    pub(super) reviewer_loading: bool,
    pub(super) reviewer_error: Option<&'a str>,
    pub(super) reviewer_candidates: &'a [PullRequestReviewerCandidate],
    pub(super) reviewer_truncated: bool,
    pub(super) reviewer_pending_id: Option<&'a str>,
    pub(super) label_open: bool,
    pub(super) label_search_input: &'a Entity<InputState>,
    pub(super) label_query: &'a str,
    pub(super) label_loading: bool,
    pub(super) label_error: Option<&'a str>,
    pub(super) label_candidates: &'a [PullRequestLabelCandidate],
    pub(super) label_truncated: bool,
    pub(super) label_pending_name: Option<&'a str>,
    pub(super) base_freshness_open: bool,
}

/// Renders the fixed PR title bar (`PULL_REQUEST_DETAIL_HEADER_CLASS`).
#[expect(
    clippy::too_many_arguments,
    reason = "view props passed explicitly from PullRequestPanel::render"
)]
pub(super) fn render_title_header(
    tokens: &Tokens,
    detail: &PullRequestDetail,
    checks_state: Option<ChecksState>,
    editing_title: bool,
    title_input: &Entity<InputState>,
    title_saving: bool,
    selected_merge_method: Option<PullRequestDetailAutoMergeMethod>,
    pending_action: Option<PullRequestAction>,
    armed_confirm: Option<ConfirmableAction>,
    actions_menu_open: bool,
    refreshing: bool,
    can_fix_findings: bool,
    fix_findings_prompt: String,
    condensed: bool,
    cb: &HeaderCallbacks,
) -> AnyElement {
    let fg = to_hsla(tokens.foreground);
    let muted = to_hsla(tokens.muted_foreground);
    let divider = to_hsla(tokens.shell_divider);
    let hover = to_hsla(tokens.shell_highlight);

    let title_block: AnyElement = if editing_title {
        v_flex()
            .flex_1()
            .min_w_0()
            .gap(px(8.0))
            .child(
                div()
                    .w_full()
                    .h(px(30.0))
                    .px(px(10.0))
                    .flex()
                    .items_center()
                    .rounded(px(8.0))
                    .bg(to_hsla(tokens.shell_field))
                    .border_1()
                    .border_color(to_hsla(tokens.ring))
                    .child(
                        Input::new(title_input)
                            .appearance(false)
                            .text_size(px(14.0)),
                    ),
            )
            .child(
                h_flex()
                    .w_full()
                    .justify_end()
                    .gap(px(8.0))
                    .child(small_ghost_button(
                        "pr-title-cancel",
                        "Cancel",
                        tokens,
                        title_saving,
                        {
                            let on_cancel = cb.on_cancel_edit_title.clone();
                            move |window, cx| on_cancel(window, cx)
                        },
                    ))
                    .child(small_outline_button(
                        "pr-title-save",
                        None,
                        if title_saving { "Saving..." } else { "Save" },
                        tokens,
                        title_saving,
                        {
                            let on_save = cb.on_save_title.clone();
                            move |window, cx| on_save(window, cx)
                        },
                    )),
            )
            .into_any_element()
    } else {
        let can_edit = can_edit_change_request(detail);
        let group = SharedString::from("pr-title-row");
        let mut row = h_flex()
            .id("pr-title-display")
            .group(group.clone())
            .flex_1()
            .min_w_0()
            .min_h(px(24.0))
            .items_center()
            .gap(px(4.0))
            .child(
                div()
                    .id("pr-title-text")
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .text_size(px(18.0))
                    .line_height(px(24.0))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(fg)
                    .conn_fast_tooltip(detail.title.clone(), tokens)
                    .child(detail.title.clone()),
            );
        if can_edit {
            let on_edit = cb.on_start_edit_title.clone();
            row = row.child(
                div().invisible().group_hover(group, |s| s.visible()).child(
                    div()
                        .id("pr-edit-title-btn")
                        .a11y_button("panel.pr-edit-title-btn", "Edit title")
                        .flex()
                        .flex_shrink_0()
                        .size(px(24.0))
                        .items_center()
                        .justify_center()
                        .rounded(px(PILL_RADIUS_PX))
                        .cursor_pointer()
                        .hover(move |s| s.bg(hover))
                        .on_click(move |_, window, cx| on_edit(window, cx))
                        .conn_fast_tooltip("Edit title", tokens)
                        .child(superhero_icon("superhero/edit.svg", 13.0, muted)),
                ),
            );
        }
        row.into_any_element()
    };

    let allowed_methods = allowed_merge_methods(detail);
    let effective_method = resolve_merge_method(
        &allowed_methods,
        selected_merge_method,
        detail.auto_merge_method,
    );
    let primary = resolve_primary_control(detail, checks_state);
    let state_pres = resolve_state_presentation(detail.state, detail.is_draft);

    let primary_el = render_primary_control(
        tokens,
        detail,
        primary,
        effective_method,
        state_pres,
        pending_action,
        armed_confirm,
        cb,
    );

    let on_toggle_menu = cb.on_toggle_actions_menu.clone();
    let actions_tooltip = if refreshing {
        "Refreshing pull request"
    } else {
        "Pull request actions"
    };
    let mut overflow_anchor = div().relative().child(
        div()
            .id("pr-actions-menu-btn")
            .a11y_button("panel.pr-actions-menu-btn", "Actions menu")
            .flex()
            .flex_shrink_0()
            .size(px(24.0))
            .items_center()
            .justify_center()
            .rounded(px(PILL_RADIUS_PX))
            .cursor_pointer()
            .hover(move |s| s.bg(hover))
            .on_click(move |_, window, cx| on_toggle_menu(window, cx))
            .conn_fast_tooltip(actions_tooltip, tokens)
            .child(superhero_icon(
                if refreshing {
                    "superhero/spinner.svg"
                } else {
                    "superhero/more-horizontal.svg"
                },
                16.0,
                muted,
            )),
    );
    if actions_menu_open {
        overflow_anchor = overflow_anchor.child(render_actions_menu(
            tokens,
            detail,
            primary,
            &allowed_methods,
            effective_method,
            pending_action,
            armed_confirm,
            refreshing,
            can_fix_findings,
            fix_findings_prompt,
            cb,
        ));
    }

    let on_toggle_condensed = cb.on_toggle_header_condensed.clone();
    let collapse_btn = div()
        .id("pr-header-collapse-btn")
        .a11y_button("panel.pr-header-collapse-btn", "Toggle header details")
        .flex()
        .flex_shrink_0()
        .size(px(24.0))
        .items_center()
        .justify_center()
        .rounded(px(PILL_RADIUS_PX))
        .cursor_pointer()
        .hover(move |s| s.bg(hover))
        .on_click(move |_, window, cx| on_toggle_condensed(window, cx))
        .conn_fast_tooltip(
            if condensed {
                "Show details"
            } else {
                "Hide details"
            },
            tokens,
        )
        .child(superhero_icon(
            if condensed {
                "superhero/chevron-down.svg"
            } else {
                "superhero/chevron-up.svg"
            },
            14.0,
            muted,
        ));

    h_flex()
        .w_full()
        .flex_shrink_0()
        .items_center()
        .justify_between()
        .gap(px(8.0))
        .px(px(HEADER_INSET_X_PX))
        .py(px(14.0))
        .border_b_1()
        .border_color(divider)
        .child(title_block)
        .child(
            h_flex()
                .flex_shrink_0()
                .h(px(28.0))
                .items_center()
                .gap(px(4.0))
                .when_some(primary_el, |el, ctrl| el.child(ctrl))
                .child(collapse_btn)
                .child(overflow_anchor),
        )
        .into_any_element()
}

#[expect(
    clippy::too_many_arguments,
    reason = "view props passed explicitly from PullRequestPanel::render"
)]
fn render_primary_control(
    tokens: &Tokens,
    detail: &PullRequestDetail,
    primary: PrimaryControl,
    method: PullRequestDetailAutoMergeMethod,
    state_pres: super::logic::StatePresentation,
    pending_action: Option<PullRequestAction>,
    armed_confirm: Option<ConfirmableAction>,
    cb: &HeaderCallbacks,
) -> Option<AnyElement> {
    let busy = pending_action.is_some();
    match primary {
        PrimaryControl::None => None,
        PrimaryControl::Merged | PrimaryControl::Closed => {
            let color = to_hsla(state_tone_color(tokens, state_pres.tone));
            let bg = match tokens.appearance {
                Appearance::Dark => to_hsla(tokens.input.with_alpha(0.32)),
                Appearance::Light => to_hsla(tokens.shell_card),
            };
            Some(
                h_flex()
                    .h(px(24.0))
                    .px(px(8.0))
                    .gap(px(4.0))
                    .items_center()
                    .rounded(px(PILL_RADIUS_PX))
                    .bg(bg)
                    .border_1()
                    .border_color(to_hsla(tokens.input))
                    .text_size(px(XS_TEXT_PX))
                    .line_height(px(XS_LINE_HEIGHT_PX))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(color)
                    .child(superhero_icon(state_pres.icon, 14.0, color))
                    .child(state_pres.label)
                    .into_any_element(),
            )
        }
        PrimaryControl::Resolve => {
            let fg = to_hsla(tokens.destructive_foreground);
            let border = to_hsla(tokens.destructive.with_alpha(0.35));
            let bg = to_hsla(tokens.destructive.with_alpha(0.10));
            let hover_bg = to_hsla(tokens.destructive.with_alpha(0.18));
            let prompt = build_resolve_conflicts_prompt(detail);
            let on_send = cb.on_send_prompt.clone();
            Some(
                h_flex()
                    .id("pr-primary-conflicts")
                    .a11y_button(
                        "panel.pr-primary-conflicts",
                        "Resolve conflicts in this thread",
                    )
                    .h(px(24.0))
                    .px(px(8.0))
                    .gap(px(4.0))
                    .items_center()
                    .rounded(px(PILL_RADIUS_PX))
                    .bg(bg)
                    .border_1()
                    .border_color(border)
                    .cursor_pointer()
                    .hover(move |s| s.bg(hover_bg))
                    .on_click(move |_, window, cx| on_send(prompt.clone(), window, cx))
                    .text_size(px(XS_TEXT_PX))
                    .line_height(px(XS_LINE_HEIGHT_PX))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(fg)
                    .conn_fast_tooltip("Resolve conflicts in this thread", tokens)
                    .child(superhero_icon("superhero/warning.svg", 14.0, fg))
                    .child("Resolve conflicts")
                    .into_any_element(),
            )
        }
        PrimaryControl::AutoMergeArmed => {
            let label = detail
                .auto_merge_method
                .map_or("Auto-merge", auto_merge_label);
            let fg = to_hsla(tokens.info_foreground);
            let bg = to_hsla(
                tokens
                    .info
                    .with_alpha(if tokens.appearance == Appearance::Dark {
                        0.16
                    } else {
                        0.08
                    }),
            );
            Some(
                h_flex()
                    .id("pr-primary-automerge-armed")
                    .h(px(24.0))
                    .px(px(8.0))
                    .gap(px(4.0))
                    .items_center()
                    .rounded(px(PILL_RADIUS_PX))
                    .bg(bg)
                    .text_size(px(XS_TEXT_PX))
                    .line_height(px(XS_LINE_HEIGHT_PX))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(fg)
                    .conn_fast_tooltip(
                        format!("{label}: the host will merge this on its own once its requirements are met"),
                        tokens,
                    )
                    .child(superhero_icon("superhero/merge.svg", 14.0, fg))
                    .child(label)
                    .into_any_element(),
            )
        }
        PrimaryControl::Ready => {
            let on_perform = cb.on_perform_action.clone();
            let label = if pending_action == Some(PullRequestAction::Ready) {
                "Marking ready..."
            } else {
                "Ready for review"
            };
            Some(primary_pill_button(
                "pr-primary-ready",
                "superhero/pull-request.svg",
                label,
                tokens,
                busy,
                move |window, cx| on_perform(PullRequestAction::Ready, None, None, window, cx),
            ))
        }
        PrimaryControl::Merge => {
            let armed = armed_confirm == Some(ConfirmableAction::Merge);
            let label = if pending_action == Some(PullRequestAction::Merge) {
                "Merging..."
            } else if armed {
                "Confirm merge?"
            } else {
                merge_method_label(method)
            };
            let icon = if armed {
                "superhero/check.svg"
            } else {
                "superhero/merge.svg"
            };
            let on_perform = cb.on_perform_action.clone();
            let on_arm = cb.on_arm_confirm.clone();
            Some(primary_pill_button(
                "pr-primary-merge",
                icon,
                label,
                tokens,
                busy,
                move |window, cx| {
                    if armed {
                        on_arm(None, window, cx);
                        on_perform(PullRequestAction::Merge, Some(method), None, window, cx);
                    } else {
                        on_arm(Some(ConfirmableAction::Merge), window, cx);
                    }
                },
            ))
        }
        PrimaryControl::EnableAutoMerge => {
            let armed = armed_confirm == Some(ConfirmableAction::EnableAutoMerge);
            let label = if pending_action == Some(PullRequestAction::EnableAutoMerge) {
                "Enabling..."
            } else if armed {
                "Confirm auto-merge?"
            } else {
                auto_merge_label(method)
            };
            let icon = if armed {
                "superhero/check.svg"
            } else {
                "superhero/merge.svg"
            };
            let on_perform = cb.on_perform_action.clone();
            let on_arm = cb.on_arm_confirm.clone();
            Some(primary_pill_button(
                "pr-primary-automerge",
                icon,
                label,
                tokens,
                busy,
                move |window, cx| {
                    if armed {
                        on_arm(None, window, cx);
                        on_perform(
                            PullRequestAction::EnableAutoMerge,
                            Some(method),
                            None,
                            window,
                            cx,
                        );
                    } else {
                        on_arm(Some(ConfirmableAction::EnableAutoMerge), window, cx);
                    }
                },
            ))
        }
    }
}

#[expect(
    clippy::too_many_arguments,
    reason = "view props passed explicitly from PullRequestPanel::render"
)]
fn render_actions_menu(
    tokens: &Tokens,
    detail: &PullRequestDetail,
    primary: PrimaryControl,
    allowed_methods: &[PullRequestDetailAutoMergeMethod],
    selected_method: PullRequestDetailAutoMergeMethod,
    pending_action: Option<PullRequestAction>,
    armed_confirm: Option<ConfirmableAction>,
    refreshing: bool,
    can_fix_findings: bool,
    fix_findings_prompt: String,
    cb: &HeaderCallbacks,
) -> AnyElement {
    let busy = pending_action.is_some();
    let fg = to_hsla(tokens.foreground);
    let muted = to_hsla(tokens.muted_foreground);
    let destructive = to_hsla(tokens.destructive);
    let highlight = to_hsla(tokens.shell_highlight);
    let checked_bg = chrome::alpha(tokens.foreground, 0.08);
    let divider = chrome::alpha(tokens.foreground, 0.08);
    let (offset_y, blur, alpha) = match tokens.appearance {
        Appearance::Dark => (18.0, 44.0, 0.80),
        Appearance::Light => (16.0, 40.0, 0.55),
    };
    let shadow = BoxShadow {
        color: gpui_kit::hsla(0.0, 0.0, 0.0, alpha),
        offset: point(px(0.0), px(offset_y)),
        blur_radius: px(blur),
        spread_radius: px(-18.0),
        inset: false,
    };

    let mut list = v_flex()
        .id("pr-actions-menu-popup")
        .min_w(px(220.0))
        .max_w(px(280.0))
        .p(px(4.0))
        .rounded(px(12.0))
        .bg(to_hsla(tokens.popover))
        .border_1()
        .border_color(divider)
        .shadow(vec![shadow])
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation());

    let sep = |d: Hsla| div().mx(px(8.0)).my(px(4.0)).h(px(1.0)).bg(d);

    let item = |id: &str,
                icon: &'static str,
                label: String,
                color: Hsla,
                icon_color: Hsla,
                checked: bool,
                disabled: bool,
                on_click: Box<dyn Fn(&mut Window, &mut App)>| {
        let mut row = h_flex()
            .id(SharedString::from(id.to_owned()))
            .w_full()
            .min_h(px(28.0))
            .px(px(8.0))
            .py(px(4.0))
            .gap(px(8.0))
            .items_center()
            .rounded(px(8.0))
            .text_size(px(13.0))
            .line_height(px(18.0))
            .text_color(color)
            .when(checked, |el| el.bg(checked_bg))
            .child(superhero_icon(icon, 14.0, icon_color))
            .child(div().flex_1().min_w_0().truncate().child(label));
        if disabled {
            row = row.opacity(0.5);
        } else {
            row = row
                .cursor_pointer()
                .hover(move |s| s.bg(highlight))
                .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                    cx.stop_propagation();
                    on_click(window, cx);
                });
        }
        row
    };

    // Refresh
    {
        let on_refresh = cb.on_refresh_from_host.clone();
        list = list.child(item(
            "pr-menu-refresh",
            if refreshing {
                "superhero/spinner.svg"
            } else {
                "superhero/refresh.svg"
            },
            "Refresh".to_owned(),
            fg,
            muted,
            false,
            refreshing,
            Box::new(move |window, cx| on_refresh(window, cx)),
        ));
    }

    // Agent prompt actions (Explain this PR / Fix findings in this thread)
    {
        let explain_prompt = build_explain_pr_prompt(detail);
        let on_send = cb.on_send_prompt.clone();
        list = list.child(item(
            "pr-menu-explain-pr",
            "superhero/book.svg",
            "Explain this pull request".to_owned(),
            fg,
            muted,
            false,
            false,
            Box::new(move |window, cx| on_send(explain_prompt.clone(), window, cx)),
        ));
    }
    {
        let on_send = cb.on_send_prompt.clone();
        list = list.child(item(
            "pr-menu-fix-findings",
            "superhero/tool.svg",
            "Fix findings in this thread".to_owned(),
            fg,
            muted,
            false,
            !can_fix_findings,
            Box::new(move |window, cx| on_send(fix_findings_prompt.clone(), window, cx)),
        ));
    }

    // State/merge controls when open
    let auto_merge_armed =
        detail.state == PullRequestState::Open && detail.auto_merge_enabled == Some(true);
    let conflicting = detail.state == PullRequestState::Open
        && detail.mergeability == conn_contract::PullRequestMergeability::Conflicting;
    let shows_draft_toggle = detail.state == PullRequestState::Open
        && can_perform_action(
            detail,
            if detail.is_draft {
                PullRequestAction::Ready
            } else {
                PullRequestAction::Draft
            },
        )
        && !(detail.is_draft && primary == PrimaryControl::Ready);
    let shows_merge_now = detail.state == PullRequestState::Open
        && matches!(
            primary,
            PrimaryControl::EnableAutoMerge | PrimaryControl::AutoMergeArmed
        )
        && can_perform_action(detail, PullRequestAction::Merge)
        && !detail.is_draft
        && !conflicting
        && !allowed_methods.is_empty();
    let shows_auto_merge = detail.state == PullRequestState::Open
        && ((auto_merge_armed && can_perform_action(detail, PullRequestAction::DisableAutoMerge))
            || (!auto_merge_armed
                && primary != PrimaryControl::EnableAutoMerge
                && !detail.is_draft
                && !conflicting
                && can_perform_action(detail, PullRequestAction::EnableAutoMerge)
                && !allowed_methods.is_empty()));
    let shows_merge_methods = detail.state == PullRequestState::Open
        && can_perform_action(detail, PullRequestAction::Merge)
        && !detail.is_draft
        && !conflicting
        && allowed_methods.len() > 1;

    if shows_draft_toggle || shows_merge_now || shows_auto_merge || shows_merge_methods {
        list = list.child(sep(divider));
    }

    if shows_draft_toggle {
        let target_action = if detail.is_draft {
            PullRequestAction::Ready
        } else {
            PullRequestAction::Draft
        };
        let on_perform = cb.on_perform_action.clone();
        list = list.child(item(
            "pr-menu-draft-toggle",
            if detail.is_draft {
                "superhero/pull-request.svg"
            } else {
                "superhero/pull-request-draft.svg"
            },
            if detail.is_draft {
                "Ready for review".to_owned()
            } else {
                "Convert to draft".to_owned()
            },
            fg,
            muted,
            false,
            busy,
            Box::new(move |window, cx| on_perform(target_action, None, None, window, cx)),
        ));
    }

    if shows_merge_now {
        let armed = armed_confirm == Some(ConfirmableAction::Merge);
        let on_perform = cb.on_perform_action.clone();
        let on_arm = cb.on_arm_confirm.clone();
        list = list.child(item(
            "pr-menu-merge-now",
            "superhero/merge.svg",
            if armed {
                "Confirm merge?".to_owned()
            } else {
                "Merge now".to_owned()
            },
            fg,
            muted,
            false,
            busy,
            Box::new(move |window, cx| {
                if armed {
                    on_arm(None, window, cx);
                    on_perform(
                        PullRequestAction::Merge,
                        Some(selected_method),
                        None,
                        window,
                        cx,
                    );
                } else {
                    on_arm(Some(ConfirmableAction::Merge), window, cx);
                }
            }),
        ));
    }

    if shows_auto_merge {
        if auto_merge_armed {
            let on_perform = cb.on_perform_action.clone();
            list = list.child(item(
                "pr-menu-disable-automerge",
                "superhero/merge.svg",
                "Disable auto-merge".to_owned(),
                fg,
                muted,
                false,
                busy,
                Box::new(move |window, cx| {
                    on_perform(PullRequestAction::DisableAutoMerge, None, None, window, cx);
                }),
            ));
        } else {
            let armed = armed_confirm == Some(ConfirmableAction::EnableAutoMerge);
            let on_perform = cb.on_perform_action.clone();
            let on_arm = cb.on_arm_confirm.clone();
            list = list.child(item(
                "pr-menu-enable-automerge",
                "superhero/merge.svg",
                if armed {
                    "Confirm auto-merge?".to_owned()
                } else {
                    "Enable auto-merge".to_owned()
                },
                fg,
                muted,
                false,
                busy,
                Box::new(move |window, cx| {
                    if armed {
                        on_arm(None, window, cx);
                        on_perform(
                            PullRequestAction::EnableAutoMerge,
                            Some(selected_method),
                            None,
                            window,
                            cx,
                        );
                    } else {
                        on_arm(Some(ConfirmableAction::EnableAutoMerge), window, cx);
                    }
                }),
            ));
        }
    }

    if shows_merge_methods {
        if shows_draft_toggle || shows_merge_now || shows_auto_merge {
            list = list.child(sep(divider));
        }
        for method in allowed_methods {
            let method = *method;
            let on_select = cb.on_select_merge_method.clone();
            let is_selected = method == selected_method;
            list = list.child(item(
                &format!("pr-menu-method-{method:?}"),
                if is_selected {
                    "superhero/check.svg"
                } else {
                    "superhero/merge.svg"
                },
                merge_method_label(method).to_owned(),
                fg,
                if is_selected { fg } else { muted },
                is_selected,
                busy,
                Box::new(move |window, cx| on_select(method, window, cx)),
            ));
        }
    }

    // Links & clipboard
    list = list.child(sep(divider));
    {
        let url = detail.url.clone();
        let on_open = cb.on_open_url.clone();
        list = list.child(item(
            "pr-menu-open-host",
            "superhero/arrow-up-right.svg",
            open_on_host_label(&detail.provider).to_owned(),
            fg,
            muted,
            false,
            false,
            Box::new(move |window, cx| on_open(url.clone(), window, cx)),
        ));
    }
    {
        let url = detail.url.clone();
        let on_close = cb.on_toggle_actions_menu.clone();
        list = list.child(item(
            "pr-menu-copy-link",
            "superhero/link.svg",
            "Copy link".to_owned(),
            fg,
            muted,
            false,
            false,
            Box::new(move |window, cx| {
                cx.write_to_clipboard(ClipboardItem::new_string(url.clone()));
                on_close(window, cx);
            }),
        ));
    }
    {
        let num = format!("#{}", detail.number);
        let on_close = cb.on_toggle_actions_menu.clone();
        list = list.child(item(
            "pr-menu-copy-number",
            "superhero/copy.svg",
            "Copy PR number".to_owned(),
            fg,
            muted,
            false,
            false,
            Box::new(move |window, cx| {
                cx.write_to_clipboard(ClipboardItem::new_string(num.clone()));
                on_close(window, cx);
            }),
        ));
    }
    if let Some(cmd) = checkout_command(&detail.provider, detail.number, &detail.head_branch) {
        let on_close = cb.on_toggle_actions_menu.clone();
        list = list.child(item(
            "pr-menu-copy-checkout",
            "superhero/terminal-window.svg",
            "Copy checkout command".to_owned(),
            fg,
            muted,
            false,
            false,
            Box::new(move |window, cx| {
                cx.write_to_clipboard(ClipboardItem::new_string(cmd.clone()));
                on_close(window, cx);
            }),
        ));
    }

    // Lifecycle destructive / revert / reopen
    if detail.state == PullRequestState::Open
        && can_perform_action(detail, PullRequestAction::Close)
    {
        let armed = armed_confirm == Some(ConfirmableAction::Close);
        let on_perform = cb.on_perform_action.clone();
        let on_arm = cb.on_arm_confirm.clone();
        list = list.child(sep(divider)).child(item(
            "pr-menu-close",
            "superhero/pull-request-closed.svg",
            if armed {
                "Confirm close?".to_owned()
            } else {
                "Close pull request".to_owned()
            },
            destructive,
            destructive,
            false,
            busy,
            Box::new(move |window, cx| {
                if armed {
                    on_arm(None, window, cx);
                    on_perform(PullRequestAction::Close, None, None, window, cx);
                } else {
                    on_arm(Some(ConfirmableAction::Close), window, cx);
                }
            }),
        ));
    } else if detail.state == PullRequestState::Closed
        && can_perform_action(detail, PullRequestAction::Reopen)
    {
        let on_perform = cb.on_perform_action.clone();
        list = list.child(sep(divider)).child(item(
            "pr-menu-reopen",
            "superhero/pull-request.svg",
            "Reopen pull request".to_owned(),
            fg,
            muted,
            false,
            busy,
            Box::new(move |window, cx| {
                on_perform(PullRequestAction::Reopen, None, None, window, cx);
            }),
        ));
    } else if detail.state == PullRequestState::Merged
        && can_perform_action(detail, PullRequestAction::Revert)
    {
        let armed = armed_confirm == Some(ConfirmableAction::Revert);
        let on_perform = cb.on_perform_action.clone();
        let on_arm = cb.on_arm_confirm.clone();
        list = list.child(sep(divider)).child(item(
            "pr-menu-revert",
            "superhero/retry.svg",
            if armed {
                "Confirm revert?".to_owned()
            } else {
                "Revert changes".to_owned()
            },
            if armed { destructive } else { fg },
            if armed { destructive } else { muted },
            false,
            busy,
            Box::new(move |window, cx| {
                if armed {
                    on_arm(None, window, cx);
                    on_perform(PullRequestAction::Revert, None, None, window, cx);
                } else {
                    on_arm(Some(ConfirmableAction::Revert), window, cx);
                }
            }),
        ));
    }

    if can_delete_branch(detail) {
        let armed = armed_confirm == Some(ConfirmableAction::DeleteBranch);
        let on_perform = cb.on_perform_action.clone();
        let on_arm = cb.on_arm_confirm.clone();
        list = list.child(sep(divider)).child(item(
            "pr-menu-delete-branch",
            "superhero/delete.svg",
            if pending_action == Some(PullRequestAction::DeleteBranch) {
                "Deleting branch...".to_owned()
            } else if armed {
                "Confirm delete branch?".to_owned()
            } else {
                format!("Delete branch {}", detail.head_branch)
            },
            destructive,
            destructive,
            false,
            busy,
            Box::new(move |window, cx| {
                if armed {
                    on_arm(None, window, cx);
                    on_perform(PullRequestAction::DeleteBranch, None, None, window, cx);
                } else {
                    on_arm(Some(ConfirmableAction::DeleteBranch), window, cx);
                }
            }),
        ));
    }

    deferred(div().absolute().top(px(30.0)).right(px(0.0)).child(list))
        .with_priority(3)
        .into_any_element()
}

/// Renders the compact single-line summary bar shown when the metadata header is condensed
/// (`PullRequestDetailPanel.tsx` condensed row).
pub(super) fn render_condensed_header_row(
    tokens: &Tokens,
    detail: &PullRequestDetail,
    now_ms: i64,
    cb: &HeaderCallbacks,
) -> AnyElement {
    let muted = to_hsla(tokens.muted_foreground);
    let divider = to_hsla(tokens.shell_divider);
    let updated = format_relative_time(&detail.updated_at, now_ms);
    let on_expand = cb.on_toggle_header_condensed.clone();

    h_flex()
        .id("pr-condensed-header-row")
        .a11y_button("panel.pr-condensed-header-row", "Show details")
        .w_full()
        .flex_shrink_0()
        .px(px(HEADER_INSET_X_PX))
        .py(px(6.0))
        .gap(px(8.0))
        .items_center()
        .border_b_1()
        .border_color(divider)
        .text_size(px(XS_TEXT_PX))
        .line_height(px(XS_LINE_HEIGHT_PX))
        .text_color(muted)
        .cursor_pointer()
        .on_click(move |_, window, cx| on_expand(window, cx))
        .child(render_actor_avatar(tokens, detail.author.as_ref(), 16.0))
        .child(div().flex_shrink_0().child(if updated.is_empty() {
            detail.updated_at.clone()
        } else {
            updated
        }))
        .child(div().h(px(12.0)).w(px(1.0)).flex_shrink_0().bg(divider))
        .child(
            h_flex()
                .flex_1()
                .min_w_0()
                .items_center()
                .gap(px(4.0))
                .font_family(SharedString::from(MONO_FONT))
                .text_size(px(11.0))
                .child(div().min_w_0().truncate().child(detail.head_branch.clone()))
                .child(div().flex_shrink_0().child("→"))
                .child(div().min_w_0().truncate().child(detail.base_branch.clone())),
        )
        .child(
            h_flex()
                .flex_shrink_0()
                .items_center()
                .gap(px(6.0))
                .child(
                    h_flex()
                        .items_center()
                        .gap(px(3.0))
                        .child(superhero_icon("superhero/file-diff.svg", 12.0, muted))
                        .child(format_grouped_count(detail.changed_files)),
                )
                .child(render_diff_stat(
                    tokens,
                    detail.additions,
                    detail.deletions,
                    11.0,
                )),
        )
        .into_any_element()
}

/// Renders the key-value metadata section (`PullRequestDetailHeaderBody` + `PullRequestPeopleRows`).
#[expect(
    clippy::too_many_arguments,
    reason = "view props passed explicitly from PullRequestPanel::render"
)]
pub(super) fn render_header_body(
    tokens: &Tokens,
    detail: &PullRequestDetail,
    comments: &[PullRequestComment],
    commits: &[PullRequestCommit],
    now_ms: i64,
    copied_branch: bool,
    pending_action: Option<PullRequestAction>,
    pickers: &HeaderPickerState<'_>,
    cb: &HeaderCallbacks,
) -> AnyElement {
    let fg = to_hsla(tokens.foreground);
    let muted = to_hsla(tokens.muted_foreground);
    let hover_bg = chrome::alpha(tokens.foreground, 0.06);
    let state_pres = resolve_state_presentation(detail.state, detail.is_draft);
    let state_color = to_hsla(state_tone_color(tokens, state_pres.tone));
    let parsed_url = parse_pull_request_url(&detail.url);
    let repo_url = parsed_url.as_ref().map(|p| p.repository_url.clone());

    // Repository value
    let repo_el: AnyElement = if let Some(url) = repo_url {
        let on_open = cb.on_open_url.clone();
        div()
            .id("pr-meta-repo")
            .a11y_button("panel.pr-meta-repo", "Repository")
            .min_w_0()
            .truncate()
            .cursor_pointer()
            .text_color(fg)
            .hover(|s| s.underline())
            .on_click(move |_, window, cx| on_open(url.clone(), window, cx))
            .conn_fast_tooltip(format!("Open {} repository", detail.repository), tokens)
            .child(detail.repository.clone())
            .into_any_element()
    } else {
        div()
            .min_w_0()
            .truncate()
            .text_color(fg)
            .child(detail.repository.clone())
            .into_any_element()
    };

    // Link value (`#42` + external-link in state color, plus compact state pill)
    let pr_url = detail.url.clone();
    let on_open_pr = cb.on_open_url.clone();
    let link_el = h_flex()
        .min_w_0()
        .items_center()
        .gap(px(8.0))
        .child(
            h_flex()
                .id("pr-meta-number-link")
                .a11y_button("panel.pr-meta-number-link", "Pull request link")
                .flex_shrink_0()
                .items_center()
                .gap(px(4.0))
                .cursor_pointer()
                .text_color(state_color)
                .hover(|s| s.underline())
                .on_click(move |_, window, cx| on_open_pr(pr_url.clone(), window, cx))
                .conn_fast_tooltip(open_on_host_label(&detail.provider), tokens)
                .child(format!("#{}", detail.number))
                .child(superhero_icon(
                    "superhero/external-link.svg",
                    12.0,
                    state_color,
                )),
        )
        .child(
            h_flex()
                .h(px(18.0))
                .px(px(6.0))
                .gap(px(4.0))
                .items_center()
                .rounded(px(PILL_RADIUS_PX))
                .bg(to_hsla(
                    state_tone_color(tokens, state_pres.tone).with_alpha(0.12),
                ))
                .text_size(px(11.0))
                .line_height(px(14.0))
                .font_weight(FontWeight::MEDIUM)
                .text_color(state_color)
                .child(superhero_icon(state_pres.icon, 11.0, state_color))
                .child(state_pres.label),
        )
        .into_any_element();

    // Author value
    let author_el = render_actor_label(tokens, detail.author.as_ref());

    // Updated at value
    let updated_text = format_relative_time(&detail.updated_at, now_ms);
    let updated_el = div()
        .id("pr-meta-updated-at")
        .text_color(muted)
        .conn_fast_tooltip(detail.updated_at.clone(), tokens)
        .child(if updated_text.is_empty() {
            detail.updated_at.clone()
        } else {
            updated_text
        })
        .into_any_element();

    // Branch value (`head` copyable + `into` + `base` + optional behind-by update button)
    let head_branch = detail.head_branch.clone();
    let on_copy_branch = cb.on_copy_branch.clone();
    let freshness = resolve_base_freshness(detail);
    let head_branch_tip = format!(
        "{}: {}",
        if copied_branch {
            "Copied"
        } else {
            "Copy branch"
        },
        detail.head_branch
    );
    let branch_row = h_flex()
        .ml(px(-4.0))
        .min_w_0()
        .flex_wrap()
        .items_center()
        .gap(px(6.0))
        .text_color(muted)
        .child(
            div()
                .id("pr-head-branch-copy")
                .a11y_button("panel.pr-head-branch-copy", "Copy head branch")
                .max_w(px(220.0))
                .truncate()
                .px(px(4.0))
                .py(px(2.0))
                .rounded(px(4.0))
                .cursor_pointer()
                .text_color(if copied_branch { fg } else { muted })
                .hover(move |s| s.bg(hover_bg).text_color(fg))
                .on_click(move |_, window, cx| on_copy_branch(head_branch.clone(), window, cx))
                .conn_code_tooltip(head_branch_tip, tokens)
                .child(if copied_branch {
                    "Copied".to_owned()
                } else {
                    detail.head_branch.clone()
                }),
        )
        .child(
            div()
                .flex_shrink_0()
                .text_color(chrome::alpha(tokens.muted_foreground, 0.7))
                .child("into"),
        )
        .child(render_base_branch_freshness(
            tokens,
            &detail.base_branch,
            freshness.as_ref(),
            pickers.base_freshness_open,
            pending_action,
            cb.on_toggle_base_freshness_popover.clone(),
            {
                let on_perform = cb.on_perform_action.clone();
                Rc::new(move |method, window, cx| {
                    on_perform(
                        PullRequestAction::UpdateBranch,
                        None,
                        Some(method),
                        window,
                        cx,
                    );
                })
            },
        ));

    // Changes value (`N files` + `+add -del`)
    let files_label = if detail.changed_files == 1 {
        "1 file".to_owned()
    } else {
        format!("{} files", format_grouped_count(detail.changed_files))
    };
    let changes_el = h_flex()
        .min_w_0()
        .items_center()
        .gap(px(6.0))
        .child(div().text_color(fg).child(files_label))
        .child(render_diff_stat(
            tokens,
            detail.additions,
            detail.deletions,
            14.0,
        ))
        .into_any_element();

    // Reviewers row
    let reviewer_entries = build_reviewer_entries(&detail.reviewers, comments, commits);
    let can_show_reviewer_picker =
        detail.capabilities.reviewers.request && detail.capabilities.reviewers.list_candidates;
    let mut reviewers_row = h_flex().min_w_0().flex_wrap().items_center().gap(px(6.0));
    if reviewer_entries.is_empty() {
        reviewers_row = reviewers_row.child(div().text_color(muted).child("None"));
    } else {
        for (idx, entry) in reviewer_entries.iter().enumerate() {
            let login = entry
                .actor
                .as_ref()
                .map_or("ghost", |a| a.login.as_str())
                .to_owned();
            let actor_label = actor_tooltip_label(entry.actor.as_ref());
            let reviewer_tip = match entry.outcome {
                Some(outcome) => {
                    let status = if entry.stale {
                        match outcome {
                            ReviewOutcome::Approved => "Approved before new commits",
                            ReviewOutcome::ChangesRequested => {
                                "Changes requested before new commits"
                            }
                            ReviewOutcome::Dismissed => "Review dismissed",
                        }
                    } else {
                        review_outcome_label(outcome)
                    };
                    format!("{actor_label}: {status}")
                }
                None => format!("{actor_label}: Review requested"),
            };
            let ring_color = entry.outcome.map(|outcome| {
                let base = review_outcome_color(tokens, outcome);
                if entry.stale {
                    to_hsla(color_mix_srgb(base, 0.35, tokens.shell_card))
                } else {
                    to_hsla(base)
                }
            });
            let mut chip = h_flex()
                .id(SharedString::from(format!("pr-reviewer-{idx}")))
                .items_center()
                .gap(px(4.0))
                .px(px(6.0))
                .py(px(2.0))
                .rounded(px(PILL_RADIUS_PX))
                .bg(chrome::alpha(tokens.foreground, 0.05))
                .text_size(px(XS_TEXT_PX))
                .line_height(px(XS_LINE_HEIGHT_PX))
                .text_color(fg)
                .conn_fast_tooltip(reviewer_tip, tokens)
                .child(chrome::actor_avatar(
                    tokens,
                    entry.actor.as_ref(),
                    16.0,
                    ring_color,
                    false,
                ))
                .child(login);
            if let Some(outcome) = entry.outcome {
                let outcome_color = to_hsla(if entry.stale {
                    tokens.muted_foreground.with_alpha(0.7)
                } else {
                    review_outcome_color(tokens, outcome)
                });
                let icon = match outcome {
                    ReviewOutcome::Approved => "superhero/check-circle.svg",
                    ReviewOutcome::ChangesRequested => "superhero/clear-circle.svg",
                    ReviewOutcome::Dismissed => "superhero/circle-dashed.svg",
                };
                chip = chip.child(superhero_icon(icon, 12.0, outcome_color)).child(
                    div()
                        .text_size(px(11.0))
                        .text_color(outcome_color)
                        .child(review_outcome_label(outcome)),
                );
            }
            reviewers_row = reviewers_row.child(chip);
        }
    }
    if can_show_reviewer_picker {
        reviewers_row = reviewers_row.child(render_reviewer_picker(
            tokens,
            detail.viewer_permissions.request_reviewers,
            pickers.reviewer_open,
            pickers.reviewer_search_input,
            pickers.reviewer_query,
            pickers.reviewer_loading,
            pickers.reviewer_error,
            pickers.reviewer_candidates,
            pickers.reviewer_truncated,
            pickers.reviewer_pending_id,
            cb.on_toggle_reviewer_picker.clone(),
            cb.on_select_reviewer_candidate.clone(),
        ));
    }
    let reviewers_el = reviewers_row.into_any_element();

    // Labels row
    let can_show_label_picker = detail.capabilities.labels == Some(true);
    let show_labels_row = !detail.labels.is_empty() || can_show_label_picker;
    let mut labels_row = h_flex().min_w_0().flex_wrap().items_center().gap(px(4.0));
    if detail.labels.is_empty() {
        labels_row = labels_row.child(div().text_color(muted).child("None"));
    } else {
        for (idx, label) in detail.labels.iter().enumerate() {
            let (bg, label_fg) = label_chip_colors(tokens, label.color.as_deref());
            let chip = div()
                .id(SharedString::from(format!("pr-label-{idx}")))
                .h(px(22.0))
                .max_w(px(192.0))
                .px(px(8.0))
                .flex()
                .items_center()
                .rounded(px(PILL_RADIUS_PX))
                .bg(to_hsla(bg))
                .text_size(px(XS_TEXT_PX))
                .line_height(px(XS_LINE_HEIGHT_PX))
                .font_weight(FontWeight::MEDIUM)
                .text_color(to_hsla(label_fg))
                .when_some(
                    label
                        .description
                        .as_ref()
                        .and_then(|d| d.as_deref())
                        .map(str::trim)
                        .filter(|d| !d.is_empty()),
                    |el, desc| el.conn_fast_tooltip(desc.to_owned(), tokens),
                )
                .child(div().min_w_0().truncate().child(label.name.clone()));
            labels_row = labels_row.child(chip);
        }
    }
    if can_show_label_picker {
        labels_row = labels_row.child(render_label_picker(
            tokens,
            detail.viewer_permissions.labels != Some(false),
            pickers.label_open,
            pickers.label_search_input,
            pickers.label_query,
            pickers.label_loading,
            pickers.label_error,
            pickers.label_candidates,
            pickers.label_truncated,
            pickers.label_pending_name,
            cb.on_toggle_label_picker.clone(),
            cb.on_select_label_candidate.clone(),
        ));
    }
    let labels_el = labels_row.into_any_element();

    let mut body = v_flex()
        .w_full()
        .min_w_0()
        .flex_shrink_0()
        .px(px(HEADER_INSET_X_PX))
        .py(px(16.0))
        .gap(px(8.0))
        .child(meta_row(
            tokens,
            "superhero/folder-git.svg",
            "Repository",
            repo_el,
        ))
        .child(meta_row(tokens, "superhero/link.svg", "Link", link_el))
        .child(meta_row(tokens, "superhero/user.svg", "Author", author_el))
        .child(meta_row(
            tokens,
            "superhero/clock.svg",
            "Updated at",
            updated_el,
        ))
        .child(meta_row(
            tokens,
            "superhero/branch.svg",
            "Branch",
            branch_row.into_any_element(),
        ))
        .child(meta_row(
            tokens,
            "superhero/file-diff.svg",
            "Changes",
            changes_el,
        ))
        .child(meta_row(
            tokens,
            "superhero/users.svg",
            "Reviewers",
            reviewers_el,
        ));
    if show_labels_row {
        body = body.child(meta_row(tokens, "superhero/tag.svg", "Labels", labels_el));
    }
    body.into_any_element()
}

fn meta_row(
    tokens: &Tokens,
    icon: &'static str,
    label: &'static str,
    value: AnyElement,
) -> AnyElement {
    let muted = to_hsla(tokens.muted_foreground);
    h_flex()
        .w_full()
        .min_w_0()
        .min_h(px(28.0))
        .items_center()
        .gap(px(8.0))
        .text_size(px(14.0))
        .line_height(px(20.0))
        .child(
            h_flex()
                .w(px(META_LABEL_WIDTH_PX))
                .flex_shrink_0()
                .items_center()
                .gap(px(6.0))
                .text_color(muted)
                .child(superhero_icon(icon, 14.0, muted))
                .child(label),
        )
        .child(div().flex_1().min_w_0().child(value))
        .into_any_element()
}

/// Circular 16px/24px remote avatar with monogram fallback (`IssueActorAvatar`).
pub(super) fn render_actor_avatar(
    tokens: &Tokens,
    actor: Option<&IssueActor>,
    size_px: f32,
) -> AnyElement {
    chrome::actor_avatar(tokens, actor, size_px, None, false)
}

/// Avatar + login label (`IssueActorLabel`).
pub(super) fn render_actor_label(tokens: &Tokens, actor: Option<&IssueActor>) -> AnyElement {
    let login = actor.map_or("ghost", |a| a.login.as_str()).to_owned();
    let tip = actor_tooltip_label(actor);
    h_flex()
        .id(SharedString::from(format!("pr-actor-{login}")))
        .min_w_0()
        .items_center()
        .gap(px(6.0))
        .conn_fast_tooltip(tip, tokens)
        .child(render_actor_avatar(tokens, actor, 16.0))
        .child(
            div()
                .min_w_0()
                .truncate()
                .font_weight(FontWeight::MEDIUM)
                .text_color(to_hsla(tokens.foreground))
                .child(login),
        )
        .into_any_element()
}

/// `+additions -deletions` mono diff stat (`PullRequestDiffStat`).
pub(super) fn render_diff_stat(
    tokens: &Tokens,
    additions: i64,
    deletions: i64,
    font_size_px: f32,
) -> AnyElement {
    if additions == 0 && deletions == 0 {
        return div().into_any_element();
    }
    h_flex()
        .flex_shrink_0()
        .items_center()
        .gap(px(4.0))
        .font_family(SharedString::from(MONO_FONT))
        .text_size(px(font_size_px))
        .child(
            div()
                .text_color(to_hsla(tokens.diff_added))
                .child(format!("+{}", format_grouped_count(additions))),
        )
        .child(
            div()
                .text_color(to_hsla(tokens.diff_removed))
                .child(format!("-{}", format_grouped_count(deletions))),
        )
        .into_any_element()
}

/// Loading skeleton matching Conn's `PullRequestDetailGhost` (`PullRequestGhosts.tsx`).
pub(super) fn render_detail_ghost(tokens: &Tokens, number: Option<i64>) -> AnyElement {
    let divider = to_hsla(tokens.shell_divider);
    let muted = to_hsla(tokens.muted_foreground);
    let bar = |w_px: f32, h_px: f32, radius_px: f32| {
        div()
            .w(px(w_px))
            .h(px(h_px))
            .rounded(px(radius_px))
            .bg(chrome::alpha(tokens.muted_foreground, 0.15))
    };

    let header = h_flex()
        .w_full()
        .flex_shrink_0()
        .items_center()
        .justify_between()
        .gap(px(8.0))
        .px(px(HEADER_INSET_X_PX))
        .py(px(14.0))
        .border_b_1()
        .border_color(divider)
        .child(div().flex_1().min_w_0().child(bar(240.0, 20.0, 4.0)))
        .child(
            h_flex()
                .h(px(28.0))
                .items_center()
                .gap(px(4.0))
                .child(bar(64.0, 24.0, PILL_RADIUS_PX))
                .child(
                    div()
                        .flex()
                        .size(px(24.0))
                        .items_center()
                        .justify_center()
                        .opacity(0.64)
                        .child(superhero_icon("superhero/more-horizontal.svg", 16.0, muted)),
                ),
        );

    let number_label = match number {
        Some(n) => format!("#{n}"),
        None => "#…".to_owned(),
    };
    let meta = v_flex()
        .w_full()
        .px(px(HEADER_INSET_X_PX))
        .py(px(16.0))
        .gap(px(8.0))
        .child(meta_row(
            tokens,
            "superhero/folder-git.svg",
            "Repository",
            bar(96.0, 12.0, 4.0).into_any_element(),
        ))
        .child(meta_row(
            tokens,
            "superhero/link.svg",
            "Link",
            div()
                .text_color(muted)
                .child(number_label)
                .into_any_element(),
        ))
        .child(meta_row(
            tokens,
            "superhero/user.svg",
            "Author",
            h_flex()
                .items_center()
                .gap(px(6.0))
                .child(bar(16.0, 16.0, PILL_RADIUS_PX))
                .child(bar(56.0, 12.0, 4.0))
                .into_any_element(),
        ))
        .child(meta_row(
            tokens,
            "superhero/clock.svg",
            "Updated at",
            bar(64.0, 12.0, 4.0).into_any_element(),
        ))
        .child(meta_row(
            tokens,
            "superhero/branch.svg",
            "Branch",
            h_flex()
                .items_center()
                .gap(px(6.0))
                .child(bar(128.0, 12.0, 4.0))
                .child(
                    div()
                        .text_color(chrome::alpha(tokens.muted_foreground, 0.7))
                        .child("into"),
                )
                .child(bar(48.0, 12.0, 4.0))
                .into_any_element(),
        ))
        .child(meta_row(
            tokens,
            "superhero/file-diff.svg",
            "Changes",
            h_flex()
                .items_center()
                .gap(px(6.0))
                .child(bar(40.0, 12.0, 4.0))
                .child(bar(80.0, 12.0, 4.0))
                .into_any_element(),
        ))
        .child(meta_row(
            tokens,
            "superhero/users.svg",
            "Reviewers",
            bar(40.0, 12.0, 4.0).into_any_element(),
        ))
        .child(meta_row(
            tokens,
            "superhero/tag.svg",
            "Labels",
            h_flex()
                .items_center()
                .gap(px(4.0))
                .child(bar(96.0, 18.0, PILL_RADIUS_PX))
                .child(bar(80.0, 18.0, PILL_RADIUS_PX))
                .into_any_element(),
        ));

    let mut tab_bar = h_flex()
        .w_full()
        .h(px(49.0))
        .px(px(HEADER_INSET_X_PX))
        .gap(px(20.0))
        .items_center()
        .border_y_1()
        .border_color(divider);
    for tab in DetailTab::ALL {
        let active = tab == DetailTab::Summary;
        tab_bar = tab_bar.child(
            div()
                .relative()
                .h_full()
                .flex()
                .items_center()
                .text_size(px(14.0))
                .font_weight(FontWeight::MEDIUM)
                .text_color(if active {
                    to_hsla(tokens.foreground)
                } else {
                    muted
                })
                .child(tab.label())
                .when(active, |el| {
                    el.child(
                        div()
                            .absolute()
                            .left_0()
                            .right_0()
                            .bottom(px(-1.0))
                            .h(px(2.0))
                            .bg(chrome::alpha(tokens.foreground, 0.80)),
                    )
                }),
        );
    }

    let body_ghost = v_flex()
        .w_full()
        .px(px(HEADER_INSET_X_PX))
        .py(px(16.0))
        .gap(px(12.0))
        .child(bar(160.0, 20.0, 4.0))
        .child(
            v_flex()
                .w_full()
                .gap(px(8.0))
                .child(
                    div()
                        .w_full()
                        .h(px(16.0))
                        .rounded(px(4.0))
                        .bg(chrome::alpha(tokens.muted_foreground, 0.15)),
                )
                .child(
                    div()
                        .w(relative(0.92))
                        .h(px(16.0))
                        .rounded(px(4.0))
                        .bg(chrome::alpha(tokens.muted_foreground, 0.15)),
                )
                .child(
                    div()
                        .w(relative(0.80))
                        .h(px(16.0))
                        .rounded(px(4.0))
                        .bg(chrome::alpha(tokens.muted_foreground, 0.15)),
                )
                .child(
                    div()
                        .w(relative(0.66))
                        .h(px(16.0))
                        .rounded(px(4.0))
                        .bg(chrome::alpha(tokens.muted_foreground, 0.15)),
                ),
        );

    v_flex()
        .size_full()
        .child(header)
        .child(
            v_flex()
                .flex_1()
                .min_h_0()
                .overflow_hidden()
                .child(meta)
                .child(tab_bar)
                .child(body_ghost),
        )
        .into_any_element()
}

/// Centered unavailable / empty state matching `PullRequestsUnavailableState.tsx` + `ui/empty.tsx`.
pub(super) fn render_unavailable_state(
    tokens: &Tokens,
    title: impl Into<SharedString>,
    description: impl Into<SharedString>,
    on_retry: Option<Rc<dyn Fn(&mut Window, &mut App)>>,
    host_link: Option<(
        String,
        &'static str,
        Rc<dyn Fn(String, &mut Window, &mut App)>,
    )>,
) -> AnyElement {
    let fg = to_hsla(tokens.foreground);
    let muted = to_hsla(tokens.muted_foreground);

    let media = div()
        .flex()
        .size(px(36.0))
        .items_center()
        .justify_center()
        .rounded(px(8.0))
        .bg(to_hsla(tokens.shell_tile))
        .border_1()
        .border_color(to_hsla(tokens.shell_tile_border))
        .child(superhero_icon("superhero/pull-request.svg", 18.0, fg));

    let mut actions = h_flex().flex_wrap().justify_center().gap(px(8.0));
    let mut has_actions = false;
    if let Some(retry) = on_retry {
        has_actions = true;
        actions = actions.child(small_outline_button(
            "pr-unavailable-retry",
            Some("superhero/refresh.svg"),
            "Retry",
            tokens,
            false,
            move |window, cx| retry(window, cx),
        ));
    }
    if let Some((url, label, on_open)) = host_link {
        has_actions = true;
        actions = actions.child(small_outline_button(
            "pr-unavailable-open-host",
            Some("superhero/external-link.svg"),
            label,
            tokens,
            false,
            move |window, cx| on_open(url.clone(), window, cx),
        ));
    }

    v_flex()
        .flex_1()
        .size_full()
        .items_center()
        .justify_center()
        .p(px(24.0))
        .gap(px(16.0))
        .child(media)
        .child(
            v_flex()
                .max_w(px(384.0))
                .items_center()
                .gap(px(4.0))
                .child(
                    div()
                        .text_size(px(18.0))
                        .line_height(px(24.0))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(fg)
                        .text_center()
                        .child(title.into()),
                )
                .child(
                    div()
                        .text_size(px(UI_TEXT_PX))
                        .line_height(px(UI_LINE_HEIGHT_PX))
                        .text_color(muted)
                        .text_center()
                        .child(description.into()),
                ),
        )
        .when(has_actions, |el| el.child(actions))
        .into_any_element()
}

/// Primary pill button (`Button size="xs" variant="default"` inside `[--control-radius:9999px]`).
pub(super) fn primary_pill_button(
    id: impl Into<SharedString>,
    icon: &'static str,
    label: impl Into<SharedString>,
    tokens: &Tokens,
    disabled: bool,
    on_click: impl Fn(&mut Window, &mut App) + 'static,
) -> AnyElement {
    let fg = to_hsla(tokens.primary_foreground);
    let bg = to_hsla(tokens.primary);
    let hover = to_hsla(tokens.primary.with_alpha(0.9));
    let label: SharedString = label.into();
    let mut btn = h_flex()
        .id(id.into())
        .flex_shrink_0()
        .h(px(24.0))
        .px(px(8.0))
        .gap(px(4.0))
        .items_center()
        .rounded(px(PILL_RADIUS_PX))
        .bg(bg)
        .text_size(px(XS_TEXT_PX))
        .line_height(px(XS_LINE_HEIGHT_PX))
        .font_weight(FontWeight::MEDIUM)
        .text_color(fg)
        .conn_fast_tooltip(label.clone(), tokens)
        .child(superhero_icon(icon, 14.0, fg))
        .child(label);
    if disabled {
        btn = btn.opacity(0.64);
    } else {
        btn = btn
            .cursor_pointer()
            .hover(move |s| s.bg(hover))
            .on_click(move |_, window, cx| on_click(window, cx));
    }
    btn.into_any_element()
}

/// Outline button (`Button size="xs" variant="outline"`).
pub(super) fn small_outline_button(
    id: impl Into<SharedString>,
    icon: Option<&'static str>,
    label: impl Into<SharedString>,
    tokens: &Tokens,
    disabled: bool,
    on_click: impl Fn(&mut Window, &mut App) + 'static,
) -> AnyElement {
    let fg = to_hsla(tokens.foreground);
    let muted = to_hsla(tokens.muted_foreground);
    let (bg, hover) = match tokens.appearance {
        Appearance::Dark => (
            to_hsla(tokens.input.with_alpha(0.32)),
            to_hsla(tokens.input.with_alpha(0.64)),
        ),
        Appearance::Light => (
            to_hsla(tokens.popover),
            to_hsla(tokens.accent.with_alpha(0.5)),
        ),
    };
    let mut btn = h_flex()
        .id(id.into())
        .flex_shrink_0()
        .h(px(26.0))
        .px(px(9.0))
        .gap(px(5.0))
        .items_center()
        .rounded(px(6.0))
        .bg(bg)
        .border_1()
        .border_color(to_hsla(tokens.input))
        .text_size(px(XS_TEXT_PX))
        .line_height(px(XS_LINE_HEIGHT_PX))
        .font_weight(FontWeight::MEDIUM)
        .text_color(fg);
    if let Some(path) = icon {
        btn = btn.child(superhero_icon(path, 14.0, muted));
    }
    btn = btn.child(label.into());
    if disabled {
        btn = btn.opacity(0.64);
    } else {
        btn = btn
            .cursor_pointer()
            .hover(move |s| s.bg(hover))
            .on_click(move |_, window, cx| on_click(window, cx));
    }
    btn.into_any_element()
}

/// Ghost button (`Button size="xs" variant="ghost"`).
pub(super) fn small_ghost_button(
    id: impl Into<SharedString>,
    label: impl Into<SharedString>,
    tokens: &Tokens,
    disabled: bool,
    on_click: impl Fn(&mut Window, &mut App) + 'static,
) -> AnyElement {
    let fg = to_hsla(tokens.foreground);
    let hover = to_hsla(tokens.shell_highlight);
    let mut btn = h_flex()
        .id(id.into())
        .flex_shrink_0()
        .h(px(26.0))
        .px(px(8.0))
        .gap(px(4.0))
        .items_center()
        .rounded(px(6.0))
        .text_size(px(XS_TEXT_PX))
        .line_height(px(XS_LINE_HEIGHT_PX))
        .font_weight(FontWeight::MEDIUM)
        .text_color(fg)
        .child(label.into());
    if disabled {
        btn = btn.opacity(0.64);
    } else {
        btn = btn
            .cursor_pointer()
            .hover(move |s| s.bg(hover))
            .on_click(move |_, window, cx| on_click(window, cx));
    }
    btn.into_any_element()
}
