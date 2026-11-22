//! Pull request tab bar (`PullRequestDetailTabBar`), Description, Checks, Timeline, Code tabs,
//! and the floating bottom-right Comment composer (`PullRequestComposer` / `PullRequestCommentForm`).

use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use conn_contract::{
    IssueReaction, IssueReactionContent, PullRequestAction, PullRequestCheckStatus,
    PullRequestComment, PullRequestCommit, PullRequestDetail, PullRequestFileViewedState,
    PullRequestReviewThread, PullRequestReviewVerdict, PullRequestState,
};
use conn_theme::{Appearance, Tokens, color_mix_srgb};
use gpui_kit::component::input::{Textarea, TextareaState};
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::*;
use gpui_kit::{
    AnyElement, App, BoxShadow, Entity, FontWeight, InteractiveElement, IntoElement, MouseButton,
    ParentElement, SharedString, StatefulInteractiveElement, Styled, Window, deferred, div, point,
    px,
};

use super::super::chrome::{
    self, ConnTooltipExt as _, UI_LINE_HEIGHT_PX, UI_TEXT_PX, XS_LINE_HEIGHT_PX, XS_TEXT_PX,
};
use super::super::color::to_hsla;
use super::super::diff_parser::{DiffFile, DiffLineKind};
use super::super::header::superhero_icon;
use super::super::highlight::highlight_lines;
use super::header::{
    ConfirmableAction, render_actor_avatar, render_diff_stat, small_ghost_button,
    small_outline_button,
};
use super::logic::{
    ChecksState, CommentFilter, ComposerMode, DetailTab, ReviewOutcome, TimelineEvent,
    TimelineEventKind, TimelineOrder, TimelineRow, TimelineThread, available_review_verdicts,
    build_fix_check_prompt, build_fix_findings_prompt, build_fix_thread_prompt, build_timeline,
    can_edit_change_request, can_perform_action, can_submit_review, check_status_color,
    check_status_icon, check_status_label, filter_timeline_events, format_grouped_count,
    format_relative_time, group_timeline_rows, is_request_changes_summary_required,
    is_verdict_stale, newest_commit_at, resolve_state_presentation, review_outcome,
    review_outcome_color, review_outcome_label, review_placeholder, review_verdict_icon,
    review_verdict_label, state_tone_color, summarize_checks,
};
use super::pickers::render_reaction_bar;
use crate::chat::markdown::{MarkdownOptions, render_markdown};
use crate::theme::MONO_FONT;

const INSET_X_PX: f32 = 18.0; // `px-4.5`
const TAB_BAR_HEIGHT_PX: f32 = 49.0; // `h-12.25`
const PILL_RADIUS_PX: f32 = 9999.0;

/// Cached per-file diff state in the Code tab.
#[derive(Clone, Debug)]
pub(super) enum FileDiffState {
    Idle,
    Loading,
    Loaded(DiffFile),
    Error(String),
}

/// One changed file entry shown in the Code tab list.
#[derive(Clone, Debug)]
pub(super) struct CodeFileEntry {
    pub(super) path: String,
    pub(super) old_path: String,
    pub(super) additions: Option<usize>,
    pub(super) deletions: Option<usize>,
}

/// Callbacks for the tab bar and active tab views.
pub(super) struct TabCallbacks {
    pub(super) on_select_tab: Rc<dyn Fn(DetailTab, &mut Window, &mut App)>,
    pub(super) on_start_edit_body: Rc<dyn Fn(&mut Window, &mut App)>,
    pub(super) on_cancel_edit_body: Rc<dyn Fn(&mut Window, &mut App)>,
    pub(super) on_save_body: Rc<dyn Fn(&mut Window, &mut App)>,
    pub(super) on_approve_workflows: Rc<dyn Fn(&mut Window, &mut App)>,
    pub(super) on_open_url: Rc<dyn Fn(String, &mut Window, &mut App)>,
    pub(super) on_toggle_timeline_order: Rc<dyn Fn(&mut Window, &mut App)>,
    pub(super) on_toggle_filter_menu: Rc<dyn Fn(&mut Window, &mut App)>,
    pub(super) on_toggle_filter_bots: Rc<dyn Fn(&mut Window, &mut App)>,
    pub(super) on_toggle_filter_resolved: Rc<dyn Fn(&mut Window, &mut App)>,
    pub(super) on_toggle_group: Rc<dyn Fn(String, &mut Window, &mut App)>,
    pub(super) on_toggle_thread: Rc<dyn Fn(String, &mut Window, &mut App)>,
    pub(super) on_resolve_thread: Rc<dyn Fn(String, bool, &mut Window, &mut App)>,
    pub(super) on_start_reply: Rc<dyn Fn(Option<String>, &mut Window, &mut App)>,
    pub(super) on_submit_reply: Rc<dyn Fn(String, &mut Window, &mut App)>,
    pub(super) on_select_code_file: Rc<dyn Fn(String, &mut Window, &mut App)>,
    pub(super) on_toggle_file_viewed: Rc<dyn Fn(String, bool, &mut Window, &mut App)>,
    pub(super) on_toggle_code_wrap: Rc<dyn Fn(&mut Window, &mut App)>,
    pub(super) on_toggle_code_tree: Rc<dyn Fn(&mut Window, &mut App)>,
    pub(super) on_reload_code: Rc<dyn Fn(&mut Window, &mut App)>,
    pub(super) on_toggle_composer: Rc<dyn Fn(&mut Window, &mut App)>,
    pub(super) on_submit_comment: Rc<dyn Fn(Option<PullRequestAction>, &mut Window, &mut App)>,
    pub(super) on_set_composer_mode: Rc<dyn Fn(ComposerMode, &mut Window, &mut App)>,
    pub(super) on_select_review_verdict:
        Rc<dyn Fn(PullRequestReviewVerdict, &mut Window, &mut App)>,
    pub(super) on_submit_review: Rc<dyn Fn(&mut Window, &mut App)>,
    pub(super) on_toggle_reaction_picker: Rc<dyn Fn(String, &mut Window, &mut App)>,
    pub(super) on_toggle_reaction: Rc<
        dyn Fn(String, Option<String>, IssueReactionContent, bool, String, &mut Window, &mut App),
    >,
    pub(super) on_send_prompt: Rc<dyn Fn(String, &mut Window, &mut App)>,
    pub(super) on_arm_confirm: Rc<dyn Fn(Option<ConfirmableAction>, &mut Window, &mut App)>,
}

/// Shared reaction overlay & picker state passed into description and timeline tabs.
pub(super) struct ReactionState<'a> {
    pub(super) can_react: bool,
    pub(super) open_picker: Option<&'a str>,
    pub(super) pending: &'a HashMap<String, (String, HashMap<IssueReactionContent, bool>)>,
}

/// Renders Conn's `PullRequestDetailTabBar` (`h-12.25 border-y px-4.5 gap-5`) with the active
/// tab's trailing controls at the right end.
pub(super) fn render_tab_bar(
    tokens: &Tokens,
    active_tab: DetailTab,
    can_show_code: bool,
    trailing: Option<AnyElement>,
    cb: &TabCallbacks,
) -> AnyElement {
    let fg = to_hsla(tokens.foreground);
    let muted = to_hsla(tokens.muted_foreground);
    let divider = to_hsla(tokens.shell_divider);
    let active_bar = chrome::alpha(tokens.foreground, 0.80);

    let mut tabs_row = h_flex()
        .flex_shrink_0()
        .h_full()
        .items_center()
        .gap(px(20.0));
    for tab in DetailTab::ALL {
        if tab == DetailTab::Code && !can_show_code {
            continue;
        }
        let is_active = tab == active_tab;
        let on_select = cb.on_select_tab.clone();
        let mut btn = div()
            .id(SharedString::from(format!("pr-tab-{}", tab.id())))
            .relative()
            .h_full()
            .px(px(2.0))
            .flex()
            .items_center()
            .cursor_pointer()
            .text_size(px(14.0))
            .line_height(px(20.0))
            .font_weight(FontWeight::MEDIUM)
            .text_color(if is_active { fg } else { muted })
            .when(!is_active, |el| el.hover(move |s| s.text_color(fg)))
            .on_click(move |_, window, cx| on_select(tab, window, cx))
            .child(tab.label());
        if is_active {
            btn = btn.child(
                div()
                    .absolute()
                    .left_0()
                    .right_0()
                    .bottom(px(-1.0))
                    .h(px(2.0))
                    .bg(active_bar),
            );
        }
        tabs_row = tabs_row.child(btn);
    }

    h_flex()
        .w_full()
        .flex_shrink_0()
        .h(px(TAB_BAR_HEIGHT_PX))
        .px(px(INSET_X_PX))
        .gap(px(12.0))
        .items_center()
        .border_y_1()
        .border_color(divider)
        .bg(to_hsla(tokens.shell_card))
        .child(tabs_row)
        .child(
            h_flex()
                .flex_1()
                .min_w_0()
                .items_center()
                .justify_end()
                .gap(px(8.0))
                .when_some(trailing, |el, right| el.child(right)),
        )
        .into_any_element()
}

