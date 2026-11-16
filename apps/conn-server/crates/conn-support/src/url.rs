//! The URL text rules JavaScript applies: `decodeURIComponent` and `URLSearchParams`.

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// `decodeURIComponent`, or `None` where it throws: a `%` without two hex digits, or bytes
/// that are not UTF-8.
pub fn decode_uri_component(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while let Some(&byte) = bytes.get(index) {
        if byte == b'%' {
            let high = hex_value(*bytes.get(index + 1)?)?;
            let low = hex_value(*bytes.get(index + 2)?)?;
            out.push(high << 4 | low);
            index += 3;
        } else {
            out.push(byte);
            index += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// `application/x-www-form-urlencoded` byte decoding: `+` is a space, `%XX` a byte, and any
/// other `%` stays; then UTF-8 with U+FFFD for bad bytes.
pub fn form_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while let Some(&byte) = bytes.get(index) {
        let escaped = (byte == b'%')
            .then(|| {
                let high = hex_value(*bytes.get(index + 1)?)?;
                let low = hex_value(*bytes.get(index + 2)?)?;
                Some(high << 4 | low)
            })
            .flatten();
        match escaped {
            Some(decoded) => {
                out.push(decoded);
                index += 3;
            }
            None => {
                out.push(if byte == b'+' { b' ' } else { byte });
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// `new URLSearchParams(text)`: its name and value pairs, in order.
pub fn search_params(text: &str) -> Vec<(String, String)> {
    let text = text.strip_prefix('?').unwrap_or(text);
    text.split('&')
        .filter(|part| !part.is_empty())
        .map(|part| {
            let (name, value) = part.split_once('=').unwrap_or((part, ""));
            (form_decode(name), form_decode(value))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_as_javascript_does() {
        assert_eq!(
            decode_uri_component("a%20b%E2%82%AC").as_deref(),
            Some("a b€")
        );
        assert_eq!(decode_uri_component("%E0"), None, "a cut sequence throws");
        assert_eq!(decode_uri_component("%zz"), None);
        assert_eq!(decode_uri_component("a+b").as_deref(), Some("a+b"));
        assert_eq!(
            search_params("?a=1&b=x+y&&c&d=%zz"),
            [
                ("a".to_owned(), "1".to_owned()),
                ("b".to_owned(), "x y".to_owned()),
                ("c".to_owned(), String::new()),
                ("d".to_owned(), "%zz".to_owned()),
            ]
        );
    }
}
