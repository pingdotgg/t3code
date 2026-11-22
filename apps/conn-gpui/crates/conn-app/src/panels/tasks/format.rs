//! Pure presentation helpers for the Tasks surface: relative times, project monograms, status
//! dots, insight grid geometry, theme-derived card surfaces, and chart axis labels.

use conn_contract::ProjectIconColor;
use conn_desktop::orbit::format::{format_duration, group_integer};
use conn_desktop::orbit::insights::{InsightId, parse_date_ms};
use conn_desktop::orbit::realtime::TasksLiveStatus;
use conn_desktop::orbit::tasks::{
    AttentionKind, InsightsPeriod, TaskInsights, TaskLabelTone, TaskLane, TaskProject, TaskStatus,
    TaskSummary,
};
use conn_theme::{Appearance, Rgba, Tokens, color_mix_oklab, color_mix_srgb};

/// Pure white (`white` in CSS `color-mix(in oklab, var(--shell-divider) ..., white)`).
const CSS_WHITE: Rgba = Rgba::new(1.0, 1.0, 1.0, 1.0);

/// Conn's 18-color project icon palette order (`apps/web/src/projectIconColors.ts`).
const PROJECT_ICON_COLORS: [ProjectIconColor; 18] = [
    ProjectIconColor::Gray,
    ProjectIconColor::Red,
    ProjectIconColor::Orange,
    ProjectIconColor::Amber,
    ProjectIconColor::Yellow,
    ProjectIconColor::Lime,
    ProjectIconColor::Green,
    ProjectIconColor::Emerald,
    ProjectIconColor::Teal,
    ProjectIconColor::Cyan,
    ProjectIconColor::Sky,
    ProjectIconColor::Blue,
    ProjectIconColor::Indigo,
    ProjectIconColor::Violet,
    ProjectIconColor::Purple,
    ProjectIconColor::Fuchsia,
    ProjectIconColor::Pink,
    ProjectIconColor::Rose,
];

/// Status dot on a task card's leading project icon (`StatusDotBadge.tsx`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(super) enum StatusDot {
    Working,
    Waiting,
    Done,
    Failed,
}

/// The dot on the card's leading icon (`TaskCardButton.tsx`: `taskStatusDot`).
#[must_use]
pub(super) fn task_status_dot(task: &TaskSummary) -> Option<StatusDot> {
    if task
        .attention
        .as_ref()
        .is_some_and(|a| a.kind == AttentionKind::Question)
    {
        return Some(StatusDot::Waiting);
    }
    if task
        .label()
        .is_some_and(|label| label.tone == TaskLabelTone::Destructive)
    {
        return Some(StatusDot::Failed);
    }
    if task.status == TaskStatus::Cancelled {
        return None;
    }
    if task.status == TaskStatus::Completed {
        return Some(StatusDot::Done);
    }
    if task.lane() == TaskLane::InProgress {
        Some(StatusDot::Working)
    } else {
        None
    }
}

/// Relative timestamp label matching Conn's `formatRelativeTimeLabel` (`timestampFormat.ts`):
/// `<60s` → `"just now"`, `<60m` → `"{m}m ago"`, `<24h` → `"{h}h ago"`, else `"{d}d ago"`.
#[must_use]
pub(super) fn format_relative_time_label(iso: &str, now_ms: i64) -> String {
    let Some(at_ms) = parse_date_ms(iso) else {
        return String::new();
    };
    let elapsed_ms = (now_ms - at_ms).max(0);
    let seconds = elapsed_ms / 1_000;
    if seconds < 60 {
        return "just now".to_owned();
    }
    let minutes = seconds / 60;
    if minutes < 60 {
        return format!("{minutes}m ago");
    }
    let hours = minutes / 60;
    if hours < 24 {
        return format!("{hours}h ago");
    }
    format!("{}d ago", hours / 24)
}

/// Time text at a task card's top right (`TaskCardButton.tsx`: `TaskCardStatus`).
/// Working cards show elapsed duration since `created_at`; all others show relative last activity.
#[must_use]
pub(super) fn task_card_time_label(task: &TaskSummary, now_ms: i64) -> String {
    if task_status_dot(task) == Some(StatusDot::Working) {
        let elapsed_ms = parse_date_ms(&task.created_at)
            .map(|created| (now_ms - created).max(0) as f64)
            .unwrap_or(0.0);
        format_duration(elapsed_ms)
    } else {
        let iso = task
            .last_activity_at
            .as_deref()
            .unwrap_or(task.updated_at.as_str());
        format_relative_time_label(iso, now_ms)
    }
}

