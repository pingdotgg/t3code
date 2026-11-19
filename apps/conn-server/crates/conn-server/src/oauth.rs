//! MCP OAuth for outside agents and peer links: client registration, the pairing-code
//! decision and the PKCE code exchange. Reference: `apps/server/src/auth/McpOAuth.ts` and
//! `mcpOAuthHttp.ts`.
//!
//! What another environment's link needs is served: register, a `pairing-code` decision, the
//! token. Not served: the browser approval page (`GET /oauth/mcp/authorize`,
//! `POST /oauth/mcp/approval`), browser-session approval and the `.well-known` metadata, since
//! this server has no browser sessions. `/mcp`'s 401 therefore names no `resource_metadata`.
//!
//! Registration keeps no state: the client id is its signed metadata, as in T3. The signing
//! key lives in the T3 secret store (`mcp-oauth-signing-key`); its format is our own, so a
//! client id from one server is unknown to the other, which only means registering again.
//! Authorization codes live in memory for 60 s, at most [`MAX_PENDING_CODES`] at once.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Mutex,
};

use conn_support::{base64, hmac::hmac_sha256, secret_store};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::auth::{self, AuthStore, ClientInfo, McpCodeError};

const SIGNING_SECRET_NAME: &str = "mcp-oauth-signing-key";
const AUTHORIZATION_CODE_TTL_MS: u64 = 60_000;
const MAX_CLIENT_NAME_CHARS: usize = 100;
const MAX_REDIRECT_URIS: usize = 10;
const MAX_REDIRECT_URI_LENGTH: usize = 512;
const MAX_UNBOUNDED_CLIENT_ID_REDIRECT_URIS: usize = 5;
const MAX_CLIENT_ID_LENGTH: usize = 10_240;
const DEFAULT_CLIENT_NAME: &str = "MCP client";
/// `MCP_PEER_LINK_SOFTWARE_ID`.
pub const MCP_PEER_LINK_SOFTWARE_ID: &str = "t3code-peer-link";
/// `PEER_LINKS_OFF_DESCRIPTION`.
pub const PEER_LINKS_OFF_DESCRIPTION: &str =
    "Linked environments is off on that machine. Turn it on in its Settings → Labs.";
/// Authorization codes waiting for their exchange. A code lives 60 s, so this bounds a burst.
const MAX_PENDING_CODES: usize = 256;
const TOO_MANY_SIGN_INS: &str = "Too many sign-ins are waiting. Try again in a minute.";

/// `issuer` and `resource` as the request reached this server (`McpOAuth.requestUrls`).
#[derive(Clone, Debug)]
pub struct Urls {
    pub issuer: String,
    pub resource: String,
}

impl Urls {
    /// From the `Host` header; `X-Forwarded-Proto: https` makes it https, as `requestUrl` does.
    pub fn from_host(host: Option<&str>, forwarded_https: bool) -> Self {
        let scheme = if forwarded_https { "https" } else { "http" };
        let origin = host
            .and_then(|host| url::Url::parse(&format!("{scheme}://{host}")).ok())
            .map(|url| url.origin().ascii_serialization())
            .filter(|origin| origin != "null")
            .unwrap_or_else(|| "http://localhost".to_owned());
        Self {
            resource: format!("{origin}/mcp"),
            issuer: origin,
        }
    }
}

/// A registered client, from its signed id.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Client {
    pub client_id: String,
    pub name: String,
    pub redirect_uris: Vec<String>,
    pub peer_link: bool,
}

/// `AuthMcpRegistrationError` (400).
#[derive(Debug, PartialEq, Eq)]
pub struct RegistrationError {
    pub error: &'static str,
    pub description: String,
}

/// `AuthMcpTokenError` (400).
#[derive(Debug, PartialEq, Eq)]
pub struct TokenError {
    pub error: &'static str,
    pub description: String,
}

