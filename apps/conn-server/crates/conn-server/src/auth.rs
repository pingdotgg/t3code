//! Pairing links, bearer sessions and WebSocket tickets, as Conn clients and Orbit use them for
//! a direct (non-relay) environment. Reference: `apps/server/src/auth/EnvironmentAuth.ts`,
//! `PairingGrantStore.ts`, `SessionStore.ts`.
//!
//! Every credential is a random secret the client holds; the store keeps only its SHA-256
//! hash. Sessions and pairing links persist in one 0600 JSON file (`auth.json`), which the
//! `auth` and `pair` subcommands change while the server runs: every write takes a lock file,
//! and the server reloads the file whenever its stamp changes. Tickets and live connection
//! counts stay in memory.

use std::{
    collections::HashMap,
    fs, io,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::SystemTime,
};

use conn_contract::{
    AuthClientMetadata, AuthClientMetadataDeviceType, AuthClientSession, AuthEnvironmentScope,
    AuthPairingLink, from_json,
};
use conn_support::{
    fs::write_private,
    hex::hex,
    hmac::{constant_time_eq, hmac_sha256},
    time::iso_from_ms,
    uuid_v4,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::broadcast;

/// `AuthStandardClientScopes` in `packages/contracts/src/auth.ts`.
pub const STANDARD_SCOPES: &[&str] = &[
    "orchestration:read",
    "orchestration:operate",
    "settings:write",
    "providers:manage",
    "environment:maintain",
    "preview:operate",
    "diagnostics:read",
    "terminal:read",
    "terminal:operate",
    "source-control:write",
    "filesystem:read",
    "filesystem:write",
    "relay:read",
    "access:read",
    "access:write",
    "relay:write",
];
/// Every scope a grant may name (`AuthGrantScope`): the environment scopes but `review:write`,
/// so the standard ones plus `relay:configure`, which no standard client gets.
const GRANT_SCOPES: &[&str] = &[
    "orchestration:read",
    "orchestration:operate",
    "settings:write",
    "providers:manage",
    "environment:maintain",
    "preview:operate",
    "diagnostics:read",
    "terminal:read",
    "terminal:operate",
    "source-control:write",
    "filesystem:read",
    "filesystem:write",
    "relay:read",
    "access:read",
    "access:write",
    "relay:write",
    "relay:configure",
];
/// Scopes clients from before granular permissions know; `scopes` lists only these.
const LEGACY_SCOPES: &[&str] = &[
    "orchestration:read",
    "orchestration:operate",
    "terminal:operate",
    "review:write",
    "access:read",
    "access:write",
    "relay:read",
    "relay:write",
];

pub const PAIRING_CODE_ALPHABET: &[u8] = b"23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
pub const PAIRING_CODE_LENGTH: usize = 12;

const MINUTE_MS: u64 = 60_000;
pub const PAIRING_CODE_TTL_MS: u64 = 5 * MINUTE_MS;
pub const STARTUP_PAIRING_CODE_TTL_MS: u64 = 24 * 60 * MINUTE_MS;
pub const SESSION_TTL_MS: u64 = 30 * 24 * 60 * MINUTE_MS;
pub const TICKET_TTL_MS: u64 = 5 * MINUTE_MS;
/// The longest life a session or pairing link can get: ten years.
pub const MAX_TTL_MS: u64 = 10 * 366 * 24 * 60 * MINUTE_MS;

/// Subjects as `EnvironmentAuth.ts` names them.
pub const SUBJECT_ONE_TIME_TOKEN: &str = "one-time-token";
pub const SUBJECT_CLI_SESSION: &str = "cli-issued-session";
pub const SUBJECT_DESKTOP_BOOTSTRAP: &str = "desktop-bootstrap";
/// Sessions MCP OAuth issues to outside agents and peer links (`MCP_CLIENT_SUBJECT`).
pub const SUBJECT_MCP_CLIENT: &str = "mcp-client";
/// Pairing links bound to one purpose (`AuthPairingLinks.ts`): only the MCP sign-in they were
/// made for may spend them, never a plain pairing.
pub const MCP_APPROVAL_SUBJECT_PREFIX: &str = "mcp-approval:";
pub const PEER_LINK_PAIRING_SUBJECT_PREFIX: &str = "mcp-approval:peer-link:";
/// `MCP_CLIENT_SESSION_TTL`: 30 days.
pub const MCP_CLIENT_SESSION_TTL_MS: u64 = 30 * 24 * 60 * MINUTE_MS;
const METHOD_BEARER: &str = "bearer-access-token";

type Hash = [u8; 32];

/// Who a request acts as.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Principal {
    pub session_id: String,
    pub subject: String,
    pub scopes: Vec<String>,
    pub expires_at_ms: u64,
}

impl Principal {
    pub fn has_scope(&self, scope: &str) -> bool {
        self.scopes.iter().any(|s| s == scope)
    }
}

/// `ServerAuthDescriptor` for a server paired by one-time code, then bearer tokens. No browser
/// cookie sessions and no DPoP. [`AuthStore::descriptor`] adds the desktop's bootstrap.
pub fn descriptor() -> serde_json::Value {
    descriptor_for("remote-reachable", &["one-time-token"])
}

fn descriptor_for(policy: &str, bootstrap_methods: &[&str]) -> serde_json::Value {
    serde_json::json!({
        "policy": policy,
        "bootstrapMethods": bootstrap_methods,
        "sessionMethods": ["bearer-access-token"],
        "sessionCookieName": "conn_session",
        "serverUpdateScope": "environment:maintain",
    })
}

/// The credential Conn desktop hands its local backend (`DesktopBackendBootstrap`). With a
/// secret, valid tokens rotate every 12 hours (`desktopBootstrapToken.ts`); without one, the
/// token itself works for 24 hours. Either may be exchanged any number of times.
#[derive(Clone)]
pub struct DesktopBootstrap {
    pub token: String,
    pub secret: Option<String>,
    pub expires_at_ms: u64,
    /// Bound to a non-loopback host: one-time codes work too (`remote-reachable`).
    pub remote_reachable: bool,
}

impl std::fmt::Debug for DesktopBootstrap {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DesktopBootstrap")
            .field("token", &"<redacted>")
            .field("secret", &self.secret.as_ref().map(|_| "<redacted>"))
            .field("expires_at_ms", &self.expires_at_ms)
            .field("remote_reachable", &self.remote_reachable)
            .finish()
    }
}

const DESKTOP_TOKEN_WINDOW_MS: u64 = 12 * 60 * MINUTE_MS;
const DESKTOP_TOKEN_TTL_MS: u64 = 24 * 60 * MINUTE_MS;

impl DesktopBootstrap {
    pub fn new(token: String, secret: Option<String>, remote_reachable: bool) -> Self {
        Self {
            token,
            secret,
            expires_at_ms: expires_at(now_ms(), DESKTOP_TOKEN_TTL_MS),
            remote_reachable,
        }
    }

    fn accepts(&self, credential: &str, now: u64) -> bool {
        match &self.secret {
            Some(secret) => {
                let window = now / DESKTOP_TOKEN_WINDOW_MS;
                [window.saturating_sub(1), window, window + 1]
                    .into_iter()
                    .any(|w| {
                        constant_time_eq(desktop_token(secret, w).as_bytes(), credential.as_bytes())
                    })
            }
            None => {
                now < self.expires_at_ms
                    && constant_time_eq(self.token.as_bytes(), credential.as_bytes())
            }
        }
    }
}

/// `deriveToken`: hex HMAC-SHA256 of `t3-desktop-bootstrap:<window>` under the secret.
pub fn desktop_token(secret: &str, window: u64) -> String {
    hex(&hmac_sha256(
        secret.as_bytes(),
        format!("t3-desktop-bootstrap:{window}").as_bytes(),
    ))
}

/// `authScopeResponse`: legacy `scopes` plus the full grant as `permissions`.
pub fn scope_response(scopes: &[String]) -> serde_json::Value {
    serde_json::json!({ "scopes": legacy_scopes(scopes), "permissions": scopes })
}

fn legacy_scopes(scopes: &[String]) -> Vec<&String> {
    scopes
        .iter()
        .filter(|s| LEGACY_SCOPES.contains(&s.as_str()))
        .collect()
}

/// `authScopeRequiredResponse`: the scope a client from before granular permissions knows,
/// plus the exact permission.
pub fn legacy_parent(scope: &str) -> &str {
    match scope {
        "filesystem:read" | "diagnostics:read" => "orchestration:read",
        "settings:write"
        | "providers:manage"
        | "environment:maintain"
        | "preview:operate"
        | "source-control:write"
        | "filesystem:write" => "orchestration:operate",
        "terminal:read" => "terminal:operate",
        "relay:configure" => "relay:write",
        other => other,
    }
}

pub fn is_grant_scope(scope: &str) -> bool {
    GRANT_SCOPES.contains(&scope)
}

/// `AuthClientMetadata`, as stored.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientInfo {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ip_address: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_agent: Option<String>,
    /// `desktop`, `mobile`, `tablet`, `bot` or `unknown`.
    #[serde(default = "unknown_device")]
    pub device_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub os: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub browser: Option<String>,
}

fn unknown_device() -> String {
    "unknown".into()
}

