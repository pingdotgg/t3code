//! The Task detail view: breadcrumb header, key-value metadata, line tabs (Brief, Subtasks,
//! Agents), Markdown brief renderer, subtask rows, and agent rows.
//!
//! Port of `apps/web/src/orbit/tasks/TaskDetail.tsx`.

use crate::a11y::ConnA11yExt as _;
use std::rc::Rc;

use conn_desktop::orbit::board::tasks_error_notice;
use conn_desktop::orbit::client::TasksError;
use conn_desktop::orbit::detail::{
    AgentRow, AgentsModel, StatusTone, SubtaskLead, agent_state_text, agent_state_tone, agents_for,
    orbit_agent_driver_kind, subtask_lead, subtask_status_text, task_usage,
};
use conn_desktop::orbit::format::{format_duration, format_tokens};
use conn_desktop::orbit::panel::{TasksDetailTab, TasksNavigation};
use conn_desktop::orbit::realtime::TasksLiveStatus;
use conn_desktop::orbit::tasks::{
    AgentState, AttentionKind, PullRequestState, Subtask, TaskAgent, TaskDetail, TaskEnvironment,
    TaskMetrics,
};
use conn_theme::Tokens;
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::*;
use gpui_kit::{
    AnyElement, App, FontWeight, Hsla, MouseButton, ScrollHandle, SharedString, Window, div, px,
};

use super::board::pull_request_presentation;
use super::format::{format_diff_count, live_status_label};
use crate::chat::markdown::{HeadingStyle, MarkdownOptions, render_markdown};
use crate::icons::provider_mark;
use crate::panels::chrome::{self, ConnTooltipExt as _, UI_LINE_HEIGHT_PX, UI_TEXT_PX};
use crate::panels::color::to_hsla;
use crate::panels::header::superhero_icon;

const DETAIL_PAD_X_PX: f32 = 18.0;
const NAV_HEIGHT_PX: f32 = 36.0;
const TABS_HEIGHT_PX: f32 = 48.0;
const META_LABEL_WIDTH_PX: f32 = 120.0;
const SM_TEXT_PX: f32 = 14.0;
const SM_LINE_HEIGHT_PX: f32 = 20.0;
const DASH: &str = "\u{2013}";

/// Loaded state for the open task detail.
#[derive(Clone, Debug)]
pub(super) enum DetailLoadState {
    Loading,
    Ready(Box<TaskDetail>),
    Error(TasksError),
}

/// Callbacks wired from the task detail view back into `TasksPanel`.
pub(super) struct DetailCallbacks {
    pub(super) on_show_board: Rc<dyn Fn(&mut Window, &mut App)>,
    pub(super) on_open_subtask:
        Rc<dyn Fn(Option<i64>, Option<TasksDetailTab>, &mut Window, &mut App)>,
    pub(super) on_set_tab: Rc<dyn Fn(TasksDetailTab, &mut Window, &mut App)>,
    pub(super) on_retry: Rc<dyn Fn(&mut Window, &mut App)>,
    pub(super) on_open_pr: Rc<dyn Fn(i64, String, &mut Window, &mut App)>,
    pub(super) on_open_agent: Rc<dyn Fn(String, String, &mut Window, &mut App)>,
}

