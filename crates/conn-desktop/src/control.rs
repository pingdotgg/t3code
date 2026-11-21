//! `conn://` / `t3code://` deep link parser, workspace matching, and Unix domain control socket
//! matching Conn's `packages/contracts/src/desktopAppActivation.ts`,
//! `packages/shared/src/desktopAppControl.ts`, `apps/desktop/src/app/workspaceLink.ts`, and
//! `apps/desktop/src/app/DesktopAppActivation.ts`.
//!
//! Rooms, Orbit CLI, and macOS URL handlers use this protocol to focus Conn, switch workspaces
//! (`select-workspace`, `conn://workspace/<name>`), or jump directly to a thread (`open-thread`,
//! `conn://thread/<id>`).

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use tokio::io::{AsyncBufReadExt as _, AsyncWriteExt as _, BufReader};
use tokio::sync::{mpsc, oneshot};

/// Wire version matching `DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION`.
pub const DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION: u8 = 1;

const MAX_REQUEST_BYTES: usize = 64 * 1024;
const SOCKET_READ_TIMEOUT: Duration = Duration::from_secs(5);
const REQUEST_HANDLE_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_MACOS_UNIX_PATH_BYTES: usize = 103;

const ACCEPTED_SCHEMES: [&str; 4] = ["conn", "conn-dev", "t3code", "t3code-dev"];

/// Parsed desktop deep link (`conn://` or legacy `t3code://`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeepLink {
    /// `conn://workspace/<name>` or `conn://workspace/` (`"all"`).
    Workspace(String),
    /// `conn://thread/<id>[?environment=<id>]` or `conn://open-thread?threadId=<id>&environmentId=<id>`.
    Thread {
        thread_id: String,
        environment_id: Option<String>,
    },
    /// `conn://open-workspace?path=<abs-path>` or `conn://workspace-root?path=<abs-path>`.
    WorkspaceRoot(String),
}

/// Parses a `conn://`, `conn-dev://`, `t3code://`, or `t3code-dev://` URL.
///
/// Returns `None` for non-Conn URLs, malformed percent-encoding, or unrelated routes (such as
/// sign-in callbacks like `conn://app/welcome`).
#[must_use]
pub fn parse_deep_link(raw: &str) -> Option<DeepLink> {
    let parsed = url::Url::parse(raw.trim()).ok()?;
    if !ACCEPTED_SCHEMES.contains(&parsed.scheme()) {
        return None;
    }
    let host = parsed.host_str()?;
    match host {
        "workspace" => {
            let trimmed = parsed.path().trim_matches('/');
            if trimmed.is_empty() {
                return Some(DeepLink::Workspace("all".to_owned()));
            }
            let decoded = percent_decode_utf8(trimmed)?;
            let name = decoded.trim();
            if name.is_empty() {
                Some(DeepLink::Workspace("all".to_owned()))
            } else {
                Some(DeepLink::Workspace(name.to_owned()))
            }
        }
        "thread" => {
            let trimmed = parsed.path().trim_matches('/');
            if trimmed.is_empty() {
                return None;
            }
            let thread_id = percent_decode_utf8(trimmed)?;
            let thread_id = thread_id.trim();
            if thread_id.is_empty() {
                return None;
            }
            let env = query_param(
                &parsed,
                &["environmentId", "environment", "node", "instance"],
            );
            Some(DeepLink::Thread {
                thread_id: thread_id.to_owned(),
                environment_id: env,
            })
        }
        "open-thread" => {
            let thread_id = query_param(&parsed, &["threadId", "thread", "id"])?;
            let env = query_param(
                &parsed,
                &["environmentId", "environment", "node", "instance"],
            );
            Some(DeepLink::Thread {
                thread_id,
                environment_id: env,
            })
        }
        "open-workspace" | "workspace-root" => {
            let path = query_param(&parsed, &["workspaceRoot", "path"])?;
            Some(DeepLink::WorkspaceRoot(path))
        }
        _ => None,
    }
}

fn query_param(parsed: &url::Url, keys: &[&str]) -> Option<String> {
    for (k, v) in parsed.query_pairs() {
        if keys.iter().any(|candidate| *candidate == k.as_ref()) {
            let trimmed = v.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_owned());
            }
        }
    }
    None
}