/// Trailing controls for the Checks tab bar.
pub(super) fn render_checks_tab_trailing(
    tokens: &Tokens,
    detail: &PullRequestDetail,
    checks_state: Option<ChecksState>,
    pending_action: Option<PullRequestAction>,
    armed_confirm: Option<ConfirmableAction>,
    cb: &TabCallbacks,
) -> AnyElement {
    let approvals_needed = if detail.state == PullRequestState::Open {
        detail.workflow_approvals_required.unwrap_or(0)
    } else {
        0
    };
    if approvals_needed > 0 && can_perform_action(detail, PullRequestAction::ApproveWorkflows) {
        let armed = armed_confirm == Some(ConfirmableAction::ApproveWorkflows);
        let busy = pending_action.is_some();
        let warn = to_hsla(tokens.warning_foreground);
        let bg = to_hsla(tokens.warning.with_alpha(0.12));
        let border = to_hsla(tokens.warning.with_alpha(0.32));
        let label = if pending_action == Some(PullRequestAction::ApproveWorkflows) {
            "Approving..."
        } else if armed {
            "Confirm approve?"
        } else {
            "Approve workflows to run"
        };
        let on_approve = cb.on_approve_workflows.clone();
        let on_arm = cb.on_arm_confirm.clone();
        let mut btn = h_flex()
            .id("pr-approve-workflows-btn")
            .flex_shrink_0()
            .h(px(24.0))
            .px(px(8.0))
            .gap(px(4.0))
            .items_center()
            .rounded(px(6.0))
            .bg(bg)
            .border_1()
            .border_color(border)
            .text_size(px(XS_TEXT_PX))
            .line_height(px(XS_LINE_HEIGHT_PX))
            .font_weight(FontWeight::MEDIUM)
            .text_color(warn)
            .conn_fast_tooltip(label, tokens)
            .child(superhero_icon("superhero/play.svg", 13.0, warn))
            .child(label);
        if busy {
            btn = btn.opacity(0.64);
        } else {
            btn = btn.cursor_pointer().on_click(move |_, window, cx| {
                if armed {
                    on_arm(None, window, cx);
                    on_approve(window, cx);
                } else {
                    on_arm(Some(ConfirmableAction::ApproveWorkflows), window, cx);
                }
            });
        }
        return btn.into_any_element();
    }

    let summary = summarize_checks(&detail.checks);
    let (icon, color) = match checks_state {
        Some(ChecksState::Passing) => ("superhero/check-circle.svg", to_hsla(tokens.success)),
        Some(ChecksState::Failing) => ("superhero/clear-circle.svg", to_hsla(tokens.destructive)),
        Some(ChecksState::Pending) => ("superhero/circle-dot.svg", to_hsla(tokens.warning)),
        None => ("superhero/circle-dot.svg", to_hsla(tokens.muted_foreground)),
    };
    let mut row = h_flex().min_w_0().items_center().gap(px(8.0)).child(
        h_flex()
            .min_w_0()
            .items_center()
            .gap(px(6.0))
            .text_size(px(UI_TEXT_PX))
            .line_height(px(UI_LINE_HEIGHT_PX))
            .text_color(chrome::alpha(tokens.foreground, 0.85))
            .child(superhero_icon(icon, 14.0, color))
            .child(div().min_w_0().truncate().child(summary)),
    );
    if checks_state == Some(ChecksState::Failing) {
        let prompt = build_fix_findings_prompt(detail, &[], &[], &detail.checks, false);
        let on_send = cb.on_send_prompt.clone();
        row = row.child(small_outline_button(
            "pr-fix-failing-checks-btn",
            Some("superhero/tool.svg"),
            "Fix failing checks",
            tokens,
            false,
            move |window, cx| on_send(prompt.clone(), window, cx),
        ));
    }
    row.into_any_element()
}

/// Trailing controls for the Timeline tab bar (`commentCount · commits · approvals`, filter menu,
/// newest/oldest pill toggle).
#[expect(
    clippy::too_many_arguments,
    reason = "view props passed explicitly from PullRequestPanel::render"
)]
pub(super) fn render_timeline_tab_trailing(
    tokens: &Tokens,
    comment_count: i64,
    commit_count: usize,
    approval_count: usize,
    activity_loading: bool,
    filter: CommentFilter,
    filter_menu_open: bool,
    order: TimelineOrder,
    cb: &TabCallbacks,
) -> AnyElement {
    let fg = to_hsla(tokens.foreground);
    let muted = to_hsla(tokens.muted_foreground);
    let success = to_hsla(tokens.success);
    let pill_bg = to_hsla(tokens.shell_control);
    let pill_border = to_hsla(tokens.shell_divider_header);
    let hover = to_hsla(tokens.shell_highlight);

    let comments_str = if activity_loading {
        "…".to_owned()
    } else {
        format_grouped_count(comment_count)
    };
    let commits_str = if activity_loading {
        "…".to_owned()
    } else {
        format_grouped_count(i64::try_from(commit_count).unwrap_or(i64::MAX))
    };

    let filter_active = !(filter.bots && filter.resolved);
    let on_toggle_filter = cb.on_toggle_filter_menu.clone();
    let mut filter_anchor = div().relative().child(
        div()
            .id("pr-timeline-filter-btn")
            .flex()
            .flex_shrink_0()
            .size(px(28.0))
            .items_center()
            .justify_center()
            .rounded(px(PILL_RADIUS_PX))
            .bg(pill_bg)
            .border_1()
            .border_color(pill_border)
            .cursor_pointer()
            .hover(move |s| s.bg(hover))
            .on_click(move |_, window, cx| on_toggle_filter(window, cx))
            .conn_fast_tooltip("Filter timeline", tokens)
            .child(superhero_icon(
                "superhero/filter.svg",
                14.0,
                if filter_active { fg } else { muted },
            )),
    );

    if filter_menu_open {
        let on_bots = cb.on_toggle_filter_bots.clone();
        let on_resolved = cb.on_toggle_filter_resolved.clone();
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
        let check_row = |id: &'static str,
                         label: &'static str,
                         checked: bool,
                         on_click: Rc<dyn Fn(&mut Window, &mut App)>| {
            h_flex()
                .id(id)
                .w_full()
                .min_h(px(28.0))
                .px(px(8.0))
                .py(px(4.0))
                .gap(px(8.0))
                .items_center()
                .rounded(px(8.0))
                .cursor_pointer()
                .text_size(px(13.0))
                .text_color(fg)
                .hover(move |s| s.bg(hover))
                .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                    cx.stop_propagation();
                    on_click(window, cx);
                })
                .child(div().w(px(14.0)).child(if checked {
                    superhero_icon("superhero/check.svg", 13.0, fg).into_any_element()
                } else {
                    div().into_any_element()
                }))
                .child(label)
        };

        let menu = v_flex()
            .id("pr-timeline-filter-popup")
            .min_w(px(190.0))
            .p(px(4.0))
            .rounded(px(12.0))
            .bg(to_hsla(tokens.popover))
            .border_1()
            .border_color(divider)
            .shadow(vec![shadow])
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .child(
                div()
                    .px(px(8.0))
                    .py(px(4.0))
                    .text_size(px(11.0))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(muted)
                    .child("Show"),
            )
            .child(check_row(
                "pr-filter-bots",
                "Bot comments",
                filter.bots,
                on_bots,
            ))
            .child(check_row(
                "pr-filter-resolved",
                "Resolved or dismissed",
                filter.resolved,
                on_resolved,
            ));

        filter_anchor = filter_anchor.child(
            deferred(div().absolute().top(px(34.0)).right(px(0.0)).child(menu)).with_priority(3),
        );
    }

    let on_order = cb.on_toggle_timeline_order.clone();
    let order_btn = h_flex()
        .id("pr-timeline-order-btn")
        .flex_shrink_0()
        .h(px(28.0))
        .px(px(12.0))
        .gap(px(6.0))
        .items_center()
        .rounded(px(PILL_RADIUS_PX))
        .bg(pill_bg)
        .border_1()
        .border_color(pill_border)
        .cursor_pointer()
        .text_size(px(UI_TEXT_PX))
        .line_height(px(UI_LINE_HEIGHT_PX))
        .text_color(fg)
        .hover(move |s| s.bg(hover))
        .on_click(move |_, window, cx| on_order(window, cx))
        .child(superhero_icon("superhero/sort-order.svg", 14.0, muted))
        .child(order.label());

    h_flex()
        .flex_shrink_0()
        .items_center()
        .gap(px(6.0))
        .text_size(px(11.0))
        .text_color(muted)
        .child(
            h_flex()
                .items_center()
                .gap(px(4.0))
                .child(superhero_icon("superhero/thread.svg", 12.0, muted))
                .child(comments_str),
        )
        .child(
            div()
                .text_color(chrome::alpha(tokens.muted_foreground, 0.5))
                .child("·"),
        )
        .child(
            h_flex()
                .items_center()
                .gap(px(4.0))
                .child(superhero_icon("superhero/commit.svg", 12.0, muted))
                .child(commits_str),
        )
        .when(approval_count > 0, |el| {
            el.child(
                div()
                    .text_color(chrome::alpha(tokens.muted_foreground, 0.5))
                    .child("·"),
            )
            .child(
                h_flex()
                    .items_center()
                    .gap(px(4.0))
                    .text_color(success)
                    .child(superhero_icon("superhero/check-circle.svg", 12.0, success))
                    .child(approval_count.to_string()),
            )
        })
        .child(
            div()
                .text_color(chrome::alpha(tokens.muted_foreground, 0.5))
                .child("·"),
        )
        .child(filter_anchor)
        .child(order_btn)
        .into_any_element()
}

/// Trailing controls for the Code tab bar (file tree toggle, wrap lines toggle, reload).
pub(super) fn render_code_tab_trailing(
    tokens: &Tokens,
    file_count: usize,
    viewed_count: usize,
    tree_open: bool,
    word_wrap: bool,
    cb: &TabCallbacks,
) -> AnyElement {
    let fg = to_hsla(tokens.foreground);
    let muted = to_hsla(tokens.muted_foreground);
    let hover = to_hsla(tokens.shell_highlight);

    let on_tree = cb.on_toggle_code_tree.clone();
    let on_wrap = cb.on_toggle_code_wrap.clone();
    let on_reload = cb.on_reload_code.clone();

    let toggle_btn = |id: &'static str,
                      icon: &'static str,
                      tooltip: &'static str,
                      active: bool,
                      on_click: Rc<dyn Fn(&mut Window, &mut App)>| {
        div()
            .id(id)
            .flex()
            .flex_shrink_0()
            .size(px(24.0))
            .items_center()
            .justify_center()
            .rounded(px(PILL_RADIUS_PX))
            .cursor_pointer()
            .hover(move |s| s.bg(hover))
            .on_click(move |_, window, cx| on_click(window, cx))
            .conn_fast_tooltip(tooltip, tokens)
            .child(superhero_icon(icon, 14.0, if active { fg } else { muted }))
    };

    h_flex()
        .flex_shrink_0()
        .items_center()
        .gap(px(8.0))
        .when(file_count > 0, |el| {
            let label = if viewed_count > 0 {
                format!("{viewed_count}/{file_count} viewed")
            } else if file_count == 1 {
                "1 file".to_owned()
            } else {
                format!("{file_count} files")
            };
            el.child(
                div()
                    .text_size(px(XS_TEXT_PX))
                    .line_height(px(XS_LINE_HEIGHT_PX))
                    .text_color(muted)
                    .child(label),
            )
        })
        .child(
            chrome::toolbar_group(tokens)
                .child(toggle_btn(
                    "pr-code-tree-toggle",
                    "superhero/file-tree.svg",
                    if tree_open {
                        "Hide file tree"
                    } else {
                        "Show file tree"
                    },
                    tree_open,
                    on_tree,
                ))
                .child(toggle_btn(
                    "pr-code-wrap-toggle",
                    "superhero/wrap-lines.svg",
                    if word_wrap {
                        "Disable line wrapping"
                    } else {
                        "Enable line wrapping"
                    },
                    word_wrap,
                    on_wrap,
                ))
                .child(toggle_btn(
                    "pr-code-reload",
                    "superhero/refresh.svg",
                    "Reload diff",
                    false,
                    on_reload,
                )),
        )
        .into_any_element()
}

