//! The Tasks board view: search toolbar + board settings menu, lanes, task cards, and empty/error
//! notices.
//!
//! Port of `apps/web/src/orbit/tasks/TasksPanel.tsx` and `TaskCardButton.tsx`.

use crate::a11y::ConnA11yExt as _;
use std::cell::Cell;
use std::rc::Rc;

use conn_desktop::orbit::board::{BoardLane, task_card_detail, tasks_board_lanes};
use conn_desktop::orbit::insights::{INSIGHTS, InsightId};
use conn_desktop::orbit::panel::TasksBoardSettings;
use conn_desktop::orbit::tasks::{
    InsightsPeriod, PullRequestState, TaskInsights, TaskLane, TaskSummary,
};
use conn_theme::{Appearance, Tokens};
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::*;
use gpui_kit::{
    AnyElement, App, Bounds, BoxShadow, Entity, FontWeight, Hsla, MouseButton, Pixels,
    ScrollHandle, SharedString, Window, deferred, div, point, px,
};

use super::format::{
    StatusDot, TasksSurfaceColors, period_menu_label, task_card_time_label, task_project_monogram,
    task_status_dot,
};
use super::insights::{InsightsCallbacks, render_insights_strip};
use crate::panels::chrome::{
    self, ConnTooltipExt as _, UI_LINE_HEIGHT_PX, UI_TEXT_PX, XS_LINE_HEIGHT_PX, XS_TEXT_PX,
};
use crate::panels::color::to_hsla;
use crate::panels::header::superhero_icon;
use crate::sidebar::{project_icon_color, render_project_monogram_badge};

/// Lane minimum width (`min-w-48` = 192px).
const LANE_MIN_WIDTH_PX: f32 = 192.0;
/// Gap between lanes and outer board padding (`gap-2 p-2` = 8px).
const LANE_GAP_PX: f32 = 8.0;
/// Lane corner radius (`rounded-xl` = 12px).
const LANE_RADIUS_PX: f32 = 12.0;
/// Project monogram size on a task card (`size-4` = 16px).
const CARD_PROJECT_ICON_PX: f32 = 16.0;

/// Callbacks wired from the board back into `TasksPanel`.
pub(super) struct BoardCallbacks {
    pub(super) on_clear_query: Rc<dyn Fn(&mut Window, &mut App)>,
    pub(super) on_toggle_settings: Rc<dyn Fn(&mut Window, &mut App)>,
    pub(super) on_toggle_lane: Rc<dyn Fn(TaskLane, &mut Window, &mut App)>,
    pub(super) on_toggle_insight: Rc<dyn Fn(InsightId, &mut Window, &mut App)>,
    pub(super) on_set_period: Rc<dyn Fn(InsightsPeriod, &mut Window, &mut App)>,
    pub(super) on_expand_insight: Rc<dyn Fn(Option<InsightId>, &mut Window, &mut App)>,
    pub(super) on_hover_chart: Rc<dyn Fn(Option<usize>, &mut Window, &mut App)>,
    pub(super) on_open_task: Rc<dyn Fn(i64, &mut Window, &mut App)>,
    pub(super) on_open_pr: Rc<dyn Fn(i64, String, &mut Window, &mut App)>,
}

