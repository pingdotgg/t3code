//! Searching thread messages from the sidebar (`useThreadSearch`, `searchSidebarThreads`,
//! `rankMessageMatches`, `nextShownOrder`, `visibleThreadSearch`, `findSearchTokenRanges` in
//! `packages/client-runtime/src/state/threadSearch.ts` and `packages/shared/src/paletteSearch.ts`).
//! The server finds the messages (`orchestration.searchThreads`); the client ranks them, keeps the
//! rows it showed in place while slower answers arrive, and marks the words in each snippet.
//! Plain data in and out, so the iPhone app can share it.
//!
//! Folding is per `char`, as Conn's is per UTF-16 unit, so a range found in the folded text is a
//! range of the original. Conn folds with Unicode NFKD; this folds the Latin letters with accents
//! that `docs/scope.md` languages use, and leaves other scripts as typed.

use std::collections::HashSet;

use conn_contract::{
    OrchestrationThreadSearchMatch as Match, OrchestrationThreadSearchSource as Source,
    OrchestrationV2ThreadShell as ThreadShell,
};

use crate::thread::parse_iso8601_epoch_ms;

/// `THREAD_SEARCH_DEBOUNCE_MS`: a query settles this long before it is sent.
pub const THREAD_SEARCH_DEBOUNCE_MS: u64 = 120;
/// `THREAD_SEARCH_QUERY_MAX_LENGTH`: a longer pasted text searches by its start.
pub const THREAD_SEARCH_QUERY_MAX_LENGTH: usize = 200;
/// Rows past the limit a slower answer's best matches may take (`LATE_ROOM`).
const LATE_ROOM: usize = 3;
/// A two-letter Latin substring of a message is noise rather than a match.
const MESSAGE_TOKEN_MIN_LENGTH: usize = 3;
/// A shorter token only counts where it starts a word.
const MESSAGE_WORD_START_LENGTH: usize = 4;
/// `MESSAGE_PREFIX`: a match this good is a word match.
const MESSAGE_PREFIX: f64 = 0.8;
const USE_BOOST_LIMIT: f64 = 2.5;
const HALF_LIFE_MS: f64 = 14.0 * 24.0 * 60.0 * 60.0 * 1000.0;

const WRAPPING_QUOTES: &[char] = &[
    '"', '\'', '`', '\u{201c}', '\u{201d}', '\u{2018}', '\u{2019}',
];

fn strip_wrapping_quotes(query: &str) -> &str {
    query
        .trim_start_matches(char::is_whitespace)
        .trim_start_matches(WRAPPING_QUOTES)
        .trim_end_matches(char::is_whitespace)
        .trim_end_matches(WRAPPING_QUOTES)
}

/// The Latin letter an accented letter folds to.
fn latin_base(c: char) -> Option<char> {
    Some(match c {
        'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' | 'ā' | 'ă' | 'ą' => 'a',
        'ç' | 'ć' | 'ĉ' | 'ċ' | 'č' => 'c',
        'ď' | 'đ' => 'd',
        'è' | 'é' | 'ê' | 'ë' | 'ē' | 'ĕ' | 'ė' | 'ę' | 'ě' => 'e',
        'ĝ' | 'ğ' | 'ġ' | 'ģ' => 'g',
        'ĥ' | 'ħ' => 'h',
        'ì' | 'í' | 'î' | 'ï' | 'ĩ' | 'ī' | 'ĭ' | 'į' | 'ı' => 'i',
        'ĵ' => 'j',
        'ķ' => 'k',
        'ĺ' | 'ļ' | 'ľ' | 'ŀ' | 'ł' => 'l',
        'ñ' | 'ń' | 'ņ' | 'ň' => 'n',
        'ò' | 'ó' | 'ô' | 'õ' | 'ö' | 'ø' | 'ō' | 'ŏ' | 'ő' => 'o',
        'ŕ' | 'ŗ' | 'ř' => 'r',
        'ś' | 'ŝ' | 'ş' | 'š' => 's',
        'ţ' | 'ť' | 'ŧ' => 't',
        'ù' | 'ú' | 'û' | 'ü' | 'ũ' | 'ū' | 'ŭ' | 'ů' | 'ű' | 'ų' => 'u',
        'ŵ' => 'w',
        'ý' | 'ÿ' | 'ŷ' => 'y',
        'ź' | 'ż' | 'ž' => 'z',
        _ => return None,
    })
}

