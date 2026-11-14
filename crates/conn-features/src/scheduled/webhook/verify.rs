//! Webhook signatures: an HMAC-SHA256 of the body with the task's secret, in a header.
//! Follows `webhookVerification.ts` in the T3 server, with Effect's `Hex.decode` and
//! `Base64.decode` rules for what a tag may look like.

use conn_contract::{ScheduledTaskWebhookSignature, ScheduledTaskWebhookSignatureEncoding};
use conn_support::hmac::{constant_time_eq, hmac_sha256, sha256};

use super::template::{header_value, js_trim};

/// Compares the SHA-256 digests of two strings, so the time does not tell either length.
pub fn constant_time_equals(a: &str, b: &str) -> bool {
    constant_time_eq(&sha256(a.as_bytes()), &sha256(b.as_bytes()))
}

/// The rest of `value` after its first `units` UTF-16 code units, as JavaScript's
/// `value.slice(units)`; `None` when the cut falls inside a surrogate pair, where the rest
/// would start with a lone surrogate that no decoder accepts.
fn skip_utf16_units(value: &str, units: usize) -> Option<&str> {
    let mut counted = 0;
    for (at, c) in value.char_indices() {
        if counted == units {
            return value.get(at..);
        }
        counted += c.len_utf16();
        if counted > units {
            return None;
        }
    }
    Some("")
}

/// Effect's `Hex.decode`: an even number of hex digits, either case.
fn hex_decode(text: &str) -> Option<Vec<u8>> {
    let digits = text.as_bytes();
    if !digits.len().is_multiple_of(2) {
        return None;
    }
    digits
        .as_chunks::<2>()
        .0
        .iter()
        .map(|&[high, low]| {
            let high = char::from(high).to_digit(16)?;
            let low = char::from(low).to_digit(16)?;
            u8::try_from(high << 4 | low).ok()
        })
        .collect()
}

fn base64_code(byte: u8) -> Option<u32> {
    let code = match byte {
        b'A'..=b'Z' => byte - b'A',
        b'a'..=b'z' => byte - b'a' + 26,
        b'0'..=b'9' => byte - b'0' + 52,
        b'+' => 62,
        b'/' => 63,
        b'=' => 0,
        _ => return None,
    };
    Some(u32::from(code))
}

/// Effect's `Base64.decode`: line breaks removed; the standard alphabet; a length that is a
/// multiple of 4; at most two `=`, only at the end. The bits under the padding are not
/// checked.
fn base64_decode(text: &str) -> Option<Vec<u8>> {
    let stripped: Vec<u8> = text
        .bytes()
        .filter(|b| !matches!(b, b'\n' | b'\r'))
        .collect();
    let length = stripped.len();
    if !length.is_multiple_of(4) {
        return None;
    }
    if let Some(index) = stripped.iter().position(|&b| b == b'=') {
        let last_is_pad = stripped.last() == Some(&b'=');
        if index + 2 < length || (index + 2 == length && !last_is_pad) {
            return None;
        }
    }
    let missing = if stripped.ends_with(b"==") {
        2
    } else {
        usize::from(stripped.ends_with(b"="))
    };
    let mut out = Vec::with_capacity(length / 4 * 3);
    for chunk in stripped.as_chunks::<4>().0 {
        let mut buffer = 0u32;
        for &byte in chunk {
            buffer = buffer << 6 | base64_code(byte)?;
        }
        out.extend_from_slice(buffer.to_be_bytes().get(1..).unwrap_or_default());
    }
    out.truncate((length / 4 * 3).saturating_sub(missing));
    Some(out)
}

/// Whether the request carries the HMAC-SHA256 of `body` keyed with `secret`, in the header
/// and encoding `signature` names, after its prefix (matched without case). An empty secret
/// never verifies, as Effect refuses an empty HMAC key.
pub fn verify_webhook_signature(
    signature: &ScheduledTaskWebhookSignature,
    secret: &str,
    headers: &[(String, String)],
    body: &[u8],
) -> bool {
    let Some(received) = header_value(headers, &signature.header.to_lowercase()) else {
        return false;
    };
    let value = js_trim(received);
    let prefix = signature.prefix.as_str();
    if !prefix.is_empty() && !value.to_lowercase().starts_with(&prefix.to_lowercase()) {
        return false;
    }
    let Some(candidate) = skip_utf16_units(value, prefix.encode_utf16().count()) else {
        return false;
    };
    let tag = match signature.encoding {
        ScheduledTaskWebhookSignatureEncoding::Hex => hex_decode(&candidate.to_lowercase()),
        ScheduledTaskWebhookSignatureEncoding::Base64 => base64_decode(candidate),
    };
    let Some(tag) = tag else {
        return false;
    };
    !secret.is_empty() && constant_time_eq(&hmac_sha256(secret.as_bytes(), body), &tag)
}

