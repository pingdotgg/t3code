//! The worktree setup card: where a new thread's worktree setup stands, from the server's
//! `subscribeWorktreeSetup` stream (web `WorktreeSetupCard.tsx`, `useWorktreeSetup.ts`,
//! `resolveVisibleWorktreeSetup`; lab `WorktreeExample`).
//!
//! The card sits after the thread's first message while setup runs, and stays when setup failed or
//! was cancelled. A finished setup leaves once the agent has started, unless a stage failed.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash as _, Hasher as _};
use std::time::Duration;

use conn_contract::{
    ProjectClonePhase, WorktreeSetupSnapshot, WorktreeSetupStage, WorktreeSetupStageId,
    WorktreeSetupStageStatus,
};
use gpui_kit::{
    AnyElement, Context, FollowMode, Hsla, InteractiveElement, IntoElement, ParentElement,
    SharedString, StatefulInteractiveElement, Styled, Task, div, px,
};

use super::card_face::{
    BRANCH, CARD_ICON_PX, CARD_TEXT_PX, CardFace, card_body, card_colors, card_header, card_shell,
};
use super::color::{hsla, hsla_alpha};
use super::spinner::TurningArc;
use super::{ChatView, MONO_FONT_FAMILY, icons};
use crate::a11y::ConnA11yExt as _;

/// A stage row's text: 13px on the card's list line.
const ROW_LINE_PX: f32 = CARD_TEXT_PX * 1.5;
/// How many lines of the setup script's output the card holds.
const OUTPUT_TAIL_LINES: usize = 4;

/// What the open thread's worktree setup shows.
#[derive(Default)]
pub(super) struct WorktreeSetupState {
    /// The thread the stream below follows.
    thread_id: Option<String>,
    snapshot: Option<WorktreeSetupSnapshot>,
    stream: Option<conn_client::StreamId>,
    /// Counts streams, so one that ended late is dropped.
    generation: u64,
    details_open: bool,
    cancelling: bool,
    /// Repaints the running card each second, for its clocks.
    tick: Option<Task<()>>,
}

impl WorktreeSetupState {
    fn running(&self) -> bool {
        self.snapshot
            .as_ref()
            .is_some_and(|snapshot| snapshot.phase == ProjectClonePhase::Running)
    }
}

/// Whether the card shows (`resolveVisibleWorktreeSetup`): always while running, and while failed
/// or cancelled; a finished setup only until the agent runs, unless a stage failed.
fn worktree_visible(snapshot: &WorktreeSetupSnapshot, agent_ran: bool) -> bool {
    match snapshot.phase {
        ProjectClonePhase::Running | ProjectClonePhase::Failed | ProjectClonePhase::Cancelled => {
            true
        }
        ProjectClonePhase::Done => {
            !agent_ran
                || snapshot
                    .stages
                    .iter()
                    .any(|stage| stage.status == WorktreeSetupStageStatus::Failed)
        }
    }
}

/// Milliseconds from `started_at` to `ended_at`, or to `now_ms` while `live` and not ended.
fn elapsed_ms(
    started_at: Option<&str>,
    ended_at: Option<&str>,
    live: bool,
    now_ms: i64,
) -> Option<u64> {
    let start = conn_state::parse_iso8601_epoch_ms(started_at?)?;
    let end = match ended_at {
        Some(ended) => conn_state::parse_iso8601_epoch_ms(ended)?,
        None if live => now_ms,
        None => return None,
    };
    u64::try_from(end - start).ok()
}

/// A stage's name (the contracts' English labels); the setup script goes by its own name.
fn stage_label(id: WorktreeSetupStageId, script_name: Option<&str>) -> String {
    match id {
        WorktreeSetupStageId::Fetch => "Fetch base branch".to_owned(),
        WorktreeSetupStageId::Checkout => "Check out files".to_owned(),
        WorktreeSetupStageId::Submodules => "Init submodules".to_owned(),
        WorktreeSetupStageId::SetupScript => script_name.unwrap_or("Run setup script").to_owned(),
        WorktreeSetupStageId::Agent => "Start agent".to_owned(),
    }
}

