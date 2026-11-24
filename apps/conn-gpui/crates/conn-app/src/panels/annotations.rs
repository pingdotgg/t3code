//! Shared Browser & Device Annotation Queue popover, viewport pin overlay, and click-to-annotate
//! inline comment composer (with Operator voice dictation).
//!
//! Mirrors Conn's `apps/web/src/annotations/{AnnotationQueuePopover.tsx,annotationQueue.ts}` using
//! `conn-state` pure queue reducers and `conn-theme` semantic tokens.

use std::rc::Rc;
use std::time::{SystemTime, UNIX_EPOCH};

use conn_desktop::operator::{DictationStart, DictationWait, OperatorClient};
use conn_state::{
    AnnotationCapture, AnnotationPinPoint, AnnotationQueueCounts, AnnotationQueueState,
    AnnotationRecord, AnnotationRecordSource, DetectedDomElement, annotation_state,
    count_annotations,
};
use conn_theme::{Appearance, Tokens};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::*;
use gpui_kit::{
    AnyElement, BoxShadow, Context, Entity, FontWeight, MouseButton, MouseDownEvent, ParentElement,
    SharedString, Styled, Subscription, Window, deferred, div, point, px,
};

use super::chrome::{self, ConnTooltipExt as _};
use super::color::to_hsla;
use super::header::superhero_icon;
use crate::a11y::ConnA11yExt as _;

const UI_TEXT_PX: f32 = 13.0;
const UI_LINE_HEIGHT_PX: f32 = 20.0;
const SM_TEXT_PX: f32 = 12.0;
const SM_LINE_HEIGHT_PX: f32 = 16.0;
const PIN_SIZE_PX: f32 = 22.0;
const POPOVER_WIDTH_PX: f32 = 348.0;
const COMPOSER_WIDTH_PX: f32 = 296.0;

/// Actions emitted by a panel's annotation controls up to `RightPanel` -> `ConnApp`.
#[derive(Clone, Debug)]
pub(crate) enum AnnotationAction {
    /// Persist a new annotation on the active project via `annotations.create`.
    Create(AnnotationCapture),
    /// Remove the given annotation ids via `annotations.remove`.
    Remove { ids: Vec<String> },
    /// Dispatch waiting annotations to the active thread with Conn's orchestrator prompt.
    SendWaiting,
    /// Toggle automatic Watch dispatch for the active thread.
    ToggleWatch,
}

/// Which surface the annotation overlay is mounted on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AnnotationSubject {
    Page,
    Device,
}

impl AnnotationSubject {
    fn noun(self) -> &'static str {
        match self {
            Self::Page => "page",
            Self::Device => "screen",
        }
    }

    fn id_prefix(self) -> &'static str {
        match self {
            Self::Page => "browser-ann",
            Self::Device => "device-ann",
        }
    }

    fn matches_record(self, record: &AnnotationRecord) -> bool {
        match self {
            Self::Page => record.source != Some(AnnotationRecordSource::Device),
            Self::Device => record.source == Some(AnnotationRecordSource::Device),
        }
    }
}

/// Coordinates (and optional detected DOM element) of an annotation currently being authored.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct PendingPinDraft {
    pub(crate) point: AnnotationPinPoint,
    /// Local pixel offset inside the viewport container (for placing the composer card).
    pub(crate) local_x: f32,
    pub(crate) local_y: f32,
    /// Exact DOM element detected under the cursor by the injected Browser detector script.
    pub(crate) detected: Option<DetectedDomElement>,
}

/// Operator voice dictation phase inside the inline annotation composer.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) enum AnnotationDictation {
    #[default]
    Idle,
    Starting(String),
    Recording(String),
    Transcribing(String),
}

impl AnnotationDictation {
    pub(crate) fn session_id(&self) -> Option<&str> {
        match self {
            Self::Idle => None,
            Self::Starting(id) | Self::Recording(id) | Self::Transcribing(id) => Some(id.as_str()),
        }
    }

    pub(crate) fn is_active(&self) -> bool {
        !matches!(self, Self::Idle)
    }
}

/// Reusable per-surface annotation UI state owned by `BrowserPanel` and `DevicePanel`.
pub(crate) struct AnnotationUiState {
    pub(crate) subject: AnnotationSubject,
    pub(crate) annotations: Vec<AnnotationRecord>,
    pub(crate) watching: bool,
    pub(crate) project_ready: bool,
    pub(crate) annotating: bool,
    pub(crate) queue_open: bool,
    pub(crate) confirming_remove: bool,
    pub(crate) pending_pin: Option<PendingPinDraft>,
    pub(crate) hovered_element: Option<DetectedDomElement>,
    pub(crate) comment_input: Entity<InputState>,
    pub(crate) dictation: AnnotationDictation,
    pub(crate) dictation_error: Option<String>,
    next_seq: u64,
    _input_sub: Subscription,
}

impl AnnotationUiState {
    pub(crate) fn new<V: 'static>(
        subject: AnnotationSubject,
        window: &mut Window,
        cx: &mut Context<'_, V>,
        on_submit: impl Fn(&mut V, &mut Window, &mut Context<'_, V>) + 'static,
    ) -> Self {
        let comment_input = cx.new(|cx| {
            InputState::new(window, cx).placeholder("Describe the change for the agent…")
        });
        let input_sub = cx.subscribe_in(
            &comment_input,
            window,
            move |view, _input, event: &InputEvent, window, cx| match event {
                InputEvent::PressEnter { .. } => on_submit(view, window, cx),
                InputEvent::Change => cx.notify(),
                _ => {}
            },
        );
        Self {
            subject,
            annotations: Vec::new(),
            watching: false,
            project_ready: false,
            annotating: false,
            queue_open: false,
            confirming_remove: false,
            pending_pin: None,
            hovered_element: None,
            comment_input,
            dictation: AnnotationDictation::Idle,
            dictation_error: None,
            next_seq: 1,
            _input_sub: input_sub,
        }
    }

    pub(crate) fn sync(
        &mut self,
        annotations: Vec<AnnotationRecord>,
        watching: bool,
        project_ready: bool,
    ) {
        self.annotations = annotations;
        self.watching = watching;
        self.project_ready = project_ready;
        if !project_ready {
            self.annotating = false;
            self.pending_pin = None;
            self.hovered_element = None;
            self.confirming_remove = false;
        }
    }

