//! JavaScript text rules used by contract decoders and model-facing text.

/// JavaScript's Unicode whitespace, including U+FEFF and excluding U+0085.
pub fn is_js_space(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
}

/// JavaScript's `String.prototype.trim`.
pub fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_space)
}

pub fn utf16_prefix(text: &str, max: usize) -> &str {
    let mut units = 0;
    let end = text
        .char_indices()
        .find_map(|(at, c)| {
            units += c.len_utf16();
            (units > max).then_some(at)
        })
        .unwrap_or(text.len());
    text.get(..end).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::js_trim;

    #[test]
    fn utf16_bounds_keep_surrogate_pairs_together() {
        for (max, expected) in [(0, ""), (1, "a"), (2, "a"), (3, "a😀"), (4, "a😀b")] {
            assert_eq!(super::utf16_prefix("a😀b", max), expected);
        }
    }

    #[test]
    fn trim_keeps_nel_and_removes_bom_and_unicode_separators() {
        assert_eq!(js_trim("\u{feff}\u{2003} value \u{2029}"), "value");
        assert_eq!(js_trim("\u{85}value\u{85}"), "\u{85}value\u{85}");
    }
}