/// `foldCharacter` for one `char`: case and accents folded to a single `char`.
fn fold_char(c: char) -> char {
    let mut lower = c.to_lowercase();
    let first = lower.next().unwrap_or(c);
    let lowered = if lower.next().is_some() { c } else { first };
    match latin_base(lowered).unwrap_or(lowered) {
        'ς' => 'σ',
        '\u{2018}' | '\u{2019}' => '\'',
        other => other,
    }
}

fn is_cjk(c: char) -> bool {
    matches!(u32::from(c), 0x3040..=0x30ff | 0x3400..=0x4dbf | 0x4e00..=0x9fff | 0xf900..=0xfaff)
}

fn has_cjk_word(token: &str) -> bool {
    token
        .chars()
        .any(|c| is_cjk(c) || matches!(u32::from(c), 0xac00..=0xd7af))
}

/// `\p{So}`, close enough: emoji and the common symbol blocks.
fn is_symbol(c: char) -> bool {
    matches!(
        u32::from(c),
        0xa6 | 0xa9 | 0xae | 0xb0 | 0x2190..=0x2bff | 0x1f000..=0x1faff
    )
}

/// `foldSearchQuery`: folded, whitespace collapsed; empty when there is nothing to match.
#[must_use]
pub fn fold_search_query(query: &str) -> String {
    strip_wrapping_quotes(query)
        .split_whitespace()
        .map(|word| word.chars().map(fold_char).collect::<String>())
        .collect::<Vec<_>>()
        .join(" ")
}

/// The words of a query, split by how well they search messages.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct MessageTokens {
    /// Words of three or more letters (two CJK characters count); every one must match.
    pub long: Vec<String>,
    /// Shorter words, which only narrow the hits.
    pub short: Vec<String>,
}

/// `messageSearchTokens`. Accents stay: the server index folds Latin accents itself.
#[must_use]
pub fn message_search_tokens(query: &str) -> MessageTokens {
    let straight = strip_wrapping_quotes(query)
        .replace(['\u{2018}', '\u{2019}'], "'")
        .to_lowercase();
    let mut tokens = MessageTokens::default();
    for word in straight.split_whitespace() {
        let length = word.chars().count();
        if length >= MESSAGE_TOKEN_MIN_LENGTH || (length == 2 && has_cjk_word(word)) {
            tokens.long.push(word.to_owned());
        } else {
            tokens.short.push(word.to_owned());
        }
    }
    tokens
}

/// The query sent to the server: trimmed and cut to the length it takes; `None` while no word is
/// long enough to search messages for (the server answers nothing for it).
#[must_use]
pub fn search_query(query: &str) -> Option<String> {
    let normalized: String = query
        .trim()
        .chars()
        .take(THREAD_SEARCH_QUERY_MAX_LENGTH)
        .collect::<String>()
        .trim()
        .to_owned();
    (!message_search_tokens(&normalized).long.is_empty()).then_some(normalized)
}

/// A place in a text, in bytes: `text[start..end]`.
pub type TextRange = std::ops::Range<usize>;

fn is_word_start(
    before_previous: Option<char>,
    previous: Option<char>,
    c: char,
    next: Option<char>,
) -> bool {
    let apostrophe_after = previous.is_some_and(|p| p == '\'' || p == '\u{2019}')
        && before_previous.is_some_and(char::is_alphanumeric);
    (c.is_alphanumeric() || is_symbol(c))
        && !apostrophe_after
        && (previous.is_none_or(|p| !p.is_alphanumeric())
            || (previous.is_some_and(char::is_lowercase) && c.is_uppercase())
            // The last capital of an acronym starts the next word: "JSONSchema".
            || (previous.is_some_and(char::is_uppercase)
                && c.is_uppercase()
                && next.is_some_and(char::is_lowercase))
            || previous.is_some_and(|p| p.is_numeric() != c.is_numeric())
            || is_cjk(c))
}

