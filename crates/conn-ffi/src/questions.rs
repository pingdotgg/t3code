//! The question panel above the composer, ported from Conn mobile's `PendingUserInputCard.tsx`,
//! the question parts of `ThreadDetailScreen.tsx` (composer placeholder and answer action) and
//! `ThreadPendingUserInput` (`client-runtime/src/state/threadRequests.ts`), so the SwiftUI view
//! only draws and keeps the drafts.

use std::collections::HashMap;
use std::sync::Arc;

use conn_state::{
    ThreadState, TimelineEntry, UserInputAnswerValue, UserInputDraft, UserInputOption,
    UserInputQuestion, build_user_input_answers, clamp_context, markdown_preview_text,
    seed_user_input_drafts, split_recommended_label,
};

use crate::types::{
    FfiUserInputAnswerValue, FfiUserInputOption, FfiUserInputQuestion, FfiUserInputSubmission,
    map_user_input_question,
};

/// The open question the panel above the composer asks (mobile's `activePendingUserInput`).
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct FfiPendingQuestion {
    /// The question's timeline entry, which the feed leaves out while the panel shows it.
    pub entry_id: String,
    /// Server request id to pass to [`crate::ConnCore::respond_user_input`] or
    /// [`crate::ConnCore::dismiss_user_input`].
    pub request_id: String,
    pub questions: Vec<FfiUserInputQuestion>,
    /// What the agent wrote just before asking, as markdown.
    pub context_markdown: Option<String>,
    /// The same text as plain lines, for the three-line clamp (`markdownPreviewText`).
    pub context_preview: Option<String>,
    /// The provider still waits for the answer. When it does not, the panel is dimmed and says
    /// the provider process is gone.
    pub answerable: bool,
    /// The question can be skipped unanswered (`responseMode: "message"`).
    pub dismissible: bool,
}

/// The local answer to one question (`PendingUserInputDraftAnswer`).
#[derive(Clone, Debug, Default, PartialEq, Eq, uniffi::Record)]
pub struct FfiQuestionDraft {
    pub selected: Vec<String>,
    pub custom: Option<String>,
}

/// One option row of the panel.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct FfiQuestionPanelOption {
    /// The value to pass to [`question_toggle_option`].
    pub value: String,
    /// The label without a trailing "(Recommended)".
    pub label: String,
    /// The agent marked this option "(Recommended)"; the row shows a pill above the label.
    pub recommended: bool,
    /// Shown under the label when it says more than the label.
    pub description: Option<String>,
    /// Markdown shown under the row.
    pub preview: Option<String>,
    pub selected: bool,
}

/// Everything the question panel and the composer show for the current step.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct FfiQuestionPanel {
    /// The step, clamped to the questions.
    pub step: u32,
    pub question_id: String,
    /// The question, as markdown.
    pub question: String,
    pub multi_select: bool,
    pub options: Vec<FfiQuestionPanelOption>,
    /// The typed or stored free-text answer, shown as a selected "Your answer" row.
    pub custom_answer: Option<String>,
    /// "2 of 3", when there is more than one question.
    pub progress: Option<String>,
    /// Why the panel cannot answer, under the questions.
    pub notice: Option<String>,
    /// The options and the footer are dimmed: nobody waits for the answer.
    pub dimmed: bool,
    /// The options take no taps: dimmed or an answer is on its way.
    pub options_disabled: bool,
    pub show_skip: bool,
    pub skip_disabled: bool,
    pub show_back: bool,
    pub back_disabled: bool,
    pub show_next: bool,
    pub next_disabled: bool,
    pub show_send: bool,
    pub send_disabled: bool,
    /// The footer row shows at all.
    pub show_footer: bool,
    pub is_last: bool,
    /// A single-choice pick moves to the next step on its own (after mobile's 200 ms).
    pub advances_on_pick: bool,
    /// The composer's text answers this question.
    pub accepts_text: bool,
    pub composer_placeholder: String,
    /// The composer's send button answers the question even with no text: it moves to the next
    /// question, or sends the answers on the last one.
    pub answer_action_ready: bool,
    pub answer_action_label: String,
}

