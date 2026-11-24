//! Pull request popovers and inline widgets:
//! - Reviewer picker (`PullRequestReviewerPicker.tsx`)
//! - Label picker (`PullRequestLabelPicker.tsx`)
//! - Base-branch freshness popover (`PullRequestBaseBranch.tsx`)
//! - Emoji reaction bar + picker (`IssueReactions.tsx`)

use crate::a11y::ConnA11yExt as _;
use std::collections::HashMap;
use std::rc::Rc;

use conn_contract::{
    IssueActor, IssueReaction, IssueReactionContent, PullRequestAction,
    PullRequestActionInputUpdateMethod, PullRequestLabelCandidate, PullRequestReviewerCandidate,
    PullRequestReviewerKind,
};
use conn_theme::{Appearance, Tokens};
use gpui_kit::component::input::{Input, InputState};
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
use super::super::header::superhero_icon;
use super::header::{render_actor_label, small_outline_button};
use super::logic::{
    BaseFreshness, REACTION_ORDER, apply_pending_reactions, filter_label_candidates,
    filter_reviewer_candidates, format_base_freshness_summary, label_chip_colors, reaction_emoji,
    reaction_name, reaction_tooltip, reactions_signature,
};

const PILL_RADIUS_PX: f32 = 9999.0;

/// Shared dropdown-glass shadow matching Conn's `PopoverPopup` / `ComboboxPopup`.
pub(super) fn glass_shadow(tokens: &Tokens) -> BoxShadow {
    let (offset_y, blur, alpha) = match tokens.appearance {
        Appearance::Dark => (18.0, 44.0, 0.80),
        Appearance::Light => (16.0, 40.0, 0.55),
    };
    BoxShadow {
        color: gpui_kit::hsla(0.0, 0.0, 0.0, alpha),
        offset: point(px(0.0), px(offset_y)),
        blur_radius: px(blur),
        spread_radius: px(-18.0),
        inset: false,
    }
}