/// Renders the full Tasks board: search toolbar, insights strip, and horizontal lanes.
#[expect(
    clippy::too_many_arguments,
    reason = "board view takes borrowed panel state handles without cloning collections"
)]
pub(super) fn render_board(
    tokens: &Tokens,
    tasks: &[TaskSummary],
    insights: Option<&TaskInsights>,
    query: &str,
    search_input: &Entity<InputState>,
    settings: &TasksBoardSettings,
    settings_open: bool,
    expanded_insight: Option<InsightId>,
    chart_hover: Option<usize>,
    chart_bounds: Rc<Cell<Bounds<Pixels>>>,
    insights_scroll: &ScrollHandle,
    lanes_scroll: &ScrollHandle,
    now_ms: i64,
    callbacks: BoardCallbacks,
) -> AnyElement {
    let surface = TasksSurfaceColors::from_tokens(tokens);
    let searching = !query.trim().is_empty();
    let lanes = tasks_board_lanes(tasks, query, &settings.hidden_lanes);

    let toolbar = render_board_toolbar(
        tokens,
        query,
        search_input,
        settings,
        settings_open,
        &callbacks,
    );

    let insights_el = render_insights_strip(
        tokens,
        insights,
        settings.insight_period,
        searching,
        &settings.hidden_insights,
        expanded_insight,
        chart_hover,
        chart_bounds,
        insights_scroll,
        InsightsCallbacks {
            on_expand: Rc::clone(&callbacks.on_expand_insight),
            on_hover_chart: Rc::clone(&callbacks.on_hover_chart),
        },
    );

    let lane_count = lanes.len();
    let min_lanes_width =
        lane_count as f32 * LANE_MIN_WIDTH_PX + lane_count.saturating_sub(1) as f32 * LANE_GAP_PX;

    let mut lanes_row = h_flex()
        .w_full()
        .min_w(px(min_lanes_width))
        .min_h(px(256.0))
        .flex_1()
        .items_stretch()
        .gap(px(LANE_GAP_PX));

    for lane in &lanes {
        lanes_row = lanes_row.child(render_lane(
            tokens, &surface, lane, searching, now_ms, &callbacks,
        ));
    }

    let lanes_scroller = div()
        .id("tasks-lanes-scroll")
        .a11y_group("panel.tasks.lanes", "Task lanes")
        .flex()
        .flex_1()
        .min_h(px(256.0))
        .w_full()
        .overflow_x_scroll()
        .track_scroll(lanes_scroll)
        .p(px(LANE_GAP_PX))
        .child(lanes_row);

    v_flex()
        .flex_1()
        .min_h_0()
        .w_full()
        .child(toolbar)
        .child(
            div()
                .id("tasks-board-scroll")
                .a11y_group("panel.tasks.board", "Task board")
                .flex()
                .flex_col()
                .flex_1()
                .min_h_0()
                .w_full()
                .overflow_y_scroll()
                .when_some(insights_el, |el, strip| el.child(strip))
                .child(lanes_scroller),
        )
        .into_any_element()
}

/// Search field + Board settings pill (`TasksPanel.tsx`: `BoardToolbar`).
fn render_board_toolbar(
    tokens: &Tokens,
    query: &str,
    search_input: &Entity<InputState>,
    settings: &TasksBoardSettings,
    settings_open: bool,
    callbacks: &BoardCallbacks,
) -> AnyElement {
    let muted = to_hsla(tokens.muted_foreground);
    let fg = to_hsla(tokens.foreground);
    let control_hover = to_hsla(tokens.shell_control);

    let mut search_group = chrome::soft_input_group(tokens)
        .id("tasks-search")
        .a11y_group("panel.tasks.search", "Search tasks")
        .pl(px(10.0))
        .pr(px(6.0))
        .gap(px(6.0))
        .child(superhero_icon(
            "superhero/search.svg",
            16.0,
            muted.opacity(0.50),
        ))
        .child(
            div().flex_1().min_w_0().child(
                Input::new(search_input)
                    .appearance(false)
                    .text_size(px(UI_TEXT_PX)),
            ),
        );

    if !query.is_empty() {
        let on_clear = Rc::clone(&callbacks.on_clear_query);
        search_group = search_group.child(
            chrome::icon_button(
                "tasks-search-clear",
                "superhero/close.svg",
                tokens,
                false,
                move |_, window, cx| on_clear(window, cx),
            )
            .conn_tooltip("Clear search", tokens),
        );
    }

    let on_toggle = Rc::clone(&callbacks.on_toggle_settings);
    let settings_btn = div()
        .id("tasks-board-settings-btn")
        .a11y_button("panel.tasks.board-settings", "Board settings")
        .flex()
        .flex_shrink_0()
        .size(px(26.0))
        .items_center()
        .justify_center()
        .rounded(px(9999.0))
        .cursor_pointer()
        .when(settings_open, |el| el.bg(control_hover))
        .hover(move |s| s.bg(control_hover))
        .on_mouse_down(MouseButton::Left, move |_, window, cx| {
            cx.stop_propagation();
            on_toggle(window, cx);
        })
        .conn_tooltip("Board settings", tokens)
        .child(superhero_icon(
            "superhero/adjust.svg",
            16.0,
            if settings_open { fg } else { muted },
        ));

    let mut settings_anchor = div()
        .relative()
        .flex_shrink_0()
        .child(chrome::toolbar_group(tokens).child(settings_btn));

    if settings_open {
        settings_anchor = settings_anchor.child(render_settings_menu(tokens, settings, callbacks));
    }

    // `flex shrink-0 items-center gap-2 px-2 py-toolbar` (no divider above or below the insights strip).
    h_flex()
        .id("tasks-board-toolbar")
        .a11y_group("panel.tasks.toolbar", "Tasks toolbar")
        .w_full()
        .flex_shrink_0()
        .items_center()
        .gap(px(8.0))
        .px(px(8.0))
        .py(px(chrome::TOOLBAR_PAD_Y_PX))
        .child(search_group)
        .child(settings_anchor)
        .into_any_element()
}