/// Measures whether the agent's context fits the panel's three lines; Swift measures with the
/// panel's font and width.
#[uniffi::export(with_foreign)]
pub trait FfiTextFits: Send + Sync {
    /// Whether `text`, followed by "… Show more" when `with_more` is set, wraps within three
    /// lines.
    fn fits(&self, text: String, with_more: bool) -> bool;
}

/// The open question of `thread`: the first question whose request still waits, in timeline
/// order.
pub(crate) fn pending_question(thread: &ThreadState) -> Option<FfiPendingQuestion> {
    thread.entries.iter().find_map(|entry| {
        let TimelineEntry::UserInputRequest {
            id,
            request_id,
            questions,
            dismissible,
            ..
        } = entry
        else {
            return None;
        };
        let pending = thread.pending_requests.get(request_id)?;
        let context = thread
            .question_context(id)
            .map(str::trim)
            .filter(|text| !text.is_empty());
        Some(FfiPendingQuestion {
            entry_id: id.clone(),
            request_id: request_id.clone(),
            questions: questions.iter().map(map_user_input_question).collect(),
            context_markdown: context.map(str::to_owned),
            context_preview: context.map(markdown_preview_text),
            answerable: pending.answerable,
            dismissible: *dismissible,
        })
    })
}

/// The panel for `step` of `pending`, with `typed_answer` the composer's text.
#[uniffi::export]
#[must_use]
pub fn question_panel(
    pending: FfiPendingQuestion,
    step: u32,
    drafts: HashMap<String, FfiQuestionDraft>,
    typed_answer: String,
    responding: bool,
) -> Option<FfiQuestionPanel> {
    let questions = core_questions(&pending);
    let last = questions.len().checked_sub(1)?;
    let index = usize::try_from(step).unwrap_or(usize::MAX).min(last);
    let question = &questions[index];
    let drafts = seed_user_input_drafts(&questions, &core_drafts(drafts));
    let draft = drafts.get(&question.id);

    let dimmed = !pending.answerable;
    let response_disabled = dimmed || responding;
    let is_last = index == last;
    let can_submit = build_user_input_answers(&questions, &drafts).is_some();
    let answered = question.resolve_answer(draft).is_some();

    let options: Vec<FfiQuestionPanelOption> = question
        .options
        .iter()
        .map(|option| panel_option(question, draft, option))
        .collect();
    let any_picked = options.iter().any(|option| option.selected);
    let typed = if !question.allow_custom_answer || (!question.multi_select && any_picked) {
        ""
    } else {
        typed_answer.as_str()
    };
    let stored = if question.allow_custom_answer {
        draft.and_then(|d| d.custom.as_deref()).unwrap_or_default()
    } else {
        ""
    };
    let custom = if typed.trim().is_empty() {
        stored
    } else {
        typed
    };
    let custom_active = if question.initial_answer.is_some() {
        !custom.is_empty()
    } else {
        !custom.trim().is_empty()
    };

    let show_next = !is_last && (question.multi_select || answered);
    let show_send = is_last && can_submit;
    let show_back = index > 0;
    let question_count = questions.len();

    Some(FfiQuestionPanel {
        step: u32::try_from(index).unwrap_or(u32::MAX),
        question_id: question.id.clone(),
        question: question.question.clone(),
        multi_select: question.multi_select,
        options,
        custom_answer: custom_active.then(|| custom.to_owned()),
        progress: (question_count > 1).then(|| format!("{} of {question_count}", index + 1)),
        notice: dimmed.then(|| {
            "The provider process for this request is no longer available. Interrupt or \
             restart the run to continue."
                .to_owned()
        }),
        dimmed,
        options_disabled: response_disabled,
        show_skip: pending.dismissible,
        skip_disabled: responding,
        show_back,
        back_disabled: responding,
        show_next,
        next_disabled: !answered || response_disabled,
        show_send,
        send_disabled: response_disabled,
        show_footer: question_count > 1
            || index > 0
            || pending.dismissible
            || show_next
            || show_send,
        is_last,
        advances_on_pick: !question.multi_select && !is_last,
        accepts_text: question.allow_custom_answer,
        composer_placeholder: if !question.allow_custom_answer {
            "Choose an option above"
        } else if question.options.is_empty() {
            "Type your answer"
        } else {
            "Or type your own answer"
        }
        .to_owned(),
        answer_action_ready: !responding
            && pending.answerable
            && if is_last { can_submit } else { answered },
        answer_action_label: if is_last {
            "Send answers"
        } else {
            "Next question"
        }
        .to_owned(),
    })
}