impl ClientInfo {
    /// What a client tells about itself when it pairs: its own label, device type and OS, and
    /// what its user agent shows.
    pub fn from_request(
        label: Option<String>,
        device_type: Option<String>,
        os: Option<String>,
        user_agent: Option<&str>,
        ip_address: Option<String>,
    ) -> Self {
        let ua = user_agent.unwrap_or_default();
        Self {
            label: label.filter(|l| !l.trim().is_empty()),
            ip_address,
            user_agent: user_agent.map(str::to_owned),
            device_type: device_type.unwrap_or_else(|| device_from_user_agent(ua).into()),
            os: os.or_else(|| os_from_user_agent(ua).map(str::to_owned)),
            browser: browser_from_user_agent(ua).map(str::to_owned),
        }
    }

    pub fn bot(label: Option<String>) -> Self {
        Self {
            label,
            device_type: "bot".into(),
            ..Self::default()
        }
    }

    pub fn to_contract(&self) -> AuthClientMetadata {
        AuthClientMetadata {
            label: self.label.clone(),
            ip_address: self.ip_address.clone(),
            user_agent: self.user_agent.clone(),
            device_type: from_json(serde_json::Value::String(self.device_type.clone()))
                .unwrap_or(AuthClientMetadataDeviceType::Unknown),
            os: self.os.clone(),
            browser: self.browser.clone(),
        }
    }
}

fn device_from_user_agent(ua: &str) -> &'static str {
    if ua.is_empty() {
        "unknown"
    } else if ua.contains("iPad") || ua.contains("Tablet") {
        "tablet"
    } else if ua.contains("Mobile") || ua.contains("iPhone") || ua.contains("Android") {
        "mobile"
    } else if ua.contains("bot") || ua.starts_with("curl/") || ua.starts_with("node") {
        "bot"
    } else if ua.starts_with("Mozilla/") {
        "desktop"
    } else {
        "unknown"
    }
}

fn os_from_user_agent(ua: &str) -> Option<&'static str> {
    [
        ("iPhone", "iOS"),
        ("iPad", "iPadOS"),
        ("Android", "Android"),
        ("Mac OS X", "macOS"),
        ("Windows", "Windows"),
        ("CrOS", "ChromeOS"),
        ("Linux", "Linux"),
    ]
    .into_iter()
    .find(|(needle, _)| ua.contains(needle))
    .map(|(_, os)| os)
}

fn browser_from_user_agent(ua: &str) -> Option<&'static str> {
    [
        ("Electron/", "Electron"),
        ("Edg/", "Edge"),
        ("Firefox/", "Firefox"),
        ("Chrome/", "Chrome"),
        ("Safari/", "Safari"),
    ]
    .into_iter()
    .find(|(needle, _)| ua.contains(needle))
    .map(|(_, browser)| browser)
}

#[derive(Clone)]
pub struct IssuedPairingCode {
    pub id: String,
    pub code: String,
    pub label: Option<String>,
    pub scopes: Vec<String>,
    pub created_at_ms: u64,
    pub expires_at_ms: u64,
}

impl std::fmt::Debug for IssuedPairingCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("IssuedPairingCode")
            .field("id", &self.id)
            .field("code", &"<redacted>")
            .field("label", &self.label)
            .field("scopes", &self.scopes)
            .field("created_at_ms", &self.created_at_ms)
            .field("expires_at_ms", &self.expires_at_ms)
            .finish()
    }
}

pub struct IssuedSession {
    pub token: String,
    pub principal: Principal,
    pub client: ClientInfo,
}

impl std::fmt::Debug for IssuedSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("IssuedSession")
            .field("token", &"<redacted>")
            .field("principal", &self.principal)
            .field("client", &self.client)
            .finish()
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum ExchangeError {
    /// Unknown, spent, or expired code.
    InvalidCredential,
    /// The request named a scope that does not exist.
    InvalidScope,
    /// None of the requested scopes is in the grant.
    ScopeNotGranted,
    /// The new session could not be saved; nothing changed.
    Storage,
}

/// Why a pairing code could not approve an MCP sign-in (`ServerAuthMcpApprovalCodeError`).
#[derive(Debug, PartialEq, Eq)]
pub enum McpCodeError {
    UnknownOrUsed,
    InsufficientScope,
    Storage,
}

impl McpCodeError {
    /// The T3 server's words for each reason.
    pub fn message(&self) -> &'static str {
        match self {
            McpCodeError::InsufficientScope => {
                "That pairing code cannot grant this access. It has not been used, so choose an access level it grants, or create a code with the standard scopes."
            }
            McpCodeError::UnknownOrUsed => {
                "That pairing code is unknown, expired, or already used."
            }
            McpCodeError::Storage => "The code could not be checked. Try again.",
        }
    }
}

/// An MCP OAuth client, as `/mcp` sees it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct McpClientSession {
    pub session_id: String,
    pub label: String,
    /// `AuthMcpClientAccess`.
    pub access: String,
    pub peer_link: bool,
}

/// `AuthMcpClientAccess` levels.
pub const MCP_ACCESS_LEVELS: &[&str] = &[
    "read-only",
    "approval-required",
    "auto-accept-edits",
    "auto",
    "full-access",
];

pub fn is_mcp_access(level: &str) -> bool {
    MCP_ACCESS_LEVELS.contains(&level)
}

/// `mcpClientScopes`: the scopes an agent session gets for an access level.
pub fn mcp_client_scopes(access: &str) -> Vec<String> {
    let scopes: &[&str] = match access {
        "read-only" => &["orchestration:read"],
        "full-access" => &[
            "orchestration:read",
            "orchestration:operate",
            "settings:write",
            "source-control:write",
        ],
        _ => &["orchestration:read", "orchestration:operate"],
    };
    scopes.iter().map(|s| (*s).to_owned()).collect()
}

/// A client may not revoke its own session (`current_session_revoke_not_allowed`).
#[derive(Debug, PartialEq, Eq)]
pub struct RevokeCurrentSession;

/// What a pairing link grants.
#[derive(Clone, Debug)]
pub struct PairingRequest {
    pub scopes: Vec<String>,
    pub label: Option<String>,
    pub ttl_ms: u64,
}

impl PairingRequest {
    pub fn standard(label: Option<String>, ttl_ms: u64) -> Self {
        Self {
            scopes: STANDARD_SCOPES.iter().map(|s| s.to_string()).collect(),
            label,
            ttl_ms,
        }
    }
}

/// A session issued without pairing (`t3 auth session issue`).
#[derive(Clone, Debug)]
pub struct SessionRequest {
    pub scopes: Vec<String>,
    pub label: Option<String>,
    pub subject: Option<String>,
    pub ttl_ms: u64,
}

/// One change to what `subscribeAuthAccess` shows. Carries ids; readers look up the rest.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AccessChange {
    PairingLinkUpserted(String),
    PairingLinkRemoved(String),
    ClientUpserted(String),
    ClientRemoved(String),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredPairing {
    id: String,
    code_hash: String,
    scopes: Vec<String>,
    subject: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    label: Option<String>,
    created_at_ms: u64,
    expires_at_ms: u64,
}

impl StoredPairing {
    /// A code made for one MCP sign-in (`mcp-approval:…`), not a pairing link a client shows.
    fn purpose_bound(&self) -> bool {
        self.subject.starts_with(MCP_APPROVAL_SUBJECT_PREFIX)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredSession {
    id: String,
    token_hash: String,
    subject: String,
    scopes: Vec<String>,
    #[serde(default = "bearer_method")]
    method: String,
    #[serde(default)]
    client: ClientInfo,
    issued_at_ms: u64,
    expires_at_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_connected_at_ms: Option<u64>,
    /// An MCP client's approved runtime mode (`runtimeModeCeiling`); none for read-only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    runtime_mode_ceiling: Option<String>,
    /// An MCP client session another environment holds as its peer link.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    peer_link: bool,
}

fn bearer_method() -> String {
    METHOD_BEARER.into()
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthFile {
    version: u32,
    sessions: Vec<StoredSession>,
    pairing_links: Vec<StoredPairing>,
}

#[derive(Clone)]
struct Ticket {
    session: Hash,
    audience: Option<String>,
    expires_at_ms: u64,
}

/// Size and modification time of the auth file as last read or written.
type Stamp = (u64, SystemTime);

#[derive(Clone, Default)]
struct State {
    pairing: HashMap<Hash, StoredPairing>,
    sessions: HashMap<Hash, StoredSession>,
    tickets: HashMap<Hash, Ticket>,
    /// Open sockets per session id.
    connections: HashMap<String, usize>,
    /// When each session last opened a socket, kept in memory so a socket open writes no
    /// file. Holds only ids of live sessions.
    last_connected: HashMap<String, u64>,
    stamp: Option<Stamp>,
}

impl State {
    /// Drops what expired. Returns the changes to announce.
    fn purge(&mut self, now: u64) -> Vec<AccessChange> {
        let mut changes = Vec::new();
        self.pairing.retain(|_, grant| {
            let keep = grant.expires_at_ms > now;
            // Approval and peer-link codes are never listed, so their end is not announced.
            if !keep && !grant.purpose_bound() {
                changes.push(AccessChange::PairingLinkRemoved(grant.id.clone()));
            }
            keep
        });
        self.sessions.retain(|_, session| {
            let keep = session.expires_at_ms > now;
            if !keep {
                changes.push(AccessChange::ClientRemoved(session.id.clone()));
            }
            keep
        });
        self.tickets.retain(|_, ticket| ticket.expires_at_ms > now);
        let sessions = &self.sessions;
        self.last_connected
            .retain(|id, _| sessions.values().any(|s| &s.id == id));
        changes
    }

    fn session_by_id(&self, id: &str) -> Option<(&Hash, &StoredSession)> {
        self.sessions.iter().find(|(_, s)| s.id == id)
    }
}

pub struct AuthStore {
    state: Mutex<State>,
    desktop: Mutex<Option<DesktopBootstrap>>,
    /// Where sessions and pairing links persist; `None` keeps them in memory (tests).
    file: Option<PathBuf>,
    changes: broadcast::Sender<AccessChange>,
}

impl std::fmt::Debug for AuthStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // The state holds token hashes and pairing codes.
        f.debug_struct("AuthStore")
            .field("file", &self.file)
            .finish_non_exhaustive()
    }
}

impl AuthStore {
    pub fn in_memory() -> Arc<Self> {
        Arc::new(Self::new(None))
    }

