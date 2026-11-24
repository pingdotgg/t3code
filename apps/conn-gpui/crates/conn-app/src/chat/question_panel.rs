//! The pending question as a composer banner (`ComposerPendingUserInputPanel.tsx` in
//! `ComposerBanner.Dock` of `ChatComposer.tsx`), with the lead-in the agent wrote before it
//! asked (`ComposerPendingUserInputContext.tsx`) and the `1`-`9` option shortcuts.
//!
//! The timeline shows the question only once it is answered. Answer state and actions live in
//! `cards.rs`; the pure logic is in `question_logic.rs`.

use conn_state::{ThreadState, TimelineEntry, UserInputQuestion};
use gpui_kit::TestSupportExt as _;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    AnyElement, Context, FocusHandle, Font, FontFeatures, FontStyle, FontWeight,
    InteractiveElement, InteractiveText, IntoElement, KeyDownEvent, ParentElement, Role,
    ScrollHandle, SharedString, StatefulInteractiveElement, Styled, StyledText, TextRun, Window,
    canvas, div, px,
};

use super::color::{fade_ends, hsla, hsla_alpha};
use super::composer_state::thread_draft_key;
use super::markdown::{self, MarkdownOptions, ProseStyle};
use super::question_logic::{
    DisplacedAnswers, KeyMods, PrimaryInput, SET_ASIDE_DESCRIPTION, SET_ASIDE_TITLE,
    carry_displaced_into_prompt, clamp_context, every_question_answered, markdown_preview_text,
    question_primary, shortcut_option_index, split_recommended_label,
};
use super::request_stack::panel_colors;
use super::{
    BODY_FONT_PX, CHAT_CONTENT_MAX_WIDTH_PX, ChatView, UI_FONT_PX, UI_LINE_HEIGHT_PX, icons,
};
use crate::a11y::ConnA11yExt as _;

/// `scrollFade` of `ComposerBanner.Scroll`.
const FADE_PX: f32 = 24.0;
/// The context text is `text-sm leading-5`, clamped to three lines.
const CONTEXT_FONT_PX: f32 = 14.0;
const CONTEXT_LINE_PX: f32 = 20.0;
const CONTEXT_MAX_LINES: usize = 3;
/// The question text and the context sit 17px inside the panel body (`--composer-panel-content-padding`).
const TEXT_INSET_PX: f32 = 17.0;
/// Longest typed answer the "Your answer" row shows before it cuts the text.
const TYPED_PREVIEW_CHARS: usize = 400;
const SHOW_MORE: &str = "Show more";

/// What the panel remembers between frames.
pub(super) struct QuestionPanelState {
    /// Held by the panel itself, not a text field, so the `1`-`9` shortcuts reach it. Clicking
    /// the panel takes it; the composer's editor and pickers keep their own.
    focus: FocusHandle,
    /// The provider can still take an answer (`responseCapability !== "not_resumable"`).
    pub(super) can_respond: bool,
    /// What the agent wrote just before it asked, trimmed.
    context: Option<String>,
    scroll: ScrollHandle,
    /// Width of the content column, from the last paint.
    content_width: f32,
    clamp: Option<ClampCache>,
    /// The choice-only question that already took the keyboard focus.
    focus_claimed: Option<(String, usize)>,
    /// Typed answers that picking an option moved into the thread's draft.
    pub(super) displaced: DisplacedAnswers,
}

/// The context text as it clamps at one width.
struct ClampCache {
    preview: String,
    width_px: i32,
    clamped: Option<String>,
}

impl QuestionPanelState {
    pub(super) fn new(cx: &mut gpui_kit::App) -> Self {
        Self {
            focus: cx.focus_handle(),
            can_respond: true,
            context: None,
            scroll: ScrollHandle::new(),
            content_width: CHAT_CONTENT_MAX_WIDTH_PX - 6.0 - 8.0,
            clamp: None,
            focus_claimed: None,
            displaced: DisplacedAnswers::default(),
        }
    }
}