/// Renders the entire Task detail surface (breadcrumb nav + loading/error/content body).
#[expect(
    clippy::too_many_arguments,
    reason = "renders the detail screen from borrowed panel state"
)]
pub(super) fn render_task_detail(
    tokens: &Tokens,
    navigation: &TasksNavigation,
    live_status: TasksLiveStatus,
    state: &DetailLoadState,
    list_title: Option<&str>,
    notice: Option<&str>,
    scroll: &ScrollHandle,
    callbacks: DetailCallbacks,
) -> AnyElement {
    let fg = to_hsla(tokens.foreground);
    let muted = to_hsla(tokens.muted_foreground);
    let divider = to_hsla(tokens.shell_divider);

    let title = match state {
        DetailLoadState::Ready(task) => Some(task.summary.title.as_str()),
        _ => list_title,
    };
    let subtask_title = match (state, navigation.subtask_id) {
        (DetailLoadState::Ready(task), Some(sub_id)) => task
            .subtasks
            .iter()
            .find(|s| s.id == sub_id)
            .map(|s| s.title.as_str()),
        _ => None,
    };

    let on_board = Rc::clone(&callbacks.on_show_board);
    let mut nav = h_flex()
        .w_full()
        .h(px(NAV_HEIGHT_PX))
        .flex_shrink_0()
        .items_center()
        .gap(px(8.0))
        .px(px(DETAIL_PAD_X_PX))
        .border_b_1()
        .border_color(divider)
        .text_size(px(UI_TEXT_PX))
        .line_height(px(UI_LINE_HEIGHT_PX))
        .child(
            h_flex()
                .id("tasks-detail-back")
                .a11y_button("panel.tasks-detail-back", "Tasks")
                .flex_shrink_0()
                .items_center()
                .gap(px(4.0))
                .rounded(px(4.0))
                .cursor_pointer()
                .text_color(muted)
                .hover(move |s| s.text_color(fg))
                .on_click(move |_, window, cx| on_board(window, cx))
                .child(superhero_icon("superhero/chevron-left.svg", 16.0, muted))
                .child("Tasks"),
        );

    if let Some(title) = title {
        nav = nav.child(div().text_color(muted.opacity(0.60)).child("/"));
        if let Some(sub_title) = subtask_title {
            let on_up = Rc::clone(&callbacks.on_open_subtask);
            nav = nav
                .child(
                    div()
                        .id("tasks-detail-crumb-task")
                        .a11y_button("panel.tasks-detail-crumb-task", "Task")
                        .max_w(gpui_kit::relative(0.45))
                        .min_w_0()
                        .flex_shrink(1.0)
                        .truncate()
                        .cursor_pointer()
                        .text_color(muted)
                        .hover(move |s| s.text_color(fg))
                        .on_click(move |_, window, cx| on_up(None, None, window, cx))
                        .child(title.to_owned()),
                )
                .child(div().text_color(muted.opacity(0.60)).child("/"))
                .child(
                    div()
                        .min_w_0()
                        .truncate()
                        .text_color(fg.opacity(0.85))
                        .child(sub_title.to_owned()),
                );
        } else {
            nav = nav.child(
                div()
                    .min_w_0()
                    .truncate()
                    .text_color(fg.opacity(0.85))
                    .child(title.to_owned()),
            );
        }
    }

    nav = nav.child(
        div()
            .ml_auto()
            .flex_shrink_0()
            .text_color(muted.opacity(0.70))
            .child(live_status_label(live_status)),
    );

    let body: AnyElement = match state {
        DetailLoadState::Loading => div()
            .flex_1()
            .min_h_0()
            .w_full()
            .flex()
            .items_center()
            .justify_center()
            .child(superhero_icon("superhero/spinner.svg", 18.0, muted))
            .into_any_element(),
        DetailLoadState::Error(error) => {
            let notice_info = tasks_error_notice(error.reason);
            let on_retry = Rc::clone(&callbacks.on_retry);
            let hover = to_hsla(tokens.shell_highlight);
            v_flex()
                .flex_1()
                .min_h_0()
                .w_full()
                .items_center()
                .justify_center()
                .gap(px(12.0))
                .p(px(24.0))
                .child(superhero_icon("superhero/unplug.svg", 20.0, muted))
                .child(
                    v_flex()
                        .items_center()
                        .gap(px(4.0))
                        .child(
                            div()
                                .text_size(px(UI_TEXT_PX))
                                .line_height(px(UI_LINE_HEIGHT_PX))
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(fg)
                                .child(notice_info.title),
                        )
                        .child(
                            div()
                                .text_size(px(UI_TEXT_PX))
                                .line_height(px(UI_LINE_HEIGHT_PX))
                                .text_color(muted)
                                .child(error.message.clone()),
                        ),
                )
                .child(
                    div()
                        .id("tasks-detail-retry")
                        .a11y_button("panel.tasks-detail-retry", "Retry")
                        .h(px(28.0))
                        .px(px(12.0))
                        .flex()
                        .items_center()
                        .justify_center()
                        .rounded(px(6.0))
                        .border_1()
                        .border_color(to_hsla(tokens.shell_divider_header))
                        .bg(to_hsla(tokens.shell_control))
                        .cursor_pointer()
                        .text_size(px(UI_TEXT_PX))
                        .line_height(px(UI_LINE_HEIGHT_PX))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(fg)
                        .hover(move |s| s.bg(hover))
                        .on_click(move |_, window, cx| on_retry(window, cx))
                        .child("Retry"),
                )
                .into_any_element()
        }
        DetailLoadState::Ready(task) => {
            render_detail_body(tokens, navigation, task, scroll, &callbacks)
        }
    };

    v_flex()
        .flex_1()
        .min_h_0()
        .w_full()
        .child(nav)
        .when_some(notice, |col, msg| {
            col.child(chrome::warning_notice(tokens, msg.to_owned()))
        })
        .child(body)
        .into_any_element()
}