/// Renders the Reviewers picker trigger and searchable dropdown (`PullRequestReviewerPicker.tsx`).
#[expect(
    clippy::too_many_arguments,
    reason = "view props passed explicitly from PullRequestPanel::render"
)]
pub(super) fn render_reviewer_picker(
    tokens: &Tokens,
    allowed: bool,
    open: bool,
    search_input: &Entity<InputState>,
    query: &str,
    loading: bool,
    error: Option<&str>,
    candidates: &[PullRequestReviewerCandidate],
    truncated: bool,
    pending_id: Option<&str>,
    on_toggle_open: Rc<dyn Fn(&mut Window, &mut App)>,
    on_select: Rc<dyn Fn(PullRequestReviewerCandidate, &mut Window, &mut App)>,
) -> AnyElement {
    let fg = to_hsla(tokens.foreground);
    let muted = to_hsla(tokens.muted_foreground);
    let hover = to_hsla(tokens.shell_highlight);

    if !allowed {
        return div()
            .id("pr-reviewer-picker-disabled")
            .flex()
            .flex_shrink_0()
            .size(px(24.0))
            .items_center()
            .justify_center()
            .rounded(px(PILL_RADIUS_PX))
            .opacity(0.45)
            .conn_fast_tooltip(
                "Asking someone to review needs write access on this repository",
                tokens,
            )
            .child(superhero_icon("superhero/user-add.svg", 14.0, muted))
            .into_any_element();
    }

    let trigger = div()
        .id("pr-reviewer-picker-btn")
        .a11y_button("panel.pr-reviewer-picker-btn", "Request a review")
        .flex()
        .flex_shrink_0()
        .size(px(24.0))
        .items_center()
        .justify_center()
        .rounded(px(PILL_RADIUS_PX))
        .cursor_pointer()
        .hover(move |s| s.bg(hover))
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .on_click(move |_, window, cx| on_toggle_open(window, cx))
        .conn_fast_tooltip("Request a review", tokens)
        .child(superhero_icon("superhero/user-add.svg", 14.0, muted));

    let mut anchor = div().relative().child(trigger);

    if open {
        let filtered = filter_reviewer_candidates(candidates, query);
        let divider = chrome::alpha(tokens.foreground, 0.08);
        let busy = pending_id.is_some();

        let mut list = v_flex()
            .id("pr-reviewer-picker-list")
            .a11y_group("panel.pull-request.reviewer-list", "Reviewer candidates")
            .w_full()
            .max_h(px(260.0))
            .overflow_y_scroll()
            .p(px(4.0))
            .gap(px(2.0));

        if loading && candidates.is_empty() {
            list = list.child(picker_loading_rows(tokens, 4));
        } else if let Some(err) = error
            && candidates.is_empty()
        {
            list = list.child(picker_message(
                tokens,
                format!("The people with access could not be read. {err}"),
            ));
        } else if filtered.is_empty() {
            let msg = if query.trim().is_empty() {
                "Nobody else has access to this repository."
            } else {
                "Nobody with access matches that."
            };
            list = list.child(picker_message(tokens, msg));
        } else {
            for candidate in filtered {
                let is_this_pending = pending_id == Some(candidate.id.as_str());
                let actor = IssueActor {
                    is_bot: candidate.is_bot,
                    login: candidate.login.clone(),
                    name: candidate.name.clone(),
                    avatar_url: candidate.avatar_url.clone(),
                };
                let candidate_owned = candidate.clone();
                let on_pick = on_select.clone();
                let mut row = h_flex()
                    .id(SharedString::from(format!(
                        "pr-rev-cand-{:?}-{}",
                        candidate.kind, candidate.id
                    )))
                    .w_full()
                    .min_h(px(28.0))
                    .px(px(8.0))
                    .py(px(4.0))
                    .gap(px(8.0))
                    .items_center()
                    .rounded(px(8.0))
                    .text_size(px(UI_TEXT_PX))
                    .line_height(px(UI_LINE_HEIGHT_PX))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .child(render_actor_label(tokens, Some(&actor))),
                    )
                    .when(candidate.kind == PullRequestReviewerKind::Team, |el| {
                        el.child(
                            div()
                                .flex_shrink_0()
                                .text_size(px(XS_TEXT_PX))
                                .text_color(muted)
                                .child("team"),
                        )
                    })
                    .when(is_this_pending, |el| {
                        el.child(superhero_icon("superhero/spinner.svg", 13.0, muted))
                    })
                    .when(!is_this_pending && candidate.is_requested, |el| {
                        el.child(superhero_icon("superhero/check.svg", 13.0, fg))
                    });
                if busy {
                    row = row.opacity(0.6);
                } else {
                    row = row
                        .cursor_pointer()
                        .hover(move |s| s.bg(hover))
                        .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                            cx.stop_propagation();
                            on_pick(candidate_owned.clone(), window, cx);
                        });
                }
                list = list.child(row);
            }
        }

        if truncated {
            list = list.child(picker_message(
                tokens,
                "This repository has more people with access than are listed here. Ask for the rest on the host.",
            ));
        }

        let popup = v_flex()
            .id("pr-reviewer-picker-popup")
            .a11y_group("panel.pull-request.reviewer-picker", "Reviewer picker")
            .w(px(288.0))
            .rounded(px(12.0))
            .bg(to_hsla(tokens.popover))
            .border_1()
            .border_color(divider)
            .shadow(vec![glass_shadow(tokens)])
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .child(picker_search_bar(tokens, search_input))
            .child(list);

        anchor = anchor.child(
            deferred(div().absolute().top(px(28.0)).left(px(0.0)).child(popup)).with_priority(4),
        );
    }

    anchor.into_any_element()
}

