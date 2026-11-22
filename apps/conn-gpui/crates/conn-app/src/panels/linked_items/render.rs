//! Pure rendering functions for the Linked items surface.
//!
//! Port of Conn's `ThreadPullRequestsPanel.tsx`, `PullRequestListRow.tsx`,
//! `ThreadDetailsIssueRows.tsx`, `PullRequestsUnavailableState.tsx`, and
//! `LinkPullRequestDialog.tsx`, painted exclusively with `conn_theme::Tokens`.

use std::collections::HashMap;
use std::rc::Rc;

use conn_contract::{PullRequestState, ThreadPullRequestLink, ThreadPullRequestLinkSource};
use conn_theme::{Appearance, Tokens};
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::*;
use gpui_kit::{
    AnyElement, App, BoxShadow, Entity, FontWeight, MouseButton, SharedString, Window, deferred,
    div, point, px,
};

use super::ChangeBreakdownState;
use super::logic::{
    ChainKind, IssueDetailSummary, LinkInputResolution, PullRequestListLine, ServerCapabilities,
    ThreadIssueLink, format_diff_count, format_footer_summary, format_relative_time,
    issue_state_glyph, latest_synced_at, middle_truncate, open_pull_request_count, pr_checks_glyph,
    pr_has_conflict, pr_review_glyph, pr_state_glyph, pull_request_key, resolve_tone_hsla,
    thread_issue_key,
};
use crate::panels::chrome::{
    self, ConnTooltipExt as _, UI_LINE_HEIGHT_PX, UI_TEXT_PX, XS_LINE_HEIGHT_PX, XS_TEXT_PX,
    actor_tooltip_label,
};
use crate::panels::color::to_hsla;
use crate::panels::header::superhero_icon;
use crate::theme::MONO_FONT;

/// `text-sm`: 14px / 20px (`PullRequestRowLines` title, empty title).
const SM_TEXT_PX: f32 = 14.0;
const SM_LINE_HEIGHT_PX: f32 = 20.0;
/// `text-2xs`: 11px / 16px (`PullRequestRowLines` meta/signals/status, footer).
const TWO_XS_TEXT_PX: f32 = 11.0;
const TWO_XS_LINE_HEIGHT_PX: f32 = 16.0;
/// `EmptyTitle`: `text-xl` (20px / 28px).
const EMPTY_TITLE_PX: f32 = 20.0;
const EMPTY_TITLE_LINE_HEIGHT_PX: f32 = 28.0;
/// `PullRequestRow` base left padding (`0.5rem` = 8px) and per-depth indent (`1.25rem` = 20px).
const ROW_BASE_PAD_LEFT_PX: f32 = 8.0;
const ROW_DEPTH_STEP_PX: f32 = 20.0;
/// `Button size="sm"` (`sm:h-7` = 28px, `--control-radius` = 6px in right panel).
const OUTLINE_BTN_HEIGHT_PX: f32 = 28.0;
const CONTROL_RADIUS_PX: f32 = 6.0;
/// `Button size="icon-micro"` (`size-5` = 20px, `rounded-sm` = 4px).
const ROW_ACTION_BTN_PX: f32 = 20.0;

/// Callbacks wired from the rendered list back into `LinkedItemsPanel`.
pub(super) struct ListCallbacks {
    pub(super) on_open_pr: Rc<dyn Fn(ThreadPullRequestLink, &mut Window, &mut App)>,
    pub(super) on_open_issue: Rc<dyn Fn(ThreadIssueLink, &mut Window, &mut App)>,
    pub(super) on_copy_link: Rc<dyn Fn(String, &mut Window, &mut App)>,
    pub(super) on_toggle_watch: Rc<dyn Fn(ThreadPullRequestLink, bool, &mut Window, &mut App)>,
    pub(super) on_unlink: Rc<dyn Fn(ThreadPullRequestLink, &mut Window, &mut App)>,
    pub(super) on_toggle_menu: Rc<dyn Fn(Option<String>, &mut Window, &mut App)>,
    pub(super) on_toggle_breakdown:
        Rc<dyn Fn(String, ThreadPullRequestLink, &mut Window, &mut App)>,
    pub(super) on_open_link_dialog: Rc<dyn Fn(&mut Window, &mut App)>,
    pub(super) on_dismiss_notice: Rc<dyn Fn(&mut Window, &mut App)>,
}

/// Conn `PullRequestsUnavailableState`: stacked tile `EmptyMedia`, title, error, optional Retry.
pub(super) fn render_unavailable_state(
    tokens: &Tokens,
    title: impl Into<SharedString>,
    error: impl Into<SharedString>,
    on_retry: Option<Rc<dyn Fn(&mut Window, &mut App)>>,
) -> AnyElement {
    let fg = to_hsla(tokens.foreground);
    let muted = to_hsla(tokens.muted_foreground);
    let tile_bg = to_hsla(tokens.shell_tile);
    let tile_border = to_hsla(tokens.shell_tile_border);

    let icon_tile = div()
        .size(px(36.0))
        .rounded(px(6.0))
        .border_1()
        .border_color(tile_border)
        .bg(tile_bg)
        .flex()
        .items_center()
        .justify_center()
        .child(superhero_icon("superhero/pull-request.svg", 18.0, fg));

    v_flex()
        .flex_1()
        .min_h_0()
        .w_full()
        .items_center()
        .justify_center()
        .gap(px(24.0))
        .p(px(24.0))
        .child(icon_tile)
        .child(
            v_flex()
                .max_w(px(384.0))
                .items_center()
                .gap(px(4.0))
                .child(
                    div()
                        .text_size(px(EMPTY_TITLE_PX))
                        .line_height(px(EMPTY_TITLE_LINE_HEIGHT_PX))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(fg)
                        .text_center()
                        .child(title.into()),
                )
                .child(
                    div()
                        .text_size(px(SM_TEXT_PX))
                        .line_height(px(SM_LINE_HEIGHT_PX))
                        .text_color(muted)
                        .text_center()
                        .child(error.into()),
                ),
        )
        .when_some(on_retry, |col, retry| {
            col.child(outline_button(
                "linked-items-retry-btn",
                Some("superhero/refresh.svg"),
                "Retry",
                tokens,
                false,
                move |window, cx| retry(window, cx),
            ))
        })
        .into_any_element()
}

