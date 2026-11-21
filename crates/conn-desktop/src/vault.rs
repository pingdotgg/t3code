//! Bridge to the Vault Mac app (`Vault --conn-bridge`), matching Conn's
//! `apps/desktop/src/ipc/methods/vault.ts` and `apps/desktop/src/vault/Logins.ts`.
//!
//! Each request starts `/Applications/Vault.app/Contents/MacOS/Vault --conn-bridge` over stdio
//! pipes and exchanges one 4-byte little-endian length-prefixed JSON frame. Stdin stays open until
//! Vault sends its reply (the relay treats EOF as caller disconnect). Passwords and OTP codes are
//! never persisted to disk and live only for the single database open or browser fill call.

use std::fmt;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::process::Command;

use crate::database::DatabaseDriver;

/// Default Vault Mac app binary path.
pub const VAULT_BINARY: &str = "/Applications/Vault.app/Contents/MacOS/Vault";

/// Touch ID or master-password unlock can take a while before Vault replies.
const TIMEOUT: Duration = Duration::from_secs(120);
/// Maximum accepted reply frame length (64 KiB, matching Conn's `MAX_FRAME`).
const MAX_FRAME: usize = 64 * 1024;

/// TLS requirement reported by a Vault Database entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum VaultTls {
    #[serde(rename = "disabled")]
    Disabled,
    #[serde(rename = "required")]
    Required,
    #[serde(rename = "verify-ca")]
    VerifyCa,
    #[serde(rename = "verify-full")]
    VerifyFull,
}

/// High-level status returned by the Vault bridge.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VaultErrorKind {
    Locked,
    Unavailable,
    Error,
}

/// Failure talking to the Vault Mac app bridge.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct VaultError {
    pub kind: VaultErrorKind,
    pub message: String,
}

impl VaultError {
    #[must_use]
    pub fn new(kind: VaultErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    #[must_use]
    pub fn locked() -> Self {
        Self::new(
            VaultErrorKind::Locked,
            "Vault is locked. Unlock Vault to use this connection.",
        )
    }

    #[must_use]
    pub fn unavailable(message: impl Into<String>) -> Self {
        Self::new(VaultErrorKind::Unavailable, message)
    }
}

/// A Database entry listed by Vault (never contains a password).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultDatabase {
    pub id: String,
    pub name: String,
    pub driver: DatabaseDriver,
    pub host: String,
    pub port: u16,
    pub database: String,
    pub username: String,
    pub tls: VaultTls,
    pub ssh_host: Option<String>,
    pub ssh_port: Option<u16>,
    pub ssh_user: Option<String>,
    pub organization: Option<String>,
}

/// One Vault Database entry together with its transient password and SSH agent socket.
#[derive(Clone, PartialEq, Eq)]
pub struct VaultDatabaseCredential {
    pub database: VaultDatabase,
    pub password: String,
    pub ssh_agent: Option<String>,
}

impl fmt::Debug for VaultDatabaseCredential {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("VaultDatabaseCredential")
            .field("database", &self.database)
            .field("password", &"<redacted>")
            .field("ssh_agent", &self.ssh_agent)
            .finish()
    }
}

/// Login field supported by Vault autofill (`CredentialField`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VaultLoginField {
    Username,
    Password,
    Otp,
}

impl VaultLoginField {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Username => "username",
            Self::Password => "password",
            Self::Otp => "otp",
        }
    }
}

/// One login suggestion returned by Vault for an HTTPS origin.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultLoginItem {
    pub id: String,
    pub title: String,
    pub username: Option<String>,
    pub source: String,
}

/// Result of querying Vault login status or suggestions for a page URL.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultLoginsResponse {
    pub status: VaultLoginsStatus,
    pub items: Vec<VaultLoginItem>,
    pub error: Option<String>,
}

/// Status tag for [`VaultLoginsResponse`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VaultLoginsStatus {
    Ok,
    Locked,
    Unavailable,
    Error,
}

/// Result of looking up one login field for browser autofill.
#[derive(Clone, PartialEq, Eq)]
pub enum VaultLoginFillLookup {
    Value(String),
    OriginMismatch,
    ItemNotFound,
    Denied,
    NoValue,
    InsertFailed,
    ProviderUnavailable,
}