    #[must_use]
    pub(crate) fn counts(&self) -> AnnotationQueueCounts {
        count_annotations(&self.annotations)
    }

    pub(crate) fn toggle_annotating(&mut self) {
        if !self.project_ready {
            return;
        }
        self.annotating = !self.annotating;
        if self.annotating {
            self.queue_open = false;
            self.confirming_remove = false;
        } else {
            self.hovered_element = None;
            self.cancel_pin();
        }
    }

    pub(crate) fn toggle_queue(&mut self) {
        self.queue_open = !self.queue_open;
        if !self.queue_open {
            self.confirming_remove = false;
        }
    }

    pub(crate) fn begin_pin<V: 'static>(
        &mut self,
        draft: PendingPinDraft,
        window: &mut Window,
        cx: &mut Context<'_, V>,
    ) {
        self.queue_open = false;
        self.confirming_remove = false;
        self.dictation_error = None;
        self.pending_pin = Some(draft);
        self.comment_input.update(cx, |input, cx| {
            input.set_value("", window, cx);
            input.focus(window, cx);
        });
    }

    pub(crate) fn cancel_pin(&mut self) {
        if let Some(session_id) = self.dictation.session_id().map(str::to_owned) {
            self.dictation = AnnotationDictation::Idle;
            crate::live::RT.spawn(async move {
                if let Ok(client) = OperatorClient::from_config() {
                    let _ = client.cancel(&session_id).await;
                }
            });
        }
        self.dictation_error = None;
        self.pending_pin = None;
    }

    pub(crate) fn next_annotation_id(&mut self) -> String {
        let seq = self.next_seq;
        self.next_seq = self.next_seq.wrapping_add(1);
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX));
        format!("{}-{now_ms}-{seq}", self.subject.id_prefix())
    }

    pub(crate) fn next_dictation_session_id(&mut self) -> String {
        let seq = self.next_seq;
        self.next_seq = self.next_seq.wrapping_add(1);
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX));
        format!("conn-gpui-ann-{now_ms}-{seq}")
    }

    pub(crate) fn append_transcript<V: 'static>(
        &mut self,
        transcript: &str,
        window: &mut Window,
        cx: &mut Context<'_, V>,
    ) {
        let cleaned = transcript.trim();
        if cleaned.is_empty() {
            return;
        }
        let existing = self.comment_input.read(cx).value().to_string();
        let next = if existing.trim().is_empty() {
            cleaned.to_owned()
        } else if existing.ends_with(char::is_whitespace) {
            format!("{existing}{cleaned}")
        } else {
            format!("{existing} {cleaned}")
        };
        self.comment_input.update(cx, |input, cx| {
            input.set_value(next, window, cx);
            input.focus(window, cx);
        });
    }
}

/// Starts or stops Operator voice dictation for a host entity's [`AnnotationUiState`].
pub(crate) fn toggle_annotation_dictation<V: 'static>(
    window: &mut Window,
    cx: &mut Context<'_, V>,
    access: fn(&mut V) -> &mut AnnotationUiState,
) {
    let entity = cx.entity();
    let current = entity.update(cx, |view, _| access(view).dictation.clone());

    match current {
        AnnotationDictation::Idle => {
            let session_id = entity.update(cx, |view, cx| {
                let state = access(view);
                let sid = state.next_dictation_session_id();
                state.dictation = AnnotationDictation::Starting(sid.clone());
                state.dictation_error = None;
                cx.notify();
                sid
            });
            let sid_for_req = session_id.clone();
            cx.spawn_in(window, async move |this, cx| {
                let start_res = crate::live::RT
                    .spawn(async move {
                        let client = OperatorClient::from_config()?;
                        client.start(&sid_for_req).await
                    })
                    .await;
                let should_wait = this
                    .update_in(cx, |view, _window, cx| {
                        let state = access(view);
                        if state.dictation.session_id() != Some(session_id.as_str()) {
                            return false;
                        }
                        match start_res {
                            Ok(Ok(DictationStart::Started)) => {
                                state.dictation =
                                    AnnotationDictation::Recording(session_id.clone());
                                cx.notify();
                                true
                            }
                            Ok(Ok(DictationStart::Unsupported)) => {
                                state.dictation = AnnotationDictation::Idle;
                                state.dictation_error = Some(
                                    "Operator Local API session dictation is not supported."
                                        .to_owned(),
                                );
                                cx.notify();
                                false
                            }
                            Ok(Err(err)) => {
                                state.dictation = AnnotationDictation::Idle;
                                state.dictation_error = Some(err.to_string());
                                cx.notify();
                                false
                            }
                            Err(err) => {
                                state.dictation = AnnotationDictation::Idle;
                                state.dictation_error = Some(err.to_string());
                                cx.notify();
                                false
                            }
                        }
                    })
                    .unwrap_or(false);

                if !should_wait {
                    return;
                }

                // Wait for Operator's own stop/hotkey completion while recording.
                loop {
                    let sid_wait = session_id.clone();
                    let wait_res = crate::live::RT
                        .spawn(async move {
                            let client = OperatorClient::from_config()?;
                            client.wait(&sid_wait).await
                        })
                        .await;
                    match wait_res {
                        Ok(Ok(DictationWait::StillWaiting)) => {
                            let keep = this
                                .update(cx, |view, _| {
                                    matches!(
                                        &access(view).dictation,
                                        AnnotationDictation::Recording(active)
                                            if active == &session_id
                                    )
                                })
                                .unwrap_or(false);
                            if !keep {
                                break;
                            }
                        }
                        Ok(Ok(DictationWait::Transcript(text))) => {
                            let _ = this.update_in(cx, |view, window, cx| {
                                let state = access(view);
                                if matches!(
                                    &state.dictation,
                                    AnnotationDictation::Recording(active) if active == &session_id
                                ) {
                                    state.dictation = AnnotationDictation::Idle;
                                    state.append_transcript(&text, window, cx);
                                    cx.notify();
                                }
                            });
                            break;
                        }
                        Ok(Ok(DictationWait::Unsupported)) | Ok(Err(_)) | Err(_) => break,
                    }
                }
            })
            .detach();
        }
        AnnotationDictation::Recording(session_id) => {
            entity.update(cx, |view, cx| {
                access(view).dictation = AnnotationDictation::Transcribing(session_id.clone());
                cx.notify();
            });
            let sid_stop = session_id.clone();
            cx.spawn_in(window, async move |this, cx| {
                let stop_res = crate::live::RT
                    .spawn(async move {
                        let client = OperatorClient::from_config()?;
                        client.stop(&sid_stop).await
                    })
                    .await;
                let _ = this.update_in(cx, |view, window, cx| {
                    let state = access(view);
                    if state.dictation.session_id() != Some(session_id.as_str()) {
                        return;
                    }
                    state.dictation = AnnotationDictation::Idle;
                    match stop_res {
                        Ok(Ok(text)) => state.append_transcript(&text, window, cx),
                        Ok(Err(err)) => state.dictation_error = Some(err.to_string()),
                        Err(err) => state.dictation_error = Some(err.to_string()),
                    }
                    cx.notify();
                });
            })
            .detach();
        }
        AnnotationDictation::Starting(session_id)
        | AnnotationDictation::Transcribing(session_id) => {
            entity.update(cx, |view, cx| {
                let state = access(view);
                state.dictation = AnnotationDictation::Idle;
                state.dictation_error = None;
                cx.notify();
            });
            crate::live::RT.spawn(async move {
                if let Ok(client) = OperatorClient::from_config() {
                    let _ = client.cancel(&session_id).await;
                }
            });
        }
    }
}

