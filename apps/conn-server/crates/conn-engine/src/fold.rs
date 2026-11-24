//! Search text folding, as T3 folds it in two places:
//!
//! - The message search index ([`fold`]): T3 indexes with SQLite's
//!   `trigram remove_diacritics 1` tokenizer (`069_ThreadMessageSearch.ts`). It folds case and
//!   takes a single diacritic off Latin letters ("École" is "ecole"), but keeps the marks that
//!   tell other scripts' letters apart ("が" is not "か"). The index stores folded text, so a
//!   query folded the same way matches it in SQL. The fold is SQLite's own table.
//! - Titles, branches and pull requests ([`fold_search_query`], [`fold_field`]): `foldInPlace`
//!   in `paletteSearch.ts`, which drops every mark a compatibility decomposition leaves.
//!
//! Both read words as `isWordStart` does ([`is_word_start`]), by the Unicode general categories
//! its patterns test. Messages read text in UTF-16 units, as JavaScript strings index it.

use unicode_normalization::UnicodeNormalization;
use unicode_normalization::char::{decompose_compatible, is_combining_mark};

/// The quotes `WRAPPING_QUOTES` in `paletteSearch.ts` strips from both ends of a query.
pub(crate) const WRAPPING_QUOTES: &[char] = &[
    '"', '\'', '`', '\u{201c}', '\u{201d}', '\u{2018}', '\u{2019}',
];

/// `FILLER_WORDS`: words a query may carry that a name leaves out ("fix the sidebar").
const FILLER_WORDS: &[&str] = &[
    "a", "an", "and", "for", "in", "of", "on", "the", "to", "with",
];

/// `text` folded as the message search index stores it: the text every write to an FTS index
/// of message text folds, and every query to it.
pub fn fold(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        push_indexed(c, &mut out);
    }
    out
}

/// Appends `c` folded as SQLite's `trigram remove_diacritics 1` tokenizer folds it, from the
/// table that tokenizer gives ([`sqlite_fold`]). T3's index also stores apostrophes straight
/// (`indexedMessageText`).
pub(crate) fn push_indexed(c: char, out: &mut String) {
    if c.is_ascii() {
        out.push(c.to_ascii_lowercase());
        return;
    }
    match c {
        '\u{2018}' | '\u{2019}' => out.push('\''),
        _ => match sqlite_fold(c) {
            Some(Some(folded)) => out.push(folded),
            Some(None) => {}
            None => out.push(c),
        },
    }
}

/// What the bundled SQLite's tokenizer makes of a non-ASCII code point it changes: its simple
/// case fold, then the ASCII letter of a Latin letter with one diacritic ("é", "Ș", "ſ" folds
/// to "s"), or `Some(None)` for a diacritic it drops. `None` when SQLite keeps `c`, as it keeps
/// "ǡ" (two marks), "が" and letters its Unicode tables predate. `sqlite-fold.txt` holds the
/// table, generated from SQLite and checked against it in this module's tests.
fn sqlite_fold(c: char) -> Option<Option<char>> {
    static TABLE: std::sync::OnceLock<Vec<(char, Option<char>)>> = std::sync::OnceLock::new();
    let table = TABLE.get_or_init(|| {
        let code = |hex: &str| u32::from_str_radix(hex, 16).ok().and_then(char::from_u32);
        include_str!("sqlite-fold.txt")
            .lines()
            .filter(|line| !line.starts_with('#'))
            .filter_map(|line| {
                let (from, to) = line.split_once(' ')?;
                Some((code(from)?, if to == "-" { None } else { Some(code(to)?) }))
            })
            .collect()
    });
    let at = table.binary_search_by_key(&c, |&(from, _)| from).ok()?;
    table.get(at).map(|&(_, to)| to)
}