fn token_error(error: &'static str, description: &str) -> TokenError {
    TokenError {
        error,
        description: description.to_owned(),
    }
}

/// What a decision answers: a redirect for the client, or a page error
/// (`AuthMcpApprovalError`, 400) that never redirects.
#[derive(Debug, PartialEq, Eq)]
pub enum Decision {
    Redirect(String),
    PageError(String),
}

#[derive(Debug, Default, Deserialize)]
pub struct Registration {
    pub client_name: Option<String>,
    pub software_id: Option<String>,
    pub redirect_uris: Option<Vec<String>>,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct AuthorizationRequest {
    pub response_type: Option<String>,
    pub client_id: Option<String>,
    pub redirect_uri: Option<String>,
    pub code_challenge: Option<String>,
    pub code_challenge_method: Option<String>,
    pub state: Option<String>,
    pub resource: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
pub struct TokenRequest {
    pub grant_type: Option<String>,
    pub code: Option<String>,
    pub redirect_uri: Option<String>,
    pub client_id: Option<String>,
    pub code_verifier: Option<String>,
    pub resource: Option<String>,
}

/// A validated authorization request.
struct Authorization {
    client: Client,
    redirect_uri: String,
    code_challenge: String,
    state: Option<String>,
    resource: String,
    issuer: String,
}

struct PendingCode {
    client_id: String,
    client_name: String,
    peer_link: bool,
    redirect_uri: String,
    code_challenge: String,
    resource: String,
    access: String,
    expires_at_ms: u64,
}

#[derive(Serialize, Deserialize)]
struct ClientIdPayload {
    v: u8,
    n: String,
    r: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    p: Option<u8>,
}

pub struct McpOAuth {
    secrets_dir: PathBuf,
    key: Mutex<Option<[u8; 32]>>,
    codes: Mutex<HashMap<String, PendingCode>>,
    /// Slots taken by sign-ins whose pairing code is being spent; counted with `codes`.
    reserved: std::sync::atomic::AtomicUsize,
}

/// A pending-code slot held while a pairing code is spent; given back on drop.
struct Slot<'a>(&'a std::sync::atomic::AtomicUsize);

impl Drop for Slot<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}

impl std::fmt::Debug for McpOAuth {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("McpOAuth").finish_non_exhaustive()
    }
}

impl McpOAuth {
    /// `secrets_dir` is the T3 secret store (`<state>/secrets`).
    pub fn new(secrets_dir: &Path) -> Self {
        Self {
            secrets_dir: secrets_dir.to_owned(),
            key: Mutex::new(None),
            codes: Mutex::new(HashMap::new()),
            reserved: std::sync::atomic::AtomicUsize::new(0),
        }
    }

    /// The signing key, read or made once (`getOrCreateRandom`). Blocking file work: the
    /// routes call it on a blocking thread through [`Self::load_key`] first.
    pub fn load_key(&self) -> std::io::Result<()> {
        let mut key = crate::lock(&self.key);
        if key.is_some() {
            return Ok(());
        }
        let stored = secret_store::read(&self.secrets_dir, SIGNING_SECRET_NAME)?;
        let bytes = match stored {
            Some(bytes) if bytes.len() == 32 => bytes,
            _ => {
                let mut fresh = vec![0u8; 32];
                getrandom::fill(&mut fresh).map_err(std::io::Error::other)?;
                secret_store::write(&self.secrets_dir, SIGNING_SECRET_NAME, &fresh)?;
                fresh
            }
        };
        let mut out = [0u8; 32];
        out.copy_from_slice(bytes.get(..32).unwrap_or(&[0u8; 32]));
        *key = Some(out);
        Ok(())
    }

    fn sign(&self, domain: &str, payload: &str) -> Option<String> {
        let key = (*crate::lock(&self.key))?;
        Some(base64::url_encode(&hmac_sha256(
            &key,
            format!("{domain}.{payload}").as_bytes(),
        )))
    }