/// `findSearchTokenRanges`: where the long words of `query` are in `text`, ignoring case and
/// accents, for highlighting a snippet. A short long word only counts where it starts a word.
#[must_use]
pub fn find_search_token_ranges(text: &str, query: &str) -> Vec<TextRange> {
    let tokens: Vec<(Vec<char>, bool)> = message_search_tokens(query)
        .long
        .iter()
        .filter_map(|token| {
            let folded: Vec<char> = fold_search_query(token).chars().collect();
            // Some tokens fold to nothing, which would match everywhere.
            (!folded.is_empty())
                .then(|| (folded, token.chars().count() < MESSAGE_WORD_START_LENGTH))
        })
        .collect();
    if tokens.is_empty() {
        return Vec::new();
    }
    let chars: Vec<char> = text.chars().collect();
    let folded: Vec<char> = chars.iter().map(|c| fold_char(*c)).collect();
    let starts: Vec<bool> = (0..chars.len())
        .map(|i| {
            let at = |offset: usize| i.checked_sub(offset).and_then(|j| chars.get(j)).copied();
            is_word_start(at(2), at(1), chars[i], chars.get(i + 1).copied())
        })
        .collect();
    let mut found: Vec<(usize, usize)> = Vec::new();
    for (token, needs_word_start) in &tokens {
        // A token that opens with punctuation brings its own boundary.
        let own_boundary = !token[0].is_alphanumeric() && !is_symbol(token[0]);
        let mut index = 0;
        while index + token.len() <= folded.len() {
            if folded[index..index + token.len()] == token[..] {
                if *needs_word_start && !own_boundary && !starts[index] {
                    index += 1;
                    continue;
                }
                found.push((index, index + token.len()));
                index += token.len();
            } else {
                index += 1;
            }
        }
    }
    found.sort_unstable();
    let mut merged: Vec<(usize, usize)> = Vec::new();
    for (start, end) in found {
        match merged.last_mut() {
            Some(last) if start <= last.1 => last.1 = last.1.max(end),
            _ => merged.push((start, end)),
        }
    }
    let mut offsets: Vec<usize> = text.char_indices().map(|(at, _)| at).collect();
    offsets.push(text.len());
    merged
        .into_iter()
        .map(|(start, end)| offsets[start]..offsets[end])
        .collect()
}

/// One stretch of a snippet and whether it holds a searched word (`splitSearchText`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SnippetPart {
    pub text: String,
    pub highlighted: bool,
}

/// `text` cut into plain and highlighted parts at sorted, non-overlapping `ranges`.
#[must_use]
pub fn split_search_text(text: &str, ranges: &[TextRange]) -> Vec<SnippetPart> {
    let mut parts = Vec::new();
    let mut cursor = 0;
    for range in ranges {
        if range.start > cursor {
            parts.push(SnippetPart {
                text: text[cursor..range.start].to_owned(),
                highlighted: false,
            });
        }
        parts.push(SnippetPart {
            text: text[range.clone()].to_owned(),
            highlighted: true,
        });
        cursor = range.end;
    }
    if cursor < text.len() || parts.is_empty() {
        parts.push(SnippetPart {
            text: text[cursor..].to_owned(),
            highlighted: false,
        });
    }
    parts
}

/// The tag in front of a snippet: who wrote the message (`ThreadSearchMatchExcerpt`).
#[must_use]
pub fn excerpt_label(source: Source) -> &'static str {
    match source {
        Source::User => "You:",
        Source::Assistant => "Agent:",
    }
}

/// What ranking reads of a thread (`ThreadSearchSubject`).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Subject {
    /// When the user last wrote in the thread, in epoch milliseconds.
    pub activity_at: Option<f64>,
    /// The server's open history: `(score, openedAt)`.
    pub opens: Option<(f64, f64)>,
}

impl Subject {
    /// The subject of a thread shell (`threadSearchSubject`).
    #[must_use]
    pub fn of(thread: &ThreadShell) -> Self {
        let ms = |iso: &str| parse_iso8601_epoch_ms(iso).map(|ms| ms as f64);
        let activity_at = match &thread.latest_user_authored_message_at {
            Some(Some(at)) => ms(at),
            Some(None) => None,
            None => thread.latest_user_message_at.as_deref().and_then(ms),
        }
        .or_else(|| ms(&thread.created_at))
        .or_else(|| ms(&thread.updated_at));
        Self {
            activity_at,
            opens: thread
                .opens
                .as_ref()
                .and_then(Option::as_ref)
                .map(|opens| (opens.score, opens.opened_at)),
        }
    }
}

fn decay(age_ms: f64) -> f64 {
    2.0_f64.powf(-age_ms.max(0.0) / HALF_LIFE_MS)
}