/// The note at a stage row's right: what a skipped stage says, a checkout's progress, or detail.
fn stage_trailing(stage: &WorktreeSetupStage) -> Option<String> {
    match stage.status {
        WorktreeSetupStageStatus::Pending => None,
        WorktreeSetupStageStatus::Skipped => Some(
            stage
                .detail
                .clone()
                .filter(|detail| !detail.is_empty())
                .unwrap_or_else(|| "skipped".to_owned()),
        ),
        _ => match (stage.id, stage.status, stage.percent) {
            (WorktreeSetupStageId::Checkout, WorktreeSetupStageStatus::Running, Some(percent)) => {
                Some(format!("{percent}%"))
            }
            _ => stage.detail.clone().filter(|detail| !detail.is_empty()),
        },
    }
}

/// Whether the setup script's output shows: its last lines while it runs, and why it failed.
fn shows_output(stage: &WorktreeSetupStage) -> bool {
    stage.id == WorktreeSetupStageId::SetupScript
        && (stage.status == WorktreeSetupStageStatus::Failed
            || (stage.status == WorktreeSetupStageStatus::Running && !stage.tail.is_empty()))
}

/// The last [`OUTPUT_TAIL_LINES`] lines, with empty lines above when there are fewer, so the box
/// holds one height.
fn output_slots(tail: &[String]) -> [&str; OUTPUT_TAIL_LINES] {
    let mut slots = [""; OUTPUT_TAIL_LINES];
    for (slot, line) in slots.iter_mut().enumerate() {
        let index = (tail.len() + slot).checked_sub(OUTPUT_TAIL_LINES);
        if let Some(line_text) = index.and_then(|index| tail.get(index)) {
            *line = line_text.as_str();
        }
    }
    slots
}

impl ChatView {
    // -----------------------------------------------------------------------------------------
    // Following the stream
    // -----------------------------------------------------------------------------------------

    /// Follows the open thread's worktree setup: starts its stream, and drops the last thread's.
    /// Called after every thread sync, so a stream that ended starts again.
    pub(super) fn follow_worktree_setup(&mut self, cx: &mut Context<'_, Self>) {
        let wanted = self.thread_id.clone();
        if wanted == self.worktree.thread_id && (wanted.is_none() || self.worktree.stream.is_some())
        {
            self.refresh_worktree_row(cx);
            return;
        }
        if let (Some(connection), Some(stream)) = (&self.connection, self.worktree.stream.take()) {
            connection.cancel_stream(stream);
        }
        self.worktree.snapshot = None;
        self.worktree.details_open = false;
        self.worktree.cancelling = false;
        self.worktree.tick = None;
        self.worktree.thread_id = wanted.clone();
        self.worktree.generation = self.worktree.generation.wrapping_add(1);
        let generation = self.worktree.generation;
        if let (Some(connection), Some(thread_id)) = (self.connection.clone(), wanted) {
            let (stream_id, mut rx) = connection.stream_json(
                "subscribeWorktreeSetup",
                serde_json::json!({ "threadId": thread_id }),
            );
            self.worktree.stream = Some(stream_id);
            cx.spawn(async move |this, cx| {
                while let Some(raw) = rx.recv().await {
                    // `null` says no setup (yet): the card keeps what it has.
                    let snapshot = serde_json::from_value::<Option<WorktreeSetupSnapshot>>(raw)
                        .ok()
                        .flatten();
                    let keep = this
                        .update(cx, |view, cx| {
                            if view.worktree.generation != generation {
                                return false;
                            }
                            if let Some(snapshot) = snapshot {
                                view.apply_worktree_snapshot(snapshot, cx);
                            }
                            true
                        })
                        .unwrap_or(false);
                    if !keep {
                        return;
                    }
                }
                // The stream ended (a dropped connection): the next sync starts it again.
                let _ = this.update(cx, |view, _| {
                    if view.worktree.generation == generation {
                        view.worktree.stream = None;
                    }
                });
            })
            .detach();
        }
        self.refresh_worktree_row(cx);
    }

    /// Takes a snapshot from the stream; an older one than the card has is dropped.
    fn apply_worktree_snapshot(
        &mut self,
        snapshot: WorktreeSetupSnapshot,
        cx: &mut Context<'_, Self>,
    ) {
        if self.worktree.snapshot.as_ref().is_some_and(|current| {
            current.thread_id == snapshot.thread_id && current.sequence > snapshot.sequence
        }) {
            return;
        }
        let was_running = self.worktree.running();
        self.worktree.snapshot = Some(snapshot);
        if !self.worktree.running() {
            self.worktree.tick = None;
        } else if !was_running {
            self.worktree.tick = Some(cx.spawn(async move |this, cx| {
                loop {
                    cx.background_executor().timer(Duration::from_secs(1)).await;
                    if this.update(cx, |_, cx| cx.notify()).is_err() {
                        return;
                    }
                }
            }));
        }
        self.refresh_worktree_row(cx);
    }