/// Calm centered loading indicator while the selected thread's projection is fetched.
pub(super) fn render_loading_state(tokens: &Tokens) -> AnyElement {
    let muted = to_hsla(tokens.muted_foreground);
    h_flex()
        .flex_1()
        .min_h_0()
        .w_full()
        .items_center()
        .justify_center()
        .gap(px(8.0))
        .px(px(chrome::ROW_PAD_START_PX))
        .text_size(px(UI_TEXT_PX))
        .line_height(px(UI_LINE_HEIGHT_PX))
        .text_color(muted)
        .child(superhero_icon("superhero/spinner.svg", 16.0, muted))
        .child("Loading linked items…")
        .into_any_element()
}

/// Conn empty state (`ThreadPullRequestsPanel.tsx:513-531`): 24px link icon, title, copy, and
/// outline `Link pull request` button.
pub(super) fn render_empty_state(
    tokens: &Tokens,
    on_open_link_dialog: Rc<dyn Fn(&mut Window, &mut App)>,
) -> AnyElement {
    let fg = to_hsla(tokens.foreground);
    let muted = to_hsla(tokens.muted_foreground);
    let icon_color = to_hsla(tokens.muted_foreground.with_alpha(0.60));

    v_flex()
        .flex_1()
        .min_h_0()
        .w_full()
        .items_center()
        .justify_center()
        .gap(px(8.0))
        .p(px(24.0))
        .child(superhero_icon("superhero/link.svg", 24.0, icon_color))
        .child(
            div()
                .text_size(px(SM_TEXT_PX))
                .line_height(px(SM_LINE_HEIGHT_PX))
                .font_weight(FontWeight::MEDIUM)
                .text_color(fg)
                .text_center()
                .child("No linked pull requests"),
        )
        .child(
            div()
                .max_w(px(240.0))
                .text_size(px(XS_TEXT_PX))
                .line_height(px(XS_LINE_HEIGHT_PX))
                .text_color(muted)
                .text_center()
                .child("Pull requests the agent opens from this thread land here. Link one yourself from a URL or a number."),
        )
        .child(outline_button(
            "linked-items-empty-link-btn",
            Some("superhero/add.svg"),
            "Link pull request",
            tokens,
            false,
            move |window, cx| on_open_link_dialog(window, cx),
        ))
        .into_any_element()
}

/// Renders the populated linked items list: optional Issues section, Pull requests list with
/// stack indentation and hover actions, optional action notice, and status footer.
#[expect(
    clippy::too_many_arguments,
    reason = "list renderer takes borrowed view state without cloning collections"
)]
pub(super) fn render_linked_list(
    tokens: &Tokens,
    visible_links: &[ThreadPullRequestLink],
    lines: &[PullRequestListLine],
    issues: &[ThreadIssueLink],
    issue_details: &HashMap<String, IssueDetailSummary>,
    open_menu_key: Option<&str>,
    open_breakdown_key: Option<&str>,
    breakdowns: &HashMap<String, ChangeBreakdownState>,
    capabilities: ServerCapabilities,
    notice: Option<&str>,
    now_ms: i64,
    callbacks: ListCallbacks,
) -> AnyElement {
    let muted = to_hsla(tokens.muted_foreground);
    let divider = to_hsla(tokens.shell_divider);

    let mut scroll = v_flex()
        .id("linked-items-scroll")
        .flex_1()
        .min_h_0()
        .w_full()
        .overflow_y_scroll()
        .p(px(6.0))
        .on_mouse_down(MouseButton::Left, {
            let on_toggle_menu = Rc::clone(&callbacks.on_toggle_menu);
            move |_, window, cx| on_toggle_menu(None, window, cx)
        });

    if !issues.is_empty() {
        let mut issues_section = v_flex().w_full().child(
            div()
                .px(px(8.0))
                .py(px(4.0))
                .text_size(px(XS_TEXT_PX))
                .line_height(px(XS_LINE_HEIGHT_PX))
                .font_weight(FontWeight::MEDIUM)
                .text_color(muted)
                .child("Issues"),
        );
        for issue in issues {
            let key = thread_issue_key(issue);
            let detail = issue_details.get(&key);
            issues_section = issues_section.child(render_issue_row(
                tokens,
                issue,
                detail,
                now_ms,
                Rc::clone(&callbacks.on_open_issue),
            ));
        }
        scroll = scroll.child(issues_section);

        if !lines.is_empty() {
            scroll = scroll.child(
                div()
                    .mt(px(8.0))
                    .border_t_1()
                    .border_color(divider)
                    .px(px(12.0))
                    .pt(px(8.0))
                    .pb(px(4.0))
                    .text_size(px(XS_TEXT_PX))
                    .line_height(px(XS_LINE_HEIGHT_PX))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(muted)
                    .child("Pull requests"),
            );
        }
    }

    for (idx, line) in lines.iter().enumerate() {
        let row_key = pull_request_key(&line.link);
        let menu_open = open_menu_key == Some(row_key.as_str());
        let breakdown_open = open_breakdown_key == Some(row_key.as_str());
        let breakdown = breakdowns.get(&row_key);
        scroll = scroll.child(render_pull_request_row(
            tokens,
            idx,
            line,
            &row_key,
            menu_open,
            breakdown_open,
            breakdown,
            capabilities.thread_pull_request_watch,
            now_ms,
            &callbacks,
        ));
    }

    let open_count = open_pull_request_count(visible_links);
    let link_count = visible_links.len();
    let last_synced = latest_synced_at(visible_links);
    let summary_text = format_footer_summary(open_count, link_count, last_synced, now_ms);

    let footer = h_flex()
        .w_full()
        .flex_shrink_0()
        .items_center()
        .justify_between()
        .gap(px(8.0))
        .border_t_1()
        .border_color(divider)
        .px(px(8.0))
        .py(px(6.0))
        .text_size(px(TWO_XS_TEXT_PX))
        .line_height(px(TWO_XS_LINE_HEIGHT_PX))
        .text_color(muted)
        .child(div().min_w_0().truncate().child(summary_text))
        .child(chrome::text_button(
            "linked-items-footer-link-btn",
            Some("superhero/add.svg"),
            "Link pull request",
            tokens,
            {
                let on_open_link_dialog = Rc::clone(&callbacks.on_open_link_dialog);
                move |_, window, cx| on_open_link_dialog(window, cx)
            },
        ));

    v_flex()
        .flex_1()
        .min_h_0()
        .w_full()
        .when_some(notice, |col, msg| {
            let on_dismiss = Rc::clone(&callbacks.on_dismiss_notice);
            col.child(
                div()
                    .id("linked-items-notice")
                    .cursor_pointer()
                    .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                        on_dismiss(window, cx);
                    })
                    .child(chrome::warning_notice(tokens, msg.to_owned())),
            )
        })
        .child(scroll)
        .child(footer)
        .into_any_element()
}