fn render_detail_body(
    tokens: &Tokens,
    navigation: &TasksNavigation,
    task: &TaskDetail,
    scroll: &ScrollHandle,
    callbacks: &DetailCallbacks,
) -> AnyElement {
    let fg = to_hsla(tokens.foreground);
    let divider = to_hsla(tokens.shell_divider);
    let subtask = navigation
        .subtask_id
        .and_then(|id| task.subtasks.iter().find(|s| s.id == id));
    let tab = if subtask.is_some() && navigation.tab == TasksDetailTab::Subtasks {
        TasksDetailTab::Brief
    } else {
        navigation.tab
    };
    let agents = agents_for(task, subtask.map(|s| s.id));
    let agents_count = agents.current.len() + agents.earlier.len();

    let title_text = subtask
        .map(|s| s.title.as_str())
        .unwrap_or(task.summary.title.as_str());

    let title_block = div()
        .w_full()
        .px(px(DETAIL_PAD_X_PX))
        .py(px(16.0))
        .when(subtask.is_none(), |el| {
            el.border_b_1().border_color(divider)
        })
        .child(
            div()
                .text_size(px(18.0))
                .line_height(px(24.0))
                .font_weight(FontWeight::MEDIUM)
                .text_color(fg)
                .child(title_text.to_owned()),
        );

    let key_values = subtask.is_none().then(|| {
        div()
            .w_full()
            .px(px(DETAIL_PAD_X_PX))
            .py(px(16.0))
            .child(render_key_values(tokens, task, callbacks))
    });

    let tabs = render_task_tabs(
        tokens,
        task,
        subtask.is_some(),
        tab,
        agents_count,
        callbacks,
    );

    let tab_body: AnyElement = match tab {
        TasksDetailTab::Agents => render_agents_list(tokens, &agents, callbacks),
        TasksDetailTab::Subtasks if subtask.is_none() => {
            render_subtasks_list(tokens, task, callbacks)
        }
        _ => render_brief(tokens, task, subtask),
    };

    div()
        .id("tasks-detail-scroll")
        .flex_1()
        .min_h_0()
        .w_full()
        .overflow_y_scroll()
        .track_scroll(scroll)
        .pb(px(32.0))
        .child(
            v_flex()
                .w_full()
                .child(title_block)
                .when_some(key_values, |col, kv| col.child(kv))
                .child(tabs)
                .child(
                    div()
                        .w_full()
                        .px(px(DETAIL_PAD_X_PX))
                        .pt(px(18.0))
                        .child(tab_body),
                ),
        )
        .into_any_element()
}

fn render_meta_row(
    tokens: &Tokens,
    icon_path: &'static str,
    label: &'static str,
    value: AnyElement,
) -> AnyElement {
    let muted = to_hsla(tokens.muted_foreground);
    h_flex()
        .w_full()
        .min_h(px(28.0))
        .items_center()
        .gap(px(8.0))
        .text_size(px(SM_TEXT_PX))
        .line_height(px(SM_LINE_HEIGHT_PX))
        .child(
            h_flex()
                .w(px(META_LABEL_WIDTH_PX))
                .flex_shrink_0()
                .items_center()
                .gap(px(6.0))
                .text_color(muted)
                .child(superhero_icon(icon_path, 14.0, muted))
                .child(label),
        )
        .child(
            h_flex()
                .min_w_0()
                .flex_1()
                .items_center()
                .gap(px(6.0))
                .text_color(to_hsla(tokens.foreground))
                .child(value),
        )
        .into_any_element()
}