/// Right-aligned `dropdown-glass` Board settings menu (Lanes, Insights, Insights period).
fn render_settings_menu(
    tokens: &Tokens,
    settings: &TasksBoardSettings,
    callbacks: &BoardCallbacks,
) -> AnyElement {
    let fg = to_hsla(tokens.foreground);
    let muted = to_hsla(tokens.muted_foreground);
    let highlight = to_hsla(tokens.shell_highlight);
    let divider = to_hsla(tokens.foreground.with_alpha(0.08));
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

    let group_label = |title: &'static str| {
        div()
            .px(px(8.0))
            .py(px(4.0))
            .text_size(px(XS_TEXT_PX))
            .line_height(px(XS_LINE_HEIGHT_PX))
            .font_weight(FontWeight::MEDIUM)
            .text_color(muted)
            .child(title)
    };

    let check_row = |id: String,
                     label: &'static str,
                     checked: bool,
                     disabled: bool,
                     on_press: Rc<dyn Fn(&mut Window, &mut App)>| {
        let mut row = h_flex()
            .id(SharedString::from(id))
            .w_full()
            .min_h(px(28.0))
            .px(px(8.0))
            .py(px(4.0))
            .gap(px(8.0))
            .items_center()
            .rounded(px(8.0))
            .text_size(px(UI_TEXT_PX))
            .line_height(px(UI_LINE_HEIGHT_PX))
            .text_color(fg)
            .child(
                div()
                    .w(px(16.0))
                    .h(px(16.0))
                    .flex_shrink_0()
                    .flex()
                    .items_center()
                    .justify_center()
                    .when(checked, |el| {
                        el.child(superhero_icon("superhero/check.svg", 14.0, fg))
                    }),
            )
            .child(div().min_w_0().flex_1().truncate().child(label));
        if disabled {
            row = row.opacity(0.50);
        } else {
            row = row
                .cursor_pointer()
                .hover(move |s| s.bg(highlight))
                .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                    cx.stop_propagation();
                    on_press(window, cx);
                });
        }
        row
    };

    let hidden_count = settings.hidden_lanes.len();
    let mut menu = v_flex()
        .id("tasks-board-settings-menu")
        .a11y_group("panel.tasks.board-settings-menu", "Board settings menu")
        .min_w(px(208.0))
        .max_h(px(520.0))
        .overflow_y_scroll()
        .p(px(4.0))
        .rounded(px(12.0))
        .bg(to_hsla(tokens.popover))
        .border_1()
        .border_color(divider)
        .shadow(vec![shadow])
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation());

    menu = menu.child(group_label("Lanes"));
    for lane in TaskLane::ALL {
        let shown = !settings.hidden_lanes.contains(&lane);
        let disabled = shown && hidden_count == TaskLane::ALL.len() - 1;
        let on_lane = Rc::clone(&callbacks.on_toggle_lane);
        menu = menu.child(check_row(
            format!("tasks-setting-lane-{lane:?}"),
            lane.label(),
            shown,
            disabled,
            Rc::new(move |window, cx| on_lane(lane, window, cx)),
        ));
    }

    menu = menu
        .child(div().mx(px(-4.0)).my(px(4.0)).h(px(1.0)).bg(divider))
        .child(group_label("Insights"));
    for spec in INSIGHTS {
        let shown = !settings.hidden_insights.contains(&spec.id);
        let on_insight = Rc::clone(&callbacks.on_toggle_insight);
        menu = menu.child(check_row(
            format!("tasks-setting-insight-{:?}", spec.id),
            spec.label,
            shown,
            false,
            Rc::new(move |window, cx| on_insight(spec.id, window, cx)),
        ));
    }

    menu = menu
        .child(div().mx(px(-4.0)).my(px(4.0)).h(px(1.0)).bg(divider))
        .child(group_label("Insights period"));
    for period in InsightsPeriod::ALL {
        let selected = settings.insight_period == period;
        let on_period = Rc::clone(&callbacks.on_set_period);
        menu = menu.child(check_row(
            format!("tasks-setting-period-{period:?}"),
            period_menu_label(period),
            selected,
            false,
            Rc::new(move |window, cx| on_period(period, window, cx)),
        ));
    }

    deferred(
        div()
            .absolute()
            .top(px(chrome::CONTROL_HEIGHT_PX + 6.0))
            .right(px(0.0))
            .child(menu),
    )
    .with_priority(3)
    .into_any_element()
}

