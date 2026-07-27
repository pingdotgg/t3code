//! Secret storage for remote-device bearer tokens and the mobile pairing
//! credentials — the Windows counterpart of
//! `apps/mac/Sources/SergeCodeMac/Support/KeychainStore.swift`.
//!
//! macOS uses the login Keychain (`kSecClassGenericPassword`); Windows uses
//! Credential Manager generic credentials, which are the same shape: a target
//! name, a blob, and per-user encryption at rest (DPAPI). Entries persist with
//! `CRED_PERSIST_LOCAL_MACHINE` so they survive logoff exactly like a Keychain
//! item survives app restarts.
//!
//! On non-Windows hosts (development builds of this crate) the store is an
//! in-process map. It is never used to hold a real credential there — the app
//! only ships on Windows — but it keeps the calling code identical.

const TARGET_PREFIX: &str = "SergeCode";

/// Credential Manager target name for a device's bearer token.
pub fn target_name(device_id: &str) -> String {
    format!("{TARGET_PREFIX}/{device_id}")
}

#[derive(Debug, thiserror::Error)]
pub enum SecretError {
    #[error("could not write the credential: {0}")]
    Write(String),
    #[error("could not read the credential: {0}")]
    Read(String),
    #[error("could not delete the credential: {0}")]
    Delete(String),
}

#[cfg(windows)]
mod platform {
    use super::{target_name, SecretError};

    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{ERROR_NOT_FOUND, WIN32_ERROR};
    use windows::Win32::Security::Credentials::{
        CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE,
        CRED_TYPE_GENERIC,
    };

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    pub fn write(device_id: &str, token: &str) -> Result<(), SecretError> {
        let mut target = wide(&target_name(device_id));
        let mut blob = token.as_bytes().to_vec();

        let credential = CREDENTIALW {
            Type: CRED_TYPE_GENERIC,
            TargetName: windows::core::PWSTR(target.as_mut_ptr()),
            CredentialBlobSize: u32::try_from(blob.len()).unwrap_or(u32::MAX),
            CredentialBlob: blob.as_mut_ptr(),
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            ..Default::default()
        };

        // SAFETY: every pointer in `credential` borrows a local buffer that
        // outlives the call, and the sizes match those buffers.
        unsafe { CredWriteW(&credential, 0) }.map_err(|error| SecretError::Write(error.to_string()))
    }

    pub fn read(device_id: &str) -> Result<Option<String>, SecretError> {
        let target = wide(&target_name(device_id));
        let mut credential: *mut CREDENTIALW = std::ptr::null_mut();

        // SAFETY: `target` is a NUL-terminated wide string that outlives the
        // call; `credential` receives an owned pointer freed below.
        let result = unsafe {
            CredReadW(
                PCWSTR(target.as_ptr()),
                CRED_TYPE_GENERIC,
                None,
                &mut credential,
            )
        };

        if let Err(error) = result {
            return if error.code() == WIN32_ERROR(ERROR_NOT_FOUND.0).into() {
                Ok(None)
            } else {
                Err(SecretError::Read(error.to_string()))
            };
        }

        if credential.is_null() {
            return Ok(None);
        }

        // SAFETY: `CredReadW` succeeded, so the pointer is a valid credential
        // whose blob pointer/length pair describes initialized memory.
        let token = unsafe {
            let blob = std::slice::from_raw_parts(
                (*credential).CredentialBlob,
                (*credential).CredentialBlobSize as usize,
            );
            let token = String::from_utf8_lossy(blob).into_owned();
            CredFree(credential.cast());
            token
        };
        Ok(Some(token))
    }

    pub fn delete(device_id: &str) -> Result<(), SecretError> {
        let target = wide(&target_name(device_id));
        // SAFETY: `target` is a NUL-terminated wide string valid for the call.
        let result = unsafe { CredDeleteW(PCWSTR(target.as_ptr()), CRED_TYPE_GENERIC, None) };
        match result {
            Ok(()) => Ok(()),
            // Deleting a credential that was never stored is a success for
            // callers, matching the macOS `SecItemDelete` errSecItemNotFound
            // handling.
            Err(error) if error.code() == WIN32_ERROR(ERROR_NOT_FOUND.0).into() => Ok(()),
            Err(error) => Err(SecretError::Delete(error.to_string())),
        }
    }
}

#[cfg(not(windows))]
mod platform {
    use super::SecretError;

    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};

    fn store() -> &'static Mutex<HashMap<String, String>> {
        static STORE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
        STORE.get_or_init(|| Mutex::new(HashMap::new()))
    }

    pub fn write(device_id: &str, token: &str) -> Result<(), SecretError> {
        let mut guard = store()
            .lock()
            .map_err(|error| SecretError::Write(error.to_string()))?;
        guard.insert(device_id.to_owned(), token.to_owned());
        Ok(())
    }

    pub fn read(device_id: &str) -> Result<Option<String>, SecretError> {
        let guard = store()
            .lock()
            .map_err(|error| SecretError::Read(error.to_string()))?;
        Ok(guard.get(device_id).cloned())
    }

    pub fn delete(device_id: &str) -> Result<(), SecretError> {
        let mut guard = store()
            .lock()
            .map_err(|error| SecretError::Delete(error.to_string()))?;
        guard.remove(device_id);
        Ok(())
    }
}

pub use platform::{delete, read, write};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn target_names_are_namespaced() {
        assert_eq!(target_name("mac-mini"), "SergeCode/mac-mini");
    }

    #[test]
    fn round_trips_a_token_and_treats_missing_as_none() {
        let device = format!("test-device-{}", std::process::id());
        assert_eq!(read(&device).expect("reads"), None);
        write(&device, "bearer-token").expect("writes");
        assert_eq!(
            read(&device).expect("reads"),
            Some("bearer-token".to_owned())
        );
        delete(&device).expect("deletes");
        assert_eq!(read(&device).expect("reads"), None);
        // Deleting twice is not an error.
        delete(&device).expect("deletes again");
    }
}