/// `foldSearchQuery` in `paletteSearch.ts`: quotes around a pasted query dropped, NFC, folded as
/// [`fold_field`], and whitespace collapsed to single spaces.
pub fn fold_search_query(query: &str) -> String {
    let unquoted: String = query.trim().trim_matches(WRAPPING_QUOTES).nfc().collect();
    fold_field(&unquoted)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Maps a curly apostrophe to a straight one, as T3 does to queries and to the text a phrase is
/// looked for in (`CURLY_APOSTROPHES`).
pub(crate) fn straight(c: char) -> char {
    match c {
        '\u{2018}' | '\u{2019}' => '\'',
        _ => c,
    }
}

/// JavaScript's `\s`: Rust's whitespace without U+0085, plus U+FEFF.
pub(crate) fn is_js_space(c: char) -> bool {
    c == '\u{feff}' || (c != '\u{85}' && c.is_whitespace())
}

/// `foldInPlace` in `paletteSearch.ts`: each character as [`push_field`] folds it.
pub fn fold_field(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        push_field(c, &mut out);
    }
    out
}

/// Appends `c` as `foldInPlace` folds it: a character of the Basic Multilingual Plane as
/// `foldCharacter` folds it (NFKD, marks dropped, lower case, final sigma and curly apostrophes
/// made plain) when that leaves one UTF-16 unit, else only lower case: "ß", "ﬁ" and a lone mark
/// stay.
pub(crate) fn push_field(c: char, out: &mut String) {
    if c.is_ascii() {
        out.push(c.to_ascii_lowercase());
        return;
    }
    let mut units = 0;
    let mut single = None;
    if u32::from(c) <= 0xffff {
        decompose_compatible(c, |part| {
            if !is_combining_mark(part) {
                for lower in part.to_lowercase() {
                    units += lower.len_utf16();
                    single = Some(lower);
                }
            }
        });
    }
    match single {
        Some('ς') if units == 1 => out.push('σ'),
        Some('\u{2018}' | '\u{2019}') if units == 1 => out.push('\''),
        Some(single) if units == 1 => out.push(single),
        _ => out.extend(c.to_lowercase()),
    }
}

/// Whether every word of a folded query (`fold_search_query`) starts a word in `text`, as
/// `matchSearchFields` matches a field that takes no mid-word hits: "resume" and "res" find
/// "Résumé indexing", "sume" does not. Filler words may be missing when another word is not one.
pub fn field_holds_words(text: &str, query: &str) -> bool {
    let words: Vec<&str> = query.split(' ').filter(|word| !word.is_empty()).collect();
    let filler_optional = words.iter().any(|word| !FILLER_WORDS.contains(word));
    let field = Folded::new(text, push_field);
    !words.is_empty()
        && words.iter().all(|word| {
            field.has_at_word_start(word) || (filler_optional && FILLER_WORDS.contains(word))
        })
}

/// A thread title, branch or name, folded once for [`match_fields`].
#[derive(Debug)]
pub struct SearchField(Folded);

impl SearchField {
    pub fn new(text: &str) -> Self {
        Self(Folded::new(text, push_field))
    }

    /// Whether the folded field is the whole folded query.
    pub fn is(&self, query: &str) -> bool {
        self.0.text == query
    }
}

/// `matchSearchFields` in `paletteSearch.ts`, without typos or joined words: `Some` when every
/// word of a folded query (`fold_search_query`) starts a word in `title` or in one of `others`,
/// or, with four or more characters, sits inside a word of `title`. Filler words may be missing
/// when another word is not one. `Some(true)` when a word matched in the title.
pub fn match_fields(query: &str, title: &SearchField, others: &[SearchField]) -> Option<bool> {
    let words: Vec<&str> = query.split(' ').filter(|word| !word.is_empty()).collect();
    let filler_optional = words.iter().any(|word| !FILLER_WORDS.contains(word));
    let mut in_title = false;
    for word in &words {
        let title_hit = title.0.has_at_word_start(word)
            || (word.encode_utf16().count() >= 4 && title.0.text.contains(word));
        in_title |= title_hit;
        let optional = filler_optional && FILLER_WORDS.contains(word);
        if !title_hit && !optional && !others.iter().any(|f| f.0.has_at_word_start(word)) {
            return None;
        }
    }
    (!words.is_empty()).then_some(in_title)
}

/// Where a token sits in a message, worst first (`findMessageToken`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum Placement {
    Inside,
    Start,
    Whole,
}

/// `HEX_ID`: a commit SHA or UUID part, seven or more hex characters with a digit.
fn is_hex_id(run: &[char]) -> bool {
    run.len() >= 7
        && run.iter().all(char::is_ascii_hexdigit)
        && run.iter().any(char::is_ascii_digit)
}