/// Renders one linked issue row (`ThreadDetailsIssueRows.tsx` with `compact={false}`).
fn render_issue_row(
    tokens: &Tokens,
    link: &ThreadIssueLink,
    detail: Option<&IssueDetailSummary>,
    now_ms: i64,
    on_open: Rc<dyn Fn(ThreadIssueLink, &mut Window, &mut App)>,
) -> AnyElement {
    let fg = to_hsla(tokens.foreground);
    let muted = to_hsla(tokens.muted_foreground);
    let row_hover = to_hsla(tokens.accent.with_alpha(0.60));
    let mono: SharedString = MONO_FONT.into();

    let state_spec = issue_state_glyph(detail.map(|d| &d.state));
    let state_color = resolve_tone_hsla(tokens, state_spec.tone);
    let title = detail.map_or(link.title.as_str(), |d| d.title.as_str());
    let comment_count = detail.map_or(0, |d| d.comment_count);
    let updated_iso = detail
        .and_then(|d| d.updated_at.as_deref())
        .unwrap_or(link.linked_at.as_str());
    let relative = format_relative_time(updated_iso, now_ms);

    let mut line_one = h_flex()
        .w_full()
        .min_w_0()
        .items_center()
        .gap(px(6.0))
        .child(
            div()
                .flex_shrink_0()
                .font_family(mono)
                .text_size(px(XS_TEXT_PX))
                .line_height(px(XS_LINE_HEIGHT_PX))
                .text_color(muted)
                .child(link.display_key.clone()),
        )
        .child(
            div()
                .min_w_0()
                .truncate()
                .text_size(px(SM_TEXT_PX))
                .line_height(px(SM_LINE_HEIGHT_PX))
                .text_color(fg)
                .child(title.to_owned()),
        );

    if comment_count > 0 {
        line_one = line_one.child(
            h_flex()
                .ml_auto()
                .flex_shrink_0()
                .items_center()
                .gap(px(2.0))
                .text_size(px(TWO_XS_TEXT_PX))
                .line_height(px(TWO_XS_LINE_HEIGHT_PX))
                .text_color(muted)
                .child(superhero_icon("superhero/thread.svg", 12.0, muted))
                .child(comment_count.to_string()),
        );
    }

    let mut line_two = h_flex()
        .w_full()
        .min_w_0()
        .items_center()
        .gap(px(6.0))
        .overflow_hidden()
        .text_size(px(TWO_XS_TEXT_PX))
        .line_height(px(TWO_XS_LINE_HEIGHT_PX))
        .text_color(muted);

    if let Some(author) = detail.and_then(|d| d.author.as_ref()) {
        line_two = line_two.child(
            h_flex()
                .id(SharedString::from(format!(
                    "linked-issue-author-{}-{}-{}",
                    link.tracker, link.scope, link.key
                )))
                .flex_shrink_0()
                .items_center()
                .gap(px(6.0))
                .conn_tooltip(actor_tooltip_label(Some(author)), tokens)
                .child(render_actor_avatar(tokens, Some(author), 16.0))
                .child(
                    div()
                        .max_w(px(112.0))
                        .truncate()
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(fg)
                        .child(author.login.clone()),
                ),
        );
    }

    line_two = line_two
        .child(superhero_icon("superhero/ticket.svg", 12.0, muted))
        .child(div().min_w_0().truncate().child(link.scope.clone()));

    if let Some(rel) = relative {
        line_two = line_two.child(
            div()
                .ml_auto()
                .flex_shrink_0()
                .whitespace_nowrap()
                .child(rel),
        );
    }

    let link_for_click = link.clone();
    h_flex()
        .id(SharedString::from(format!(
            "linked-issue-{}-{}-{}",
            link.tracker, link.scope, link.key
        )))
        .w_full()
        .items_center()
        .gap(px(8.0))
        .rounded(px(6.0))
        .px(px(8.0))
        .py(px(4.0))
        .cursor_pointer()
        .hover(move |s| s.bg(row_hover))
        .on_mouse_down(MouseButton::Left, move |_, window, cx| {
            cx.stop_propagation();
            on_open(link_for_click.clone(), window, cx);
        })
        .child(
            div()
                .id(SharedString::from(format!(
                    "linked-issue-state-{}-{}-{}",
                    link.tracker, link.scope, link.key
                )))
                .flex_shrink_0()
                .conn_tooltip(state_spec.label, tokens)
                .child(superhero_icon(state_spec.icon_path, 16.0, state_color)),
        )
        .child(v_flex().min_w_0().flex_1().child(line_one).child(line_two))
        .into_any_element()
}