/// Renders the Description (`summary`) tab (`PullRequestDescriptionTab`).
#[expect(
    clippy::too_many_arguments,
    reason = "view props passed explicitly from PullRequestPanel::render"
)]
pub(super) fn render_description_tab(
    tokens: &Tokens,
    detail: &PullRequestDetail,
    pr_reactions: &[IssueReaction],
    reaction_state: &ReactionState<'_>,
    editing_body: bool,
    body_input: &Entity<TextareaState>,
    body_saving: bool,
    cb: &TabCallbacks,
) -> AnyElement {
    let muted = to_hsla(tokens.muted_foreground);
    let hover = to_hsla(tokens.shell_highlight);

    if editing_body {
        return v_flex()
            .w_full()
            .px(px(INSET_X_PX))
            .py(px(16.0))
            .gap(px(10.0))
            .child(
                div()
                    .w_full()
                    .min_h(px(140.0))
                    .p(px(10.0))
                    .rounded(px(8.0))
                    .bg(to_hsla(tokens.shell_field))
                    .border_1()
                    .border_color(to_hsla(tokens.ring))
                    .child(
                        Textarea::new(body_input)
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
                        "pr-body-cancel",
                        "Cancel",
                        tokens,
                        body_saving,
                        {
                            let on_cancel = cb.on_cancel_edit_body.clone();
                            move |window, cx| on_cancel(window, cx)
                        },
                    ))
                    .child(small_outline_button(
                        "pr-body-save",
                        None,
                        if body_saving { "Saving..." } else { "Save" },
                        tokens,
                        body_saving,
                        {
                            let on_save = cb.on_save_body.clone();
                            move |window, cx| on_save(window, cx)
                        },
                    )),
            )
            .into_any_element();
    }

    let text = if detail.body.trim().is_empty() {
        "_No description provided._"
    } else {
        detail.body.as_str()
    };
    let can_edit = can_edit_change_request(detail);
    let group = SharedString::from("pr-description-group");
    let mut row = h_flex()
        .id("pr-description-section")
        .group(group.clone())
        .w_full()
        .min_w_0()
        .items_start()
        .gap(px(4.0))
        .px(px(INSET_X_PX))
        .py(px(16.0))
        .child(div().flex_1().min_w_0().child(render_markdown(
            "pr-desc",
            text,
            tokens,
            &MarkdownOptions::default(),
        )));
    if can_edit {
        let on_edit = cb.on_start_edit_body.clone();
        row = row.child(
            div().invisible().group_hover(group, |s| s.visible()).child(
                div()
                    .id("pr-edit-body-btn")
                    .flex()
                    .flex_shrink_0()
                    .size(px(24.0))
                    .items_center()
                    .justify_center()
                    .rounded(px(PILL_RADIUS_PX))
                    .cursor_pointer()
                    .hover(move |s| s.bg(hover))
                    .on_click(move |_, window, cx| on_edit(window, cx))
                    .conn_fast_tooltip("Edit description", tokens)
                    .child(superhero_icon("superhero/edit.svg", 13.0, muted)),
            ),
        );
    }
    let reaction_bar = render_reaction_bar(
        tokens,
        "__pr__",
        None,
        pr_reactions,
        reaction_state.pending.get("__pr__"),
        reaction_state.can_react,
        reaction_state.open_picker == Some("__pr__"),
        cb.on_toggle_reaction_picker.clone(),
        cb.on_toggle_reaction.clone(),
    );
    v_flex()
        .w_full()
        .min_w_0()
        .child(row)
        .when_some(reaction_bar, |el, bar| {
            el.child(div().px(px(INSET_X_PX)).pb(px(16.0)).child(bar))
        })
        .into_any_element()
}

/// Renders the Checks tab (`PullRequestChecksTab`: `p-1.75`, `px-2.75 py-2`, `text-xs leading-5`).
pub(super) fn render_checks_tab(
    tokens: &Tokens,
    detail: &PullRequestDetail,
    cb: &TabCallbacks,
) -> AnyElement {
    let fg = to_hsla(tokens.foreground);
    let muted = to_hsla(tokens.muted_foreground);
    let row_hover = to_hsla(tokens.accent.with_alpha(0.60));

    let mut container = v_flex().w_full().min_w_0().p(px(7.0));
    if detail.checks.is_empty() {
        return container
            .child(
                div()
                    .px(px(11.0))
                    .py(px(8.0))
                    .text_size(px(XS_TEXT_PX))
                    .line_height(px(20.0))
                    .text_color(muted)
                    .child("No checks reported."),
            )
            .into_any_element();
    }

    for (idx, check) in detail.checks.iter().enumerate() {
        let status_color = to_hsla(check_status_color(tokens, check.status));
        let icon = check_status_icon(check.status);
        let status_label = check_status_label(check);
        let is_failing = matches!(
            check.status,
            PullRequestCheckStatus::Failure | PullRequestCheckStatus::Cancelled
        );
        let mut row = h_flex()
            .id(SharedString::from(format!("pr-check-row-{idx}")))
            .w_full()
            .min_w_0()
            .items_center()
            .gap(px(8.0))
            .px(px(11.0))
            .py(px(8.0))
            .rounded(px(8.0))
            .text_size(px(XS_TEXT_PX))
            .line_height(px(20.0))
            .hover(move |s| s.bg(row_hover))
            .child(superhero_icon(icon, 14.0, status_color))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .text_color(fg)
                    .child(check.name.clone()),
            )
            .child(div().flex_shrink_0().text_color(muted).child(status_label));
        if is_failing {
            let prompt = build_fix_check_prompt(detail, check);
            let on_send = cb.on_send_prompt.clone();
            let hover = to_hsla(tokens.shell_highlight);
            row = row.child(
                h_flex()
                    .id(SharedString::from(format!("pr-check-fix-{idx}")))
                    .flex_shrink_0()
                    .h(px(22.0))
                    .px(px(7.0))
                    .gap(px(4.0))
                    .items_center()
                    .rounded(px(6.0))
                    .cursor_pointer()
                    .text_size(px(XS_TEXT_PX))
                    .text_color(fg)
                    .hover(move |s| s.bg(hover))
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .on_click(move |_, window, cx| on_send(prompt.clone(), window, cx))
                    .conn_fast_tooltip("Fix failing check in this thread", tokens)
                    .child(superhero_icon("superhero/tool.svg", 12.0, muted))
                    .child("Fix"),
            );
        }
        if let Some(url) = check.url.clone() {
            let on_open = cb.on_open_url.clone();
            row = row
                .cursor_pointer()
                .on_click(move |_, window, cx| on_open(url.clone(), window, cx));
        }
        container = container.child(row);
    }

    container.into_any_element()
}

/// Renders the Timeline tab (`PullRequestTimelineTab`).
#[expect(
    clippy::too_many_arguments,
    reason = "view props passed explicitly from PullRequestPanel::render"
)]
pub(super) fn render_timeline_tab(
    tokens: &Tokens,
    detail: &PullRequestDetail,
    comments: &[PullRequestComment],
    review_threads: &[PullRequestReviewThread],
    commits: &[PullRequestCommit],
    activity_loading: bool,
    activity_error: Option<&str>,
    order: TimelineOrder,
    filter: CommentFilter,
    expanded_groups: &HashSet<String>,
    expanded_threads: &HashMap<String, bool>,
    replying_thread: Option<&str>,
    reply_input: &Entity<TextareaState>,
    reply_submitting: bool,
    reaction_state: &ReactionState<'_>,
    now_ms: i64,
    cb: &TabCallbacks,
) -> AnyElement {
    let muted = to_hsla(tokens.muted_foreground);
    let divider = to_hsla(tokens.shell_divider);

    if activity_loading {
        return render_timeline_ghost(tokens);
    }

    if let Some(err) = activity_error {
        return v_flex()
            .w_full()
            .py(px(40.0))
            .px(px(16.0))
            .items_center()
            .justify_center()
            .gap(px(8.0))
            .child(
                div()
                    .text_size(px(14.0))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(to_hsla(tokens.foreground))
                    .child("Could not load pull request activity"),
            )
            .child(
                div()
                    .max_w(px(420.0))
                    .text_size(px(XS_TEXT_PX))
                    .text_color(muted)
                    .text_center()
                    .child(err.to_owned()),
            )
            .into_any_element();
    }

    let all_events = build_timeline(detail, comments, review_threads, commits);
    let mut filtered = filter_timeline_events(&all_events, filter);
    if order == TimelineOrder::Oldest {
        filtered.reverse();
    }

    if filtered.is_empty() {
        return v_flex()
            .w_full()
            .py(px(64.0))
            .px(px(INSET_X_PX))
            .items_center()
            .justify_center()
            .gap(px(8.0))
            .child(superhero_icon("superhero/pull-request.svg", 20.0, muted))
            .child(
                div()
                    .text_size(px(UI_TEXT_PX))
                    .text_color(muted)
                    .child("No activity yet."),
            )
            .into_any_element();
    }

    let newest_commit = newest_commit_at(commits);
    let rows = group_timeline_rows(filtered);
    let mut rail_content = v_flex().relative().w_full().min_w_0();

    // Vertical timeline connector line (`left-3`, 12px from content left).
    rail_content = rail_content.child(
        div()
            .absolute()
            .top(px(20.0))
            .bottom(px(28.0))
            .left(px(12.0))
            .w(px(1.0))
            .bg(divider),
    );

    let raw_threads_by_id: HashMap<&str, &PullRequestReviewThread> =
        review_threads.iter().map(|t| (t.id.as_str(), t)).collect();

    for (idx, row) in rows.into_iter().enumerate() {
        let el = match row {
            TimelineRow::Comments(group_events) => {
                let group_key = format!(
                    "grp-{}",
                    group_events.first().map_or("empty", |e| e.id.as_str())
                );
                let is_open = expanded_groups.contains(&group_key);
                render_conversation_group(
                    tokens,
                    &group_key,
                    &group_events,
                    is_open,
                    reaction_state,
                    now_ms,
                    cb,
                )
            }
            TimelineRow::Event(event) => {
                if let Some(thread) = &event.thread {
                    let dismissed = review_outcome(event.review_state.as_deref())
                        == Some(ReviewOutcome::Dismissed);
                    let default_expanded = !thread.is_resolved && !dismissed;
                    let is_expanded = expanded_threads
                        .get(&thread.id)
                        .copied()
                        .unwrap_or(default_expanded);
                    let raw_thread = raw_threads_by_id.get(thread.id.as_str()).copied();
                    render_review_thread_event(
                        tokens,
                        detail,
                        &event,
                        thread,
                        raw_thread,
                        is_expanded,
                        replying_thread == Some(thread.id.as_str()),
                        reply_input,
                        reply_submitting,
                        reaction_state,
                        now_ms,
                        cb,
                    )
                } else if event.kind == TimelineEventKind::Commit {
                    render_commit_event(tokens, &event, now_ms, cb)
                } else if let Some(outcome) = review_outcome(event.review_state.as_deref()) {
                    let stale = is_verdict_stale(&event.at, newest_commit);
                    render_review_verdict_event(
                        tokens,
                        idx,
                        &event,
                        outcome,
                        stale,
                        reaction_state,
                        now_ms,
                        cb,
                    )
                } else {
                    render_lifecycle_event(tokens, &event, now_ms)
                }
            }
        };
        rail_content = rail_content.child(el);
    }

    div()
        .w_full()
        .min_w_0()
        .px(px(INSET_X_PX))
        .pt(px(8.0))
        .pb(px(56.0))
        .child(rail_content)
        .into_any_element()
}