/// How a [`Folded`] text reads words: by code point, as `foldSearchField` reads a title, or by
/// UTF-16 unit, as `findMessageToken` reads a message.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Units {
    CodePoints,
    Utf16,
}

/// What a character outside the Basic Multilingual Plane reads as in a message: a lone
/// surrogate in JavaScript, which is no letter, digit, symbol or apostrophe. U+FFFF is a
/// noncharacter in no such category either.
const SURROGATE: char = '\u{ffff}';

/// A text folded one character at a time, which still reads the original's word starts.
#[derive(Debug)]
pub(crate) struct Folded {
    pub(crate) text: String,
    /// For each byte of `text`, the index of the original character it came from.
    origin: Vec<usize>,
    /// The original characters as the word rules read them.
    chars: Vec<char>,
    /// For each original character, and one past the end, its offset in UTF-16 units.
    utf16: Vec<usize>,
}

impl Folded {
    pub(crate) fn new(text: &str, fold: fn(char, &mut String)) -> Self {
        Self::build(text, Units::CodePoints, |_, c, out| fold(c, out))
    }

    /// A message folded by `fold`, read in UTF-16 units.
    pub(crate) fn message(text: &str, fold: fn(char, &mut String)) -> Self {
        Self::build(text, Units::Utf16, |_, c, out| fold(c, out))
    }

    /// A message lowercased as a whole, as `toLowerCase` lowercases it (a final sigma stays
    /// final), or `None` when that changes its length ("İ"): `messageMatcher` then folds it.
    pub(crate) fn message_lowercase(text: &str) -> Option<Self> {
        let lower = text.to_lowercase();
        let units = |text: &str| text.chars().map(char::len_utf16).sum::<usize>();
        if lower.chars().count() != text.chars().count() || units(&lower) != units(text) {
            return None;
        }
        let lower: Vec<char> = lower.chars().collect();
        Some(Self::build(text, Units::Utf16, |index, _, out| {
            out.extend(lower.get(index));
        }))
    }

    fn build(text: &str, units: Units, mut fold: impl FnMut(usize, char, &mut String)) -> Self {
        let mut folded = String::with_capacity(text.len());
        let mut origin = Vec::with_capacity(text.len());
        let mut chars = Vec::with_capacity(text.len());
        let mut utf16 = Vec::with_capacity(text.len() + 1);
        let mut offset = 0;
        for (index, c) in text.chars().enumerate() {
            let before = folded.len();
            fold(index, c, &mut folded);
            origin.resize(origin.len() + (folded.len() - before), index);
            let wide = c.len_utf16() == 2;
            chars.push(if wide && units == Units::Utf16 {
                SURROGATE
            } else {
                c
            });
            utf16.push(offset);
            offset += c.len_utf16();
        }
        utf16.push(offset);
        Self {
            text: folded,
            origin,
            chars,
            utf16,
        }
    }

    /// Where the original character at `index` starts, in UTF-16 units.
    pub(crate) fn utf16_offset(&self, index: usize) -> usize {
        self.utf16.get(index).copied().unwrap_or(0)
    }

    /// The original character where `needle` first occurs.
    #[cfg(test)]
    pub(crate) fn find(&self, needle: &str) -> Option<usize> {
        self.text
            .find(needle)
            .and_then(|byte| self.origin.get(byte).copied())
    }

    /// Byte offsets in `text` where `token` occurs, overlapping ones included.
    fn occurrences<'a>(&'a self, token: &'a str) -> impl Iterator<Item = usize> + 'a {
        let mut from = 0;
        std::iter::from_fn(move || {
            if token.is_empty() {
                return None;
            }
            let at = from + self.text.get(from..)?.find(token)?;
            from = at
                + self
                    .text
                    .get(at..)
                    .and_then(|rest| rest.chars().next())
                    .map_or(1, char::len_utf8);
            Some(at)
        })
    }

    /// Whether `token` occurs where a word starts (`matchToken`). A token that opens with
    /// punctuation (".ts") brings its own boundary, so it counts anywhere; one that opens with a
    /// symbol does not. T3 reads that first character as a UTF-16 unit, so a token that opens
    /// with an emoji above U+FFFF brings its own boundary too.
    pub(crate) fn has_at_word_start(&self, token: &str) -> bool {
        let own_boundary = token
            .chars()
            .next()
            .is_some_and(|c| c.len_utf16() == 2 || (!is_alphanumeric(c) && !is_symbol(c)));
        self.occurrences(token)
            .any(|at| own_boundary || self.origin.get(at).is_some_and(|&i| self.starts_word(i)))
    }

