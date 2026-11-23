//! Shared helpers, with optional rustls configuration for HTTPS callers.
//! Only login values and the optional TLS config hold shared state.

pub mod base64;
pub mod fs;
pub mod hex;
pub mod hmac;
pub mod ids;
pub mod input;
pub mod js_date;
pub mod login_env;
pub mod modes;
pub mod secret_store;
pub mod spawn_guard;
#[cfg(any(test, feature = "test-util"))]
pub mod test_util;
pub mod text;
pub mod time;
#[cfg(feature = "tls")]
pub mod tls;
pub mod url;

/// A random version 4 UUID from the OS random source, lowercase and hyphenated, as
/// `crypto.randomUUID` makes them.
///
/// # Panics
///
/// When the OS random source fails, which leaves no safe way to make ids or tokens.
pub fn uuid_v4() -> String {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).expect("the OS random source is available");
    uuid::Builder::from_random_bytes(bytes)
        .into_uuid()
        .to_string()
}

/// A ULID for `ms` milliseconds since the epoch: 48 bits of time, then 80 random bits from the
/// OS random source, in Crockford base32 (26 characters). Ids made later sort later.
///
/// # Panics
///
/// When the OS random source fails, as [`uuid_v4`].
pub fn ulid(ms: u64) -> String {
    let mut random = [0u8; 10];
    getrandom::fill(&mut random).expect("the OS random source is available");
    ulid_from(ms, random)
}

fn ulid_from(ms: u64, random: [u8; 10]) -> String {
    const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    let mut value = u128::from(ms & 0xFFFF_FFFF_FFFF) << 80;
    for (i, byte) in random.iter().enumerate() {
        value |= u128::from(*byte) << (8 * (9 - i));
    }
    (0..26)
        .rev()
        .map(|i| char::from(ALPHABET[((value >> (5 * i)) & 31) as usize]))
        .collect()
}

#[cfg(test)]
mod sealed_probe;

#[cfg(test)]
mod tests {
    #[test]
    fn ulids_encode_time_then_randomness() {
        // The time of the ULID spec's example id, 01ARYZ6S41…
        assert_eq!(
            super::ulid_from(1_469_918_176_385, [0; 10]),
            "01ARYZ6S410000000000000000"
        );
        assert_eq!(
            super::ulid_from(0, [0xFF; 10]),
            "0000000000ZZZZZZZZZZZZZZZZ"
        );
        let (a, b) = (super::ulid(1_000), super::ulid(2_000));
        assert_eq!(a.len(), 26);
        assert!(a < b, "{a} {b}");
    }

    #[test]
    fn uuids_have_the_v4_shape() {
        let id = super::uuid_v4();
        let groups: Vec<usize> = id.split('-').map(str::len).collect();
        assert_eq!(groups, [8, 4, 4, 4, 12], "{id}");
        assert_eq!(id.chars().nth(14), Some('4'), "version 4: {id}");
        assert!(
            matches!(id.chars().nth(19), Some('8' | '9' | 'a' | 'b')),
            "variant: {id}"
        );
        assert_eq!(id, id.to_lowercase(), "lowercase");
        assert_ne!(id, super::uuid_v4(), "random");
    }
}
