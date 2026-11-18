//! The protected provisioning input of a managed target (`--managed-provision <file>`).
//!
//! The file is JSON, mode 0600, owned by the server's user:
//!
//! ```json
//! {"gatewayUrl":"https://gateway.orbit","caPath":"/etc/conn/orbit-ca.pem",
//!  "environmentId":"<uuid>","generation":1,"credentialPath":"/etc/conn/service-credential",
//!  "listen":"10.0.0.5:3774","previewTabs":[{"threadId":"…","tabId":"…"}]}
//! ```
//!
//! The credential file holds `conn_svc_` and 43 base64url characters, also mode 0600 and owned
//! by the server's user. The environment ID and the generation are fixed for the process. The
//! public instance file and the descriptor never hold any of this.

use std::{
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::Arc,
};

use serde::Deserialize;

pub const SERVICE_CREDENTIAL_PREFIX: &str = "conn_svc_";
pub const MANAGED_TOKEN_PREFIX: &str = "conn_mt_";
/// 32 random bytes in unpadded base64url.
const SECRET_CHARS: usize = 43;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct File {
    gateway_url: String,
    ca_path: PathBuf,
    environment_id: String,
    generation: u64,
    credential_path: PathBuf,
    listen: SocketAddr,
    #[serde(default)]
    preview_tabs: Vec<PreviewTab>,
}

/// A preview tab the reader may watch read-only.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewTab {
    pub thread_id: String,
    pub tab_id: String,
}

#[derive(Clone)]
pub struct Provision {
    pub gateway_url: String,
    pub ca_pem: Vec<u8>,
    pub environment_id: String,
    pub generation: u64,
    pub credential: Arc<str>,
    pub listen: SocketAddr,
    pub preview_tabs: Vec<PreviewTab>,
}

impl std::fmt::Debug for Provision {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Provision")
            .field("gateway_url", &self.gateway_url)
            .field("environment_id", &self.environment_id)
            .field("generation", &self.generation)
            .field("listen", &self.listen)
            .finish_non_exhaustive()
    }
}

/// Whether `token` has the shape of a secret with `prefix`.
pub fn has_secret_shape(token: &str, prefix: &str) -> bool {
    token.strip_prefix(prefix).is_some_and(|rest| {
        rest.len() == SECRET_CHARS
            && rest
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    })
}

/// A lowercase canonical UUID, as enrolment requires.
pub fn is_canonical_uuid(text: &str) -> bool {
    text.len() == 36
        && text.bytes().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => b == b'-',
            _ => b.is_ascii_digit() || (b'a'..=b'f').contains(&b),
        })
}

/// Reads a protected file: mode 0600 (no group or other bits) and owned by this process's
/// user. Runs `std::fs`: call it before the runtime starts or on a blocking thread.
fn read_protected(path: &Path, what: &str) -> Result<Vec<u8>, String> {
    use std::io::Read;
    // One open: the checks and the read see the same file, and a symlink is refused.
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // Non-blocking too: a FIFO cannot hang the open before the regular-file check.
        options.custom_flags(
            (rustix::fs::OFlags::NOFOLLOW | rustix::fs::OFlags::NONBLOCK).bits() as i32,
        );
    }
    let mut file = options.open(path).map_err(|e| format!("{what}: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let meta = file.metadata().map_err(|e| format!("{what}: {e}"))?;
        if !meta.is_file() {
            return Err(format!("{what} is not a file"));
        }
        // Exactly 0600: no group or other bit, and no setuid, setgid or sticky bit either.
        if meta.mode() & 0o7777 != 0o600 {
            return Err(format!("{what} must have mode 0600"));
        }
        if meta.uid() != rustix::process::geteuid().as_raw() {
            return Err(format!("{what} must be owned by the server's user"));
        }
    }
    let mut raw = Vec::new();
    file.read_to_end(&mut raw)
        .map_err(|e| format!("{what}: {e}"))?;
    Ok(raw)
}