/// A `Kbd` (`ui/kbd.tsx`, default variant): `h-5 min-w-5 rounded px-1 text-xs font-medium`.
fn kbd_badge(label: String, tokens: &conn_theme::Tokens) -> impl IntoElement {
    div()
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .h(px(20.0))
        .min_w(px(20.0))
        .px(px(4.0))
        .rounded(px(4.0))
        .bg(hsla_alpha(tokens.foreground, 0.07))
        .text_size(px(12.0))
        .line_height(px(16.0))
        .font_weight(FontWeight::MEDIUM)
        .text_color(hsla(tokens.muted_foreground))
        .child(label)
}

fn system_font(weight: FontWeight) -> Font {
    Font {
        family: ".SystemUIFont".into(),
        features: FontFeatures::default(),
        fallbacks: None,
        weight,
        style: FontStyle::Normal,
    }
}

/// The context text with `… Show more` after `cut`, as one run of text and one of the link.
fn show_more_runs(cut: &str, color: gpui_kit::Hsla, link: gpui_kit::Hsla) -> Vec<TextRun> {
    let run = |len: usize, weight: FontWeight, color: gpui_kit::Hsla| TextRun {
        len,
        font: system_font(weight),
        color,
        background_color: None,
        underline: None,
        strikethrough: None,
    };
    vec![
        run(cut.len() + "… ".len(), FontWeight::NORMAL, color),
        run(SHOW_MORE.len(), FontWeight::MEDIUM, link),
    ]
}

/// Whether `candidate`, followed by `… Show more` when asked, wraps within three lines.
fn fits_in_lines(window: &Window, candidate: &str, with_more: bool, width: f32) -> bool {
    let (text, runs) = if with_more {
        (
            format!("{candidate}… {SHOW_MORE}"),
            show_more_runs(candidate, gpui_kit::black(), gpui_kit::black()),
        )
    } else {
        (
            candidate.to_owned(),
            vec![TextRun {
                len: candidate.len(),
                font: system_font(FontWeight::NORMAL),
                color: gpui_kit::black(),
                background_color: None,
                underline: None,
                strikethrough: None,
            }],
        )
    };
    match window.text_system().shape_text(
        SharedString::from(text),
        px(CONTEXT_FONT_PX),
        &runs,
        Some(px(width)),
        None,
    ) {
        Ok(lines) => {
            lines
                .iter()
                .map(|line| line.wrap_boundaries().len() + 1)
                .sum::<usize>()
                <= CONTEXT_MAX_LINES
        }
        Err(_) => true,
    }
}

impl ChatView {
    /// Reads the pending question's lead-in and whether anyone can still answer it.
    pub(super) fn sync_question_panel(&mut self, thread: &ThreadState) {
        let pending = thread.entries.iter().find_map(|entry| match entry {
            TimelineEntry::UserInputRequest {
                id,
                request_id,
                dismissible,
                pending: true,
                ..
            } => Some((id, request_id, *dismissible)),
            _ => None,
        });
        let panel = &mut self.question_panel;
        let Some((id, request_id, dismissible)) = pending else {
            panel.can_respond = true;
            panel.context = None;
            return;
        };
        // A `message`-mode request stays answerable after its provider turn ends.
        panel.can_respond = dismissible
            || thread
                .pending_requests
                .get(request_id)
                .is_none_or(|request| request.answerable);
        let context = thread
            .question_context(id)
            .map(str::trim)
            .filter(|text| !text.is_empty());
        if panel.context.as_deref() != context {
            panel.context = context.map(str::to_owned);
        }
    }

    fn pending_question(&self) -> Option<(String, Vec<UserInputQuestion>, bool)> {
        let id = self.pending_question_id.as_deref()?;
        self.cache.rows().iter().find_map(|row| match &row.entry {
            TimelineEntry::UserInputRequest {
                id: entry_id,
                questions,
                dismissible,
                ..
            } if entry_id == id => Some((entry_id.clone(), questions.clone(), *dismissible)),
            _ => None,
        })
    }