    fn new(file: Option<PathBuf>) -> Self {
        Self {
            state: Mutex::default(),
            desktop: Mutex::default(),
            file,
            changes: broadcast::channel(64).0,
        }
    }

    /// Loads the sessions and pairing links saved in `file`, if it exists.
    pub fn open(file: PathBuf) -> io::Result<Arc<Self>> {
        let store = Self::new(Some(file));
        {
            let mut state = store.lock();
            store.reload(&mut state)?;
        }
        Ok(Arc::new(store))
    }

    /// Accept Conn desktop's bootstrap credential from now on.
    pub fn set_desktop_bootstrap(&self, bootstrap: DesktopBootstrap) {
        *crate::lock(&self.desktop) = Some(bootstrap);
    }

    /// `ServerAuthDescriptor`, as `EnvironmentAuthPolicy` resolves it for how this server started.
    pub fn descriptor(&self) -> serde_json::Value {
        match &*crate::lock(&self.desktop) {
            Some(desktop) if desktop.remote_reachable => {
                descriptor_for("remote-reachable", &["desktop-bootstrap", "one-time-token"])
            }
            Some(_) => descriptor_for("desktop-managed-local", &["desktop-bootstrap"]),
            None => descriptor(),
        }
    }

    fn desktop_accepts(&self, credential: &str) -> bool {
        crate::lock(&self.desktop)
            .as_ref()
            .is_some_and(|d| d.accepts(credential, now_ms()))
    }

    /// Changes to sessions and pairing links, for `subscribeAuthAccess` and open sockets.
    pub fn subscribe(&self) -> broadcast::Receiver<AccessChange> {
        self.changes.subscribe()
    }

    /// A pairing link with the standard client scopes.
    pub fn issue_pairing_code(
        &self,
        label: Option<String>,
        ttl_ms: u64,
    ) -> io::Result<IssuedPairingCode> {
        self.issue_pairing(PairingRequest::standard(label, ttl_ms))
    }

    /// A one-time pairing link. The caller has checked the scopes.
    pub fn issue_pairing(&self, request: PairingRequest) -> io::Result<IssuedPairingCode> {
        let code = pairing_code();
        let now = now_ms();
        let link = StoredPairing {
            id: uuid_v4(),
            code_hash: hex(&hash(&code)),
            scopes: request.scopes,
            subject: SUBJECT_ONE_TIME_TOKEN.into(),
            label: request.label,
            created_at_ms: now,
            expires_at_ms: expires_at(now, request.ttl_ms),
        };
        let issued = IssuedPairingCode {
            id: link.id.clone(),
            code: code.clone(),
            label: link.label.clone(),
            scopes: link.scopes.clone(),
            created_at_ms: now,
            expires_at_ms: link.expires_at_ms,
        };
        self.write(|state| {
            state.pairing.insert(hash(&code), link.clone());
            vec![AccessChange::PairingLinkUpserted(link.id.clone())]
        })?;
        Ok(issued)
    }

    /// Spends a pairing code for a bearer session. `requested` narrows the grant.
    pub fn exchange(
        &self,
        code: &str,
        requested: Option<&[String]>,
        client: ClientInfo,
    ) -> Result<IssuedSession, ExchangeError> {
        if let Some(requested) = requested
            && requested
                .iter()
                .any(|s| !is_grant_scope(s) && s != "review:write")
        {
            return Err(ExchangeError::InvalidScope);
        }
        if self.desktop_accepts(code.trim()) {
            let scopes = narrow(
                STANDARD_SCOPES.iter().map(|s| s.to_string()).collect(),
                requested,
            );
            if scopes.is_empty() {
                return Err(ExchangeError::ScopeNotGranted);
            }
            let (token, session) = new_session(
                SUBJECT_DESKTOP_BOOTSTRAP.into(),
                scopes,
                client,
                SESSION_TTL_MS,
            );
            let issued = IssuedSession {
                token: token.clone(),
                principal: principal_of(&session),
                client: session.client.clone(),
            };
            let id = session.id.clone();
            // `replaceActiveForSubjectAndMethod`: the desktop holds one session at a time.
            let written = self.write(|state| {
                let mut changes = Vec::new();
                state.sessions.retain(|_, s| {
                    let replaced =
                        s.subject == SUBJECT_DESKTOP_BOOTSTRAP && s.method == session.method;
                    if replaced {
                        changes.push(AccessChange::ClientRemoved(s.id.clone()));
                    }
                    !replaced
                });
                state.sessions.insert(hash(&token), session);
                changes.push(AccessChange::ClientUpserted(id));
                changes
            });
            return match written {
                Ok(()) => Ok(issued),
                Err(error) => {
                    eprintln!("conn-server: could not save auth state: {error}");
                    Err(ExchangeError::Storage)
                }
            };
        }
        // Codes are case-insensitive, as `PAIRING_TOKEN_PATTERN` is.
        let key = hash(&code.trim().to_ascii_uppercase());
        let mut outcome = Err(ExchangeError::InvalidCredential);
        let written = self.write(|state| {
            // A purpose-bound code (`mcp-approval:…`) is only for the MCP sign-in it was made for.
            let Some(grant) = state
                .pairing
                .get(&key)
                .filter(|g| !g.subject.starts_with(MCP_APPROVAL_SUBJECT_PREFIX))
            else {
                return Vec::new();
            };
            let scopes = narrow(grant.scopes.clone(), requested);
            if scopes.is_empty() {
                outcome = Err(ExchangeError::ScopeNotGranted);
                return Vec::new();
            }
            let Some(grant) = state.pairing.remove(&key) else {
                return Vec::new();
            };
            let mut client = client.clone();
            if client.label.is_none() {
                client.label = grant.label.clone();
            }
            let (token, session) =
                new_session(grant.subject.clone(), scopes, client, SESSION_TTL_MS);
            let issued = IssuedSession {
                token: token.clone(),
                principal: principal_of(&session),
                client: session.client.clone(),
            };
            let id = session.id.clone();
            state.sessions.insert(hash(&token), session);
            outcome = Ok(issued);
            vec![
                AccessChange::PairingLinkRemoved(grant.id),
                AccessChange::ClientUpserted(id),
            ]
        });
        if let Err(error) = written {
            eprintln!("conn-server: could not save auth state: {error}");
            return Err(ExchangeError::Storage);
        }
        outcome
    }

    /// A bearer session without pairing, for headless clients (`auth session issue`).
    pub fn issue_session(&self, request: SessionRequest) -> io::Result<IssuedSession> {
        let subject = request
            .subject
            .unwrap_or_else(|| SUBJECT_CLI_SESSION.into());
        let (token, session) = new_session(
            subject,
            request.scopes,
            ClientInfo::bot(request.label),
            request.ttl_ms,
        );
        let issued = IssuedSession {
            token: token.clone(),
            principal: principal_of(&session),
            client: session.client.clone(),
        };
        self.write(|state| {
            let id = session.id.clone();
            state.sessions.insert(hash(&token), session.clone());
            vec![AccessChange::ClientUpserted(id)]
        })?;
        Ok(issued)
    }

    /// A one-time code that links another environment at `access` (`purpose: "peer-link"`):
    /// it carries exactly the scopes that access needs, and only a peer link may spend it.
    pub fn issue_peer_link_pairing(
        &self,
        access: &str,
        label: Option<String>,
    ) -> io::Result<IssuedPairingCode> {
        let code = pairing_code();
        let now = now_ms();
        let link = StoredPairing {
            id: uuid_v4(),
            code_hash: hex(&hash(&code)),
            scopes: mcp_client_scopes(access),
            subject: format!("{PEER_LINK_PAIRING_SUBJECT_PREFIX}{access}"),
            label,
            created_at_ms: now,
            expires_at_ms: expires_at(now, PAIRING_CODE_TTL_MS),
        };
        let issued = IssuedPairingCode {
            id: link.id.clone(),
            code: code.clone(),
            label: link.label.clone(),
            scopes: link.scopes.clone(),
            created_at_ms: now,
            expires_at_ms: link.expires_at_ms,
        };
        // Purpose-bound codes stay out of the pairing links clients show
        // (`PairingGrantStore.issue`): no upsert event.
        self.write(|state| {
            state.pairing.insert(hash(&code), link.clone());
            Vec::new()
        })?;
        Ok(issued)
    }