impl fmt::Debug for VaultLoginFillLookup {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Value(_) => f.write_str("Value(<redacted>)"),
            Self::OriginMismatch => f.write_str("OriginMismatch"),
            Self::ItemNotFound => f.write_str("ItemNotFound"),
            Self::Denied => f.write_str("Denied"),
            Self::NoValue => f.write_str("NoValue"),
            Self::InsertFailed => f.write_str("InsertFailed"),
            Self::ProviderUnavailable => f.write_str("ProviderUnavailable"),
        }
    }
}

/// Returns `https://host[:port]` when `value` is a valid HTTPS URL without embedded credentials.
#[must_use]
pub fn https_origin(value: &str) -> Option<String> {
    let parsed = url::Url::parse(value).ok()?;
    if parsed.scheme() != "https" || !parsed.username().is_empty() || parsed.password().is_some() {
        return None;
    }
    let origin = parsed.origin().ascii_serialization();
    if origin == "null" { None } else { Some(origin) }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BridgeRequest<'a> {
    version: u8,
    id: String,
    kind: &'a str,
    mode: &'a str,
    #[serde(skip_serializing_if = "Option::is_none", rename = "itemID")]
    item_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    field: Option<&'a str>,
    allow_unlock: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireDatabase {
    id: String,
    name: String,
    driver: String,
    host: String,
    port: u16,
    database: String,
    username: String,
    tls: String,
    password: Option<String>,
    ssh_host: Option<String>,
    ssh_port: Option<u16>,
    ssh_user: Option<String>,
    organization: Option<String>,
}

#[derive(Deserialize)]
struct WireSuggestion {
    id: String,
    name: String,
    #[serde(default)]
    username: String,
}

#[derive(Deserialize)]
struct WireCredential {
    mode: String,
    username: Option<String>,
    password: Option<String>,
    code: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BridgeReply {
    id: Option<String>,
    status: Option<String>,
    message: Option<String>,
    databases: Option<Vec<WireDatabase>>,
    database: Option<WireDatabase>,
    ssh_agent: Option<String>,
    suggestions: Option<Vec<WireSuggestion>>,
    #[serde(rename = "itemID")]
    item_id: Option<String>,
    credential: Option<WireCredential>,
}

fn parse_wire_database(wire: WireDatabase) -> Option<(VaultDatabase, Option<String>)> {
    let driver = match wire.driver.as_str() {
        "postgresql" | "pgsql" => DatabaseDriver::Pgsql,
        "mysql" => DatabaseDriver::Mysql,
        _ => return None,
    };
    let tls = match wire.tls.as_str() {
        "disabled" => VaultTls::Disabled,
        "required" => VaultTls::Required,
        "verify-ca" => VaultTls::VerifyCa,
        "verify-full" => VaultTls::VerifyFull,
        _ => return None,
    };
    let password = wire.password;
    let db = VaultDatabase {
        id: wire.id,
        name: wire.name,
        driver,
        host: wire.host,
        port: wire.port,
        database: wire.database,
        username: wire.username,
        tls,
        ssh_host: wire.ssh_host,
        ssh_port: wire.ssh_port,
        ssh_user: wire.ssh_user,
        organization: wire.organization,
    };
    Some((db, password))
}

fn failure_from_reply(reply: &BridgeReply) -> VaultError {
    if reply.status.as_deref() == Some("locked") {
        VaultError::locked()
    } else {
        VaultError::new(
            VaultErrorKind::Error,
            reply
                .message
                .clone()
                .unwrap_or_else(|| "Vault did not return the entry.".to_owned()),
        )
    }
}

/// Client for Vault's `--conn-bridge` stdio relay.
#[derive(Debug, Clone)]
pub struct VaultClient {
    binary: PathBuf,
    timeout: Duration,
}

impl Default for VaultClient {
    fn default() -> Self {
        Self::new()
    }
}

impl VaultClient {
    /// Creates a client targeting `/Applications/Vault.app/Contents/MacOS/Vault`.
    #[must_use]
    pub fn new() -> Self {
        Self {
            binary: PathBuf::from(VAULT_BINARY),
            timeout: TIMEOUT,
        }
    }

    /// Creates a client targeting a custom binary (used by tests).
    #[must_use]
    pub fn with_binary(binary: impl Into<PathBuf>) -> Self {
        Self {
            binary: binary.into(),
            timeout: TIMEOUT,
        }
    }

    /// Sets a custom per-request timeout.
    #[must_use]
    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    /// Path to the configured Vault binary.
    #[must_use]
    pub fn binary(&self) -> &Path {
        &self.binary
    }

    /// Whether the Vault binary exists on disk.
    #[must_use]
    pub fn is_installed(&self) -> bool {
        self.binary.exists()
    }

    /// Lists all Database entries in Vault (without passwords).
    ///
    /// # Errors
    ///
    /// Returns [`VaultError`] when Vault is missing, locked, refuses the signature, or errors.
    pub async fn list_databases(
        &self,
        allow_unlock: bool,
    ) -> Result<Vec<VaultDatabase>, VaultError> {
        let reply = self
            .send_request("database", "list-database", None, None, None, allow_unlock)
            .await?;
        if reply.status.as_deref() != Some("databases") {
            return Err(failure_from_reply(&reply));
        }
        let list = reply
            .databases
            .unwrap_or_default()
            .into_iter()
            .filter_map(|wire| parse_wire_database(wire).map(|(db, _)| db))
            .collect();
        Ok(list)
    }

    /// Fetches one Database entry with its password and optional Vault SSH agent socket.
    ///
    /// # Errors
    ///
    /// Returns [`VaultError`] when Vault is missing, locked, refuses the signature, or has no
    /// matching entry.
    pub async fn database_credential(
        &self,
        item_id: &str,
        allow_unlock: bool,
    ) -> Result<VaultDatabaseCredential, VaultError> {
        let reply = self
            .send_request(
                "database",
                "database-credential",
                Some(item_id),
                None,
                None,
                allow_unlock,
            )
            .await?;
        if reply.status.as_deref() != Some("ok") {
            return Err(failure_from_reply(&reply));
        }
        let ssh_agent = reply.ssh_agent.clone();
        let Some(wire) = reply.database else {
            return Err(VaultError::new(
                VaultErrorKind::Error,
                "Vault did not return the entry.",
            ));
        };
        let Some((database, Some(password))) = parse_wire_database(wire) else {
            return Err(VaultError::new(
                VaultErrorKind::Error,
                "Vault did not return the entry.",
            ));
        };
        Ok(VaultDatabaseCredential {
            database,
            password,
            ssh_agent,
        })
    }

    /// Queries whether Vault is currently unlocked without prompting.
    pub async fn login_status(&self) -> VaultLoginsResponse {
        match self
            .send_request("login", "status", None, None, None, false)
            .await
        {
            Ok(reply) => match reply.status.as_deref() {
                Some("unlocked") => VaultLoginsResponse {
                    status: VaultLoginsStatus::Ok,
                    items: Vec::new(),
                    error: None,
                },
                Some("locked" | "cancelled") => VaultLoginsResponse {
                    status: VaultLoginsStatus::Locked,
                    items: Vec::new(),
                    error: None,
                },
                _ => VaultLoginsResponse {
                    status: VaultLoginsStatus::Error,
                    items: Vec::new(),
                    error: Some(
                        "Vault did not return logins. Update Vault and try again.".to_owned(),
                    ),
                },
            },
            Err(err) => logins_error_response(err),
        }
    }

    /// Lists Vault login suggestions for an HTTPS page URL. Non-HTTPS URLs return an empty `ok`
    /// list without invoking Vault (matching `Logins.ts`).
    pub async fn list_logins(&self, url: &str, allow_unlock: bool) -> VaultLoginsResponse {
        if https_origin(url).is_none() {
            return VaultLoginsResponse {
                status: VaultLoginsStatus::Ok,
                items: Vec::new(),
                error: None,
            };
        }
        match self
            .send_request("login", "list-login", None, Some(url), None, allow_unlock)
            .await
        {
            Ok(reply) => match reply.status.as_deref() {
                Some("locked" | "cancelled") => VaultLoginsResponse {
                    status: VaultLoginsStatus::Locked,
                    items: Vec::new(),
                    error: None,
                },
                Some("suggestions") => {
                    let items = reply
                        .suggestions
                        .unwrap_or_default()
                        .into_iter()
                        .map(|s| VaultLoginItem {
                            id: s.id.to_ascii_lowercase(),
                            title: s.name,
                            username: if s.username.is_empty() {
                                None
                            } else {
                                Some(s.username)
                            },
                            source: "vault".to_owned(),
                        })
                        .collect();
                    VaultLoginsResponse {
                        status: VaultLoginsStatus::Ok,
                        items,
                        error: None,
                    }
                }
                _ => VaultLoginsResponse {
                    status: VaultLoginsStatus::Error,
                    items: Vec::new(),
                    error: Some(
                        "Vault did not return logins. Update Vault and try again.".to_owned(),
                    ),
                },
            },
            Err(err) => logins_error_response(err),
        }
    }

    /// Reads one selected login field for `page_url` after verifying `expected_origin`.
    pub async fn login_credential(
        &self,
        page_url: &str,
        expected_origin: &str,
        item_id: &str,
        field: VaultLoginField,
    ) -> VaultLoginFillLookup {
        if https_origin(expected_origin).is_none()
            || https_origin(page_url).as_deref() != Some(expected_origin)
        {
            return VaultLoginFillLookup::OriginMismatch;
        }
        let reply = match self
            .send_request(
                "login",
                "login-credential",
                Some(item_id),
                Some(page_url),
                Some(field.as_str()),
                true,
            )
            .await
        {
            Ok(reply) => reply,
            Err(_) => return VaultLoginFillLookup::ProviderUnavailable,
        };
        match reply.status.as_deref() {
            Some("item-not-found") => return VaultLoginFillLookup::ItemNotFound,
            Some("locked" | "cancelled") => return VaultLoginFillLookup::Denied,
            Some("ok") => {}
            _ => return VaultLoginFillLookup::InsertFailed,
        }
        if !reply
            .item_id
            .as_deref()
            .is_some_and(|got| got.eq_ignore_ascii_case(item_id))
        {
            return VaultLoginFillLookup::InsertFailed;
        }
        let Some(cred) = reply.credential else {
            return VaultLoginFillLookup::InsertFailed;
        };
        if cred.mode != field.as_str() {
            return VaultLoginFillLookup::InsertFailed;
        }
        let value = match field {
            VaultLoginField::Username => cred.username,
            VaultLoginField::Password => cred.password,
            VaultLoginField::Otp => cred.code,
        };
        match value {
            Some(v) if !v.is_empty() => VaultLoginFillLookup::Value(v),
            _ => VaultLoginFillLookup::NoValue,
        }
    }

    async fn send_request(
        &self,
        kind: &str,
        mode: &str,
        item_id: Option<&str>,
        url: Option<&str>,
        field: Option<&str>,
        allow_unlock: bool,
    ) -> Result<BridgeReply, VaultError> {
        if !self.binary.exists() {
            return Err(VaultError::unavailable(
                "Vault is not installed on this Mac.",
            ));
        }

        let request_id = next_request_id();
        let payload = BridgeRequest {
            version: 1,
            id: request_id.clone(),
            kind,
            mode,
            item_id,
            url,
            field,
            allow_unlock,
        };
        let body = serde_json::to_vec(&payload)
            .map_err(|err| VaultError::new(VaultErrorKind::Error, err.to_string()))?;
        let body_len = u32::try_from(body.len())
            .map_err(|_| VaultError::new(VaultErrorKind::Error, "Vault request is too large."))?;

        let mut child = Command::new(&self.binary)
            .arg("--conn-bridge")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|err| VaultError::unavailable(err.to_string()))?;

        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| VaultError::unavailable("Vault bridge stdin unavailable."))?;
        let mut stdout = child
            .stdout
            .take()
            .ok_or_else(|| VaultError::unavailable("Vault bridge stdout unavailable."))?;

        // Keep stdin open until the reply arrives: the relay treats EOF as caller disconnect.
        let mut frame = Vec::with_capacity(4 + body.len());
        frame.extend_from_slice(&body_len.to_le_bytes());
        frame.extend_from_slice(&body);
        if stdin.write_all(&frame).await.is_err() || stdin.flush().await.is_err() {
            let _ = child.kill().await;
            return Err(VaultError::new(
                VaultErrorKind::Error,
                "Vault refused the request. Update Vault, and use the signed Conn app.",
            ));
        }

        let read_reply = async {
            loop {
                let mut len_buf = [0u8; 4];
                if let Err(err) = stdout.read_exact(&mut len_buf).await {
                    return if err.kind() == std::io::ErrorKind::UnexpectedEof {
                        Err(VaultError::new(
                            VaultErrorKind::Error,
                            "Vault refused the request. Update Vault, and use the signed Conn app.",
                        ))
                    } else {
                        Err(VaultError::new(VaultErrorKind::Error, err.to_string()))
                    };
                }
                let size = u32::from_le_bytes(len_buf) as usize;
                if size == 0 || size > MAX_FRAME {
                    return Err(VaultError::new(
                        VaultErrorKind::Error,
                        "Vault sent an invalid reply.",
                    ));
                }
                let mut payload_buf = vec![0u8; size];
                if stdout.read_exact(&mut payload_buf).await.is_err() {
                    return Err(VaultError::new(
                        VaultErrorKind::Error,
                        "Vault sent an invalid reply.",
                    ));
                }
                let reply: BridgeReply = serde_json::from_slice(&payload_buf).map_err(|_| {
                    VaultError::new(VaultErrorKind::Error, "Vault sent an invalid reply.")
                })?;
                if reply.id.as_deref() == Some(request_id.as_str()) {
                    return Ok(reply);
                }
            }
        };

        let result = match tokio::time::timeout(self.timeout, read_reply).await {
            Ok(inner) => inner,
            Err(_) => Err(VaultError::new(
                VaultErrorKind::Error,
                "Vault did not answer in time.",
            )),
        };

        drop(stdin);
        let _ = child.kill().await;
        result
    }
}