/// Strict UTF-8 percent-decoder (rejects invalid `%XX` escapes like `decodeURIComponent`).
fn percent_decode_utf8(input: &str) -> Option<String> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return None;
            }
            let hi = hex_nibble(bytes[i + 1])?;
            let lo = hex_nibble(bytes[i + 2])?;
            out.push((hi << 4) | lo);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn hex_nibble(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// Lowercased alphanumeric folding matching Conn's `workspaceNameKey` in `workspaceLink.ts`.
#[must_use]
pub fn workspace_name_key(name: &str) -> String {
    name.chars()
        .flat_map(char::to_lowercase)
        .filter(|c| c.is_alphanumeric())
        .collect()
}

/// Whether `token` selects all projects (`""`, `"all"`, `"allprojects"`, `"none"`).
#[must_use]
pub fn means_all_projects(token: &str) -> bool {
    matches!(
        workspace_name_key(token).as_str(),
        "" | "all" | "allprojects" | "none"
    )
}

/// Resolves a workspace token (id, name, or unique prefix like `"DLF"` -> `"DLF - Leden"`)
/// against `(id, name)` pairs.
///
/// - Returns `Some(None)` when `token` means all projects.
/// - Returns `Some(Some((id, name)))` when one workspace matches unambiguously.
/// - Returns `None` when no workspace matches or a prefix is ambiguous across multiple workspaces.
#[must_use]
pub fn match_workspace(
    token: &str,
    workspaces: &[(String, String)],
) -> Option<Option<(String, String)>> {
    if means_all_projects(token) {
        return Some(None);
    }
    // 1. Exact id match
    if let Some((id, name)) = workspaces.iter().find(|(id, _)| id == token) {
        return Some(Some((id.clone(), name.clone())));
    }
    // 2. Exact folded name match
    let key = workspace_name_key(token);
    if key.is_empty() {
        return None;
    }
    if let Some((id, name)) = workspaces
        .iter()
        .find(|(_, name)| workspace_name_key(name) == key)
    {
        return Some(Some((id.clone(), name.clone())));
    }
    // 3. Unique folded prefix match
    let matches: Vec<&(String, String)> = workspaces
        .iter()
        .filter(|(_, name)| {
            let candidate = workspace_name_key(name);
            candidate.starts_with(&key) && candidate != key
        })
        .collect();
    if matches.is_empty() {
        return None;
    }
    let unique_keys: HashSet<String> = matches
        .iter()
        .map(|(_, name)| workspace_name_key(name))
        .collect();
    if unique_keys.len() == 1 {
        let (id, name) = matches[0];
        Some(Some((id.clone(), name.clone())))
    } else {
        None
    }
}

/// Resolved Unix socket address & directory matching Conn's `resolveDesktopAppControlAddress`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ControlSocketAddress {
    pub address: PathBuf,
    pub directory: PathBuf,
}

/// First 12 bytes of SHA-256 as 24 lowercase hex chars (exact match to Conn's `shortHash`).
#[must_use]
pub fn short_state_hash(state_dir: &str) -> String {
    let digest = Sha256::digest(state_dir.as_bytes());
    let mut out = String::with_capacity(24);
    for byte in &digest[..12] {
        use std::fmt::Write as _;
        let _ = write!(&mut out, "{byte:02x}");
    }
    out
}

/// Resolves the Unix domain control socket path for `state_dir` matching
/// `packages/shared/src/desktopAppControl.ts`.
#[must_use]
pub fn resolve_control_socket_address(
    state_dir: &Path,
    temp_dir: &Path,
    user_id: Option<u32>,
) -> ControlSocketAddress {
    let state_str = state_dir.to_string_lossy();
    let state_hash = short_state_hash(&state_str);
    let user_key = match user_id {
        Some(uid) => uid.to_string(),
        None => state_hash[..12].to_owned(),
    };
    let socket_name = format!("{state_hash}.sock");
    let mut directory = temp_dir.join(format!("t3code-{user_key}"));
    let candidate = directory.join(&socket_name);
    if candidate.to_string_lossy().len() > MAX_MACOS_UNIX_PATH_BYTES {
        directory = PathBuf::from("/tmp").join(format!("t3code-{user_key}"));
    }
    let address = directory.join(socket_name);
    ControlSocketAddress { address, directory }
}

/// One request sent over the desktop app control socket (`DesktopAppActivationRequest`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ControlRequest {
    #[serde(rename = "open-workspace", rename_all = "camelCase")]
    OpenWorkspace {
        version: u8,
        request_id: String,
        workspace_root: String,
        platform: String,
    },
    #[serde(rename = "open-thread", rename_all = "camelCase")]
    OpenThread {
        version: u8,
        request_id: String,
        environment_id: String,
        thread_id: String,
    },
    #[serde(rename = "select-workspace", rename_all = "camelCase")]
    SelectWorkspace {
        version: u8,
        request_id: String,
        workspace: String,
    },
}

