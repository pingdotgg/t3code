//! SHA-256, HMAC-SHA256 (RFC 2104) and a compare for secrets.

use sha2::{Digest, Sha256};

/// SHA-256 of `bytes`.
pub fn sha256(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

/// HMAC-SHA256 with a key of any length.
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

#[cfg(test)]
mod tests {
    use super::{constant_time_eq, hmac_sha256};
    use crate::hex::hex;

    #[test]
    fn matches_rfc_4231() {
        // Case 2: a key shorter than the block.
        assert_eq!(
            hex(&hmac_sha256(b"Jefe", b"what do ya want for nothing?")),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
        // The same key, zero-padded to 32 bytes, gives the same HMAC.
        let mut key = [0u8; 32];
        key[..4].copy_from_slice(b"Jefe");
        assert_eq!(
            hex(&hmac_sha256(&key, b"what do ya want for nothing?")),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
        // Case 6: a 131-byte key, longer than the block.
        assert_eq!(
            hex(&hmac_sha256(
                &[0xaa; 131],
                b"Test Using Larger Than Block-Size Key - Hash Key First"
            )),
            "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"
        );
    }

    #[test]
    fn compares_secrets() {
        assert!(constant_time_eq(b"abc", b"abc"), "equal");
        assert!(!constant_time_eq(b"abc", b"abd"), "one byte differs");
        assert!(!constant_time_eq(b"abc", b"ab"), "lengths differ");
        assert!(constant_time_eq(b"", b""), "both empty");
    }
}
