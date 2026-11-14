//! Signed URL tokens: `base64url(JSON claims) . base64url(HMAC-SHA256)`, the shape of
//! `apps/server/src/auth/PayloadSigner.ts`. Asset and upload URLs share one key, kept in
//! `<state-dir>/secrets/asset-signing-key` (0600). The claims are ours; clients treat the
//! token as opaque.

use std::{fs, io, path::Path};

use conn_support::{
    base64::{url_decode as base64url_decode, url_encode as base64url_encode},
    hmac::{constant_time_eq, hmac_sha256},
};
use serde::{Serialize, de::DeserializeOwned};

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
        create_private(&file, &key)?;
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

pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    getrandom::fill(&mut bytes).expect("OS random source");
    bytes
}

/// Creates a file only the owner can read; fails when it exists, so two servers starting at
/// once cannot both write a key.
pub fn create_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
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
}
