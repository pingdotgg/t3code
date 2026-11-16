//! Lowercase hex.

/// `bytes` as lowercase hex, two digits per byte.
pub fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        for nibble in [byte >> 4, byte & 15] {
            out.push(char::from(DIGITS[usize::from(nibble)]));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::hex;

    #[test]
    fn lowercase_two_digits_per_byte() {
        assert_eq!(hex(&[]), "");
        assert_eq!(hex(&[0, 1, 0x0f, 0x10, 0xab, 0xff]), "00010f10abff");
        let all: Vec<u8> = (0..=255).collect();
        let want: String = all.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(hex(&all), want, "the same as format!(\"{{b:02x}}\")");
    }
}