/// Renders one linked pull request row (`LinkRowImpl` + `PullRequestRowGlyph` + `PullRequestRowLines`).
#[expect(
    clippy::too_many_arguments,
    reason = "row renderer takes borrowed line data and panel callbacks"
)]
fn render_pull_request_row(
    tokens: &Tokens,
    index: usize,
    line: &PullRequestListLine,
    row_key: &str,
    menu_open: bool,
    breakdown_open: bool,
    breakdown: Option<&ChangeBreakdownState>,
    supports_watch: bool,
    now_ms: i64,
    callbacks: &ListCallbacks,
) -> AnyElement {
    let fg = to_hsla(tokens.foreground);
    let muted = to_hsla(tokens.muted_foreground);
    let row_hover = to_hsla(tokens.accent.with_alpha(0.60));
    let mono: SharedString = MONO_FONT.into();

    let link = &line.link;
    let snapshot = link.snapshot.as_ref();
    let is_open = snapshot.is_none_or(|s| s.state == PullRequestState::Open);
    let watching = link.watch.is_some();
    let pad_left = ROW_BASE_PAD_LEFT_PX + (line.depth.min(3) as f32) * ROW_DEPTH_STEP_PX;
    let group_name = SharedString::from(format!("linked-pr-group-{index}"));

    // Leading glyph + optional conflict badge overlay (`PullRequestRowGlyph`).
    let state_spec = pr_state_glyph(snapshot);
    let state_color = resolve_tone_hsla(tokens, state_spec.tone);
    let mut glyph_box = div()
        .id(SharedString::from(format!("linked-pr-state-{index}")))
        .relative()
        .flex()
        .flex_shrink_0()
        .w(px(16.0))
        .h(px(16.0))
        .items_center()
        .justify_center()
        .conn_tooltip(state_spec.label, tokens)
        .child(superhero_icon(state_spec.icon_path, 16.0, state_color));

    if pr_has_conflict(snapshot) {
        glyph_box = glyph_box.child(
            div()
                .id(SharedString::from(format!("linked-pr-conflict-{index}")))
                .absolute()
                .right(px(-4.0))
                .bottom(px(-4.0))
                .size(px(12.0))
                .rounded(px(9999.0))
                .bg(to_hsla(tokens.shell_card))
                .flex()
                .items_center()
                .justify_center()
                .conn_tooltip("Has conflicts", tokens)
                .child(superhero_icon(
                    "superhero/warning.svg",
                    11.0,
                    to_hsla(tokens.destructive),
                )),
        );
    }

    // Line 1: #number, title, open signals (watching, checks, review), diff stat.
    let source_label = match link.source {
        ThreadPullRequestLinkSource::Manual => "Linked by you",
        ThreadPullRequestLinkSource::Created => "Created from this thread",
        ThreadPullRequestLinkSource::Agent => "Linked by the agent",
        ThreadPullRequestLinkSource::Stack => "Found in the stack",
        ThreadPullRequestLinkSource::StackDismissed => "Dismissed",
    };
    let number_tip = match format_relative_time(&link.linked_at, now_ms) {
        Some(rel) => format!("{source_label} · {rel}"),
        None => source_label.to_owned(),
    };
    let title = snapshot.map_or(link.repository.as_str(), |s| s.title.as_str());
    let mut line_one = h_flex()
        .w_full()
        .min_w_0()
        .items_center()
        .gap(px(6.0))
        .child(
            div()
                .id(SharedString::from(format!("linked-pr-number-{index}")))
                .flex_shrink_0()
                .font_family(mono.clone())
                .text_size(px(XS_TEXT_PX))
                .line_height(px(XS_LINE_HEIGHT_PX))
                .text_color(muted)
                .conn_tooltip(number_tip, tokens)
                .child(format!("#{}", link.number)),
        )
        .child(
            div()
                .min_w_0()
                .truncate()
                .text_size(px(SM_TEXT_PX))
                .line_height(px(SM_LINE_HEIGHT_PX))
                .text_color(fg)
                .child(title.to_owned()),
        );

    if is_open {
        let checks = snapshot.and_then(|s| s.checks_state.flatten());
        let review = snapshot.and_then(|s| s.review_decision.flatten());
        if watching || checks.is_some() || review.is_some() {
            let mut signals = h_flex().flex_shrink_0().items_center().gap(px(4.0));
            if watching {
                signals = signals.child(
                    div()
                        .id(SharedString::from(format!("linked-pr-watch-{index}")))
                        .flex()
                        .flex_shrink_0()
                        .conn_tooltip(
                            "Watching: the agent wakes when checks finish, someone comments, or the branch conflicts",
                            tokens,
                        )
                        .child(superhero_icon("superhero/show.svg", 14.0, fg)),
                );
            }
            if let Some(state) = checks {
                let spec = pr_checks_glyph(state);
                signals = signals.child(
                    div()
                        .id(SharedString::from(format!("linked-pr-checks-{index}")))
                        .flex()
                        .flex_shrink_0()
                        .conn_tooltip(spec.label, tokens)
                        .child(superhero_icon(
                            spec.icon_path,
                            14.0,
                            resolve_tone_hsla(tokens, spec.tone),
                        )),
                );
            }
            if let Some(decision) = review {
                let spec = pr_review_glyph(decision);
                // Conn: "The person glyphs are drawn short; one step up balances them."
                signals = signals.child(
                    div()
                        .id(SharedString::from(format!("linked-pr-review-{index}")))
                        .flex()
                        .flex_shrink_0()
                        .conn_tooltip(spec.label, tokens)
                        .child(superhero_icon(
                            spec.icon_path,
                            16.0,
                            resolve_tone_hsla(tokens, spec.tone),
                        )),
                );
            }
            line_one = line_one.child(signals);
        }
    }

    let additions = snapshot.and_then(|s| s.additions).unwrap_or(0);
    let deletions = snapshot.and_then(|s| s.deletions).unwrap_or(0);
    if additions > 0 || deletions > 0 {
        let breakdown_key = row_key.to_owned();
        let breakdown_link = link.clone();
        let on_toggle_breakdown = Rc::clone(&callbacks.on_toggle_breakdown);
        let hover_bg = to_hsla(tokens.shell_highlight);
        let mut stat_slot = div().relative().ml_auto().flex_shrink_0().child(
            h_flex()
                .id(SharedString::from(format!("linked-pr-diff-stat-{index}")))
                .items_center()
                .gap(px(4.0))
                .px(px(4.0))
                .py(px(1.0))
                .rounded(px(4.0))
                .cursor_pointer()
                .hover(move |s| s.bg(hover_bg))
                .font_family(mono.clone())
                .text_size(px(TWO_XS_TEXT_PX))
                .line_height(px(TWO_XS_LINE_HEIGHT_PX))
                .conn_tooltip("Change breakdown", tokens)
                .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                    cx.stop_propagation();
                    on_toggle_breakdown(breakdown_key.clone(), breakdown_link.clone(), window, cx);
                })
                .child(
                    div()
                        .text_color(to_hsla(tokens.diff_added))
                        .child(format!("+{}", format_diff_count(additions))),
                )
                .child(
                    div()
                        .text_color(to_hsla(tokens.diff_removed))
                        .child(format!("-{}", format_diff_count(deletions))),
                ),
        );
        if breakdown_open {
            stat_slot = stat_slot.child(render_change_breakdown_popover(tokens, breakdown));
        }
        line_one = line_one.child(stat_slot);
    }

    // Line 2: stack badge, author, repository, head -> base branches, updated relative time.
    let mut line_two = h_flex()
        .w_full()
        .min_w_0()
        .items_center()
        .gap(px(6.0))
        .overflow_hidden()
        .text_size(px(TWO_XS_TEXT_PX))
        .line_height(px(TWO_XS_LINE_HEIGHT_PX))
        .text_color(muted);

    if let Some(stack) = line.stack {
        let stack_fg = to_hsla(tokens.foreground.with_alpha(0.70));
        let stack_tip = match stack.kind {
            ChainKind::Native => format!(
                "Stack of {}: merging a layer lands the ones below it.",
                stack.size
            ),
            ChainKind::Derived => format!("{} pull requests chained by base branch.", stack.size),
        };
        line_two = line_two.child(
            h_flex()
                .id(SharedString::from(format!("linked-pr-stack-{index}")))
                .flex_shrink_0()
                .items_center()
                .gap(px(2.0))
                .text_color(stack_fg)
                .conn_tooltip(stack_tip, tokens)
                .child(superhero_icon("superhero/layers.svg", 12.0, stack_fg))
                .child(stack.size.to_string()),
        );
    }

    if let Some(author) = snapshot.and_then(|s| s.author.as_ref().and_then(|a| a.as_ref())) {
        line_two = line_two.child(
            h_flex()
                .id(SharedString::from(format!("linked-pr-author-{index}")))
                .flex_shrink_0()
                .items_center()
                .gap(px(4.0))
                .conn_tooltip(actor_tooltip_label(Some(author)), tokens)
                .child(render_actor_avatar(tokens, Some(author), 14.0))
                .child(
                    div()
                        .max_w(px(112.0))
                        .truncate()
                        .child(author.login.clone()),
                ),
        );
    }

    if let Some(s) = snapshot {
        line_two = line_two
            .child(
                div()
                    .id(SharedString::from(format!("linked-pr-repo-{index}")))
                    .min_w_0()
                    .max_w(px(128.0))
                    .truncate()
                    .font_family(mono.clone())
                    .conn_tooltip(link.repository.clone(), tokens)
                    .child(middle_truncate(&link.repository, 24)),
            )
            .child(
                h_flex()
                    .id(SharedString::from(format!("linked-pr-branches-{index}")))
                    .min_w_0()
                    .items_center()
                    .gap(px(4.0))
                    .font_family(mono)
                    .conn_tooltip(format!("{} → {}", s.head_branch, s.base_branch), tokens)
                    .child(
                        div()
                            .min_w_0()
                            .truncate()
                            .child(middle_truncate(&s.head_branch, 22)),
                    )
                    .child(div().flex_shrink_0().child("→"))
                    .child(
                        div()
                            .flex_shrink_0()
                            .truncate()
                            .child(middle_truncate(&s.base_branch, 16)),
                    ),
            );
    } else {
        line_two = line_two.child(
            div()
                .min_w_0()
                .truncate()
                .font_family(mono)
                .child(format!("{}/{}", link.host, link.repository)),
        );
    }

    if let Some(rel) = snapshot
        .and_then(|s| s.updated_at.as_deref())
        .and_then(|ts| format_relative_time(ts, now_ms))
    {
        line_two = line_two.child(
            div()
                .ml_auto()
                .flex_shrink_0()
                .whitespace_nowrap()
                .child(rel),
        );
    }

    // Hover actions trigger (`...`): overlays the bottom-right corner like Conn (`absolute
    // right-0 bottom-0.5 rounded-r-md bg-background pr-1 pl-5`) so diff stats and timestamps
    // stay flush right when idle. Uses `invisible()` / `visible()` in `group_hover` (never
    // changing `display`, which panics GPUI prepaint).
    let row_key_for_btn = row_key.to_owned();
    let row_key_for_ctx = row_key.to_owned();
    let on_toggle_btn = Rc::clone(&callbacks.on_toggle_menu);
    let on_toggle_ctx = Rc::clone(&callbacks.on_toggle_menu);
    let btn_hover = to_hsla(tokens.shell_highlight);

    let fade_bg = gpui_kit::linear_gradient(
        90.0,
        gpui_kit::linear_color_stop(to_hsla(tokens.shell_card.with_alpha(0.0)), 0.0),
        gpui_kit::linear_color_stop(to_hsla(tokens.shell_card), 0.45),
    );
    let mut action_anchor = div()
        .absolute()
        .right(px(0.0))
        .bottom(px(2.0))
        .pl(px(16.0))
        .pr(px(4.0))
        .rounded_r(px(6.0))
        .bg(fade_bg)
        .flex()
        .items_center()
        .when(!menu_open, |el| {
            let group = group_name.clone();
            el.invisible().group_hover(group, |s| s.visible())
        })
        .child(div().absolute().inset_0().rounded_r(px(6.0)).bg(row_hover))
        .child(
            div()
                .id(SharedString::from(format!("linked-pr-more-{index}")))
                .relative()
                .size(px(ROW_ACTION_BTN_PX))
                .rounded(px(4.0))
                .flex()
                .items_center()
                .justify_center()
                .cursor_pointer()
                .when(menu_open, |el| el.bg(btn_hover))
                .hover(move |s| s.bg(btn_hover))
                .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                    cx.stop_propagation();
                    let next = (!menu_open).then(|| row_key_for_btn.clone());
                    on_toggle_btn(next, window, cx);
                })
                .conn_tooltip(format!("Actions for #{}", link.number), tokens)
                .child(superhero_icon("superhero/more-horizontal.svg", 14.0, muted)),
        );

    if menu_open {
        action_anchor = action_anchor.child(render_row_actions_menu(
            tokens,
            index,
            link,
            is_open,
            watching,
            supports_watch,
            callbacks,
        ));
    }

    let link_for_open = link.clone();
    let on_open_pr = Rc::clone(&callbacks.on_open_pr);
    let mut row = h_flex()
        .id(SharedString::from(format!("linked-pr-row-{index}")))
        .group(group_name)
        .relative()
        .w_full()
        .items_center()
        .gap(px(8.0))
        .rounded(px(6.0))
        .pl(px(pad_left))
        .pr(px(4.0))
        .py(px(4.0))
        .cursor_pointer()
        .when(menu_open, |el| el.bg(row_hover))
        .hover(move |s| s.bg(row_hover))
        .on_mouse_down(MouseButton::Left, move |_, window, cx| {
            cx.stop_propagation();
            on_open_pr(link_for_open.clone(), window, cx);
        })
        .on_mouse_down(MouseButton::Right, move |_, window, cx| {
            cx.stop_propagation();
            on_toggle_ctx(Some(row_key_for_ctx.clone()), window, cx);
        });

    if line.depth > 0 {
        row = row.child(
            div()
                .ml(px(-8.0))
                .h(px(24.0))
                .w(px(1.0))
                .flex_shrink_0()
                .bg(to_hsla(tokens.border.with_alpha(0.70))),
        );
    }

    row.child(glyph_box)
        .child(v_flex().min_w_0().flex_1().child(line_one).child(line_two))
        .child(action_anchor)
        .into_any_element()
}