/// Callbacks wired into the floating Annotation Queue popover.
pub(crate) struct QueuePopoverCallbacks {
    pub(crate) on_toggle_annotating: Rc<dyn Fn(&mut Window, &mut gpui_kit::App)>,
    pub(crate) on_send_waiting: Rc<dyn Fn(&mut Window, &mut gpui_kit::App)>,
    pub(crate) on_toggle_watch: Rc<dyn Fn(&mut Window, &mut gpui_kit::App)>,
    pub(crate) on_remove_ids: Rc<dyn Fn(Vec<String>, &mut Window, &mut gpui_kit::App)>,
    pub(crate) on_set_confirming_remove: Rc<dyn Fn(bool, &mut Window, &mut gpui_kit::App)>,
    pub(crate) on_close: Rc<dyn Fn(&mut Window, &mut gpui_kit::App)>,
}

/// Anchor placement for [`render_queue_popover`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum QueuePopoverAnchor {
    /// Below the right edge of the Browser toolbar trigger.
    BelowRight,
    /// Left of the Device floating controls rail.
    LeftOfRail,
}

/// Renders the Conn-styled floating Annotation Queue popover (`AnnotationQueuePopover.tsx`).
pub(crate) fn render_queue_popover(
    state: &AnnotationUiState,
    tokens: &Tokens,
    anchor: QueuePopoverAnchor,
    callbacks: QueuePopoverCallbacks,
) -> AnyElement {
    let counts = state.counts();
    let done_ids: Vec<String> = state
        .annotations
        .iter()
        .filter(|r| annotation_state(r) == AnnotationQueueState::Done)
        .map(|r| r.id.clone())
        .collect();
    let idle_ids: Vec<String> = state
        .annotations
        .iter()
        .filter(|r| annotation_state(r) != AnnotationQueueState::Working)
        .map(|r| r.id.clone())
        .collect();

    let popover_bg = to_hsla(tokens.popover);
    let fg = to_hsla(tokens.popover_foreground);
    let muted = to_hsla(tokens.muted_foreground);
    let border = to_hsla(tokens.border);
    let divider = to_hsla(tokens.glass_divider);
    let hover_bg = to_hsla(tokens.shell_highlight);
    let primary = to_hsla(tokens.primary);
    let primary_fg = to_hsla(tokens.primary_foreground);
    let success_fg = to_hsla(tokens.success_foreground);
    let warning_fg = to_hsla(tokens.warning_foreground);
    let destructive = to_hsla(tokens.destructive);
    let switch_on = to_hsla(tokens.switch_on);
    let switch_off = chrome::alpha(tokens.foreground, 0.18);

    let shadow_alpha = match tokens.appearance {
        Appearance::Dark => 0.36,
        Appearance::Light => 0.14,
    };
    let shadow = BoxShadow {
        color: gpui_kit::hsla(0.0, 0.0, 0.0, shadow_alpha),
        offset: point(px(0.0), px(8.0)),
        blur_radius: px(24.0),
        spread_radius: px(-4.0),
        inset: false,
    };

    let mut header_actions = h_flex().items_center().gap(px(4.0));
    if state.watching {
        header_actions = header_actions.child(
            div()
                .rounded(px(9999.0))
                .bg(chrome::alpha(tokens.success, 0.16))
                .px(px(7.0))
                .py(px(2.0))
                .text_size(px(11.0))
                .font_weight(FontWeight::MEDIUM)
                .text_color(success_fg)
                .child("Watching"),
        );
    }
    if !done_ids.is_empty() {
        let on_remove = callbacks.on_remove_ids.clone();
        let ids = done_ids.clone();
        header_actions = header_actions.child(
            div()
                .id("ann-queue-clear-done")
                .a11y_button(
                    "annotations.queue.clear-done",
                    format!("Clear {} done annotations", done_ids.len()),
                )
                .size(px(24.0))
                .rounded(px(6.0))
                .flex()
                .items_center()
                .justify_center()
                .cursor_pointer()
                .hover(move |s| s.bg(hover_bg))
                .conn_fast_tooltip(format!("Clear {} done", done_ids.len()), tokens)
                .on_click(move |_, window, cx| on_remove(ids.clone(), window, cx))
                .child(superhero_icon("superhero/clean.svg", 13.0, muted)),
        );
    }
    if !idle_ids.is_empty() {
        let on_confirm = callbacks.on_set_confirming_remove.clone();
        header_actions = header_actions.child(
            div()
                .id("ann-queue-remove-idle")
                .a11y_button(
                    "annotations.queue.remove-idle",
                    format!("Remove {} idle annotations", idle_ids.len()),
                )
                .size(px(24.0))
                .rounded(px(6.0))
                .flex()
                .items_center()
                .justify_center()
                .cursor_pointer()
                .hover(move |s| s.bg(hover_bg))
                .conn_fast_tooltip(format!("Remove {} not in progress", idle_ids.len()), tokens)
                .on_click(move |_, window, cx| on_confirm(true, window, cx))
                .child(superhero_icon("superhero/delete.svg", 13.0, muted)),
        );
    }
    {
        let on_close = callbacks.on_close.clone();
        header_actions = header_actions.child(
            div()
                .id("ann-queue-close")
                .a11y_button("annotations.queue.close", "Close annotations queue")
                .size(px(24.0))
                .rounded(px(6.0))
                .flex()
                .items_center()
                .justify_center()
                .cursor_pointer()
                .hover(move |s| s.bg(hover_bg))
                .on_click(move |_, window, cx| on_close(window, cx))
                .child(superhero_icon("superhero/close.svg", 13.0, muted)),
        );
    }

    let annotate_action_label = if state.annotating {
        "Stop annotating"
    } else if state.subject == AnnotationSubject::Page {
        "Annotate page"
    } else {
        "Annotate screen"
    };
    let on_toggle_annotating = callbacks.on_toggle_annotating.clone();

    let mut card = v_flex()
        .id("annotations-queue-popover")
        .a11y_group("annotations.queue.popover", "Annotations queue")
        .w(px(POPOVER_WIDTH_PX))
        .rounded(px(12.0))
        .bg(popover_bg)
        .border_1()
        .border_color(border)
        .text_color(fg)
        .shadow(vec![shadow])
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .child(
            h_flex()
                .items_start()
                .justify_between()
                .gap(px(8.0))
                .px(px(12.0))
                .pt(px(10.0))
                .pb(px(8.0))
                .child(
                    v_flex()
                        .min_w_0()
                        .flex_1()
                        .child(
                            div()
                                .text_size(px(UI_TEXT_PX))
                                .line_height(px(UI_LINE_HEIGHT_PX))
                                .font_weight(FontWeight::MEDIUM)
                                .child("Annotations"),
                        )
                        .child(
                            div()
                                .text_size(px(SM_TEXT_PX))
                                .line_height(px(SM_LINE_HEIGHT_PX))
                                .text_color(muted)
                                .child(if state.annotating {
                                    format!(
                                        "Click the {} to drop a pin · Esc to stop",
                                        state.subject.noun()
                                    )
                                } else {
                                    format!(
                                        "Pin feedback directly on the {}",
                                        state.subject.noun()
                                    )
                                }),
                        ),
                )
                .child(header_actions),
        )
        // Quick toggle row for starting/stopping annotation mode right from the popover.
        .child(
            div()
                .px(px(12.0))
                .pb(px(8.0))
                .child(
                    div()
                        .id("ann-queue-toggle-mode")
                        .a11y_button("annotations.queue.toggle-mode", annotate_action_label)
                        .h(px(28.0))
                        .w_full()
                        .rounded(px(7.0))
                        .px(px(10.0))
                        .flex()
                        .flex_row()
                        .items_center()
                        .justify_center()
                        .gap(px(6.0))
                        .text_size(px(SM_TEXT_PX))
                        .font_weight(FontWeight::MEDIUM)
                        .border_1()
                        .border_color(if state.annotating { primary } else { border })
                        .bg(if state.annotating {
                            chrome::alpha(tokens.primary, 0.16)
                        } else {
                            to_hsla(tokens.shell_control)
                        })
                        .text_color(if state.annotating { primary } else { fg })
                        .when(state.project_ready, |el| {
                            el.cursor_pointer()
                                .hover(move |s| s.bg(hover_bg))
                                .on_click(move |_, window, cx| on_toggle_annotating(window, cx))
                        })
                        .when(!state.project_ready, |el| el.opacity(0.5))
                        .child(superhero_icon(
                            "superhero/comment-text.svg",
                            13.0,
                            if state.annotating { primary } else { fg },
                        ))
                        .child(annotate_action_label),
                ),
        );

    if state.confirming_remove && !idle_ids.is_empty() {
        let on_cancel = callbacks.on_set_confirming_remove.clone();
        let on_remove = callbacks.on_remove_ids.clone();
        let count_idle = idle_ids.len();
        let noun = if count_idle == 1 {
            "annotation"
        } else {
            "annotations"
        };
        card = card.child(div().w_full().h(px(1.0)).bg(divider)).child(
            h_flex()
                .items_center()
                .justify_between()
                .gap(px(8.0))
                .px(px(12.0))
                .py(px(8.0))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .text_size(px(SM_TEXT_PX))
                        .line_height(px(SM_LINE_HEIGHT_PX))
                        .text_color(muted)
                        .child(format!(
                            "Remove {count_idle} {noun}? Work in progress stays."
                        )),
                )
                .child(
                    h_flex()
                        .flex_shrink_0()
                        .gap(px(4.0))
                        .child(
                            div()
                                .id("ann-remove-cancel")
                                .a11y_button("annotations.remove.cancel", "Cancel")
                                .px(px(8.0))
                                .py(px(4.0))
                                .rounded(px(6.0))
                                .text_size(px(SM_TEXT_PX))
                                .cursor_pointer()
                                .hover(move |s| s.bg(hover_bg))
                                .on_click(move |_, window, cx| on_cancel(false, window, cx))
                                .child("Cancel"),
                        )
                        .child(
                            div()
                                .id("ann-remove-confirm")
                                .a11y_button("annotations.remove.confirm", "Remove")
                                .px(px(8.0))
                                .py(px(4.0))
                                .rounded(px(6.0))
                                .bg(destructive)
                                .text_color(to_hsla(tokens.destructive_foreground))
                                .text_size(px(SM_TEXT_PX))
                                .font_weight(FontWeight::MEDIUM)
                                .cursor_pointer()
                                .on_click(move |_, window, cx| {
                                    on_remove(idle_ids.clone(), window, cx);
                                })
                                .child("Remove"),
                        ),
                ),
        );
    }

    card = card.child(div().w_full().h(px(1.0)).bg(divider));

    if !state.project_ready {
        card = card.child(
            div()
                .px(px(12.0))
                .py(px(12.0))
                .text_size(px(UI_TEXT_PX))
                .line_height(px(UI_LINE_HEIGHT_PX))
                .text_color(muted)
                .child("Select a thread to view or create project annotations."),
        );
    } else if state.annotations.is_empty() {
        card = card.child(
            div()
                .px(px(12.0))
                .py(px(12.0))
                .text_size(px(UI_TEXT_PX))
                .line_height(px(UI_LINE_HEIGHT_PX))
                .text_color(muted)
                .child(format!(
                    "No annotations yet. Click Annotate {}, then click anywhere on the {}.",
                    state.subject.noun(),
                    state.subject.noun(),
                )),
        );
    } else {
        let mut list = v_flex()
            .id("annotations-queue-list")
            .a11y_group("panel.annotations.queue", "Annotation queue")
            .max_h(px(260.0))
            .overflow_y_scroll()
            .p(px(6.0))
            .gap(px(2.0));

        for record in &state.annotations {
            let qstate = annotation_state(record);
            let number = record.number.0.round() as i64;
            let (badge_bg, badge_fg) = match qstate {
                AnnotationQueueState::Done => (to_hsla(tokens.muted), muted),
                AnnotationQueueState::Question => {
                    (to_hsla(tokens.warning), to_hsla(tokens.warning_foreground))
                }
                AnnotationQueueState::Waiting | AnnotationQueueState::Working => {
                    (primary, primary_fg)
                }
            };
            let (state_icon, state_label, state_color) = match qstate {
                AnnotationQueueState::Done => ("superhero/check.svg", "Done", success_fg),
                AnnotationQueueState::Working => ("superhero/spinner.svg", "Working", primary),
                AnnotationQueueState::Question => {
                    ("superhero/question.svg", "Question", warning_fg)
                }
                AnnotationQueueState::Waiting => ("superhero/circle-dot.svg", "Waiting", muted),
            };
            let mut subtitle = record
                .summary
                .as_deref()
                .or(record.element.as_deref())
                .or(record.pathname.as_deref())
                .unwrap_or("")
                .to_owned();
            if state.subject == AnnotationSubject::Page
                && record.source == Some(AnnotationRecordSource::Device)
            {
                if subtitle.is_empty() {
                    subtitle = "device".to_owned();
                } else {
                    subtitle.push_str(" · device");
                }
            } else if state.subject == AnnotationSubject::Device
                && record.source != Some(AnnotationRecordSource::Device)
            {
                if subtitle.is_empty() {
                    subtitle = "browser".to_owned();
                } else {
                    subtitle.push_str(" · browser");
                }
            }

            let mut row_right = h_flex().flex_shrink_0().items_center().gap(px(4.0)).child(
                h_flex()
                    .items_center()
                    .gap(px(3.0))
                    .text_size(px(11.0))
                    .text_color(state_color)
                    .child(superhero_icon(state_icon, 11.0, state_color))
                    .child(state_label),
            );
            if qstate != AnnotationQueueState::Working {
                let on_remove = callbacks.on_remove_ids.clone();
                let rid = record.id.clone();
                row_right = row_right.child(
                    div()
                        .id(SharedString::from(format!("ann-item-del-{rid}")))
                        .a11y_button(
                            SharedString::from(format!("annotations.item.{number}.remove")),
                            format!("Remove annotation #{number}"),
                        )
                        .size(px(20.0))
                        .rounded(px(5.0))
                        .flex()
                        .items_center()
                        .justify_center()
                        .cursor_pointer()
                        .hover(move |s| s.bg(hover_bg))
                        .on_click(move |_, window, cx| on_remove(vec![rid.clone()], window, cx))
                        .child(superhero_icon("superhero/close.svg", 11.0, muted)),
                );
            }

            let row = h_flex()
                .id(SharedString::from(format!("ann-row-{}", record.id)))
                .a11y_group(format!("panel.annotations.row.{}", record.id), "Annotation")
                .items_start()
                .gap(px(8.0))
                .rounded(px(8.0))
                .px(px(6.0))
                .py(px(6.0))
                .hover(move |s| s.bg(hover_bg))
                .child(
                    div()
                        .mt(px(1.0))
                        .size(px(18.0))
                        .flex_shrink_0()
                        .rounded(px(9999.0))
                        .bg(badge_bg)
                        .text_color(badge_fg)
                        .flex()
                        .items_center()
                        .justify_center()
                        .text_size(px(10.0))
                        .font_weight(FontWeight::SEMIBOLD)
                        .child(number.to_string()),
                )
                .child(
                    v_flex()
                        .flex_1()
                        .min_w_0()
                        .child(
                            div()
                                .text_size(px(UI_TEXT_PX))
                                .line_height(px(18.0))
                                .text_color(if qstate == AnnotationQueueState::Done {
                                    muted
                                } else {
                                    fg
                                })
                                .truncate()
                                .child(record.comment.clone()),
                        )
                        .when(!subtitle.is_empty(), |el| {
                            el.child(
                                div()
                                    .text_size(px(SM_TEXT_PX))
                                    .line_height(px(SM_LINE_HEIGHT_PX))
                                    .text_color(muted)
                                    .truncate()
                                    .child(subtitle),
                            )
                        }),
                )
                .child(row_right);

            list = list.child(row);
        }
        card = card.child(list);
    }

    // Send action or Watch notice.
    if state.watching {
        let mut msg = "New annotations go to this thread when it is idle.".to_owned();
        if counts.question > 0 {
            msg.push_str(" Questions wait for your answer in the thread.");
        }
        card = card.child(div().w_full().h(px(1.0)).bg(divider)).child(
            div()
                .px(px(12.0))
                .py(px(8.0))
                .text_size(px(SM_TEXT_PX))
                .line_height(px(SM_LINE_HEIGHT_PX))
                .text_color(muted)
                .child(msg),
        );
    } else if counts.waiting > 0 {
        let on_send = callbacks.on_send_waiting.clone();
        card = card.child(div().w_full().h(px(1.0)).bg(divider)).child(
            div().px(px(12.0)).py(px(8.0)).child(
                div()
                    .id("ann-queue-send-waiting")
                    .a11y_button(
                        "annotations.queue.send",
                        format!("Send {} annotations to this thread", counts.waiting),
                    )
                    .h(px(28.0))
                    .w_full()
                    .rounded(px(7.0))
                    .bg(primary)
                    .text_color(primary_fg)
                    .flex()
                    .flex_row()
                    .items_center()
                    .justify_center()
                    .gap(px(6.0))
                    .text_size(px(SM_TEXT_PX))
                    .font_weight(FontWeight::MEDIUM)
                    .cursor_pointer()
                    .on_click(move |_, window, cx| on_send(window, cx))
                    .child(superhero_icon("superhero/send.svg", 13.0, primary_fg))
                    .child(format!("Send {} to this thread", counts.waiting)),
            ),
        );
    }

    // Watch switch row.
    let on_watch = callbacks.on_toggle_watch.clone();
    let knob_bg = to_hsla(tokens.background);
    let watch_switch = div()
        .id("ann-queue-watch-switch")
        .a11y_button(
            "annotations.queue.watch",
            if state.watching {
                "Disable watch mode"
            } else {
                "Enable watch mode"
            },
        )
        .w(px(32.0))
        .h(px(18.0))
        .flex_shrink_0()
        .rounded(px(9999.0))
        .p(px(2.0))
        .flex()
        .items_center()
        .bg(if state.watching {
            switch_on
        } else {
            switch_off
        })
        .when(state.watching, |el| el.justify_end())
        .when(!state.watching, |el| el.justify_start())
        .child(div().size(px(14.0)).rounded(px(9999.0)).bg(knob_bg));

    card = card.child(div().w_full().h(px(1.0)).bg(divider)).child(
        h_flex()
            .id("ann-queue-watch-row")
            .a11y_switch(
                "panel.annotations.queue.watch",
                "Watch for annotations",
                state.watching,
            )
            .items_center()
            .justify_between()
            .gap(px(12.0))
            .px(px(12.0))
            .py(px(8.0))
            .when(state.project_ready, |el| {
                el.cursor_pointer()
                    .hover(move |s| s.bg(hover_bg))
                    .on_click(move |_, window, cx| on_watch(window, cx))
            })
            .when(!state.project_ready, |el| el.opacity(0.5))
            .child(
                v_flex()
                    .min_w_0()
                    .flex_1()
                    .child(
                        div()
                            .text_size(px(UI_TEXT_PX))
                            .line_height(px(18.0))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(fg)
                            .child("Watch"),
                    )
                    .child(
                        div()
                            .text_size(px(SM_TEXT_PX))
                            .line_height(px(SM_LINE_HEIGHT_PX))
                            .text_color(muted)
                            .child("Send new annotations automatically"),
                    ),
            )
            .child(watch_switch),
    );

    let positioned = match anchor {
        QueuePopoverAnchor::BelowRight => div().absolute().top(px(38.0)).right(px(0.0)).child(card),
        QueuePopoverAnchor::LeftOfRail => div().absolute().top(px(0.0)).right(px(44.0)).child(card),
    };

    deferred(positioned).with_priority(3).into_any_element()
}