/// Current Unix wall-clock time in milliseconds.
#[must_use]
pub(super) fn now_epoch_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

/// Project badge letter and deterministic palette color (`TaskCardButton.tsx`: `TaskProjectIcon`).
#[must_use]
pub(super) fn task_project_monogram(project: &TaskProject) -> (String, ProjectIconColor) {
    let hash: usize = project.slug.encode_utf16().map(usize::from).sum();
    let color = PROJECT_ICON_COLORS[hash % PROJECT_ICON_COLORS.len()];
    let letter = project
        .name
        .chars()
        .next()
        .map(|ch| ch.to_uppercase().to_string())
        .unwrap_or_else(|| "?".to_owned());
    (letter, color)
}

/// Grouped integer diff line count matching Conn's `formatDiffCount`.
#[must_use]
pub(super) fn format_diff_count(value: f64) -> String {
    group_integer(value.max(0.0))
}

/// Short axis / tooltip label for a trend point date (`InsightCharts.tsx`: `dateLabel`):
/// `YYYY-MM-DD` → `"18 Nov"`, ISO timestamp with `T` → `"10:00"`.
#[must_use]
pub(super) fn format_chart_date_label(date: &str) -> String {
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    if let Some((_, time_part)) = date.split_once('T') {
        let hhmm = time_part.get(..5).unwrap_or(time_part);
        if hhmm.len() == 5
            && hhmm.as_bytes()[2] == b':'
            && hhmm.as_bytes()[0..2].iter().all(u8::is_ascii_digit)
            && hhmm.as_bytes()[3..5].iter().all(u8::is_ascii_digit)
        {
            return hhmm.to_owned();
        }
        return date.to_owned();
    }
    let mut parts = date.split('-');
    let _year = parts.next();
    let Some(month) = parts.next().and_then(|m| m.parse::<usize>().ok()) else {
        return date.to_owned();
    };
    let Some(day) = parts.next().and_then(|d| d.parse::<u32>().ok()) else {
        return date.to_owned();
    };
    let Some(month_name) = month.checked_sub(1).and_then(|idx| MONTHS.get(idx)) else {
        return date.to_owned();
    };
    format!("{day} {month_name}")
}

/// Two-row insight strip geometry (`TasksInsights.tsx`: `insightGrid`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct InsightGridLayout {
    pub(super) columns: usize,
    pub(super) rows: usize,
    pub(super) last_span: usize,
}

/// Computes the insight grid dimensions for `count` visible metrics.
#[must_use]
pub(super) fn insight_grid_layout(count: usize) -> InsightGridLayout {
    let columns = if count <= 2 { 3 } else { count.div_ceil(2) };
    let rows = if count <= 2 { 1 } else { 2 };
    let last_span = if rows == 2 {
        columns * 2 - count + 1
    } else {
        1
    };
    InsightGridLayout {
        columns,
        rows,
        last_span,
    }
}

/// Returns `[top_left, top_right, bottom_right, bottom_left]` booleans indicating whether each
/// corner of insight cell `index` is an outer corner of the grid (`12px` radius vs `0px`).
#[must_use]
pub(super) fn insight_block_corners(
    grid: InsightGridLayout,
    index: usize,
    count: usize,
) -> [bool; 4] {
    let row = index / grid.columns;
    let start = index % grid.columns;
    let end = start
        + if index + 1 == count {
            grid.last_span
        } else {
            1
        };
    let top = row == 0;
    let bottom = row + 1 == grid.rows;
    let right = end == grid.columns || (grid.rows == 1 && index + 1 == count);
    [
        top && start == 0,
        top && right,
        bottom && right,
        bottom && start == 0,
    ]
}

/// Live-status text in the task detail header (`TaskDetail.tsx:240-244`).
#[must_use]
pub(super) fn live_status_label(status: TasksLiveStatus) -> &'static str {
    match status {
        TasksLiveStatus::Live => "Live",
        TasksLiveStatus::Polling => "Updates every 30s",
        TasksLiveStatus::Connecting => "Connecting updates",
    }
}

/// Period label in the Board settings menu (`TasksPanel.tsx:322-326`).
#[must_use]
pub(super) fn period_menu_label(period: InsightsPeriod) -> &'static str {
    match period {
        InsightsPeriod::Day => "Last 24 hours",
        InsightsPeriod::Week => "Last 7 days",
        InsightsPeriod::Month => "Last 30 days",
    }
}

