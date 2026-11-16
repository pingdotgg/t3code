//! `joinId` from `packages/provider-core/src/server/IdAllocator.ts`: the server's derived ids.

/// `encodeURIComponent`: keeps `A-Z a-z 0-9 - _ . ! ~ * ' ( )`, percent-encodes the rest.
pub fn encode_component(part: &str) -> String {
    let mut out = String::with_capacity(part.len());
    for byte in part.bytes() {
        let keep = byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            );
        if keep {
            out.push(char::from(byte));
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// `joinId`: `prefix:part:part`, each part encoded.
pub fn join_id(prefix: &str, parts: &[&str]) -> String {
    let mut out = String::from(prefix);
    for part in parts {
        out.push(':');
        out.push_str(&encode_component(part));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parts_are_uri_encoded() {
        assert_eq!(
            join_id(
                "checkpoint-scope",
                &["thread", "thread:a b", "name", "root"]
            ),
            "checkpoint-scope:thread:thread%3Aa%20b:name:root"
        );
        assert_eq!(encode_component("é~*"), "%C3%A9~*");
    }
}