    /// `findMessageToken` in `paletteSearch.ts`: the best placement of `token` and the original
    /// characters where it has it. A hit past the start of a hex id ("cafe" in "7cafe52bb8")
    /// does not count, though a pasted id prefix does. With `first_only`, the first whole word.
    pub(crate) fn find_token(
        &self,
        token: &str,
        first_only: bool,
    ) -> Option<(Placement, Vec<usize>)> {
        let mut best: Option<(Placement, Vec<usize>)> = None;
        // The letters-and-digits run around the last hit, so hits in one long run ("0000" in a
        // hex dump) do not rescan it.
        let mut run = (0, 0, false);
        for at in self.occurrences(token) {
            let (Some(&start), Some(&last)) = (
                self.origin.get(at),
                self.origin.get(at + token.len().saturating_sub(1)),
            ) else {
                continue;
            };
            let end = last + 1;
            if end > run.1 {
                let alphanumeric =
                    |i: &usize| self.chars.get(*i).copied().is_some_and(is_alphanumeric);
                let run_start = (0..start)
                    .rev()
                    .take_while(alphanumeric)
                    .last()
                    .unwrap_or(start);
                let run_end = (end..self.chars.len())
                    .take_while(alphanumeric)
                    .last()
                    .map_or(end, |i| i + 1);
                let hex = self.chars.get(run_start..run_end).is_some_and(is_hex_id);
                run = (run_start, run_end, hex);
            }
            if run.2 && run.0 < start {
                continue;
            }
            let placement = if !self.starts_word_at(start) {
                Placement::Inside
            } else if self.ends_word_at(end) {
                Placement::Whole
            } else {
                Placement::Start
            };
            if best
                .as_ref()
                .is_none_or(|(quality, _)| placement > *quality)
            {
                best = Some((placement, vec![start]));
                if first_only && placement == Placement::Whole {
                    return best;
                }
            } else if let Some((quality, places)) = &mut best
                && placement == *quality
                && !first_only
            {
                places.push(start);
            }
        }
        best
    }

    /// `startsWordAt`: punctuation brings its own boundary; a symbol starts a word where a
    /// letter would.
    fn starts_word_at(&self, index: usize) -> bool {
        self.chars
            .get(index)
            .is_some_and(|&c| (!is_alphanumeric(c) && !is_symbol(c)) || self.starts_word(index))
    }

    /// `messagePhrase`: the first original character where `words` (lowercased, apostrophes
    /// straight) sit side by side in `text`, with whitespace between them and no letter or digit
    /// right before or after. Curly apostrophes in `text` read as straight ones.
    pub(crate) fn find_phrase(&self, words: &[String]) -> Option<usize> {
        let mut previous = None;
        for (at, c) in self.text.char_indices() {
            let boundary = previous.is_none_or(|p| !is_alphanumeric(p));
            previous = Some(c);
            if boundary
                && self
                    .text
                    .get(at..)
                    .is_some_and(|rest| phrase_at(rest, words))
            {
                return self.origin.get(at).copied();
            }
        }
        None
    }

    /// `endsWordAt`: whether a word ends right before `end`.
    fn ends_word_at(&self, end: usize) -> bool {
        self.chars
            .get(end)
            .is_none_or(|&c| !is_alphanumeric(c) || self.starts_word_at(end))
    }

    fn starts_word(&self, index: usize) -> bool {
        let at = |i: Option<usize>| i.and_then(|i| self.chars.get(i)).copied();
        self.chars.get(index).is_some_and(|&c| {
            is_word_start(
                at(index.checked_sub(2)),
                at(index.checked_sub(1)),
                c,
                at(Some(index + 1)),
            )
        })
    }
}