/// Renders the numbered `#N` pins overlay and optional active-annotate banner over a viewport.
///
/// `viewport_size` is `(width_px, height_px)` of the host container; when `None`, pins wait until
/// the first prepaint records bounds.
pub(crate) fn render_pins_overlay(
    state: &AnnotationUiState,
    tokens: &Tokens,
    viewport_size: Option<(f32, f32)>,
) -> Option<AnyElement> {
    let show_pins = state.annotating
        || state.annotations.iter().any(|r| {
            state.subject.matches_record(r) && annotation_state(r) != AnnotationQueueState::Done
        });
    if !show_pins && state.pending_pin.is_none() {
        return None;
    }

    let primary = to_hsla(tokens.primary);
    let primary_fg = to_hsla(tokens.primary_foreground);
    let warning = to_hsla(tokens.warning);
    let warning_fg = to_hsla(tokens.warning_foreground);
    let border = to_hsla(tokens.background);
    let popover_bg = to_hsla(tokens.popover);
    let popover_fg = to_hsla(tokens.popover_foreground);

    let mut layer = div()
        .id("annotations-pins-layer")
        .a11y_group("panel.annotations.pins", "Annotation pins")
        .absolute()
        .inset_0()
        .overflow_hidden();

    if state.annotating {
        let active_hit = state
            .pending_pin
            .as_ref()
            .and_then(|d| d.detected.as_ref())
            .or(state.hovered_element.as_ref());

        if let (Some(hit), Some((vw, vh))) = (active_hit, viewport_size)
            && vw > 1.0
            && vh > 1.0
        {
            let bx = (hit.bounding_box.x as f32).clamp(0.0, (vw - 2.0).max(0.0));
            let by = (hit.bounding_box.y as f32).clamp(0.0, (vh - 2.0).max(0.0));
            let bw = (hit.bounding_box.width as f32).clamp(4.0, (vw - bx).max(4.0));
            let bh = (hit.bounding_box.height as f32).clamp(4.0, (vh - by).max(4.0));

            let mut label_text = hit.element.clone();
            if let Some(comp) = hit.components.first() {
                label_text = format!("<{comp}> · {label_text}");
            }
            let dims = format!(
                "{}×{}",
                hit.bounding_box.width.round() as i64,
                hit.bounding_box.height.round() as i64
            );
            let label_top = if by >= 28.0 {
                by - 26.0
            } else {
                (by + bh + 4.0).min((vh - 26.0).max(4.0))
            };
            let label_left = bx.clamp(6.0, (vw - 220.0).max(6.0));

            layer = layer
                .child(
                    div()
                        .id("annotations-element-highlight")
                        .a11y_group(
                            "annotations.hovered-element",
                            format!("{label_text} ({dims})"),
                        )
                        .absolute()
                        .left(px(bx))
                        .top(px(by))
                        .w(px(bw))
                        .h(px(bh))
                        .rounded(px(4.0))
                        .border_2()
                        .border_color(primary)
                        .bg(chrome::alpha(tokens.primary, 0.12)),
                )
                .child(
                    h_flex()
                        .absolute()
                        .left(px(label_left))
                        .top(px(label_top))
                        .max_w(px(320.0))
                        .items_center()
                        .gap(px(6.0))
                        .rounded(px(6.0))
                        .bg(popover_bg)
                        .border_1()
                        .border_color(chrome::alpha(tokens.primary, 0.7))
                        .px(px(7.0))
                        .py(px(2.0))
                        .child(
                            div()
                                .min_w_0()
                                .truncate()
                                .text_size(px(11.0))
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(popover_fg)
                                .child(label_text),
                        )
                        .child(
                            div()
                                .flex_shrink_0()
                                .text_size(px(10.0))
                                .text_color(to_hsla(tokens.muted_foreground))
                                .child(dims),
                        ),
                );
        }

        layer = layer
            .border_2()
            .border_color(chrome::alpha(tokens.primary, 0.72))
            .child(
                div()
                    .absolute()
                    .top(px(8.0))
                    .left_0()
                    .right_0()
                    .flex()
                    .justify_center()
                    .child(
                        div()
                            .rounded(px(9999.0))
                            .bg(popover_bg)
                            .border_1()
                            .border_color(chrome::alpha(tokens.primary, 0.6))
                            .px(px(10.0))
                            .py(px(3.0))
                            .text_size(px(11.0))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(popover_fg)
                            .child(format!(
                                "Annotating {} · hover & click an element",
                                state.subject.noun()
                            )),
                    ),
            );
    }

    if let Some((vw, vh)) = viewport_size
        && vw > 1.0
        && vh > 1.0
    {
        for record in &state.annotations {
            if !state.subject.matches_record(record) {
                continue;
            }
            let qstate = annotation_state(record);
            if qstate == AnnotationQueueState::Done && !state.annotating {
                continue;
            }
            let (Some(x), Some(y)) = (record.x.as_ref(), record.y.as_ref()) else {
                continue;
            };
            let px_x = ((x.0 as f32 / 100.0) * vw - PIN_SIZE_PX * 0.5)
                .clamp(2.0, (vw - PIN_SIZE_PX - 2.0).max(2.0));
            let px_y = ((y.0 as f32 / 100.0) * vh - PIN_SIZE_PX * 0.5)
                .clamp(2.0, (vh - PIN_SIZE_PX - 2.0).max(2.0));
            let number = record.number.0.round() as i64;
            let (bg, fg) = match qstate {
                AnnotationQueueState::Done => {
                    (to_hsla(tokens.muted), to_hsla(tokens.muted_foreground))
                }
                AnnotationQueueState::Question => (warning, warning_fg),
                AnnotationQueueState::Waiting | AnnotationQueueState::Working => {
                    (primary, primary_fg)
                }
            };
            let pin = div()
                .id(SharedString::from(format!("ann-pin-{}", record.id)))
                .a11y_group(
                    SharedString::from(format!("annotations.pin.{number}")),
                    format!("#{number}: {}", record.comment),
                )
                .absolute()
                .left(px(px_x))
                .top(px(px_y))
                .size(px(PIN_SIZE_PX))
                .rounded(px(9999.0))
                .bg(bg)
                .border_2()
                .border_color(border)
                .text_color(fg)
                .flex()
                .items_center()
                .justify_center()
                .text_size(px(10.0))
                .font_weight(FontWeight::SEMIBOLD)
                .conn_fast_tooltip(format!("#{number} · {}", record.comment), tokens)
                .child(number.to_string());
            layer = layer.child(pin);
        }

        if let Some(draft) = state.pending_pin.as_ref() {
            let px_x =
                (draft.local_x - PIN_SIZE_PX * 0.5).clamp(2.0, (vw - PIN_SIZE_PX - 2.0).max(2.0));
            let px_y =
                (draft.local_y - PIN_SIZE_PX * 0.5).clamp(2.0, (vh - PIN_SIZE_PX - 2.0).max(2.0));
            layer = layer.child(
                div()
                    .absolute()
                    .left(px(px_x))
                    .top(px(px_y))
                    .size(px(PIN_SIZE_PX))
                    .rounded(px(9999.0))
                    .bg(primary)
                    .border_2()
                    .border_color(border)
                    .text_color(primary_fg)
                    .flex()
                    .items_center()
                    .justify_center()
                    .text_size(px(11.0))
                    .font_weight(FontWeight::BOLD)
                    .child("+"),
            );
        }
    }

    Some(layer.into_any_element())
}