    /// `register`: checks the metadata and signs it into a client id.
    pub fn register(
        &self,
        metadata: Registration,
        links_enabled: bool,
    ) -> Result<Client, RegistrationError> {
        let raw = metadata.client_name.as_deref().unwrap_or("").trim();
        let name: String = if raw.is_empty() {
            DEFAULT_CLIENT_NAME.to_owned()
        } else {
            // `slice(0, 100)` counts UTF-16 units.
            take_utf16(raw, MAX_CLIENT_NAME_CHARS)
        };
        let redirect_uris = metadata.redirect_uris.unwrap_or_default();
        if redirect_uris.is_empty() || redirect_uris.len() > MAX_REDIRECT_URIS {
            return Err(RegistrationError {
                error: "invalid_redirect_uri",
                description: format!("Register between 1 and {MAX_REDIRECT_URIS} redirect URIs."),
            });
        }
        if !redirect_uris
            .iter()
            .all(|uri| parse_redirect(uri).is_some())
        {
            return Err(RegistrationError {
                error: "invalid_redirect_uri",
                description:
                    "Redirect URIs must be https, or http on localhost, 127.0.0.1 or [::1]."
                        .to_owned(),
            });
        }
        let peer_link = metadata.software_id.as_deref() == Some(MCP_PEER_LINK_SOFTWARE_ID);
        if peer_link && !links_enabled {
            return Err(RegistrationError {
                error: "invalid_client_metadata",
                description: PEER_LINKS_OFF_DESCRIPTION.to_owned(),
            });
        }
        let body = base64::url_encode(
            serde_json::to_string(&ClientIdPayload {
                v: 1,
                n: name.clone(),
                r: redirect_uris.clone(),
                p: peer_link.then_some(1),
            })
            .unwrap_or_default()
            .as_bytes(),
        );
        let Some(signature) = self.sign("mcp-client-id", &body) else {
            return Err(RegistrationError {
                error: "invalid_client_metadata",
                description: "The server could not register clients.".to_owned(),
            });
        };
        let client_id = format!("{body}.{signature}");
        if redirect_uris.len() > MAX_UNBOUNDED_CLIENT_ID_REDIRECT_URIS
            && client_id.len() > MAX_CLIENT_ID_LENGTH
        {
            return Err(RegistrationError {
                error: "invalid_redirect_uri",
                description: "Redirect URIs are too long to fit in an authorization request."
                    .to_owned(),
            });
        }
        Ok(Client {
            client_id,
            name,
            redirect_uris,
            peer_link,
        })
    }

    fn parse_client_id(&self, client_id: &str) -> Option<Client> {
        let mut parts = client_id.split('.');
        let (body, signature) = (parts.next()?, parts.next()?);
        if body.is_empty() || signature.is_empty() || parts.next().is_some() {
            return None;
        }
        let expected = self.sign("mcp-client-id", body)?;
        if !conn_support::hmac::constant_time_eq(expected.as_bytes(), signature.as_bytes()) {
            return None;
        }
        let json = base64::url_decode(body)?;
        let payload: ClientIdPayload = serde_json::from_slice(&json).ok()?;
        (payload.v == 1).then(|| Client {
            client_id: client_id.to_owned(),
            name: payload.n,
            redirect_uris: payload.r,
            peer_link: payload.p == Some(1),
        })
    }