    fn agent_ran(&self) -> bool {
        self.run_timings
            .values()
            .any(|timing| timing.started_at_ms.is_some())
    }

    /// Shows, moves or removes the card to match the snapshot, and measures it again when what it
    /// shows changed.
    fn refresh_worktree_row(&mut self, cx: &mut Context<'_, Self>) {
        let agent_ran = self.agent_ran();
        let fingerprint = self
            .worktree
            .snapshot
            .as_ref()
            .filter(|snapshot| worktree_visible(snapshot, agent_ran))
            .map(|snapshot| {
                let mut hasher = DefaultHasher::new();
                format!(
                    "{snapshot:?}|{}|{}",
                    self.worktree.details_open, self.worktree.cancelling
                )
                .hash(&mut hasher);
                hasher.finish()
            });
        if self.cache.set_worktree_setup(fingerprint) {
            self.resync_timeline();
        }
        cx.notify();
    }

    /// Applies the list changes of a card that came, went or changed.
    fn resync_timeline(&mut self) {
        let stats = self.cache.resync(
            &self.entry_timings,
            &self.turn_checkpoints,
            self.working,
            self.has_more_history,
            self.loading_earlier,
        );
        if stats.old_item_count == 0 {
            self.list_state.reset(stats.new_item_count);
            self.list_state.set_follow_mode(FollowMode::Tail);
            self.list_state.scroll_to_end();
        } else if stats.splice_start < stats.splice_old_end
            || stats.splice_start < stats.splice_new_end
        {
            self.list_state.splice(
                stats.splice_start..stats.splice_old_end,
                stats.splice_new_end - stats.splice_start,
            );
        }
    }

    fn toggle_worktree_details(&mut self, cx: &mut Context<'_, Self>) {
        self.worktree.details_open = !self.worktree.details_open;
        self.refresh_worktree_row(cx);
    }

    /// Asks the server to stop the setup (`worktreeSetup.cancel`).
    fn cancel_worktree_setup(&mut self, cx: &mut Context<'_, Self>) {
        let (Some(connection), Some(snapshot)) =
            (self.connection.clone(), self.worktree.snapshot.as_ref())
        else {
            return;
        };
        if snapshot.phase != ProjectClonePhase::Running || self.worktree.cancelling {
            return;
        }
        let thread_id = snapshot.thread_id.clone();
        self.worktree.cancelling = true;
        self.refresh_worktree_row(cx);
        cx.spawn(async move |this, cx| {
            let _ = connection
                .call_json(
                    "worktreeSetup.cancel",
                    serde_json::json!({ "threadId": thread_id }),
                )
                .await;
            let _ = this.update(cx, |view, cx| {
                view.worktree.cancelling = false;
                view.refresh_worktree_row(cx);
            });
        })
        .detach();
    }

    // -----------------------------------------------------------------------------------------
    // The card
    // -----------------------------------------------------------------------------------------