fn render_key_values(
    tokens: &Tokens,
    task: &TaskDetail,
    callbacks: &DetailCallbacks,
) -> AnyElement {
    let muted = to_hsla(tokens.muted_foreground);
    let destructive_fg = to_hsla(tokens.destructive_foreground);
    let environment = task.summary.environment();
    let usage = task_usage(&task.metrics);

    let env_state = match environment {
        TaskEnvironment::Disposed => Some(("removed", true)),
        TaskEnvironment::Stopped => Some(("asleep", false)),
        TaskEnvironment::Unreachable => Some(("offline", true)),
        TaskEnvironment::NotStarted | TaskEnvironment::Ready { .. } => None,
    };

    let workspace_value: AnyElement = if let Some(ws) = &task.summary.workspace {
        let machine = ws.node.as_ref().map(|n| format!("on {}", n.name));
        let mut suffix_parts = Vec::new();
        if let Some(m) = machine {
            suffix_parts.push(m);
        }
        if let Some((state_text, _)) = env_state {
            suffix_parts.push(state_text.to_owned());
        }
        let suffix_color = if env_state.is_some_and(|(_, bad)| bad) {
            destructive_fg
        } else {
            muted
        };
        h_flex()
            .min_w_0()
            .items_center()
            .gap(px(6.0))
            .child(div().min_w_0().truncate().child(ws.name.clone()))
            .when(!suffix_parts.is_empty(), |row| {
                row.child(
                    div()
                        .flex_shrink_0()
                        .text_color(suffix_color)
                        .child(suffix_parts.join(" \u{00b7} ")),
                )
            })
            .into_any_element()
    } else {
        let text = if environment == TaskEnvironment::NotStarted {
            "No workspace yet"
        } else {
            "Removed"
        };
        div().text_color(muted).child(text).into_any_element()
    };

    let mut rows = v_flex().w_full().gap(px(8.0)).child(render_meta_row(
        tokens,
        "superhero/server.svg",
        "Workspace",
        workspace_value,
    ));

    if let Some(branch) = task
        .summary
        .workspace
        .as_ref()
        .and_then(|ws| ws.branch.as_ref())
    {
        rows = rows.child(render_meta_row(
            tokens,
            "superhero/branch.svg",
            "Branch",
            div()
                .min_w_0()
                .truncate()
                .text_color(muted)
                .child(branch.clone())
                .into_any_element(),
        ));
    }

    if let Some(pr) = &task.summary.pull_request {
        let (icon_path, color) = pull_request_presentation(pr.state, tokens);
        let state_label = match pr.state {
            Some(PullRequestState::Open) => "Open",
            Some(PullRequestState::Merged) => "Merged",
            Some(PullRequestState::Closed) => "Closed",
            None => "Pull request",
        };
        let url = pr.url.clone();
        let task_id = task.summary.id;
        let on_pr = Rc::clone(&callbacks.on_open_pr);
        rows = rows.child(render_meta_row(
            tokens,
            "superhero/pull-request.svg",
            "Pull request",
            h_flex()
                .id("tasks-detail-pr-link")
                .a11y_button("panel.tasks-detail-pr-link", "Linked pull request")
                .min_w_0()
                .items_center()
                .gap(px(6.0))
                .cursor_pointer()
                .on_click(move |_, window, cx| on_pr(task_id, url.clone(), window, cx))
                .child(superhero_icon(icon_path, 14.0, color))
                .child(div().min_w_0().truncate().child(state_label))
                .child(
                    div()
                        .flex_shrink_0()
                        .text_color(muted)
                        .child(format!("#{}", pr.number)),
                )
                .into_any_element(),
        ));
    }

    rows = rows.child(render_meta_row(
        tokens,
        "superhero/usage.svg",
        "Usage",
        div()
            .id("tasks-detail-usage")
            .min_w_0()
            .truncate()
            .conn_tooltip(usage.description, tokens)
            .child(usage.text)
            .into_any_element(),
    ));

    let changes_value: AnyElement = match usage.lines {
        None => div()
            .text_color(muted)
            .child("Not reported yet")
            .into_any_element(),
        Some((a, d)) if a == 0.0 && d == 0.0 => div()
            .text_color(muted)
            .child("No changes")
            .into_any_element(),
        Some((a, d)) => render_diff_stat(tokens, a, d),
    };
    rows = rows.child(render_meta_row(
        tokens,
        "superhero/file-diff.svg",
        "Changes",
        changes_value,
    ));

    rows.into_any_element()
}

fn render_diff_stat(tokens: &Tokens, additions: f64, deletions: f64) -> AnyElement {
    h_flex()
        .flex_shrink_0()
        .items_baseline()
        .gap(px(4.0))
        .child(
            div()
                .text_color(to_hsla(tokens.diff_added))
                .child(format!("+{}", format_diff_count(additions))),
        )
        .child(
            div()
                .text_color(to_hsla(tokens.diff_removed))
                .child(format!("-{}", format_diff_count(deletions))),
        )
        .into_any_element()
}

fn render_task_tabs(
    tokens: &Tokens,
    task: &TaskDetail,
    is_subtask: bool,
    active: TasksDetailTab,
    agents_count: usize,
    callbacks: &DetailCallbacks,
) -> AnyElement {
    let fg = to_hsla(tokens.foreground);
    let muted = to_hsla(tokens.muted_foreground);
    let divider = to_hsla(tokens.shell_divider);
    let done = task
        .subtasks
        .iter()
        .filter(|s| s.status == conn_desktop::orbit::tasks::SubtaskStatus::Completed)
        .count();

    let make_tab = |tab: TasksDetailTab, label: &'static str, count: Option<String>| {
        let selected = tab == active;
        let on_select = Rc::clone(&callbacks.on_set_tab);
        h_flex()
            .id(SharedString::from(format!("tasks-detail-tab-{tab:?}")))
            .a11y_tab(format!("panel.tasks.detail.tab.{tab:?}"), label, selected)
            .relative()
            .h(px(TABS_HEIGHT_PX))
            .px(px(2.0))
            .items_center()
            .gap(px(6.0))
            .cursor_pointer()
            .text_size(px(SM_TEXT_PX))
            .line_height(px(SM_LINE_HEIGHT_PX))
            .font_weight(FontWeight::MEDIUM)
            .text_color(if selected { fg } else { muted })
            .when(!selected, |el| {
                el.hover(move |s| s.text_color(fg.opacity(0.85)))
            })
            .on_click(move |_, window, cx| on_select(tab, window, cx))
            .child(label)
            .when_some(count, |el, c| {
                el.child(
                    div()
                        .font_weight(FontWeight::NORMAL)
                        .text_color(muted)
                        .child(c),
                )
            })
            .when(selected, |el| {
                el.child(
                    div()
                        .absolute()
                        .left_0()
                        .right_0()
                        .bottom(px(-1.0))
                        .h(px(2.0))
                        .bg(fg.opacity(0.80)),
                )
            })
    };

    h_flex()
        .w_full()
        .flex_shrink_0()
        .items_center()
        .gap(px(20.0))
        .px(px(DETAIL_PAD_X_PX))
        .border_b_1()
        .when(!is_subtask, |el| el.border_t_1())
        .border_color(divider)
        .child(make_tab(TasksDetailTab::Brief, "Brief", None))
        .when(!is_subtask, |row| {
            row.child(make_tab(
                TasksDetailTab::Subtasks,
                "Subtasks",
                Some(format!("{done}/{}", task.subtasks.len())),
            ))
        })
        .child(make_tab(
            TasksDetailTab::Agents,
            "Agents",
            Some(agents_count.to_string()),
        ))
        .into_any_element()
}