impl ControlRequest {
    #[must_use]
    pub fn version(&self) -> u8 {
        match self {
            Self::OpenWorkspace { version, .. }
            | Self::OpenThread { version, .. }
            | Self::SelectWorkspace { version, .. } => *version,
        }
    }

    #[must_use]
    pub fn request_id(&self) -> &str {
        match self {
            Self::OpenWorkspace { request_id, .. }
            | Self::OpenThread { request_id, .. }
            | Self::SelectWorkspace { request_id, .. } => request_id,
        }
    }
}

/// One response written back over the control socket (`DesktopAppActivationResponse`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ControlResponse {
    #[serde(rename_all = "camelCase")]
    ThreadSuccess {
        version: u8,
        request_id: String,
        ok: bool,
        project_id: String,
        thread_id: String,
    },
    #[serde(rename_all = "camelCase")]
    WorkspaceSuccess {
        version: u8,
        request_id: String,
        ok: bool,
        workspace_id: Option<String>,
        workspace_name: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Failure {
        version: u8,
        request_id: String,
        ok: bool,
        code: String,
        message: String,
    },
}

impl ControlResponse {
    #[must_use]
    pub fn thread_ok(
        request_id: impl Into<String>,
        project_id: impl Into<String>,
        thread_id: impl Into<String>,
    ) -> Self {
        Self::ThreadSuccess {
            version: DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION,
            request_id: request_id.into(),
            ok: true,
            project_id: project_id.into(),
            thread_id: thread_id.into(),
        }
    }

    #[must_use]
    pub fn workspace_ok(
        request_id: impl Into<String>,
        workspace_id: Option<String>,
        workspace_name: Option<String>,
    ) -> Self {
        Self::WorkspaceSuccess {
            version: DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION,
            request_id: request_id.into(),
            ok: true,
            workspace_id,
            workspace_name,
        }
    }

    #[must_use]
    pub fn failure(
        request_id: impl Into<String>,
        code: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self::Failure {
            version: DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION,
            request_id: request_id.into(),
            ok: false,
            code: code.into(),
            message: message.into(),
        }
    }
}

/// One incoming control socket request paired with its reply channel.
pub type IncomingControlRequest = (ControlRequest, oneshot::Sender<ControlResponse>);

/// Live control socket server handle; dropping aborts the listener and cleans up our socket.
#[derive(Debug)]
pub struct ControlServerHandle {
    address: PathBuf,
    inode: Option<u64>,
    task: tokio::task::JoinHandle<()>,
}

impl ControlServerHandle {
    #[must_use]
    pub fn address(&self) -> &Path {
        &self.address
    }
}

impl Drop for ControlServerHandle {
    fn drop(&mut self) {
        self.task.abort();
        #[cfg(unix)]
        if let Some(expected_ino) = self.inode
            && let Ok(meta) = std::fs::symlink_metadata(&self.address)
        {
            use std::os::unix::fs::MetadataExt as _;
            if meta.ino() == expected_ino {
                let _ = std::fs::remove_file(&self.address);
            }
        }
    }
}

/// Starts Conn's Unix domain control socket server on the active Tokio runtime.
///
/// # Errors
///
/// Returns an `std::io::Error` if the socket directory cannot be created or bound.
#[cfg(unix)]
pub fn start_control_server(
    socket: &ControlSocketAddress,
    tx: mpsc::UnboundedSender<IncomingControlRequest>,
) -> std::io::Result<ControlServerHandle> {
    use std::os::unix::fs::{MetadataExt as _, PermissionsExt as _};
    use tokio::net::UnixListener;

    std::fs::create_dir_all(&socket.directory)?;
    let dir_meta = std::fs::symlink_metadata(&socket.directory)?;
    if !dir_meta.is_dir() || dir_meta.file_type().is_symlink() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("{} is not a directory", socket.directory.display()),
        ));
    }
    std::fs::set_permissions(&socket.directory, std::fs::Permissions::from_mode(0o700))?;

    static STAGING_SEQ: AtomicU64 = AtomicU64::new(1);
    let seq = STAGING_SEQ.fetch_add(1, Ordering::Relaxed);
    let staging = socket
        .directory
        .join(format!("{}-{seq}.tmp", std::process::id()));
    let _ = std::fs::remove_file(&staging);

    let listener = UnixListener::bind(&staging)?;
    std::fs::set_permissions(&staging, std::fs::Permissions::from_mode(0o600))?;
    let inode = std::fs::symlink_metadata(&staging).ok().map(|m| m.ino());
    if let Err(err) = std::fs::rename(&staging, &socket.address) {
        let _ = std::fs::remove_file(&staging);
        return Err(err);
    }

    let task = tokio::spawn(async move {
        while let Ok((stream, _addr)) = listener.accept().await {
            let tx = tx.clone();
            tokio::spawn(async move {
                handle_connection(stream, tx).await;
            });
        }
    });

    Ok(ControlServerHandle {
        address: socket.address.clone(),
        inode,
        task,
    })
}