/// Anchored `dropdown-glass` actions menu for a pull request row (`ThreadPullRequestsPanel.tsx:353-385`).
fn render_row_actions_menu(
    tokens: &Tokens,
    index: usize,
    link: &ThreadPullRequestLink,
    is_open: bool,
    watching: bool,
    supports_watch: bool,
    callbacks: &ListCallbacks,
) -> AnyElement {
    let fg = to_hsla(tokens.foreground);
    let muted = to_hsla(tokens.muted_foreground);
    let highlight = to_hsla(tokens.shell_highlight);
    let border = to_hsla(tokens.foreground.with_alpha(0.08));
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

    let menu_item = |id: String,
                     icon: &'static str,
                     label: &'static str,
                     on_press: Box<dyn Fn(&mut Window, &mut App)>| {
        h_flex()
            .id(SharedString::from(id))
            .w_full()
            .min_h(px(28.0))
            .px(px(8.0))
            .py(px(4.0))
            .gap(px(8.0))
            .items_center()
            .rounded(px(8.0))
            .cursor_pointer()
            .text_size(px(SM_TEXT_PX))
            .line_height(px(SM_LINE_HEIGHT_PX))
            .text_color(fg)
            .hover(move |s| s.bg(highlight))
            .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                cx.stop_propagation();
                on_press(window, cx);
            })
            .child(superhero_icon(icon, 14.0, muted))
            .child(div().min_w_0().truncate().child(label))
    };

    let mut list = div()
        .id(SharedString::from(format!("linked-pr-menu-{index}")))
        .flex()
        .flex_col()
        .min_w(px(176.0))
        .p(px(4.0))
        .rounded(px(12.0))
        .bg(to_hsla(tokens.popover))
        .border_1()
        .border_color(border)
        .shadow(vec![shadow])
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .child(menu_item(
            format!("linked-pr-menu-copy-{index}"),
            "superhero/link.svg",
            "Copy link",
            {
                let url = link.url.clone();
                let on_copy = Rc::clone(&callbacks.on_copy_link);
                Box::new(move |window, cx| on_copy(url.clone(), window, cx))
            },
        ))
        .child(menu_item(
            format!("linked-pr-menu-open-{index}"),
            "superhero/arrow-up-right.svg",
            "Open",
            {
                let link = link.clone();
                let on_open = Rc::clone(&callbacks.on_open_pr);
                Box::new(move |window, cx| on_open(link.clone(), window, cx))
            },
        ));

    if supports_watch && is_open {
        let (icon, label) = if watching {
            ("superhero/hide.svg", "Stop watching")
        } else {
            ("superhero/show.svg", "Watch for changes")
        };
        list = list.child(menu_item(
            format!("linked-pr-menu-watch-{index}"),
            icon,
            label,
            {
                let link = link.clone();
                let on_watch = Rc::clone(&callbacks.on_toggle_watch);
                Box::new(move |window, cx| on_watch(link.clone(), !watching, window, cx))
            },
        ));
    }

    let unlink_label = if link.source == ThreadPullRequestLinkSource::Stack {
        "Dismiss from thread"
    } else {
        "Unlink from thread"
    };
    list = list.child(menu_item(
        format!("linked-pr-menu-unlink-{index}"),
        "superhero/unlink.svg",
        unlink_label,
        {
            let link = link.clone();
            let on_unlink = Rc::clone(&callbacks.on_unlink);
            Box::new(move |window, cx| on_unlink(link.clone(), window, cx))
        },
    ));

    deferred(
        div()
            .absolute()
            .top(px(ROW_ACTION_BTN_PX + 4.0))
            .right(px(0.0))
            .child(list),
    )
    .with_priority(2)
    .into_any_element()
}

