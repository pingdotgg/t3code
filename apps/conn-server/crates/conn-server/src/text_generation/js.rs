//! JavaScript string rules that the T3 server's text code depends on. JavaScript measures and
//! slices strings in UTF-16 code units, and `localeCompare` sorts by the ICU root collation;
//! the prompts and the model lists must come out the same here.

use std::cmp::Ordering;

/// `value.length`.
pub fn len16(value: &str) -> usize {
    value.encode_utf16().count()
}

/// `value.slice(start, end)` on UTF-16 units. A cut through a surrogate pair keeps the lone
/// half as U+FFFD, where JavaScript keeps the lone surrogate; the T3 code avoids those cuts.
pub fn slice16(value: &str, start: usize, end: usize) -> String {
    let units: Vec<u16> = value.encode_utf16().collect();
    let end = end.min(units.len());
    let start = start.min(end);
    String::from_utf16_lossy(units.get(start..end).unwrap_or_default())
}

/// `value.charCodeAt(index)`, or `None` past the end (JavaScript's `NaN`).
pub fn char_code_at(value: &str, index: usize) -> Option<u16> {
    value.encode_utf16().nth(index)
}

pub fn is_high_surrogate(unit: Option<u16>) -> bool {
    unit.is_some_and(|u| (0xd800..=0xdbff).contains(&u))
}

pub fn is_low_surrogate(unit: Option<u16>) -> bool {
    unit.is_some_and(|u| (0xdc00..=0xdfff).contains(&u))
}

/// `JSON.stringify(value)` for a string. serde_json escapes exactly the characters
/// JavaScript does (`"`, `\`, and control characters, with the same short forms).
pub fn json_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_default()
}

/// The ICU root order of the ASCII punctuation and symbols, before digits and letters.
const PUNCTUATION: &str = "_-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$";

/// The primary weight of one character: white space, punctuation in ICU order, digits,
/// letters without case, then everything else by code point.
fn primary(c: char) -> (u8, u32) {
    if c.is_whitespace() {
        (0, c as u32)
    } else if let Some(at) = PUNCTUATION.find(c) {
        (1, u32::try_from(at).unwrap_or(u32::MAX))
    } else if c.is_ascii_digit() {
        (2, c as u32)
    } else if c.is_ascii_alphabetic() {
        (3, c.to_ascii_lowercase() as u32)
    } else {
        (4, c as u32)
    }
}

/// `left.localeCompare(right)` for the ids and names model APIs return: the primary weights
/// first, then lower case before upper case, then code points. Exact for ASCII; the
/// `textgen-diff.mjs` check compares it with Node on a list of real model ids.
pub fn locale_compare(left: &str, right: &str) -> Ordering {
    let primary_order = left.chars().map(primary).cmp(right.chars().map(primary));
    primary_order
        .then_with(|| {
            let case = |c: char| u8::from(c.is_ascii_uppercase());
            left.chars().map(case).cmp(right.chars().map(case))
        })
        .then_with(|| left.cmp(right))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn measures_and_slices_in_utf16_units() {
        assert_eq!(len16("a😀"), 3);
        assert_eq!(slice16("a😀b", 1, 3), "😀");
        assert_eq!(slice16("abc", 2, 10), "c");
        assert!(is_high_surrogate(char_code_at("😀", 0)));
        assert!(is_low_surrogate(char_code_at("😀", 1)));
        assert_eq!(char_code_at("a", 5), None);
    }

    #[test]
    fn sorts_as_locale_compare() {
        let mut ids = vec![
            "gpt-4o", "GPT-4", "claude-3", "claude_3", "a.b", "a-b", "a1", "ab",
        ];
        ids.sort_by(|a, b| locale_compare(a, b));
        assert_eq!(
            ids,
            [
                "a-b", "a.b", "a1", "ab", "claude_3", "claude-3", "GPT-4", "gpt-4o"
            ]
        );
        assert_eq!(locale_compare("abc", "Abc"), Ordering::Less);
    }
}