    /// Spends a pairing code for an MCP sign-in at `access` (`consumeMcpApprovalCode`). A plain
    /// one-time code works when it carries the access's scopes; a purpose-bound one only for
    /// its own purpose (`peer_link`) and level. Returns the access the session gets.
    pub fn consume_mcp_code(
        &self,
        code: &str,
        access: &str,
        peer_link: bool,
    ) -> Result<String, McpCodeError> {
        let key = hash(&code.trim().to_ascii_uppercase());
        let allowed = format!(
            "{}{access}",
            if peer_link {
                PEER_LINK_PAIRING_SUBJECT_PREFIX
            } else {
                MCP_APPROVAL_SUBJECT_PREFIX
            }
        );
        let required = mcp_client_scopes(access);
        let mut outcome = Err(McpCodeError::UnknownOrUsed);
        let written = self.write(|state| {
            let Some(grant) = state.pairing.get(&key) else {
                return Vec::new();
            };
            // T3 names a missing scope before a purpose that does not match.
            if !required.iter().all(|s| grant.scopes.contains(s)) {
                outcome = Err(McpCodeError::InsufficientScope);
                return Vec::new();
            }
            if grant.subject.starts_with(MCP_APPROVAL_SUBJECT_PREFIX) && grant.subject != allowed {
                return Vec::new();
            }
            let Some(grant) = state.pairing.remove(&key) else {
                return Vec::new();
            };
            let level = grant
                .subject
                .strip_prefix(MCP_APPROVAL_SUBJECT_PREFIX)
                .filter(|level| is_mcp_access(level))
                .unwrap_or(access);
            outcome = Ok(level.to_owned());
            // `consumeAvailable`: a spent approval or peer-link code is not announced.
            if grant.purpose_bound() {
                Vec::new()
            } else {
                vec![AccessChange::PairingLinkRemoved(grant.id)]
            }
        });
        if let Err(error) = written {
            eprintln!("conn-server: could not save auth state: {error}");
            return Err(McpCodeError::Storage);
        }
        outcome
    }

    /// A session for an MCP client signed in through OAuth (`issueMcpClientSession`).
    pub fn issue_mcp_client_session(
        &self,
        label: &str,
        access: &str,
        peer_link: bool,
        client: ClientInfo,
    ) -> io::Result<IssuedSession> {
        let mut client = client;
        client.label = Some(label.to_owned());
        client.device_type = "bot".into();
        let (token, mut session) = new_session(
            SUBJECT_MCP_CLIENT.into(),
            mcp_client_scopes(access),
            client,
            MCP_CLIENT_SESSION_TTL_MS,
        );
        session.runtime_mode_ceiling = (access != "read-only").then(|| access.to_owned());
        session.peer_link = peer_link;
        let issued = IssuedSession {
            token: token.clone(),
            principal: principal_of(&session),
            client: session.client.clone(),
        };
        self.write(|state| {
            let id = session.id.clone();
            state.sessions.insert(hash(&token), session.clone());
            vec![AccessChange::ClientUpserted(id)]
        })?;
        Ok(issued)
    }

    /// The MCP client behind a bearer token (`authenticateMcpClient`), or `None` for any other
    /// session.
    pub fn authenticate_mcp_client(&self, token: &str) -> Option<McpClientSession> {
        let now = now_ms();
        let mut state = self.lock();
        self.refresh(&mut state);
        let session = state
            .sessions
            .get(&hash(token))
            .filter(|s| s.expires_at_ms > now && s.subject == SUBJECT_MCP_CLIENT)?;
        let access = if session.scopes.iter().any(|s| s == "orchestration:operate") {
            session
                .runtime_mode_ceiling
                .clone()
                .unwrap_or_else(|| "approval-required".to_owned())
        } else {
            "read-only".to_owned()
        };
        Some(McpClientSession {
            session_id: session.id.clone(),
            label: session
                .client
                .label
                .clone()
                .unwrap_or_else(|| "MCP client".to_owned()),
            access,
            peer_link: session.peer_link,
        })
    }

    /// The session behind a bearer token on the native HTTP and WebSocket paths. An MCP client
    /// session is refused here: it is only accepted by `/mcp` (`rejectMcpClientAudience`).
    pub fn authenticate_bearer(&self, token: &str) -> Option<Principal> {
        let now = now_ms();
        let mut state = self.lock();
        self.refresh(&mut state);
        state
            .sessions
            .get(&hash(token))
            .filter(|s| s.expires_at_ms > now && native_audience(s))
            .map(principal_of)
    }

    /// A short-lived ticket for a WebSocket upgrade, which cannot carry headers.
    pub fn issue_ticket(
        &self,
        bearer_token: &str,
        audience: Option<&str>,
    ) -> Option<(String, u64)> {
        let now = now_ms();
        let mut state = self.lock();
        self.refresh(&mut state);
        state.tickets.retain(|_, t| t.expires_at_ms > now);
        let session = hash(bearer_token);
        state
            .sessions
            .get(&session)
            .filter(|s| s.expires_at_ms > now && native_audience(s))?;
        let ticket = random_hex(32);
        let expires_at_ms = expires_at(now, TICKET_TTL_MS);
        state.tickets.insert(
            hash(&ticket),
            Ticket {
                session,
                audience: audience.map(str::to_owned),
                expires_at_ms,
            },
        );
        Some((ticket, expires_at_ms))
    }

    /// The session behind a ticket. A ticket minted for one route (`rpc`, `media`) is
    /// refused on another; an unbound ticket from the bare path works on both.
    pub fn authenticate_ticket(&self, ticket: &str, route: &str) -> Option<Principal> {
        let now = now_ms();
        let mut state = self.lock();
        self.refresh(&mut state);
        let ticket = state
            .tickets
            .get(&hash(ticket))
            .filter(|t| t.expires_at_ms > now)?;
        if ticket.audience.as_deref().is_some_and(|aud| aud != route) {
            return None;
        }
        state
            .sessions
            .get(&ticket.session)
            .filter(|s| s.expires_at_ms > now && native_audience(s))
            .map(principal_of)
    }

    /// Whether a session is still live. Open sockets close when this turns false.
    pub fn session_active(&self, session_id: &str) -> bool {
        let now = now_ms();
        let mut state = self.lock();
        self.refresh(&mut state);
        state
            .session_by_id(session_id)
            .is_some_and(|(_, s)| s.expires_at_ms > now)
    }

    /// Unspent, unexpired pairing links, oldest first. Purpose-bound codes are not listed
    /// (`EnvironmentAuth.listPairingLinks`).
    pub fn pairing_links(&self) -> Vec<AuthPairingLink> {
        let mut state = self.lock();
        self.refresh(&mut state);
        let mut links: Vec<&StoredPairing> = state
            .pairing
            .values()
            .filter(|l| !l.purpose_bound())
            .collect();
        links.sort_by_key(|l| (l.created_at_ms, l.id.clone()));
        links.into_iter().map(pairing_to_contract).collect()
    }

    pub fn pairing_link(&self, id: &str) -> Option<AuthPairingLink> {
        let mut state = self.lock();
        self.refresh(&mut state);
        state
            .pairing
            .values()
            .find(|l| l.id == id && !l.purpose_bound())
            .map(pairing_to_contract)
    }

    /// Live client sessions, newest first. `current` marks the caller's own.
    pub fn client_sessions(&self, current: Option<&str>) -> Vec<AuthClientSession> {
        let mut state = self.lock();
        self.refresh(&mut state);
        let mut sessions: Vec<&StoredSession> = state.sessions.values().collect();
        sessions.sort_by_key(|s| (std::cmp::Reverse(s.issued_at_ms), s.id.clone()));
        sessions
            .into_iter()
            .map(|s| session_to_contract(s, &state, current))
            .collect()
    }

    pub fn client_session(&self, id: &str, current: Option<&str>) -> Option<AuthClientSession> {
        let mut state = self.lock();
        self.refresh(&mut state);
        state
            .session_by_id(id)
            .map(|(_, s)| session_to_contract(s, &state, current))
    }

    pub fn revoke_pairing_link(&self, id: &str) -> io::Result<bool> {
        let mut revoked = false;
        self.write(|state| {
            let before = state.pairing.len();
            state.pairing.retain(|_, l| l.id != id);
            revoked = state.pairing.len() != before;
            if revoked {
                vec![AccessChange::PairingLinkRemoved(id.to_owned())]
            } else {
                Vec::new()
            }
        })?;
        Ok(revoked)
    }

    /// Revokes one session. A client may not revoke its own (`current`).
    pub fn revoke_session(
        &self,
        current: Option<&str>,
        id: &str,
    ) -> io::Result<Result<bool, RevokeCurrentSession>> {
        if current == Some(id) {
            return Ok(Err(RevokeCurrentSession));
        }
        let mut revoked = false;
        self.write(|state| {
            let before = state.sessions.len();
            state.sessions.retain(|_, s| s.id != id);
            revoked = state.sessions.len() != before;
            if revoked {
                vec![AccessChange::ClientRemoved(id.to_owned())]
            } else {
                Vec::new()
            }
        })?;
        Ok(Ok(revoked))
    }

    /// Revokes every session but `current`. Returns how many.
    pub fn revoke_other_sessions(&self, current: &str) -> io::Result<usize> {
        let mut removed = Vec::new();
        self.write(|state| {
            state.sessions.retain(|_, s| {
                let keep = s.id == current;
                if !keep {
                    removed.push(s.id.clone());
                }
                keep
            });
            removed
                .iter()
                .cloned()
                .map(AccessChange::ClientRemoved)
                .collect()
        })?;
        Ok(removed.len())
    }

