//! One-time codes for saved test logins (`apps/server/src/credentials/totp.ts`): a base32
//! secret or an `otpauth://totp` URI, RFC 6238 with SHA-1, SHA-256 or SHA-512.

use sha1::Sha1;
use sha2::{Digest, Sha256, Sha512};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Algorithm {
    Sha1,
    Sha256,
    Sha512,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TotpSetup {
    pub secret: Vec<u8>,
    pub digits: u32,
    pub period_seconds: u64,
    pub algorithm: Algorithm,
}

const BASE32: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

fn decode_base32(text: &str) -> Option<Vec<u8>> {
    let clean: String = text
        .chars()
        .filter(|c| !(conn_support::text::is_js_space(*c) || *c == '=' || *c == '-'))
        .collect::<String>()
        .to_uppercase();
    if clean.is_empty() {
        return None;
    }
    let mut bits = 0u32;
    let mut value = 0u64;
    let mut bytes = Vec::with_capacity(clean.len() * 5 / 8);
    for ch in clean.bytes() {
        let index = BASE32.iter().position(|b| *b == ch)?;
        value = ((value << 5) | index as u64) & 0xFFFF_FFFF;
        bits += 5;
        if bits >= 8 {
            bytes.push(((value >> (bits - 8)) & 0xff) as u8);
            bits -= 8;
        }
    }
    Some(bytes)
}

/// `parseTotpSetup`: a base32 secret or an `otpauth://totp` URI; `None` when it is neither.
pub fn parse_totp_setup(input: &str) -> Option<TotpSetup> {
    let trimmed = conn_support::text::js_trim(input);
    if trimmed.len() >= 10 && trimmed.get(..10)?.eq_ignore_ascii_case("otpauth://") {
        let url = url::Url::parse(trimmed).ok()?;
        // `url.host`: the host with its port, so `totp:123` is not `totp`.
        if !url.host_str()?.eq_ignore_ascii_case("totp") || url.port().is_some() {
            return None;
        }
        let param = |name: &str| {
            url.query_pairs()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.into_owned())
        };
        let secret = decode_base32(&param("secret").unwrap_or_default())?;
        let digits: f64 = param("digits").map_or(Some(6.0), |d| number(&d))?;
        let period: f64 = param("period").map_or(Some(30.0), |p| number(&p))?;
        if !period.is_finite() {
            return None;
        }
        let algorithm = match param("algorithm")
            .unwrap_or_else(|| "SHA1".into())
            .to_lowercase()
            .as_str()
        {
            "sha1" => Algorithm::Sha1,
            "sha256" => Algorithm::Sha256,
            "sha512" => Algorithm::Sha512,
            _ => return None,
        };
        if ![6.0, 7.0, 8.0].contains(&digits) || period.fract() != 0.0 || period <= 0.0 {
            return None;
        }
        return Some(TotpSetup {
            secret,
            digits: digits as u32,
            period_seconds: period as u64,
            algorithm,
        });
    }
    decode_base32(trimmed).map(|secret| TotpSetup {
        secret,
        digits: 6,
        period_seconds: 30,
        algorithm: Algorithm::Sha1,
    })
}

/// JavaScript's `Number(text)`: trimmed, empty is 0, `0x`/`0o`/`0b` integers, `Infinity`, and
/// decimals with an optional exponent; anything else is `NaN` (`None`).
fn number(text: &str) -> Option<f64> {
    let text = conn_support::text::js_trim(text);
    if text.is_empty() {
        return Some(0.0);
    }
    // Every character after the prefix must be a digit of the radix; the value is built as a
    // double, as JavaScript does, so a value past u64 stays finite.
    let radix = |prefix: &str, radix: u32| {
        let lower = text.get(..2)?.to_ascii_lowercase();
        if lower != prefix {
            return None;
        }
        let digits = text.get(2..).filter(|d| !d.is_empty())?;
        digits.chars().try_fold(0.0_f64, |value, c| {
            c.to_digit(radix)
                .map(|d| value * f64::from(radix) + f64::from(d))
        })
    };
    if let Some(n) = radix("0x", 16)
        .or_else(|| radix("0o", 8))
        .or_else(|| radix("0b", 2))
    {
        return Some(n);
    }
    match text {
        "Infinity" | "+Infinity" => return Some(f64::INFINITY),
        "-Infinity" => return Some(f64::NEG_INFINITY),
        _ => {}
    }
    let decimal = text
        .chars()
        .all(|c| c.is_ascii_digit() || matches!(c, '.' | 'e' | 'E' | '+' | '-'));
    if !decimal || !text.chars().any(|c| c.is_ascii_digit()) {
        return None;
    }
    text.parse::<f64>().ok()
}

fn hmac<D: Digest + Clone>(block: usize, key: &[u8], message: &[u8]) -> Vec<u8> {
    let mut padded = vec![0u8; block];
    let hashed;
    let key = if key.len() > block {
        hashed = D::digest(key).to_vec();
        hashed.as_slice()
    } else {
        key
    };
    for (slot, byte) in padded.iter_mut().zip(key) {
        *slot = *byte;
    }
    let pad = |xor: u8| padded.iter().map(|b| b ^ xor).collect::<Vec<u8>>();
    let inner = D::new()
        .chain_update(pad(0x36))
        .chain_update(message)
        .finalize();
    D::new()
        .chain_update(pad(0x5c))
        .chain_update(inner)
        .finalize()
        .to_vec()
}

/// `totpCode`: the RFC 6238 code at `now_ms`.
pub fn totp_code(setup: &TotpSetup, now_ms: u64) -> String {
    let counter = now_ms / 1000 / setup.period_seconds.max(1);
    let message = counter.to_be_bytes();
    let digest = match setup.algorithm {
        Algorithm::Sha1 => hmac::<Sha1>(64, &setup.secret, &message),
        Algorithm::Sha256 => hmac::<Sha256>(64, &setup.secret, &message),
        Algorithm::Sha512 => hmac::<Sha512>(128, &setup.secret, &message),
    };
    let offset = usize::from(digest.last().copied().unwrap_or(0) & 0x0f);
    let byte = |i: usize| u32::from(digest.get(offset + i).copied().unwrap_or(0));
    let binary = ((byte(0) & 0x7f) << 24) | (byte(1) << 16) | (byte(2) << 8) | byte(3);
    let code = binary % 10u32.pow(setup.digits);
    format!("{code:0width$}", width = setup.digits as usize)
}