/// How much use lifts a thread: 1 for a stale, never-opened thread, about 2 for one active today,
/// up to 2.5 for threads opened often (`threadUsageBoost`).
fn usage_boost(subject: Subject, now_ms: f64) -> f64 {
    let recency = subject.activity_at.map_or(0.0, |at| decay(now_ms - at));
    let opens = subject
        .opens
        .map_or(0.0, |(score, opened_at)| score * decay(now_ms - opened_at));
    (1.0 + recency + 0.5 * (1.0 + opens).log2()).min(USE_BOOST_LIMIT)
}

/// `rankMessageMatches` with picks off, as a list filter: word matches first, then the closer
/// match, then the thread that keeps using the word and was used lately, then the newer message.
/// A server that sends no quality counts every match as a word.
#[must_use]
pub fn rank_message_matches(
    matches: &[Match],
    subject_of: impl Fn(&Match) -> Option<Subject>,
    now_ms: f64,
) -> Vec<Match> {
    struct Ranked<'a> {
        found: &'a Match,
        quality: f64,
        score: f64,
    }
    let mut ranked: Vec<Ranked<'_>> = matches
        .iter()
        .filter_map(|found| {
            let subject = subject_of(found)?;
            let hits = found.hits.unwrap_or(1) as f64;
            Some(Ranked {
                found,
                quality: found.quality.unwrap_or(1.0),
                score: (1.0 + (1.0 + hits).log2()) * usage_boost(subject, now_ms),
            })
        })
        .collect();
    ranked.sort_by(|left, right| {
        let word = |r: &Ranked<'_>| r.quality >= MESSAGE_PREFIX;
        word(right)
            .cmp(&word(left))
            .then_with(|| right.quality.total_cmp(&left.quality))
            .then_with(|| right.score.total_cmp(&left.score))
            .then_with(|| {
                let created =
                    |r: &Ranked<'_>| r.found.message_created_at.clone().unwrap_or_default();
                created(right).cmp(&created(left))
            })
    });
    ranked.into_iter().map(|r| r.found.clone()).collect()
}

/// Result keys in the order a search box last showed them for a query (`ShownOrder`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ShownOrder {
    pub query: String,
    pub keys: Vec<String>,
    /// How many of `keys` are on screen; only those hold their places.
    pub shown: usize,
}

/// `nextShownOrder`: keeps the rows shown in place so a late answer cannot move the pointer or
/// keyboard target, and lets a few of its best matches in.
#[must_use]
pub fn next_shown_order(
    previous: Option<&ShownOrder>,
    query: &str,
    ranked: &[String],
    limit: usize,
) -> ShownOrder {
    let Some(previous) = previous.filter(|p| p.query == query) else {
        return ShownOrder {
            query: query.to_owned(),
            keys: ranked.to_vec(),
            shown: limit.min(ranked.len()),
        };
    };
    let listed: HashSet<&String> = ranked.iter().collect();
    let kept: Vec<String> = previous
        .keys
        .iter()
        .take(previous.shown)
        .filter(|key| listed.contains(key))
        .cloned()
        .collect();
    let held: HashSet<&String> = kept.iter().collect();
    let seen: HashSet<&String> = previous.keys.iter().collect();
    let rest: Vec<String> = ranked
        .iter()
        .filter(|key| !held.contains(key))
        .cloned()
        .collect();
    let arrived = rest.iter().filter(|key| !seen.contains(key)).count();
    let keys: Vec<String> = kept.iter().cloned().chain(rest).collect();
    let shown = keys
        .len()
        .min(limit.saturating_add(LATE_ROOM))
        .min(limit.max(kept.len() + arrived.min(LATE_ROOM)));
    if shown == previous.shown && keys == previous.keys {
        return previous.clone();
    }
    ShownOrder {
        query: query.to_owned(),
        keys,
        shown,
    }
}

/// The matches of one query (`SettledThreadSearch`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SettledSearch {
    pub query: String,
    pub matches: Vec<Match>,
}

/// `visibleThreadSearch`: the new results once they arrive, else the last ones while the query
/// only refines or widens theirs, so rows do not blink out and back on every key.
#[must_use]
pub fn visible_thread_search(
    query: &str,
    ready: Option<&SettledSearch>,
    previous: Option<&SettledSearch>,
) -> SettledSearch {
    if let Some(ready) = ready {
        return ready.clone();
    }
    let current = fold_search_query(query);
    let before = previous
        .map(|p| fold_search_query(&p.query))
        .unwrap_or_default();
    match previous {
        Some(previous)
            if !current.is_empty()
                && !before.is_empty()
                && (current.starts_with(&before) || before.starts_with(&current)) =>
        {
            previous.clone()
        }
        _ => SettledSearch::default(),
    }
}

