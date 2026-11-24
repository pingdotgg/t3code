//! The agent message and Orbit task cards, in the boxed face of `card_face` (lab `FeedCards.tsx`
//! `AgentMessageCard` and `OrbitTaskCard`; web `TimelineTaskReceipt.tsx` and `TaskRow`).

use conn_desktop::orbit::format::format_duration;
use conn_desktop::orbit::insights::parse_date_ms;
use conn_desktop::orbit::tasks::{
    AttentionKind, PullRequestState, TaskLabelTone, TaskLane, TaskStatus, TaskSummary,
};
use conn_theme::Tokens;
use gpui_kit::{
    AnyElement, Context, FontWeight, Hsla, InteractiveElement, IntoElement, MouseButton,
    ParentElement, SharedString, StatefulInteractiveElement, Styled, div, px,
};

use super::card_face::{
    CARD_CHEVRON_ROOM_PX, CARD_LINE_PX, CARD_META_LINE_PX, CARD_PREVIEW_LINES, CARD_TEXT_PX,
    CHECKLIST, CardFace, MERGE, PULL_REQUEST, card_body, card_colors, card_header,
    card_hover_surface, card_shell, disclosure_chevron, icon_with_dot, one_line_preview,
};
use super::color::{hsla, hsla_alpha, prose_foreground};
use super::{ChatEvent, ChatView, icons, markdown};
use crate::a11y::ConnA11yExt as _;

/// The dot on a task card's glyph.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TaskDot {
    Working,
    Waiting,
    Done,
    Failed,
}

/// The dot on the card's leading glyph (`TaskCardButton.tsx` `taskStatusDot`).
fn task_dot(task: &TaskSummary) -> Option<TaskDot> {
    if task
        .attention
        .as_ref()
        .is_some_and(|attention| attention.kind == AttentionKind::Question)
    {
        return Some(TaskDot::Waiting);
    }
    if task
        .label()
        .is_some_and(|label| label.tone == TaskLabelTone::Destructive)
    {
        return Some(TaskDot::Failed);
    }
    match task.status {
        TaskStatus::Cancelled => None,
        TaskStatus::Completed => Some(TaskDot::Done),
        _ if task.lane() == TaskLane::InProgress => Some(TaskDot::Working),
        _ => None,
    }
}

/// The time at the card's right: how long a working task has run, else when it last moved.
fn task_time_label(task: &TaskSummary, now_ms: i64) -> String {
    if task_dot(task) == Some(TaskDot::Working) {
        let elapsed = parse_date_ms(&task.created_at)
            .map(|created| (now_ms - created).max(0) as f64)
            .unwrap_or(0.0);
        return format_duration(elapsed);
    }
    let iso = task
        .last_activity_at
        .as_deref()
        .unwrap_or(task.updated_at.as_str());
    let Some(at_ms) = parse_date_ms(iso) else {
        return String::new();
    };
    let seconds = (now_ms - at_ms).max(0) / 1_000;
    match seconds {
        0..=59 => "just now".to_owned(),
        60..=3_599 => format!("{}m ago", seconds / 60),
        3_600..=86_399 => format!("{}h ago", seconds / 3_600),
        _ => format!("{}d ago", seconds / 86_400),
    }
}

/// A task's PR badge glyph and colour, by the PR's state.
fn pull_request_presentation(
    state: Option<PullRequestState>,
    tokens: &Tokens,
) -> (&'static str, Hsla) {
    match state {
        Some(PullRequestState::Open) => (PULL_REQUEST, hsla(tokens.success_foreground)),
        Some(PullRequestState::Merged) => (
            MERGE,
            hsla(conn_theme::color_mix_srgb(
                tokens.info_foreground,
                0.52,
                tokens.destructive,
            )),
        ),
        Some(PullRequestState::Closed) => (
            "superhero/pull-request-closed.svg",
            hsla(tokens.destructive_foreground),
        ),
        None => (PULL_REQUEST, hsla(tokens.muted_foreground)),
    }
}

