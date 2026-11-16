//! String bounds measured as JavaScript UTF-16 lengths, without splitting a scalar.
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
    #[test]
    fn utf16_bounds_keep_surrogate_pairs_together() {
        for (max, expected) in [(0, ""), (1, "a"), (2, "a"), (3, "a😀"), (4, "a😀b")] {
            assert_eq!(super::utf16_prefix("a😀b", max), expected);
        }
    }
}