    /// `validateAuthorization`: page errors never redirect; the rest go back to the client.
    fn validate(
        &self,
        urls: &Urls,
        request: &AuthorizationRequest,
    ) -> Result<Authorization, Decision> {
        let Some(client) = self.parse_client_id(request.client_id.as_deref().unwrap_or("")) else {
            return Err(Decision::PageError(
                "This sign-in link names an unknown app. Start the sign-in again from it."
                    .to_owned(),
            ));
        };
        let Some(redirect_uri) = request.redirect_uri.clone().filter(|uri| {
            client
                .redirect_uris
                .iter()
                .any(|r| redirect_matches(r, uri))
        }) else {
            return Err(Decision::PageError(
                "This sign-in link sends you to an address the app did not register.".to_owned(),
            ));
        };
        let fail = |error: &str, description: &str| {
            Decision::Redirect(redirect_with(
                &redirect_uri,
                &[
                    ("error", Some(error)),
                    ("error_description", Some(description)),
                    ("state", request.state.as_deref()),
                    ("iss", Some(&urls.issuer)),
                ],
            ))
        };
        if request.response_type.as_deref() != Some("code") {
            return Err(fail(
                "unsupported_response_type",
                "Only response_type=code is supported.",
            ));
        }
        let challenge = request.code_challenge.clone().filter(|c| {
            c.len() == 43
                && c.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        });
        let (Some("S256"), Some(code_challenge)) =
            (request.code_challenge_method.as_deref(), challenge)
        else {
            return Err(fail(
                "invalid_request",
                "PKCE with code_challenge_method=S256 is required.",
            ));
        };
        if !same_resource(urls, request.resource.as_deref()) {
            return Err(fail(
                "invalid_target",
                &format!("This server only issues tokens for {}.", urls.resource),
            ));
        }
        Ok(Authorization {
            client,
            redirect_uri,
            code_challenge,
            state: request.state.clone(),
            resource: urls.resource.clone(),
            issuer: urls.issuer.clone(),
        })
    }