    /// `1`-`9` pick the option with that number while the keyboard is not in a text field:
    /// Conn's document `keydown` listener skips inputs, menus and dialogs. Here that is the
    /// focus on the panel itself (`idle_focus` false) or on no control at all, the app's own
    /// handle (`idle_focus` true, from the shell). Returns whether the key was used.
    pub(crate) fn on_question_key(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
        idle_focus: bool,
    ) -> bool {
        if !(idle_focus || self.question_panel.focus.is_focused(window))
            || !self.question_panel.can_respond
        {
            return false;
        }
        let Some((entry_id, questions, _)) = self.pending_question() else {
            return false;
        };
        let Some(state) = self.user_input_cards.get(&entry_id) else {
            return false;
        };
        if state.responding {
            return false;
        }
        let index = state.question_index.min(questions.len().saturating_sub(1));
        let Some(question) = questions.get(index) else {
            return false;
        };
        let modifiers = event.keystroke.modifiers;
        let mods = KeyMods {
            control: modifiers.control,
            alt: modifiers.alt,
            platform: modifiers.platform,
            shift: modifiers.shift,
        };
        let Some(option) =
            shortcut_option_index(&event.keystroke.key, mods, question.options.len())
        else {
            return false;
        };
        let value = question.options[option].answer_value().to_owned();
        cx.stop_propagation();
        self.select_user_input_option(&entry_id, question, &value, window, cx);
        true
    }

    /// An option replaces the typed answer. The text is the user's, so it goes to the end of the
    /// thread's draft, which comes back once the question is answered
    /// (`onSelectActivePendingUserInputOption`).
    pub(super) fn set_aside_typed_answer(
        &mut self,
        entry_id: &str,
        question: &UserInputQuestion,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        if !question.allow_custom_answer {
            return;
        }
        let typed = self
            .composer
            .update(cx, |composer, cx| composer.take_answer_text(window, cx));
        let Some(thread_id) = self.thread_id.as_deref() else {
            return;
        };
        let draft = thread_draft_key(thread_id);
        let moved = self.composer.update(cx, |composer, _| {
            composer.edit_parked_text(&draft, |prompt| {
                Some(carry_displaced_into_prompt(prompt, &typed))
            })
        });
        if !moved {
            return;
        }
        self.question_panel
            .displaced
            .push(&draft, &format!("{entry_id}:{}", question.id), &typed);
        self.set_error(
            Some(format!("{SET_ASIDE_TITLE}. {SET_ASIDE_DESCRIPTION}")),
            cx,
        );
    }

    /// The typed answer is a text that was set aside: it is the answer again (typed back or
    /// restored by undo), so the thread's draft must not keep a copy to send twice
    /// (`withdrawRestoredAnswer`).
    pub(super) fn withdraw_restored_answer(
        &mut self,
        entry_id: &str,
        question_id: &str,
        value: &str,
        cx: &mut Context<'_, Self>,
    ) {
        let Some(thread_id) = self.thread_id.as_deref() else {
            return;
        };
        let draft = thread_draft_key(thread_id);
        let key = format!("{entry_id}:{question_id}");
        let displaced = &mut self.question_panel.displaced;
        self.composer.update(cx, |composer, _| {
            composer.edit_parked_text(&draft, |prompt| {
                displaced.withdraw(&draft, &key, value, prompt)
            })
        });
    }

    /// The Next / Send pill: through the composer when it takes typed answers, so the typed text
    /// (or the dictation in progress) becomes the answer, else straight from the card.
    fn answer_question_from_panel(
        &mut self,
        entry_id: &str,
        via_composer: bool,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        if !via_composer {
            self.advance_user_input(entry_id, cx);
            return;
        }
        self.composer.update(cx, |composer, cx| {
            if composer.question_panel_status(cx).voice_active {
                composer.finish_dictation_and_submit(window, cx);
            } else {
                composer.submit(window, cx);
            }
        });
    }