/// Whether `words` open `text` side by side, with whitespace between them and no letter or digit
/// right after the last one.
fn phrase_at(text: &str, words: &[String]) -> bool {
    let mut rest = text.chars().peekable();
    for (index, word) in words.iter().enumerate() {
        if index > 0 {
            let mut spaces = 0;
            while rest.next_if(|&c| is_js_space(c)).is_some() {
                spaces += 1;
            }
            if spaces == 0 {
                return false;
            }
        }
        if !word.chars().all(|w| rest.next().map(straight) == Some(w)) {
            return false;
        }
    }
    rest.peek().is_none_or(|&c| !is_alphanumeric(c))
}

/// `isWordStart` in `paletteSearch.ts`: whether `c` starts a word after `previous` and
/// `before_previous` (`None` at the start of the text). A letter, digit or symbol starts a word
/// after a character that is no letter or digit, at a camelCase or digit boundary, at the last
/// capital of an acronym ("JSONSchema"), and at every Chinese or Japanese character, but not
/// after an apostrophe inside a word ("Julius’s").
fn is_word_start(
    before_previous: Option<char>,
    previous: Option<char>,
    c: char,
    next: Option<char>,
) -> bool {
    let after_apostrophe =
        matches!(previous, Some('\'' | '\u{2019}')) && before_previous.is_some_and(is_alphanumeric);
    if !(is_alphanumeric(c) || is_symbol(c)) || after_apostrophe {
        return false;
    }
    let Some(previous) = previous else {
        return true;
    };
    !is_alphanumeric(previous)
        || (is_lowercase(previous) && is_uppercase(c))
        || (is_uppercase(previous) && is_uppercase(c) && next.is_some_and(is_lowercase))
        || previous.is_numeric() != c.is_numeric()
        || is_cjk(c)
}

/// A Unicode general category as sorted, disjoint ranges, from `regex-syntax`'s tables.
struct Category(Vec<(char, char)>);

impl Category {
    fn parse(class: &str) -> Self {
        let ranges = regex_syntax::parse(class)
            .ok()
            .and_then(|hir| match hir.kind() {
                regex_syntax::hir::HirKind::Class(regex_syntax::hir::Class::Unicode(class)) => {
                    Some(
                        class
                            .ranges()
                            .iter()
                            .map(|range| (range.start(), range.end()))
                            .collect(),
                    )
                }
                _ => None,
            });
        Self(ranges.unwrap_or_default())
    }

    fn contains(&self, c: char) -> bool {
        self.0
            .binary_search_by(|&(start, end)| {
                if end < c {
                    std::cmp::Ordering::Less
                } else if start > c {
                    std::cmp::Ordering::Greater
                } else {
                    std::cmp::Ordering::Equal
                }
            })
            .is_ok()
    }
}

type CategoryCell = std::sync::OnceLock<Category>;

fn in_category(cell: &'static CategoryCell, class: &str, c: char) -> bool {
    cell.get_or_init(|| Category::parse(class)).contains(c)
}

/// `LETTER`: `\p{L}`.
fn is_letter(c: char) -> bool {
    static CELL: CategoryCell = CategoryCell::new();
    c.is_ascii_alphabetic() || (!c.is_ascii() && in_category(&CELL, r"\p{L}", c))
}

/// `LOWERCASE`: `\p{Ll}`.
fn is_lowercase(c: char) -> bool {
    static CELL: CategoryCell = CategoryCell::new();
    c.is_ascii_lowercase() || (!c.is_ascii() && in_category(&CELL, r"\p{Ll}", c))
}

/// `UPPERCASE`: `\p{Lu}`.
fn is_uppercase(c: char) -> bool {
    static CELL: CategoryCell = CategoryCell::new();
    c.is_ascii_uppercase() || (!c.is_ascii() && in_category(&CELL, r"\p{Lu}", c))
}

/// `SYMBOL`: emoji and other symbols, `\p{So}`. ASCII has none.
fn is_symbol(c: char) -> bool {
    static CELL: CategoryCell = CategoryCell::new();
    !c.is_ascii() && in_category(&CELL, r"\p{So}", c)
}

/// `ALPHANUMERIC` in `paletteSearch.ts`: a letter or a digit (`\p{L}`, `\p{N}`).
fn is_alphanumeric(c: char) -> bool {
    is_letter(c) || c.is_numeric()
}