fn render_timeline_ghost(tokens: &Tokens) -> AnyElement {
    let divider = to_hsla(tokens.shell_divider);
    let widths = [210.0_f32, 150.0, 180.0, 230.0, 140.0, 195.0];
    let mut rail = v_flex()
        .w_full()
        .ml(px(8.0))
        .pl(px(20.0))
        .border_l_1()
        .border_color(divider);
    for w in widths {
        rail = rail.child(
            v_flex()
                .pb(px(20.0))
                .gap(px(6.0))
                .child(
                    div()
                        .w(px(w))
                        .h(px(14.0))
                        .rounded(px(4.0))
                        .bg(chrome::alpha(tokens.muted_foreground, 0.15)),
                )
                .child(
                    div()
                        .w(px(64.0))
                        .h(px(12.0))
                        .rounded(px(4.0))
                        .bg(chrome::alpha(tokens.muted_foreground, 0.15)),
                ),
        );
    }
    div()
        .w_full()
        .px(px(16.0))
        .py(px(20.0))
        .child(rail)
        .into_any_element()
}

fn timeline_marker(tokens: &Tokens, child: AnyElement) -> AnyElement {
    div()
        .absolute()
        .left_0()
        .top(px(10.0))
        .flex()
        .size(px(24.0))
        .items_center()
        .justify_center()
        .rounded(px(PILL_RADIUS_PX))
        .bg(to_hsla(tokens.shell_card))
        .child(child)
        .into_any_element()
}

fn render_lifecycle_event(tokens: &Tokens, event: &TimelineEvent, now_ms: i64) -> AnyElement {
    let state = match event.kind {
        TimelineEventKind::Merged => PullRequestState::Merged,
        TimelineEventKind::Closed => PullRequestState::Closed,
        _ => PullRequestState::Open,
    };
    let pres = resolve_state_presentation(state, false);
    let tone = state_tone_color(tokens, pres.tone);
    let tone_hsla = to_hsla(tone);
    let fg = to_hsla(tokens.foreground);
    let muted = to_hsla(tokens.muted_foreground);

    let badge = div()
        .flex()
        .size(px(24.0))
        .items_center()
        .justify_center()
        .rounded(px(PILL_RADIUS_PX))
        .bg(to_hsla(tone.with_alpha(0.15)))
        .border_1()
        .border_color(to_hsla(tone.with_alpha(0.28)))
        .child(superhero_icon(pres.icon, 14.0, tone_hsla))
        .into_any_element();

    let rel = format_relative_time(&event.at, now_ms);
    div()
        .relative()
        .w_full()
        .py(px(12.0))
        .pl(px(36.0))
        .child(timeline_marker(tokens, badge))
        .child(
            v_flex()
                .gap(px(2.0))
                .text_size(px(14.0))
                .line_height(px(20.0))
                .child(
                    h_flex()
                        .flex_wrap()
                        .items_center()
                        .gap(px(6.0))
                        .when_some(event.actor.as_ref(), |el, actor| {
                            el.child(
                                div()
                                    .font_weight(FontWeight::MEDIUM)
                                    .text_color(fg)
                                    .child(actor.login.clone()),
                            )
                        })
                        .child(div().text_color(muted).child(event.title.clone())),
                )
                .child(div().text_color(muted).child(rel)),
        )
        .into_any_element()
}

fn render_commit_event(
    tokens: &Tokens,
    event: &TimelineEvent,
    now_ms: i64,
    cb: &TabCallbacks,
) -> AnyElement {
    let fg = to_hsla(tokens.foreground);
    let muted = to_hsla(tokens.muted_foreground);
    let short_sha = event.id.get(..7).unwrap_or(&event.id).to_owned();
    let rel = format_relative_time(&event.at, now_ms);
    let headline = event
        .body
        .clone()
        .unwrap_or_else(|| "Untitled commit".to_owned());

    let marker_child: AnyElement = if event.actor.is_some() {
        render_actor_avatar(tokens, event.actor.as_ref(), 24.0)
    } else {
        superhero_icon("superhero/commit.svg", 14.0, muted).into_any_element()
    };

    let on_select_code = cb.on_select_tab.clone();
    div()
        .id(SharedString::from(format!("pr-commit-{}", event.id)))
        .relative()
        .w_full()
        .py(px(12.0))
        .pl(px(36.0))
        .cursor_pointer()
        .on_click(move |_, window, cx| on_select_code(DetailTab::Code, window, cx))
        .child(timeline_marker(tokens, marker_child))
        .child(
            h_flex()
                .w_full()
                .min_w_0()
                .items_start()
                .gap(px(12.0))
                .child(
                    v_flex()
                        .flex_1()
                        .min_w_0()
                        .gap(px(2.0))
                        .child(
                            div()
                                .min_w_0()
                                .truncate()
                                .text_size(px(14.0))
                                .line_height(px(20.0))
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(chrome::alpha(tokens.foreground, 0.90))
                                .hover(move |s| s.text_color(fg))
                                .child(headline),
                        )
                        .child(
                            h_flex()
                                .items_center()
                                .gap(px(6.0))
                                .text_size(px(14.0))
                                .line_height(px(20.0))
                                .text_color(muted)
                                .child(short_sha)
                                .child("·")
                                .child(rel),
                        ),
                )
                .when_some(event.additions.zip(event.deletions), |el, (add, del)| {
                    el.child(render_diff_stat(tokens, add, del, 14.0))
                }),
        )
        .into_any_element()
}

#[expect(
    clippy::too_many_arguments,
    reason = "view props passed explicitly from render_timeline_tab"
)]
fn render_review_verdict_event(
    tokens: &Tokens,
    idx: usize,
    event: &TimelineEvent,
    outcome: ReviewOutcome,
    stale: bool,
    reaction_state: &ReactionState<'_>,
    now_ms: i64,
    cb: &TabCallbacks,
) -> AnyElement {
    let fg = to_hsla(tokens.foreground);
    let muted = to_hsla(tokens.muted_foreground);
    let outcome_color = to_hsla(if stale {
        tokens.muted_foreground.with_alpha(0.70)
    } else {
        review_outcome_color(tokens, outcome)
    });
    let rel = format_relative_time(&event.at, now_ms);
    let login = event
        .actor
        .as_ref()
        .map_or("ghost", |a| a.login.as_str())
        .to_owned();

    let base_outcome = review_outcome_color(tokens, outcome);
    let ring_color = if stale {
        to_hsla(color_mix_srgb(base_outcome, 0.35, tokens.shell_card))
    } else {
        to_hsla(base_outcome)
    };
    let marker_child =
        chrome::actor_avatar(tokens, event.actor.as_ref(), 24.0, Some(ring_color), false);
    let mut header = h_flex()
        .w_full()
        .min_w_0()
        .items_start()
        .justify_between()
        .gap(px(8.0))
        .child(
            v_flex()
                .flex_1()
                .min_w_0()
                .gap(px(2.0))
                .child(
                    h_flex()
                        .flex_wrap()
                        .items_center()
                        .gap(px(6.0))
                        .text_size(px(14.0))
                        .line_height(px(20.0))
                        .child(
                            div()
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(fg)
                                .child(login),
                        )
                        .child({
                            let stale_tip = stale.then_some(match outcome {
                                ReviewOutcome::Approved => "Approved before new commits",
                                ReviewOutcome::ChangesRequested => {
                                    "Changes requested before new commits"
                                }
                                ReviewOutcome::Dismissed => "Review dismissed",
                            });
                            div()
                                .id(SharedString::from(format!("pr-verdict-outcome-{idx}")))
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(outcome_color)
                                .when_some(stale_tip, |el, tip| el.conn_fast_tooltip(tip, tokens))
                                .child(review_outcome_label(outcome).to_ascii_lowercase())
                        }),
                )
                .child(div().text_size(px(14.0)).text_color(muted).child(rel)),
        );
    if let Some(url) = event.url.clone() {
        let on_open = cb.on_open_url.clone();
        header = header.child(open_external_icon_btn(
            format!("pr-verdict-open-{idx}"),
            tokens,
            move |window, cx| on_open(url.clone(), window, cx),
        ));
    }

    let mut content = v_flex().w_full().min_w_0().child(header);
    if let Some(body) = &event.body {
        content = content.child(div().mt(px(12.0)).child(render_markdown(
            &format!("verdict-{idx}"),
            body,
            tokens,
            &MarkdownOptions::default(),
        )));
    }
    if let Some(bar) = render_reaction_bar(
        tokens,
        &event.id,
        Some(event.id.clone()),
        &event.reactions,
        reaction_state.pending.get(&event.id),
        reaction_state.can_react,
        reaction_state.open_picker == Some(event.id.as_str()),
        cb.on_toggle_reaction_picker.clone(),
        cb.on_toggle_reaction.clone(),
    ) {
        content = content.child(div().mt(px(8.0)).child(bar));
    }

    div()
        .relative()
        .w_full()
        .py(px(12.0))
        .pl(px(36.0))
        .child(timeline_marker(tokens, marker_child))
        .child(content)
        .into_any_element()
}

