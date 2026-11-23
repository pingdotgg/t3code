//! Pure logic of the pending question card (`pendingUserInputContext.logic.ts`,
//! `ComposerPendingUserInputPanel.tsx`): no GPUI types.

use std::collections::HashMap;
use std::sync::LazyLock;

use conn_state::{UserInputDraft, UserInputQuestion};
use fancy_regex::Regex;

/// Splits a trailing "(Recommended)" from an option label (`splitRecommendedLabel`).
/// The row shows the mark as a pill instead. Brackets may be mixed, like Conn's regex.
pub(super) fn split_recommended_label(label: &str) -> (&str, bool) {
    let trimmed = label.trim_end();
    let Some(inner_end) = trimmed
        .strip_suffix(')')
        .or_else(|| trimmed.strip_suffix(']'))
    else {
        return (label, false);
    };
    let Some(open) = inner_end.rfind(['(', '[']) else {
        return (label, false);
    };
    if !inner_end[open + 1..]
        .trim()
        .eq_ignore_ascii_case("recommended")
    {
        return (label, false);
    }
    let text = inner_end[..open].trim_end();
    if text.is_empty() {
        (label, false)
    } else {
        (text, true)
    }
}

/// What the bottom row of the question card shows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct QuestionPrimary {
    pub(super) show: bool,
    pub(super) enabled: bool,
}

/// What the Next / Send pill depends on (`pendingPanelActions` in `ChatComposer.tsx`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct PrimaryInput {
    pub(super) is_last: bool,
    pub(super) multi_select: bool,
    /// The active question has an answer (`canAdvance`'s `resolvedAnswer !== null`).
    pub(super) answered: bool,
    /// Every question has an answer (`isComplete`).
    pub(super) complete: bool,
    /// A file is still uploading, which holds Next but not Send (`attachmentBlockReason`).
    pub(super) attachments_blocked: bool,
    /// A single-select pick is about to advance on its own.
    pub(super) auto_advancing: bool,
    /// Dictation is running; Send finishes it and submits (`voiceInputActive`).
    pub(super) voice_active: bool,
    /// Blocked by something outside the answer: offline, preparing, uploading, already sending.
    pub(super) disabled: bool,
}

/// The Next / Send pill (`showPrimary` and `primaryDisabled` in `ComposerPendingUserInputPanel`):
/// shown once the answer is enough to go on, while dictating, or on a multi-select that is not
/// the last question. Hidden while a single-select answer auto-advances.
pub(super) fn question_primary(input: PrimaryInput) -> QuestionPrimary {
    let ready = if input.is_last {
        input.complete
    } else {
        input.answered && !input.attachments_blocked
    };
    QuestionPrimary {
        show: !input.auto_advancing
            && (input.voice_active || ready || (!input.is_last && input.multi_select)),
        enabled: !input.disabled && (input.voice_active || ready),
    }
}

/// Whether every question has an answer, counting the composer's typed text as the answer of
/// question `active` (`isComplete`: Conn mirrors the typed text into that question's draft).
pub(super) fn every_question_answered(
    questions: &[UserInputQuestion],
    drafts: &HashMap<String, UserInputDraft>,
    active: usize,
    active_has_typed_answer: bool,
) -> bool {
    questions.iter().enumerate().all(|(index, question)| {
        (index == active && active_has_typed_answer)
            || question.resolve_answer(drafts.get(&question.id)).is_some()
    })
}

/// Between a set-aside answer and the text already in the thread draft (`DISPLACED_ANSWER_SEPARATOR`).
const DISPLACED_ANSWER_SEPARATOR: &str = "\n\n";

/// The title of the notice shown when picking an option sets typed text aside.
pub(super) const SET_ASIDE_TITLE: &str = "Your typed text was set aside";
/// The notice's second line.
pub(super) const SET_ASIDE_DESCRIPTION: &str =
    "It will be back in the composer once the question is answered.";