    /// Marks a socket of `session_id` open until the guard drops. Records the connect time in
    /// memory only: a socket open touches no file.
    pub fn connect(self: &Arc<Self>, session_id: &str) -> ConnectionGuard {
        let mut state = self.lock();
        *state.connections.entry(session_id.to_owned()).or_default() += 1;
        if state.session_by_id(session_id).is_some() {
            state.last_connected.insert(session_id.to_owned(), now_ms());
        }
        drop(state);
        self.announce(vec![AccessChange::ClientUpserted(session_id.to_owned())]);
        ConnectionGuard {
            store: self.clone(),
            session_id: session_id.to_owned(),
        }
    }

    fn disconnect(&self, session_id: &str) {
        let mut state = self.lock();
        if let Some(count) = state.connections.get_mut(session_id) {
            *count -= 1;
            if *count == 0 {
                state.connections.remove(session_id);
            }
        }
        drop(state);
        let _ = self
            .changes
            .send(AccessChange::ClientUpserted(session_id.to_owned()));
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        crate::lock(&self.state)
    }

    /// Reloads the file when another process changed it, and announces what moved.
    /// Reads the file again when another process changed it. `false` when it could not: the
    /// state in memory may then be stale.
    fn refresh(&self, state: &mut State) -> bool {
        let Some(path) = &self.file else {
            let changes = state.purge(now_ms());
            self.announce(changes);
            return true;
        };
        if stamp(path) == state.stamp {
            let changes = state.purge(now_ms());
            self.announce(changes);
            return true;
        }
        let before_links: Vec<String> = state.pairing.values().map(|l| l.id.clone()).collect();
        let hidden_before: Vec<String> = state
            .pairing
            .values()
            .filter(|l| l.purpose_bound())
            .map(|l| l.id.clone())
            .collect();
        let before_sessions: Vec<StoredSession> = state.sessions.values().cloned().collect();
        if let Err(error) = self.reload(state) {
            eprintln!("conn-server: could not read {}: {error}", path.display());
            return false;
        }
        let mut changes = Vec::new();
        for id in &before_links {
            if !state.pairing.values().any(|l| &l.id == id) {
                changes.push(AccessChange::PairingLinkRemoved(id.clone()));
            }
        }
        // Approval and peer-link codes were never announced, so their end is not either.
        changes.retain(|change| match change {
            AccessChange::PairingLinkRemoved(id) => !hidden_before.contains(id),
            _ => true,
        });
        for link in state.pairing.values() {
            if !before_links.contains(&link.id) && !link.purpose_bound() {
                changes.push(AccessChange::PairingLinkUpserted(link.id.clone()));
            }
        }
        for old in &before_sessions {
            if !state.sessions.values().any(|s| s.id == old.id) {
                changes.push(AccessChange::ClientRemoved(old.id.clone()));
            }
        }
        for session in state.sessions.values() {
            if !before_sessions.contains(session) {
                changes.push(AccessChange::ClientUpserted(session.id.clone()));
            }
        }
        self.announce(changes);
        true
    }

    /// Replaces the persistent part of `state` with the file's content.
    fn reload(&self, state: &mut State) -> io::Result<()> {
        let Some(path) = &self.file else {
            return Ok(());
        };
        let stamp_before = stamp(path);
        let file: AuthFile = match fs::read(path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => AuthFile::default(),
            Err(error) => return Err(error),
        };
        state.sessions.clear();
        state.pairing.clear();
        for session in file.sessions {
            if let Some(hash) = decode_hex(&session.token_hash) {
                state.sessions.insert(hash, session);
            }
        }
        for link in file.pairing_links {
            if let Some(hash) = decode_hex(&link.code_hash) {
                state.pairing.insert(hash, link);
            }
        }
        state.stamp = stamp_before;
        state.purge(now_ms());
        Ok(())
    }

    /// Runs `change` on a copy of fresh state under the cross-process lock, saves it, and
    /// only then keeps it and announces. When the save fails, memory stays as it was.
    fn write(&self, change: impl FnOnce(&mut State) -> Vec<AccessChange>) -> io::Result<()> {
        let _file_lock = match &self.file {
            Some(path) => Some(lock_file(path)?),
            None => None,
        };
        let mut state = self.lock();
        // A write from a stale snapshot could bring back what another process removed.
        if !self.refresh(&mut state) {
            return Err(io::Error::other(
                "could not read the auth file before writing it",
            ));
        }
        let mut next = state.clone();
        let changes = change(&mut next);
        // Saved whenever the stored records changed, announced or not: a spent approval or
        // peer-link code announces nothing but must not come back in another process.
        let changed = !changes.is_empty()
            || next.pairing.len() != state.pairing.len()
            || next.pairing.keys().any(|k| !state.pairing.contains_key(k))
            || next.sessions.len() != state.sessions.len()
            || next
                .sessions
                .keys()
                .any(|k| !state.sessions.contains_key(k));
        if changed && let Some(path) = &self.file {
            let file = AuthFile {
                version: 1,
                sessions: next.sessions.values().cloned().collect(),
                pairing_links: next.pairing.values().cloned().collect(),
            };
            let bytes = serde_json::to_vec_pretty(&file).map_err(io::Error::other)?;
            write_private(path, &bytes)?;
            next.stamp = stamp(path);
        }
        *state = next;
        drop(state);
        self.announce(changes);
        Ok(())
    }

    fn announce(&self, changes: Vec<AccessChange>) {
        for change in changes {
            let _ = self.changes.send(change);
        }
    }
}

/// Keeps a session counted as connected while a socket is open.
pub struct ConnectionGuard {
    store: Arc<AuthStore>,
    session_id: String,
}

impl std::fmt::Debug for ConnectionGuard {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ConnectionGuard").finish_non_exhaustive()
    }
}

impl Drop for ConnectionGuard {
    fn drop(&mut self) {
        self.store.disconnect(&self.session_id);
    }
}

fn new_session(
    subject: String,
    scopes: Vec<String>,
    client: ClientInfo,
    ttl_ms: u64,
) -> (String, StoredSession) {
    let now = now_ms();
    let token = random_hex(32);
    let session = StoredSession {
        id: uuid_v4(),
        token_hash: hex(&hash(&token)),
        subject,
        scopes,
        method: METHOD_BEARER.into(),
        client,
        issued_at_ms: now,
        expires_at_ms: expires_at(now, ttl_ms),
        last_connected_at_ms: None,
        runtime_mode_ceiling: None,
        peer_link: false,
    };
    (token, session)
}

/// The grant, narrowed to the requested scopes it holds.
fn narrow(grant: Vec<String>, requested: Option<&[String]>) -> Vec<String> {
    let Some(requested) = requested else {
        return grant;
    };
    let mut granted: Vec<String> = Vec::new();
    for scope in requested {
        if grant.contains(scope) && !granted.contains(scope) {
            granted.push(scope.clone());
        }
    }
    granted
}

/// The wall clock, which every expiry here reads, as the T3 server's `DateTime.now`. A test
/// moves it forward with [`tests::jump_wall`] to act out a container that was frozen.
fn now_ms() -> u64 {
    let now = conn_support::time::now_ms();
    #[cfg(test)]
    let now = now.saturating_add(tests::WALL_OFFSET_MS.with(std::cell::Cell::get));
    now
}

/// When something made at `now` with `ttl_ms` to live expires. The life is capped at
/// [`MAX_TTL_MS`], so no TTL overflows.
fn expires_at(now: u64, ttl_ms: u64) -> u64 {
    now.saturating_add(ttl_ms.min(MAX_TTL_MS))
}

/// Whether a session may use the native HTTP and WebSocket paths: every session but an MCP
/// client's (`rejectMcpClientAudience` in `EnvironmentAuth.ts`).
fn native_audience(session: &StoredSession) -> bool {
    session.subject != SUBJECT_MCP_CLIENT
}

fn principal_of(session: &StoredSession) -> Principal {
    Principal {
        session_id: session.id.clone(),
        subject: session.subject.clone(),
        scopes: session.scopes.clone(),
        expires_at_ms: session.expires_at_ms,
    }
}

fn contract_scopes(scopes: &[&String]) -> Vec<AuthEnvironmentScope> {
    scopes
        .iter()
        .filter_map(|s| from_json(serde_json::Value::String((*s).clone())).ok())
        .collect()
}

/// The full grant. A scope this build does not know is left out, as the client's decode
/// would drop it anyway.
fn permissions(scopes: &[String]) -> Option<Vec<Option<AuthEnvironmentScope>>> {
    Some(
        scopes
            .iter()
            .filter_map(|s| from_json(serde_json::Value::String(s.clone())).ok())
            .map(Some)
            .collect(),
    )
}

fn pairing_to_contract(link: &StoredPairing) -> AuthPairingLink {
    AuthPairingLink {
        id: link.id.clone(),
        scopes: contract_scopes(&legacy_scopes(&link.scopes)),
        permissions: permissions(&link.scopes),
        subject: link.subject.clone(),
        label: link.label.clone(),
        created_at: iso_from_ms(link.created_at_ms),
        expires_at: iso_from_ms(link.expires_at_ms),
        // Only a T3 Connect device's request makes a link with one; this server refuses
        // DPoP, so it serves no T3 Connect device.
        connect_device_request: None,
    }
}

