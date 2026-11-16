//! JavaScript text rules used by contract decoders and model-facing text.

/// JavaScript's Unicode whitespace, including U+FEFF and excluding U+0085.
pub fn is_js_space(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
}

/// JavaScript's `String.prototype.trim`.
pub fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_space)
}

#[cfg(test)]
mod tests {
    use super::js_trim;

    #[test]
    fn trim_keeps_nel_and_removes_bom_and_unicode_separators() {
        assert_eq!(js_trim("\u{feff}\u{2003} value \u{2029}"), "value");
        assert_eq!(js_trim("\u{85}value\u{85}"), "\u{85}value\u{85}");
    }
}