/// Modal dialog for linking a pull request by URL or `#number` (`LinkPullRequestDialog.tsx`).
#[expect(
    clippy::too_many_arguments,
    reason = "dialog view receives borrowed panel fields and callbacks"
)]
pub(super) fn render_link_dialog(
    tokens: &Tokens,
    input: &Entity<InputState>,
    resolution: &LinkInputResolution,
    dirty: bool,
    submit_error: Option<&str>,
    pending: bool,
    on_cancel: Rc<dyn Fn(&mut Window, &mut App)>,
    on_submit: Rc<dyn Fn(&mut Window, &mut App)>,
) -> AnyElement {
    let fg = to_hsla(tokens.foreground);
    let muted = to_hsla(tokens.muted_foreground);
    let destructive = to_hsla(tokens.destructive);
    let border = to_hsla(tokens.foreground.with_alpha(0.10));
    let backdrop = gpui_kit::hsla(0.0, 0.0, 0.0, 0.42);
    let shadow = BoxShadow {
        color: gpui_kit::hsla(0.0, 0.0, 0.0, 0.55),
        offset: point(px(0.0), px(18.0)),
        blur_radius: px(44.0),
        spread_radius: px(-16.0),
        inset: false,
    };

    let can_submit = !pending && matches!(resolution, LinkInputResolution::Resolved(_));
    let preview = match resolution {
        LinkInputResolution::Resolved(parsed) => Some(format!(
            "{}/{} #{}",
            parsed.host, parsed.repository, parsed.number
        )),
        LinkInputResolution::Empty | LinkInputResolution::Error(_) => None,
    };
    let error_text = submit_error.map(str::to_owned).or_else(|| {
        if !dirty {
            return None;
        }
        match resolution {
            LinkInputResolution::Empty => {
                Some("Paste a pull request URL or enter 123 / #123.".to_owned())
            }
            LinkInputResolution::Error(err) => Some(err.clone()),
            LinkInputResolution::Resolved(_) => None,
        }
    });

    let on_cancel_backdrop = Rc::clone(&on_cancel);
    let on_cancel_btn = Rc::clone(&on_cancel);
    let primary_bg = to_hsla(tokens.primary);
    let primary_fg = to_hsla(tokens.primary_foreground);
    let primary_hover = to_hsla(tokens.primary.with_alpha(0.90));

    let submit_btn = {
        let base = h_flex()
            .id("linked-items-dialog-submit")
            .h(px(OUTLINE_BTN_HEIGHT_PX))
            .px(px(10.0))
            .items_center()
            .justify_center()
            .rounded(px(CONTROL_RADIUS_PX))
            .bg(primary_bg)
            .text_size(px(SM_TEXT_PX))
            .line_height(px(SM_LINE_HEIGHT_PX))
            .font_weight(FontWeight::MEDIUM)
            .text_color(primary_fg)
            .child(if pending { "Linking..." } else { "Link" });
        if can_submit {
            base.cursor_pointer()
                .hover(move |s| s.bg(primary_hover))
                .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                    cx.stop_propagation();
                    on_submit(window, cx);
                })
        } else {
            base.opacity(0.64)
        }
    };

    let dialog_card = v_flex()
        .id("linked-items-dialog-card")
        .w(px(360.0))
        .max_w(gpui_kit::relative(0.92))
        .rounded(px(12.0))
        .bg(to_hsla(tokens.popover))
        .border_1()
        .border_color(border)
        .shadow(vec![shadow])
        .p(px(16.0))
        .gap(px(12.0))
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .child(
            v_flex()
                .gap(px(4.0))
                .child(
                    div()
                        .text_size(px(16.0))
                        .line_height(px(22.0))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(fg)
                        .child("Link pull request"),
                )
                .child(
                    div()
                        .text_size(px(UI_TEXT_PX))
                        .line_height(px(UI_LINE_HEIGHT_PX))
                        .text_color(muted)
                        .child("Attach a pull request to this thread by its URL, or by its number for this thread's repository."),
                ),
        )
        .child(
            v_flex()
                .gap(px(6.0))
                .child(
                    div()
                        .w_full()
                        .h(px(32.0))
                        .px(px(10.0))
                        .rounded(px(6.0))
                        .bg(to_hsla(tokens.shell_field))
                        .border_1()
                        .border_color(to_hsla(tokens.input))
                        .flex()
                        .items_center()
                        .child(
                            div().flex_1().min_w_0().child(
                                Input::new(input)
                                    .appearance(false)
                                    .text_size(px(UI_TEXT_PX)),
                            ),
                        ),
                )
                .when_some(preview, |col, text| {
                    col.child(
                        div()
                            .truncate()
                            .text_size(px(XS_TEXT_PX))
                            .line_height(px(XS_LINE_HEIGHT_PX))
                            .text_color(muted)
                            .child(text),
                    )
                })
                .when_some(error_text, |col, text| {
                    col.child(
                        div()
                            .text_size(px(XS_TEXT_PX))
                            .line_height(px(XS_LINE_HEIGHT_PX))
                            .text_color(destructive)
                            .child(text),
                    )
                }),
        )
        .child(
            h_flex()
                .w_full()
                .justify_end()
                .gap(px(8.0))
                .child(outline_button(
                    "linked-items-dialog-cancel",
                    None,
                    "Cancel",
                    tokens,
                    pending,
                    move |window, cx| on_cancel_btn(window, cx),
                ))
                .child(submit_btn),
        );

    deferred(
        div()
            .id("linked-items-dialog-backdrop")
            .absolute()
            .inset_0()
            .bg(backdrop)
            .flex()
            .items_center()
            .justify_center()
            .p(px(16.0))
            .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                cx.stop_propagation();
                if !pending {
                    on_cancel_backdrop(window, cx);
                }
            })
            .child(dialog_card),
    )
    .with_priority(3)
    .into_any_element()
}