/// `isCjk`: kana and CJK ideographs, which start a word each.
fn is_cjk(c: char) -> bool {
    matches!(
        u32::from(c),
        0x3040..=0x30ff | 0x3400..=0x4dbf | 0x4e00..=0x9fff | 0xf900..=0xfaff
    )
}

#[cfg(test)]
mod tests {
    use super::{Folded, field_holds_words, fold, fold_field, fold_search_query, push_field};

    #[test]
    fn the_index_folds_latin_diacritics_only_as_sqlite_does() {
        for (text, folded) in [
            ("École fermée à Lyon", "ecole fermee a lyon"),
            ("Le garçon était déjà prêt", "le garcon etait deja pret"),
            ("Școala închisă", "scoala inchisa"),
            ("Hồ Chí Minh", "ho chi minh"),
            ("В логах ОШИБКА", "в логах ошибка"),
            ("e\u{301}cole", "ecole"),
            ("İstanbul", "istanbul"),
            ("gannet\u{2019}s ΟΔΟΣ", "gannet's οδοσ"),
            // Letters that are no base letter with a diacritic stay apart.
            ("Straße ørsted ﬁle 東京", "straße ørsted ﬁle 東京"),
            // Marks that tell other scripts' letters apart stay.
            ("かがく", "かがく"),
            ("か\u{3099}", "か\u{3099}"),
            ("한글", "한글"),
            // SQLite keeps a letter with two marks, and case-folds the long s.
            ("ǡard", "ǡard"),
            ("ſay", "say"),
        ] {
            assert_eq!(fold(text), folded, "{text}");
            assert_eq!(fold(folded), folded, "folding is idempotent: {folded}");
        }
    }

    /// The code points the fixture covers: SQLite folds only below U+10000 and Deseret, and
    /// the rest of the second plane holds letters Rust lowercases that SQLite does not.
    fn fixture_code_points() -> impl Iterator<Item = char> {
        (0x80..=0x1_ffff).filter_map(char::from_u32)
    }