    /// Where the context text is cut so that `… Show more` ends its third line, at this width.
    fn context_clamp(&mut self, window: &Window, preview: &str, width: f32) -> Option<String> {
        let width_px = width.round() as i32;
        if let Some(cache) = &self.question_panel.clamp
            && cache.preview == preview
            && cache.width_px == width_px
        {
            return cache.clamped.clone();
        }
        let clamped = clamp_context(preview, |candidate, with_more| {
            fits_in_lines(window, candidate, with_more, width)
        });
        self.question_panel.clamp = Some(ClampCache {
            preview: preview.to_owned(),
            width_px,
            clamped: clamped.clone(),
        });
        clamped
    }

    /// `ComposerPendingUserInputContext`: the agent's lead-in, muted, three lines with an inline
    /// `… Show more`; opened, the whole message as muted markdown.
    fn render_question_context(
        &mut self,
        entry_id: &str,
        text: &str,
        expanded: bool,
        window: &Window,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let muted = hsla(self.tokens.muted_foreground);
        let fg = hsla(self.tokens.foreground);
        let preview = markdown_preview_text(text);
        let width = self.question_panel.content_width - 2.0 * TEXT_INSET_PX;
        let clamped = self.context_clamp(window, &preview, width);

        let whole = |this: &Self, with_less: bool, cx: &mut Context<'_, Self>| {
            let options = MarkdownOptions {
                prose: Some(ProseStyle {
                    color: muted,
                    size: None,
                }),
                ..MarkdownOptions::default()
            };
            let entry = entry_id.to_owned();
            div()
                .flex()
                .flex_col()
                .child(markdown::render_markdown(
                    &format!("question-context-{entry_id}"),
                    text,
                    &this.tokens,
                    &options,
                ))
                .when(with_less, |d| {
                    d.child(
                        div()
                            .id("question-context-less")
                            .a11y_button("chat.question.context-less", "Show less")
                            .mt(px(4.0))
                            .text_size(px(CONTEXT_FONT_PX))
                            .line_height(px(CONTEXT_LINE_PX))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(fg)
                            .cursor_pointer()
                            .hover(|s| s.underline())
                            .on_click(cx.listener(move |view, _, _, cx| {
                                if let Some(state) = view.user_input_cards.get_mut(&entry) {
                                    state.context_expanded = false;
                                    cx.notify();
                                }
                            }))
                            .child("Show less"),
                    )
                })
                .into_any_element()
        };