/// Renders one lane column (`Backlog`, `To do`, `In progress`, `Done`).
fn render_lane(
    tokens: &Tokens,
    surface: &TasksSurfaceColors,
    lane: &BoardLane<'_>,
    searching: bool,
    now_ms: i64,
    callbacks: &BoardCallbacks,
) -> AnyElement {
    let muted = to_hsla(tokens.muted_foreground);
    let count_text = if searching {
        format!("{} of {}", lane.tasks.len(), lane.total)
    } else {
        lane.tasks.len().to_string()
    };

    let mut list = v_flex()
        .id(SharedString::from(format!("tasks-lane-list-{:?}", lane.id)))
        .a11y_group(
            format!("panel.tasks.lane-list.{:?}", lane.id),
            format!("{} tasks", lane.label),
        )
        .flex_1()
        .min_h_0()
        .w_full()
        .gap(px(6.0))
        .overflow_y_scroll();

    if lane.tasks.is_empty() {
        list = list.child(
            div()
                .w_full()
                .px(px(12.0))
                .py(px(16.0))
                .flex()
                .justify_center()
                .text_size(px(UI_TEXT_PX))
                .line_height(px(UI_LINE_HEIGHT_PX))
                .text_color(muted.opacity(0.70))
                .child(if searching && lane.total > 0 {
                    "No matches"
                } else {
                    "Nothing here"
                }),
        );
    } else {
        for task in &lane.tasks {
            list = list.child(render_task_card(tokens, surface, task, now_ms, callbacks));
        }
    }

    v_flex()
        .id(SharedString::from(format!("tasks-lane-{:?}", lane.id)))
        .a11y_group(format!("panel.tasks.lane.{:?}", lane.id), lane.label)
        .min_w(px(LANE_MIN_WIDTH_PX))
        .flex_1()
        .flex_basis(px(0.0))
        .rounded(px(LANE_RADIUS_PX))
        .bg(to_hsla(surface.lane_bg))
        .p(px(6.0))
        .pt(px(0.0))
        .child(
            h_flex()
                .flex_shrink_0()
                .w_full()
                .items_center()
                .justify_between()
                .px(px(8.0))
                .py(px(8.0))
                .text_size(px(UI_TEXT_PX))
                .line_height(px(UI_LINE_HEIGHT_PX))
                .text_color(muted)
                .child(div().font_weight(FontWeight::MEDIUM).child(lane.label))
                .child(div().child(count_text)),
        )
        .child(list)
        .into_any_element()
}