fn session_to_contract(
    session: &StoredSession,
    state: &State,
    current: Option<&str>,
) -> AuthClientSession {
    let last_connected_at_ms = state
        .last_connected
        .get(&session.id)
        .copied()
        .max(session.last_connected_at_ms);
    AuthClientSession {
        session_id: session.id.clone(),
        subject: session.subject.clone(),
        scopes: contract_scopes(&legacy_scopes(&session.scopes)),
        permissions: permissions(&session.scopes),
        method: from_json(serde_json::Value::String(session.method.clone()))
            .unwrap_or(conn_contract::ServerAuthSessionMethod::BearerAccessToken),
        client: session.client.to_contract(),
        issued_at: iso_from_ms(session.issued_at_ms),
        expires_at: iso_from_ms(session.expires_at_ms),
        last_connected_at: last_connected_at_ms.map(iso_from_ms),
        connected: state.connections.get(&session.id).is_some_and(|n| *n > 0),
        current: current == Some(session.id.as_str()),
    }
}

/// The file's size and modification time, or `None` when it does not exist.
fn stamp(path: &Path) -> Option<Stamp> {
    let meta = fs::metadata(path).ok()?;
    Some((meta.len(), meta.modified().ok()?))
}

/// Holds `<file>.lock` exclusively until dropped, so the server and the CLI never write over
/// each other's change.
fn lock_file(path: &Path) -> io::Result<fs::File> {
    let lock = path.with_extension("lock");
    if let Some(dir) = lock.parent() {
        fs::create_dir_all(dir)?;
    }
    let file = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(lock)?;
    file.lock()?;
    Ok(file)
}

fn hash(secret: &str) -> Hash {
    Sha256::digest(secret.as_bytes()).into()
}

fn random_bytes<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    getrandom::fill(&mut bytes).expect("the OS random source is available");
    bytes
}

/// `bytes` random bytes as lowercase hex.
pub fn random_hex(bytes: usize) -> String {
    let mut out = Vec::with_capacity(bytes);
    while out.len() < bytes {
        out.extend_from_slice(&random_bytes::<32>());
    }
    out.truncate(bytes);
    hex(&out)
}

/// A pairing code as `PairingGrantStore` makes them: rejection-sampled, no modulo bias.
fn pairing_code() -> String {
    let limit = 256 / PAIRING_CODE_ALPHABET.len() * PAIRING_CODE_ALPHABET.len();
    let mut code = String::with_capacity(PAIRING_CODE_LENGTH);
    while code.len() < PAIRING_CODE_LENGTH {
        for byte in random_bytes::<16>() {
            if usize::from(byte) < limit && code.len() < PAIRING_CODE_LENGTH {
                code.push(
                    PAIRING_CODE_ALPHABET[byte as usize % PAIRING_CODE_ALPHABET.len()] as char,
                );
            }
        }
    }
    code
}

fn decode_hex(text: &str) -> Option<Hash> {
    let mut out = [0u8; 32];
    if text.len() != 64 {
        return None;
    }
    for (i, pair) in text.as_bytes().chunks(2).enumerate() {
        let pair = std::str::from_utf8(pair).ok()?;
        out[i] = u8::from_str_radix(pair, 16).ok()?;
    }
    Some(out)
}

/// Parses a TTL as the TypeScript CLI takes it: `90s`, `5m`, `1h`, `30d`, `15 minutes`.
pub fn parse_ttl_ms(text: &str) -> Option<u64> {
    let text = text.trim();
    let split = text
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(text.len());
    let (number, unit) = text.split_at(split);
    let number: u64 = number.parse().ok()?;
    let unit_ms = match unit.trim() {
        "" | "s" | "sec" | "secs" | "second" | "seconds" => 1000,
        "m" | "min" | "mins" | "minute" | "minutes" => MINUTE_MS,
        "h" | "hr" | "hrs" | "hour" | "hours" => 60 * MINUTE_MS,
        "d" | "day" | "days" => 24 * 60 * MINUTE_MS,
        "w" | "week" | "weeks" => 7 * 24 * 60 * MINUTE_MS,
        _ => return None,
    };
    number.checked_mul(unit_ms).filter(|ms| *ms > 0)
}

/// Splits `a,b c` into scopes and checks each is a grant scope.
pub fn parse_scopes(text: &str) -> Result<Vec<String>, String> {
    let mut scopes: Vec<String> = Vec::new();
    for scope in text.split([',', ' ']).filter(|s| !s.is_empty()) {
        if !is_grant_scope(scope) {
            return Err(format!("unknown scope `{scope}`"));
        }
        if !scopes.iter().any(|s| s == scope) {
            scopes.push(scope.to_owned());
        }
    }
    if scopes.is_empty() {
        return Err("no scopes".into());
    }
    Ok(scopes)
}

#[cfg(test)]
mod tests {
    use super::*;

    thread_local! {
        /// How far this test thread's wall clock is ahead of the system's.
        pub(super) static WALL_OFFSET_MS: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
    }

    pub(super) fn jump_wall(by_ms: u64) {
        WALL_OFFSET_MS.with(|offset| offset.set(offset.get() + by_ms));
    }

    /// `rejectMcpClientAudience`: an MCP OAuth token works on `/mcp` only, never as a native
    /// bearer, for a WebSocket ticket, or behind a ticket minted before.
    #[test]
    fn mcp_client_sessions_are_refused_outside_mcp() {
        let store = AuthStore::in_memory();
        let issued = store
            .issue_mcp_client_session("T3 Code · peer", "full-access", true, ClientInfo::default())
            .unwrap();
        assert!(
            store.authenticate_mcp_client(&issued.token).is_some(),
            "/mcp takes it"
        );
        assert!(
            store.authenticate_bearer(&issued.token).is_none(),
            "a native bearer path refuses it"
        );
        assert!(
            store.issue_ticket(&issued.token, Some("rpc")).is_none(),
            "no WebSocket ticket for it"
        );
        // A ticket that names the session (as one minted before this check) is refused too.
        let ticket = "fixture-ticket";
        {
            let mut state = store.lock();
            state.tickets.insert(
                hash(ticket),
                Ticket {
                    session: hash(&issued.token),
                    audience: None,
                    expires_at_ms: now_ms() + 60_000,
                },
            );
        }
        assert!(store.authenticate_ticket(ticket, "rpc").is_none());
    }

    /// Orbit freezes a container and its wall clock jumps on wake. Every expiry here reads
    /// the wall clock, as T3's `PairingGrantStore.ts` and `SessionStore.ts` read
    /// `DateTime.now`: a 5-minute pairing code and WebSocket ticket are gone after 10
    /// minutes, a 30-day session lives through 3 days and ends after 30.
    #[test]
    fn expiries_follow_the_wall_clock_after_a_freeze() {
        const MIN: u64 = MINUTE_MS;
        let store = AuthStore::in_memory();
        let session = store
            .issue_session(SessionRequest {
                scopes: vec!["access:read".into()],
                label: None,
                subject: None,
                ttl_ms: SESSION_TTL_MS,
            })
            .unwrap();
        let id = session.principal.session_id.clone();
        let fresh_code = |ttl| store.issue_pairing_code(None, ttl).unwrap().code;
        let pairing = |code: &str| store.exchange(code, None, ClientInfo::bot(None)).is_ok();
        let ticket = || store.issue_ticket(&session.token, Some("rpc")).unwrap().0;

        let code = fresh_code(PAIRING_CODE_TTL_MS);
        let startup_code = fresh_code(STARTUP_PAIRING_CODE_TTL_MS);
        let rpc_ticket = ticket();
        assert!(
            pairing(&fresh_code(PAIRING_CODE_TTL_MS)),
            "a fresh code pairs"
        );
        assert!(store.authenticate_ticket(&ticket(), "rpc").is_some());
        jump_wall(10 * MIN);
        assert!(!pairing(&code), "a 5-minute code after 10 minutes");
        assert!(store.authenticate_ticket(&rpc_ticket, "rpc").is_none());
        assert!(store.authenticate_bearer(&session.token).is_some());
        assert!(store.session_active(&id));

        let code = fresh_code(PAIRING_CODE_TTL_MS);
        jump_wall(2 * 60 * MIN);
        assert!(!pairing(&code), "a 5-minute code after 2 hours");
        assert!(store.session_active(&id), "a 30-day session after 2 hours");

        let rpc_ticket = ticket();
        jump_wall(3 * 24 * 60 * MIN);
        assert!(!pairing(&startup_code), "a 24-hour code after 3 days");
        assert!(store.authenticate_ticket(&rpc_ticket, "rpc").is_none());
        assert!(store.authenticate_bearer(&session.token).is_some());
        assert!(store.session_active(&id), "a 30-day session after 3 days");

        jump_wall(27 * 24 * 60 * MIN);
        assert!(store.authenticate_bearer(&session.token).is_none());
        assert!(!store.session_active(&id), "the session ends at 30 days");
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("conn-server-{name}-{}", random_hex(6)));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn parses_ttls_and_scopes_like_the_cli() {
        assert_eq!(parse_ttl_ms("5m"), Some(5 * MINUTE_MS));
        assert_eq!(parse_ttl_ms("15 minutes"), Some(15 * MINUTE_MS));
        assert_eq!(parse_ttl_ms("1h"), Some(60 * MINUTE_MS));
        assert_eq!(parse_ttl_ms("30d"), Some(30 * 24 * 60 * MINUTE_MS));
        assert_eq!(parse_ttl_ms("90s"), Some(90_000));
        assert_eq!(parse_ttl_ms("soon"), None);
        assert_eq!(parse_ttl_ms("0m"), None);
        assert_eq!(
            parse_scopes("access:read,access:write access:read").unwrap(),
            vec!["access:read", "access:write"]
        );
        assert!(parse_scopes("review:write").is_err());
        assert!(parse_scopes("").is_err());
    }

