//! Pure logic of the pending question card (`pendingUserInputContext.logic.ts`,
//! `ComposerPendingUserInputPanel.tsx`): no GPUI types.

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

/// The Next / Send pill (`showPrimary` and `primaryDisabled` in Conn): shown once the answer is
/// enough to go on, or on a multi-select that is not the last question. Hidden while a
/// single-select answer auto-advances.
pub(super) fn question_primary(
    is_last: bool,
    multi_select: bool,
    answered: bool,
    complete: bool,
    auto_advancing: bool,
    responding: bool,
) -> QuestionPrimary {
    let ready = if is_last { complete } else { answered };
    QuestionPrimary {
        show: !auto_advancing && (ready || (!is_last && multi_select)),
        enabled: !responding && ready,
    }
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

    #[test]
    fn primary_follows_the_answer_and_the_question_kind() {
        // Single-select, not last: appears once answered, never while auto-advancing.
        assert_eq!(
            question_primary(false, false, false, false, false, false),
            QuestionPrimary {
                show: false,
                enabled: false
            }
        );
        assert_eq!(
            question_primary(false, false, true, false, false, false),
            QuestionPrimary {
                show: true,
                enabled: true
            }
        );
        assert!(!question_primary(false, false, true, false, true, false).show);
        // Multi-select, not last: Next shows from the start, disabled until answered.
        assert_eq!(
            question_primary(false, true, false, false, false, false),
            QuestionPrimary {
                show: true,
                enabled: false
            }
        );
        // Last question: Send needs every question answered.
        assert_eq!(
            question_primary(true, true, true, false, false, false),
            QuestionPrimary {
                show: false,
                enabled: false
            }
        );
        assert_eq!(
            question_primary(true, false, true, true, false, false),
            QuestionPrimary {
                show: true,
                enabled: true
            }
        );
        // Responding keeps the pill but blocks it.
        assert_eq!(
            question_primary(true, false, true, true, false, true),
            QuestionPrimary {
                show: true,
                enabled: false
            }
        );
    }
}