/// Renders the Labels picker trigger and searchable dropdown (`PullRequestLabelPicker.tsx`).
#[expect(
    clippy::too_many_arguments,
    reason = "view props passed explicitly from PullRequestPanel::render"
)]
pub(super) fn render_label_picker(
    tokens: &Tokens,
    allowed: bool,
    open: bool,
    search_input: &Entity<InputState>,
    query: &str,
    loading: bool,
    error: Option<&str>,
    candidates: &[PullRequestLabelCandidate],
    truncated: bool,
    pending_name: Option<&str>,
    on_toggle_open: Rc<dyn Fn(&mut Window, &mut App)>,
    on_select: Rc<dyn Fn(PullRequestLabelCandidate, &mut Window, &mut App)>,
) -> AnyElement {
    let fg = to_hsla(tokens.foreground);
    let muted = to_hsla(tokens.muted_foreground);
    let hover = to_hsla(tokens.shell_highlight);

    if !allowed {
        return div()
            .id("pr-label-picker-disabled")
            .flex()
            .flex_shrink_0()
            .size(px(24.0))
            .items_center()
            .justify_center()
            .rounded(px(PILL_RADIUS_PX))
            .opacity(0.45)
            .conn_fast_tooltip(
                "Changing labels needs triage access on this repository",
                tokens,
            )
            .child(superhero_icon("superhero/tag.svg", 14.0, muted))
            .into_any_element();
    }

    let trigger = div()
        .id("pr-label-picker-btn")
        .a11y_button("panel.pr-label-picker-btn", "Change labels")
        .flex()
        .flex_shrink_0()
        .size(px(24.0))
        .items_center()
        .justify_center()
        .rounded(px(PILL_RADIUS_PX))
        .cursor_pointer()
        .hover(move |s| s.bg(hover))
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .on_click(move |_, window, cx| on_toggle_open(window, cx))
        .conn_fast_tooltip("Change labels", tokens)
        .child(superhero_icon("superhero/tag.svg", 14.0, muted));

    let mut anchor = div().relative().child(trigger);

    if open {
        let filtered = filter_label_candidates(candidates, query);
        let divider = chrome::alpha(tokens.foreground, 0.08);
        let busy = pending_name.is_some();

        let mut list = v_flex()
            .id("pr-label-picker-list")
            .a11y_group("panel.pull-request.label-list", "Label candidates")
            .w_full()
            .max_h(px(260.0))
            .overflow_y_scroll()
            .p(px(4.0))
            .gap(px(2.0));

        if loading && candidates.is_empty() {
            list = list.child(picker_loading_rows(tokens, 4));
        } else if let Some(err) = error
            && candidates.is_empty()
        {
            list = list.child(picker_message(
                tokens,
                format!("The labels could not be read. {err}"),
            ));
        } else if filtered.is_empty() {
            let msg = if query.trim().is_empty() {
                "This repository has no labels."
            } else {
                "No label matches that."
            };
            list = list.child(picker_message(tokens, msg));
        } else {
            for (idx, candidate) in filtered.into_iter().enumerate() {
                let is_this_pending = pending_name == Some(candidate.name.as_str());
                let (chip_bg, chip_fg) = label_chip_colors(tokens, candidate.color.as_deref());
                let candidate_owned = candidate.clone();
                let on_pick = on_select.clone();
                let desc = candidate
                    .description
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(ToOwned::to_owned);
                let mut row = h_flex()
                    .id(SharedString::from(format!("pr-label-cand-{idx}")))
                    .a11y_button(
                        format!("panel.pull-request.label-candidate.{idx}"),
                        "Label candidate",
                    )
                    .w_full()
                    .min_h(px(28.0))
                    .px(px(8.0))
                    .py(px(4.0))
                    .gap(px(8.0))
                    .items_center()
                    .rounded(px(8.0))
                    .text_size(px(UI_TEXT_PX))
                    .line_height(px(UI_LINE_HEIGHT_PX))
                    .child(
                        div()
                            .h(px(20.0))
                            .max_w(px(160.0))
                            .px(px(7.0))
                            .flex()
                            .flex_shrink_0()
                            .items_center()
                            .rounded(px(PILL_RADIUS_PX))
                            .bg(to_hsla(chip_bg))
                            .text_size(px(XS_TEXT_PX))
                            .line_height(px(XS_LINE_HEIGHT_PX))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(to_hsla(chip_fg))
                            .child(div().min_w_0().truncate().child(candidate.name.clone())),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .text_size(px(XS_TEXT_PX))
                            .text_color(muted)
                            .when_some(desc, |el, d| el.child(d)),
                    )
                    .when(is_this_pending, |el| {
                        el.child(superhero_icon("superhero/spinner.svg", 13.0, muted))
                    })
                    .when(!is_this_pending && candidate.is_applied, |el| {
                        el.child(superhero_icon("superhero/check.svg", 13.0, fg))
                    });
                if busy {
                    row = row.opacity(0.6);
                } else {
                    row = row
                        .cursor_pointer()
                        .hover(move |s| s.bg(hover))
                        .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                            cx.stop_propagation();
                            on_pick(candidate_owned.clone(), window, cx);
                        });
                }
                list = list.child(row);
            }
        }

        if truncated {
            list = list.child(picker_message(
                tokens,
                "This repository has more labels than are listed here. Apply the rest on the host.",
            ));
        }

        let popup = v_flex()
            .id("pr-label-picker-popup")
            .a11y_group("panel.pull-request.label-picker", "Label picker")
            .w(px(288.0))
            .rounded(px(12.0))
            .bg(to_hsla(tokens.popover))
            .border_1()
            .border_color(divider)
            .shadow(vec![glass_shadow(tokens)])
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .child(picker_search_bar(tokens, search_input))
            .child(list);

        anchor = anchor.child(
            deferred(div().absolute().top(px(28.0)).left(px(0.0)).child(popup)).with_priority(4),
        );
    }

    anchor.into_any_element()
}