    /// A peer-link code is purpose-bound: it is never announced as a pairing link nor listed,
    /// here or in another process that reads the file (`PairingGrantStore.issue`,
    /// `EnvironmentAuth.listPairingLinks`).
    #[test]
    fn peer_link_codes_stay_out_of_pairing_links_and_events() {
        let dir = temp_dir("auth-peer-link-hidden");
        let file = dir.join("auth.json");
        let store = AuthStore::open(file.clone()).unwrap();
        let other = AuthStore::open(file).unwrap();
        let mut events = store.subscribe();
        let mut other_events = other.subscribe();
        let issued = store.issue_peer_link_pairing("auto", None).unwrap();
        assert!(events.try_recv().is_err(), "an upsert was announced");
        assert!(store.pairing_links().is_empty());
        assert!(store.pairing_link(&issued.id).is_none());
        assert!(other.pairing_links().is_empty());
        assert!(other.pairing_link(&issued.id).is_none());
        assert!(
            other_events.try_recv().is_err(),
            "a reload announced the code"
        );
        // A plain code is still listed and announced.
        let plain = store.issue_pairing_code(None, PAIRING_CODE_TTL_MS).unwrap();
        assert!(matches!(
            events.try_recv(),
            Ok(AccessChange::PairingLinkUpserted(id)) if id == plain.id
        ));
        assert_eq!(store.pairing_links().len(), 1);
        // Spending the peer-link code announces nothing either, here or on a reload
        // (`consumeAvailable` skips approval subjects; Codex finding 4 of #151).
        let _ = other_events.try_recv();
        assert_eq!(
            store
                .consume_mcp_code(&issued.code, "auto", true)
                .ok()
                .as_deref(),
            Some("auto")
        );
        assert!(events.try_recv().is_err(), "the spent code was announced");
        // Spent means spent in a process that opens the file afresh too.
        let reopened = AuthStore::open(dir.join("auth.json")).unwrap();
        assert!(
            reopened
                .consume_mcp_code(&issued.code, "auto", true)
                .is_err(),
            "a spent peer-link code came back from the file"
        );
        assert_eq!(other.pairing_links().len(), 1);
        while let Ok(change) = other_events.try_recv() {
            assert!(
                !matches!(&change, AccessChange::PairingLinkRemoved(id) if *id == issued.id),
                "a reload announced the spent code"
            );
        }
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn pairing_codes_are_single_use_and_case_insensitive() {
        let store = AuthStore::in_memory();
        let issued = store.issue_pairing_code(None, PAIRING_CODE_TTL_MS).unwrap();
        assert_eq!(issued.code.len(), PAIRING_CODE_LENGTH);
        assert!(
            issued
                .code
                .bytes()
                .all(|b| PAIRING_CODE_ALPHABET.contains(&b))
        );
        assert_eq!(store.pairing_links().len(), 1);
        let session = store
            .exchange(
                &issued.code.to_ascii_lowercase(),
                None,
                ClientInfo::default(),
            )
            .unwrap();
        assert_eq!(session.principal.scopes.len(), STANDARD_SCOPES.len());
        assert!(store.pairing_links().is_empty());
        assert_eq!(
            store
                .exchange(&issued.code, None, ClientInfo::default())
                .unwrap_err(),
            ExchangeError::InvalidCredential
        );
        assert_eq!(
            store.authenticate_bearer(&session.token),
            Some(session.principal)
        );
        assert_eq!(store.authenticate_bearer("nope"), None);
    }

    #[test]
    fn exchange_narrows_and_checks_scopes() {
        let store = AuthStore::in_memory();
        let code = store
            .issue_pairing_code(None, PAIRING_CODE_TTL_MS)
            .unwrap()
            .code;
        assert_eq!(
            store
                .exchange(&code, Some(&["root".into()]), ClientInfo::default())
                .unwrap_err(),
            ExchangeError::InvalidScope
        );
        // A rejected scope does not spend the code.
        let session = store
            .exchange(
                &code,
                Some(&["orchestration:read".into()]),
                ClientInfo::default(),
            )
            .unwrap();
        assert_eq!(
            session.principal.scopes,
            vec!["orchestration:read".to_owned()]
        );
        let code = store
            .issue_pairing_code(None, PAIRING_CODE_TTL_MS)
            .unwrap()
            .code;
        assert_eq!(
            store
                .exchange(&code, Some(&["review:write".into()]), ClientInfo::default())
                .unwrap_err(),
            ExchangeError::ScopeNotGranted
        );
    }

    #[test]
    fn a_scoped_link_grants_only_its_scopes_and_keeps_its_label() {
        let store = AuthStore::in_memory();
        let scopes: Vec<String> = ["relay:read", "access:read", "access:write", "relay:write"]
            .map(str::to_owned)
            .into();
        let issued = store
            .issue_pairing(PairingRequest {
                scopes: scopes.clone(),
                label: Some("node via Orbit".into()),
                ttl_ms: PAIRING_CODE_TTL_MS,
            })
            .unwrap();
        let link = &store.pairing_links()[0];
        assert_eq!(link.label.as_deref(), Some("node via Orbit"));
        assert_eq!(link.permissions.as_ref().unwrap().len(), 4);
        let session = store
            .exchange(&issued.code, None, ClientInfo::default())
            .unwrap();
        assert_eq!(session.principal.scopes, scopes);
        assert_eq!(session.client.label.as_deref(), Some("node via Orbit"));
    }

    #[test]
    fn expired_codes_are_refused() {
        let store = AuthStore::in_memory();
        let code = store.issue_pairing_code(None, 0).unwrap().code;
        assert_eq!(
            store
                .exchange(&code, None, ClientInfo::default())
                .unwrap_err(),
            ExchangeError::InvalidCredential
        );
    }

    #[test]
    fn tickets_are_bound_to_their_route_and_session() {
        let store = AuthStore::in_memory();
        let code = store
            .issue_pairing_code(None, PAIRING_CODE_TTL_MS)
            .unwrap()
            .code;
        let session = store.exchange(&code, None, ClientInfo::default()).unwrap();
        assert!(store.issue_ticket("not-a-token", Some("rpc")).is_none());
        let (rpc, _) = store.issue_ticket(&session.token, Some("rpc")).unwrap();
        assert_eq!(
            store.authenticate_ticket(&rpc, "rpc"),
            Some(session.principal.clone())
        );
        assert_eq!(store.authenticate_ticket(&rpc, "media"), None);
        let (any, _) = store.issue_ticket(&session.token, None).unwrap();
        assert!(store.authenticate_ticket(&any, "media").is_some());
        // The bearer token itself is not a ticket.
        assert_eq!(store.authenticate_ticket(&session.token, "rpc"), None);
    }

    #[test]
    fn revocation_ends_the_session_and_its_tickets_and_announces_it() {
        let store = AuthStore::in_memory();
        let mut changes = store.subscribe();
        let me = store
            .exchange(
                &store
                    .issue_pairing_code(None, PAIRING_CODE_TTL_MS)
                    .unwrap()
                    .code,
                None,
                ClientInfo::default(),
            )
            .unwrap();
        let other = store
            .exchange(
                &store
                    .issue_pairing_code(None, PAIRING_CODE_TTL_MS)
                    .unwrap()
                    .code,
                None,
                ClientInfo::default(),
            )
            .unwrap();
        let (ticket, _) = store.issue_ticket(&other.token, Some("rpc")).unwrap();
        let me_id = me.principal.session_id.as_str();
        assert_eq!(
            store.revoke_session(Some(me_id), me_id).unwrap(),
            Err(RevokeCurrentSession)
        );
        let sessions = store.client_sessions(Some(me_id));
        assert_eq!(sessions.len(), 2);
        assert!(sessions.iter().any(|s| s.current));
        let other_id = other.principal.session_id.clone();
        assert_eq!(
            store.revoke_session(Some(me_id), &other_id).unwrap(),
            Ok(true)
        );
        assert_eq!(
            store.revoke_session(Some(me_id), &other_id).unwrap(),
            Ok(false)
        );
        assert_eq!(store.authenticate_bearer(&other.token), None);
        assert_eq!(store.authenticate_ticket(&ticket, "rpc"), None);
        assert!(!store.session_active(&other_id));
        let mut seen = Vec::new();
        while let Ok(change) = changes.try_recv() {
            seen.push(change);
        }
        assert!(seen.contains(&AccessChange::ClientRemoved(other_id)));
        assert_eq!(store.revoke_other_sessions(me_id).unwrap(), 0);
    }

    #[test]
    fn connections_mark_a_session_connected_until_the_socket_closes() {
        let store = AuthStore::in_memory();
        let session = store
            .exchange(
                &store
                    .issue_pairing_code(None, PAIRING_CODE_TTL_MS)
                    .unwrap()
                    .code,
                None,
                ClientInfo::default(),
            )
            .unwrap();
        let id = session.principal.session_id;
        let guard = store.connect(&id);
        let listed = store.client_session(&id, None).unwrap();
        assert!(listed.connected);
        assert!(listed.last_connected_at.is_some());
        drop(guard);
        assert!(!store.client_session(&id, None).unwrap().connected);
    }

    /// Opening a socket touches no file: the connect time lives in memory.
    #[test]
    fn connecting_does_not_write_the_file() {
        let dir = temp_dir("auth-connect");
        let file = dir.join("auth.json");
        let store = AuthStore::open(file.clone()).unwrap();
        let session = store
            .exchange(
                &store
                    .issue_pairing_code(None, PAIRING_CODE_TTL_MS)
                    .unwrap()
                    .code,
                None,
                ClientInfo::default(),
            )
            .unwrap();
        let saved = fs::read_to_string(&file).unwrap();
        let id = session.principal.session_id;
        let mut changes = store.subscribe();
        let guard = store.connect(&id);
        assert_eq!(fs::read_to_string(&file).unwrap(), saved);
        assert_eq!(
            changes.try_recv().unwrap(),
            AccessChange::ClientUpserted(id.clone())
        );
        let listed = store.client_session(&id, None).unwrap();
        assert!(listed.connected);
        assert!(listed.last_connected_at.is_some());
        // Another process's write does not lose it.
        let cli = AuthStore::open(file).unwrap();
        cli.issue_pairing_code(None, PAIRING_CODE_TTL_MS).unwrap();
        assert!(
            store
                .client_session(&id, None)
                .unwrap()
                .last_connected_at
                .is_some()
        );
        drop(guard);
        assert!(!store.client_session(&id, None).unwrap().connected);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn state_survives_a_restart_and_only_hashes_are_stored() {
        let dir = temp_dir("auth");
        let file = dir.join("auth.json");
        let store = AuthStore::open(file.clone()).unwrap();
        let code = store
            .issue_pairing_code(None, PAIRING_CODE_TTL_MS)
            .unwrap()
            .code;
        let session = store.exchange(&code, None, ClientInfo::default()).unwrap();
        let link = store
            .issue_pairing_code(Some("later".into()), PAIRING_CODE_TTL_MS)
            .unwrap();
        let saved = fs::read_to_string(&file).unwrap();
        assert!(!saved.contains(&session.token));
        assert!(!saved.contains(&link.code));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&file).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        let reopened = AuthStore::open(file).unwrap();
        assert_eq!(
            reopened.authenticate_bearer(&session.token),
            Some(session.principal)
        );
        assert_eq!(reopened.pairing_links().len(), 1);
        fs::remove_dir_all(dir).unwrap();
    }

    /// A write that fails leaves memory as it was: the code stays unspent, no session appears
    /// that nobody holds, and the caller learns it was a storage failure.
    #[cfg(unix)]
    #[test]
    fn a_failed_write_changes_nothing() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir("auth-readonly");
        let file = dir.join("auth.json");
        let store = AuthStore::open(file.clone()).unwrap();
        let code = store
            .issue_pairing_code(None, PAIRING_CODE_TTL_MS)
            .unwrap()
            .code;
        let saved = fs::read(&file).unwrap();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o500)).unwrap();
        let failed = store.exchange(&code, None, ClientInfo::default());
        let sessions_while_failed = store.client_sessions(None).len();
        let links_while_failed = store.pairing_links().len();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(failed.unwrap_err(), ExchangeError::Storage);
        assert_eq!((sessions_while_failed, links_while_failed), (0, 1));
        assert_eq!(fs::read(&file).unwrap(), saved);
        // The next write saves only what it made; the code still works once.
        let session = store.exchange(&code, None, ClientInfo::default()).unwrap();
        let reopened = AuthStore::open(file).unwrap();
        assert_eq!(reopened.client_sessions(None).len(), 1);
        assert!(reopened.authenticate_bearer(&session.token).is_some());
        assert!(reopened.pairing_links().is_empty());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn another_process_writes_are_seen_and_announced() {
        let dir = temp_dir("auth-shared");
        let file = dir.join("auth.json");
        let server = AuthStore::open(file.clone()).unwrap();
        let mut changes = server.subscribe();
        // What `auth session issue` does in its own process while the server runs.
        let cli = AuthStore::open(file).unwrap();
        let issued = cli
            .issue_session(SessionRequest {
                scopes: vec!["access:read".into(), "access:write".into()],
                label: Some("Orbit Gateway".into()),
                subject: None,
                ttl_ms: SESSION_TTL_MS,
            })
            .unwrap();
        let principal = server.authenticate_bearer(&issued.token).unwrap();
        assert_eq!(principal.subject, SUBJECT_CLI_SESSION);
        assert_eq!(
            changes.try_recv().unwrap(),
            AccessChange::ClientUpserted(principal.session_id.clone())
        );
        let listed = server.client_session(&principal.session_id, None).unwrap();
        assert_eq!(listed.client.label.as_deref(), Some("Orbit Gateway"));
        // The server's own write keeps the CLI's session.
        server
            .issue_pairing_code(None, PAIRING_CODE_TTL_MS)
            .unwrap();
        assert!(cli.authenticate_bearer(&issued.token).is_some());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_desktop_credential_is_reusable_and_rotates_with_its_secret() {
        let store = AuthStore::in_memory();
        assert!(
            store
                .exchange("desktop-token", None, ClientInfo::default())
                .is_err()
        );
        store.set_desktop_bootstrap(DesktopBootstrap::new("desktop-token".into(), None, false));
        assert_eq!(store.descriptor()["policy"], "desktop-managed-local");
        for _ in 0..2 {
            let session = store
                .exchange("desktop-token", None, ClientInfo::default())
                .unwrap();
            assert_eq!(session.principal.subject, SUBJECT_DESKTOP_BOOTSTRAP);
        }
        store.set_desktop_bootstrap(DesktopBootstrap::new(
            "ignored".into(),
            Some("s3cret".into()),
            true,
        ));
        assert_eq!(
            store.descriptor()["bootstrapMethods"],
            serde_json::json!(["desktop-bootstrap", "one-time-token"])
        );
        let window = now_ms() / DESKTOP_TOKEN_WINDOW_MS;
        assert!(
            store
                .exchange(
                    &desktop_token("s3cret", window),
                    None,
                    ClientInfo::default()
                )
                .is_ok()
        );
        assert!(
            store
                .exchange(
                    &desktop_token("s3cret", window - 1),
                    None,
                    ClientInfo::default()
                )
                .is_ok()
        );
        assert!(
            store
                .exchange(
                    &desktop_token("s3cret", window - 2),
                    None,
                    ClientInfo::default()
                )
                .is_err()
        );
        assert!(
            store
                .exchange("ignored", None, ClientInfo::default())
                .is_err()
        );
    }

    /// `replaceActiveForSubjectAndMethod`: each desktop exchange replaces the desktop's
    /// earlier session, so they do not pile up. Other sessions stay.
    #[test]
    fn a_desktop_exchange_replaces_the_earlier_desktop_session() {
        let store = AuthStore::in_memory();
        store.set_desktop_bootstrap(DesktopBootstrap::new("desktop-token".into(), None, false));
        let other = store
            .issue_session(SessionRequest {
                scopes: vec!["access:read".into()],
                label: None,
                subject: None,
                ttl_ms: SESSION_TTL_MS,
            })
            .unwrap();
        let first = store
            .exchange("desktop-token", None, ClientInfo::default())
            .unwrap();
        let mut changes = store.subscribe();
        let second = store
            .exchange("desktop-token", None, ClientInfo::default())
            .unwrap();
        assert_eq!(store.authenticate_bearer(&first.token), None);
        assert!(store.authenticate_bearer(&second.token).is_some());
        assert!(store.authenticate_bearer(&other.token).is_some());
        assert_eq!(store.client_sessions(None).len(), 2);
        let mut seen = Vec::new();
        while let Ok(change) = changes.try_recv() {
            seen.push(change);
        }
        assert!(seen.contains(&AccessChange::ClientRemoved(first.principal.session_id)));
    }

    /// A scope this build does not know (a newer CLI wrote it) is left out of `permissions`,
    /// never sent as `null`.
    #[test]
    fn unknown_scopes_are_left_out_of_permissions() {
        let store = AuthStore::in_memory();
        let issued = store
            .issue_session(SessionRequest {
                scopes: vec!["orchestration:read".into(), "future:scope".into()],
                label: None,
                subject: None,
                ttl_ms: SESSION_TTL_MS,
            })
            .unwrap();
        let listed = store
            .client_session(&issued.principal.session_id, None)
            .unwrap();
        let json = serde_json::to_value(&listed).unwrap();
        assert_eq!(
            json["permissions"],
            serde_json::json!(["orchestration:read"])
        );
    }

    /// No TTL can overflow an expiry; the CLI takes any number.
    #[test]
    fn huge_ttls_saturate_to_the_cap() {
        let store = AuthStore::in_memory();
        let issued = store
            .issue_session(SessionRequest {
                scopes: vec!["orchestration:read".into()],
                label: None,
                subject: None,
                ttl_ms: u64::MAX,
            })
            .unwrap();
        assert!(store.authenticate_bearer(&issued.token).is_some());
        assert!(issued.principal.expires_at_ms <= now_ms() + MAX_TTL_MS);
        let code = store.issue_pairing_code(None, u64::MAX).unwrap();
        assert!(code.expires_at_ms > now_ms());
    }

    #[test]
    fn user_agents_describe_the_client() {
        let info = ClientInfo::from_request(
            Some("Phone".into()),
            None,
            None,
            Some(
                "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148 Safari/604.1",
            ),
            Some("10.0.0.2".into()),
        );
        assert_eq!(info.device_type, "mobile");
        assert_eq!(info.os.as_deref(), Some("iOS"));
        assert_eq!(info.browser.as_deref(), Some("Safari"));
        let contract = info.to_contract();
        assert_eq!(contract.ip_address.as_deref(), Some("10.0.0.2"));
    }
}