    /// A slot for one more pending code, or `None` when [`MAX_PENDING_CODES`] unexpired codes
    /// and reserved slots already wait. Taken under the codes lock, so two sign-ins can never
    /// both take the last one.
    fn reserve_code(&self) -> Option<Slot<'_>> {
        use std::sync::atomic::Ordering;
        let now = conn_support::time::now_ms();
        let mut codes = crate::lock(&self.codes);
        codes.retain(|_, pending| pending.expires_at_ms > now);
        if codes.len() + self.reserved.load(Ordering::SeqCst) >= MAX_PENDING_CODES {
            return None;
        }
        self.reserved.fetch_add(1, Ordering::SeqCst);
        Some(Slot(&self.reserved))
    }

    /// `decision`: `deny`, or a `pairing-code` that this environment issued. Browser-session
    /// approval needs a cookie session, which this server does not have.
    pub fn decide(
        &self,
        auth: &AuthStore,
        urls: &Urls,
        request: &AuthorizationRequest,
        decision: &Value,
    ) -> Decision {
        let authorization = match self.validate(urls, request) {
            Ok(authorization) => authorization,
            Err(decision) => return decision,
        };
        let redirect = |params: &[(&str, Option<&str>)]| {
            Decision::Redirect(redirect_with(&authorization.redirect_uri, params))
        };
        let access = match decision["_tag"].as_str() {
            Some("deny") => {
                return redirect(&[
                    ("error", Some("access_denied")),
                    ("state", authorization.state.as_deref()),
                    ("iss", Some(&authorization.issuer)),
                ]);
            }
            Some("pairing-code") => {
                let (Some(access), Some(code)) = (
                    decision["access"]
                        .as_str()
                        .filter(|a| auth::is_mcp_access(a)),
                    decision["code"].as_str(),
                ) else {
                    return Decision::PageError("Invalid decision.".to_owned());
                };
                if authorization.client.peer_link && is_approval_code(code) {
                    return Decision::PageError(
                        "Linking needs a plain pairing code, not an app approval code.".to_owned(),
                    );
                }
                // Capacity first: a sign-in refused for it must not spend the user's code.
                let Some(slot) = self.reserve_code() else {
                    return Decision::PageError(TOO_MANY_SIGN_INS.to_owned());
                };
                match auth.consume_mcp_code(code, access, authorization.client.peer_link) {
                    Ok(level) => (level, slot),
                    Err(McpCodeError::Storage) => {
                        return Decision::PageError(McpCodeError::Storage.message().to_owned());
                    }
                    Err(error) => return Decision::PageError(error.message().to_owned()),
                }
            }
            _ => {
                return Decision::PageError(
                    "Your session cannot approve this request. Enter a pairing code instead."
                        .to_owned(),
                );
            }
        };
        let (access, slot) = access;
        let code = mint_code();
        let now = conn_support::time::now_ms();
        {
            // The slot reserved before the pairing code was spent becomes this code.
            let mut codes = crate::lock(&self.codes);
            codes.retain(|_, pending| pending.expires_at_ms > now);
            codes.insert(
                code.clone(),
                PendingCode {
                    client_id: authorization.client.client_id.clone(),
                    client_name: authorization.client.name.clone(),
                    peer_link: authorization.client.peer_link,
                    redirect_uri: authorization.redirect_uri.clone(),
                    code_challenge: authorization.code_challenge.clone(),
                    resource: authorization.resource.clone(),
                    access,
                    expires_at_ms: now.saturating_add(AUTHORIZATION_CODE_TTL_MS),
                },
            );
            drop(slot);
        }
        redirect(&[
            ("code", Some(&code)),
            ("state", authorization.state.as_deref()),
            ("iss", Some(&authorization.issuer)),
        ])
    }

    /// `exchangeCode`: a code is spent when presented, even when a later check fails.
    pub fn exchange(
        &self,
        auth: &AuthStore,
        urls: &Urls,
        token: &TokenRequest,
        client: ClientInfo,
    ) -> Result<Value, TokenError> {
        if token.grant_type.as_deref() != Some("authorization_code") {
            return Err(token_error(
                "unsupported_grant_type",
                "Only authorization_code is supported.",
            ));
        }
        let nonempty = |v: &Option<String>| v.clone().filter(|v| !v.is_empty());
        let (Some(code), Some(redirect_uri), Some(client_id), Some(verifier)) = (
            nonempty(&token.code),
            nonempty(&token.redirect_uri),
            nonempty(&token.client_id),
            nonempty(&token.code_verifier),
        ) else {
            return Err(token_error(
                "invalid_request",
                "code, redirect_uri, client_id and code_verifier are required.",
            ));
        };
        if self.parse_client_id(&client_id).is_none() {
            return Err(token_error("invalid_client", "The client is unknown."));
        }
        let pending = crate::lock(&self.codes).remove(&code);
        let now = conn_support::time::now_ms();
        let Some(pending) = pending.filter(|p| {
            p.expires_at_ms > now
                && p.client_id == client_id
                && p.redirect_uri == redirect_uri
                && p.resource == urls.resource
                && same_resource(urls, token.resource.as_deref())
                && pkce_verifies(&verifier, &p.code_challenge)
        }) else {
            return Err(token_error(
                "invalid_grant",
                "The authorization code is invalid or expired.",
            ));
        };
        let issued = auth
            .issue_mcp_client_session(
                &pending.client_name,
                &pending.access,
                pending.peer_link,
                client,
            )
            .map_err(|error| {
                eprintln!("conn-server: could not issue an MCP client session: {error}");
                token_error("invalid_grant", "The session could not be issued.")
            })?;
        Ok(json!({
            "access_token": issued.token,
            "token_type": "Bearer",
            "expires_in": issued.principal.expires_at_ms.saturating_sub(now) / 1000,
            "scope": auth::mcp_client_scopes(&pending.access).join(" "),
        }))
    }
}

/// The first `units` UTF-16 code units of `text`, as JavaScript's `slice` cuts.
fn take_utf16(text: &str, units: usize) -> String {
    let mut out = String::new();
    let mut used = 0;
    for c in text.chars() {
        used += c.len_utf16();
        if used > units {
            break;
        }
        out.push(c);
    }
    out
}