/// Tooltip explanation for an insight metric (`TasksInsights.tsx`: `useInsightHint`).
#[must_use]
pub(super) fn insight_hint(id: InsightId, insights: Option<&TaskInsights>) -> &'static str {
    match id {
        InsightId::Completed => {
            if insights.is_some_and(|i| i.period == InsightsPeriod::Day) {
                "Tasks that merged in the period. The line counts the merges in the hours up to each point."
            } else {
                "Tasks that merged in the period. The line counts the merges in the days up to each point."
            }
        }
        InsightId::Spent => {
            "All agent tokens of the tasks that ended, replaced threads included. More tasks spend more, so a change is neither good nor bad."
        }
        InsightId::Tokens => {
            "All agent tokens of ended tasks, divided by the tasks that merged (one task, one PR). The line shows each week."
        }
        InsightId::Wasted => {
            "Share of tokens spent on tasks that did not merge and on implementer threads that were replaced."
        }
        InsightId::Delivery => {
            if insights.is_some_and(|i| i.current.delivery_time_ms.is_some()) {
                "Median time from ready to deployed."
            } else {
                "Median time from ready to merged. Once Orbit records deploys per task, this runs to deployed."
            }
        }
        InsightId::FirstPass => "Merged tasks that needed no fixup subtask.",
        InsightId::MergeWait => {
            if insights.is_some_and(|i| i.current.pr_merge_wait_ms.is_some()) {
                "Median time from PR opened to merged: CI, review and fixups."
            } else {
                "Median time from PR opened to merged. Orbit does not report it yet."
            }
        }
        InsightId::ReviewRounds => "Mean review verdicts per reviewed subtask.",
    }
}

/// Tasks-specific surface colors derived from `conn_theme::Tokens`, matching `index.css` formulas.
#[derive(Clone, Copy, Debug)]
pub(super) struct TasksSurfaceColors {
    /// `--shell-card-edge`: lighter top bevel on cards and the top row of insights.
    pub(super) shell_card_edge: Rgba,
    /// `--shell-chart-grid`: dashed horizontal gridlines in the expanded trend chart.
    pub(super) shell_chart_grid: Rgba,
    /// `--popover-rule`: dashed separator inside chart tooltips.
    pub(super) popover_rule: Rgba,
    /// Card surface fill (`bg-(--shell-card)` light / `bg-(--shell-highlight)/70` dark).
    pub(super) card_bg: Rgba,
    /// Card hover fill (`bg-(--shell-card)/70` light / `bg-(--shell-highlight)` dark).
    pub(super) card_hover_bg: Rgba,
    /// Opaque approximation of the card fill (`--task-card-fill`) for `StatusDotBadge` rings.
    pub(super) card_ring_fill: Rgba,
    /// Lane background fill (`bg-(--shell-highlight)/60` light / `bg-(--shell-highlight)/30` dark).
    pub(super) lane_bg: Rgba,
}

impl TasksSurfaceColors {
    #[must_use]
    pub(super) fn from_tokens(tokens: &Tokens) -> Self {
        let is_dark = tokens.appearance == Appearance::Dark;
        let shell_card_edge = if is_dark {
            color_mix_oklab(tokens.shell_divider, 0.965, CSS_WHITE)
        } else {
            color_mix_oklab(tokens.shell_divider, 0.80, CSS_WHITE)
        };
        let shell_chart_grid = color_mix_oklab(tokens.shell_divider, 0.93, tokens.foreground);
        let popover_rule = color_mix_oklab(tokens.popover, 0.80, tokens.foreground);
        let (card_bg, card_hover_bg, card_ring_fill, lane_bg) = if is_dark {
            (
                tokens
                    .shell_highlight
                    .with_alpha(tokens.shell_highlight.a * 0.70),
                tokens.shell_highlight,
                color_mix_srgb(tokens.foreground, 0.056, tokens.shell_card),
                tokens
                    .shell_highlight
                    .with_alpha(tokens.shell_highlight.a * 0.30),
            )
        } else {
            (
                tokens.shell_card,
                tokens.shell_card.with_alpha(0.70),
                tokens.shell_card,
                tokens
                    .shell_highlight
                    .with_alpha(tokens.shell_highlight.a * 0.60),
            )
        };
        Self {
            shell_card_edge,
            shell_chart_grid,
            popover_rule,
            card_bg,
            card_hover_bg,
            card_ring_fill,
            lane_bg,
        }
    }
}