impl ChatView {
    /// A message another agent sent: a card headed `Agent`, its text two lines at rest and in full
    /// when opened. The rest of the card is the button.
    pub(super) fn render_agent_message_card(
        &self,
        id: &str,
        text: &str,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let key = format!("agent-msg-{id}");
        let text = &*super::cache::humanize_task_ids(self.cache.rows(), text);
        let expanded = self.expanded_ids.contains(&key);
        let colors = card_colors(&self.tokens, CardFace::Tinted);
        let fg = hsla(self.tokens.foreground);
        let muted = hsla(self.tokens.muted_foreground);
        let toggle_key = key.clone();
        let hover = card_hover_surface(colors, &self.tokens);

        let header = card_header(false)
            .child(icons::icon(icons::ROBOT, 15.0, muted))
            .child(
                div()
                    .text_size(px(CARD_TEXT_PX))
                    .line_height(px(CARD_META_LINE_PX))
                    .text_color(muted)
                    .child("Agent"),
            );
        let title = div()
            .relative()
            .pr(px(CARD_CHEVRON_ROOM_PX))
            .text_size(px(CARD_TEXT_PX))
            .line_height(px(CARD_LINE_PX))
            .font_weight(FontWeight::MEDIUM)
            .text_color(fg)
            .child("Message")
            .child(disclosure_chevron(expanded, muted));
        let summary = if expanded {
            let mut options = self.markdown_options(cx);
            options.prose = Some(markdown::ProseStyle {
                color: prose_foreground(&self.tokens),
                size: Some((CARD_TEXT_PX, CARD_LINE_PX)),
            });
            div()
                .pt(px(6.0))
                .w_full()
                .min_w_0()
                // Links and code buttons in the text are not a tap on the card.
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .child(markdown::render_markdown(
                    &format!("agent-card-{id}"),
                    text,
                    &self.tokens,
                    &options,
                ))
        } else {
            div()
                .pt(px(6.0))
                .min_w_0()
                .text_size(px(CARD_TEXT_PX))
                .line_height(px(CARD_LINE_PX))
                .text_color(muted)
                .text_ellipsis()
                .line_clamp(CARD_PREVIEW_LINES)
                .child(one_line_preview(text))
        };

        let card = card_shell(colors)
            .id(SharedString::from(key))
            .a11y_button(
                format!("chat.agent-message.{id}"),
                if expanded {
                    "Collapse agent message"
                } else {
                    "Expand agent message"
                },
            )
            .cursor_pointer()
            .hover(move |s| s.bg(hover))
            .on_click(cx.listener(move |view, _, _, cx| view.toggle_expanded(&toggle_key, cx)))
            .child(header)
            .child(card_body(colors).child(title).child(summary));
        div()
            .w_full()
            .min_w_0()
            .pb(px(12.0))
            .child(card)
            .into_any_element()
    }