#[cfg(unix)]
async fn handle_connection(
    stream: tokio::net::UnixStream,
    tx: mpsc::UnboundedSender<IncomingControlRequest>,
) {
    let (read_half, mut write_half) = stream.into_split();
    let mut reader = BufReader::new(read_half);
    let mut line = Vec::new();
    let read_result = tokio::time::timeout(SOCKET_READ_TIMEOUT, async {
        loop {
            let n = reader.read_until(b'\n', &mut line).await?;
            if line.len() > MAX_REQUEST_BYTES {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "too-large",
                ));
            }
            if n == 0 || line.ends_with(b"\n") {
                return Ok(());
            }
        }
    })
    .await;

    let response = match read_result {
        Err(_) => return,
        Ok(Err(err)) if err.kind() == std::io::ErrorKind::InvalidData => ControlResponse::failure(
            "invalid-request",
            "invalid-request",
            "The desktop app request is too large.",
        ),
        Ok(Err(_)) => return,
        Ok(Ok(())) => {
            if line.is_empty() {
                return;
            }
            let text = String::from_utf8_lossy(&line);
            let trimmed = text.trim();
            match serde_json::from_str::<serde_json::Value>(trimmed) {
                Err(_) => ControlResponse::failure(
                    "invalid-request",
                    "invalid-request",
                    "The desktop app request is not valid JSON.",
                ),
                Ok(raw) => {
                    let fallback_id = raw
                        .get("requestId")
                        .and_then(serde_json::Value::as_str)
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .unwrap_or("invalid-request")
                        .to_owned();
                    match serde_json::from_value::<ControlRequest>(raw) {
                        Err(_) => ControlResponse::failure(
                            fallback_id,
                            "invalid-request",
                            "The desktop app request is invalid.",
                        ),
                        Ok(req)
                            if req.version() != DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION
                                || req.request_id().trim().is_empty() =>
                        {
                            ControlResponse::failure(
                                fallback_id,
                                "invalid-request",
                                "The desktop app request is invalid.",
                            )
                        }
                        Ok(req) => {
                            let req_id = req.request_id().to_owned();
                            let (reply_tx, reply_rx) = oneshot::channel();
                            if tx.send((req, reply_tx)).is_err() {
                                ControlResponse::failure(
                                    req_id,
                                    "renderer-unavailable",
                                    "Conn is shutting down.",
                                )
                            } else {
                                match tokio::time::timeout(REQUEST_HANDLE_TIMEOUT, reply_rx).await {
                                    Ok(Ok(reply)) => reply,
                                    Ok(Err(_)) => ControlResponse::failure(
                                        req_id,
                                        "renderer-unavailable",
                                        "Conn closed before answering the request.",
                                    ),
                                    Err(_) => ControlResponse::failure(
                                        req_id,
                                        "request-timeout",
                                        "The desktop app did not finish opening in time.",
                                    ),
                                }
                            }
                        }
                    }
                }
            }
        }
    };

    if let Ok(mut encoded) = serde_json::to_string(&response) {
        encoded.push('\n');
        let _ = write_half.write_all(encoded.as_bytes()).await;
        let _ = write_half.shutdown().await;
    }
}

#[cfg(test)]
#[expect(
    clippy::panic_in_result_fn,
    reason = "tests assert expected control socket responses and use ? for setup"
)]
mod tests {
    use super::*;

    #[test]
    fn parses_conn_and_t3code_deep_links() {
        assert_eq!(
            parse_deep_link("conn://workspace/orbit"),
            Some(DeepLink::Workspace("orbit".to_owned()))
        );
        assert_eq!(
            parse_deep_link("t3code://workspace/Desktop%20apps/"),
            Some(DeepLink::Workspace("Desktop apps".to_owned()))
        );
        assert_eq!(
            parse_deep_link("conn-dev://workspace/"),
            Some(DeepLink::Workspace("all".to_owned()))
        );
        assert_eq!(
            parse_deep_link("conn://thread/thr-123?environmentId=node-1"),
            Some(DeepLink::Thread {
                thread_id: "thr-123".to_owned(),
                environment_id: Some("node-1".to_owned()),
            })
        );
        assert_eq!(
            parse_deep_link("conn://open-thread?threadId=thr-9&node=nick"),
            Some(DeepLink::Thread {
                thread_id: "thr-9".to_owned(),
                environment_id: Some("nick".to_owned()),
            })
        );
        assert_eq!(parse_deep_link("https://workspace/orbit"), None);
        assert_eq!(parse_deep_link("t3code://workspace/%E0%A4%A"), None);
        assert_eq!(parse_deep_link("conn://app/welcome"), None);
    }

