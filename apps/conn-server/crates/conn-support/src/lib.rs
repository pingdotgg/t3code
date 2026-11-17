//! Shared helpers, with optional rustls configuration for HTTPS callers.
//! Only login values and the optional TLS config hold shared state.

pub mod base64;
pub mod fs;
pub mod hex;
pub mod hmac;
pub mod ids;
pub mod input;
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

#[cfg(test)]
mod sealed_probe;

#[cfg(test)]
mod tests {
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