/// Renders one task card (`TaskCardButton.tsx`).
fn render_task_card(
    tokens: &Tokens,
    surface: &TasksSurfaceColors,
    task: &TaskSummary,
    now_ms: i64,
    callbacks: &BoardCallbacks,
) -> AnyElement {
    let fg = to_hsla(tokens.foreground);
    let muted = to_hsla(tokens.muted_foreground);
    let card_bg = to_hsla(surface.card_bg);
    let card_hover = to_hsla(surface.card_hover_bg);
    let divider = to_hsla(tokens.shell_divider);

    let working = task.lane() == TaskLane::InProgress && task.attention.is_none();
    let detail = task_card_detail(task);
    let time_label = task_card_time_label(task, now_ms);
    let (letter, proj_color) = task_project_monogram(&task.project);
    let monogram = render_project_monogram_badge(
        &letter,
        project_icon_color(proj_color, tokens),
        CARD_PROJECT_ICON_PX,
    );
    let leading_icon = render_status_dot_badge(
        monogram,
        task_status_dot(task),
        to_hsla(surface.card_ring_fill),
        tokens,
    );

    let task_id = task.id;
    let on_open = Rc::clone(&callbacks.on_open_task);

    let pr_badge = task.pull_request.as_ref().map(|pr| {
        let (icon_path, color) = pull_request_presentation(pr.state, tokens);
        let url = pr.url.clone();
        let on_pr = Rc::clone(&callbacks.on_open_pr);
        h_flex()
            .id(SharedString::from(format!("tasks-card-pr-{task_id}")))
            .a11y_button(
                format!("panel.tasks.card-pr.{task_id}"),
                "Open pull request",
            )
            .flex_shrink_0()
            .items_center()
            .gap(px(4.0))
            .rounded(px(4.0))
            .cursor_pointer()
            .text_size(px(UI_TEXT_PX))
            .line_height(px(16.0))
            .text_color(color)
            .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                cx.stop_propagation();
                on_pr(task_id, url.clone(), window, cx);
            })
            .child(superhero_icon(icon_path, 14.0, color))
            .child(format!("#{}", pr.number))
    });

    let has_footer = !detail.is_empty() || pr_badge.is_some();

    v_flex()
        .id(SharedString::from(format!("tasks-card-{task_id}")))
        .a11y_button(format!("panel.tasks.card.{task_id}"), task.title.clone())
        .w_full()
        .gap(px(6.0))
        .rounded(px(8.0))
        .border_1()
        .border_color(divider)
        .bg(card_bg)
        .px(px(9.0))
        .pt(px(10.0))
        .pb(px(8.0))
        .cursor_pointer()
        .hover(move |s| s.bg(card_hover))
        .on_click(move |_, window, cx| on_open(task_id, window, cx))
        // Row 1: project badge + status dot, `#id`, age/duration.
        .child(
            h_flex()
                .w_full()
                .items_center()
                .gap(px(6.0))
                .text_size(px(UI_TEXT_PX))
                .line_height(px(16.0))
                .child(leading_icon)
                .child(
                    div()
                        .min_w_0()
                        .flex_1()
                        .truncate()
                        .text_color(muted)
                        .child(format!("#{task_id}")),
                )
                .child(
                    div()
                        .flex_shrink_0()
                        .text_color(muted.opacity(0.80))
                        .child(time_label),
                ),
        )
        // Row 2: title (`font-normal` while working, `font-medium` otherwise).
        .child(
            div()
                .w_full()
                .text_size(px(UI_TEXT_PX))
                .line_height(px(UI_LINE_HEIGHT_PX))
                .text_color(fg.opacity(0.90))
                .font_weight(if working {
                    FontWeight::NORMAL
                } else {
                    FontWeight::MEDIUM
                })
                .child(task.title.clone()),
        )
        // Row 3: subtask count / machine + optional PR badge.
        .when(has_footer, |card| {
            card.child(
                h_flex()
                    .w_full()
                    .items_center()
                    .gap(px(8.0))
                    .text_size(px(UI_TEXT_PX))
                    .line_height(px(16.0))
                    .text_color(muted)
                    .child(div().min_w_0().flex_1().truncate().child(detail))
                    .when_some(pr_badge, |row, badge| row.child(badge)),
            )
        })
        .into_any_element()
}