/// Circular remote avatar with initial fallback (`PullRequestActorAvatar`).
fn render_actor_avatar(
    tokens: &Tokens,
    actor: Option<&conn_contract::IssueActor>,
    size_px: f32,
) -> AnyElement {
    chrome::actor_avatar(tokens, actor, size_px, None, false)
}

/// Conn's `Button size="sm" variant="outline"` (`button.tsx`: `sm:h-7 gap-1.5 px-2.5 text-sm`).
fn outline_button(
    id: &'static str,
    icon_path: Option<&'static str>,
    label: &'static str,
    tokens: &Tokens,
    disabled: bool,
    on_press: impl Fn(&mut Window, &mut App) + 'static,
) -> AnyElement {
    let fg = to_hsla(tokens.foreground);
    let muted = to_hsla(tokens.muted_foreground);
    let (bg, hover_bg) = match tokens.appearance {
        Appearance::Dark => (
            to_hsla(tokens.input.with_alpha(0.32)),
            to_hsla(tokens.input.with_alpha(0.64)),
        ),
        Appearance::Light => (
            to_hsla(tokens.popover),
            to_hsla(tokens.accent.with_alpha(0.50)),
        ),
    };
    let mut btn = h_flex()
        .id(id)
        .flex_shrink_0()
        .h(px(OUTLINE_BTN_HEIGHT_PX))
        .px(px(9.0))
        .gap(px(6.0))
        .items_center()
        .justify_center()
        .rounded(px(CONTROL_RADIUS_PX))
        .border_1()
        .border_color(to_hsla(tokens.input))
        .bg(bg)
        .text_size(px(SM_TEXT_PX))
        .line_height(px(SM_LINE_HEIGHT_PX))
        .font_weight(FontWeight::MEDIUM)
        .text_color(fg);
    if let Some(path) = icon_path {
        btn = btn.child(superhero_icon(path, 14.0, muted));
    }
    btn = btn.child(label);
    if disabled {
        btn.opacity(0.64).into_any_element()
    } else {
        btn.cursor_pointer()
            .hover(move |s| s.bg(hover_bg))
            .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                cx.stop_propagation();
                on_press(window, cx);
            })
            .into_any_element()
    }
}