/// Callbacks for the inline pin comment composer card.
pub(crate) struct PinComposerCallbacks {
    pub(crate) on_submit: Rc<dyn Fn(&mut Window, &mut gpui_kit::App)>,
    pub(crate) on_cancel: Rc<dyn Fn(&mut Window, &mut gpui_kit::App)>,
    pub(crate) on_toggle_dictation: Rc<dyn Fn(&mut Window, &mut gpui_kit::App)>,
}

/// Renders the inline annotation comment card anchored next to the clicked pin point.
pub(crate) fn render_pin_composer(
    state: &AnnotationUiState,
    tokens: &Tokens,
    viewport_size: Option<(f32, f32)>,
    callbacks: PinComposerCallbacks,
) -> Option<AnyElement> {
    let draft = state.pending_pin.as_ref()?;
    let (vw, vh) = viewport_size.unwrap_or((480.0, 480.0));
    let left = (draft.local_x + 14.0).clamp(8.0, (vw - COMPOSER_WIDTH_PX - 8.0).max(8.0));
    let top = (draft.local_y + 14.0).clamp(8.0, (vh - 176.0).max(8.0));

    let popover_bg = to_hsla(tokens.popover);
    let fg = to_hsla(tokens.popover_foreground);
    let muted = to_hsla(tokens.muted_foreground);
    let border = to_hsla(tokens.border);
    let field_bg = to_hsla(tokens.shell_field);
    let hover_bg = to_hsla(tokens.shell_highlight);
    let primary = to_hsla(tokens.primary);
    let primary_fg = to_hsla(tokens.primary_foreground);
    let destructive = to_hsla(tokens.destructive);

    let shadow_alpha = match tokens.appearance {
        Appearance::Dark => 0.38,
        Appearance::Light => 0.14,
    };
    let shadow = BoxShadow {
        color: gpui_kit::hsla(0.0, 0.0, 0.0, shadow_alpha),
        offset: point(px(0.0), px(8.0)),
        blur_radius: px(22.0),
        spread_radius: px(-4.0),
        inset: false,
    };

    let (mic_icon, mic_color, mic_label) = match &state.dictation {
        AnnotationDictation::Idle => ("superhero/microphone.svg", muted, "Dictate with Operator"),
        AnnotationDictation::Starting(_) => {
            ("superhero/spinner.svg", primary, "Starting Operator…")
        }
        AnnotationDictation::Recording(_) => {
            ("superhero/microphone.svg", destructive, "Stop recording")
        }
        AnnotationDictation::Transcribing(_) => ("superhero/spinner.svg", primary, "Transcribing…"),
    };

    let on_cancel_x = callbacks.on_cancel.clone();
    let on_cancel_btn = callbacks.on_cancel.clone();
    let on_submit = callbacks.on_submit.clone();
    let on_dictate = callbacks.on_toggle_dictation.clone();

    let mut card = v_flex()
        .id("annotation-pin-composer")
        .a11y_group("annotations.composer", "New annotation")
        .absolute()
        .left(px(left))
        .top(px(top))
        .w(px(COMPOSER_WIDTH_PX))
        .rounded(px(12.0))
        .bg(popover_bg)
        .border_1()
        .border_color(border)
        .p(px(10.0))
        .gap(px(8.0))
        .text_color(fg)
        .shadow(vec![shadow])
        .on_mouse_down(MouseButton::Left, |_: &MouseDownEvent, _, cx| {
            cx.stop_propagation();
        })
        .child(
            h_flex()
                .items_start()
                .justify_between()
                .gap(px(6.0))
                .child(
                    v_flex()
                        .min_w_0()
                        .flex_1()
                        .child(
                            div()
                                .text_size(px(SM_TEXT_PX))
                                .font_weight(FontWeight::MEDIUM)
                                .truncate()
                                .child(
                                    draft
                                        .detected
                                        .as_ref()
                                        .map(|d| d.element.clone())
                                        .unwrap_or_else(|| {
                                            format!(
                                                "New annotation ({:.0}%, {:.0}%)",
                                                draft.point.x_pct, draft.point.y_pct
                                            )
                                        }),
                                ),
                        )
                        .when_some(
                            draft.detected.as_ref().and_then(|d| {
                                d.component
                                    .as_deref()
                                    .or(d.element_path.as_deref())
                                    .map(str::to_owned)
                            }),
                            |el, sub| {
                                el.child(
                                    div()
                                        .text_size(px(11.0))
                                        .line_height(px(14.0))
                                        .text_color(muted)
                                        .truncate()
                                        .child(sub),
                                )
                            },
                        ),
                )
                .child(
                    div()
                        .id("ann-composer-close")
                        .a11y_button("annotations.composer.close", "Cancel annotation")
                        .size(px(22.0))
                        .flex_shrink_0()
                        .rounded(px(6.0))
                        .flex()
                        .items_center()
                        .justify_center()
                        .cursor_pointer()
                        .hover(move |s| s.bg(hover_bg))
                        .on_click(move |_, window, cx| on_cancel_x(window, cx))
                        .child(superhero_icon("superhero/close.svg", 12.0, muted)),
                ),
        )
        .child(
            div()
                .rounded(px(8.0))
                .bg(field_bg)
                .border_1()
                .border_color(border)
                .px(px(8.0))
                .py(px(5.0))
                .child(
                    Input::new(&state.comment_input)
                        .appearance(false)
                        .text_size(px(UI_TEXT_PX)),
                ),
        );

    if let Some(err) = state.dictation_error.as_deref() {
        card = card.child(
            div()
                .text_size(px(11.0))
                .line_height(px(15.0))
                .text_color(destructive)
                .child(err.to_owned()),
        );
    }

    card = card.child(
        h_flex()
            .items_center()
            .justify_between()
            .gap(px(6.0))
            .child(
                h_flex().items_center().gap(px(4.0)).child(
                    div()
                        .id("ann-composer-dictate")
                        .a11y_button("annotations.composer.dictate", mic_label)
                        .h(px(26.0))
                        .px(px(8.0))
                        .rounded(px(6.0))
                        .flex()
                        .items_center()
                        .gap(px(5.0))
                        .cursor_pointer()
                        .when(state.dictation.is_active(), |el| {
                            el.bg(chrome::alpha(tokens.destructive, 0.14))
                        })
                        .hover(move |s| s.bg(hover_bg))
                        .conn_fast_tooltip(mic_label, tokens)
                        .on_click(move |_, window, cx| on_dictate(window, cx))
                        .child(superhero_icon(mic_icon, 13.0, mic_color))
                        .when(state.dictation.is_active(), |el| {
                            el.child(div().text_size(px(11.0)).text_color(mic_color).child(
                                match &state.dictation {
                                    AnnotationDictation::Recording(_) => "Listening…",
                                    AnnotationDictation::Transcribing(_) => "Transcribing…",
                                    _ => "Starting…",
                                },
                            ))
                        }),
                ),
            )
            .child(
                h_flex()
                    .items_center()
                    .gap(px(6.0))
                    .child(
                        div()
                            .id("ann-composer-cancel")
                            .a11y_button("annotations.composer.cancel", "Cancel")
                            .h(px(26.0))
                            .px(px(9.0))
                            .rounded(px(6.0))
                            .flex()
                            .items_center()
                            .text_size(px(SM_TEXT_PX))
                            .text_color(muted)
                            .cursor_pointer()
                            .hover(move |s| s.bg(hover_bg))
                            .on_click(move |_, window, cx| on_cancel_btn(window, cx))
                            .child("Cancel"),
                    )
                    .child(
                        div()
                            .id("ann-composer-save")
                            .a11y_button("annotations.composer.save", "Add annotation")
                            .h(px(26.0))
                            .px(px(11.0))
                            .rounded(px(6.0))
                            .bg(primary)
                            .text_color(primary_fg)
                            .flex()
                            .items_center()
                            .text_size(px(SM_TEXT_PX))
                            .font_weight(FontWeight::MEDIUM)
                            .cursor_pointer()
                            .on_click(move |_, window, cx| on_submit(window, cx))
                            .child("Add"),
                    ),
            ),
    );

    Some(deferred(card).with_priority(4).into_any_element())
}
