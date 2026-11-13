//! Pairing codes, bearer sessions and WebSocket tickets, as Conn clients use them for a
//! direct (non-relay) environment. Reference: `apps/server/src/auth/EnvironmentAuth.ts`,
//! `PairingGrantStore.ts`, `SessionStore.ts`.
//!
//! Every credential is a random secret the client holds; the store keeps only its SHA-256
//! hash. Sessions persist in one 0600 JSON file so a restart keeps devices paired. Pairing
//! codes and tickets are short-lived and live in memory only.

use std::{
    collections::HashMap,
    fs,
    io::{self, Write},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

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

/// `ServerAuthDescriptor`: pairing by one-time code, then bearer tokens. No browser cookie
/// sessions and no DPoP (T3 Connect relay).
pub fn descriptor() -> serde_json::Value {
    serde_json::json!({
        "policy": "remote-reachable",
        "bootstrapMethods": ["one-time-token"],
        "sessionMethods": ["bearer-access-token"],
        "sessionCookieName": "conn_session",
        "serverUpdateScope": "environment:maintain",
    })
}

/// `authScopeResponse`: legacy `scopes` plus the full grant as `permissions`.
pub fn scope_response(scopes: &[String]) -> serde_json::Value {
    let legacy: Vec<&String> = scopes
        .iter()
        .filter(|s| LEGACY_SCOPES.contains(&s.as_str()))
        .collect();
    serde_json::json!({ "scopes": legacy, "permissions": scopes })
}

#[derive(Debug)]
pub struct IssuedPairingCode {
    pub id: String,
    pub code: String,
    pub label: Option<String>,
    pub expires_at_ms: u64,
}

#[derive(Debug)]
pub struct IssuedSession {
    pub token: String,
    pub principal: Principal,
}

#[derive(Debug, PartialEq, Eq)]
pub enum ExchangeError {
    /// Unknown, spent, or expired code.
    InvalidCredential,
    /// The request named a scope that does not exist.
    InvalidScope,
    /// None of the requested scopes is in the grant.
    ScopeNotGranted,
}

struct PairingGrant {
    scopes: Vec<String>,
    label: Option<String>,
    expires_at_ms: u64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredSession {
    id: String,
    token_hash: String,
    subject: String,
    scopes: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    label: Option<String>,
    issued_at_ms: u64,
    expires_at_ms: u64,
}

struct Ticket {
    session: Hash,
    audience: Option<String>,
    expires_at_ms: u64,
}

#[derive(Default)]
struct State {
    pairing: HashMap<Hash, PairingGrant>,
    sessions: HashMap<Hash, StoredSession>,
    tickets: HashMap<Hash, Ticket>,
}

impl State {
    fn purge(&mut self, now: u64) {
        self.pairing.retain(|_, grant| grant.expires_at_ms > now);
        self.sessions
            .retain(|_, session| session.expires_at_ms > now);
        self.tickets.retain(|_, ticket| ticket.expires_at_ms > now);
    }
}

pub struct AuthStore {
    state: Mutex<State>,
    /// Where sessions persist; `None` keeps them in memory (tests).
    sessions_file: Option<PathBuf>,
}

impl AuthStore {
    pub fn in_memory() -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::default(),
            sessions_file: None,
        })
    }

    /// Loads the sessions saved in `sessions_file`, if it exists.
    pub fn open(sessions_file: PathBuf) -> io::Result<Arc<Self>> {
        let mut state = State::default();
        match fs::read(&sessions_file) {
            Ok(bytes) => {
                let stored: Vec<StoredSession> = serde_json::from_slice(&bytes)
                    .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
                for session in stored {
                    if let Some(hash) = decode_hex(&session.token_hash) {
                        state.sessions.insert(hash, session);
                    }
                }
                state.purge(now_ms());
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        Ok(Arc::new(Self {
            state: Mutex::new(state),
            sessions_file: Some(sessions_file),
        }))
    }

    /// A one-time pairing code with the standard client scopes.
    pub fn issue_pairing_code(&self, label: Option<String>, ttl_ms: u64) -> IssuedPairingCode {
        let code = pairing_code();
        let id = random_hex(16);
        let expires_at_ms = now_ms() + ttl_ms;
        let grant = PairingGrant {
            scopes: STANDARD_SCOPES.iter().map(|s| s.to_string()).collect(),
            label: label.clone(),
            expires_at_ms,
        };
        self.lock().pairing.insert(hash(&code), grant);
        IssuedPairingCode {
            id,
            code,
            label,
            expires_at_ms,
        }
    }

    /// Spends a pairing code for a bearer session. `requested` narrows the grant.
    pub fn exchange(
        &self,
        code: &str,
        requested: Option<&[String]>,
        client_label: Option<String>,
    ) -> Result<IssuedSession, ExchangeError> {
        if let Some(requested) = requested
            && requested
                .iter()
                .any(|s| !STANDARD_SCOPES.contains(&s.as_str()) && s != "review:write")
        {
            return Err(ExchangeError::InvalidScope);
        }
        let now = now_ms();
        let mut state = self.lock();
        state.purge(now);
        // Codes are case-insensitive, as `PAIRING_TOKEN_PATTERN` is.
        let key = hash(&code.trim().to_ascii_uppercase());
        let grant = state
            .pairing
            .remove(&key)
            .ok_or(ExchangeError::InvalidCredential)?;
        let scopes: Vec<String> = match requested {
            None => grant.scopes,
            Some(requested) => {
                let mut granted: Vec<String> = Vec::new();
                for scope in requested {
                    if grant.scopes.contains(scope) && !granted.contains(scope) {
                        granted.push(scope.clone());
                    }
                }
                granted
            }
        };
        if scopes.is_empty() {
            return Err(ExchangeError::ScopeNotGranted);
        }
        let token = random_hex(32);
        let session = StoredSession {
            id: random_hex(16),
            token_hash: hex(&hash(&token)),
            subject: "one-time-token".into(),
            scopes,
            label: grant.label.or(client_label),
            issued_at_ms: now,
            expires_at_ms: now + SESSION_TTL_MS,
        };
        let principal = principal_of(&session);
        state.sessions.insert(hash(&token), session);
        self.persist(&state);
        Ok(IssuedSession { token, principal })
    }

    pub fn authenticate_bearer(&self, token: &str) -> Option<Principal> {
        let now = now_ms();
        let state = self.lock();
        state
            .sessions
            .get(&hash(token))
            .filter(|s| s.expires_at_ms > now)
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
        state.purge(now);
        let session = hash(bearer_token);
        state.sessions.get(&session)?;
        let ticket = random_hex(32);
        let expires_at_ms = now + TICKET_TTL_MS;
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
        let state = self.lock();
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
            .filter(|s| s.expires_at_ms > now)
            .map(principal_of)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn persist(&self, state: &State) {
        let Some(path) = &self.sessions_file else {
            return;
        };
        let sessions: Vec<&StoredSession> = state.sessions.values().collect();
        let bytes = serde_json::to_vec(&sessions).expect("sessions serialize");
        if let Err(error) = write_private(path, &bytes) {
            eprintln!(
                "conn-server: could not save sessions to {}: {error}",
                path.display()
            );
        }
    }
}

fn principal_of(session: &StoredSession) -> Principal {
    Principal {
        session_id: session.id.clone(),
        subject: session.subject.clone(),
        scopes: session.scopes.clone(),
        expires_at_ms: session.expires_at_ms,
    }
}

/// Writes through a temp file and a rename, readable by the owner only.
fn write_private(path: &PathBuf, bytes: &[u8]) -> io::Result<()> {
    let tmp = path.with_extension("tmp");
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut file = options.open(&tmp)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    fs::rename(tmp, path)
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
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

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(DIGITS[(byte >> 4) as usize] as char);
        out.push(DIGITS[(byte & 15) as usize] as char);
    }
    out
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

/// RFC 3339 UTC with milliseconds, as `DateTimeUtc` encodes.
pub fn iso8601(ms: u64) -> String {
    let secs = ms / 1000;
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60,
        ms % 1000
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_dates_like_effect() {
        assert_eq!(iso8601(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso8601(1_794_528_000_123), "2026-11-13T00:00:00.123Z");
        assert_eq!(iso8601(951_782_400_000), "2000-02-29T00:00:00.000Z");
    }

    #[test]
    fn pairing_codes_are_single_use_and_case_insensitive() {
        let store = AuthStore::in_memory();
        let issued = store.issue_pairing_code(None, PAIRING_CODE_TTL_MS);
        assert_eq!(issued.code.len(), PAIRING_CODE_LENGTH);
        assert!(
            issued
                .code
                .bytes()
                .all(|b| PAIRING_CODE_ALPHABET.contains(&b))
        );
        let session = store
            .exchange(&issued.code.to_ascii_lowercase(), None, None)
            .unwrap();
        assert_eq!(session.principal.scopes.len(), STANDARD_SCOPES.len());
        assert_eq!(
            store.exchange(&issued.code, None, None).unwrap_err(),
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
        let code = store.issue_pairing_code(None, PAIRING_CODE_TTL_MS).code;
        assert_eq!(
            store
                .exchange(&code, Some(&["root".into()]), None)
                .unwrap_err(),
            ExchangeError::InvalidScope
        );
        // A rejected scope does not spend the code.
        let session = store
            .exchange(&code, Some(&["orchestration:read".into()]), None)
            .unwrap();
        assert_eq!(
            session.principal.scopes,
            vec!["orchestration:read".to_owned()]
        );
        let code = store.issue_pairing_code(None, PAIRING_CODE_TTL_MS).code;
        assert_eq!(
            store
                .exchange(&code, Some(&["review:write".into()]), None)
                .unwrap_err(),
            ExchangeError::ScopeNotGranted
        );
    }

    #[test]
    fn expired_codes_are_refused() {
        let store = AuthStore::in_memory();
        let code = store.issue_pairing_code(None, 0).code;
        assert_eq!(
            store.exchange(&code, None, None).unwrap_err(),
            ExchangeError::InvalidCredential
        );
    }

    #[test]
    fn tickets_are_bound_to_their_route_and_session() {
        let store = AuthStore::in_memory();
        let code = store.issue_pairing_code(None, PAIRING_CODE_TTL_MS).code;
        let session = store.exchange(&code, None, None).unwrap();
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
    fn sessions_survive_a_restart_and_only_hashes_are_stored() {
        let dir = std::env::temp_dir().join(format!("conn-server-auth-{}", random_hex(8)));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("sessions.json");
        let store = AuthStore::open(file.clone()).unwrap();
        let code = store.issue_pairing_code(None, PAIRING_CODE_TTL_MS).code;
        let session = store.exchange(&code, None, None).unwrap();
        let saved = fs::read_to_string(&file).unwrap();
        assert!(!saved.contains(&session.token));
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
        fs::remove_dir_all(dir).unwrap();
    }
}