fn render_conversation_group(
    tokens: &Tokens,
    group_key: &str,
    events: &[TimelineEvent],
    is_open: bool,
    reaction_state: &ReactionState<'_>,
    now_ms: i64,
    cb: &TabCallbacks,
) -> AnyElement {
    let fg = to_hsla(tokens.foreground);
    let muted = to_hsla(tokens.muted_foreground);
    let first = events.first();
    let rel = first.map_or_else(String::new, |e| format_relative_time(&e.at, now_ms));

    let mut unique_authors: HashSet<&str> = HashSet::new();
    for ev in events {
        if let Some(a) = &ev.actor {
            unique_authors.insert(a.login.as_str());
        }
    }
    let author_count = unique_authors.len().max(1);
    let comments_label = if events.len() == 1 {
        "1 comment".to_owned()
    } else {
        format!("{} comments", events.len())
    };
    let authors_label = if author_count == 1 {
        "1 author".to_owned()
    } else {
        format!("{author_count} authors")
    };

    let marker_child: AnyElement = if let Some(actor) = first.and_then(|e| e.actor.as_ref()) {
        let avatar = chrome::actor_avatar(tokens, Some(actor), 24.0, None, !is_open);
        if is_open {
            avatar
        } else {
            div().opacity(0.45).child(avatar).into_any_element()
        }
    } else {
        superhero_icon("superhero/thread.svg", 14.0, muted).into_any_element()
    };

    let key_owned = group_key.to_owned();
    let on_toggle = cb.on_toggle_group.clone();
    let trigger = h_flex()
        .id(SharedString::from(format!("pr-group-trigger-{group_key}")))
        .w_full()
        .min_w_0()
        .items_center()
        .gap(px(12.0))
        .cursor_pointer()
        .on_click(move |_, window, cx| on_toggle(key_owned.clone(), window, cx))
        .child(
            v_flex()
                .flex_1()
                .min_w_0()
                .gap(px(2.0))
                .child(
                    div()
                        .text_size(px(14.0))
                        .line_height(px(20.0))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(chrome::alpha(tokens.foreground, 0.90))
                        .hover(move |s| s.text_color(fg))
                        .child(comments_label),
                )
                .child(
                    div()
                        .text_size(px(14.0))
                        .line_height(px(20.0))
                        .text_color(muted)
                        .child(format!("{authors_label} · {rel}")),
                ),
        )
        .child(superhero_icon(
            if is_open {
                "superhero/chevron-down.svg"
            } else {
                "superhero/chevron-right.svg"
            },
            16.0,
            muted,
        ));

    let mut content = v_flex().w_full().min_w_0().child(trigger);
    if is_open {
        let mut cards = v_flex().mt(px(12.0)).gap(px(8.0));
        for (i, ev) in events.iter().enumerate() {
            cards = cards.child(render_conversation_card(
                tokens,
                &format!("{group_key}-{i}"),
                ev,
                true,
                None,
                reaction_state,
                now_ms,
                cb,
            ));
        }
        content = content.child(cards);
    }

    div()
        .relative()
        .w_full()
        .py(px(12.0))
        .pl(px(36.0))
        .child(timeline_marker(tokens, marker_child))
        .child(content)
        .into_any_element()
}

#[expect(
    clippy::too_many_arguments,
    reason = "view props passed explicitly from PullRequestPanel::render"
)]
fn render_review_thread_event(
    tokens: &Tokens,
    detail: &PullRequestDetail,
    event: &TimelineEvent,
    thread: &TimelineThread,
    raw_thread: Option<&PullRequestReviewThread>,
    is_expanded: bool,
    is_replying: bool,
    reply_input: &Entity<TextareaState>,
    reply_submitting: bool,
    reaction_state: &ReactionState<'_>,
    now_ms: i64,
    cb: &TabCallbacks,
) -> AnyElement {
    let fg = to_hsla(tokens.foreground);
    let muted = to_hsla(tokens.muted_foreground);
    let success = to_hsla(tokens.success_foreground);
    let divider = to_hsla(tokens.shell_divider);

    let title_text = match (&thread.path, thread.line) {
        (Some(p), Some(line)) => format!("{p}:{line}"),
        (Some(p), None) => p.clone(),
        (None, _) => "Overview".to_owned(),
    };
    let reply_count = thread.replies.len() + thread.more_replies;
    let login = event
        .actor
        .as_ref()
        .map_or("ghost", |a| a.login.as_str())
        .to_owned();

    let marker_child: AnyElement = {
        let avatar = chrome::actor_avatar(tokens, event.actor.as_ref(), 24.0, None, !is_expanded);
        if is_expanded {
            avatar
        } else {
            div().opacity(0.45).child(avatar).into_any_element()
        }
    };

    let tid_toggle = thread.id.clone();
    let on_toggle = cb.on_toggle_thread.clone();
    let mut meta = h_flex()
        .mt(px(4.0))
        .flex_wrap()
        .items_center()
        .gap(px(6.0))
        .text_size(px(14.0))
        .line_height(px(20.0))
        .text_color(muted);
    if thread.is_resolved {
        meta = meta
            .child(
                h_flex()
                    .items_center()
                    .gap(px(4.0))
                    .text_color(success)
                    .child(superhero_icon("superhero/check-circle.svg", 14.0, success))
                    .child("Resolved"),
            )
            .child("·");
    }
    if thread.is_outdated {
        meta = meta.child("Outdated").child("·");
    }
    meta = meta.child(login);
    if reply_count > 0 {
        let label = if reply_count == 1 {
            "1 reply".to_owned()
        } else {
            format!("{reply_count} replies")
        };
        meta = meta.child("·").child(label);
    }

    let trigger = h_flex()
        .id(SharedString::from(format!(
            "pr-thread-toggle-{}",
            thread.id
        )))
        .w_full()
        .min_w_0()
        .items_start()
        .gap(px(12.0))
        .cursor_pointer()
        .on_click(move |_, window, cx| on_toggle(tid_toggle.clone(), window, cx))
        .child(
            v_flex()
                .flex_1()
                .min_w_0()
                .child(
                    h_flex()
                        .min_w_0()
                        .items_center()
                        .gap(px(6.0))
                        .text_size(px(14.0))
                        .line_height(px(20.0))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(if is_expanded {
                            chrome::alpha(tokens.foreground, 0.90)
                        } else {
                            muted
                        })
                        .hover(move |s| s.text_color(fg))
                        .when(thread.path.is_some(), |el| {
                            el.child(superhero_icon("superhero/file-code.svg", 14.0, muted))
                        })
                        .child(div().min_w_0().truncate().child(title_text)),
                )
                .child(meta),
        )
        .child(superhero_icon(
            if is_expanded {
                "superhero/chevron-down.svg"
            } else {
                "superhero/chevron-right.svg"
            },
            16.0,
            muted,
        ));

    let mut content = v_flex().w_full().min_w_0().child(trigger);

    if is_expanded {
        let can_resolve = detail.capabilities.review.resolve
            && detail.viewer_permissions.resolve
            && thread.can_resolve;
        let fix_btn = if !thread.is_resolved
            && let Some(raw) = raw_thread
        {
            let prompt = build_fix_thread_prompt(detail, raw);
            let on_send = cb.on_send_prompt.clone();
            let hover = to_hsla(tokens.shell_highlight);
            Some(
                h_flex()
                    .id(SharedString::from(format!("pr-thread-fix-{}", thread.id)))
                    .flex_shrink_0()
                    .h(px(24.0))
                    .px(px(7.0))
                    .gap(px(4.0))
                    .items_center()
                    .rounded(px(6.0))
                    .cursor_pointer()
                    .text_size(px(XS_TEXT_PX))
                    .line_height(px(XS_LINE_HEIGHT_PX))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(fg)
                    .hover(move |s| s.bg(hover))
                    .on_click(move |_, window, cx| on_send(prompt.clone(), window, cx))
                    .conn_fast_tooltip("Fix findings in this thread", tokens)
                    .child(superhero_icon("superhero/tool.svg", 12.0, muted))
                    .child("Fix")
                    .into_any_element(),
            )
        } else {
            None
        };
        let resolve_btn = if can_resolve {
            let tid = thread.id.clone();
            let next_resolved = !thread.is_resolved;
            let on_resolve = cb.on_resolve_thread.clone();
            Some(small_ghost_button(
                format!("pr-thread-resolve-{}", thread.id),
                if thread.is_resolved {
                    "Unresolve"
                } else {
                    "Resolve"
                },
                tokens,
                false,
                move |window, cx| on_resolve(tid.clone(), next_resolved, window, cx),
            ))
        } else {
            None
        };
        let extra_actions: Option<AnyElement> = match (fix_btn, resolve_btn) {
            (Some(a), Some(b)) => Some(
                h_flex()
                    .items_center()
                    .gap(px(4.0))
                    .child(a)
                    .child(b)
                    .into_any_element(),
            ),
            (Some(a), None) => Some(a),
            (None, Some(b)) => Some(b),
            (None, None) => None,
        };

        let mut expanded_box = v_flex()
            .mt(px(12.0))
            .gap(px(8.0))
            .child(render_conversation_card(
                tokens,
                &format!("th-root-{}", thread.id),
                event,
                false,
                extra_actions,
                reaction_state,
                now_ms,
                cb,
            ));

        if !thread.replies.is_empty() {
            let mut replies_col = v_flex()
                .pl(px(20.0))
                .border_l_1()
                .border_color(divider)
                .gap(px(8.0));
            for (r_idx, reply) in thread.replies.iter().enumerate() {
                replies_col = replies_col.child(render_conversation_card(
                    tokens,
                    &format!("th-reply-{}-{r_idx}", thread.id),
                    reply,
                    false,
                    None,
                    reaction_state,
                    now_ms,
                    cb,
                ));
            }
            expanded_box = expanded_box.child(replies_col);
        }

        let can_reply = detail.capabilities.review.reply && detail.viewer_permissions.comment;
        if can_reply {
            if is_replying {
                let tid_send = thread.id.clone();
                let on_submit = cb.on_submit_reply.clone();
                let on_cancel = cb.on_start_reply.clone();
                expanded_box = expanded_box.child(
                    v_flex()
                        .ml(px(20.0))
                        .p(px(10.0))
                        .gap(px(8.0))
                        .rounded(px(8.0))
                        .border_1()
                        .border_color(divider)
                        .bg(to_hsla(tokens.shell_field))
                        .child(
                            Textarea::new(reply_input)
                                .appearance(false)
                                .text_size(px(UI_TEXT_PX)),
                        )
                        .child(
                            h_flex()
                                .justify_end()
                                .gap(px(8.0))
                                .child(small_ghost_button(
                                    format!("pr-reply-cancel-{}", thread.id),
                                    "Cancel",
                                    tokens,
                                    reply_submitting,
                                    move |window, cx| on_cancel(None, window, cx),
                                ))
                                .child(small_outline_button(
                                    format!("pr-reply-send-{}", thread.id),
                                    Some("superhero/send.svg"),
                                    if reply_submitting {
                                        "Replying..."
                                    } else {
                                        "Reply"
                                    },
                                    tokens,
                                    reply_submitting,
                                    move |window, cx| on_submit(tid_send.clone(), window, cx),
                                )),
                        ),
                );
            } else {
                let tid_open = thread.id.clone();
                let on_start = cb.on_start_reply.clone();
                expanded_box = expanded_box.child(div().ml(px(20.0)).child(small_ghost_button(
                    format!("pr-reply-open-{}", thread.id),
                    "Reply",
                    tokens,
                    false,
                    move |window, cx| on_start(Some(tid_open.clone()), window, cx),
                )));
            }
        }

        content = content.child(expanded_box);
    }

    div()
        .relative()
        .w_full()
        .py(px(12.0))
        .pl(px(36.0))
        .child(timeline_marker(tokens, marker_child))
        .child(content)
        .into_any_element()
}