    /// The task an Orbit task-create call made: its project, id and subtasks above the title, the
    /// time at the right, and the PR it opened. The card opens the task in Tasks, the PR badge
    /// opens the PR.
    pub(super) fn render_orbit_task_card(
        &self,
        id: &str,
        task_row: &serde_json::Value,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let colors = card_colors(&self.tokens, CardFace::Tinted);
        let fg = hsla(self.tokens.foreground);
        let muted = hsla(self.tokens.muted_foreground);
        let Ok(task) = serde_json::from_value::<TaskSummary>(task_row.clone()) else {
            let title = task_row
                .get("title")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("Orbit task")
                .to_owned();
            let card = card_shell(colors)
                .id(SharedString::from(format!("orbit-task-{id}")))
                .a11y_group(format!("chat.task.{id}"), format!("Orbit task, {title}"))
                .child(card_header(false).child(icons::icon(CHECKLIST, 16.0, muted)))
                .child(
                    card_body(colors)
                        .text_size(px(CARD_TEXT_PX))
                        .line_height(px(CARD_LINE_PX))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(fg)
                        .child(title),
                );
            return div()
                .w_full()
                .min_w_0()
                .pb(px(12.0))
                .child(card)
                .into_any_element();
        };

        let state = task_dot(&task);
        let working = state == Some(TaskDot::Working);
        let dot = state.map(|state| {
            let core = match state {
                TaskDot::Working => hsla(self.tokens.info),
                TaskDot::Waiting => hsla_alpha(self.tokens.muted_foreground, 0.70),
                TaskDot::Done => hsla(self.tokens.success),
                TaskDot::Failed => hsla(self.tokens.destructive),
            };
            (core, colors.surface())
        });
        let task_id = task.id;
        let counts = task.subtask_counts;
        let mut first = format!("{} · #{}", task.project.slug.to_lowercase(), task.id);
        if counts.total >= 2 {
            first.push_str(&format!(" · {}/{}", counts.completed, counts.total));
        }
        let node = task
            .workspace
            .as_ref()
            .and_then(|workspace| workspace.node.as_ref())
            .map(|node| node.name.clone())
            .filter(|name| !name.is_empty());
        let time = task_time_label(&task, super::now_epoch_ms());
        let label = task.label().map(|label| label.label);

        let mut meta = div()
            .flex()
            .flex_row()
            .items_center()
            .flex_1()
            .min_w_0()
            .gap(px(4.0))
            .text_size(px(CARD_TEXT_PX))
            .line_height(px(CARD_META_LINE_PX))
            .text_color(muted)
            .child(div().min_w_0().truncate().child(first));
        if let Some(node) = node {
            meta = meta.child(div().flex_none().child(format!("· {node}")));
        }
        if let Some(pr) = task.pull_request.as_ref() {
            let (glyph, color) = pull_request_presentation(pr.state, &self.tokens);
            let url = pr.url.clone();
            let number = pr.number;
            meta = meta.child(div().flex_none().child("·")).child(
                div()
                    .id(SharedString::from(format!("orbit-task-pr-{id}")))
                    .a11y_button(
                        format!("chat.task.{id}.pr"),
                        format!("Pull request #{number}. Open it"),
                    )
                    .flex()
                    .flex_row()
                    .flex_none()
                    .items_center()
                    .gap(px(2.0))
                    .rounded(px(4.0))
                    .cursor_pointer()
                    .text_color(color)
                    .hover(|style| style.underline())
                    // A tap on the badge is not a tap on the card.
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .on_click(cx.listener(move |_, _, _, cx| {
                        cx.emit(ChatEvent::OpenInBrowser(url.clone()));
                    }))
                    .child(icons::icon(glyph, CARD_TEXT_PX, color))
                    .child(format!("#{number}")),
            );
        }
        meta = meta
            .child(div().flex_1())
            .child(div().flex_none().whitespace_nowrap().child(time));

        let header = card_header(false)
            .child(icon_with_dot(
                icons::icon(CHECKLIST, 16.0, muted).into_any_element(),
                dot,
            ))
            .child(meta);
        let title = div()
            .text_size(px(CARD_TEXT_PX))
            .line_height(px(CARD_LINE_PX))
            .font_weight(if working {
                FontWeight::NORMAL
            } else {
                FontWeight::MEDIUM
            })
            .text_color(fg)
            .child(task.title.clone());

        let hover = card_hover_surface(colors, &self.tokens);
        let a11y_label = match label {
            Some(label) => format!("Orbit task #{task_id}, {}, {label}", task.title),
            None => format!("Orbit task #{task_id}, {}", task.title),
        };
        let card = card_shell(colors)
            .id(SharedString::from(format!("orbit-task-{id}")))
            .a11y_button(format!("chat.task.{id}"), a11y_label)
            .cursor_pointer()
            .hover(move |s| s.bg(hover))
            .on_click(cx.listener(move |_, _, _, cx| {
                cx.emit(ChatEvent::OpenTask { task_id });
            }))
            .child(header)
            .child(card_body(colors).child(title));
        div()
            .w_full()
            .min_w_0()
            .pb(px(12.0))
            .child(card)
            .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn task(status: &str, attention: Option<&str>) -> TaskSummary {
        serde_json::from_value(json!({
            "id": 476,
            "title": "Fix TLS renewal",
            "status": status,
            "attention": attention.map(|kind| json!({ "kind": kind, "question": null, "reason": null })),
            "project": { "id": 1, "slug": "Orbit", "name": "Orbit", "code": null },
            "workspace": null,
            "pull_request": null,
            "subtask_counts": { "total": 2, "todo": 0, "running": 0, "completed": 2, "failed": 0, "cancelled": 0 },
            "created_at": "2026-11-24T10:00:00.000Z",
            "updated_at": "2026-11-24T10:30:00.000Z",
            "last_activity_at": null,
        }))
        .expect("a task row decodes")
    }

    #[test]
    fn the_dot_follows_the_task_state() {
        assert_eq!(task_dot(&task("running", None)), Some(TaskDot::Working));
        assert_eq!(task_dot(&task("completed", None)), Some(TaskDot::Done));
        assert_eq!(task_dot(&task("failed", None)), Some(TaskDot::Failed));
        assert_eq!(task_dot(&task("cancelled", None)), None);
        assert_eq!(task_dot(&task("todo", None)), None);
        assert_eq!(
            task_dot(&task("running", Some("question"))),
            Some(TaskDot::Waiting)
        );
    }

    #[test]
    fn a_working_task_shows_its_age_and_a_settled_one_its_last_move() {
        let created = parse_date_ms("2026-11-24T10:00:00.000Z").expect("a date");
        assert_eq!(
            task_time_label(&task("running", None), created + 25 * 60_000),
            "25m"
        );
        let moved = parse_date_ms("2026-11-24T10:30:00.000Z").expect("a date");
        assert_eq!(
            task_time_label(&task("completed", None), moved + 3 * 60_000),
            "3m ago"
        );
        assert_eq!(
            task_time_label(&task("completed", None), moved + 5 * 3_600_000),
            "5h ago"
        );
    }
}