/// Wraps a 16px project icon with Conn's 6px corner `StatusDotBadge` and ring cutout.
fn render_status_dot_badge(
    icon: gpui_kit::Div,
    state: Option<StatusDot>,
    ring: Hsla,
    tokens: &Tokens,
) -> gpui_kit::Div {
    let mut wrapper = div()
        .relative()
        .flex()
        .flex_shrink_0()
        .items_center()
        .justify_center()
        .child(icon);
    if let Some(dot) = state {
        let dot_color = match dot {
            StatusDot::Working => to_hsla(tokens.info),
            StatusDot::Waiting => to_hsla(tokens.muted_foreground).opacity(0.70),
            StatusDot::Done => to_hsla(tokens.success),
            StatusDot::Failed => to_hsla(tokens.destructive),
        };
        wrapper = wrapper.child(chrome::status_dot_cutout(dot_color, ring, None, false));
    }
    wrapper
}

/// PR icon concept and semantic tone (`pullRequestIcons.tsx`).
#[must_use]
pub(super) fn pull_request_presentation(
    state: Option<PullRequestState>,
    tokens: &Tokens,
) -> (&'static str, Hsla) {
    match state {
        Some(PullRequestState::Open) => (
            "superhero/pull-request.svg",
            to_hsla(tokens.success_foreground),
        ),
        Some(PullRequestState::Merged) => (
            "superhero/merge.svg",
            to_hsla(conn_theme::color_mix_srgb(
                tokens.info_foreground,
                0.52,
                tokens.destructive,
            )),
        ),
        Some(PullRequestState::Closed) => (
            "superhero/pull-request-closed.svg",
            to_hsla(tokens.destructive_foreground),
        ),
        None => (
            "superhero/pull-request.svg",
            to_hsla(tokens.muted_foreground),
        ),
    }
}

/// Centered Conn `Empty` notice used for unavailable, access/error, and empty-list states.
pub(super) fn render_notice(
    tokens: &Tokens,
    icon_path: &'static str,
    title: impl Into<SharedString>,
    description: impl Into<SharedString>,
    retry: Option<Rc<dyn Fn(&mut Window, &mut App)>>,
) -> AnyElement {
    let fg = to_hsla(tokens.foreground);
    let muted = to_hsla(tokens.muted_foreground);
    let tile_bg = to_hsla(tokens.shell_tile);
    let tile_border = to_hsla(tokens.shell_tile_border);

    let icon_tile = div()
        .size(px(36.0))
        .rounded(px(8.0))
        .border_1()
        .border_color(tile_border)
        .bg(tile_bg)
        .flex()
        .items_center()
        .justify_center()
        .child(superhero_icon(icon_path, 18.0, fg));

    v_flex()
        .flex_1()
        .min_h_0()
        .w_full()
        .items_center()
        .justify_center()
        .gap(px(16.0))
        .p(px(24.0))
        .child(icon_tile)
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
                        .child(title.into()),
                )
                .child(
                    div()
                        .text_size(px(14.0))
                        .line_height(px(20.0))
                        .text_color(muted)
                        .child(description.into()),
                ),
        )
        .when_some(retry, |col, on_retry| {
            let hover = to_hsla(tokens.shell_highlight);
            col.child(
                div()
                    .id("tasks-notice-retry")
                    .a11y_button("panel.tasks-notice-retry", "Retry")
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
        })
        .into_any_element()
}