#[expect(
    clippy::too_many_arguments,
    reason = "view props passed explicitly from timeline renderers"
)]
fn render_conversation_card(
    tokens: &Tokens,
    card_id: &str,
    event: &TimelineEvent,
    show_path: bool,
    extra_action: Option<AnyElement>,
    reaction_state: &ReactionState<'_>,
    now_ms: i64,
    cb: &TabCallbacks,
) -> AnyElement {
    let fg = to_hsla(tokens.foreground);
    let muted = to_hsla(tokens.muted_foreground);
    let divider = to_hsla(tokens.shell_divider);
    let header_bg = match tokens.appearance {
        Appearance::Dark => chrome::alpha(tokens.foreground, 0.04),
        Appearance::Light => to_hsla(tokens.muted.with_alpha(0.25)),
    };
    let login = event
        .actor
        .as_ref()
        .map_or("ghost", |a| a.login.as_str())
        .to_owned();
    let rel = format_relative_time(&event.at, now_ms);

    let mut header_row = h_flex()
        .w_full()
        .min_h(px(28.0))
        .items_center()
        .gap(px(6.0))
        .child(
            v_flex()
                .flex_1()
                .min_w_0()
                .child(
                    h_flex()
                        .flex_wrap()
                        .items_center()
                        .gap(px(6.0))
                        .text_size(px(14.0))
                        .line_height(px(20.0))
                        .child(
                            div()
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(fg)
                                .child(login),
                        )
                        .child(div().text_color(muted).child(event.title.clone()))
                        .child(div().text_color(muted).child(format!("· {rel}"))),
                )
                .when(show_path && event.path.is_some(), |el| {
                    let path = event.path.clone().unwrap_or_default();
                    el.child(
                        h_flex()
                            .mt(px(2.0))
                            .items_center()
                            .gap(px(4.0))
                            .text_size(px(XS_TEXT_PX))
                            .text_color(muted)
                            .child(superhero_icon("superhero/file-code.svg", 12.0, muted))
                            .child(div().min_w_0().truncate().child(path)),
                    )
                }),
        )
        .when_some(extra_action, |el, btn| el.child(btn));

    if let Some(url) = event.url.clone() {
        let on_open = cb.on_open_url.clone();
        header_row = header_row.child(open_external_icon_btn(
            format!("pr-card-open-{card_id}"),
            tokens,
            move |window, cx| on_open(url.clone(), window, cx),
        ));
    }

    let mut card = v_flex()
        .w_full()
        .min_w_0()
        .rounded(px(8.0))
        .border_1()
        .border_color(divider)
        .overflow_hidden()
        .child(
            div()
                .w_full()
                .pl(px(12.0))
                .pr(px(6.0))
                .py(px(6.0))
                .bg(header_bg)
                .when(event.body.is_some(), |el| {
                    el.border_b_1().border_color(divider)
                })
                .child(header_row),
        );

    if let Some(body) = &event.body {
        let body_el = if event.markdown {
            render_markdown(
                &format!("card-{card_id}"),
                body,
                tokens,
                &MarkdownOptions::default(),
            )
        } else {
            div()
                .text_size(px(14.0))
                .line_height(px(22.75))
                .text_color(muted)
                .child(body.clone())
                .into_any_element()
        };
        card = card.child(div().w_full().p(px(12.0)).child(body_el));
    }

    if let Some(bar) = render_reaction_bar(
        tokens,
        &event.id,
        Some(event.id.clone()),
        &event.reactions,
        reaction_state.pending.get(&event.id),
        reaction_state.can_react,
        reaction_state.open_picker == Some(event.id.as_str()),
        cb.on_toggle_reaction_picker.clone(),
        cb.on_toggle_reaction.clone(),
    ) {
        card = card.child(div().w_full().px(px(12.0)).pb(px(10.0)).child(bar));
    }

    card.into_any_element()
}

fn open_external_icon_btn(
    id: impl Into<SharedString>,
    tokens: &Tokens,
    on_click: impl Fn(&mut Window, &mut App) + 'static,
) -> AnyElement {
    let muted = to_hsla(tokens.muted_foreground);
    let hover = to_hsla(tokens.shell_highlight);
    div()
        .id(id.into())
        .flex()
        .flex_shrink_0()
        .size(px(24.0))
        .items_center()
        .justify_center()
        .rounded(px(PILL_RADIUS_PX))
        .cursor_pointer()
        .hover(move |s| s.bg(hover))
        .on_click(move |_, window, cx| on_click(window, cx))
        .conn_fast_tooltip("Open on host", tokens)
        .child(superhero_icon("superhero/external-link.svg", 13.0, muted))
        .into_any_element()
}

/// Renders the Code tab: changed files list + per-file unified diff + files-viewed toggles.
#[expect(
    clippy::too_many_arguments,
    reason = "view props passed explicitly from PullRequestPanel::render"
)]
pub(super) fn render_code_tab(
    tokens: &Tokens,
    detail: &PullRequestDetail,
    files: &[CodeFileEntry],
    files_loading: bool,
    files_error: Option<&str>,
    selected_path: Option<&str>,
    diffs_by_path: &HashMap<String, FileDiffState>,
    viewed_states: &HashMap<String, PullRequestFileViewedState>,
    viewed_enabled: bool,
    tree_open: bool,
    word_wrap: bool,
    cb: &TabCallbacks,
) -> AnyElement {
    let fg = to_hsla(tokens.foreground);
    let muted = to_hsla(tokens.muted_foreground);
    let divider = to_hsla(tokens.shell_divider);
    let added = to_hsla(tokens.diff_added);
    let removed = to_hsla(tokens.diff_removed);

    if files_loading && files.is_empty() {
        return h_flex()
            .w_full()
            .py(px(48.0))
            .items_center()
            .justify_center()
            .gap(px(8.0))
            .text_size(px(UI_TEXT_PX))
            .text_color(muted)
            .child(superhero_icon("superhero/spinner.svg", 16.0, muted))
            .child("Loading pull request diff...")
            .into_any_element();
    }

    if let Some(err) = files_error
        && files.is_empty()
    {
        let on_reload = cb.on_reload_code.clone();
        return v_flex()
            .w_full()
            .py(px(40.0))
            .px(px(24.0))
            .items_center()
            .gap(px(10.0))
            .child(superhero_icon(
                "superhero/warning.svg",
                20.0,
                to_hsla(tokens.warning),
            ))
            .child(
                div()
                    .text_size(px(14.0))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(fg)
                    .child("Could not load changed files"),
            )
            .child(
                div()
                    .max_w(px(400.0))
                    .text_size(px(XS_TEXT_PX))
                    .text_color(muted)
                    .text_center()
                    .child(err.to_owned()),
            )
            .child(small_outline_button(
                "pr-code-retry",
                Some("superhero/refresh.svg"),
                "Try again",
                tokens,
                false,
                move |window, cx| on_reload(window, cx),
            ))
            .into_any_element();
    }

    if files.is_empty() {
        let on_open = cb.on_open_url.clone();
        let url = detail.url.clone();
        return v_flex()
            .w_full()
            .py(px(48.0))
            .px(px(24.0))
            .items_center()
            .gap(px(8.0))
            .child(superhero_icon("superhero/file-diff.svg", 20.0, muted))
            .child(
                div()
                    .text_size(px(UI_TEXT_PX))
                    .text_color(muted)
                    .text_center()
                    .child(if detail.changed_files > 0 {
                        format!(
                            "{} changed files reported by host (diff index requires HTTP /api/pull-requests/diff).",
                            format_grouped_count(detail.changed_files)
                        )
                    } else {
                        "No changed files.".to_owned()
                    }),
            )
            .when(detail.changed_files > 0, |el| {
                el.child(small_outline_button(
                    "pr-code-open-host",
                    Some("superhero/external-link.svg"),
                    "Open diff on host",
                    tokens,
                    false,
                    move |window, cx| on_open(url.clone(), window, cx),
                ))
            })
            .into_any_element();
    }

    let selected = selected_path
        .and_then(|p| files.iter().find(|f| f.path == p))
        .or_else(|| files.first());

    let mut split = h_flex().w_full().min_w_0().items_start();

    if tree_open {
        let row_hover = chrome::alpha(tokens.foreground, 0.04);
        let row_selected = to_hsla(tokens.shell_highlight);
        let mut list = v_flex()
            .w(px(224.0))
            .flex_shrink_0()
            .p(px(6.0))
            .gap(px(2.0));
        for (idx, file) in files.iter().enumerate() {
            let is_sel = selected.is_some_and(|s| s.path == file.path);
            let is_viewed =
                viewed_states.get(&file.path) == Some(&PullRequestFileViewedState::Viewed);
            let path = file.path.clone();
            let on_select = cb.on_select_code_file.clone();
            let row = h_flex()
                .id(SharedString::from(format!("pr-code-file-{idx}")))
                .w_full()
                .h(px(28.0))
                .px(px(8.0))
                .gap(px(6.0))
                .items_center()
                .rounded(px(5.0))
                .cursor_pointer()
                .when(is_sel, |el| el.bg(row_selected))
                .when(!is_sel, |el| el.hover(move |s| s.bg(row_hover)))
                .on_click(move |_, window, cx| on_select(path.clone(), window, cx))
                .child(superhero_icon(
                    if is_viewed {
                        "superhero/check-circle.svg"
                    } else {
                        "superhero/file-diff.svg"
                    },
                    13.0,
                    if is_viewed {
                        to_hsla(tokens.success)
                    } else {
                        muted
                    },
                ))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .text_size(px(UI_TEXT_PX))
                        .line_height(px(UI_LINE_HEIGHT_PX))
                        .text_color(if is_sel { fg } else { muted })
                        .when(is_viewed && !is_sel, |el| el.opacity(0.70))
                        .child(file.path.clone()),
                )
                .when(
                    file.additions.unwrap_or(0) > 0 || file.deletions.unwrap_or(0) > 0,
                    |el| {
                        el.child(
                            h_flex()
                                .flex_shrink_0()
                                .gap(px(4.0))
                                .font_family(SharedString::from(MONO_FONT))
                                .text_size(px(11.0))
                                .when(file.additions.unwrap_or(0) > 0, |s| {
                                    s.child(
                                        div()
                                            .text_color(added)
                                            .child(format!("+{}", file.additions.unwrap_or(0))),
                                    )
                                })
                                .when(file.deletions.unwrap_or(0) > 0, |s| {
                                    s.child(
                                        div()
                                            .text_color(removed)
                                            .child(format!("-{}", file.deletions.unwrap_or(0))),
                                    )
                                }),
                        )
                    },
                );
            list = list.child(row);
        }
        split = split
            .child(list)
            .child(div().w(px(1.0)).self_stretch().bg(divider));
    }

    if let Some(file) = selected {
        let state = diffs_by_path
            .get(&file.path)
            .unwrap_or(&FileDiffState::Idle);
        let viewed_state = viewed_states.get(&file.path).copied();
        split = split.child(render_file_diff_pane(
            tokens,
            file,
            state,
            viewed_state,
            viewed_enabled,
            word_wrap,
            cb,
        ));
    }

    split.into_any_element()
}