    pub(super) fn render_worktree_setup_row(&self, cx: &mut Context<'_, Self>) -> AnyElement {
        let Some(snapshot) = self.worktree.snapshot.as_ref() else {
            return div().into_any_element();
        };
        let colors = card_colors(&self.tokens, CardFace::Plain);
        let fg = hsla(self.tokens.foreground);
        let muted = hsla(self.tokens.muted_foreground);
        let destructive = hsla(self.tokens.destructive);
        let now = super::now_epoch_ms();
        let running = snapshot.phase == ProjectClonePhase::Running;
        let script_failed = snapshot
            .stages
            .iter()
            .any(|stage| stage.status == WorktreeSetupStageStatus::Failed);
        let total = elapsed_ms(
            Some(&snapshot.started_at),
            snapshot.ended_at.as_deref(),
            running,
            now,
        )
        .map(conn_state::format_duration);

        let (state_label, status): (&str, AnyElement) = match snapshot.phase {
            ProjectClonePhase::Running => (
                "running",
                TurningArc::new(CARD_ICON_PX, muted).into_any_element(),
            ),
            ProjectClonePhase::Done if script_failed => (
                "ready, setup script failed",
                icons::icon(icons::CLOSE, 16.0, hsla(self.tokens.warning)).into_any_element(),
            ),
            ProjectClonePhase::Done => (
                "ready",
                icons::icon(icons::CHECK, 16.0, muted).into_any_element(),
            ),
            ProjectClonePhase::Failed => (
                "failed",
                icons::icon(icons::CLOSE, 16.0, destructive).into_any_element(),
            ),
            ProjectClonePhase::Cancelled => (
                "cancelled",
                icons::icon(icons::CLOSE, 16.0, muted).into_any_element(),
            ),
        };

        let mut right = div().flex().flex_row().items_center().flex_none().child(
            div()
                .size(px(24.0))
                .flex()
                .items_center()
                .justify_center()
                .child(status),
        );
        if let Some(total) = total {
            right = right.child(
                div()
                    .pr(px(6.0))
                    .text_size(px(CARD_TEXT_PX))
                    .line_height(px(ROW_LINE_PX))
                    .text_color(muted)
                    .child(total),
            );
        }
        let header = card_header(true)
            .child(icons::icon(BRANCH, CARD_ICON_PX, muted))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .text_size(px(CARD_TEXT_PX))
                    .line_height(px(ROW_LINE_PX))
                    .text_color(muted)
                    .child("Worktree setup"),
            )
            .child(right);

        let script_name = snapshot
            .setup_script
            .as_ref()
            .map(|script| script.name.as_str());
        let mut list = div().flex().flex_col().gap(px(5.0));
        for stage in &snapshot.stages {
            list = list.child(self.render_worktree_stage(
                stage,
                running,
                snapshot.ended_at.as_deref(),
                script_name,
                now,
            ));
            if shows_output(stage) {
                list = list.child(self.render_worktree_output(stage));
            }
        }

        let mut body = card_body(colors)
            .flex()
            .flex_col()
            .gap(px(6.0))
            .text_size(px(CARD_TEXT_PX))
            .line_height(px(ROW_LINE_PX))
            .text_color(fg)
            .child(list);
        if snapshot.phase == ProjectClonePhase::Failed
            && let Some(error) = snapshot.error.as_deref().filter(|error| !error.is_empty())
        {
            body = body.child(div().text_color(muted).child(error.to_owned()));
        }
        let mut actions = div()
            .flex()
            .flex_row()
            .flex_wrap()
            .items_center()
            .gap(px(2.0))
            .ml(px(-8.0))
            .child(
                self.ghost_button(
                    "worktree-details",
                    if self.worktree.details_open {
                        "Hide details"
                    } else {
                        "Details"
                    },
                    true,
                    cx,
                )
                .on_click(cx.listener(|view, _, _, cx| view.toggle_worktree_details(cx))),
            );
        if running {
            actions = actions.child(
                self.ghost_button(
                    "worktree-cancel",
                    if self.worktree.cancelling {
                        "Cancelling…"
                    } else {
                        "Cancel"
                    },
                    !self.worktree.cancelling,
                    cx,
                )
                .on_click(cx.listener(|view, _, _, cx| view.cancel_worktree_setup(cx))),
            );
        }
        body = body.child(actions);
        if self.worktree.details_open {
            body = body.child(self.render_worktree_details(snapshot));
        }