    #[test]
    fn matches_workspaces_by_exact_folded_and_unique_prefix() {
        let list = vec![
            ("ws-1".to_owned(), "DLF - Leden".to_owned()),
            ("ws-2".to_owned(), "Orbit".to_owned()),
            ("ws-3".to_owned(), "App Alpha".to_owned()),
            ("ws-4".to_owned(), "App Beta".to_owned()),
        ];

        assert_eq!(match_workspace("all", &list), Some(None));
        assert_eq!(match_workspace("", &list), Some(None));
        assert_eq!(
            match_workspace("ws-2", &list),
            Some(Some(("ws-2".to_owned(), "Orbit".to_owned())))
        );
        assert_eq!(
            match_workspace("DLF", &list),
            Some(Some(("ws-1".to_owned(), "DLF - Leden".to_owned())))
        );
        // Ambiguous prefix matches two distinct workspaces -> None.
        assert_eq!(match_workspace("App", &list), None);
        assert_eq!(match_workspace("Missing", &list), None);
    }

    #[test]
    fn resolves_control_socket_address_matching_conn_hash() {
        let addr = resolve_control_socket_address(
            Path::new("/Users/nick/.t3/userdata"),
            Path::new("/tmp"),
            Some(501),
        );
        assert_eq!(addr.directory, PathBuf::from("/tmp/t3code-501"));
        let name = addr.address.file_name().and_then(|s| s.to_str()).unwrap();
        assert!(name.ends_with(".sock"));
        assert_eq!(name.len(), 24 + 5);

        let long_tmp = PathBuf::from(format!("/{}", "a".repeat(95)));
        let fallback = resolve_control_socket_address(
            Path::new("/Users/nick/.t3/userdata"),
            &long_tmp,
            Some(501),
        );
        assert_eq!(fallback.directory, PathBuf::from("/tmp/t3code-501"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn control_socket_round_trips_select_workspace_and_errors()
    -> Result<(), Box<dyn std::error::Error>> {
        let dir = tempfile::tempdir()?;
        let socket = ControlSocketAddress {
            address: dir.path().join("test.sock"),
            directory: dir.path().to_path_buf(),
        };
        let (tx, mut rx) = mpsc::unbounded_channel::<IncomingControlRequest>();
        let handle = start_control_server(&socket, tx)?;

        let responder = tokio::spawn(async move {
            if let Some((req, reply_tx)) = rx.recv().await {
                match req {
                    ControlRequest::SelectWorkspace {
                        request_id,
                        workspace,
                        ..
                    } => {
                        let _ = reply_tx.send(ControlResponse::workspace_ok(
                            request_id,
                            Some("ws-1".to_owned()),
                            Some(workspace),
                        ));
                    }
                    other => {
                        let _ = reply_tx.send(ControlResponse::failure(
                            other.request_id(),
                            "invalid-request",
                            "unexpected",
                        ));
                    }
                }
            }
        });

        // 1. Valid select-workspace request
        let mut client = tokio::net::UnixStream::connect(handle.address()).await?;
        client
            .write_all(
                br#"{"version":1,"requestId":"req-1","type":"select-workspace","workspace":"Orbit"}"#,
            )
            .await?;
        client.write_all(b"\n").await?;
        let mut reader = BufReader::new(client);
        let mut resp_line = String::new();
        reader.read_line(&mut resp_line).await?;
        let resp: serde_json::Value = serde_json::from_str(&resp_line)?;
        assert_eq!(resp["ok"], true);
        assert_eq!(resp["requestId"], "req-1");
        assert_eq!(resp["workspaceName"], "Orbit");

        // 2. Invalid JSON returns error response
        let mut bad_client = tokio::net::UnixStream::connect(handle.address()).await?;
        bad_client.write_all(b"not-json\n").await?;
        let mut bad_reader = BufReader::new(bad_client);
        let mut bad_line = String::new();
        bad_reader.read_line(&mut bad_line).await?;
        let bad_resp: serde_json::Value = serde_json::from_str(&bad_line)?;
        assert_eq!(bad_resp["ok"], false);
        assert_eq!(bad_resp["code"], "invalid-request");

        let _ = responder.await;
        drop(handle);
        assert!(!socket.address.exists());
        Ok(())
    }
}