fn is_approval_code(code: &str) -> bool {
    let code = code.trim();
    let Some((prefix, token)) = code.split_once('-') else {
        return false;
    };
    ["READ", "SUPERVISED", "EDITS", "AUTO", "FULL"]
        .iter()
        .any(|p| p.eq_ignore_ascii_case(prefix))
        && token.len() == auth::PAIRING_CODE_LENGTH
        && token
            .bytes()
            .all(|b| auth::PAIRING_CODE_ALPHABET.contains(&b.to_ascii_uppercase()))
}

fn mint_code() -> String {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("the OS random source is available");
    base64::url_encode(&bytes)
}

fn pkce_verifies(verifier: &str, challenge: &str) -> bool {
    let valid = (43..=128).contains(&verifier.len())
        && verifier
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~'));
    valid
        && conn_support::hmac::constant_time_eq(
            base64::url_encode(&conn_support::hmac::sha256(verifier.as_bytes())).as_bytes(),
            challenge.as_bytes(),
        )
}

/// `parseRedirect`: https, or http on a loopback name; no fragment and no user info.
fn parse_redirect(value: &str) -> Option<url::Url> {
    if value.len() > MAX_REDIRECT_URI_LENGTH || value.contains('#') {
        return None;
    }
    let url = url::Url::parse(value).ok()?;
    let host = url.host_str().unwrap_or_default();
    let allowed = url.scheme() == "https"
        || (url.scheme() == "http" && matches!(host, "localhost" | "127.0.0.1" | "[::1]"));
    (allowed && url.username().is_empty() && url.password().is_none()).then_some(url)
}

/// Loopback redirects ignore the port (RFC 8252 §7.3); https ones match exactly.
fn redirect_matches(registered: &str, presented: &str) -> bool {
    let (Some(left), Some(right)) = (parse_redirect(registered), parse_redirect(presented)) else {
        return false;
    };
    if left.scheme() == "https" || right.scheme() == "https" {
        return left.as_str() == right.as_str();
    }
    left.host_str() == right.host_str()
        && left.path() == right.path()
        && left.query() == right.query()
}

fn same_resource(urls: &Urls, presented: Option<&str>) -> bool {
    let Some(presented) = presented else {
        return true;
    };
    if presented.contains('#') {
        return false;
    }
    let Ok(url) = url::Url::parse(presented) else {
        return false;
    };
    format!(
        "{}{}",
        url.origin().ascii_serialization(),
        url.path().trim_end_matches('/')
    ) == urls.resource
}