#[cfg(test)]
mod tests {
    use super::*;
    use conn_support::{base64, hex::hex};

    const BODY: &[u8] = br#"{"action":"opened"}"#;
    const SECRET: &str = "shared-secret";

    fn github() -> ScheduledTaskWebhookSignature {
        ScheduledTaskWebhookSignature {
            header: "x-hub-signature-256".to_owned(),
            encoding: ScheduledTaskWebhookSignatureEncoding::Hex,
            prefix: "sha256=".to_owned(),
        }
    }

    fn header(name: &str, value: &str) -> Vec<(String, String)> {
        vec![(name.to_owned(), value.to_owned())]
    }

    fn mac() -> [u8; 32] {
        hmac_sha256(SECRET.as_bytes(), BODY)
    }

    #[test]
    fn rejects_a_tampered_body_a_wrong_secret_a_missing_header_and_a_missing_prefix() {
        let valid = format!("sha256={}", hex(&mac()));
        let headers = header("x-hub-signature-256", &valid);
        assert!(
            !verify_webhook_signature(&github(), SECRET, &headers, br#"{"action":"closed"}"#),
            "tampered"
        );
        assert!(
            !verify_webhook_signature(&github(), "other", &headers, BODY),
            "secret"
        );
        assert!(
            !verify_webhook_signature(&github(), SECRET, &[], BODY),
            "no header"
        );
        assert!(
            !verify_webhook_signature(
                &github(),
                SECRET,
                &header("x-hub-signature-256", &hex(&mac())),
                BODY
            ),
            "no prefix"
        );
        assert!(
            verify_webhook_signature(&github(), SECRET, &headers, BODY),
            "valid"
        );
    }

    #[test]
    fn accepts_a_hex_signature_with_its_prefix_and_a_base64_signature_without_one() {
        assert!(
            verify_webhook_signature(
                &github(),
                SECRET,
                &header(
                    "x-hub-signature-256",
                    &format!("sha256={}", hex(&mac()).to_uppercase())
                ),
                BODY
            ),
            "upper hex"
        );
        let plain = ScheduledTaskWebhookSignature {
            header: "X-Signature".to_owned(),
            encoding: ScheduledTaskWebhookSignatureEncoding::Base64,
            prefix: String::new(),
        };
        assert!(
            verify_webhook_signature(
                &plain,
                SECRET,
                &header("x-signature", &base64::encode(&mac())),
                BODY
            ),
            "base64"
        );
    }

    #[test]
    fn decodes_as_effect_does() {
        assert_eq!(hex_decode("0aFf"), Some(vec![0x0a, 0xff]), "hex");
        assert_eq!(hex_decode("abc"), None, "odd");
        assert_eq!(hex_decode("zz"), None, "not hex");
        assert_eq!(base64_decode("AQ=="), Some(vec![1]), "two pads");
        assert_eq!(base64_decode("AQI="), Some(vec![1, 2]), "one pad");
        assert_eq!(base64_decode("AR=="), Some(vec![1]), "loose bits");
        assert_eq!(base64_decode("AQ\r\n=="), Some(vec![1]), "line breaks");
        assert_eq!(base64_decode("AQ"), None, "no padding");
        assert_eq!(base64_decode("A=Q="), None, "pad inside");
        assert_eq!(base64_decode("AQ=A"), None, "pad then data");
        assert_eq!(base64_decode("-_8="), None, "url alphabet");
        assert_eq!(base64_decode(""), Some(vec![]), "empty");
    }

    #[test]
    fn compares_digests() {
        assert!(constant_time_equals("token", "token"), "equal");
        assert!(!constant_time_equals("token", "token2"), "different");
    }

    #[test]
    fn an_empty_secret_never_verifies() {
        let empty_mac = hmac_sha256(b"", BODY);
        let headers = header(
            "x-hub-signature-256",
            &format!("sha256={}", hex(&empty_mac)),
        );
        assert!(
            !verify_webhook_signature(&github(), "", &headers, BODY),
            "empty secret"
        );
    }
}