/// Renders the base-branch warning trigger and update popover (`PullRequestBaseBranch.tsx`).
pub(super) fn render_base_branch_freshness(
    tokens: &Tokens,
    base_branch: &str,
    freshness: Option<&BaseFreshness>,
    popover_open: bool,
    pending_action: Option<PullRequestAction>,
    on_toggle_popover: Rc<dyn Fn(&mut Window, &mut App)>,
    on_update: Rc<dyn Fn(PullRequestActionInputUpdateMethod, &mut Window, &mut App)>,
) -> AnyElement {
    let muted = to_hsla(tokens.muted_foreground);

    let Some(freshness) = freshness else {
        return div()
            .id("pr-base-branch")
            .max_w(px(160.0))
            .truncate()
            .text_color(muted)
            .conn_code_tooltip(base_branch.to_owned(), tokens)
            .child(base_branch.to_owned())
            .into_any_element();
    };

    let warn_fg = to_hsla(tokens.warning_foreground);
    let fg = to_hsla(tokens.foreground);
    let hover_bg = chrome::alpha(tokens.warning, 0.12);
    let summary = format_base_freshness_summary(base_branch, freshness.behind_by);
    let busy = pending_action.is_some();

    let trigger = h_flex()
        .id("pr-base-freshness-trigger")
        .a11y_button("panel.pr-base-freshness-trigger", "Base branch freshness")
        .max_w(px(180.0))
        .px(px(4.0))
        .py(px(2.0))
        .gap(px(4.0))
        .items_center()
        .rounded(px(4.0))
        .cursor_pointer()
        .text_color(warn_fg)
        .hover(move |s| s.bg(hover_bg))
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .on_click(move |_, window, cx| on_toggle_popover(window, cx))
        .conn_fast_tooltip(summary.clone(), tokens)
        .child(div().min_w_0().truncate().child(base_branch.to_owned()))
        .child(superhero_icon("superhero/warning.svg", 13.0, warn_fg));

    let mut anchor = div().relative().child(trigger);

    if popover_open {
        let divider = chrome::alpha(tokens.foreground, 0.08);
        let mut popup = v_flex()
            .id("pr-base-freshness-popover")
            .w(px(300.0))
            .p(px(10.0))
            .gap(px(4.0))
            .rounded(px(12.0))
            .bg(to_hsla(tokens.popover))
            .border_1()
            .border_color(divider)
            .shadow(vec![glass_shadow(tokens)])
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .child(
                div()
                    .text_size(px(XS_TEXT_PX))
                    .line_height(px(XS_LINE_HEIGHT_PX))
                    .text_color(fg)
                    .child(summary),
            )
            .child(
                div()
                    .text_size(px(XS_TEXT_PX))
                    .line_height(px(XS_LINE_HEIGHT_PX))
                    .text_color(muted)
                    .child("Changes can be cleanly merged."),
            );

        if !freshness.methods.is_empty() {
            let mut actions = h_flex().mt(px(6.0)).flex_wrap().items_center().gap(px(6.0));
            for method in &freshness.methods {
                let method = *method;
                let on_upd = on_update.clone();
                let label = if pending_action == Some(PullRequestAction::UpdateBranch) {
                    "Updating..."
                } else if method == PullRequestActionInputUpdateMethod::Rebase {
                    "Update with rebase"
                } else {
                    "Update branch"
                };
                actions = actions.child(small_outline_button(
                    format!("pr-base-update-{method:?}"),
                    Some("superhero/merge.svg"),
                    label,
                    tokens,
                    busy,
                    move |window, cx| on_upd(method, window, cx),
                ));
            }
            popup = popup.child(actions);
        }

        anchor = anchor.child(
            deferred(div().absolute().top(px(28.0)).left(px(0.0)).child(popup)).with_priority(4),
        );
    }

    anchor.into_any_element()
}