/// The drafts after tapping option `value` of question `question_id`.
#[uniffi::export]
#[must_use]
pub fn question_toggle_option(
    pending: FfiPendingQuestion,
    question_id: String,
    drafts: HashMap<String, FfiQuestionDraft>,
    value: String,
) -> HashMap<String, FfiQuestionDraft> {
    edit_draft(&pending, &question_id, drafts, |question, draft| {
        question.toggle_option(draft, &value)
    })
}

/// The drafts after the composer's text became the free-text answer of question `question_id`.
#[uniffi::export]
#[must_use]
pub fn question_set_custom_answer(
    pending: FfiPendingQuestion,
    question_id: String,
    drafts: HashMap<String, FfiQuestionDraft>,
    text: String,
) -> HashMap<String, FfiQuestionDraft> {
    edit_draft(&pending, &question_id, drafts, |question, draft| {
        question.set_custom_answer(draft, &text)
    })
}

/// Every question's answer, or `None` while one is unanswered (`buildPendingUserInputAnswers`).
#[uniffi::export]
#[must_use]
pub fn question_answers(
    pending: FfiPendingQuestion,
    drafts: HashMap<String, FfiQuestionDraft>,
) -> Option<Vec<FfiUserInputSubmission>> {
    let questions = core_questions(&pending);
    let drafts = seed_user_input_drafts(&questions, &core_drafts(drafts));
    let answers = build_user_input_answers(&questions, &drafts)?;
    Some(
        answers
            .into_iter()
            .map(|(question_id, value)| FfiUserInputSubmission {
                question_id,
                value: match value {
                    UserInputAnswerValue::Single(value) => {
                        FfiUserInputAnswerValue::Single { value }
                    }
                    UserInputAnswerValue::Multi(values) => {
                        FfiUserInputAnswerValue::Multi { values }
                    }
                },
            })
            .collect(),
    )
}

/// Where the agent's context stops so "… Show more" ends its third line, or `None` when it fits.
#[uniffi::export]
#[must_use]
pub fn question_context_clamp(preview: String, fits: Arc<dyn FfiTextFits>) -> Option<String> {
    clamp_context(&preview, |text, with_more| {
        fits.fits(text.to_owned(), with_more)
    })
}

fn panel_option(
    question: &UserInputQuestion,
    draft: Option<&UserInputDraft>,
    option: &UserInputOption,
) -> FfiQuestionPanelOption {
    let value = option.answer_value().to_owned();
    let (label, recommended) = split_recommended_label(&option.label);
    let description = (!option.description.is_empty() && option.description != option.label)
        .then(|| option.description.clone());
    FfiQuestionPanelOption {
        selected: question.is_option_selected(draft, &value),
        value,
        label: label.to_owned(),
        recommended,
        description,
        preview: option.preview.clone().filter(|p| !p.trim().is_empty()),
    }
}