#[cfg(test)]
mod tests {
    use conn_desktop::orbit::fixtures::fixture_tasks;
    use conn_desktop::orbit::tasks::TaskProject;

    use super::*;

    #[test]
    fn maps_task_status_dots_like_conn() {
        let tasks = fixture_tasks();
        let dot_of = |id: i64| {
            tasks
                .iter()
                .find(|t| t.id == id)
                .map(task_status_dot)
                .unwrap_or(None)
        };
        assert_eq!(dot_of(520), None, "backlog task has no dot");
        assert_eq!(dot_of(510), None, "todo task has no dot");
        assert_eq!(
            dot_of(482),
            Some(StatusDot::Working),
            "running task is working"
        );
        assert_eq!(
            dot_of(465),
            Some(StatusDot::Waiting),
            "question attention is waiting"
        );
        assert_eq!(
            dot_of(458),
            Some(StatusDot::Failed),
            "blocked attention is failed"
        );
        assert_eq!(
            dot_of(449),
            Some(StatusDot::Failed),
            "failed task is failed"
        );
        assert_eq!(dot_of(440), None, "cancelled task has no dot");
        assert_eq!(dot_of(431), Some(StatusDot::Done), "completed task is done");
    }

    #[test]
    fn formats_relative_times_and_working_durations() {
        let now = parse_date_ms("2026-11-17T16:11:09+00:00").unwrap_or(0);
        assert_eq!(
            format_relative_time_label("2026-11-17T16:10:40+00:00", now),
            "just now",
            "under 60s is just now"
        );
        assert_eq!(
            format_relative_time_label("2026-11-17T15:59:00+00:00", now),
            "12m ago",
            "minutes elapsed"
        );
        assert_eq!(
            format_relative_time_label("2026-11-17T11:11:09+00:00", now),
            "5h ago",
            "hours elapsed"
        );
        assert_eq!(
            format_relative_time_label("2026-11-15T16:11:09+00:00", now),
            "2d ago",
            "days elapsed"
        );
        assert_eq!(
            format_relative_time_label("invalid", now),
            "",
            "invalid timestamp yields empty string"
        );
    }

    #[test]
    fn computes_insight_grid_and_outer_corners() {
        let eight = insight_grid_layout(8);
        assert_eq!(
            eight,
            InsightGridLayout {
                columns: 4,
                rows: 2,
                last_span: 1
            },
            "8 insights form 4x2"
        );
        assert_eq!(
            insight_block_corners(eight, 0, 8),
            [true, false, false, false],
            "top-left card rounds only TL"
        );
        assert_eq!(
            insight_block_corners(eight, 3, 8),
            [false, true, false, false],
            "top-right card rounds only TR"
        );
        assert_eq!(
            insight_block_corners(eight, 4, 8),
            [false, false, false, true],
            "bottom-left card rounds only BL"
        );
        assert_eq!(
            insight_block_corners(eight, 7, 8),
            [false, false, true, false],
            "bottom-right card rounds only BR"
        );
        assert_eq!(
            insight_block_corners(eight, 1, 8),
            [false, false, false, false],
            "interior card has square corners"
        );

        let seven = insight_grid_layout(7);
        assert_eq!(seven.last_span, 2, "odd count spans trailing cell");
        assert_eq!(
            insight_block_corners(seven, 6, 7),
            [false, false, true, false],
            "spanning bottom-right card rounds BR"
        );

        let two = insight_grid_layout(2);
        assert_eq!(
            two,
            InsightGridLayout {
                columns: 3,
                rows: 1,
                last_span: 1
            },
            "2 insights stay on 1 row"
        );
        assert_eq!(
            insight_block_corners(two, 1, 2),
            [false, true, true, false],
            "last cell of 1-row strip rounds TR and BR"
        );
    }

    #[test]
    fn formats_chart_dates_and_project_monogram() {
        assert_eq!(
            format_chart_date_label("2026-11-18"),
            "18 Nov",
            "day format"
        );
        assert_eq!(
            format_chart_date_label("2026-11-19T09:30:00+00:00"),
            "09:30",
            "hour format"
        );
        let project = TaskProject {
            id: 78,
            slug: "orbit".to_owned(),
            name: "Orbit".to_owned(),
            code: Some("ORB".to_owned()),
        };
        let (letter, _) = task_project_monogram(&project);
        assert_eq!(letter, "O", "single uppercase initial for project monogram");
    }
}