impl Provision {
    /// Reads and checks the provisioning input. Any failure refuses to start: a managed
    /// target never runs on partial input.
    pub fn load(path: &Path) -> Result<Self, String> {
        let raw = read_protected(path, "the managed provisioning file")?;
        let file: File = serde_json::from_slice(&raw)
            .map_err(|e| format!("the managed provisioning file: {e}"))?;
        if !is_canonical_uuid(&file.environment_id) {
            return Err("environmentId must be a lowercase canonical UUID".into());
        }
        if file.generation == 0 {
            return Err("generation starts at 1".into());
        }
        if !file.gateway_url.starts_with("https://") {
            return Err("gatewayUrl must be https".into());
        }
        let credential = read_protected(&file.credential_path, "the service credential file")?;
        let credential = String::from_utf8(credential)
            .map_err(|_| "the service credential is not text".to_owned())?;
        let credential = credential.trim();
        if !has_secret_shape(credential, SERVICE_CREDENTIAL_PREFIX) {
            return Err("the service credential has the wrong format".into());
        }
        let ca_pem = std::fs::read(&file.ca_path).map_err(|e| format!("the CA file: {e}"))?;
        super::gateway::lab_tls(&ca_pem)?;
        Ok(Self {
            gateway_url: file.gateway_url,
            ca_pem,
            environment_id: file.environment_id,
            generation: file.generation,
            credential: credential.into(),
            listen: file.listen,
            preview_tabs: file.preview_tabs,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_shapes() {
        let good = format!("conn_mt_{}", "a".repeat(43));
        assert!(has_secret_shape(&good, MANAGED_TOKEN_PREFIX));
        assert!(!has_secret_shape(&good, SERVICE_CREDENTIAL_PREFIX));
        assert!(!has_secret_shape(
            &format!("conn_mt_{}", "a".repeat(42)),
            MANAGED_TOKEN_PREFIX
        ));
        assert!(!has_secret_shape(
            &format!("conn_mt_{}=", "a".repeat(42)),
            MANAGED_TOKEN_PREFIX
        ));
        assert!(is_canonical_uuid("0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d"));
        assert!(!is_canonical_uuid("0B1C2D3E-4F50-4A6B-8C7D-9E0F1A2B3C4D"));
        assert!(!is_canonical_uuid("env-test"));
    }

    #[cfg(unix)]
    #[test]
    fn refuses_files_others_can_read() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("conn-provision-{}", conn_support::uuid_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let credential = dir.join("credential");
        std::fs::write(&credential, format!("conn_svc_{}\n", "b".repeat(43))).unwrap();
        std::fs::set_permissions(&credential, std::fs::Permissions::from_mode(0o644)).unwrap();
        let provision = dir.join("provision.json");
        std::fs::write(
            &provision,
            serde_json::json!({
                "gatewayUrl": "https://gateway.test",
                "caPath": dir.join("ca.pem"),
                "environmentId": "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d",
                "generation": 1,
                "credentialPath": credential,
                "listen": "127.0.0.1:0",
            })
            .to_string(),
        )
        .unwrap();
        std::fs::set_permissions(&provision, std::fs::Permissions::from_mode(0o600)).unwrap();
        let error = Provision::load(&provision).unwrap_err();
        assert!(
            error.contains("service credential file must have mode 0600"),
            "{error}"
        );
        std::fs::set_permissions(&provision, std::fs::Permissions::from_mode(0o640)).unwrap();
        let error = Provision::load(&provision).unwrap_err();
        assert!(
            error.contains("provisioning file must have mode 0600"),
            "{error}"
        );
        // A special permission bit is not 0600 either.
        std::fs::set_permissions(&provision, std::fs::Permissions::from_mode(0o4600)).unwrap();
        if std::fs::metadata(&provision).unwrap().permissions().mode() & 0o7777 == 0o4600 {
            let error = Provision::load(&provision).unwrap_err();
            assert!(error.contains("must have mode 0600"), "{error}");
        }
        // A symlink to a protected file is refused: the file is opened once, never followed.
        std::fs::set_permissions(&provision, std::fs::Permissions::from_mode(0o600)).unwrap();
        let link = dir.join("link.json");
        std::os::unix::fs::symlink(&provision, &link).unwrap();
        let error = Provision::load(&link).unwrap_err();
        assert!(error.contains("provisioning file"), "{error}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