fn edit_draft(
    pending: &FfiPendingQuestion,
    question_id: &str,
    drafts: HashMap<String, FfiQuestionDraft>,
    edit: impl FnOnce(&UserInputQuestion, Option<&UserInputDraft>) -> UserInputDraft,
) -> HashMap<String, FfiQuestionDraft> {
    let questions = core_questions(pending);
    let Some(question) = questions.iter().find(|q| q.id == question_id) else {
        return drafts;
    };
    // Edits start from the suggested answer the user was looking at.
    let seeded =
        seed_user_input_drafts(std::slice::from_ref(question), &core_drafts(drafts.clone()));
    let next = edit(question, seeded.get(question_id));
    let mut drafts = drafts;
    drafts.insert(
        question_id.to_owned(),
        FfiQuestionDraft {
            selected: next.selected,
            custom: next.custom,
        },
    );
    drafts
}

fn core_drafts(drafts: HashMap<String, FfiQuestionDraft>) -> HashMap<String, UserInputDraft> {
    drafts
        .into_iter()
        .map(|(id, draft)| {
            (
                id,
                UserInputDraft {
                    selected: draft.selected,
                    custom: draft.custom,
                },
            )
        })
        .collect()
}

/// The FFI questions as conn-state's. Each FFI option carries its answer value, so it matches
/// as a provider value.
fn core_questions(pending: &FfiPendingQuestion) -> Vec<UserInputQuestion> {
    pending
        .questions
        .iter()
        .map(|q| UserInputQuestion {
            id: q.id.clone(),
            header: q.header.clone(),
            question: q.question.clone(),
            options: q.options.iter().map(core_option).collect(),
            multi_select: q.multi_select,
            allow_custom_answer: q.allow_custom_answer,
            initial_answer: q.initial_answer.clone(),
        })
        .collect()
}

fn core_option(option: &FfiUserInputOption) -> UserInputOption {
    UserInputOption {
        label: option.label.clone(),
        description: option.description.clone(),
        value: Some(option.value.clone()),
        preview: option.preview.clone(),
    }
}

#[cfg(test)]
mod tests {
    use conn_contract::OrchestrationV2TurnItemStatus;
    use conn_state::PendingRequest;

    use super::*;

    fn option(label: &str, description: &str, value: Option<&str>) -> UserInputOption {
        UserInputOption {
            label: label.to_owned(),
            description: description.to_owned(),
            value: value.map(str::to_owned),
            preview: None,
        }
    }

    fn question(id: &str, options: Vec<UserInputOption>, multi_select: bool) -> UserInputQuestion {
        UserInputQuestion {
            id: id.to_owned(),
            header: String::new(),
            question: format!("{id}?"),
            options,
            multi_select,
            allow_custom_answer: true,
            initial_answer: None,
        }
    }

    fn request(id: &str, request_id: &str, questions: Vec<UserInputQuestion>) -> TimelineEntry {
        TimelineEntry::UserInputRequest {
            id: id.to_owned(),
            request_id: request_id.to_owned(),
            title: None,
            questions,
            status: OrchestrationV2TurnItemStatus::Running,
            pending: true,
            answers: Vec::new(),
            dismissible: false,
            created_at: None,
        }
    }

    fn pending(questions: Vec<UserInputQuestion>) -> FfiPendingQuestion {
        FfiPendingQuestion {
            entry_id: "q".to_owned(),
            request_id: "req".to_owned(),
            questions: questions.iter().map(map_user_input_question).collect(),
            context_markdown: None,
            context_preview: None,
            answerable: true,
            dismissible: false,
        }
    }

    fn two_steps() -> FfiPendingQuestion {
        pending(vec![
            question(
                "db",
                vec![
                    option("Postgres (Recommended)", "Postgres (Recommended)", None),
                    option("SQLite", "Embedded", Some("sqlite")),
                ],
                false,
            ),
            question(
                "tags",
                vec![option("a", "", None), option("b", "", None)],
                true,
            ),
        ])
    }