/// `searchSidebarThreads`: the rows whose titles match, then the threads listed only because a
/// message matches, in the order the messages were ranked.
#[must_use]
pub fn merge_results(title_matches: &[String], message_matches: &[String]) -> Vec<String> {
    let listed: HashSet<&String> = title_matches.iter().collect();
    title_matches
        .iter()
        .cloned()
        .chain(
            message_matches
                .iter()
                .filter(|id| !listed.contains(id))
                .cloned(),
        )
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_threads::thread;
    use serde_json::json;

    fn hit(thread_id: &str, at: &str, quality: Option<f64>, hits: Option<i64>) -> Match {
        Match {
            thread_id: thread_id.to_owned(),
            project_id: "p".to_owned(),
            source: Source::User,
            snippet: "a snippet".to_owned(),
            message_created_at: Some(at.to_owned()),
            quality,
            hits,
            message_id: None,
        }
    }

    fn keys(list: &[&str]) -> Vec<String> {
        list.iter().map(|key| (*key).to_owned()).collect()
    }

    #[test]
    fn words_of_three_letters_search_messages_and_shorter_ones_only_narrow() {
        let tokens = message_search_tokens("  “Fix ui sidebar” ");
        assert_eq!(tokens.long, ["fix", "sidebar"]);
        assert_eq!(tokens.short, ["ui"]);
        assert_eq!(message_search_tokens("世界").long, ["世界"]);
        assert!(message_search_tokens("ab cd").long.is_empty());
    }

    #[test]
    fn a_query_is_cut_and_searches_only_with_a_long_word() {
        assert_eq!(
            search_query("  hello world  ").as_deref(),
            Some("hello world")
        );
        assert_eq!(search_query("ui ab"), None);
        assert_eq!(search_query("   "), None);
        let long = "word ".repeat(100);
        assert!(
            search_query(&long)
                .is_some_and(|q| q.chars().count() <= THREAD_SEARCH_QUERY_MAX_LENGTH)
        );
    }

    #[test]
    fn folding_ignores_case_accents_and_curly_quotes() {
        assert_eq!(fold_search_query("  “Café   Ünï” "), "cafe uni");
        assert_eq!(fold_search_query("Julius’s"), "julius's");
        assert_eq!(fold_search_query(""), "");
    }

    #[test]
    fn highlights_cover_each_long_word_and_merge_where_they_touch() {
        let text = "Fix the Sidebar search, then fix sidebarsearch";
        let ranges = find_search_token_ranges(text, "sidebar search");
        let marked: Vec<&str> = ranges.iter().map(|r| &text[r.clone()]).collect();
        assert_eq!(marked, ["Sidebar", "search", "sidebarsearch"]);
        let parts = split_search_text("a Fix b", &find_search_token_ranges("a Fix b", "fix"));
        assert_eq!(
            parts,
            [
                SnippetPart {
                    text: "a ".to_owned(),
                    highlighted: false
                },
                SnippetPart {
                    text: "Fix".to_owned(),
                    highlighted: true
                },
                SnippetPart {
                    text: " b".to_owned(),
                    highlighted: false
                },
            ]
        );
    }

    #[test]
    fn a_three_letter_word_marks_only_where_a_word_starts_and_accents_still_match() {
        let text = "prefix fix: Éclair";
        let ranges = find_search_token_ranges(text, "fix");
        assert_eq!(
            ranges.iter().map(|r| &text[r.clone()]).collect::<Vec<_>>(),
            ["fix"]
        );
        assert_eq!(ranges[0].start, "prefix ".len());
        let accent = find_search_token_ranges(text, "eclair");
        assert_eq!(
            accent.iter().map(|r| &text[r.clone()]).collect::<Vec<_>>(),
            ["Éclair"]
        );
        assert!(find_search_token_ranges(text, "zz").is_empty());
    }

    #[test]
    fn a_snippet_with_no_match_is_one_plain_part_and_the_label_names_the_writer() {
        assert_eq!(split_search_text("plain", &[]).len(), 1);
        assert_eq!(excerpt_label(Source::User), "You:");
        assert_eq!(excerpt_label(Source::Assistant), "Agent:");
    }

    #[test]
    fn ranking_puts_the_closer_match_first_then_the_used_thread_then_the_newer_message() {
        let now = 1_800_000_000_000.0;
        let matches = [
            hit("weak", "2026-11-20T00:00:00.000Z", Some(0.5), Some(9)),
            hit("busy", "2026-11-19T00:00:00.000Z", Some(1.0), Some(30)),
            hit("quiet", "2026-11-19T00:00:00.000Z", Some(1.0), Some(1)),
            hit("newer", "2026-11-21T00:00:00.000Z", Some(1.0), Some(1)),
        ];
        let ranked = rank_message_matches(&matches, |_| Some(Subject::default()), now);
        let order: Vec<&str> = ranked.iter().map(|m| m.thread_id.as_str()).collect();
        assert_eq!(order, ["busy", "newer", "quiet", "weak"]);
        // A thread the client does not list has no row, so its match is dropped.
        let none = rank_message_matches(
            &matches,
            |m| (m.thread_id == "busy").then(Subject::default),
            now,
        );
        assert_eq!(none.len(), 1);
    }

    #[test]
    fn a_server_that_sends_no_quality_ranks_by_use_and_then_message_time() {
        let matches = [
            hit("old-use", "2026-11-21T00:00:00.000Z", None, None),
            hit("fresh-use", "2026-11-20T00:00:00.000Z", None, None),
        ];
        let used = thread("fresh-use", "p", |t| {
            t["latestUserMessageAt"] = json!("2026-11-20T00:00:00.000Z")
        });
        let ranked = rank_message_matches(
            &matches,
            |m| {
                Some(if m.thread_id == "fresh-use" {
                    Subject {
                        activity_at: Subject::of(&used).activity_at,
                        opens: None,
                    }
                } else {
                    Subject::default()
                })
            },
            parse_iso8601_epoch_ms("2026-11-21T00:00:00.000Z").unwrap_or(0) as f64,
        );
        assert_eq!(ranked[0].thread_id, "fresh-use");
    }

    #[test]
    fn shown_rows_keep_their_places_while_late_answers_come_in() {
        let first = next_shown_order(None, "q", &keys(&["a", "b", "c"]), 5);
        assert_eq!((first.shown, first.keys.len()), (3, 3));
        // A slower environment answers with a better match: it goes below the rows shown.
        let late = next_shown_order(Some(&first), "q", &keys(&["z", "a", "b", "c"]), 3);
        assert_eq!(late.keys, ["a", "b", "c", "z"]);
        assert_eq!(late.shown, 4);
        // The same answer again changes nothing.
        assert_eq!(
            next_shown_order(Some(&late), "q", &keys(&["z", "a", "b", "c"]), 3),
            late
        );
        // A new query starts over.
        assert_eq!(
            next_shown_order(Some(&late), "r", &keys(&["z"]), 3).keys,
            ["z"]
        );
        // A row that left the answer leaves the list.
        let gone = next_shown_order(Some(&late), "q", &keys(&["a", "c"]), 3);
        assert_eq!(gone.keys, ["a", "c"]);
        // No limit (Conn passes `Infinity`) shows every row, and a later answer does not overflow.
        let all = next_shown_order(None, "q", &keys(&["a", "b"]), usize::MAX);
        assert_eq!(all.shown, 2);
        let more = next_shown_order(Some(&all), "q", &keys(&["a", "b", "c"]), usize::MAX);
        assert_eq!(more.shown, 3);
    }

    #[test]
    fn the_last_results_stay_while_a_query_refines_them_and_clear_for_another() {
        let last = SettledSearch {
            query: "side".to_owned(),
            matches: vec![hit("a", "2026-11-20T00:00:00.000Z", None, None)],
        };
        assert_eq!(
            visible_thread_search("sideb", None, Some(&last))
                .matches
                .len(),
            1
        );
        assert_eq!(
            visible_thread_search("sid", None, Some(&last))
                .matches
                .len(),
            1
        );
        assert!(
            visible_thread_search("other", None, Some(&last))
                .matches
                .is_empty()
        );
        assert!(
            visible_thread_search("", None, Some(&last))
                .matches
                .is_empty()
        );
        let ready = SettledSearch {
            query: "other".to_owned(),
            matches: vec![],
        };
        assert_eq!(
            visible_thread_search("other", Some(&ready), Some(&last)),
            ready
        );
    }

    #[test]
    fn titles_come_first_and_a_thread_listed_by_its_title_is_not_listed_again() {
        assert_eq!(
            merge_results(&keys(&["t1", "t2"]), &keys(&["m1", "t2", "m2"])),
            ["t1", "t2", "m1", "m2"]
        );
    }
}