fn render_brief(tokens: &Tokens, task: &TaskDetail, subtask: Option<&Subtask>) -> AnyElement {
    let fg = to_hsla(tokens.foreground);
    let muted = to_hsla(tokens.muted_foreground);

    let attention = subtask
        .and_then(|s| s.attention.as_ref())
        .or(task.summary.attention.as_ref());
    let attention_banner = attention
        .filter(|a| a.kind != AttentionKind::Observation)
        .and_then(|a| {
            let text = a.question.as_deref().or(a.reason.as_deref())?;
            let is_warn = matches!(a.kind, AttentionKind::Question | AttentionKind::Direction);
            let (bg, color) = if is_warn {
                (
                    to_hsla(tokens.warning.with_alpha(0.10)),
                    to_hsla(tokens.warning_foreground),
                )
            } else {
                (
                    to_hsla(tokens.destructive.with_alpha(0.10)),
                    to_hsla(tokens.destructive_foreground),
                )
            };
            Some(
                div()
                    .w_full()
                    .rounded(px(8.0))
                    .bg(bg)
                    .px(px(12.0))
                    .py(px(8.0))
                    .text_size(px(UI_TEXT_PX))
                    .line_height(px(UI_LINE_HEIGHT_PX))
                    .text_color(color)
                    .child(text.to_owned()),
            )
        });

    let brief_src = subtask
        .map(|s| s.brief.as_str())
        .unwrap_or(task.brief.as_str());
    let brief_id = match subtask {
        Some(sub) => format!("task-{}-subtask-{}", task.summary.id, sub.id),
        None => format!("task-{}-brief", task.summary.id),
    };
    let brief_body: AnyElement = if brief_src.trim().is_empty() {
        div()
            .text_size(px(UI_TEXT_PX))
            .line_height(px(UI_LINE_HEIGHT_PX))
            .text_color(muted)
            .child("No brief.")
            .into_any_element()
    } else {
        // Conn `TaskDetail.tsx:507`: headings inside a task brief stay at body size (`14px` medium).
        let options = MarkdownOptions {
            heading_style: HeadingStyle::BodySize,
            ..MarkdownOptions::default()
        };
        div()
            .w_full()
            .min_w_0()
            .when(subtask.is_some(), |el| el.mt(px(10.0)))
            .child(render_markdown(&brief_id, brief_src, tokens, &options))
            .into_any_element()
    };

    let deliverables = subtask.filter(|s| !s.deliverables.is_empty()).map(|s| {
        let mut list = v_flex().gap(px(4.0)).pl(px(16.0));
        for item in &s.deliverables {
            list = list.child(
                h_flex()
                    .items_start()
                    .gap(px(8.0))
                    .text_size(px(SM_TEXT_PX))
                    .line_height(px(SM_LINE_HEIGHT_PX))
                    .text_color(fg.opacity(0.85))
                    .child(div().text_color(muted).child("\u{2022}"))
                    .child(div().min_w_0().flex_1().child(item.description.clone())),
            );
        }
        v_flex()
            .gap(px(12.0))
            .child(
                div()
                    .text_size(px(16.0))
                    .line_height(px(24.0))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(fg)
                    .child("Deliverables"),
            )
            .child(list)
    });

    v_flex()
        .w_full()
        .gap(px(20.0))
        .when_some(subtask, |col, sub| {
            col.child(render_subtask_summary_rows(tokens, task, sub))
        })
        .when_some(attention_banner, |col, banner| col.child(banner))
        .child(brief_body)
        .when_some(deliverables, |col, deliv| col.child(deliv))
        .into_any_element()
}