fn redirect_with(redirect_uri: &str, params: &[(&str, Option<&str>)]) -> String {
    let Ok(mut url) = url::Url::parse(redirect_uri) else {
        return redirect_uri.to_owned();
    };
    for (name, value) in params {
        if let Some(value) = value {
            // `searchParams.set`: replace any earlier value of the same name.
            let kept: Vec<(String, String)> = url
                .query_pairs()
                .filter(|(key, _)| key != name)
                .map(|(k, v)| (k.into_owned(), v.into_owned()))
                .collect();
            url.query_pairs_mut()
                .clear()
                .extend_pairs(kept)
                .append_pair(name, value);
        }
    }
    url.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn oauth() -> McpOAuth {
        let dir = std::env::temp_dir().join(format!("conn-oauth-{}", crate::auth::random_hex(6)));
        let oauth = McpOAuth::new(&dir);
        oauth.load_key().unwrap();
        oauth
    }

    fn urls() -> Urls {
        Urls::from_host(Some("127.0.0.1:3773"), false)
    }

    fn authorization(client: &Client, challenge: &str) -> AuthorizationRequest {
        AuthorizationRequest {
            response_type: Some("code".into()),
            client_id: Some(client.client_id.clone()),
            redirect_uri: Some("http://127.0.0.1/t3code-peer-link".into()),
            code_challenge: Some(challenge.into()),
            code_challenge_method: Some("S256".into()),
            state: Some("s".into()),
            resource: Some("http://127.0.0.1:3773/mcp".into()),
        }
    }

    /// Two sign-ins at the last free slot: only one may spend its code (Codex finding 3 of
    /// #151); the slot comes back when the sign-in ends without a code.
    #[test]
    fn the_last_code_slot_is_taken_once() {
        let oauth = oauth();
        oauth
            .reserved
            .store(MAX_PENDING_CODES - 1, std::sync::atomic::Ordering::SeqCst);
        let first = oauth.reserve_code();
        assert!(first.is_some());
        assert!(
            oauth.reserve_code().is_none(),
            "the table is full with the slot taken"
        );
        drop(first);
        assert!(
            oauth.reserve_code().is_some(),
            "a given-back slot is free again"
        );
    }

    /// A sign-in refused because too many codes wait must leave the user's pairing code
    /// unspent: capacity is checked before the code is consumed.
    #[test]
    fn a_full_code_table_does_not_spend_the_pairing_code() {
        let oauth = oauth();
        let auth = AuthStore::in_memory();
        let client = oauth
            .register(
                Registration {
                    client_name: Some("T3 Code · other".into()),
                    software_id: Some(MCP_PEER_LINK_SOFTWARE_ID.into()),
                    redirect_uris: Some(vec!["http://127.0.0.1/t3code-peer-link".into()]),
                },
                true,
            )
            .unwrap();
        let challenge = base64::url_encode(&conn_support::hmac::sha256(b"verifier"));
        let request = authorization(&client, &challenge);
        let later = conn_support::time::now_ms() + 60_000;
        {
            let mut codes = crate::lock(&oauth.codes);
            for n in 0..MAX_PENDING_CODES {
                codes.insert(
                    format!("pending-{n}"),
                    PendingCode {
                        client_id: client.client_id.clone(),
                        client_name: client.name.clone(),
                        peer_link: true,
                        redirect_uri: "http://127.0.0.1/t3code-peer-link".into(),
                        code_challenge: challenge.clone(),
                        resource: "http://127.0.0.1:3773/mcp".into(),
                        access: "auto".into(),
                        expires_at_ms: later,
                    },
                );
            }
        }
        let code = auth.issue_peer_link_pairing("auto", None).unwrap().code;
        let decision = json!({"_tag": "pairing-code", "access": "auto", "code": code});
        let Decision::PageError(message) = oauth.decide(&auth, &urls(), &request, &decision) else {
            panic!("a full table refuses the sign-in");
        };
        assert_eq!(message, TOO_MANY_SIGN_INS);
        // Once codes free up, the same pairing code still links.
        crate::lock(&oauth.codes).clear();
        assert!(matches!(
            oauth.decide(&auth, &urls(), &request, &decision),
            Decision::Redirect(_)
        ));
    }

    #[test]
    fn links_a_peer_with_a_peer_link_code() {
        let oauth = oauth();
        let auth = AuthStore::in_memory();
        let client = oauth
            .register(
                Registration {
                    client_name: Some("T3 Code · other".into()),
                    software_id: Some(MCP_PEER_LINK_SOFTWARE_ID.into()),
                    redirect_uris: Some(vec!["http://127.0.0.1/t3code-peer-link".into()]),
                },
                true,
            )
            .unwrap();
        assert!(client.peer_link, "the software id marks a peer link");
        let verifier = "v".repeat(43);
        let challenge = base64::url_encode(&conn_support::hmac::sha256(verifier.as_bytes()));
        let code = auth.issue_peer_link_pairing("auto", None).unwrap().code;
        let request = authorization(&client, &challenge);
        let Decision::Redirect(to) = oauth.decide(
            &auth,
            &urls(),
            &request,
            &json!({"_tag": "pairing-code", "access": "auto", "code": code}),
        ) else {
            panic!("the code approves the link");
        };
        let to = url::Url::parse(&to).unwrap();
        let code = to
            .query_pairs()
            .find(|(k, _)| k == "code")
            .map(|(_, v)| v.into_owned())
            .unwrap();
        let token = oauth
            .exchange(
                &auth,
                &urls(),
                &TokenRequest {
                    grant_type: Some("authorization_code".into()),
                    code: Some(code.clone()),
                    redirect_uri: request.redirect_uri.clone(),
                    client_id: Some(client.client_id.clone()),
                    code_verifier: Some(verifier.clone()),
                    resource: request.resource.clone(),
                },
                ClientInfo::default(),
            )
            .unwrap();
        assert_eq!(token["scope"], "orchestration:read orchestration:operate");
        let session = auth
            .authenticate_mcp_client(token["access_token"].as_str().unwrap())
            .unwrap();
        assert_eq!(session.access, "auto");
        assert!(session.peer_link, "the session is a peer link");
        assert_eq!(session.label, "T3 Code · other");
        // A code is spent once.
        let again = oauth.exchange(
            &auth,
            &urls(),
            &TokenRequest {
                grant_type: Some("authorization_code".into()),
                code: Some(code),
                redirect_uri: request.redirect_uri.clone(),
                client_id: Some(client.client_id),
                code_verifier: Some(verifier),
                resource: request.resource,
            },
            ClientInfo::default(),
        );
        assert_eq!(again.unwrap_err().error, "invalid_grant");
    }

    #[test]
    fn refuses_peer_links_while_links_are_off_and_purpose_codes_for_pairing() {
        let oauth = oauth();
        let refused = oauth
            .register(
                Registration {
                    client_name: None,
                    software_id: Some(MCP_PEER_LINK_SOFTWARE_ID.into()),
                    redirect_uris: Some(vec!["http://127.0.0.1/x".into()]),
                },
                false,
            )
            .unwrap_err();
        assert_eq!(refused.description, PEER_LINKS_OFF_DESCRIPTION);
        let auth = AuthStore::in_memory();
        let code = auth
            .issue_peer_link_pairing("read-only", None)
            .unwrap()
            .code;
        assert!(
            auth.exchange(&code, None, ClientInfo::default()).is_err(),
            "a peer-link code is not a device pairing code"
        );
        assert_eq!(
            auth.consume_mcp_code(&code, "full-access", true),
            Err(McpCodeError::InsufficientScope),
            "a read-only code lacks a broader access's scopes, named first as in T3"
        );
        let auto = auth.issue_peer_link_pairing("auto", None).unwrap().code;
        assert_eq!(
            auth.consume_mcp_code(&auto, "approval-required", true),
            Err(McpCodeError::UnknownOrUsed),
            "a code for auto links refuses another level with the same scopes"
        );
        assert_eq!(
            auth.consume_mcp_code(&auto, "auto", false),
            Err(McpCodeError::UnknownOrUsed),
            "a peer-link code is not an app sign-in code"
        );
        assert_eq!(
            auth.consume_mcp_code(&code, "read-only", true),
            Ok("read-only".into())
        );
    }

    #[test]
    fn rejects_unknown_clients_and_bad_redirects() {
        let oauth = oauth();
        let auth = AuthStore::in_memory();
        let request = AuthorizationRequest {
            client_id: Some("forged.id".into()),
            ..AuthorizationRequest::default()
        };
        assert!(matches!(
            oauth.decide(&auth, &urls(), &request, &json!({"_tag": "deny"})),
            Decision::PageError(_)
        ));
        assert!(redirect_matches(
            "http://127.0.0.1:9/cb",
            "http://127.0.0.1:7/cb"
        ));
        assert!(!redirect_matches(
            "https://a.test/cb",
            "https://a.test/other"
        ));
        assert!(parse_redirect("http://example.test/cb").is_none());
        assert_eq!(take_utf16("ab🙂c", 3), "ab");
    }
}