    /// What the bundled SQLite's `trigram remove_diacritics 1` tokenizer, T3's index, makes of
    /// each code point that it changes: one line `<code point> <folded>`, or `-` when it drops it.
    fn sqlite_fold_table() -> String {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE VIRTUAL TABLE t USING fts5(x, tokenize = 'trigram remove_diacritics 1');
             CREATE VIRTUAL TABLE v USING fts5vocab(t, 'instance');",
        )
        .unwrap();
        let tx = conn.unchecked_transaction().unwrap();
        {
            let mut insert = tx
                .prepare("INSERT INTO t (rowid, x) VALUES (?1, ?2)")
                .unwrap();
            for c in fixture_code_points() {
                insert
                    .execute(rusqlite::params![
                        u32::from(c),
                        format!("\u{2}\u{2}{c}\u{3}\u{3}")
                    ])
                    .unwrap();
            }
        }
        tx.commit().unwrap();
        // The first trigram is the two sentinels and the folded code point, or the closing
        // sentinel when SQLite dropped it.
        let mut first = conn
            .prepare("SELECT doc, term FROM v WHERE offset = 0 ORDER BY doc")
            .unwrap();
        let rows = first
            .query_map([], |row| {
                Ok((row.get::<_, u32>(0)?, row.get::<_, String>(1)?))
            })
            .unwrap();
        let mut table = String::from(
            "# SQLite's trigram remove_diacritics 1 fold, from fold.rs tests\n\
             # (write_sqlite_fold_fixture). Code points it leaves alone are not listed.\n",
        );
        for row in rows {
            let (code, term) = row.unwrap();
            let folded: String = term.chars().skip(2).collect();
            let line = match folded.as_str() {
                "\u{3}" => format!("{code:04x} -\n"),
                _ if folded == char::from_u32(code).unwrap().to_string() => continue,
                _ => format!(
                    "{code:04x} {}\n",
                    folded
                        .chars()
                        .map(|c| format!("{:04x}", u32::from(c)))
                        .collect::<Vec<_>>()
                        .join(" ")
                ),
            };
            table.push_str(&line);
        }
        table
    }

    #[test]
    #[ignore = "writes src/sqlite-fold.txt"]
    fn write_sqlite_fold_fixture() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/sqlite-fold.txt");
        std::fs::write(path, sqlite_fold_table()).unwrap();
    }

    /// The fixture is what the bundled SQLite does now: an SQLite update that folds differently
    /// fails here.
    #[test]
    fn the_fixture_is_what_the_bundled_sqlite_folds() {
        assert_eq!(sqlite_fold_table(), include_str!("sqlite-fold.txt"));
    }

    /// The index folds every code point as SQLite's tokenizer does, but for T3's own step:
    /// `indexedMessageText` stores curly apostrophes straight.
    #[test]
    fn the_index_folds_every_code_point_as_sqlite() {
        let changed: std::collections::HashMap<u32, String> = include_str!("sqlite-fold.txt")
            .lines()
            .filter(|line| !line.starts_with('#'))
            .map(|line| {
                let mut parts = line.split(' ');
                let code = u32::from_str_radix(parts.next().unwrap(), 16).unwrap();
                let folded = parts
                    .filter(|part| *part != "-")
                    .map(|part| char::from_u32(u32::from_str_radix(part, 16).unwrap()).unwrap())
                    .collect();
                (code, folded)
            })
            .collect();
        let differ: Vec<String> = fixture_code_points()
            .filter(|c| !matches!(c, '\u{2018}' | '\u{2019}'))
            .filter_map(|c| {
                let sqlite = changed
                    .get(&u32::from(c))
                    .cloned()
                    .unwrap_or_else(|| c.to_string());
                let ours = fold(&c.to_string());
                (ours != sqlite)
                    .then(|| format!("U+{:04X} {c:?}: {ours:?}, SQLite {sqlite:?}", u32::from(c)))
            })
            .collect();
        assert!(
            differ.is_empty(),
            "{} differ:\n{}",
            differ.len(),
            differ.join("\n")
        );
    }

    #[test]
    fn titles_fold_as_fold_in_place() {
        for (text, folded) in [
            ("Résumé indexing", "resume indexing"),
            ("Straße ﬁle", "straße ﬁle"),
            ("かがく", "かかく"),
            ("e\u{301}", "e\u{301}"),
            ("ＡＢ", "ab"),
            ("𝐀", "𝐀"),
        ] {
            assert_eq!(fold_field(text), folded, "{text}");
        }
        assert_eq!(fold_search_query("  “Résumé   index”  "), "resume index");
        assert_eq!(
            fold_search_query("\"example/fixture#7483\""),
            "example/fixture#7483"
        );
        assert_eq!(fold_search_query("e\u{301}cole"), "ecole", "NFC first");
    }

    #[test]
    fn words_start_as_t3_starts_them() {
        let starts = |text: &str| -> Vec<usize> {
            let field = Folded::new(text, push_field);
            (0..field.chars.len())
                .filter(|&i| field.starts_word(i))
                .collect()
        };
        assert_eq!(starts("marker fermé"), [0, 7]);
        assert_eq!(starts("JSONSchema t3code"), [0, 4, 11, 12, 13]);
        assert_eq!(starts("Julius’s drafts"), [0, 9]);
        assert_eq!(starts("東京"), [0, 1]);
        // A symbol starts a word where a letter would, and is no letter after it.
        assert_eq!(starts("fix⚙ ⚙x 😀"), [0, 5, 6, 8]);
        // By general category: "ª" is no lowercase letter (`Lo`), "Ⓐ" no letter at all (`So`).
        assert_eq!(starts("ªB Ⓐb"), [0, 3, 4]);
        assert_eq!(starts("écoleÉté"), [0, 5]);
    }

    #[test]
    fn a_field_holds_the_words_at_word_starts() {
        let title = "#7483 Résumé indexing";
        for query in [
            "resume",
            "res",
            "7483",
            "748",
            "indexing resume",
            "the resume",
        ] {
            assert!(field_holds_words(title, query), "{query}");
        }
        for query in ["sume", "dexing", "7484", "resume draft", "the", ""] {
            assert!(!field_holds_words(title, query), "{query}");
        }
        assert!(field_holds_words("fix parser.ts", ".ts"), "own boundary");
        // A symbol is no punctuation: it starts a word only where a letter would.
        assert!(field_holds_words("fix ⚙ settings", "⚙"));
        assert!(!field_holds_words("fix⚙ settings", "⚙"));
        assert!(field_holds_words("parseJSONSchema", "schema"));
    }
}