    fn panel(
        pending: &FfiPendingQuestion,
        step: u32,
        drafts: &HashMap<String, FfiQuestionDraft>,
        typed: &str,
    ) -> FfiQuestionPanel {
        question_panel(
            pending.clone(),
            step,
            drafts.clone(),
            typed.to_owned(),
            false,
        )
        .expect("a question")
    }

    #[test]
    fn the_first_waiting_question_opens_the_panel_and_leaves_the_feed() {
        let mut thread = ThreadState::new("t");
        thread.entries = vec![
            request("answered", "req-0", vec![question("x", Vec::new(), false)]),
            request("open", "req-1", vec![question("y", Vec::new(), false)]),
            request("later", "req-2", vec![question("z", Vec::new(), false)]),
        ];
        for id in ["req-1", "req-2"] {
            thread.pending_requests.insert(
                id.to_owned(),
                PendingRequest {
                    answerable: id == "req-1",
                    supports_feedback: false,
                },
            );
        }
        let open = pending_question(&thread).expect("an open question");
        assert_eq!(open.entry_id, "open", "the first request that still waits");
        assert!(open.answerable, "its provider waits");

        let snapshot = crate::types::build_thread_snapshot(&thread, None);
        let ids: Vec<String> = snapshot
            .entries
            .iter()
            .map(|entry| match entry {
                crate::types::FfiTimelineEntry::UserInputRequest { id, .. } => id.clone(),
                _ => String::new(),
            })
            .collect();
        assert_eq!(
            ids,
            vec!["answered".to_owned(), "later".to_owned()],
            "the panel's question has no feed row"
        );
        assert_eq!(
            snapshot.pending_question.map(|q| q.request_id).as_deref(),
            Some("req-1"),
            "the snapshot carries the panel"
        );
    }

    #[test]
    fn options_drop_the_recommended_mark_and_a_description_that_repeats_the_label() {
        let first = panel(&two_steps(), 0, &HashMap::new(), "");
        let rows: Vec<_> = first
            .options
            .iter()
            .map(|o| (o.label.as_str(), o.recommended, o.description.as_deref()))
            .collect();
        assert_eq!(
            rows,
            vec![
                ("Postgres", true, None),
                ("SQLite", false, Some("Embedded"))
            ],
            "pill instead of the suffix; no repeated description"
        );
        assert_eq!(first.progress.as_deref(), Some("1 of 2"), "progress");
        assert!(first.advances_on_pick, "a single-choice pick moves on");
        assert!(!first.show_next, "nothing picked: no Next");
        assert!(!first.answer_action_ready, "nothing to answer with yet");
        assert_eq!(
            first.composer_placeholder, "Or type your own answer",
            "options and free text"
        );
    }

    #[test]
    fn picking_answers_the_step_and_the_last_step_sends() {
        let pending = two_steps();
        let drafts = question_toggle_option(
            pending.clone(),
            "db".to_owned(),
            HashMap::new(),
            "Postgres (Recommended)".to_owned(),
        );
        let first = panel(&pending, 0, &drafts, "");
        assert!(first.options[0].selected, "the pick shows");
        assert!(
            first.show_next && !first.next_disabled,
            "Next once answered"
        );
        assert_eq!(
            first.answer_action_label, "Next question",
            "composer moves on"
        );
        assert!(first.answer_action_ready, "composer can move on");

        let last = panel(&pending, 9, &drafts, "");
        assert_eq!(last.step, 1, "the step is clamped");
        assert!(last.is_last && !last.advances_on_pick, "last, multi-select");
        assert!(!last.show_send, "the last question is unanswered");
        assert!(last.show_back, "can go back");
        assert_eq!(
            question_answers(pending.clone(), drafts.clone()),
            None,
            "incomplete"
        );

        let drafts =
            question_toggle_option(pending.clone(), "tags".to_owned(), drafts, "b".to_owned());
        let last = panel(&pending, 1, &drafts, "");
        assert!(
            last.show_send && !last.send_disabled,
            "every question answered"
        );
        assert_eq!(last.answer_action_label, "Send answers", "composer sends");
        assert_eq!(
            question_answers(pending, drafts),
            Some(vec![
                FfiUserInputSubmission {
                    question_id: "db".to_owned(),
                    value: FfiUserInputAnswerValue::Single {
                        value: "Postgres (Recommended)".to_owned()
                    },
                },
                FfiUserInputSubmission {
                    question_id: "tags".to_owned(),
                    value: FfiUserInputAnswerValue::Multi {
                        values: vec!["b".to_owned()]
                    },
                },
            ]),
            "the provider's values"
        );
    }

