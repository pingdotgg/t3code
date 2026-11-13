//! Signed URL tokens: `base64url(JSON claims) . base64url(HMAC-SHA256)`, the shape of
//! `apps/server/src/auth/PayloadSigner.ts`. Asset and upload URLs share one key, kept in
//! `<state-dir>/secrets/asset-signing-key` (0600). The claims are ours; clients treat the
//! token as opaque.

use std::{fs, io, path::Path};

use serde::{Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};

pub struct Signer {
    key: [u8; 32],
}

impl std::fmt::Debug for Signer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Signer { key: <redacted> }")
    }
}

impl Signer {
    /// Loads the key, or creates it on first start.
    pub fn open(secrets_dir: &Path) -> io::Result<Self> {
        let file = secrets_dir.join("asset-signing-key");
        match fs::read(&file) {
            Ok(bytes) if bytes.len() == 32 => {
                let mut key = [0u8; 32];
                key.copy_from_slice(&bytes);
                return Ok(Self { key });
            }
            Ok(_) => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "asset-signing-key must hold 32 bytes",
                ));
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
        fs::create_dir_all(secrets_dir)?;
        let key = random_bytes::<32>();
        write_private(&file, &key)?;
        Ok(Self { key })
    }

    pub fn from_key(key: [u8; 32]) -> Self {
        Self { key }
    }

    pub fn sign<T: Serialize>(&self, claims: &T) -> String {
        let payload = base64url_encode(&serde_json::to_vec(claims).expect("claims encode"));
        let signature = base64url_encode(&self.mac(payload.as_bytes()));
        format!("{payload}.{signature}")
    }

    /// The claims of a token this key signed, or `None`. Expiry is the caller's check.
    pub fn verify<T: DeserializeOwned>(&self, token: &str) -> Option<T> {
        let mut parts = token.split('.');
        let (payload, signature) = (parts.next()?, parts.next()?);
        if parts.next().is_some() || payload.is_empty() {
            return None;
        }
        let signature = base64url_decode(signature)?;
        if !constant_time_eq(&signature, &self.mac(payload.as_bytes())) {
            return None;
        }
        serde_json::from_slice(&base64url_decode(payload)?).ok()
    }

    fn mac(&self, message: &[u8]) -> [u8; 32] {
        hmac_sha256(&self.key, message)
    }
}

/// HMAC-SHA256 (RFC 2104) with a key of any length.
pub fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    let mut block = [0u8; 64];
    let hashed: [u8; 32];
    let key = if key.len() > block.len() {
        hashed = Sha256::digest(key).into();
        &hashed[..]
    } else {
        key
    };
    for (slot, byte) in block.iter_mut().zip(key) {
        *slot = *byte;
    }
    let pad = |byte: u8| block.map(|b| b ^ byte);
    let inner = Sha256::new()
        .chain_update(pad(0x36))
        .chain_update(message)
        .finalize();
    Sha256::new()
        .chain_update(pad(0x5c))
        .chain_update(inner)
        .finalize()
        .into()
}

/// Compares two secrets in time that depends only on their length. `black_box` keeps the
/// compiler from ending the loop at the first difference.
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len()
        && std::hint::black_box(
            a.iter()
                .zip(b)
                .fold(0u8, |acc, (x, y)| std::hint::black_box(acc | (x ^ y))),
        ) == 0
}

pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    getrandom::fill(&mut bytes).expect("OS random source");
    bytes
}

/// A random v4 UUID, lowercase.
pub fn uuid_v4() -> String {
    let mut b = random_bytes::<16>();
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let hex = hex(&b);
    format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    )
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

pub fn base64url_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        for i in 0..=chunk.len() {
            out.push(ALPHABET[(n >> (18 - 6 * i) & 63) as usize] as char);
        }
    }
    out
}

pub fn base64url_decode(text: &str) -> Option<Vec<u8>> {
    decode_with(text.trim_end_matches('='), |c| match c {
        b'A'..=b'Z' => Some(c - b'A'),
        b'a'..=b'z' => Some(c - b'a' + 26),
        b'0'..=b'9' => Some(c - b'0' + 52),
        b'-' => Some(62),
        b'_' => Some(63),
        _ => None,
    })
}

/// Standard base64 with padding, as in `data:` URLs.
pub fn base64_decode(text: &str) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(4) {
        return None;
    }
    decode_with(text.trim_end_matches('='), |c| match c {
        b'A'..=b'Z' => Some(c - b'A'),
        b'a'..=b'z' => Some(c - b'a' + 26),
        b'0'..=b'9' => Some(c - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    })
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
            out.push((buffer >> bits) as u8);
        }
    }
    Some(out)
}

/// Writes a file only the owner can read.
pub fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    use std::io::Write;
    #[cfg(unix)]
    use std::os::unix::fs::OpenOptionsExt;
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    options.open(path)?.write_all(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hmac_takes_keys_of_any_length() {
        // RFC 4231 case 6: a 131-byte key, longer than the block.
        assert_eq!(
            hex(&hmac_sha256(
                &[0xaa; 131],
                b"Test Using Larger Than Block-Size Key - Hash Key First"
            )),
            "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"
        );
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"ab"));
    }

    #[test]
    fn hmac_matches_rfc_4231_shape() {
        // RFC 4231 case 2 uses a short key; a 32-byte zero-padded key gives the same HMAC.
        let mut key = [0u8; 32];
        key[..4].copy_from_slice(b"Jefe");
        assert_eq!(
            hex(&hmac_sha256(&key, b"what do ya want for nothing?")),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
    }

    #[test]
    fn signs_and_rejects_tampering() {
        let signer = Signer::from_key([7; 32]);
        let token = signer.sign(&serde_json::json!({"a": 1}));
        assert_eq!(
            signer.verify::<serde_json::Value>(&token),
            Some(serde_json::json!({"a": 1}))
        );
        let (payload, _) = token.split_once('.').unwrap();
        let forged = format!(
            "{}.{}",
            base64url_encode(br#"{"a":2}"#),
            &token[payload.len() + 1..]
        );
        assert_eq!(signer.verify::<serde_json::Value>(&forged), None);
        assert_eq!(
            Signer::from_key([8; 32]).verify::<serde_json::Value>(&token),
            None
        );
        assert_eq!(
            signer.verify::<serde_json::Value>(&format!("{token}.x")),
            None
        );
    }

    #[test]
    fn base64_round_trips() {
        for len in 0..10 {
            let bytes: Vec<u8> = (0..len).map(|i| (i * 37 + 250) as u8).collect();
            assert_eq!(base64url_decode(&base64url_encode(&bytes)), Some(bytes));
        }
        assert_eq!(base64_decode("aGk="), Some(b"hi".to_vec()));
        assert_eq!(base64_decode("aGk"), None);
        assert_eq!(uuid_v4().len(), 36);
    }
}
