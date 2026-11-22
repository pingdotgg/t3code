//! Interactive timeline cards and message chrome ported 1:1 from Conn:
//!
//! - `ComposerPendingUserInputPanel.tsx`: question picker (rendered inline in the timeline,
//!   since the composer is owned by another surface), plus answered-question history.
//! - `SecretRequestCard.tsx`: masked secret form and its settled `WorkLogRow`.
//! - `ProposedPlanCard.tsx`: plan badge, title, copy action, collapse with fade.
//! - `V2LifecycleRow.tsx` `SubagentTimelineLink`: clickable subagent row.
//! - `ChangedFilesTree.tsx` `ChangedFilesCard`: sticky header + collapsible directory tree.
//! - `TimelineUserMessageRow.tsx` / `TimelineAssistantRows.tsx`: hover action bars with
//!   day-aware timestamps (`timestampFormat.ts`), Copy, and Fork.

use std::collections::HashMap;
use std::time::Duration;

use conn_state::{
    LocalDateTime, PLAN_PREVIEW_MAX_LINES, SecretRequestStatus, TimelineEntry,
    TurnCheckpointSummary, TurnItemStatus, UserInputAnswer, UserInputDraft, UserInputQuestion,
    build_turn_diff_tree, build_user_input_answers, collapsed_plan_preview, flatten_turn_diff_tree,
    format_chat_timestamp_tooltip, format_day_aware_timestamp, normalize_plan_markdown_for_export,
    plan_can_collapse, strip_displayed_plan_markdown, subagent_status_visual,
};
use conn_theme::Appearance;
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    AnyElement, AppContext as _, ClipboardItem, Context, Entity, FontWeight, Hsla,
    InteractiveElement, IntoElement, ParentElement, SharedString, StatefulInteractiveElement,
    Styled, Subscription, Task, Window, div, px, relative,
};

use super::color::{hsla, hsla_alpha, muted_icon, prose_foreground};
use super::{
    BODY_FONT_PX, BODY_LINE_HEIGHT_PX, ChatEvent, ChatView, MONO_FONT_FAMILY, UI_FONT_PX,
    UI_LINE_HEIGHT_PX, icons, markdown,
};
use crate::a11y::ConnA11yExt as _;
use crate::panels::chrome::ConnTooltipExt as _;

/// Conn's single-select auto-advance delay after picking an option.
const AUTO_ADVANCE_DELAY: Duration = Duration::from_millis(200);
/// Conn's `ANCHORED_COPY_TOAST_TIMEOUT_MS`: how long a Copy button shows its check.
const COPY_CONFIRM_DURATION: Duration = Duration::from_millis(1_000);
/// Conn's `SECRET_REQUEST_DEFAULT_PLACEHOLDER`.
const SECRET_DEFAULT_PLACEHOLDER: &str = "Paste the secret";
/// Conn's changed-files row indent per depth (`4 + depth * 14`).
const TREE_INDENT_PX: f32 = 14.0;

/// Local state of one pending question card.
pub(super) struct UserInputCardState {
    pub(super) question_index: usize,
    pub(super) drafts: HashMap<String, UserInputDraft>,
    pub(super) collapsed: bool,
    pub(super) responding: bool,
    pub(super) error: Option<String>,
    /// Free-text answer field for the active question (when custom answers are allowed).
    custom_input: Option<(String, Entity<InputState>, Subscription)>,
    _auto_advance: Option<Task<()>>,
}

impl UserInputCardState {
    fn new() -> Self {
        Self {
            question_index: 0,
            drafts: HashMap::new(),
            collapsed: false,
            responding: false,
            error: None,
            custom_input: None,
            _auto_advance: None,
        }
    }
}

/// Local state of one pending secret form.
pub(super) struct SecretFormState {
    input: Entity<InputState>,
    pub(super) submitting: bool,
    pub(super) error: Option<String>,
    _subscription: Subscription,
}

/// Lazily fetched detail of a tool row whose output the snapshot omitted.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum DetailFetch {
    Loading,
    Loaded(Option<String>),
    Failed(String),
}

/// Returns local wall-clock time for Unix ms (falls back to UTC).
fn local_datetime(epoch_ms: i64) -> LocalDateTime {
    #[cfg(unix)]
    {
        let raw_time = epoch_ms.div_euclid(1_000) as libc::time_t;
        let mut local_tm = std::mem::MaybeUninit::<libc::tm>::zeroed();
        // SAFETY: `raw_time` is a valid `time_t` by value and `local_tm` is valid writable
        // stack storage; `localtime_r` is thread-safe and returns null on failure.
        let ptr = unsafe { libc::localtime_r(&raw_time, local_tm.as_mut_ptr()) };
        if !ptr.is_null() {
            // SAFETY: `localtime_r` succeeded and initialized `local_tm`.
            let tm = unsafe { local_tm.assume_init() };
            return LocalDateTime::from_epoch_ms(epoch_ms, tm.tm_gmtoff);
        }
    }
    LocalDateTime::from_epoch_ms(epoch_ms, 0)
}

/// Day-aware label and full tooltip for an ISO timestamp (`formatDayAwareTimestamp` +
/// `formatChatTimestampTooltip`).
pub(super) fn timestamp_labels(iso: &str) -> Option<(String, String)> {
    let at = local_datetime(conn_state::parse_iso8601_epoch_ms(iso)?);
    let now = local_datetime(super::now_epoch_ms());
    Some((
        format_day_aware_timestamp(at, now),
        format_chat_timestamp_tooltip(at),
    ))
}

impl ChatView {
    // -----------------------------------------------------------------------------------------
    // Shared chrome
    // -----------------------------------------------------------------------------------------