/// The thread draft with the typed answer an option displaced added at its end
/// (`carryDisplacedCustomAnswerIntoPrompt`). Blank text changes nothing.
pub(super) fn carry_displaced_into_prompt(prompt: &str, displaced: &str) -> String {
    let displaced = displaced.trim();
    if displaced.is_empty() {
        return prompt.to_owned();
    }
    if prompt.trim().is_empty() {
        return displaced.to_owned();
    }
    format!(
        "{}{DISPLACED_ANSWER_SEPARATOR}{displaced}",
        prompt.trim_end()
    )
}

/// Takes set-aside answer text back out of the thread draft once it is the answer again
/// (`withdrawDisplacedCustomAnswerFromPrompt`). `later` is what was set aside after it, in
/// order: together they locate this copy, so equal text inside another answer or the user's own
/// draft is never the one removed.
pub(super) fn withdraw_displaced_from_prompt(
    prompt: &str,
    displaced: &str,
    later: &[String],
) -> String {
    let text = displaced.trim();
    if text.is_empty() {
        return prompt.to_owned();
    }
    let later: Vec<&str> = later
        .iter()
        .map(|entry| entry.trim())
        .filter(|entry| !entry.is_empty())
        .collect();
    let suffix = std::iter::once(text)
        .chain(later.iter().copied())
        .collect::<Vec<_>>()
        .join(DISPLACED_ANSWER_SEPARATOR);
    let Some(before) = prompt.strip_suffix(suffix.as_str()) else {
        return prompt.to_owned();
    };
    let after = later.join(DISPLACED_ANSWER_SEPARATOR);
    if before.is_empty() {
        return after;
    }
    let Some(before) = before.strip_suffix(DISPLACED_ANSWER_SEPARATOR) else {
        return prompt.to_owned();
    };
    if after.is_empty() {
        before.to_owned()
    } else {
        format!("{before}{DISPLACED_ANSWER_SEPARATOR}{after}")
    }
}

/// One answer set aside into a thread draft.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Displaced {
    /// The draft it went into.
    draft: String,
    /// `{request}:{question}` it was typed for.
    key: String,
    text: String,
}

/// The answers set aside, in the order they went into their drafts, which is how a copy is
/// found again (`displacedAnswers`).
#[derive(Clone, Debug, Default)]
pub(super) struct DisplacedAnswers {
    entries: Vec<Displaced>,
}

impl DisplacedAnswers {
    /// Records `text`, which went into `draft` for the question `key`.
    pub(super) fn push(&mut self, draft: &str, key: &str, text: &str) {
        self.entries.push(Displaced {
            draft: draft.to_owned(),
            key: key.to_owned(),
            text: text.to_owned(),
        });
    }

    /// `value` is the answer again (undo, or retyped): forgets its set-aside copy and returns
    /// the draft without it, or `None` when the draft stays as it is
    /// (`withdrawRestoredAnswer`).
    pub(super) fn withdraw(
        &mut self,
        draft: &str,
        key: &str,
        value: &str,
        prompt: &str,
    ) -> Option<String> {
        let index = self
            .entries
            .iter()
            .rposition(|e| e.draft == draft && e.key == key && e.text.trim() == value.trim())?;
        let displaced = self.entries.remove(index);
        let later: Vec<String> = self.entries[index..]
            .iter()
            .filter(|e| e.draft == displaced.draft)
            .map(|e| e.text.clone())
            .collect();
        let next = withdraw_displaced_from_prompt(prompt, &displaced.text, &later);
        (next != prompt).then_some(next)
    }

    /// Drops what was set aside for requests that are gone.
    pub(super) fn retain_keys(&mut self, mut keep: impl FnMut(&str) -> bool) {
        self.entries.retain(|e| keep(&e.key));
    }
}

/// The modifier keys of a key press.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) struct KeyMods {
    pub(super) control: bool,
    pub(super) alt: bool,
    pub(super) platform: bool,
    pub(super) shift: bool,
}