fn render_subtask_summary_rows(
    tokens: &Tokens,
    task: &TaskDetail,
    subtask: &Subtask,
) -> AnyElement {
    let fg = to_hsla(tokens.foreground);
    let muted = to_hsla(tokens.muted_foreground);
    let lead = subtask_lead(task, subtask);

    v_flex()
        .w_full()
        .gap(px(4.0))
        .child(
            h_flex()
                .w_full()
                .min_h(px(28.0))
                .items_center()
                .gap(px(8.0))
                .text_size(px(UI_TEXT_PX))
                .line_height(px(UI_LINE_HEIGHT_PX))
                .child(render_subtask_lead_icon(tokens, lead))
                .child(
                    div()
                        .min_w_0()
                        .flex_1()
                        .truncate()
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(fg.opacity(0.90))
                        .child(subtask_status_text(subtask, task)),
                )
                .child(div().flex_shrink_0().text_color(muted).child(format!(
                    "{} of {}",
                    subtask.position,
                    task.subtasks.len()
                ))),
        )
        .child(
            h_flex()
                .w_full()
                .min_h(px(28.0))
                .items_center()
                .gap(px(8.0))
                .text_size(px(UI_TEXT_PX))
                .line_height(px(UI_LINE_HEIGHT_PX))
                .text_color(muted)
                .child(superhero_icon("superhero/usage.svg", 14.0, muted))
                .child(
                    div()
                        .min_w_0()
                        .flex_1()
                        .truncate()
                        .child(subtask_meta_text(&subtask.metrics)),
                )
                .child(render_subtask_diff(tokens, &subtask.metrics)),
        )
        .into_any_element()
}

fn render_subtasks_list(
    tokens: &Tokens,
    task: &TaskDetail,
    callbacks: &DetailCallbacks,
) -> AnyElement {
    let muted = to_hsla(tokens.muted_foreground);
    if task.subtasks.is_empty() {
        return div()
            .text_size(px(UI_TEXT_PX))
            .line_height(px(UI_LINE_HEIGHT_PX))
            .text_color(muted)
            .child("No subtasks yet.")
            .into_any_element();
    }
    let mut list = v_flex().mx(px(-10.0)).mt(px(-9.0)).gap(px(2.0));
    for subtask in &task.subtasks {
        list = list.child(render_subtask_row(tokens, task, subtask, callbacks));
    }
    list.into_any_element()
}

fn render_subtask_row(
    tokens: &Tokens,
    task: &TaskDetail,
    subtask: &Subtask,
    callbacks: &DetailCallbacks,
) -> AnyElement {
    let fg = to_hsla(tokens.foreground);
    let muted = to_hsla(tokens.muted_foreground);
    let highlight = to_hsla(tokens.shell_highlight);
    let lead = subtask_lead(task, subtask);
    let not_started = matches!(lead, SubtaskLead::NotStarted);
    let sub_id = subtask.id;

    let lead_el: AnyElement = match lead {
        SubtaskLead::Agent { .. } => {
            let on_agents = Rc::clone(&callbacks.on_open_subtask);
            div()
                .id(SharedString::from(format!("tasks-subtask-agent-{sub_id}")))
                .ml(px(9.0))
                .mt(px(6.0))
                .size(px(20.0))
                .flex_shrink_0()
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(6.0))
                .cursor_pointer()
                .hover(move |s| s.bg(highlight))
                .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                    cx.stop_propagation();
                    on_agents(Some(sub_id), Some(TasksDetailTab::Agents), window, cx);
                })
                .child(render_subtask_lead_icon(tokens, lead))
                .into_any_element()
        }
        _ => div()
            .ml(px(9.0))
            .mt(px(6.0))
            .size(px(20.0))
            .flex_shrink_0()
            .flex()
            .items_center()
            .justify_center()
            .child(render_subtask_lead_icon(tokens, lead))
            .into_any_element(),
    };

    let on_open = Rc::clone(&callbacks.on_open_subtask);
    h_flex()
        .id(SharedString::from(format!("tasks-subtask-row-{sub_id}")))
        .a11y_button(
            format!("panel.tasks.subtask.{sub_id}"),
            subtask.title.clone(),
        )
        .w_full()
        .items_start()
        .rounded(px(8.0))
        .cursor_pointer()
        .hover(move |s| s.bg(highlight))
        .on_click(move |_, window, cx| on_open(Some(sub_id), None, window, cx))
        .child(lead_el)
        .child(
            v_flex()
                .min_w_0()
                .flex_1()
                .py(px(6.0))
                .pl(px(8.0))
                .pr(px(10.0))
                .text_size(px(UI_TEXT_PX))
                .child(
                    h_flex()
                        .w_full()
                        .items_start()
                        .gap(px(8.0))
                        .child(
                            div()
                                .min_w_0()
                                .flex_1()
                                .line_height(px(UI_LINE_HEIGHT_PX))
                                .text_color(if not_started { muted } else { fg.opacity(0.85) })
                                .child(subtask.title.clone()),
                        )
                        .when(!not_started, |row| {
                            row.child(render_subtask_diff(tokens, &subtask.metrics))
                        }),
                )
                .when(!not_started, |col| {
                    col.child(
                        div()
                            .line_height(px(16.0))
                            .text_color(muted)
                            .child(subtask_meta_text(&subtask.metrics)),
                    )
                }),
        )
        .into_any_element()
}