    /// Copies `text` and shows the check on the button keyed `key` for one second.
    pub(super) fn copy_with_confirmation(
        &mut self,
        key: String,
        text: String,
        cx: &mut Context<'_, Self>,
    ) {
        cx.write_to_clipboard(ClipboardItem::new_string(text));
        self.copied_message_key = Some(key.clone());
        self._copy_reset = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(COPY_CONFIRM_DURATION).await;
            let _ = this.update(cx, |view, cx| {
                if view.copied_message_key.as_deref() == Some(key.as_str()) {
                    view.copied_message_key = None;
                    cx.notify();
                }
            });
        }));
        cx.notify();
    }

    /// Conn `MessageCopyButton` (`size="xs" variant="ghost"`): copy icon, check while copied.
    pub(super) fn render_copy_button(
        &self,
        key: &str,
        label: &'static str,
        text: String,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let copied = self.copied_message_key.as_deref() == Some(key);
        let fg = hsla(self.tokens.foreground);
        let muted = hsla(self.tokens.muted_foreground);
        let hover_bg = hsla(self.tokens.shell_highlight);
        let icon_color = if copied {
            hsla(self.tokens.primary)
        } else {
            muted
        };
        let key_owned = key.to_owned();
        div()
            .id(SharedString::from(format!("copy-{key}")))
            .a11y_button(SharedString::from(format!("chat.copy.{key}")), label)
            .flex()
            .items_center()
            .justify_center()
            .size(px(24.0))
            .rounded(px(6.0))
            .cursor_pointer()
            .hover(move |s| s.bg(hover_bg).text_color(fg))
            .on_click(cx.listener(move |view, _, _, cx| {
                view.copy_with_confirmation(key_owned.clone(), text.clone(), cx);
            }))
            .conn_tooltip(if copied { "Copied" } else { label }, &self.tokens)
            .child(icons::icon(
                if copied { icons::CHECK } else { icons::COPY },
                12.0,
                icon_color,
            ))
            .into_any_element()
    }

    /// Conn's hover timestamp: `text-xs tabular-nums text-muted-foreground` + full tooltip.
    pub(super) fn render_timestamp(&self, key: &str, iso: Option<&str>) -> Option<AnyElement> {
        let (label, tooltip) = timestamp_labels(iso?)?;
        Some(
            div()
                .id(SharedString::from(format!("ts-{key}")))
                .a11y(
                    gpui_kit::Role::Label,
                    format!("chat.timestamp.{key}"),
                    format!("Sent {tooltip}"),
                )
                .flex_none()
                .whitespace_nowrap()
                .text_size(px(12.0))
                .line_height(px(16.0))
                .text_color(hsla(self.tokens.muted_foreground))
                .conn_tooltip(tooltip, &self.tokens)
                .child(label)
                .into_any_element(),
        )
    }

    /// Attachment chips/thumbnails shown in user and queued bubbles.
    pub(super) fn render_attachment_chips(
        &self,
        key: &str,
        attachments: &[conn_contract::ChatAttachment],
    ) -> AnyElement {
        let muted = hsla(self.tokens.muted_foreground);
        let mut row = div()
            .flex()
            .flex_row()
            .flex_wrap()
            .items_center()
            .gap(px(6.0));
        for (idx, att) in attachments.iter().enumerate() {
            let chip_id = (SharedString::from(format!("att-{key}")), idx);
            let chip = match att {
                conn_contract::ChatAttachment::Image(img) => div()
                    .id(chip_id)
                    .flex()
                    .items_center()
                    .justify_center()
                    .size(px(32.0))
                    .rounded(px(6.0))
                    .bg(hsla_alpha(self.tokens.muted, 0.60))
                    .border_1()
                    .border_color(hsla_alpha(self.tokens.border, 0.70))
                    .conn_tooltip(img.name.clone(), &self.tokens)
                    .child(icons::icon(icons::IMAGE, 14.0, muted)),
                conn_contract::ChatAttachment::File(file) => {
                    let file_icon = crate::file_icons::file_icon(&file.name);
                    let icon_color = file_icon
                        .color
                        .map(|c| hsla(c.for_appearance(self.tokens.appearance)))
                        .unwrap_or(muted);
                    self.attachment_pill(chip_id, file.name.clone())
                        .child(icons::icon(file_icon.asset, 12.0, icon_color))
                        .child(div().min_w_0().truncate().child(file.name.clone()))
                }
                conn_contract::ChatAttachment::Unknown(unknown) => self
                    .attachment_pill(chip_id, unknown.name.clone())
                    .child(div().min_w_0().truncate().child(unknown.name.clone())),
            };
            let name = match att {
                conn_contract::ChatAttachment::Image(img) => &img.name,
                conn_contract::ChatAttachment::File(file) => &file.name,
                conn_contract::ChatAttachment::Unknown(unknown) => &unknown.name,
            };
            row = row.child(chip.a11y_group(
                format!("chat.attachment.{key}.{idx}"),
                format!("Attachment {name}"),
            ));
        }
        row.into_any_element()
    }

    fn attachment_pill(
        &self,
        id: (SharedString, usize),
        name: String,
    ) -> gpui_kit::Stateful<gpui_kit::Div> {
        div()
            .id(id)
            .flex()
            .flex_row()
            .items_center()
            .gap(px(4.0))
            .h(px(24.0))
            .max_w(px(200.0))
            .px(px(8.0))
            .rounded(px(6.0))
            .bg(hsla_alpha(self.tokens.muted, 0.45))
            .border_1()
            .border_color(hsla_alpha(self.tokens.border, 0.70))
            .text_size(px(12.0))
            .line_height(px(16.0))
            .text_color(hsla(self.tokens.muted_foreground))
            .conn_tooltip(name, &self.tokens)
    }

    /// Conn `UserMessageIntentMarker`: `Redo2` + `Steer` above a steering bubble.
    pub(super) fn render_steer_marker(&self, id: &str) -> AnyElement {
        let muted = hsla(self.tokens.muted_foreground);
        div()
            .id(SharedString::from(format!("steer-{id}")))
            .a11y_group(format!("chat.steer.{id}"), "Steered the active turn")
            .mr(px(4.0))
            .mb(px(4.0))
            .flex()
            .flex_row()
            .items_center()
            .justify_end()
            .gap(px(4.0))
            .text_size(px(12.0))
            .line_height(px(12.0))
            .text_color(muted)
            .conn_tooltip("Steered the active turn", &self.tokens)
            .child(icons::icon(icons::REDO, 12.0, muted))
            .child("Steer")
            .into_any_element()
    }

    /// Conn `messageActions` under a user bubble: timestamp + Copy, revealed on row hover.
    pub(super) fn render_user_actions(
        &self,
        id: &str,
        text: &str,
        created_at: Option<&str>,
        group: &SharedString,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let mut actions = div()
            .id(SharedString::from(format!("user-actions-{id}")))
            .a11y_group(format!("chat.user.{id}.actions"), "Message actions")
            .flex()
            .flex_row()
            .items_center()
            .justify_end()
            .gap(px(8.0))
            .opacity(0.0)
            .group_hover(group.clone(), |s| s.opacity(1.0));
        if let Some(ts) = self.render_timestamp(&format!("user-{id}"), created_at) {
            actions = actions.child(ts);
        }
        if !text.trim().is_empty() {
            actions = actions.child(self.render_copy_button(
                &format!("user-{id}"),
                "Copy message",
                text.to_owned(),
                cx,
            ));
        }
        actions.into_any_element()
    }

    /// Conn `AssistantMessageMeta`: non-completed status badge, Copy, Fork from this response,
    /// and the day-aware timestamp, revealed on hover.
    #[expect(
        clippy::too_many_arguments,
        reason = "mirrors the Conn component props one to one"
    )]
    pub(super) fn render_assistant_meta(
        &self,
        id: &str,
        markdown: &str,
        status: conn_state::ItemStatus,
        run_id: Option<&str>,
        created_at: Option<&str>,
        group: &SharedString,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let muted = hsla(self.tokens.muted_foreground);
        let fg = hsla(self.tokens.foreground);
        let hover_bg = hsla(self.tokens.shell_highlight);
        let mut meta = div()
            .id(SharedString::from(format!("assistant-actions-{id}")))
            .a11y_group(format!("chat.assistant.{id}.actions"), "Message actions")
            .mt(px(6.0))
            .flex()
            .flex_row()
            .items_center()
            .gap(px(8.0))
            .opacity(0.0)
            .group_hover(group.clone(), |s| s.opacity(1.0));
        if status != conn_state::ItemStatus::Completed {
            let label = match status {
                conn_state::ItemStatus::Running => "running",
                conn_state::ItemStatus::Failed => "failed",
                conn_state::ItemStatus::Completed => "completed",
            };
            meta = meta.child(
                div()
                    .id(SharedString::from(format!("assistant-status-{id}")))
                    .a11y(
                        gpui_kit::Role::Status,
                        format!("chat.assistant.{id}.status"),
                        format!("Message {label}"),
                    )
                    .px(px(6.0))
                    .py(px(2.0))
                    .rounded_full()
                    .border_1()
                    .border_color(hsla_alpha(self.tokens.border, 0.70))
                    .font_family(MONO_FONT_FAMILY)
                    .text_size(px(10.0))
                    .line_height(px(12.0))
                    .text_color(muted)
                    .child(label),
            );
        }
        if !markdown.trim().is_empty() {
            meta = meta.child(self.render_copy_button(
                &format!("assistant-{id}"),
                "Copy message",
                markdown.to_owned(),
                cx,
            ));
        }
        // `canForkProjectedAssistantItem`: completed assistant messages with a run.
        if status == conn_state::ItemStatus::Completed
            && let Some(run_id) = run_id
        {
            let run_id = run_id.to_owned();
            meta = meta.child(
                div()
                    .id(SharedString::from(format!("fork-{id}")))
                    .a11y_button(
                        SharedString::from(format!("chat.fork.{id}")),
                        "Fork from this response",
                    )
                    .flex()
                    .items_center()
                    .justify_center()
                    .size(px(24.0))
                    .rounded(px(6.0))
                    .cursor_pointer()
                    .hover(move |s| s.bg(hover_bg).text_color(fg))
                    .on_click(cx.listener(move |_, _, _, cx| {
                        cx.emit(ChatEvent::ForkFromRun {
                            run_id: run_id.clone(),
                        });
                    }))
                    .conn_tooltip("Fork from this response", &self.tokens)
                    .child(icons::icon(icons::FORK, 12.0, muted)),
            );
        }
        if let Some(ts) = self.render_timestamp(&format!("assistant-{id}"), created_at) {
            meta = meta.child(ts);
        }
        meta.into_any_element()
    }

    // -----------------------------------------------------------------------------------------
    // Card inputs (created during render, where a `Window` exists)
    // -----------------------------------------------------------------------------------------

    /// Creates input fields for pending question and secret cards and drops stale ones.
    pub(super) fn ensure_card_inputs(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        let pending = self.pending_card_ids.clone();
        self.secret_forms.retain(|id, _| pending.contains(id));
        self.user_input_cards.retain(|id, _| pending.contains(id));
        for id in pending {
            let Some(entry) = self
                .cache
                .rows()
                .iter()
                .find(|row| row.entry.id() == id)
                .map(|row| row.entry.clone())
            else {
                continue;
            };
            match entry {
                TimelineEntry::SecretRequest { placeholder, .. } => {
                    if self.secret_forms.contains_key(&id) {
                        continue;
                    }
                    let placeholder =
                        placeholder.unwrap_or_else(|| SECRET_DEFAULT_PLACEHOLDER.to_owned());
                    let input = cx.new(|cx| {
                        InputState::new(window, cx)
                            .masked(true)
                            .placeholder(placeholder)
                    });
                    let entry_id = id.clone();
                    let subscription = cx.subscribe_in(
                        &input,
                        window,
                        move |view, _, event: &InputEvent, _, cx| match event {
                            InputEvent::PressEnter { .. } => {
                                view.submit_secret(&entry_id, false, cx);
                            }
                            InputEvent::Change => cx.notify(),
                            _ => {}
                        },
                    );
                    self.secret_forms.insert(
                        id,
                        SecretFormState {
                            input,
                            submitting: false,
                            error: None,
                            _subscription: subscription,
                        },
                    );
                }
                TimelineEntry::UserInputRequest { questions, .. } => {
                    let state = self
                        .user_input_cards
                        .entry(id.clone())
                        .or_insert_with(UserInputCardState::new);
                    let index = state.question_index.min(questions.len().saturating_sub(1));
                    let Some(question) = questions.get(index) else {
                        continue;
                    };
                    if !question.allow_custom_answer {
                        state.custom_input = None;
                        continue;
                    }
                    if state
                        .custom_input
                        .as_ref()
                        .is_some_and(|(qid, _, _)| *qid == question.id)
                    {
                        continue;
                    }
                    let initial = state
                        .drafts
                        .get(&question.id)
                        .and_then(|d| d.custom.clone())
                        .or_else(|| question.initial_answer.clone())
                        .unwrap_or_default();
                    let input = cx.new(|cx| {
                        InputState::new(window, cx)
                            .placeholder("Type your own answer")
                            .default_value(initial)
                    });
                    let entry_id = id.clone();
                    let question_for_sub = question.clone();
                    let subscription = cx.subscribe_in(
                        &input,
                        window,
                        move |view, input, event: &InputEvent, _, cx| match event {
                            InputEvent::Change => {
                                let text = input.read(cx).value().to_string();
                                view.set_user_input_custom(&entry_id, &question_for_sub, &text, cx);
                            }
                            InputEvent::PressEnter { .. } => {
                                view.advance_user_input(&entry_id, cx);
                            }
                            _ => {}
                        },
                    );
                    state.custom_input = Some((question.id.clone(), input, subscription));
                }
                _ => {}
            }
        }
    }

    // -----------------------------------------------------------------------------------------
    // Pending user input
    // -----------------------------------------------------------------------------------------

    fn user_input_questions(&self, entry_id: &str) -> Option<(String, Vec<UserInputQuestion>)> {
        self.cache.rows().iter().find_map(|row| match &row.entry {
            TimelineEntry::UserInputRequest {
                id,
                request_id,
                questions,
                ..
            } if id == entry_id => Some((request_id.clone(), questions.clone())),
            _ => None,
        })
    }

    fn select_user_input_option(
        &mut self,
        entry_id: &str,
        question: &UserInputQuestion,
        value: &str,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        let Some(state) = self.user_input_cards.get_mut(entry_id) else {
            return;
        };
        if state.responding {
            return;
        }
        let next = question.toggle_option(state.drafts.get(&question.id), value);
        state.drafts.insert(question.id.clone(), next);
        // A picked option replaces any typed answer.
        if let Some((_, input, _)) = &state.custom_input {
            let input = input.clone();
            input.update(cx, |field, cx| field.set_value("", window, cx));
        }
        if !question.multi_select {
            let entry_id = entry_id.to_owned();
            state._auto_advance = Some(cx.spawn(async move |this, cx| {
                cx.background_executor().timer(AUTO_ADVANCE_DELAY).await;
                let _ = this.update(cx, |view, cx| view.advance_user_input(&entry_id, cx));
            }));
        }
        self.remeasure_for_id(entry_id);
        cx.notify();
    }

    fn set_user_input_custom(
        &mut self,
        entry_id: &str,
        question: &UserInputQuestion,
        text: &str,
        cx: &mut Context<'_, Self>,
    ) {
        if let Some(state) = self.user_input_cards.get_mut(entry_id) {
            let next = question.set_custom_answer(state.drafts.get(&question.id), text);
            state.drafts.insert(question.id.clone(), next);
            cx.notify();
        }
    }

    /// Moves to the next question once the active one is answered; submits on the last one.
    fn advance_user_input(&mut self, entry_id: &str, cx: &mut Context<'_, Self>) {
        let Some((_, questions)) = self.user_input_questions(entry_id) else {
            return;
        };
        let Some(state) = self.user_input_cards.get_mut(entry_id) else {
            return;
        };
        state._auto_advance = None;
        let index = state.question_index.min(questions.len().saturating_sub(1));
        let Some(question) = questions.get(index) else {
            return;
        };
        if question
            .resolve_answer(state.drafts.get(&question.id))
            .is_none()
        {
            return;
        }
        if index + 1 < questions.len() {
            state.question_index = index + 1;
            self.remeasure_for_id(entry_id);
            cx.notify();
        } else {
            self.submit_user_input(entry_id, cx);
        }
    }

    fn go_back_user_input(&mut self, entry_id: &str, cx: &mut Context<'_, Self>) {
        if let Some(state) = self.user_input_cards.get_mut(entry_id)
            && state.question_index > 0
        {
            state.question_index -= 1;
            state._auto_advance = None;
            self.remeasure_for_id(entry_id);
            cx.notify();
        }
    }

    /// Sends every answer with `runtime-request.respond`.
    fn submit_user_input(&mut self, entry_id: &str, cx: &mut Context<'_, Self>) {
        let Some((request_id, questions)) = self.user_input_questions(entry_id) else {
            return;
        };
        let (Some(connection), Some(thread_id)) = (self.connection.clone(), self.thread_id.clone())
        else {
            return;
        };
        let Some(state) = self.user_input_cards.get_mut(entry_id) else {
            return;
        };
        if state.responding {
            return;
        }
        let Some(answers) = build_user_input_answers(&questions, &state.drafts) else {
            return;
        };
        let answers: serde_json::Map<String, serde_json::Value> = answers
            .into_iter()
            .map(|(qid, value)| (qid, value.to_json()))
            .collect();
        let command = match crate::commands::respond_user_input(&thread_id, &request_id, &answers) {
            Ok(command) => command,
            Err(err) => {
                state.error = Some(format!("Could not build the answer: {err}"));
                cx.notify();
                return;
            }
        };
        state.responding = true;
        state.error = None;
        let entry_id = entry_id.to_owned();
        cx.spawn(async move |this, cx| {
            let result = connection.dispatch_command(command).await;
            let _ = this.update(cx, |view, cx| {
                if let Some(state) = view.user_input_cards.get_mut(&entry_id) {
                    state.responding = false;
                    if let Err(err) = result {
                        state.error = Some(crate::commands::format_client_error(&err));
                    }
                }
                view.remeasure_for_id(&entry_id);
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    /// Dismisses a message-mode question (`thread.user-input.dismiss`).
    fn dismiss_user_input(&mut self, entry_id: &str, cx: &mut Context<'_, Self>) {
        let Some((request_id, _)) = self.user_input_questions(entry_id) else {
            return;
        };
        let (Some(connection), Some(thread_id)) = (self.connection.clone(), self.thread_id.clone())
        else {
            return;
        };
        let Ok(command) = crate::commands::dismiss_user_input(&thread_id, &request_id) else {
            return;
        };
        if let Some(state) = self.user_input_cards.get_mut(entry_id) {
            state.responding = true;
        }
        let entry_id = entry_id.to_owned();
        cx.spawn(async move |this, cx| {
            let result = connection.dispatch_command(command).await;
            let _ = this.update(cx, |view, cx| {
                if let Some(state) = view.user_input_cards.get_mut(&entry_id) {
                    state.responding = false;
                    if let Err(err) = result {
                        state.error = Some(crate::commands::format_client_error(&err));
                    }
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "mirrors the Conn component props one to one"
    )]
    pub(super) fn render_user_input_card(
        &self,
        id: &str,
        title: Option<&str>,
        questions: &[UserInputQuestion],
        pending: bool,
        status: TurnItemStatus,
        answers: &[UserInputAnswer],
        dismissible: bool,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        if !pending {
            return self.render_user_input_history(id, title, questions, status, answers, cx);
        }
        let Some(state) = self.user_input_cards.get(id) else {
            // Inputs are created on the next render pass.
            return div().h(px(24.0)).into_any_element();
        };
        let index = state.question_index.min(questions.len().saturating_sub(1));
        let Some(question) = questions.get(index) else {
            return div().into_any_element();
        };
        let draft = state.drafts.get(&question.id);
        let disabled = state.responding;
        let collapsed = state.collapsed;

        let fg = hsla(self.tokens.foreground);
        let muted = hsla(self.tokens.muted_foreground);
        let hover_bg = hsla(self.tokens.shell_highlight);

        // `ComposerBanner.Row` header: header text, `N/M`, chevron, optional dismiss.
        let toggle_id = id.to_owned();
        let mut header = div()
            .id(SharedString::from(format!("question-toggle-{id}")))
            .a11y_button(
                SharedString::from(format!("chat.question.toggle.{id}")),
                if collapsed {
                    "Show the question and its options"
                } else {
                    "Hide the question and its options"
                },
            )
            .aria_expanded(!collapsed)
            .flex()
            .flex_row()
            .items_center()
            .gap(px(8.0))
            .w_full()
            .min_w_0()
            .px(px(16.0))
            .pt(px(6.0))
            .pb(px(if collapsed { 6.0 } else { 0.0 }))
            .cursor_pointer()
            .text_size(px(UI_FONT_PX))
            .line_height(px(UI_LINE_HEIGHT_PX))
            .on_click(cx.listener(move |view, _, _, cx| {
                if let Some(state) = view.user_input_cards.get_mut(&toggle_id) {
                    state.collapsed = !state.collapsed;
                }
                view.remeasure_for_id(&toggle_id);
                cx.notify();
            }))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(6.0))
                    .flex_1()
                    .min_w_0()
                    .child(
                        div()
                            .min_w_0()
                            .truncate()
                            .text_color(muted)
                            .when(collapsed, |d| d.max_w(relative(0.5)))
                            .child(question.header.clone()),
                    )
                    .when(collapsed, |d| {
                        d.child(div().text_color(muted).child("·")).child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .truncate()
                                .text_color(prose_foreground(&self.tokens))
                                .child(question.question.clone()),
                        )
                    }),
            );
        if questions.len() > 1 {
            header = header.child(
                div()
                    .flex_none()
                    .text_size(px(12.0))
                    .text_color(muted)
                    .child(format!("{}/{}", index + 1, questions.len())),
            );
        }
        header = header.child(icons::icon(
            if collapsed {
                icons::CARET_RIGHT
            } else {
                icons::CARET_DOWN
            },
            12.0,
            muted_icon(&self.tokens),
        ));
        if dismissible {
            let dismiss_id = id.to_owned();
            header = header.child(
                div()
                    .id(SharedString::from(format!("question-dismiss-{id}")))
                    .a11y_button(
                        SharedString::from(format!("chat.question.dismiss.{id}")),
                        "Dismiss question without answering",
                    )
                    .flex()
                    .items_center()
                    .justify_center()
                    .size(px(22.0))
                    .rounded(px(6.0))
                    .when(!disabled, |d| {
                        d.cursor_pointer()
                            .hover(move |s| s.bg(hover_bg).text_color(fg))
                            .on_click(cx.listener(move |view, _, _, cx| {
                                cx.stop_propagation();
                                view.dismiss_user_input(&dismiss_id, cx);
                            }))
                    })
                    .conn_tooltip("Dismiss question without answering", &self.tokens)
                    .child(icons::icon(icons::CLOSE, 12.0, muted)),
            );
        }

        let mut card = div()
            .id(SharedString::from(format!("question-card-{id}")))
            .a11y(
                gpui_kit::Role::Group,
                SharedString::from(format!("chat.question.{id}")),
                question.header.clone(),
            )
            .flex()
            .flex_col()
            .w_full()
            .min_w_0()
            .rounded(px(14.0))
            .border_1()
            .border_color(hsla(self.tokens.shell_divider))
            .bg(hsla(self.tokens.shell_tile))
            .child(header);

        if !collapsed {
            let mut body = div()
                .flex()
                .flex_col()
                .w_full()
                .min_w_0()
                .pl(px(22.0))
                .pr(px(16.0))
                .pb(px(8.0));
            // Markdown-rendered question prompt (`text-foreground/85`, `pt-2`).
            body = body.child(
                div()
                    .pt(px(8.0))
                    .text_color(hsla_alpha(self.tokens.foreground, 0.85))
                    .child(markdown::render_markdown(
                        &format!("question-{id}-{}", question.id),
                        &question.question,
                        &self.tokens,
                        &markdown::MarkdownOptions::default(),
                    )),
            );
            let mut options = div().flex().flex_col().mt(px(6.0)).ml(px(-6.0));
            for (opt_idx, option) in question.options.iter().enumerate() {
                let value = option.answer_value().to_owned();
                let selected = question.is_option_selected(draft, &value);
                let entry_id = id.to_owned();
                let q = question.clone();
                let indicator: AnyElement = if question.multi_select {
                    self.render_checkbox_mark(selected)
                } else {
                    self.render_option_radio(selected)
                };
                let mut row = div()
                    .id((SharedString::from(format!("question-opt-{id}")), opt_idx))
                    .a11y_button(
                        SharedString::from(format!("chat.question.option.{id}.{opt_idx}")),
                        option.label.clone(),
                    )
                    .aria_selected(selected)
                    .flex()
                    .flex_row()
                    .items_start()
                    .gap(px(10.0))
                    .w_full()
                    .rounded(px(6.0))
                    .py(px(6.0))
                    .pl(px(6.0))
                    .text_color(if selected {
                        fg
                    } else {
                        hsla_alpha(self.tokens.foreground, 0.70)
                    })
                    .child(div().flex().items_center().h(px(20.0)).child(indicator))
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(2.0))
                            .flex_1()
                            .min_w_0()
                            .child(
                                div()
                                    .text_size(px(BODY_FONT_PX))
                                    .line_height(px(20.0))
                                    .font_weight(FontWeight::MEDIUM)
                                    .child(option.label.clone()),
                            )
                            .when(
                                !option.description.is_empty()
                                    && option.description != option.label,
                                |d| {
                                    d.child(
                                        div()
                                            .text_size(px(11.0))
                                            .line_height(px(14.0))
                                            .text_color(muted)
                                            .child(option.description.clone()),
                                    )
                                },
                            ),
                    );
                if disabled {
                    row = row.opacity(0.5);
                } else {
                    let hover = hsla_alpha(self.tokens.muted, 0.30);
                    row = row
                        .cursor_pointer()
                        .when(!selected, move |d| d.hover(move |s| s.bg(hover)))
                        .on_click(cx.listener(move |view, _, window, cx| {
                            view.select_user_input_option(&entry_id, &q, &value, window, cx);
                        }));
                }
                options = options.child(row);
            }
            body = body.child(options);

            if let Some((qid, input, _)) = &state.custom_input
                && *qid == question.id
            {
                body = body.child(
                    div()
                        .mt(px(6.0))
                        .w_full()
                        .child(Input::new(input).disabled(disabled)),
                );
            }

            if let Some(error) = &state.error {
                body = body.child(
                    div()
                        .mt(px(6.0))
                        .text_size(px(UI_FONT_PX))
                        .line_height(px(UI_LINE_HEIGHT_PX))
                        .text_color(hsla(self.tokens.destructive))
                        .child(error.clone()),
                );
            }

            // Back / Next / Submit actions.
            let answered = question.resolve_answer(draft).is_some();
            let is_last = index + 1 >= questions.len();
            let complete = build_user_input_answers(questions, &state.drafts).is_some();
            let mut actions = div()
                .mt(px(8.0))
                .flex()
                .flex_row()
                .items_center()
                .justify_end()
                .gap(px(6.0));
            if index > 0 {
                let back_id = id.to_owned();
                actions = actions.child(
                    self.ghost_button(&format!("question-back-{id}"), "Back", !disabled, cx)
                        .on_click(cx.listener(move |view, _, _, cx| {
                            view.go_back_user_input(&back_id, cx);
                        })),
                );
            }
            let primary_enabled = !disabled && if is_last { complete } else { answered };
            let primary_label = if disabled {
                "Sending…"
            } else if is_last {
                "Submit"
            } else {
                "Next"
            };
            let primary_id = id.to_owned();
            actions = actions.child(
                self.primary_button(
                    &format!("question-submit-{id}"),
                    primary_label,
                    primary_enabled,
                )
                .when(primary_enabled, |d| {
                    d.on_click(cx.listener(move |view, _, _, cx| {
                        view.advance_user_input(&primary_id, cx);
                    }))
                }),
            );
            body = body.child(actions);
            card = card.child(body);
        }

        div()
            .w_full()
            .min_w_0()
            .pb(px(12.0))
            .child(card)
            .into_any_element()
    }

    /// Answered or ended question: a `WorkLogRow` with each `question · answer`.
    fn render_user_input_history(
        &self,
        id: &str,
        title: Option<&str>,
        questions: &[UserInputQuestion],
        status: TurnItemStatus,
        answers: &[UserInputAnswer],
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let muted = hsla(self.tokens.muted_foreground);
        let label = if !answers.is_empty() {
            title.map_or_else(
                || {
                    if answers.len() == 1 {
                        "Answered a question".to_owned()
                    } else {
                        format!("Answered {} questions", answers.len())
                    }
                },
                str::to_owned,
            )
        } else {
            match status {
                TurnItemStatus::Cancelled | TurnItemStatus::Interrupted => {
                    "Question dismissed".to_owned()
                }
                TurnItemStatus::Failed => "Question failed".to_owned(),
                _ => title
                    .map(str::to_owned)
                    .or_else(|| questions.first().map(|q| q.header.clone()))
                    .unwrap_or_else(|| "Question".to_owned()),
            }
        };
        let key = format!("{id}:history");
        let expanded = self.expanded_ids.contains(&key);
        let has_body = !answers.is_empty();
        let toggle = key.clone();
        let mut line = self
            .work_log_line(&key, icons::CHAT_CIRCLE, &label, has_body, expanded)
            .when(has_body, |d| {
                d.on_click(cx.listener(move |view, _, _, cx| view.toggle_expanded(&toggle, cx)))
            });
        line = line.text_color(muted);
        let mut col = div()
            .flex()
            .flex_col()
            .w_full()
            .min_w_0()
            .pb(px(8.0))
            .child(line);
        if expanded {
            let mut list = div()
                .ml(px(28.0))
                .flex()
                .flex_col()
                .gap(px(6.0))
                .py(px(4.0))
                .text_size(px(UI_FONT_PX))
                .line_height(px(UI_LINE_HEIGHT_PX));
            for answer in answers {
                list = list.child(
                    div()
                        .flex()
                        .flex_col()
                        .child(div().text_color(muted).child(answer.question.clone()))
                        .child(div().text_color(prose_foreground(&self.tokens)).child(
                            if answer.answer.is_empty() {
                                "(no text)".to_owned()
                            } else {
                                answer.answer.clone()
                            },
                        )),
                );
            }
            col = col.child(list);
        }
        col.into_any_element()
    }

    /// Conn `OptionRadio`: `size-4` circle, primary fill with a foreground dot when checked.
    fn render_option_radio(&self, checked: bool) -> AnyElement {
        let mut radio = div()
            .flex()
            .items_center()
            .justify_center()
            .size(px(16.0))
            .flex_none()
            .rounded_full()
            .border_1();
        radio = if checked {
            radio
                .border_color(hsla(self.tokens.primary))
                .bg(hsla(self.tokens.primary))
                .child(
                    div()
                        .size(px(6.0))
                        .rounded_full()
                        .bg(hsla(self.tokens.primary_foreground)),
                )
        } else {
            radio
                .border_color(hsla(self.tokens.input))
                .bg(hsla(self.tokens.background))
        };
        radio.into_any_element()
    }

    /// Conn `CheckboxMark`: `size-4` rounded square, primary fill with a check when checked.
    fn render_checkbox_mark(&self, checked: bool) -> AnyElement {
        let mut mark = div()
            .flex()
            .items_center()
            .justify_center()
            .size(px(16.0))
            .flex_none()
            .rounded(px(4.0))
            .border_1();
        mark = if checked {
            mark.border_color(hsla(self.tokens.primary))
                .bg(hsla(self.tokens.primary))
                .child(icons::icon(
                    icons::CHECK,
                    12.0,
                    hsla(self.tokens.primary_foreground),
                ))
        } else {
            mark.border_color(hsla(self.tokens.input))
                .bg(hsla(self.tokens.background))
        };
        mark.into_any_element()
    }

    // -----------------------------------------------------------------------------------------
    // Secret requests
    // -----------------------------------------------------------------------------------------

    /// Saves (`decline == false`) or declines the secret via `secrets.answerRequest`.
    fn submit_secret(&mut self, entry_id: &str, decline: bool, cx: &mut Context<'_, Self>) {
        let (Some(connection), Some(thread_id)) = (self.connection.clone(), self.thread_id.clone())
        else {
            return;
        };
        let Some(form) = self.secret_forms.get_mut(entry_id) else {
            return;
        };
        if form.submitting {
            return;
        }
        let secret = (!decline).then(|| form.input.read(cx).value().to_string());
        let Some(payload) =
            crate::commands::secret_answer_payload(&thread_id, entry_id, secret.as_deref())
        else {
            return;
        };
        form.submitting = true;
        form.error = None;
        let entry_id = entry_id.to_owned();
        cx.spawn(async move |this, cx| {
            let result = connection
                .call_json(crate::commands::SECRETS_ANSWER_REQUEST, payload)
                .await;
            let _ = this.update(cx, |view, cx| {
                let Some(form) = view.secret_forms.get_mut(&entry_id) else {
                    return;
                };
                form.submitting = false;
                // `secretRequestFailureMessage`: never surface transport details.
                if let Err(err) = result {
                    let message = crate::commands::format_client_error(&err);
                    form.error = Some(if message.trim().is_empty() {
                        "Could not answer the request. Try again.".to_owned()
                    } else {
                        message
                    });
                }
                view.remeasure_for_id(&entry_id);
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "mirrors the Conn component props one to one"
    )]
    pub(super) fn render_secret_card(
        &self,
        id: &str,
        label: &str,
        reason: &str,
        url: Option<&str>,
        file_delivery: bool,
        status: SecretRequestStatus,
        pending: bool,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        if !pending {
            let (icon, display) = match status {
                SecretRequestStatus::Saved => (icons::CHECK, "Saved securely and kept private"),
                SecretRequestStatus::Declined => (icons::MINUS, "Declined"),
                SecretRequestStatus::Cancelled => (icons::MINUS, "Request ended"),
                SecretRequestStatus::Pending => {
                    (icons::LOCK, "Waiting for an answer in the original thread")
                }
            };
            return div()
                .w_full()
                .min_w_0()
                .pb(px(8.0))
                .child(
                    self.work_log_line(
                        &format!("secret-{id}"),
                        icon,
                        &format!("{label} · {display}"),
                        false,
                        false,
                    )
                    .text_color(hsla(self.tokens.muted_foreground)),
                )
                .into_any_element();
        }
        let Some(form) = self.secret_forms.get(id) else {
            return div().h(px(24.0)).into_any_element();
        };
        let fg = hsla(self.tokens.foreground);
        let muted = hsla(self.tokens.muted_foreground);
        let has_value = !form.input.read(cx).value().trim().is_empty();
        let submitting = form.submitting;

        let mut card = div()
            .id(SharedString::from(format!("secret-card-{id}")))
            .a11y(
                gpui_kit::Role::Group,
                SharedString::from(format!("chat.secret.{id}")),
                label.to_owned(),
            )
            .flex()
            .flex_col()
            .gap(px(12.0))
            .w_full()
            .min_w_0()
            .rounded(px(12.0))
            .border_1()
            .border_color(hsla(self.tokens.shell_divider))
            .bg(hsla(self.tokens.shell_tile))
            .p(px(16.0));

        let mut heading = div().flex().flex_col().gap(px(4.0)).min_w_0().child(
            div()
                .text_size(px(BODY_FONT_PX))
                .line_height(px(20.0))
                .font_weight(FontWeight::MEDIUM)
                .text_color(fg)
                .child(label.to_owned()),
        );
        if !reason.trim().is_empty() {
            heading = heading.child(
                div()
                    .text_size(px(BODY_FONT_PX))
                    .line_height(px(20.0))
                    .text_color(muted)
                    .child(reason.to_owned()),
            );
        }
        card = card.child(heading);

        let save_id = id.to_owned();
        card = card.child(
            div()
                .flex()
                .flex_row()
                .items_center()
                .gap(px(8.0))
                .min_w_0()
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .child(Input::new(&form.input).disabled(submitting)),
                )
                .child(
                    self.primary_button(
                        &format!("secret-save-{id}"),
                        "Save securely",
                        !submitting && has_value,
                    )
                    .when(!submitting && has_value, |d| {
                        d.on_click(cx.listener(move |view, _, _, cx| {
                            view.submit_secret(&save_id, false, cx);
                        }))
                    }),
                ),
        );

        if let Some(error) = &form.error {
            card = card.child(
                div()
                    .text_size(px(UI_FONT_PX))
                    .line_height(px(UI_LINE_HEIGHT_PX))
                    .text_color(hsla(self.tokens.destructive))
                    .child(error.clone()),
            );
        }

        let note = if file_delivery {
            "Kept out of chat, in a private file this agent's commands can read for 24 hours"
        } else {
            "Stored securely, never shown to the agent"
        };
        let mut footer_right = div().flex().flex_row().items_center().gap(px(4.0));
        if let Some(url) = url {
            let url = url.to_owned();
            footer_right = footer_right.child(
                self.ghost_button(&format!("secret-url-{id}"), "Open sign-in page", true, cx)
                    .child(icons::icon(icons::EXTERNAL_LINK, 12.0, muted))
                    .on_click(move |_, _, cx| cx.open_url(&url)),
            );
        }
        let decline_id = id.to_owned();
        footer_right = footer_right.child(
            self.ghost_button(&format!("secret-decline-{id}"), "Decline", !submitting, cx)
                .when(!submitting, |d| {
                    d.on_click(cx.listener(move |view, _, _, cx| {
                        view.submit_secret(&decline_id, true, cx);
                    }))
                }),
        );
        card = card.child(
            div()
                .flex()
                .flex_row()
                .items_center()
                .justify_between()
                .gap(px(8.0))
                .min_w_0()
                .child(
                    div()
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(px(6.0))
                        .min_w_0()
                        .text_size(px(UI_FONT_PX))
                        .line_height(px(UI_LINE_HEIGHT_PX))
                        .text_color(muted)
                        .child(icons::icon(icons::SHIELD_CHECK, 14.0, muted))
                        .child(div().min_w_0().child(note)),
                )
                .child(footer_right),
        );

        div()
            .w_full()
            .min_w_0()
            .pb(px(12.0))
            .child(card)
            .into_any_element()
    }

    // -----------------------------------------------------------------------------------------
    // Proposed plan
    // -----------------------------------------------------------------------------------------

    pub(super) fn render_plan_card(
        &self,
        id: &str,
        title: &str,
        plan_markdown: &str,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let key = format!("{id}:plan");
        let expanded = self.expanded_ids.contains(&key);
        let can_collapse = plan_can_collapse(plan_markdown);
        let is_collapsed = can_collapse && !expanded;
        let body_md = if is_collapsed {
            collapsed_plan_preview(plan_markdown, PLAN_PREVIEW_MAX_LINES)
        } else {
            strip_displayed_plan_markdown(plan_markdown)
        };
        let fg = hsla(self.tokens.foreground);
        let card_bg = hsla_alpha(self.tokens.card, 0.70);

        let options = self.markdown_options(cx);
        let mut body =
            div()
                .relative()
                .mt(px(16.0))
                .w_full()
                .min_w_0()
                .child(markdown::render_markdown(
                    id,
                    &body_md,
                    &self.tokens,
                    &options,
                ));
        if is_collapsed {
            body = body.max_h(px(416.0)).overflow_hidden().child(
                div()
                    .absolute()
                    .left_0()
                    .right_0()
                    .bottom_0()
                    .h(px(96.0))
                    .bg(gpui_kit::linear_gradient(
                        0.0,
                        gpui_kit::linear_color_stop(hsla_alpha(self.tokens.card, 0.95), 0.0),
                        gpui_kit::linear_color_stop(hsla_alpha(self.tokens.card, 0.0), 1.0),
                    )),
            );
        }

        let copy_text = normalize_plan_markdown_for_export(plan_markdown);
        let mut card = div()
            .id(SharedString::from(format!("plan-card-{id}")))
            .a11y(
                gpui_kit::Role::Article,
                SharedString::from(format!("chat.plan.{id}")),
                title.to_owned(),
            )
            .flex()
            .flex_col()
            .w_full()
            .min_w_0()
            .rounded(px(16.0))
            .border_1()
            .border_color(hsla_alpha(self.tokens.border, 0.80))
            .bg(card_bg)
            .p(px(16.0))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .flex_wrap()
                    .items_center()
                    .justify_between()
                    .gap(px(12.0))
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap(px(8.0))
                            .min_w_0()
                            .child(
                                div()
                                    .px(px(6.0))
                                    .rounded(px(6.0))
                                    .bg(hsla(self.tokens.secondary))
                                    .text_size(px(12.0))
                                    .line_height(px(18.0))
                                    .font_weight(FontWeight::MEDIUM)
                                    .text_color(hsla(self.tokens.secondary_foreground))
                                    .child("Plan"),
                            )
                            .child(
                                div()
                                    .min_w_0()
                                    .truncate()
                                    .text_size(px(BODY_FONT_PX))
                                    .line_height(px(20.0))
                                    .font_weight(FontWeight::MEDIUM)
                                    .text_color(fg)
                                    .child(title.to_owned()),
                            ),
                    )
                    .child(self.render_copy_button(
                        &format!("plan-{id}"),
                        "Copy to clipboard",
                        copy_text,
                        cx,
                    )),
            )
            .child(body);
        if can_collapse {
            let toggle = key;
            card = card.child(
                div().mt(px(16.0)).flex().justify_center().child(
                    self.outline_button(
                        &format!("plan-toggle-{id}"),
                        if expanded {
                            "Collapse plan"
                        } else {
                            "Expand plan"
                        },
                    )
                    .on_click(cx.listener(move |view, _, _, cx| view.toggle_expanded(&toggle, cx))),
                ),
            );
        }
        div()
            .w_full()
            .min_w_0()
            .pb(px(16.0))
            .child(card)
            .into_any_element()
    }

    // -----------------------------------------------------------------------------------------
    // Subagents (`V2LifecycleRow.tsx` `SubagentTimelineLink` + `TASK_CARD_FACE_CLASS`)
    // -----------------------------------------------------------------------------------------

    #[expect(
        clippy::too_many_arguments,
        reason = "mirrors the Conn component props one to one"
    )]
    pub(super) fn render_subagent_row(
        &self,
        id: &str,
        child_thread_id: Option<&str>,
        title: &str,
        role: &str,
        status: TurnItemStatus,
        summary: Option<&str>,
        remote_label: Option<&str>,
        started_at: Option<&str>,
        completed_at: Option<&str>,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let fg = hsla(self.tokens.foreground);
        let muted = hsla(self.tokens.muted_foreground);
        let (_tone, status_label) = subagent_status_visual(status);
        let dot: Option<Hsla> = match status {
            TurnItemStatus::Pending | TurnItemStatus::Running => Some(hsla(self.tokens.info)),
            TurnItemStatus::Waiting => Some(hsla_alpha(self.tokens.muted_foreground, 0.70)),
            TurnItemStatus::Completed => Some(hsla(self.tokens.success)),
            TurnItemStatus::Failed => Some(hsla(self.tokens.destructive)),
            TurnItemStatus::Idle | TurnItemStatus::Cancelled | TurnItemStatus::Interrupted => None,
        };
        let working = matches!(
            status,
            TurnItemStatus::Pending | TurnItemStatus::Running | TurnItemStatus::Waiting
        );
        let failed = status == TurnItemStatus::Failed;
        let detail_color = if failed {
            hsla(self.tokens.destructive)
        } else {
            muted
        };
        let elapsed = started_at
            .and_then(conn_state::parse_iso8601_epoch_ms)
            .and_then(|start| {
                let end = if conn_state::subagent_settled(status) {
                    completed_at.and_then(conn_state::parse_iso8601_epoch_ms)?
                } else {
                    super::now_epoch_ms()
                };
                u64::try_from(end - start).ok()
            })
            .map(conn_state::format_duration);

        let (card_fill, card_hover, ring_fill) = match self.tokens.appearance {
            Appearance::Dark => (
                hsla(
                    self.tokens
                        .shell_highlight
                        .with_alpha(self.tokens.shell_highlight.a * 0.70),
                ),
                hsla(self.tokens.shell_highlight),
                hsla(conn_theme::color_mix_srgb(
                    self.tokens.foreground,
                    0.056,
                    self.tokens.shell_card,
                )),
            ),
            Appearance::Light => (
                hsla(self.tokens.shell_card),
                hsla(
                    self.tokens
                        .shell_card
                        .with_alpha(self.tokens.shell_card.a * 0.70),
                ),
                hsla(self.tokens.shell_card),
            ),
        };

        // Line 1 (`gap-1.5 text-ui leading-5`): `StatusDotBadge` over `BotIcon` (`size-4`) + title.
        let mut lead_icon = div()
            .relative()
            .flex()
            .items_center()
            .flex_none()
            .child(icons::icon(icons::ROBOT, 16.0, muted));
        if let Some(dot_color) = dot {
            lead_icon = lead_icon.child(crate::panels::chrome::status_dot_cutout(
                dot_color, ring_fill, None, false,
            ));
        }
        let line1 = div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(6.0))
            .w_full()
            .min_w_0()
            .child(lead_icon)
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .text_size(px(UI_FONT_PX))
                    .line_height(px(UI_LINE_HEIGHT_PX))
                    .font_weight(if working {
                        FontWeight::NORMAL
                    } else {
                        FontWeight::MEDIUM
                    })
                    .text_color(fg)
                    .child(title.to_owned()),
            );

        // Line 2 (`ps-5.5 gap-1.5 text-ui leading-4 text-muted-foreground tabular-nums`):
        // plain `12px` provider mark + optional `on <remote>` + `<provider> · <elapsed/status>`.
        let provider_label = match role {
            "claudeAgent" | "claude" => "Claude",
            "codex" => "Codex",
            "antigravity" => "Antigravity",
            "opencode" => "OpenCode",
            other if !other.is_empty() => other,
            _ => "Subagent",
        };
        let time_text = elapsed.unwrap_or_else(|| status_label.to_owned());
        let mut line2 = div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(6.0))
            .pl(px(22.0))
            .min_w_0()
            .text_size(px(UI_FONT_PX))
            .line_height(px(16.0))
            .text_color(muted)
            .child(
                div()
                    .flex_none()
                    .child(crate::icons::provider_mark(role, 12.0, muted)),
            );
        if let Some(remote) = remote_label {
            line2 = line2.child(div().flex_none().child(format!("on {remote}")));
        }
        line2 = line2.child(
            div()
                .min_w_0()
                .truncate()
                .child(format!("{provider_label} · {time_text}")),
        );

        let mut card = div()
            .id(SharedString::from(format!("subagent-{id}")))
            .a11y_group(
                format!("chat.subagent.{id}"),
                format!("Subagent {title}, {status_label}"),
            )
            .flex()
            .flex_col()
            .gap(px(4.0))
            .w_full()
            .min_w_0()
            .rounded(px(8.0))
            .border_1()
            .border_color(hsla(self.tokens.shell_divider))
            .bg(card_fill)
            .px(px(9.0))
            .pt(px(10.0))
            .pb(px(12.0))
            .child(line1)
            .child(line2);

        if let Some(detail) = summary.map(str::trim).filter(|s| !s.is_empty()) {
            card = card.child(
                div()
                    .pl(px(22.0))
                    .text_size(px(UI_FONT_PX))
                    .line_height(px(16.0))
                    .text_color(detail_color)
                    .child(detail.to_owned()),
            );
        }

        if let Some(child) = child_thread_id {
            let child = child.to_owned();
            card = card
                .a11y_button(
                    SharedString::from(format!("chat.subagent.{id}")),
                    format!("Open {title}"),
                )
                .cursor_pointer()
                .hover(move |s| s.bg(card_hover))
                .on_click(cx.listener(move |_, _, _, cx| {
                    cx.emit(ChatEvent::OpenThread(child.clone()));
                }));
        }

        div()
            .w_full()
            .min_w_0()
            .pb(px(8.0))
            .child(card)
            .into_any_element()
    }

    // -----------------------------------------------------------------------------------------
    // Changed files
    // -----------------------------------------------------------------------------------------

    pub(super) fn render_changed_files_card(
        &self,
        cp: &TurnCheckpointSummary,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let run_id = cp.run_id.clone();
        let all_expanded = self.changed_files_expanded.contains(&run_id);
        let fg = hsla(self.tokens.foreground);
        let muted = hsla(self.tokens.muted_foreground);
        let hover_bg = hsla(self.tokens.shell_highlight);
        let added = hsla(self.tokens.diff_added);
        let removed = hsla(self.tokens.diff_removed);
        let surface = match self.tokens.appearance {
            conn_theme::Appearance::Dark => hsla_alpha(self.tokens.input, 0.20),
            conn_theme::Appearance::Light => hsla(self.tokens.secondary),
        };
        let label = if cp.file_count == 1 {
            "1 changed file".to_owned()
        } else {
            format!("{} changed files", cp.file_count)
        };
        let has_dirs = cp.files.iter().any(|f| f.path.contains(['/', '\\']));
        let first_path = cp.files.first().map(|f| f.path.clone());
        let ordinal = cp.app_run_ordinal;

        let stat = |additions: i64, deletions: i64| {
            div()
                .flex()
                .flex_row()
                .flex_none()
                .gap(px(6.0))
                .text_size(px(UI_FONT_PX))
                .line_height(px(18.0))
                .child(div().text_color(added).child(format!("+{additions}")))
                .child(div().text_color(removed).child(format!("-{deletions}")))
        };

        let mut header_left = div()
            .flex()
            .flex_row()
            .flex_wrap()
            .items_center()
            .gap_x(px(12.0))
            .min_w_0()
            .text_size(px(UI_FONT_PX))
            .line_height(px(UI_LINE_HEIGHT_PX))
            .font_weight(FontWeight::MEDIUM)
            .text_color(fg)
            .child(label.clone());
        if cp.additions != 0 || cp.deletions != 0 {
            header_left = header_left.child(stat(cp.additions, cp.deletions));
        }
        let mut header_right = div().flex().flex_row().items_center().gap(px(4.0));
        if has_dirs {
            let toggle_run = run_id.clone();
            let tip = if all_expanded {
                "Collapse all folders"
            } else {
                "Expand all folders"
            };
            header_right = header_right.child(
                div()
                    .id(SharedString::from(format!("cf-toggle-all-{run_id}")))
                    .a11y_button(
                        SharedString::from(format!("chat.changed-files.toggle.{run_id}")),
                        tip,
                    )
                    .flex()
                    .items_center()
                    .justify_center()
                    .size(px(24.0))
                    .rounded(px(6.0))
                    .cursor_pointer()
                    .hover(move |s| s.bg(hover_bg))
                    .on_click(cx.listener(move |view, _, _, cx| {
                        if !view.changed_files_expanded.remove(&toggle_run) {
                            view.changed_files_expanded.insert(toggle_run.clone());
                        }
                        view.changed_files_dir_overrides.remove(&toggle_run);
                        view.remeasure_for_id(&format!("changed-files:{toggle_run}"));
                        cx.notify();
                    }))
                    .conn_tooltip(tip, &self.tokens)
                    .child(icons::icon(
                        if all_expanded {
                            icons::CHEVRONS_DOWN_UP
                        } else {
                            icons::CHEVRONS_UP_DOWN
                        },
                        12.0,
                        muted,
                    )),
            );
        }
        let open_run = run_id.clone();
        let open_path = first_path.clone();
        header_right = header_right.child(
            div()
                .id(SharedString::from(format!("cf-open-diff-{run_id}")))
                .a11y_button(
                    SharedString::from(format!("chat.changed-files.{run_id}")),
                    format!("Open diff · {label}"),
                )
                .flex()
                .flex_row()
                .items_center()
                .gap(px(4.0))
                .h(px(24.0))
                .px(px(8.0))
                .rounded(px(6.0))
                .cursor_pointer()
                .text_size(px(UI_FONT_PX))
                .text_color(muted)
                .hover(move |s| s.bg(hover_bg).text_color(fg))
                .on_click(cx.listener(move |_, _, _, cx| {
                    cx.emit(ChatEvent::OpenTurnDiff {
                        run_id: open_run.clone(),
                        app_run_ordinal: ordinal,
                        file_path: open_path.clone(),
                    });
                }))
                .conn_tooltip("Open the full diff", &self.tokens)
                .child(icons::icon(icons::FILE_DIFF, 12.0, muted))
                .child("Open diff"),
        );

        let mut card = div()
            .id(SharedString::from(format!("changed-files-{run_id}")))
            .a11y_group(format!("chat.changed-files.{run_id}"), label)
            .flex()
            .flex_col()
            .w_full()
            .min_w_0()
            .rounded(px(14.0))
            .bg(surface)
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .justify_between()
                    .gap(px(8.0))
                    .pl(px(18.0))
                    .pr(px(10.0))
                    .pt(px(8.0))
                    .pb(px(4.0))
                    .child(header_left)
                    .child(header_right),
            );

        let tree = build_turn_diff_tree(&cp.files);
        let empty = HashMap::new();
        let overrides = self
            .changed_files_dir_overrides
            .get(&run_id)
            .unwrap_or(&empty);
        let rows = flatten_turn_diff_tree(&tree, overrides, all_expanded);
        let has_dir_nodes = tree.iter().any(|n| n.is_directory);
        let mut list = div().flex().flex_col().px(px(4.0)).pb(px(6.0));
        for (row_idx, row) in rows.iter().enumerate() {
            let left = 4.0 + row.depth as f32 * TREE_INDENT_PX;
            let mut el = div()
                .id((SharedString::from(format!("cf-row-{run_id}")), row_idx))
                .flex()
                .flex_row()
                .items_center()
                .gap(px(4.0))
                .h(px(28.0))
                .w_full()
                .min_w_0()
                .pl(px(left))
                .pr(px(10.0))
                .rounded(px(6.0))
                .cursor_pointer()
                .text_size(px(UI_FONT_PX))
                .line_height(px(18.0));
            if row.is_directory {
                let dir_run = run_id.clone();
                let dir_path = row.path.clone();
                let currently = row.expanded;
                el = el
                    .a11y_button(
                        SharedString::from(format!("chat.changed-files.dir.{run_id}.{row_idx}")),
                        row.name.clone(),
                    )
                    .aria_expanded(row.expanded)
                    .on_click(cx.listener(move |view, _, _, cx| {
                        view.changed_files_dir_overrides
                            .entry(dir_run.clone())
                            .or_default()
                            .insert(dir_path.clone(), !currently);
                        view.remeasure_for_id(&format!("changed-files:{dir_run}"));
                        cx.notify();
                    }))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .justify_center()
                            .size(px(16.0))
                            .flex_none()
                            .rounded(px(4.0))
                            .child(icons::icon(
                                if row.expanded {
                                    icons::CARET_DOWN
                                } else {
                                    icons::CARET_RIGHT
                                },
                                12.0,
                                muted,
                            )),
                    )
                    .child(
                        div()
                            .min_w_0()
                            .truncate()
                            .text_color(hsla_alpha(self.tokens.muted_foreground, 0.9))
                            .child(row.name.clone()),
                    );
            } else {
                let file_run = run_id.clone();
                let file_path = row.path.clone();
                let file_icon = crate::file_icons::file_icon(&row.name);
                let icon_color = file_icon
                    .color
                    .map(|c| hsla(c.for_appearance(self.tokens.appearance)))
                    .unwrap_or_else(|| hsla_alpha(self.tokens.muted_foreground, 0.7));
                let hover = hsla_alpha(self.tokens.accent, 0.60);
                el = el
                    .a11y_button(
                        SharedString::from(format!("chat.changed-files.file.{run_id}.{row_idx}")),
                        row.path.clone(),
                    )
                    .hover(move |s| s.bg(hover))
                    .on_click(cx.listener(move |_, _, _, cx| {
                        cx.emit(ChatEvent::OpenTurnDiff {
                            run_id: file_run.clone(),
                            app_run_ordinal: ordinal,
                            file_path: Some(file_path.clone()),
                        });
                    }))
                    .when(has_dir_nodes || row.depth > 0, |d| {
                        d.child(div().size(px(16.0)).flex_none())
                    })
                    .child(icons::icon(file_icon.asset, 14.0, icon_color))
                    .child(
                        div()
                            .min_w_0()
                            .truncate()
                            .text_color(hsla_alpha(self.tokens.foreground, 0.85))
                            .child(row.name.clone()),
                    );
            }
            if row.shows_stat() {
                el = el.child(div().ml_auto().child(stat(row.additions, row.deletions)));
            }
            list = list.child(el);
        }
        card = card.child(list);

        let hidden = cp.file_count.saturating_sub(cp.files.len());
        if hidden > 0 {
            let more_run = run_id.clone();
            let more_path = first_path;
            let more_label = if hidden == 1 {
                "1 more file in the full diff".to_owned()
            } else {
                format!("{hidden} more files in the full diff")
            };
            card = card.child(
                div().px(px(12.0)).pb(px(8.0)).child(
                    div()
                        .id(SharedString::from(format!("cf-more-{run_id}")))
                        .a11y_button(
                            format!("chat.changed-files.{run_id}.more"),
                            more_label.clone(),
                        )
                        .flex()
                        .items_center()
                        .h(px(24.0))
                        .px(px(8.0))
                        .rounded(px(6.0))
                        .cursor_pointer()
                        .text_size(px(UI_FONT_PX))
                        .text_color(muted)
                        .hover(move |s| s.bg(hover_bg).text_color(fg))
                        .on_click(cx.listener(move |_, _, _, cx| {
                            cx.emit(ChatEvent::OpenTurnDiff {
                                run_id: more_run.clone(),
                                app_run_ordinal: ordinal,
                                file_path: more_path.clone(),
                            });
                        }))
                        .child(more_label),
                ),
            );
        }

        div()
            .pt(px(16.0))
            .pb(px(4.0))
            .child(card)
            .into_any_element()
    }

    // -----------------------------------------------------------------------------------------
    // Lazy tool detail
    // -----------------------------------------------------------------------------------------

    /// Fetches a tool row's omitted output once (`orchestration.getTurnItem`).
    pub(super) fn fetch_omitted_detail(&mut self, entry_id: &str, cx: &mut Context<'_, Self>) {
        if self.fetched_details.contains_key(entry_id) {
            return;
        }
        let (Some(connection), Some(thread_id)) = (self.connection.clone(), self.thread_id.clone())
        else {
            return;
        };
        self.fetched_details
            .insert(entry_id.to_owned(), DetailFetch::Loading);
        let entry_id = entry_id.to_owned();
        cx.spawn(async move |this, cx| {
            let result = connection.get_turn_item(&thread_id, &entry_id, None).await;
            let _ = this.update(cx, |view, cx| {
                let state = match result {
                    Ok(item) => DetailFetch::Loaded(item.and_then(conn_state::turn_item_detail)),
                    Err(err) => DetailFetch::Failed(crate::commands::format_client_error(&err)),
                };
                view.fetched_details.insert(entry_id.clone(), state);
                view.remeasure_for_id(&entry_id);
                cx.notify();
            });
        })
        .detach();
    }

    // -----------------------------------------------------------------------------------------
    // Small building blocks
    // -----------------------------------------------------------------------------------------

    /// Conn `WorkLogRow`: 24px icon box + `text-sm` label, optional caret.
    fn work_log_line(
        &self,
        key: &str,
        icon: &'static str,
        label: &str,
        has_body: bool,
        expanded: bool,
    ) -> gpui_kit::Stateful<gpui_kit::Div> {
        let fg = hsla(self.tokens.foreground);
        let mut line = div()
            .id(SharedString::from(format!("log-{key}")))
            .flex()
            .flex_row()
            .items_center()
            .gap(px(6.0))
            .w_full()
            .min_w_0()
            .min_h(px(24.0))
            .px(px(2.0))
            .rounded(px(6.0))
            .text_size(px(BODY_FONT_PX))
            .line_height(px(BODY_LINE_HEIGHT_PX))
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_center()
                    .size(px(24.0))
                    .flex_none()
                    .child(icons::icon(icon, 14.0, muted_icon(&self.tokens))),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .overflow_hidden()
                    .text_ellipsis()
                    .whitespace_nowrap()
                    .child(label.to_owned()),
            );
        if has_body {
            line = line
                .cursor_pointer()
                .hover(move |s| s.text_color(fg))
                .child(icons::icon(
                    if expanded {
                        icons::CARET_DOWN
                    } else {
                        icons::CARET_RIGHT
                    },
                    12.0,
                    muted_icon(&self.tokens),
                ));
        }
        line
    }

    /// Conn `Button` default (primary) at `size="sm"`.
    pub(super) fn primary_button(
        &self,
        key: &str,
        label: &str,
        enabled: bool,
    ) -> gpui_kit::Stateful<gpui_kit::Div> {
        let bg = hsla(self.tokens.primary);
        let fg = hsla(self.tokens.primary_foreground);
        div()
            .id(SharedString::from(key.to_owned()))
            .a11y_button(SharedString::from(format!("chat.{key}")), label.to_owned())
            .flex()
            .flex_none()
            .items_center()
            .justify_center()
            .h(px(32.0))
            .px(px(12.0))
            .rounded(px(8.0))
            .bg(bg)
            .text_color(fg)
            .text_size(px(UI_FONT_PX))
            .font_weight(FontWeight::MEDIUM)
            .when(enabled, |d| d.cursor_pointer().hover(|s| s.opacity(0.9)))
            .when(!enabled, |d| d.opacity(0.5))
            .child(label.to_owned())
    }

    /// Conn `Button variant="ghost-muted" size="xs"`.
    pub(super) fn ghost_button(
        &self,
        key: &str,
        label: &str,
        enabled: bool,
        _cx: &mut Context<'_, Self>,
    ) -> gpui_kit::Stateful<gpui_kit::Div> {
        let fg = hsla(self.tokens.foreground);
        let hover_bg = hsla(self.tokens.shell_highlight);
        div()
            .id(SharedString::from(key.to_owned()))
            .a11y_button(SharedString::from(format!("chat.{key}")), label.to_owned())
            .flex()
            .flex_row()
            .flex_none()
            .items_center()
            .gap(px(4.0))
            .h(px(24.0))
            .px(px(8.0))
            .rounded(px(6.0))
            .text_size(px(UI_FONT_PX))
            .text_color(hsla(self.tokens.muted_foreground))
            .when(enabled, move |d| {
                d.cursor_pointer()
                    .hover(move |s| s.bg(hover_bg).text_color(fg))
            })
            .when(!enabled, |d| d.opacity(0.5))
            .child(label.to_owned())
    }

    /// Conn `Button variant="outline" size="sm"`.
    pub(super) fn outline_button(
        &self,
        key: &str,
        label: &str,
    ) -> gpui_kit::Stateful<gpui_kit::Div> {
        outline_button_surface(
            &self.tokens,
            SharedString::from(key.to_owned()),
            SharedString::from(format!("chat.{key}")),
            label.to_owned(),
        )
        .h(px(32.0))
        .px(px(12.0))
        .rounded(px(8.0))
        .text_size(px(UI_FONT_PX))
        .child(label.to_owned())
    }
}

/// Colors and behavior of Conn `Button variant="outline"`: `border-input`, `bg-popover`
/// (`dark:bg-input/32`), hover `bg-accent/50` (`dark:bg-input/64`). Callers add size and content.
pub(super) fn outline_button_surface(
    tokens: &conn_theme::Tokens,
    id: SharedString,
    ax_id: SharedString,
    label: String,
) -> gpui_kit::Stateful<gpui_kit::Div> {
    let dark = tokens.appearance == Appearance::Dark;
    let (bg, hover_bg) = if dark {
        (
            hsla_alpha(tokens.input, tokens.input.a * 0.32),
            hsla_alpha(tokens.input, tokens.input.a * 0.64),
        )
    } else {
        (hsla(tokens.popover), hsla_alpha(tokens.accent, 0.5))
    };
    div()
        .id(id)
        .a11y_button(ax_id, label)
        .flex()
        .flex_row()
        .items_center()
        .justify_center()
        .border_1()
        .border_color(hsla(tokens.input))
        .bg(bg)
        .cursor_pointer()
        .font_weight(FontWeight::MEDIUM)
        .text_color(hsla(tokens.foreground))
        .hover(move |s| s.bg(hover_bg))
}
