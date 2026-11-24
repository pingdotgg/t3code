//! Pure logic of the pending question panel shared by the desktop and iPhone clients: the
//! "(Recommended)" pill, the plain-text preview of the agent's context and its three-line clamp
//! (`splitRecommendedLabel`, `markdownPreviewText`, mobile's `AgentContext`), and seeded drafts
//! (`seedUserInputDraftAnswers`).

use std::collections::HashMap;

use crate::timeline::{UserInputDraft, UserInputQuestion};

/// Splits a trailing "(Recommended)" from an option label (`splitRecommendedLabel`).
/// The row shows the mark as a pill instead. Brackets may be mixed, like Conn's regex.
#[must_use]
pub fn split_recommended_label(label: &str) -> (&str, bool) {
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

/// The markdown as plain lines, one per paragraph, list item or code line, with the syntax
/// dropped (`markdownPreviewText`).
#[must_use]
pub fn markdown_preview_text(markdown: &str) -> String {
    let mut lines: Vec<String> = Vec::new();
    let mut in_fence = false;
    for raw in markdown.split('\n') {
        let line = raw.trim_end();
        if is_fence(line) {
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
        let mut text = strip_heading(line).to_owned();
        text = replace_bullet(&text);
        text = strip_quote(&text).to_owned();
        for rule in [image, link, bold, italic, code] {
            text = replace_all(&text, rule);
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
pub fn clamp_context(preview: &str, mut fits: impl FnMut(&str, bool) -> bool) -> Option<String> {
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

/// The drafts with each question's suggested answer (`initial_answer`) filled in until the user
/// edits it (`seedUserInputDraftAnswers`). Only edits are stored; the suggestion is shown.
#[must_use]
pub fn seed_user_input_drafts(
    questions: &[UserInputQuestion],
    drafts: &HashMap<String, UserInputDraft>,
) -> HashMap<String, UserInputDraft> {
    let mut seeded = drafts.clone();
    for question in questions {
        if let Some(initial) = &question.initial_answer
            && question.allow_custom_answer
            && !drafts.contains_key(&question.id)
        {
            seeded.insert(
                question.id.clone(),
                UserInputDraft {
                    selected: Vec::new(),
                    custom: Some(initial.clone()),
                },
            );
        }
    }
    seeded
}

// ---------------------------------------------------------------------------------------------
// markdownPreviewText's regular expressions, by hand
// ---------------------------------------------------------------------------------------------

/// `^\s*(```|~~~)`.
fn is_fence(line: &str) -> bool {
    let rest = line.trim_start();
    rest.starts_with("```") || rest.starts_with("~~~")
}

/// `^\s{0,3}#{1,6}\s+` removed.
fn strip_heading(line: &str) -> &str {
    let indent = line
        .char_indices()
        .take_while(|(_, c)| c.is_whitespace())
        .take(4)
        .count();
    if indent > 3 {
        return line;
    }
    let after_indent: usize = line.chars().take(indent).map(char::len_utf8).sum();
    let rest = &line[after_indent..];
    let hashes = rest.len() - rest.trim_start_matches('#').len();
    if !(1..=6).contains(&hashes) {
        return line;
    }
    let after_hashes = &rest[hashes..];
    let body = after_hashes.trim_start();
    if body.len() == after_hashes.len() {
        return line;
    }
    body
}

/// `^\s*[-*+]\s+` replaced with `• `.
fn replace_bullet(line: &str) -> String {
    let rest = line.trim_start();
    let Some(marker) = rest.chars().next().filter(|c| matches!(c, '-' | '*' | '+')) else {
        return line.to_owned();
    };
    let after = &rest[marker.len_utf8()..];
    let body = after.trim_start();
    if body.len() == after.len() {
        return line.to_owned();
    }
    format!("• {body}")
}

/// `^\s*>\s?` removed.
fn strip_quote(line: &str) -> &str {
    let Some(after) = line.trim_start().strip_prefix('>') else {
        return line;
    };
    after
        .chars()
        .next()
        .filter(|c| c.is_whitespace())
        .map_or(after, |space| &after[space.len_utf8()..])
}

/// One `replace(pattern, "$1")` rule: the match starting at `at`, as (end, captured group).
type Rule = fn(&[char], usize) -> Option<(usize, std::ops::Range<usize>)>;

/// `replace_all(text, "$1")` with leftmost, first-found matches, like the regex engine.
fn replace_all(text: &str, rule: Rule) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut at = 0;
    while at < chars.len() {
        if let Some((end, group)) = rule(&chars, at) {
            out.extend(&chars[group]);
            at = end;
        } else {
            out.push(chars[at]);
            at += 1;
        }
    }
    out
}

fn find_from(chars: &[char], from: usize, target: char) -> Option<usize> {
    chars
        .get(from..)?
        .iter()
        .position(|c| *c == target)
        .map(|i| i + from)
}

/// `\[([^\]]*)\]\([^)]*\)` starting at the `[`; `min` is the group's least length.
fn bracket_link(
    chars: &[char],
    open: usize,
    min: usize,
) -> Option<(usize, std::ops::Range<usize>)> {
    if chars.get(open) != Some(&'[') {
        return None;
    }
    let close = find_from(chars, open + 1, ']')?;
    if close - (open + 1) < min || chars.get(close + 1) != Some(&'(') {
        return None;
    }
    let paren = find_from(chars, close + 2, ')')?;
    Some((paren + 1, open + 1..close))
}

/// `!\[([^\]]*)\]\([^)]*\)`.
fn image(chars: &[char], at: usize) -> Option<(usize, std::ops::Range<usize>)> {
    if chars[at] != '!' {
        return None;
    }
    bracket_link(chars, at + 1, 0)
}

/// `\[([^\]]+)\]\([^)]*\)`.
fn link(chars: &[char], at: usize) -> Option<(usize, std::ops::Range<usize>)> {
    bracket_link(chars, at, 1)
}

/// `\*\*(.+?)\*\*`.
fn bold(chars: &[char], at: usize) -> Option<(usize, std::ops::Range<usize>)> {
    if chars.get(at..at + 2) != Some(&['*', '*']) {
        return None;
    }
    let start = at + 2;
    (start + 1..chars.len().saturating_sub(1))
        .find(|&end| chars[end] == '*' && chars[end + 1] == '*')
        .map(|end| (end + 2, start..end))
}

/// `[A-Za-z0-9_*]`, the characters an emphasis `*` may not touch.
fn word_or_star(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '*'
}

/// `(?<![A-Za-z0-9_*])\*(?=\S)(.+?)\*(?![A-Za-z0-9_*])`.
fn italic(chars: &[char], at: usize) -> Option<(usize, std::ops::Range<usize>)> {
    if chars[at] != '*' || (at > 0 && word_or_star(chars[at - 1])) {
        return None;
    }
    let start = at + 1;
    if !chars.get(start).is_some_and(|c| !c.is_whitespace()) {
        return None;
    }
    (start + 1..chars.len())
        .find(|&end| chars[end] == '*' && !chars.get(end + 1).copied().is_some_and(word_or_star))
        .map(|end| (end + 1, start..end))
}

/// `` `([^`]*)` ``.
fn code(chars: &[char], at: usize) -> Option<(usize, std::ops::Range<usize>)> {
    if chars[at] != '`' {
        return None;
    }
    let close = find_from(chars, at + 1, '`')?;
    Some((close + 1, at + 1..close))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recommended_suffix_becomes_a_pill() {
        assert_eq!(
            split_recommended_label("Use Postgres (Recommended)"),
            ("Use Postgres", true),
            "parentheses"
        );
        assert_eq!(
            split_recommended_label("Use Postgres [recommended]  "),
            ("Use Postgres", true),
            "brackets and trailing space"
        );
        assert_eq!(
            split_recommended_label("Use Postgres (Recommended]"),
            ("Use Postgres", true),
            "mixed brackets"
        );
        assert_eq!(
            split_recommended_label("Use Postgres ( RECOMMENDED )"),
            ("Use Postgres", true),
            "inner spaces and capitals"
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
    fn preview_text_drops_markdown_syntax() {
        assert_eq!(
            markdown_preview_text(
                "# Plan\n\nUse **bold**, *italic* and `code`.\n- one\n* two\n> quoted\nSee [docs](https://x.y) and ![img](a.png)."
            ),
            "Plan\nUse bold, italic and code.\n• one\n• two\nquoted\nSee docs and img.",
            "headings, emphasis, code, bullets, quotes, links and images"
        );
        assert_eq!(
            markdown_preview_text("Run:\n\n```sh\ncargo test  \n  # not a heading\n```\nDone"),
            "Run:\ncargo test\n  # not a heading\nDone",
            "code lines stay as written, fences and blank lines go"
        );
        assert_eq!(
            markdown_preview_text("2*3*4"),
            "2*3*4",
            "a `*` inside a word is not emphasis"
        );
        assert_eq!(markdown_preview_text("a\r\n\r\nb"), "a\nb", "CRLF");
        assert_eq!(markdown_preview_text("   \n\n"), "", "only blank lines");
    }

    /// Conn mobile's `markdownPreview.test.ts`.
    #[test]
    fn preview_text_matches_mobile() {
        assert_eq!(
            markdown_preview_text(
                "Two **things** matter:\n\n- `queue` drains in [the worker](docs/w.md)\n1. *Speed* wins\n\n```\nCI: 24 min\n```",
            ),
            "Two things matter:\n• queue drains in the worker\n1. Speed wins\nCI: 24 min",
            "one plain line per paragraph, item or code line"
        );
    }

    /// Cases the regular expressions decide in ways a hand-written port could miss. Each
    /// expected value is what mobile's `markdownPreviewText` returns.
    #[test]
    fn preview_text_follows_the_regex_edges() {
        for (markdown, expected) in [
            ("    # indented four", "    # indented four"),
            ("\t# tab heading", "tab heading"),
            ("####### seven", "####### seven"),
            ("#nospace", "#nospace"),
            ("-no space", "-no space"),
            ("  -  two spaces", "• two spaces"),
            (">no space", "no space"),
            ("**unclosed bold", "**unclosed bold"),
            ("****", "**"),
            ("***x***", "x"),
            ("*x* and *y*", "x and y"),
            ("a*b* c", "a*b* c"),
            ("[a](b)(c)", "a(c)"),
            ("![a]([b](c))", "a)"),
            ("a **b** and **c**", "a b and c"),
            ("[](empty)", "[](empty)"),
            ("![](empty)", ""),
            ("[x] (y)", "[x] (y)"),
            ("snake_*case*", "snake_*case*"),
            ("* spaced*", "• spaced*"),
            ("*a*b", "*a*b"),
            ("``", ""),
            ("`unclosed", "`unclosed"),
            ("**bold *and italic***", "bold and italic"),
        ] {
            assert_eq!(markdown_preview_text(markdown), expected, "{markdown:?}");
        }
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
        assert_eq!(
            clamp_context("short text", fits_within(10)),
            None,
            "fits whole"
        );
    }

    #[test]
    fn clamped_context_ends_on_a_whole_word() {
        let text = "We weigh the trade-off between speed and cost";
        assert_eq!(
            clamp_context(text, fits_within(33)).as_deref(),
            Some("We weigh the"),
            "33 characters leave 20 for the text: cut mid-word"
        );
        assert_eq!(
            clamp_context("one two three four five six", fits_within(13 + 7)).as_deref(),
            Some("one two"),
            "the cut lands exactly on a space, so the last word stays"
        );
    }

    #[test]
    fn clamped_context_drops_dangling_punctuation() {
        assert_eq!(
            clamp_context("Pick one: either path works", fits_within(13 + 9)).as_deref(),
            Some("Pick one"),
            "colon"
        );
        assert_eq!(
            clamp_context("A - B - C - D - E - F - G", fits_within(13 + 6)).as_deref(),
            Some("A - B"),
            "dash"
        );
    }

    #[test]
    fn one_long_word_is_cut_where_it_stops_fitting() {
        assert_eq!(
            clamp_context("supercalifragilistic", fits_within(13 + 5)).as_deref(),
            Some("super"),
            "no space to fall back to"
        );
    }

    #[test]
    fn suggested_answers_fill_unedited_drafts() {
        let question = |id: &str, initial: Option<&str>, custom: bool| UserInputQuestion {
            id: id.to_owned(),
            header: String::new(),
            question: String::new(),
            options: Vec::new(),
            multi_select: false,
            allow_custom_answer: custom,
            initial_answer: initial.map(str::to_owned),
        };
        let questions = [
            question("suggested", Some("main"), true),
            question("edited", Some("main"), true),
            question("no-text", Some("main"), false),
            question("plain", None, true),
        ];
        let edited = UserInputDraft {
            selected: Vec::new(),
            custom: Some(String::new()),
        };
        let drafts = HashMap::from([("edited".to_owned(), edited.clone())]);
        let seeded = seed_user_input_drafts(&questions, &drafts);
        assert_eq!(
            seeded.get("suggested").and_then(|d| d.custom.as_deref()),
            Some("main"),
            "the suggestion shows until edited"
        );
        assert_eq!(
            seeded.get("edited"),
            Some(&edited),
            "an edit wins, even empty"
        );
        assert!(
            !seeded.contains_key("no-text"),
            "no free text, no suggestion"
        );
        assert!(!seeded.contains_key("plain"), "nothing to seed");
    }
}