        match clamped {
            None => whole(self, false, cx),
            Some(_) if expanded => whole(self, true, cx),
            Some(cut) => {
                let more = {
                    let entry = entry_id.to_owned();
                    move |view: &mut Self, cx: &mut Context<'_, Self>| {
                        if let Some(state) = view.user_input_cards.get_mut(&entry) {
                            state.context_expanded = true;
                            cx.notify();
                        }
                    }
                };
                let line = format!("{cut}… {SHOW_MORE}");
                let link_start = cut.len() + "… ".len();
                let link = link_start..link_start + SHOW_MORE.len();
                let styled = StyledText::new(SharedString::from(line))
                    .with_runs(show_more_runs(&cut, muted, fg));
                let layout = styled.layout().clone();
                let more_range = link.clone();
                let weak = cx.entity().downgrade();
                let on_text_click = {
                    let more = more.clone();
                    move |_: usize, _: &mut Window, cx: &mut gpui_kit::App| {
                        let _ = weak.update(cx, |view, cx| more(view, cx));
                    }
                };
                div()
                    .relative()
                    .text_size(px(CONTEXT_FONT_PX))
                    .line_height(px(CONTEXT_LINE_PX))
                    .text_color(muted)
                    // `InteractiveText` records a press of any button and clicks on release, so a
                    // right-click on `Show more` stops in the capture phase, before the text.
                    .capture_any_mouse_down(move |event, _, cx| {
                        if event.button == gpui_kit::MouseButton::Right
                            && layout
                                .index_for_position(event.position)
                                .is_ok_and(|index| more_range.contains(&index))
                        {
                            cx.stop_propagation();
                        }
                    })
                    .child(
                        InteractiveText::new("question-context-text", styled)
                            .on_click(vec![link], on_text_click),
                    )
                    // The link inside the text takes the pointer; this one is for assistive tech.
                    .child(
                        div()
                            .id("question-context-more")
                            .a11y_button("chat.question.context-more", SHOW_MORE)
                            .absolute()
                            .top_0()
                            .left_0()
                            .size(px(1.0))
                            .on_click(cx.listener(move |view, _, _, cx| more(view, cx))),
                    )
                    .into_any_element()
            }
        }
    }

    /// The pending question as a card of the request stack. `None` while no question is the
    /// current request.
    pub(super) fn render_question_panel(
        &mut self,
        window: &mut Window,
        body_max: f32,
        cx: &mut Context<'_, Self>,
    ) -> Option<AnyElement> {
        let (entry_id, questions, dismissible) = self.pending_question()?;
        let state = self.user_input_cards.get(&entry_id)?;
        let index = state.question_index.min(questions.len().saturating_sub(1));
        let question = questions.get(index)?.clone();
        let draft = state.drafts.get(&question.id).cloned();
        let drafts = state.drafts.clone();
        let responding = state.responding;
        let auto_advancing = !question.multi_select && state._auto_advance.is_some();
        let error = state.error.clone();
        let context_expanded = state.context_expanded;

        // Nothing in a choice-only question takes the keyboard, so the digit shortcuts work at
        // once (Conn's disabled editor does not hold the focus either).
        if !question.allow_custom_answer
            && self.question_panel.focus_claimed.as_ref() != Some(&(entry_id.clone(), index))
        {
            window.focus(&self.question_panel.focus, cx);
            self.question_panel.focus_claimed = Some((entry_id.clone(), index));
        }

        let status = self.composer.read(cx).question_panel_status(cx);
        let typed_active = question.allow_custom_answer && !status.typed.trim().is_empty();
        let answered = typed_active || question.resolve_answer(draft.as_ref()).is_some();
        let primary = question_primary(PrimaryInput {
            is_last: index + 1 >= questions.len(),
            multi_select: question.multi_select,
            answered,
            complete: every_question_answered(&questions, &drafts, index, typed_active),
            attachments_blocked: status.uploading,
            auto_advancing,
            voice_active: status.voice_active,
            disabled: responding || status.blocked,
        });

        let context = self.question_panel.context.clone().map(|text| {
            self.render_question_context(&entry_id, &text, context_expanded, window, cx)
        });

        let tokens = &self.tokens;
        let fg = hsla(tokens.foreground);
        let muted = hsla(tokens.muted_foreground);

        let mut options = div()
            .id(SharedString::from(format!("question-options-{entry_id}")))
            .a11y(
                if question.multi_select {
                    Role::Group
                } else {
                    Role::RadioGroup
                },
                SharedString::from(format!("chat.question.options.{entry_id}")),
                question.header.clone(),
            )
            .flex()
            .flex_col()
            .gap(px(2.0))
            .mt(px(4.0))
            .mx(px(TEXT_INSET_PX - 6.0));
        for (opt_idx, option) in question.options.iter().enumerate() {
            let value = option.answer_value().to_owned();
            let selected = !typed_active && question.is_option_selected(draft.as_ref(), &value);
            let select_id = entry_id.clone();
            let picked = question.clone();
            let (title_text, recommended) = split_recommended_label(&option.label);
            let indicator: AnyElement = if question.multi_select {
                self.render_checkbox_mark(selected)
            } else {
                self.render_option_radio(selected)
            };
            let main = div()
                .flex()
                .flex_row()
                .items_start()
                .gap(px(10.0))
                .child(div().flex().items_center().h(px(20.0)).child(indicator))
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(4.0))
                        .flex_1()
                        .min_w_0()
                        .child(
                            div()
                                .text_size(px(BODY_FONT_PX))
                                .line_height(px(20.0))
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(fg)
                                .child(title_text.to_owned()),
                        )
                        .when(
                            !option.description.is_empty() && option.description != option.label,
                            |d| {
                                d.child(
                                    div()
                                        .text_size(px(UI_FONT_PX))
                                        .line_height(px(16.0))
                                        .text_color(muted)
                                        .child(option.description.clone()),
                                )
                            },
                        ),
                )
                .when(opt_idx < 9, |d| {
                    d.child(
                        div()
                            .flex()
                            .items_center()
                            .flex_none()
                            .h(px(20.0))
                            .child(kbd_badge((opt_idx + 1).to_string(), tokens)),
                    )
                });
            let mut row = div()
                .id((
                    SharedString::from(format!("question-opt-{entry_id}")),
                    opt_idx,
                ))
                .test_support()
                .a11y_button(
                    SharedString::from(format!("chat.question.option.{entry_id}.{opt_idx}")),
                    option.label.clone(),
                )
                .aria_selected(selected)
                .flex()
                .flex_col()
                .gap(px(6.0))
                .w_full()
                .rounded(px(16.0))
                .px(px(12.0))
                .py(px(14.0))
                .when(selected, |d| d.bg(hsla_alpha(tokens.foreground, 0.06)))
                .when(recommended, |d| {
                    // On its own line above the title, so the mark lines up with the title.
                    d.child(
                        div().flex().pl(px(26.0)).child(
                            div()
                                .rounded_full()
                                .bg(hsla_alpha(tokens.primary, 0.15))
                                .px(px(8.0))
                                .py(px(1.0))
                                .text_size(px(12.0))
                                .line_height(px(16.0))
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(hsla(tokens.primary))
                                .child("Recommended"),
                        ),
                    )
                })
                .child(main);
            if responding {
                row = row.opacity(0.5);
            } else {
                let hover = hsla_alpha(tokens.foreground, 0.04);
                row = row
                    .cursor_pointer()
                    .when(!selected, move |d| d.hover(move |s| s.bg(hover)))
                    .on_click(cx.listener(move |view, _, window, cx| {
                        view.select_user_input_option(&select_id, &picked, &value, window, cx);
                    }));
            }
            let preview =
                option
                    .preview
                    .as_deref()
                    .filter(|preview| !preview.trim().is_empty())
                    .map(|preview| {
                        // `ps-9.5 pe-3 pb-1.5 text-xs text-foreground/70`, under the button.
                        let options = MarkdownOptions {
                            prose: Some(ProseStyle {
                                color: hsla_alpha(tokens.foreground, 0.70),
                                size: Some((12.0, 16.0)),
                            }),
                            ..MarkdownOptions::default()
                        };
                        div().pl(px(38.0)).pr(px(12.0)).pb(px(6.0)).child(
                            markdown::render_markdown(
                                &format!("question-preview-{entry_id}-{opt_idx}"),
                                preview,
                                tokens,
                                &options,
                            ),
                        )
                    });
            options = options.child(div().child(row).when_some(preview, |d, p| d.child(p)));
        }
        if typed_active {
            let typed: String = status.typed.chars().take(TYPED_PREVIEW_CHARS).collect();
            options = options.child(self.render_typed_answer_row(&entry_id, typed, &question));
        }

        // The content column. A canvas reads its width for the context clamp.
        let weak = cx.weak_entity();
        let measured = self.question_panel.content_width;
        let measure = canvas(
            move |bounds, _window, cx| {
                let width = f32::from(bounds.size.width);
                if (width - measured).abs() > 0.5 {
                    cx.defer(move |cx| {
                        let _ = weak.update(cx, |view, cx| {
                            view.question_panel.content_width = width;
                            cx.notify();
                        });
                    });
                }
            },
            |_, (), _, _| {},
        )
        .absolute()
        .inset_0();
        let content = div()
            .relative()
            .flex()
            .flex_col()
            .gap(px(8.0))
            .pt(px(16.0))
            .pb(px(12.0))
            .child(measure)
            .child(
                div()
                    .px(px(TEXT_INSET_PX))
                    .text_color(fg)
                    .child(markdown::render_markdown(
                        &format!("question-{entry_id}-{}", question.id),
                        &question.question,
                        tokens,
                        &MarkdownOptions::default(),
                    )),
            )
            .when_some(context, |d, context| {
                d.child(div().px(px(TEXT_INSET_PX)).child(context))
            })
            .child(options)
            .when_some(error, |d, error| {
                d.child(
                    div()
                        .px(px(TEXT_INSET_PX))
                        .text_size(px(UI_FONT_PX))
                        .line_height(px(UI_LINE_HEIGHT_PX))
                        .text_color(hsla(tokens.destructive))
                        .child(error),
                )
            });

        // `ComposerBanner.Scroll`: capped height, faded where more waits beyond the edge.
        let scroll = &self.question_panel.scroll;
        let offset = f32::from(scroll.offset().y);
        let reach = f32::from(scroll.max_offset().y);
        let overflows = reach > 0.5;
        let colors = panel_colors(tokens);
        let fade = |top: bool| {
            let (from, to) = fade_ends(colors.inner);
            let mut el = div().absolute().left_0().right_0().h(px(FADE_PX));
            el = if top {
                el.top_0().bg(gpui_kit::linear_gradient(
                    180.0,
                    gpui_kit::linear_color_stop(from, 0.0),
                    gpui_kit::linear_color_stop(to, 1.0),
                ))
            } else {
                el.bottom_0().bg(gpui_kit::linear_gradient(
                    0.0,
                    gpui_kit::linear_color_stop(from, 0.0),
                    gpui_kit::linear_color_stop(to, 1.0),
                ))
            };
            el
        };
        let scroll_area = div()
            .relative()
            .child(
                div()
                    .id(SharedString::from(format!("question-scroll-{entry_id}")))
                    .track_scroll(scroll)
                    .max_h(px(body_max))
                    .overflow_y_scroll()
                    .child(div().when(overflows, |d| d.pr(px(8.0))).child(content)),
            )
            .when(overflows && offset < -0.5, |d| d.child(fade(true)))
            .when(overflows && -offset < reach - 0.5, |d| d.child(fade(false)));

        let actions = self.render_question_actions(
            &entry_id,
            &question,
            index,
            questions.len(),
            dismissible,
            responding,
            primary,
            cx,
        );
        let progress = (questions.len() > 1).then(|| {
            div()
                .font_weight(FontWeight::NORMAL)
                .child(format!("{} of {}", index + 1, questions.len()))
                .into_any_element()
        });

        let panel = self
            .request_panel(
                SharedString::from(format!("question-banner-{entry_id}")),
                SharedString::from(format!("chat.question.{entry_id}")),
                SharedString::from(question.header.clone()),
                icons::CHAT_CIRCLE,
                "Question",
                progress,
                scroll_area.into_any_element(),
                actions,
                hsla(colors.inner),
            )
            .test_support()
            .track_focus(&self.question_panel.focus)
            .on_key_down(cx.listener(|view, event, window, cx| {
                view.on_question_key(event, window, cx, false);
            }));
        Some(panel.into_any_element())
    }

    /// What the user typed as the answer, shown beside the options it replaces
    /// (`Your answer`): selected, and set by typing, so it cannot be picked again.
    fn render_typed_answer_row(
        &self,
        entry_id: &str,
        typed: String,
        question: &UserInputQuestion,
    ) -> AnyElement {
        let indicator: AnyElement = if question.multi_select {
            self.render_checkbox_mark(true)
        } else {
            self.render_option_radio(true)
        };
        div()
            .id(SharedString::from(format!("question-typed-{entry_id}")))
            .a11y_group(
                SharedString::from(format!("chat.question.typed.{entry_id}")),
                "Your answer",
            )
            .flex()
            .flex_row()
            .items_start()
            .gap(px(10.0))
            .w_full()
            .rounded(px(16.0))
            .px(px(12.0))
            .py(px(14.0))
            .bg(hsla_alpha(self.tokens.foreground, 0.06))
            .child(div().flex().items_center().h(px(20.0)).child(indicator))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(4.0))
                    .flex_1()
                    .min_w_0()
                    .child(
                        div()
                            .text_size(px(12.0))
                            .line_height(px(16.0))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(hsla(self.tokens.muted_foreground))
                            .child("Your answer"),
                    )
                    .child(
                        div()
                            .text_size(px(BODY_FONT_PX))
                            .line_height(px(20.0))
                            .text_color(hsla(self.tokens.foreground))
                            .child(typed),
                    ),
            )
            .into_any_element()
    }

    /// The bottom row: `Back` at the left, `Skip` in the middle and the Next / Send pill at the
    /// right. `N of M` sits in the panel's header.
    #[expect(
        clippy::too_many_arguments,
        reason = "the row's inputs are the panel's own values"
    )]
    fn render_question_actions(
        &self,
        entry_id: &str,
        question: &UserInputQuestion,
        index: usize,
        total: usize,
        dismissible: bool,
        responding: bool,
        primary: super::question_logic::QuestionPrimary,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let tokens = &self.tokens;
        let is_last = index + 1 >= total;
        let via_composer = question.allow_custom_answer;
        let mut back = div()
            .flex()
            .flex_row()
            .flex_1()
            .items_center()
            .justify_start()
            .pl(px(8.0));
        if index > 0 {
            let back_id = entry_id.to_owned();
            back = back.child(
                super::cards::question_text_action(
                    tokens,
                    format!("question-back-{entry_id}"),
                    format!("chat.question-back-{entry_id}"),
                    "Back",
                    "Back",
                    !responding,
                    false,
                )
                .when(!responding, |d| {
                    d.on_click(cx.listener(move |view, _, _, cx| {
                        view.go_back_user_input(&back_id, cx);
                    }))
                }),
            );
        }
        let mut skip = div().flex().flex_row().flex_none().items_center();
        if dismissible {
            let dismiss_id = entry_id.to_owned();
            skip = skip.child(
                super::cards::question_text_action(
                    tokens,
                    format!("question-dismiss-{entry_id}"),
                    format!("chat.question.dismiss.{entry_id}"),
                    "Skip question",
                    "Skip",
                    !responding,
                    false,
                )
                .when(!responding, |d| {
                    d.on_click(cx.listener(move |view, _, _, cx| {
                        view.dismiss_user_input(&dismiss_id, cx);
                    }))
                }),
            );
        }
        let mut next = div()
            .flex()
            .flex_row()
            .flex_1()
            .items_center()
            .justify_end();
        if primary.show {
            let text = if responding {
                "Submitting..."
            } else if is_last {
                "Send"
            } else {
                "Next"
            };
            let primary_id = entry_id.to_owned();
            next = next.child(
                self.request_pill(
                    format!("question-submit-{entry_id}"),
                    format!("chat.question-submit-{entry_id}"),
                    text,
                    "accept",
                    primary.enabled,
                )
                .when(primary.enabled, |pill| {
                    pill.on_click(cx.listener(move |view, _, window, cx| {
                        view.answer_question_from_panel(&primary_id, via_composer, window, cx);
                    }))
                })
                .test_support(),
            );
        }
        Self::request_actions()
            .child(back)
            .child(skip)
            .child(next)
            .into_any_element()
    }
}