/// The option a bare `1`-`9` key press picks, when the question has that many options.
///
/// Conn ignores presses with Cmd, Ctrl or Alt held. `shift` is rejected too: GPUI reports a
/// shifted digit as the digit with `shift` set, where the browser reports `!`.
pub(super) fn shortcut_option_index(
    key: &str,
    mods: KeyMods,
    option_count: usize,
) -> Option<usize> {
    if mods.control || mods.alt || mods.platform || mods.shift {
        return None;
    }
    let mut chars = key.chars();
    let digit = chars.next()?.to_digit(10)?;
    if chars.next().is_some() || digit == 0 {
        return None;
    }
    let index = usize::try_from(digit).ok()? - 1;
    (index < option_count).then_some(index)
}

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).unwrap_or_else(|err| panic!("invalid regex {pattern}: {err}"))
}

/// The markdown as plain lines, one per paragraph, list item or code line, with the syntax
/// dropped (`markdownPreviewText`).
pub(super) fn markdown_preview_text(markdown: &str) -> String {
    static FENCE: LazyLock<Regex> = LazyLock::new(|| re(r"^\s*(```|~~~)"));
    static HEADING: LazyLock<Regex> = LazyLock::new(|| re(r"^\s{0,3}#{1,6}\s+"));
    static BULLET: LazyLock<Regex> = LazyLock::new(|| re(r"^\s*[-*+]\s+"));
    static QUOTE: LazyLock<Regex> = LazyLock::new(|| re(r"^\s*>\s?"));
    static IMAGE: LazyLock<Regex> = LazyLock::new(|| re(r"!\[([^\]]*)\]\([^)]*\)"));
    static LINK: LazyLock<Regex> = LazyLock::new(|| re(r"\[([^\]]+)\]\([^)]*\)"));
    static BOLD: LazyLock<Regex> = LazyLock::new(|| re(r"\*\*(.+?)\*\*"));
    static ITALIC: LazyLock<Regex> =
        LazyLock::new(|| re(r"(?<![A-Za-z0-9_*])\*(?=\S)(.+?)\*(?![A-Za-z0-9_*])"));
    static CODE: LazyLock<Regex> = LazyLock::new(|| re(r"`([^`]*)`"));

    let mut lines: Vec<String> = Vec::new();
    let mut in_fence = false;
    for raw in markdown.split('\n') {
        let line = raw.trim_end();
        if FENCE.is_match(line).unwrap_or(false) {
            in_fence = !in_fence;
            continue;
        }
        if line.trim().is_empty() {
            continue;
        }
        if in_fence {
            lines.push(line.to_owned());
            continue;
        }
        let mut text = HEADING.replace(line, "").into_owned();
        text = BULLET.replace(&text, "• ").into_owned();
        text = QUOTE.replace(&text, "").into_owned();
        for pattern in [&IMAGE, &LINK, &BOLD, &ITALIC, &CODE] {
            text = pattern.replace_all(&text, "$1").into_owned();
        }
        lines.push(text);
    }
    lines.join("\n")
}