fn next_request_id() -> String {
    static SEQ: AtomicU64 = AtomicU64::new(1);
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0u128, |d| d.as_nanos());
    let hi = (nanos as u64) ^ (u64::from(std::process::id()) << 32);
    let lo = ((nanos >> 64) as u64) ^ seq.wrapping_mul(0x9E37_79B9_7F4A_7C15);
    format!(
        "{:08X}-{:04X}-4{:03X}-{:04X}-{:012X}",
        (hi >> 32) as u32,
        ((hi >> 16) & 0xFFFF) as u16,
        (hi & 0x0FFF) as u16,
        ((lo >> 48) & 0x3FFF) | 0x8000,
        lo & 0x0000_FFFF_FFFF_FFFF,
    )
}

fn logins_error_response(error: VaultError) -> VaultLoginsResponse {
    let status = match error.kind {
        VaultErrorKind::Locked => VaultLoginsStatus::Locked,
        VaultErrorKind::Unavailable => VaultLoginsStatus::Unavailable,
        VaultErrorKind::Error => VaultLoginsStatus::Error,
    };
    let msg = if error.kind == VaultErrorKind::Unavailable {
        "Vault is not installed on this Mac.".to_owned()
    } else {
        "Vault could not answer. Open or update Vault and try again.".to_owned()
    };
    VaultLoginsResponse {
        status,
        items: Vec::new(),
        error: Some(msg),
    }
}