fn render_file_diff_pane(
    tokens: &Tokens,
    entry: &CodeFileEntry,
    state: &FileDiffState,
    viewed_state: Option<PullRequestFileViewedState>,
    viewed_enabled: bool,
    word_wrap: bool,
    cb: &TabCallbacks,
) -> AnyElement {
    let ui_fg = to_hsla(tokens.foreground);
    let code_fg = to_hsla(tokens.code_foreground);
    let muted = to_hsla(tokens.muted_foreground);
    let gutter_fg = to_hsla(tokens.muted_foreground.with_alpha(0.65));
    let divider = to_hsla(tokens.shell_divider);
    let added = to_hsla(tokens.diff_added);
    let removed = to_hsla(tokens.diff_removed);
    let mono = SharedString::from(MONO_FONT);

    let (add_count, del_count) = match state {
        FileDiffState::Loaded(diff) => (diff.additions, diff.deletions),
        _ => (entry.additions.unwrap_or(0), entry.deletions.unwrap_or(0)),
    };

    let is_viewed = viewed_state == Some(PullRequestFileViewedState::Viewed);
    let is_stale = viewed_state == Some(PullRequestFileViewedState::Dismissed);
    let mut header = h_flex()
        .w_full()
        .h(px(38.0))
        .flex_shrink_0()
        .px(px(14.0))
        .gap(px(8.0))
        .items_center()
        .justify_between()
        .border_b_1()
        .border_color(divider)
        .child(
            h_flex()
                .flex_1()
                .min_w_0()
                .items_center()
                .gap(px(6.0))
                .child(superhero_icon("superhero/file-diff.svg", 14.0, muted))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .text_size(px(UI_TEXT_PX))
                        .line_height(px(UI_LINE_HEIGHT_PX))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(ui_fg)
                        .child(entry.path.clone()),
                ),
        );

    let mut right = h_flex().flex_shrink_0().items_center().gap(px(12.0));
    if add_count > 0 || del_count > 0 {
        right = right.child(render_diff_stat(
            tokens,
            i64::try_from(add_count).unwrap_or(i64::MAX),
            i64::try_from(del_count).unwrap_or(i64::MAX),
            XS_TEXT_PX,
        ));
    }
    if viewed_enabled {
        let path_for_toggle = entry.path.clone();
        let next_viewed = !is_viewed;
        let on_toggle = cb.on_toggle_file_viewed.clone();
        right = right.child(
            h_flex()
                .items_center()
                .gap(px(6.0))
                .child(chrome::checkbox(
                    SharedString::from(format!("pr-viewed-{}", entry.path)),
                    is_viewed,
                    tokens,
                    move |_, window, cx| {
                        on_toggle(path_for_toggle.clone(), next_viewed, window, cx)
                    },
                ))
                .child(
                    div()
                        .id(SharedString::from(format!(
                            "pr-viewed-label-{}",
                            entry.path
                        )))
                        .text_size(px(11.0))
                        .text_color(if is_stale {
                            to_hsla(tokens.warning_foreground)
                        } else {
                            muted
                        })
                        .when(is_stale, |el| {
                            el.conn_fast_tooltip(
                                "This file has been pushed to since you marked it viewed.",
                                tokens,
                            )
                        })
                        .child(if is_stale { "Changed" } else { "Viewed" }),
                ),
        );
    }
    header = header.child(right);

    let body: AnyElement = match state {
        FileDiffState::Idle | FileDiffState::Loading => h_flex()
            .w_full()
            .py(px(32.0))
            .items_center()
            .justify_center()
            .gap(px(8.0))
            .text_size(px(UI_TEXT_PX))
            .text_color(muted)
            .child(superhero_icon("superhero/spinner.svg", 14.0, muted))
            .child("Loading file diff...")
            .into_any_element(),
        FileDiffState::Error(err) => div()
            .w_full()
            .p(px(16.0))
            .text_size(px(UI_TEXT_PX))
            .text_color(muted)
            .child(format!("Could not load file diff: {err}"))
            .into_any_element(),
        FileDiffState::Loaded(diff) if diff.is_binary => div()
            .w_full()
            .p(px(16.0))
            .text_size(px(UI_TEXT_PX))
            .text_color(muted)
            .child("Binary file changed.")
            .into_any_element(),
        FileDiffState::Loaded(diff) if diff.hunks.is_empty() => div()
            .w_full()
            .p(px(16.0))
            .text_size(px(UI_TEXT_PX))
            .text_color(muted)
            .child("No textual diff lines.")
            .into_any_element(),
        FileDiffState::Loaded(diff) => {
            let code_bg = tokens.shell_card;
            let is_dark = tokens.appearance == Appearance::Dark;
            let line_weight = if is_dark { 0.70 } else { 0.50 };
            let gutter_weight = if is_dark { 0.60 } else { 0.35 };
            let added_bg = to_hsla(color_mix_srgb(
                code_bg,
                line_weight,
                tokens.diff_added_background,
            ));
            let added_gutter_bg = to_hsla(color_mix_srgb(
                code_bg,
                gutter_weight,
                tokens.diff_added_background,
            ));
            let removed_bg = to_hsla(color_mix_srgb(
                code_bg,
                line_weight,
                tokens.diff_removed_background,
            ));
            let removed_gutter_bg = to_hsla(color_mix_srgb(
                code_bg,
                gutter_weight,
                tokens.diff_removed_background,
            ));
            let separator_bg = to_hsla(color_mix_srgb(code_bg, 0.95, tokens.code_foreground));

            let mut lines_col = v_flex().w_full().pb(px(24.0));
            for (hunk_idx, hunk) in diff.hunks.iter().enumerate() {
                let hunk_source: String = hunk
                    .lines
                    .iter()
                    .map(|l| l.text.as_str())
                    .collect::<Vec<_>>()
                    .join("\n");
                let highlighted = highlight_lines(&entry.path, &hunk_source, tokens);

                lines_col = lines_col.child(
                    div()
                        .w_full()
                        .px(px(12.0))
                        .py(px(3.0))
                        .bg(separator_bg)
                        .when(hunk_idx > 0, |el| el.border_t_1().border_color(divider))
                        .border_b_1()
                        .border_color(divider)
                        .font_family(mono.clone())
                        .text_size(px(XS_TEXT_PX))
                        .line_height(px(UI_LINE_HEIGHT_PX))
                        .text_color(muted)
                        .child(hunk.header.clone()),
                );
                for (line_idx, line) in hunk.lines.iter().enumerate() {
                    let (row_bg, gutter_bg, sign, sign_color) = match line.kind {
                        DiffLineKind::Added => (Some(added_bg), Some(added_gutter_bg), "+", added),
                        DiffLineKind::Removed => {
                            (Some(removed_bg), Some(removed_gutter_bg), "-", removed)
                        }
                        DiffLineKind::Context => (None, None, " ", muted),
                    };
                    let old_no = line.old_line.map_or_else(String::new, |n| n.to_string());
                    let new_no = line.new_line.map_or_else(String::new, |n| n.to_string());
                    let gutter = h_flex()
                        .flex_shrink_0()
                        .items_start()
                        .border_r_1()
                        .border_color(divider)
                        .bg(gutter_bg.unwrap_or_else(|| to_hsla(code_bg)))
                        .child(
                            div()
                                .w(px(34.0))
                                .flex_shrink_0()
                                .pr(px(5.0))
                                .text_right()
                                .text_color(gutter_fg)
                                .child(old_no),
                        )
                        .child(
                            div()
                                .w(px(34.0))
                                .flex_shrink_0()
                                .pr(px(6.0))
                                .text_right()
                                .text_color(gutter_fg)
                                .child(new_no),
                        );

                    let mut code_cell = if word_wrap {
                        h_flex().flex_1().min_w_0().flex_wrap().pr(px(12.0))
                    } else {
                        h_flex()
                            .flex_1()
                            .min_w_0()
                            .pr(px(12.0))
                            .overflow_hidden()
                            .whitespace_nowrap()
                    };
                    if let Some(spans) = highlighted.get(line_idx)
                        && !spans.is_empty()
                    {
                        for span in spans {
                            let mut el = div()
                                .text_color(to_hsla(span.color))
                                .child(span.text.clone());
                            if span.bold {
                                el = el.font_weight(FontWeight::BOLD);
                            }
                            if span.italic {
                                el = el.italic();
                            }
                            code_cell = code_cell.child(el);
                        }
                    } else {
                        code_cell = code_cell.text_color(code_fg).child(line.text.clone());
                    }

                    lines_col = lines_col.child(
                        h_flex()
                            .w_full()
                            .font_family(mono.clone())
                            .text_size(px(XS_TEXT_PX))
                            .line_height(px(UI_LINE_HEIGHT_PX))
                            .when_some(row_bg, |el, bg| el.bg(bg))
                            .child(gutter)
                            .child(
                                div()
                                    .w(px(16.0))
                                    .flex_shrink_0()
                                    .text_center()
                                    .text_color(sign_color)
                                    .child(sign),
                            )
                            .child(code_cell),
                    );
                }
            }
            lines_col.into_any_element()
        }
    };

    v_flex()
        .flex_1()
        .min_w_0()
        .child(header)
        .child(body)
        .into_any_element()
}