/// Renders an emoji reaction bar and add-reaction picker (`IssueReactionBar` in
/// `IssueReactions.tsx`).
#[expect(
    clippy::too_many_arguments,
    reason = "view props passed explicitly from PullRequestPanel::render"
)]
pub(super) fn render_reaction_bar(
    tokens: &Tokens,
    subject_key: &str,
    subject_id: Option<String>,
    reactions: &[IssueReaction],
    pending_map: Option<&(String, HashMap<IssueReactionContent, bool>)>,
    can_react: bool,
    picker_open: bool,
    on_toggle_picker: Rc<dyn Fn(String, &mut Window, &mut App)>,
    on_toggle_reaction: Rc<
        dyn Fn(String, Option<String>, IssueReactionContent, bool, String, &mut Window, &mut App),
    >,
) -> Option<AnyElement> {
    let sig = reactions_signature(reactions);
    let empty_overrides = HashMap::new();
    let overrides = pending_map
        .filter(|(saved_sig, _)| saved_sig == &sig)
        .map_or(&empty_overrides, |(_, map)| map);
    let shown = apply_pending_reactions(reactions, overrides);

    if shown.is_empty() && !can_react {
        return None;
    }

    let fg = to_hsla(tokens.foreground);
    let muted = to_hsla(tokens.muted_foreground);
    let primary_border = to_hsla(tokens.primary.with_alpha(0.60));
    let primary_bg = to_hsla(tokens.primary.with_alpha(0.10));
    let idle_border = to_hsla(tokens.shell_divider_header);
    let idle_bg = chrome::alpha(tokens.foreground, 0.04);
    let hover = to_hsla(tokens.shell_highlight);

    let mut bar = h_flex().min_w_0().flex_wrap().items_center().gap(px(4.0));

    for reaction in &shown {
        let content = reaction.content;
        let reacted = reaction.viewer_has_reacted;
        let tooltip = reaction_tooltip(reaction);
        let mut pill = h_flex()
            .id(SharedString::from(format!(
                "pr-react-{subject_key}-{content:?}"
            )))
            .a11y_switch(
                format!("panel.pull-request.react.{subject_key}.{content:?}"),
                format!("{} {}", reaction_name(content), reaction.count),
                reacted,
            )
            .h(px(24.0))
            .px(px(8.0))
            .gap(px(4.0))
            .items_center()
            .rounded(px(PILL_RADIUS_PX))
            .border_1()
            .border_color(if reacted { primary_border } else { idle_border })
            .bg(if reacted { primary_bg } else { idle_bg })
            .text_size(px(XS_TEXT_PX))
            .line_height(px(XS_LINE_HEIGHT_PX))
            .text_color(if reacted { fg } else { muted })
            .conn_fast_tooltip(tooltip, tokens)
            .child(reaction_emoji(content))
            .child(reaction.count.to_string());

        if can_react {
            let key_owned = subject_key.to_owned();
            let sid = subject_id.clone();
            let sig_owned = sig.clone();
            let on_react = on_toggle_reaction.clone();
            pill = pill
                .cursor_pointer()
                .hover(move |s| s.border_color(primary_border))
                .on_click(move |_, window, cx| {
                    on_react(
                        key_owned.clone(),
                        sid.clone(),
                        content,
                        !reacted,
                        sig_owned.clone(),
                        window,
                        cx,
                    );
                });
        }
        bar = bar.child(pill);
    }

    if can_react {
        let key_for_toggle = subject_key.to_owned();
        let on_open = on_toggle_picker.clone();
        let add_btn = div()
            .id(SharedString::from(format!("pr-react-add-{subject_key}")))
            .a11y_button(
                format!("panel.pull-request.react-add.{subject_key}"),
                "Add a reaction",
            )
            .flex()
            .flex_shrink_0()
            .h(px(24.0))
            .px(px(6.0))
            .items_center()
            .justify_center()
            .rounded(px(PILL_RADIUS_PX))
            .border_1()
            .border_color(idle_border)
            .cursor_pointer()
            .hover(move |s| s.border_color(primary_border).bg(hover))
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .on_click(move |_, window, cx| on_open(key_for_toggle.clone(), window, cx))
            .conn_fast_tooltip("Add a reaction", tokens)
            .child(superhero_icon("superhero/react.svg", 13.0, muted));

        let mut picker_anchor = div().relative().child(add_btn);
        if picker_open {
            let divider = chrome::alpha(tokens.foreground, 0.08);
            let mut row = h_flex()
                .id(SharedString::from(format!("pr-react-picker-{subject_key}")))
                .a11y_group(
                    format!("panel.pull-request.react-picker.{subject_key}"),
                    "Reactions",
                )
                .p(px(4.0))
                .gap(px(2.0))
                .items_center()
                .rounded(px(10.0))
                .bg(to_hsla(tokens.popover))
                .border_1()
                .border_color(divider)
                .shadow(vec![glass_shadow(tokens)])
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation());

            for content in REACTION_ORDER {
                let reacted = shown
                    .iter()
                    .find(|r| r.content == content)
                    .is_some_and(|r| r.viewer_has_reacted);
                let key_owned = subject_key.to_owned();
                let sid = subject_id.clone();
                let sig_owned = sig.clone();
                let on_react = on_toggle_reaction.clone();
                row = row.child(
                    div()
                        .id(SharedString::from(format!(
                            "pr-react-opt-{subject_key}-{content:?}"
                        )))
                        .a11y_switch(
                            format!("panel.pull-request.react-opt.{subject_key}.{content:?}"),
                            reaction_name(content),
                            reacted,
                        )
                        .flex()
                        .size(px(28.0))
                        .items_center()
                        .justify_center()
                        .rounded(px(6.0))
                        .cursor_pointer()
                        .text_size(px(15.0))
                        .when(reacted, |el| el.bg(primary_bg))
                        .hover(move |s| s.bg(hover))
                        .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                            cx.stop_propagation();
                            on_react(
                                key_owned.clone(),
                                sid.clone(),
                                content,
                                !reacted,
                                sig_owned.clone(),
                                window,
                                cx,
                            );
                        })
                        .conn_fast_tooltip(reaction_name(content), tokens)
                        .child(reaction_emoji(content)),
                );
            }

            picker_anchor = picker_anchor.child(
                deferred(div().absolute().bottom(px(30.0)).left(px(0.0)).child(row))
                    .with_priority(4),
            );
        }

        bar = bar.child(picker_anchor);
    }

    Some(bar.into_any_element())
}