/// Where the context text stops so that `… Show more` ends on the third line.
///
/// `fits(candidate, with_more)` says whether the text, followed by `… Show more` when
/// `with_more` is set, wraps within three lines at the panel's width. Returns `None` when the
/// whole text fits, else the longest prefix that fits, ending on a whole word with no dangling
/// punctuation: `trade-off… Show more`, never `off:… Show more`.
pub(super) fn clamp_context(
    preview: &str,
    mut fits: impl FnMut(&str, bool) -> bool,
) -> Option<String> {
    if fits(preview, false) {
        return None;
    }
    let chars: Vec<char> = preview.chars().collect();
    let prefix = |len: usize| chars[..len].iter().collect::<String>();
    let (mut low, mut high) = (0, chars.len());
    while low < high {
        let mid = (low + high).div_ceil(2);
        if fits(prefix(mid).trim_end(), true) {
            low = mid;
        } else {
            high = mid - 1;
        }
    }
    let cut = prefix(low);
    let at_word = if chars.get(low).is_some_and(|c| c.is_whitespace()) {
        cut.as_str()
    } else {
        // `cut.replace(/\s+\S*$/, "")`: drop the last, partly cut word and the space before it.
        let word_start = cut
            .char_indices()
            .rev()
            .find(|(_, c)| c.is_whitespace())
            .map(|(at, _)| at);
        match word_start {
            Some(last_space) => cut[..last_space].trim_end_matches(char::is_whitespace),
            None => cut.as_str(),
        }
    };
    Some(
        at_word
            .trim_end()
            .trim_end_matches(|c: char| {
                c.is_whitespace()
                    || matches!(c, ':' | ';' | ',' | '.' | '-' | '\u{2013}' | '\u{2014}')
            })
            .to_owned(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recommended_suffix_becomes_a_pill() {
        assert_eq!(
            split_recommended_label("Use Postgres (Recommended)"),
            ("Use Postgres", true)
        );
        assert_eq!(
            split_recommended_label("Use Postgres [recommended]  "),
            ("Use Postgres", true)
        );
        assert_eq!(
            split_recommended_label("Use Postgres (Recommended]"),
            ("Use Postgres", true)
        );
        assert_eq!(
            split_recommended_label("Use Postgres ( RECOMMENDED )"),
            ("Use Postgres", true)
        );
    }

    #[test]
    fn other_labels_stay_whole() {
        for label in [
            "Use Postgres",
            "Use Postgres (Recommended) now",
            "(Recommended)",
            "Use Postgres (Not recommended)",
            "Recommended)",
        ] {
            assert_eq!(split_recommended_label(label), (label, false), "{label}");
        }
    }

    fn primary(is_last: bool, multi_select: bool, answered: bool, complete: bool) -> PrimaryInput {
        PrimaryInput {
            is_last,
            multi_select,
            answered,
            complete,
            attachments_blocked: false,
            auto_advancing: false,
            voice_active: false,
            disabled: false,
        }
    }

    const SHOWN_ENABLED: QuestionPrimary = QuestionPrimary {
        show: true,
        enabled: true,
    };
    const SHOWN_DISABLED: QuestionPrimary = QuestionPrimary {
        show: true,
        enabled: false,
    };
    const HIDDEN: QuestionPrimary = QuestionPrimary {
        show: false,
        enabled: false,
    };

    #[test]
    fn primary_follows_the_answer_and_the_question_kind() {
        // Single-select, not last: appears once answered, never while auto-advancing.
        assert_eq!(
            question_primary(primary(false, false, false, false)),
            HIDDEN
        );
        assert_eq!(
            question_primary(primary(false, false, true, false)),
            SHOWN_ENABLED
        );
        assert!(
            !question_primary(PrimaryInput {
                auto_advancing: true,
                ..primary(false, false, true, false)
            })
            .show
        );
        // Multi-select, not last: Next shows from the start, disabled until answered.
        assert_eq!(
            question_primary(primary(false, true, false, false)),
            SHOWN_DISABLED
        );
        // Last question: Send needs every question answered.
        assert_eq!(question_primary(primary(true, true, true, false)), HIDDEN);
        assert_eq!(
            question_primary(primary(true, false, true, true)),
            SHOWN_ENABLED
        );
        // Responding or another blocker keeps the pill but blocks it.
        assert_eq!(
            question_primary(PrimaryInput {
                disabled: true,
                ..primary(true, false, true, true)
            }),
            SHOWN_DISABLED
        );
    }

    #[test]
    fn uploads_hold_next_but_not_send() {
        let uploading = |input: PrimaryInput| PrimaryInput {
            attachments_blocked: true,
            disabled: true,
            ..input
        };
        // Not the last question: the answer is not ready, so single-select hides the pill.
        assert_eq!(
            question_primary(uploading(primary(false, false, true, false))),
            HIDDEN
        );
        // The last question: Send shows, but blocked.
        assert_eq!(
            question_primary(uploading(primary(true, false, true, true))),
            SHOWN_DISABLED
        );
    }

    #[test]
    fn dictation_shows_and_enables_the_pill_without_an_answer() {
        let voice = PrimaryInput {
            voice_active: true,
            ..primary(true, false, false, false)
        };
        assert_eq!(question_primary(voice), SHOWN_ENABLED);
        assert_eq!(
            question_primary(PrimaryInput {
                disabled: true,
                ..voice
            }),
            SHOWN_DISABLED
        );
    }

    #[test]
    fn typed_text_answers_only_the_active_question() {
        let question = |id: &str| UserInputQuestion {
            id: id.to_owned(),
            header: id.to_owned(),
            question: id.to_owned(),
            options: vec![conn_state::UserInputOption {
                label: "A".to_owned(),
                description: String::new(),
                value: None,
                preview: None,
            }],
            multi_select: false,
            allow_custom_answer: true,
            initial_answer: None,
        };
        let questions = [question("q1"), question("q2")];
        let mut drafts = HashMap::new();
        assert!(!every_question_answered(&questions, &drafts, 0, false));
        assert!(!every_question_answered(&questions, &drafts, 0, true));
        drafts.insert(
            "q2".to_owned(),
            questions[1].toggle_option(drafts.get("q2"), "A"),
        );
        assert!(every_question_answered(&questions, &drafts, 0, true));
        assert!(!every_question_answered(&questions, &drafts, 0, false));
        assert!(!every_question_answered(&questions, &drafts, 1, true));
    }

    #[test]
    fn displaced_text_joins_the_thread_draft() {
        assert_eq!(carry_displaced_into_prompt("", "first try"), "first try");
        assert_eq!(
            carry_displaced_into_prompt("  \n", " first try "),
            "first try"
        );
        assert_eq!(
            carry_displaced_into_prompt("my draft\n", " first try "),
            "my draft\n\nfirst try"
        );
        // Blank text is not set aside.
        assert_eq!(carry_displaced_into_prompt("my draft", " \n"), "my draft");
    }

    #[test]
    fn withdrawing_takes_out_only_the_copy_that_was_set_aside() {
        let none: [String; 0] = [];
        assert_eq!(withdraw_displaced_from_prompt("a", "a", &none), "");
        assert_eq!(
            withdraw_displaced_from_prompt("mine\n\na", "a", &none),
            "mine"
        );
        // Equal text elsewhere in the draft is not the copy.
        assert_eq!(
            withdraw_displaced_from_prompt("a\n\nmine", "a", &none),
            "a\n\nmine"
        );
        assert_eq!(
            withdraw_displaced_from_prompt("mine a", "a", &none),
            "mine a"
        );
        // Later copies stay, in order.
        let later = ["b".to_owned(), " ".to_owned(), "c".to_owned()];
        assert_eq!(
            withdraw_displaced_from_prompt("mine\n\na\n\nb\n\nc", "a", &later),
            "mine\n\nb\n\nc"
        );
        assert_eq!(
            withdraw_displaced_from_prompt("a\n\nb\n\nc", "a", &later),
            "b\n\nc"
        );
        assert_eq!(withdraw_displaced_from_prompt("keep", "  ", &none), "keep");
    }

    #[test]
    fn a_restored_answer_leaves_the_thread_draft_once() {
        let mut displaced = DisplacedAnswers::default();
        displaced.push("thread:t1", "req:q1", "first try");
        displaced.push("thread:t1", "req:q1", "second");
        displaced.push("thread:t2", "req:q1", "elsewhere");
        let prompt = "first try\n\nsecond";
        // Another thread's copy and other questions' copies are not touched.
        assert_eq!(
            displaced.withdraw("thread:t1", "req:q2", "first try", prompt),
            None
        );
        assert_eq!(
            displaced.withdraw("thread:t3", "req:q1", "first try", prompt),
            None
        );
        // The copy is found by its draft, question and text; later copies stay.
        assert_eq!(
            displaced.withdraw("thread:t1", "req:q1", " first try ", prompt),
            Some("second".to_owned())
        );
        // It is forgotten, so typing the same text again withdraws nothing more.
        assert_eq!(
            displaced.withdraw("thread:t1", "req:q1", "first try", "second"),
            None
        );
        // A copy that is no longer at the end of the draft stays where it is.
        assert_eq!(
            displaced.withdraw("thread:t1", "req:q1", "second", "second and more"),
            None
        );
        displaced.retain_keys(|key| key != "req:q1");
        assert_eq!(
            displaced.withdraw("thread:t2", "req:q1", "elsewhere", "elsewhere"),
            None
        );
    }

    #[test]
    fn digits_pick_the_option_they_number() {
        let plain = KeyMods::default();
        assert_eq!(shortcut_option_index("1", plain, 3), Some(0));
        assert_eq!(shortcut_option_index("3", plain, 3), Some(2));
        assert_eq!(shortcut_option_index("9", plain, 9), Some(8));
        // Past the last option, zero, and anything that is not one digit.
        assert_eq!(shortcut_option_index("4", plain, 3), None);
        assert_eq!(shortcut_option_index("0", plain, 3), None);
        assert_eq!(shortcut_option_index("10", plain, 20), None);
        assert_eq!(shortcut_option_index("a", plain, 3), None);
        assert_eq!(shortcut_option_index("enter", plain, 3), None);
        assert_eq!(shortcut_option_index("", plain, 3), None);
        // Cmd, Ctrl, Alt and Shift belong to other shortcuts.
        for mods in [
            KeyMods {
                control: true,
                ..plain
            },
            KeyMods { alt: true, ..plain },
            KeyMods {
                platform: true,
                ..plain
            },
            KeyMods {
                shift: true,
                ..plain
            },
        ] {
            assert_eq!(shortcut_option_index("1", mods, 3), None, "{mods:?}");
        }
    }

    #[test]
    fn preview_text_drops_markdown_syntax() {
        assert_eq!(
            markdown_preview_text(
                "# Plan\n\nUse **bold**, *italic* and `code`.\n- one\n* two\n> quoted\nSee [docs](https://x.y) and ![img](a.png)."
            ),
            "Plan\nUse bold, italic and code.\n• one\n• two\nquoted\nSee docs and img."
        );
        // Code lines stay as written, fences and blank lines go.
        assert_eq!(
            markdown_preview_text("Run:\n\n```sh\ncargo test  \n  # not a heading\n```\nDone"),
            "Run:\ncargo test\n  # not a heading\nDone"
        );
        // A `*` inside a word is not emphasis.
        assert_eq!(markdown_preview_text("2*3*4"), "2*3*4");
        assert_eq!(markdown_preview_text("a\r\n\r\nb"), "a\nb");
        assert_eq!(markdown_preview_text("   \n\n"), "");
    }

    /// A fake layout: a candidate fits when it has at most `limit` characters, plus the 13 of
    /// `… Show more` when that follows it.
    fn fits_within(limit: usize) -> impl FnMut(&str, bool) -> bool {
        move |candidate, with_more| {
            candidate.chars().count() + if with_more { 13 } else { 0 } <= limit
        }
    }

    #[test]
    fn context_that_fits_is_not_clamped() {
        assert_eq!(clamp_context("short text", fits_within(10)), None);
    }

    #[test]
    fn clamped_context_ends_on_a_whole_word() {
        // 33 characters leave 20 for the text: "trade-off between speed" cut mid-word.
        let text = "We weigh the trade-off between speed and cost";
        assert_eq!(
            clamp_context(text, fits_within(33)).as_deref(),
            Some("We weigh the")
        );
        // The cut lands exactly on a space, so the last word stays.
        assert_eq!(
            clamp_context("one two three four five six", fits_within(13 + 7)).as_deref(),
            Some("one two")
        );
    }

    #[test]
    fn clamped_context_drops_dangling_punctuation() {
        assert_eq!(
            clamp_context("Pick one: either path works", fits_within(13 + 9)).as_deref(),
            Some("Pick one")
        );
        assert_eq!(
            clamp_context("A - B - C - D - E - F - G", fits_within(13 + 6)).as_deref(),
            Some("A - B")
        );
    }

    #[test]
    fn one_long_word_is_cut_where_it_stops_fitting() {
        assert_eq!(
            clamp_context("supercalifragilistic", fits_within(13 + 5)).as_deref(),
            Some("super")
        );
    }
}