/// Floating bottom-right composer (`PullRequestComposer` + `PullRequestCommentForm` +
/// `PullRequestReviewForm`).
#[expect(
    clippy::too_many_arguments,
    reason = "view props passed explicitly from PullRequestPanel::render"
)]
pub(super) fn render_floating_composer(
    tokens: &Tokens,
    detail: &PullRequestDetail,
    open: bool,
    requested_mode: ComposerMode,
    comment_input: &Entity<TextareaState>,
    comment_empty: bool,
    comment_submitting: bool,
    review_input: &Entity<TextareaState>,
    review_text: &str,
    review_verdict: PullRequestReviewVerdict,
    review_submitting: bool,
    armed_confirm: Option<ConfirmableAction>,
    cb: &TabCallbacks,
) -> Option<AnyElement> {
    let can_comment = detail.capabilities.comment && detail.viewer_permissions.comment;
    let verdicts = available_review_verdicts(detail);
    if !can_comment && verdicts.is_empty() {
        return None;
    }

    let mode = if can_comment {
        if verdicts.is_empty() {
            ComposerMode::Comment
        } else {
            requested_mode
        }
    } else {
        ComposerMode::Review
    };

    let fg = to_hsla(tokens.foreground);
    let muted = to_hsla(tokens.muted_foreground);
    let divider = chrome::alpha(tokens.foreground, 0.10);
    let hover = to_hsla(tokens.shell_highlight);
    let (offset_y, blur, alpha) = match tokens.appearance {
        Appearance::Dark => (14.0, 36.0, 0.72),
        Appearance::Light => (12.0, 32.0, 0.32),
    };
    let shadow = BoxShadow {
        color: gpui_kit::hsla(0.0, 0.0, 0.0, alpha),
        offset: point(px(0.0), px(offset_y)),
        blur_radius: px(blur),
        spread_radius: px(-12.0),
        inset: false,
    };

    let follow_up = if detail.state == PullRequestState::Open
        && can_perform_action(detail, PullRequestAction::Close)
    {
        Some(PullRequestAction::Close)
    } else if detail.state == PullRequestState::Closed
        && can_perform_action(detail, PullRequestAction::Reopen)
    {
        Some(PullRequestAction::Reopen)
    } else {
        None
    };

    let on_toggle = cb.on_toggle_composer.clone();
    let trigger_tip = if !can_comment {
        "Review pull request"
    } else {
        "Comment or review"
    };
    let trigger = div()
        .id("pr-composer-trigger")
        .flex()
        .size(px(34.0))
        .items_center()
        .justify_center()
        .rounded(px(PILL_RADIUS_PX))
        .bg(to_hsla(tokens.popover))
        .border_1()
        .border_color(to_hsla(tokens.shell_divider_header))
        .shadow(vec![shadow.clone()])
        .cursor_pointer()
        .hover(move |s| s.bg(hover))
        .on_click(move |_, window, cx| on_toggle(window, cx))
        .conn_fast_tooltip(trigger_tip, tokens)
        .child(superhero_icon("superhero/thread.svg", 16.0, fg));

    let mut wrapper = v_flex()
        .absolute()
        .right(px(16.0))
        .bottom(px(12.0))
        .items_end()
        .gap(px(8.0));

    if open {
        let on_close = cb.on_toggle_composer.clone();
        let header_left: AnyElement = if can_comment && !verdicts.is_empty() {
            let on_mode = cb.on_set_composer_mode.clone();
            let seg_btn =
                |id: &'static str,
                 label: &'static str,
                 target: ComposerMode,
                 active: bool,
                 on_set: Rc<dyn Fn(ComposerMode, &mut Window, &mut App)>| {
                    div()
                        .id(id)
                        .h(px(24.0))
                        .px(px(10.0))
                        .flex()
                        .items_center()
                        .rounded(px(6.0))
                        .cursor_pointer()
                        .text_size(px(XS_TEXT_PX))
                        .line_height(px(XS_LINE_HEIGHT_PX))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(if active { fg } else { muted })
                        .when(active, |el| el.bg(hover))
                        .when(!active, |el| el.hover(move |s| s.text_color(fg)))
                        .on_click(move |_, window, cx| on_set(target, window, cx))
                        .child(label)
                };
            h_flex()
                .p(px(2.0))
                .gap(px(2.0))
                .rounded(px(8.0))
                .bg(to_hsla(tokens.shell_control))
                .border_1()
                .border_color(to_hsla(tokens.shell_divider_header))
                .child(seg_btn(
                    "pr-composer-mode-comment",
                    "Comment",
                    ComposerMode::Comment,
                    mode == ComposerMode::Comment,
                    on_mode.clone(),
                ))
                .child(seg_btn(
                    "pr-composer-mode-review",
                    "Review",
                    ComposerMode::Review,
                    mode == ComposerMode::Review,
                    on_mode,
                ))
                .into_any_element()
        } else {
            div()
                .text_size(px(14.0))
                .font_weight(FontWeight::MEDIUM)
                .text_color(fg)
                .child(if mode == ComposerMode::Review {
                    "Review pull request"
                } else {
                    "Comment on pull request"
                })
                .into_any_element()
        };

        let mut popover = v_flex()
            .id("pr-composer-popover")
            .w(px(380.0))
            .p(px(12.0))
            .gap(px(10.0))
            .rounded(px(12.0))
            .bg(to_hsla(tokens.popover))
            .border_1()
            .border_color(divider)
            .shadow(vec![shadow])
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .child(
                h_flex()
                    .w_full()
                    .items_center()
                    .justify_between()
                    .child(header_left)
                    .child(
                        div()
                            .id("pr-composer-close")
                            .flex()
                            .size(px(24.0))
                            .items_center()
                            .justify_center()
                            .rounded(px(PILL_RADIUS_PX))
                            .cursor_pointer()
                            .hover(move |s| s.bg(hover))
                            .on_click(move |_, window, cx| on_close(window, cx))
                            .conn_fast_tooltip("Close", tokens)
                            .child(superhero_icon("superhero/close.svg", 14.0, muted)),
                    ),
            );

        if mode == ComposerMode::Review {
            let effective_verdict = if verdicts.contains(&review_verdict) {
                review_verdict
            } else {
                verdicts
                    .first()
                    .copied()
                    .unwrap_or(PullRequestReviewVerdict::Comment)
            };
            let req_summary = is_request_changes_summary_required(&detail.provider);
            let can_send = !review_submitting
                && can_submit_review(effective_verdict, review_text, req_summary);
            let hint = review_placeholder(effective_verdict, req_summary);

            let mut verdict_row = h_flex().flex_wrap().items_center().gap(px(4.0));
            for verdict in &verdicts {
                let verdict = *verdict;
                let selected = verdict == effective_verdict;
                let on_pick = cb.on_select_review_verdict.clone();
                let (sel_bg, sel_border, sel_fg) = match verdict {
                    PullRequestReviewVerdict::Approve => (
                        to_hsla(tokens.success.with_alpha(0.14)),
                        to_hsla(tokens.success.with_alpha(0.40)),
                        to_hsla(tokens.success),
                    ),
                    PullRequestReviewVerdict::RequestChanges => (
                        to_hsla(tokens.destructive.with_alpha(0.14)),
                        to_hsla(tokens.destructive.with_alpha(0.40)),
                        to_hsla(tokens.destructive),
                    ),
                    PullRequestReviewVerdict::Comment => (
                        to_hsla(tokens.shell_highlight),
                        to_hsla(tokens.shell_divider_header),
                        fg,
                    ),
                };
                verdict_row = verdict_row.child(
                    h_flex()
                        .id(SharedString::from(format!("pr-verdict-opt-{verdict:?}")))
                        .h(px(24.0))
                        .px(px(8.0))
                        .gap(px(4.0))
                        .items_center()
                        .rounded(px(6.0))
                        .border_1()
                        .border_color(if selected {
                            sel_border
                        } else {
                            to_hsla(tokens.shell_divider_header)
                        })
                        .when(selected, |el| el.bg(sel_bg))
                        .cursor_pointer()
                        .text_size(px(XS_TEXT_PX))
                        .line_height(px(XS_LINE_HEIGHT_PX))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(if selected { sel_fg } else { muted })
                        .hover(move |s| s.bg(hover))
                        .on_click(move |_, window, cx| on_pick(verdict, window, cx))
                        .child(superhero_icon(
                            review_verdict_icon(verdict),
                            12.0,
                            if selected { sel_fg } else { muted },
                        ))
                        .child(review_verdict_label(verdict)),
                );
            }

            let on_submit_review = cb.on_submit_review.clone();
            popover = popover
                .child(
                    div()
                        .w_full()
                        .min_h(px(80.0))
                        .p(px(8.0))
                        .rounded(px(8.0))
                        .bg(to_hsla(tokens.shell_field))
                        .border_1()
                        .border_color(to_hsla(tokens.shell_divider_header))
                        .child(
                            Textarea::new(review_input)
                                .appearance(false)
                                .text_size(px(UI_TEXT_PX)),
                        ),
                )
                .child(div().text_size(px(11.0)).text_color(muted).child(hint))
                .child(
                    h_flex()
                        .w_full()
                        .items_center()
                        .justify_between()
                        .gap(px(8.0))
                        .child(verdict_row)
                        .child(small_outline_button(
                            "pr-review-submit",
                            Some("superhero/send.svg"),
                            if review_submitting {
                                "Submitting..."
                            } else {
                                "Submit review"
                            },
                            tokens,
                            !can_send,
                            move |window, cx| on_submit_review(window, cx),
                        )),
                );
        } else {
            let disabled = comment_empty || comment_submitting;
            let on_submit = cb.on_submit_comment.clone();
            let on_arm = cb.on_arm_confirm.clone();

            let mut footer = h_flex().w_full().items_center().justify_end().gap(px(8.0));
            if let Some(action) = follow_up {
                let is_close = action == PullRequestAction::Close;
                let armed = armed_confirm == Some(ConfirmableAction::CloseWithComment);
                let label = if comment_submitting {
                    if is_close {
                        "Closing..."
                    } else {
                        "Reopening..."
                    }
                } else if is_close && armed {
                    "Confirm close?"
                } else if is_close {
                    "Close with comment"
                } else {
                    "Reopen with comment"
                };
                let on_submit_action = on_submit.clone();
                let on_arm_action = on_arm.clone();
                footer = footer.child(small_outline_button(
                    "pr-comment-follow-up",
                    Some(if is_close {
                        "superhero/pull-request-closed.svg"
                    } else {
                        "superhero/pull-request.svg"
                    }),
                    label,
                    tokens,
                    disabled,
                    move |window, cx| {
                        if is_close && !armed {
                            on_arm_action(Some(ConfirmableAction::CloseWithComment), window, cx);
                        } else {
                            on_arm_action(None, window, cx);
                            on_submit_action(Some(action), window, cx);
                        }
                    },
                ));
            }

            footer = footer.child(small_outline_button(
                "pr-comment-submit",
                Some("superhero/send.svg"),
                if comment_submitting {
                    "Posting..."
                } else {
                    "Comment"
                },
                tokens,
                disabled,
                move |window, cx| on_submit(None, window, cx),
            ));

            popover = popover
                .child(
                    div()
                        .w_full()
                        .min_h(px(80.0))
                        .p(px(8.0))
                        .rounded(px(8.0))
                        .bg(to_hsla(tokens.shell_field))
                        .border_1()
                        .border_color(to_hsla(tokens.shell_divider_header))
                        .child(
                            Textarea::new(comment_input)
                                .appearance(false)
                                .text_size(px(UI_TEXT_PX)),
                        ),
                )
                .child(footer);
        }

        wrapper = wrapper.child(popover);
    }

    wrapper = wrapper.child(trigger);
    Some(wrapper.into_any_element())
}