fn subtask_meta_text(metrics: &TaskMetrics) -> String {
    let dur = metrics
        .duration_ms
        .map(format_duration)
        .unwrap_or_else(|| DASH.to_owned());
    let tok = metrics
        .tokens
        .map(|t| format!("{} tokens", format_tokens(t)))
        .unwrap_or_else(|| DASH.to_owned());
    format!("{dur} \u{00b7} {tok}")
}

fn render_subtask_diff(tokens: &Tokens, metrics: &TaskMetrics) -> AnyElement {
    let muted = to_hsla(tokens.muted_foreground);
    let inner: AnyElement = match (metrics.lines_added, metrics.lines_deleted) {
        (Some(a), Some(d)) if a == 0.0 && d == 0.0 => div()
            .text_color(muted)
            .child("No changes")
            .into_any_element(),
        (Some(a), Some(d)) => render_diff_stat(tokens, a, d),
        _ => div()
            .text_color(muted.opacity(0.50))
            .child(DASH)
            .into_any_element(),
    };
    div()
        .flex_shrink_0()
        .text_size(px(UI_TEXT_PX))
        .line_height(px(UI_LINE_HEIGHT_PX))
        .child(inner)
        .into_any_element()
}

fn render_subtask_lead_icon(tokens: &Tokens, lead: SubtaskLead<'_>) -> AnyElement {
    let muted = to_hsla(tokens.muted_foreground);
    match lead {
        SubtaskLead::Agent { agent, tone } => render_agent_icon(tokens, agent, tone),
        SubtaskLead::Done => superhero_icon("superhero/check.svg", 16.0, muted).into_any_element(),
        SubtaskLead::NotStarted => {
            superhero_icon("superhero/circle.svg", 16.0, muted.opacity(0.40)).into_any_element()
        }
        SubtaskLead::State { tone } => match tone {
            StatusTone::Success => {
                superhero_icon("superhero/check.svg", 16.0, muted).into_any_element()
            }
            StatusTone::Info => superhero_icon(
                "superhero/circle-dashed.svg",
                16.0,
                to_hsla(tokens.info_foreground),
            )
            .into_any_element(),
            StatusTone::Warning => superhero_icon(
                "superhero/error-circle.svg",
                16.0,
                to_hsla(tokens.warning_foreground),
            )
            .into_any_element(),
            StatusTone::Destructive => superhero_icon(
                "superhero/close.svg",
                16.0,
                to_hsla(tokens.destructive_foreground),
            )
            .into_any_element(),
            StatusTone::Muted => {
                superhero_icon("superhero/circle.svg", 16.0, muted).into_any_element()
            }
        },
    }
}

fn render_agents_list(
    tokens: &Tokens,
    agents: &AgentsModel<'_>,
    callbacks: &DetailCallbacks,
) -> AnyElement {
    let muted = to_hsla(tokens.muted_foreground);

    let current_el: AnyElement = if agents.current.is_empty() {
        div()
            .text_size(px(UI_TEXT_PX))
            .line_height(px(UI_LINE_HEIGHT_PX))
            .text_color(muted)
            .child("No agent has started.")
            .into_any_element()
    } else {
        let mut ul = v_flex().mx(px(-10.0)).gap(px(2.0));
        for row in &agents.current {
            ul = ul.child(render_agent_row(tokens, row, callbacks));
        }
        ul.into_any_element()
    };

    let earlier_el = (!agents.earlier.is_empty()).then(|| {
        let mut ul = v_flex().mx(px(-10.0)).gap(px(2.0));
        for row in &agents.earlier {
            ul = ul.child(render_agent_row(tokens, row, callbacks));
        }
        v_flex()
            .gap(px(8.0))
            .child(
                div()
                    .text_size(px(SM_TEXT_PX))
                    .line_height(px(SM_LINE_HEIGHT_PX))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(muted)
                    .child("Earlier attempts"),
            )
            .child(ul)
    });

    v_flex()
        .w_full()
        .mt(px(-10.0))
        .gap(px(24.0))
        .child(current_el)
        .when_some(earlier_el, |col, earlier| col.child(earlier))
        .into_any_element()
}