/// Renders the `pullRequests.changeBreakdown` popover anchored under a PR row's `+A -D` stat.
fn render_change_breakdown_popover(
    tokens: &Tokens,
    state: Option<&ChangeBreakdownState>,
) -> AnyElement {
    let fg = to_hsla(tokens.popover_foreground);
    let muted = to_hsla(tokens.muted_foreground);
    let added = to_hsla(tokens.diff_added);
    let removed = to_hsla(tokens.diff_removed);
    let mono: SharedString = MONO_FONT.into();

    let mut box_el = v_flex()
        .id("linked-pr-change-breakdown")
        .absolute()
        .top_full()
        .right_0()
        .mt(px(4.0))
        .w(px(208.0))
        .rounded(px(8.0))
        .bg(to_hsla(tokens.popover))
        .border_1()
        .border_color(to_hsla(tokens.shell_inner_border))
        .shadow_md()
        .p(px(10.0))
        .gap(px(6.0))
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .child(
            div()
                .text_size(px(XS_TEXT_PX))
                .line_height(px(XS_LINE_HEIGHT_PX))
                .font_weight(FontWeight::MEDIUM)
                .text_color(fg)
                .child("Change breakdown"),
        );

    match state {
        None | Some(ChangeBreakdownState::Loading) => {
            box_el = box_el.child(
                div()
                    .text_size(px(XS_TEXT_PX))
                    .line_height(px(XS_LINE_HEIGHT_PX))
                    .text_color(muted)
                    .child("Loading breakdown…"),
            );
        }
        Some(ChangeBreakdownState::Error(err)) => {
            box_el = box_el.child(
                div()
                    .text_size(px(XS_TEXT_PX))
                    .line_height(px(XS_LINE_HEIGHT_PX))
                    .text_color(to_hsla(tokens.destructive))
                    .child(err.clone()),
            );
        }
        Some(ChangeBreakdownState::Ready(None)) => {
            box_el = box_el.child(
                div()
                    .text_size(px(XS_TEXT_PX))
                    .line_height(px(XS_LINE_HEIGHT_PX))
                    .text_color(muted)
                    .child("Breakdown unavailable for this pull request."),
            );
        }
        Some(ChangeBreakdownState::Ready(Some(data))) => {
            let categories: Vec<(&str, i64, i64)> = [
                ("Code", data.code.additions, data.code.deletions),
                ("Tests", data.tests.additions, data.tests.deletions),
                ("Mocks", data.mocks.additions, data.mocks.deletions),
                (
                    "Generated",
                    data.generated.additions,
                    data.generated.deletions,
                ),
            ]
            .into_iter()
            .chain(
                data.docs
                    .as_ref()
                    .map(|d| ("Docs", d.additions, d.deletions)),
            )
            .filter(|&(_, a, d)| a > 0 || d > 0)
            .collect();

            if categories.is_empty() {
                box_el = box_el.child(
                    div()
                        .text_size(px(XS_TEXT_PX))
                        .line_height(px(XS_LINE_HEIGHT_PX))
                        .text_color(muted)
                        .child("No categorized line changes."),
                );
            } else {
                for (label, add, del) in categories {
                    box_el = box_el.child(
                        h_flex()
                            .w_full()
                            .items_center()
                            .justify_between()
                            .gap(px(8.0))
                            .text_size(px(XS_TEXT_PX))
                            .line_height(px(XS_LINE_HEIGHT_PX))
                            .child(div().text_color(muted).child(label))
                            .child(
                                h_flex()
                                    .gap(px(6.0))
                                    .font_family(mono.clone())
                                    .child(
                                        div()
                                            .text_color(added)
                                            .child(format!("+{}", format_diff_count(add))),
                                    )
                                    .child(
                                        div()
                                            .text_color(removed)
                                            .child(format!("-{}", format_diff_count(del))),
                                    ),
                            ),
                    );
                }
            }
        }
    }

    deferred(box_el).with_priority(4).into_any_element()
}
