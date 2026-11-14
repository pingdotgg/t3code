//! Base64 (RFC 4648): standard with padding, as in `data:` URLs and image blocks, and base64url
//! without padding, as in signed URL tokens.

const STANDARD: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const URL_SAFE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// Standard base64 with `=` padding.
pub fn encode(bytes: &[u8]) -> String {
    encode_with(bytes, STANDARD, true)
}

/// Base64url without padding.
pub fn url_encode(bytes: &[u8]) -> String {
    encode_with(bytes, URL_SAFE, false)
}

/// Standard base64 with padding; `None` when the length is not a multiple of 4 or a character
/// is outside the alphabet.
pub fn decode(text: &str) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(4) {
        return None;
    }
    decode_with(text.trim_end_matches('='), |c| match c {
        b'+' => Some(62),
        b'/' => Some(63),
        _ => alphanumeric(c),
    })
}

/// Base64url, with or without padding; `None` for a character outside the alphabet or an
/// impossible length.
pub fn url_decode(text: &str) -> Option<Vec<u8>> {
    decode_with(text.trim_end_matches('='), |c| match c {
        b'-' => Some(62),
        b'_' => Some(63),
        _ => alphanumeric(c),
    })
}

fn encode_with(bytes: &[u8], table: &[u8; 64], pad: bool) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let byte = |i: usize| u32::from(chunk.get(i).copied().unwrap_or(0));
        let n = byte(0) << 16 | byte(1) << 8 | byte(2);
        for i in 0..4 {
            if i <= chunk.len() {
                let index = (n >> (18 - 6 * i)) & 63;
                // `index` is below 64: the table always has it.
                let symbol = usize::try_from(index)
                    .ok()
                    .and_then(|index| table.get(index))
                    .copied()
                    .unwrap_or(b'A');
                out.push(char::from(symbol));
            } else if pad {
                out.push('=');
            }
        }
    }
    out
}

fn alphanumeric(c: u8) -> Option<u8> {
    match c {
        b'A'..=b'Z' => Some(c - b'A'),
        b'a'..=b'z' => Some(c - b'a' + 26),
        b'0'..=b'9' => Some(c - b'0' + 52),
        _ => None,
    }
}

fn decode_with(text: &str, value: impl Fn(u8) -> Option<u8>) -> Option<Vec<u8>> {
    if text.len() % 4 == 1 {
        return None;
    }
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    let mut buffer = 0u32;
    let mut bits = 0;
    for c in text.bytes() {
        buffer = (buffer << 6) | u32::from(value(c)?);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits).to_le_bytes()[0]);
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::{decode, encode, url_decode, url_encode};

    #[test]
    fn standard_matches_rfc_4648() {
        for (plain, coded) in [
            ("", ""),
            ("f", "Zg=="),
            ("fo", "Zm8="),
            ("foo", "Zm9v"),
            ("foob", "Zm9vYg=="),
            ("fooba", "Zm9vYmE="),
            ("foobar", "Zm9vYmFy"),
        ] {
            assert_eq!(encode(plain.as_bytes()), coded, "encode {plain:?}");
            assert_eq!(
                decode(coded),
                Some(plain.as_bytes().to_vec()),
                "decode {coded:?}"
            );
        }
        assert_eq!(encode(&[0xfb, 0xff]), "+/8=");
        assert_eq!(decode("aGk="), Some(b"hi".to_vec()));
        assert_eq!(decode("aGk"), None, "unpadded");
        assert_eq!(decode("a-k="), None, "url-safe symbol");
    }

    #[test]
    fn url_safe_round_trips_without_padding() {
        for len in 0..10u8 {
            let bytes: Vec<u8> = (0..len)
                .map(|i| i.wrapping_mul(37).wrapping_add(250))
                .collect();
            let coded = url_encode(&bytes);
            assert!(!coded.contains('='), "no padding in {coded}");
            assert_eq!(url_decode(&coded), Some(bytes));
        }
        assert_eq!(url_encode(&[0xfb, 0xff]), "-_8");
        assert_eq!(
            url_decode("-_8="),
            Some(vec![0xfb, 0xff]),
            "padding is accepted"
        );
        assert_eq!(url_decode("+/8"), None, "standard symbols");
        assert_eq!(url_decode("a"), None, "impossible length");
    }
}