fn render_agent_row(
    tokens: &Tokens,
    row: &AgentRow<'_>,
    callbacks: &DetailCallbacks,
) -> AnyElement {
    let fg = to_hsla(tokens.foreground);
    let muted = to_hsla(tokens.muted_foreground);
    let highlight = to_hsla(tokens.shell_highlight);
    let tone = agent_state_tone(row.agent);

    let mut parts = row.label.split(" \u{00b7} ");
    let role = parts.next().unwrap_or(row.label.as_str());
    let rest: Vec<&str> = parts.collect();
    let mut detail_parts = Vec::new();
    if !rest.is_empty() {
        detail_parts.push(rest.join(" \u{00b7} "));
    }
    if let Some(model) = &row.agent.model {
        detail_parts.push(model.clone());
    }
    let detail = detail_parts.join(" \u{00b7} ");

    let mut el = h_flex()
        .id(SharedString::from(format!("tasks-agent-{}", row.agent.id)))
        .w_full()
        .min_h(px(32.0))
        .px(px(10.0))
        .py(px(6.0))
        .gap(px(8.0))
        .items_start()
        .rounded(px(8.0))
        .child(
            div()
                .mt(px(2.0))
                .child(render_agent_icon(tokens, row.agent, tone)),
        )
        .child(
            v_flex()
                .min_w_0()
                .flex_1()
                .child(
                    div()
                        .truncate()
                        .text_size(px(UI_TEXT_PX))
                        .line_height(px(UI_LINE_HEIGHT_PX))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(fg.opacity(0.85))
                        .child(role.to_owned()),
                )
                .when(!detail.is_empty(), |col| {
                    col.child(
                        div()
                            .truncate()
                            .text_size(px(UI_TEXT_PX))
                            .line_height(px(16.0))
                            .text_color(muted)
                            .child(detail),
                    )
                }),
        )
        .child(render_agent_state(tokens, row.agent));

    if let Some(conv) = row.conversation {
        let env_id = conv.environment_id.clone();
        let thread_id = conv.thread_id.clone();
        let on_agent = Rc::clone(&callbacks.on_open_agent);
        el = el
            .cursor_pointer()
            .hover(move |s| s.bg(highlight))
            .on_click(move |_, window, cx| {
                on_agent(env_id.clone(), thread_id.clone(), window, cx);
            });
    }

    el.into_any_element()
}

fn render_agent_icon(tokens: &Tokens, agent: &TaskAgent, tone: StatusTone) -> AnyElement {
    let muted = to_hsla(tokens.muted_foreground);
    let glyph = match orbit_agent_driver_kind(agent.provider.as_deref()) {
        Some(driver) => provider_mark(&driver, 14.0, muted),
        None => superhero_icon("superhero/agent.svg", 14.0, muted).into_any_element(),
    };
    let dot_color = tone_dot_color(tokens, tone);
    div()
        .relative()
        .size(px(16.0))
        .flex_shrink_0()
        .flex()
        .items_center()
        .justify_center()
        .child(glyph)
        .child(
            div()
                .absolute()
                .right(px(-3.0))
                .bottom(px(-3.0))
                .size(px(8.0))
                .rounded_full()
                .bg(dot_color)
                .border(px(1.5))
                .border_color(to_hsla(tokens.shell_card)),
        )
        .into_any_element()
}

fn tone_dot_color(tokens: &Tokens, tone: StatusTone) -> Hsla {
    match tone {
        StatusTone::Success => to_hsla(tokens.success),
        StatusTone::Info => to_hsla(tokens.info),
        StatusTone::Warning => to_hsla(tokens.warning),
        StatusTone::Destructive => to_hsla(tokens.destructive),
        StatusTone::Muted => to_hsla(tokens.muted_foreground).opacity(0.45),
    }
}

fn render_agent_state(tokens: &Tokens, agent: &TaskAgent) -> AnyElement {
    if agent.needs_input || agent.state == Some(AgentState::AskingForInput) {
        let warn = to_hsla(tokens.warning_foreground);
        return h_flex()
            .flex_shrink_0()
            .items_center()
            .gap(px(4.0))
            .text_size(px(UI_TEXT_PX))
            .line_height(px(UI_LINE_HEIGHT_PX))
            .font_weight(FontWeight::MEDIUM)
            .text_color(warn)
            .child(superhero_icon("superhero/question.svg", 14.0, warn))
            .child("Input")
            .into_any_element();
    }
    if agent.state == Some(AgentState::Working) {
        return div()
            .flex_shrink_0()
            .flex()
            .items_center()
            .child(superhero_icon(
                "superhero/circle-dashed.svg",
                14.0,
                to_hsla(tokens.info_foreground),
            ))
            .into_any_element();
    }
    let color = if agent.state == Some(AgentState::Failed) {
        to_hsla(tokens.destructive_foreground)
    } else {
        to_hsla(tokens.muted_foreground)
    };
    div()
        .flex_shrink_0()
        .text_size(px(UI_TEXT_PX))
        .line_height(px(UI_LINE_HEIGHT_PX))
        .text_color(color)
        .child(agent_state_text(agent))
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_subtask_meta_text_with_dashes_for_missing_values() {
        let empty = TaskMetrics::default();
        assert_eq!(
            subtask_meta_text(&empty),
            "\u{2013} \u{00b7} \u{2013}",
            "missing metrics show dashes"
        );
        let filled = TaskMetrics {
            duration_ms: Some(120_000.0),
            tokens: Some(12_500.0),
            lines_added: None,
            lines_deleted: None,
        };
        assert_eq!(
            subtask_meta_text(&filled),
            "2m \u{00b7} 12.5K tokens",
            "present metrics format duration and tokens"
        );
    }
}