fn picker_search_bar(tokens: &Tokens, input: &Entity<InputState>) -> AnyElement {
    let muted = to_hsla(tokens.muted_foreground);
    let divider = chrome::alpha(tokens.foreground, 0.08);
    h_flex()
        .w_full()
        .h(px(34.0))
        .px(px(10.0))
        .gap(px(6.0))
        .items_center()
        .border_b_1()
        .border_color(divider)
        .child(superhero_icon("superhero/search.svg", 13.0, muted))
        .child(
            div().flex_1().min_w_0().child(
                Input::new(input)
                    .appearance(false)
                    .text_size(px(UI_TEXT_PX)),
            ),
        )
        .into_any_element()
}

fn picker_loading_rows(tokens: &Tokens, count: usize) -> AnyElement {
    let bar_bg = chrome::alpha(tokens.muted_foreground, 0.15);
    let mut col = v_flex().w_full().p(px(4.0)).gap(px(8.0));
    for _ in 0..count {
        col = col.child(
            h_flex()
                .items_center()
                .gap(px(8.0))
                .px(px(4.0))
                .child(div().size(px(16.0)).rounded(px(PILL_RADIUS_PX)).bg(bar_bg))
                .child(div().w(px(120.0)).h(px(12.0)).rounded(px(4.0)).bg(bar_bg)),
        );
    }
    col.into_any_element()
}

fn picker_message(tokens: &Tokens, message: impl Into<SharedString>) -> AnyElement {
    div()
        .w_full()
        .px(px(8.0))
        .py(px(6.0))
        .text_size(px(XS_TEXT_PX))
        .line_height(px(XS_LINE_HEIGHT_PX))
        .text_color(to_hsla(tokens.muted_foreground))
        .child(message.into())
        .into_any_element()
}