        let card = card_shell(colors)
            .id(SharedString::from("worktree-setup"))
            .a11y_group(
                "chat.worktree-setup",
                format!("Worktree setup, {state_label}"),
            )
            .child(header)
            .child(body);
        div()
            .w_full()
            .min_w_0()
            .pb(px(12.0))
            .child(card)
            .into_any_element()
    }

    /// One stage: its glyph, its name, a note, and how long it took.
    fn render_worktree_stage(
        &self,
        stage: &WorktreeSetupStage,
        setup_running: bool,
        setup_ended_at: Option<&str>,
        script_name: Option<&str>,
        now_ms: i64,
    ) -> AnyElement {
        let fg = hsla(self.tokens.foreground);
        let muted = hsla(self.tokens.muted_foreground);
        let warning = hsla(self.tokens.warning);
        let destructive = hsla(self.tokens.destructive);
        let (glyph, text): (AnyElement, Hsla) = match stage.status {
            WorktreeSetupStageStatus::Done => (
                icons::icon(icons::CHECK, CARD_ICON_PX, muted).into_any_element(),
                fg,
            ),
            WorktreeSetupStageStatus::Running => {
                (TurningArc::new(CARD_ICON_PX, muted).into_any_element(), fg)
            }
            WorktreeSetupStageStatus::Failed => (
                icons::icon(icons::CLOSE, CARD_ICON_PX, destructive).into_any_element(),
                destructive,
            ),
            WorktreeSetupStageStatus::Warning => (
                icons::icon("superhero/warning.svg", CARD_ICON_PX, warning).into_any_element(),
                warning,
            ),
            WorktreeSetupStageStatus::Skipped => (
                icons::icon("superhero/remove.svg", CARD_ICON_PX, muted).into_any_element(),
                muted,
            ),
            WorktreeSetupStageStatus::Pending => (
                icons::icon("superhero/circle.svg", CARD_ICON_PX, muted.opacity(0.4))
                    .into_any_element(),
                muted.opacity(0.4),
            ),
        };
        let took = match stage.status {
            WorktreeSetupStageStatus::Skipped | WorktreeSetupStageStatus::Pending => None,
            // A stage the setup's end cut short stops with it.
            _ => elapsed_ms(
                stage.started_at.as_deref(),
                stage.ended_at.as_deref().or(setup_ended_at),
                setup_running,
                now_ms,
            )
            .map(conn_state::format_duration),
        };
        let mut row = div()
            .id(SharedString::from(format!("worktree-stage-{:?}", stage.id)))
            .flex()
            .flex_row()
            .items_center()
            .gap(px(6.0))
            .child(glyph)
            .child(
                div()
                    .min_w_0()
                    .truncate()
                    .text_color(text)
                    .child(stage_label(stage.id, script_name)),
            )
            .child(div().flex_1());
        if let Some(note) = stage_trailing(stage) {
            row = row.child(
                div()
                    .min_w_0()
                    .max_w(px(220.0))
                    .truncate()
                    .text_color(muted)
                    .child(note),
            );
        }
        if let Some(took) = took {
            row = row.child(div().flex_none().text_color(muted).child(took));
        }
        row.into_any_element()
    }

    /// The setup script's last lines, in a box that keeps its height.
    fn render_worktree_output(&self, stage: &WorktreeSetupStage) -> AnyElement {
        let failed = stage.status == WorktreeSetupStageStatus::Failed;
        div()
            .ml(px(20.0))
            .px(px(10.0))
            .py(px(6.0))
            .rounded(px(6.0))
            .border_1()
            .border_color(hsla_alpha(self.tokens.border, 0.80))
            .bg(hsla(self.tokens.code_background))
            .font_family(MONO_FONT_FAMILY)
            .text_size(px(12.0))
            .line_height(px(18.0))
            .text_color(if failed {
                hsla(self.tokens.destructive)
            } else {
                hsla(self.tokens.muted_foreground)
            })
            .children(output_slots(&stage.tail).into_iter().map(|line| {
                let text = if line.is_empty() { "\u{a0}" } else { line };
                div().truncate().child(text.to_owned())
            }))
            .into_any_element()
    }

    /// Branch, base, path and setup command, as the web card's Details lists them.
    fn render_worktree_details(&self, snapshot: &WorktreeSetupSnapshot) -> AnyElement {
        let muted = hsla(self.tokens.muted_foreground);
        let command = snapshot
            .setup_script
            .as_ref()
            .map(|script| script.command.as_str());
        let mut details = div().flex().flex_col().gap(px(2.0)).text_size(px(12.0));
        for (name, value) in [
            ("Branch", snapshot.branch.as_deref()),
            ("Base", snapshot.base_ref.as_deref()),
            ("Path", snapshot.worktree_path.as_deref()),
            ("Setup", command),
        ] {
            let Some(value) = value.filter(|value| !value.is_empty()) else {
                continue;
            };
            details = details.child(
                div()
                    .flex()
                    .flex_row()
                    .gap(px(12.0))
                    .child(div().w(px(44.0)).flex_none().text_color(muted).child(name))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .font_family(MONO_FONT_FAMILY)
                            .text_color(muted)
                            .child(value.to_owned()),
                    ),
            );
        }
        details.into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stage(id: WorktreeSetupStageId, status: WorktreeSetupStageStatus) -> WorktreeSetupStage {
        WorktreeSetupStage {
            id,
            status,
            started_at: None,
            ended_at: None,
            percent: None,
            detail: None,
            tail: Vec::new(),
        }
    }

    fn snapshot(
        phase: ProjectClonePhase,
        stages: Vec<WorktreeSetupStage>,
    ) -> WorktreeSetupSnapshot {
        WorktreeSetupSnapshot {
            thread_id: "t".to_owned(),
            phase,
            started_at: "2026-11-24T10:00:00.000Z".to_owned(),
            ended_at: None,
            branch: None,
            base_ref: None,
            worktree_path: None,
            setup_script: None,
            stages,
            error: None,
            sequence: 1,
        }
    }

    #[test]
    fn a_finished_setup_leaves_once_the_agent_ran_unless_a_stage_failed() {
        let ok = snapshot(
            ProjectClonePhase::Done,
            vec![stage(
                WorktreeSetupStageId::SetupScript,
                WorktreeSetupStageStatus::Done,
            )],
        );
        assert!(worktree_visible(&ok, false));
        assert!(!worktree_visible(&ok, true));
        let failed_stage = snapshot(
            ProjectClonePhase::Done,
            vec![stage(
                WorktreeSetupStageId::SetupScript,
                WorktreeSetupStageStatus::Failed,
            )],
        );
        assert!(worktree_visible(&failed_stage, true));
        for phase in [
            ProjectClonePhase::Running,
            ProjectClonePhase::Failed,
            ProjectClonePhase::Cancelled,
        ] {
            assert!(worktree_visible(&snapshot(phase, Vec::new()), true));
        }
    }

    #[test]
    fn clocks_run_to_the_end_or_to_now_while_live() {
        let start = Some("2026-11-24T10:00:00.000Z");
        assert_eq!(
            elapsed_ms(start, Some("2026-11-24T10:00:04.000Z"), false, 0),
            Some(4_000)
        );
        let now = conn_state::parse_iso8601_epoch_ms("2026-11-24T10:00:02.500Z").expect("a date");
        assert_eq!(elapsed_ms(start, None, true, now), Some(2_500));
        assert_eq!(elapsed_ms(start, None, false, now), None);
        assert_eq!(elapsed_ms(None, None, true, now), None);
    }

    #[test]
    fn stages_are_named_and_noted_as_the_web_card_does() {
        assert_eq!(
            stage_label(WorktreeSetupStageId::Fetch, None),
            "Fetch base branch"
        );
        assert_eq!(
            stage_label(WorktreeSetupStageId::SetupScript, Some("bun install")),
            "bun install"
        );
        let mut checkout = stage(
            WorktreeSetupStageId::Checkout,
            WorktreeSetupStageStatus::Running,
        );
        checkout.percent = Some(42);
        assert_eq!(stage_trailing(&checkout).as_deref(), Some("42%"));
        let skipped = stage(
            WorktreeSetupStageId::Submodules,
            WorktreeSetupStageStatus::Skipped,
        );
        assert_eq!(stage_trailing(&skipped).as_deref(), Some("skipped"));
        let pending = stage(
            WorktreeSetupStageId::Agent,
            WorktreeSetupStageStatus::Pending,
        );
        assert_eq!(stage_trailing(&pending), None);
    }

    #[test]
    fn the_output_box_keeps_four_lines_with_the_newest_at_the_bottom() {
        let tail: Vec<String> = ["a", "b"].iter().map(|line| (*line).to_owned()).collect();
        assert_eq!(output_slots(&tail), ["", "", "a", "b"]);
        let long: Vec<String> = ["1", "2", "3", "4", "5"]
            .iter()
            .map(|line| (*line).to_owned())
            .collect();
        assert_eq!(output_slots(&long), ["2", "3", "4", "5"]);
        let mut script = stage(
            WorktreeSetupStageId::SetupScript,
            WorktreeSetupStageStatus::Running,
        );
        assert!(!shows_output(&script));
        script.tail = tail;
        assert!(shows_output(&script));
        script.status = WorktreeSetupStageStatus::Failed;
        script.tail.clear();
        assert!(shows_output(&script));
    }
}