    #[test]
    fn typed_text_shows_as_your_answer_until_an_option_is_picked() {
        let pending = two_steps();
        let typed = panel(&pending, 0, &HashMap::new(), "MySQL");
        assert_eq!(
            typed.custom_answer.as_deref(),
            Some("MySQL"),
            "live typed answer"
        );

        let picked = question_toggle_option(
            pending.clone(),
            "db".to_owned(),
            HashMap::new(),
            "sqlite".to_owned(),
        );
        assert_eq!(
            panel(&pending, 0, &picked, "MySQL").custom_answer,
            None,
            "a single-choice pick hides the typed text"
        );

        let sent = question_set_custom_answer(
            pending.clone(),
            "db".to_owned(),
            picked,
            "MySQL".to_owned(),
        );
        let after = panel(&pending, 0, &sent, "");
        assert_eq!(
            after.custom_answer.as_deref(),
            Some("MySQL"),
            "the sent text is the answer"
        );
        assert!(!after.options[1].selected, "and replaces the pick");
    }

    #[test]
    fn a_suggested_answer_counts_until_edited() {
        let mut q = question("branch", Vec::new(), false);
        q.initial_answer = Some("main".to_owned());
        let pending = pending(vec![q]);
        let first = panel(&pending, 0, &HashMap::new(), "");
        assert_eq!(
            first.custom_answer.as_deref(),
            Some("main"),
            "suggestion shows"
        );
        assert!(first.show_send, "and answers");
        assert_eq!(first.composer_placeholder, "Type your answer", "no options");
    }

    #[test]
    fn a_question_nobody_waits_for_is_dimmed_and_says_why() {
        let mut no_text = question("pick", vec![option("a", "", None)], false);
        no_text.allow_custom_answer = false;
        let mut gone = pending(vec![no_text]);
        gone.answerable = false;
        gone.dismissible = true;
        let shown = panel(&gone, 0, &HashMap::new(), "typed");
        assert!(shown.dimmed && shown.options_disabled, "dimmed");
        assert!(shown.notice.is_some(), "says the provider is gone");
        assert!(shown.show_skip && shown.show_footer, "can still skip");
        assert!(!shown.accepts_text, "no free text");
        assert_eq!(shown.custom_answer, None, "typed text is not an answer");
        assert_eq!(
            shown.composer_placeholder, "Choose an option above",
            "placeholder"
        );
    }

    #[derive(Debug)]
    struct Chars(usize);

    impl FfiTextFits for Chars {
        fn fits(&self, text: String, with_more: bool) -> bool {
            text.chars().count() + if with_more { 13 } else { 0 } <= self.0
        }
    }

    #[test]
    fn the_context_clamp_asks_swift_what_fits() {
        assert_eq!(
            question_context_clamp(
                "We weigh the trade-off between speed and cost".to_owned(),
                Arc::new(Chars(33)),
            )
            .as_deref(),
            Some("We weigh the"),
            "ends on a whole word"
        );
        assert_eq!(
            question_context_clamp("short".to_owned(), Arc::new(Chars(33))),
            None,
            "fits"
        );
    }
}