#[cfg(test)]
#[expect(
    clippy::panic_in_result_fn,
    reason = "tests assert expected bridge frames and use ? for setup"
)]
mod tests {
    use std::os::unix::fs::PermissionsExt as _;

    use super::*;

    fn write_fake_vault(script_body: &str) -> Result<(tempfile::TempDir, PathBuf), std::io::Error> {
        let dir = tempfile::tempdir()?;
        let path = dir.path().join("fake-vault");
        let full = format!("#!/usr/bin/env python3\n{script_body}");
        std::fs::write(&path, full)?;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))?;
        Ok((dir, path))
    }

    #[tokio::test]
    async fn unavailable_when_binary_missing() {
        let client = VaultClient::with_binary("/nonexistent/Vault");
        let err = client.list_databases(false).await.unwrap_err();
        assert_eq!(err.kind, VaultErrorKind::Unavailable);
        assert!(err.message.contains("not installed"));
    }

    #[tokio::test]
    async fn lists_databases_and_fetches_credentials_and_logins()
    -> Result<(), Box<dyn std::error::Error>> {
        let script = r#"
import json, struct, sys

raw_len = sys.stdin.buffer.read(4)
size = struct.unpack("<I", raw_len)[0]
req = json.loads(sys.stdin.buffer.read(size).decode("utf-8"))
rid = req["id"]

if req["mode"] == "list-database":
    reply = {
        "id": rid,
        "status": "databases",
        "databases": [
            {
                "id": "item-1",
                "name": "Production",
                "driver": "postgresql",
                "host": "127.0.0.1",
                "port": 5432,
                "database": "app",
                "username": "readonly",
                "tls": "verify-full",
                "sshHost": "bastion.example.com",
                "sshPort": 22,
                "sshUser": "deploy",
                "organization": "Acme",
            }
        ],
    }
elif req["mode"] == "database-credential":
    reply = {
        "id": rid,
        "status": "ok",
        "sshAgent": "/tmp/vault-agent.sock",
        "database": {
            "id": req["itemID"],
            "name": "Production",
            "driver": "postgresql",
            "host": "127.0.0.1",
            "port": 5432,
            "database": "app",
            "username": "readonly",
            "password": "s3cr3t-password",
            "tls": "required",
        },
    }
elif req["mode"] == "list-login":
    reply = {
        "id": rid,
        "status": "suggestions",
        "suggestions": [
            {"id": "ABC-123", "name": "GitHub", "username": "nick@example.com"}
        ],
    }
elif req["mode"] == "login-credential":
    reply = {
        "id": rid,
        "status": "ok",
        "itemID": req["itemID"],
        "credential": {"mode": req["field"], "password": "vault-login-pass"},
    }
else:
    reply = {"id": rid, "status": "locked"}

body = json.dumps(reply).encode("utf-8")
sys.stdout.buffer.write(struct.pack("<I", len(body)) + body)
sys.stdout.buffer.flush()
"#;
        let (_dir, bin) = write_fake_vault(script)?;
        let client = VaultClient::with_binary(&bin);

        let dbs = client.list_databases(false).await?;
        assert_eq!(dbs.len(), 1);
        assert_eq!(dbs[0].driver, DatabaseDriver::Pgsql);
        assert_eq!(dbs[0].tls, VaultTls::VerifyFull);
        assert_eq!(dbs[0].organization.as_deref(), Some("Acme"));

        let cred = client.database_credential("item-1", true).await?;
        assert_eq!(cred.password, "s3cr3t-password");
        assert_eq!(cred.ssh_agent.as_deref(), Some("/tmp/vault-agent.sock"));
        assert!(!format!("{cred:?}").contains("s3cr3t-password"));

        let http_logins = client.list_logins("http://example.com/login", false).await;
        assert_eq!(http_logins.status, VaultLoginsStatus::Ok);
        assert!(http_logins.items.is_empty());

        let https_logins = client.list_logins("https://github.com/login", false).await;
        assert_eq!(https_logins.status, VaultLoginsStatus::Ok);
        assert_eq!(https_logins.items.len(), 1);
        assert_eq!(https_logins.items[0].id, "abc-123");

        let lookup = client
            .login_credential(
                "https://github.com/login",
                "https://github.com",
                "abc-123",
                VaultLoginField::Password,
            )
            .await;
        assert_eq!(
            lookup,
            VaultLoginFillLookup::Value("vault-login-pass".to_owned())
        );

        let mismatch = client
            .login_credential(
                "https://evil.example/login",
                "https://github.com",
                "abc-123",
                VaultLoginField::Password,
            )
            .await;
        assert_eq!(mismatch, VaultLoginFillLookup::OriginMismatch);
        Ok(())
    }
}
