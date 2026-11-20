//! Links from this environment to others (peers), and the calls agents make through them.
//! Reference: `apps/server/src/peer/PeerLinks.ts`, `PeerMcpClient.ts` and
//! `PeerLinkRequests.ts`.
//!
//! Linking signs this environment in to the peer's `/mcp` as an outside agent with a pairing
//! code from the peer: MCP OAuth (register, a `pairing-code` decision, the code exchange),
//! without a browser. The peer's token goes to the T3 secret store (`peer-link-<hex>`); the
//! rest of each link to `peer-links.json` (0600), at most [`MAX_LINKS`]. A forwarded tool call
//! opens one MCP session per peer and address and reuses it (at most [`MAX_SESSIONS`]).
//!
//! Requests go out one connection each through `conn_source_control::http` (rustls with
//! Mozilla's roots). Redirects are never followed: only the origin checked here may receive a
//! pairing code or a token.

use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

use conn_engine::{BoxFuture, Engine};
use conn_mcp::{LinkAsk, LinkInfo, PeerCall, PeerFailure, Peers};
use conn_source_control::{
    Secret,
    http::{self, HttpError, HttpRequest, HttpResponse, Method},
};
use conn_support::{base64, ids::encode_component as enc, time::iso_from_ms};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use tokio::task::JoinSet;

use crate::environment::Environment;

/// Where a link's sign-in redirects. Nothing listens there: the code comes back in the answer.
const LINK_REDIRECT_URI: &str = "http://127.0.0.1/t3code-peer-link";
/// The only MCP protocol version a T3 Code `/mcp` registers.
const PROTOCOL_VERSION: &str = "2025-06-18";
const SENDER_TITLE_MAX_CHARS: usize = 200;
/// Links kept at once. Each is a row and a token; a user links a handful of machines.
pub const MAX_LINKS: usize = 256;
/// Descriptor probes in flight at once, across every link and call. Every address supplied is
/// probed (`PeerLinks.link`); this bounds how many at once.
const MAX_PROBES: usize = 16;
/// MCP sessions kept open to peers, one per peer and address.
const MAX_SESSIONS: usize = 64;
/// How long a listing waits on a link's addresses.
const LIST_PROBE_TIMEOUT: Duration = Duration::from_secs(3);
/// A forwarded tool call may wait as long as an agent's own call (`TOOL_TIMEOUT_SECS`).
const CALL_TIMEOUT: Duration = Duration::from_secs(conn_mcp::TOOL_TIMEOUT_SECS);
const FILE: &str = "peer-links.json";
/// One link card answered at a time; other cards go on while a slow peer holds one.
const MAX_ANSWERING: usize = 256;

const LINKED_ENVIRONMENTS_OFF_THERE: &str =
    "The linked environment has Linked environments turned off. Turn it on in its Settings → Labs.";
const NO_LONGER_ACCEPTED: &str = "The linked environment no longer accepts this link. It may have been revoked there; link it again.";
const STOPPED_ANSWERING: &str = "The linked environment stopped answering.";

/// `PeerLinkError`: why linking or calling a peer failed, in words a user can act on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PeerLinkError {
    pub reason: &'static str,
    pub message: String,
}

impl PeerLinkError {
    fn new(reason: &'static str, message: impl Into<String>) -> Self {
        Self {
            reason,
            message: message.into(),
        }
    }

    pub fn to_contract(&self) -> Value {
        json!({"_tag": "PeerLinkError", "reason": self.reason, "message": self.message})
    }
}

fn storage(error: impl std::fmt::Display) -> PeerLinkError {
    eprintln!("conn-server: peer link storage failed: {error}");
    PeerLinkError::new(
        "storage",
        "Linked environments could not be read or saved here. The server log has details.",
    )
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Row {
    environment_id: String,
    secret_name: String,
    label: String,
    urls: Vec<String>,
    access: String,
    linked_at_ms: u64,
    expires_at_ms: u64,
    last_reached_at_ms: Option<u64>,
    last_error: Option<String>,
}

impl Row {
    fn expired(&self, now: u64) -> bool {
        self.expires_at_ms <= now
    }

    fn to_link(&self) -> Value {
        json!({
            "environmentId": self.environment_id,
            "label": self.label,
            "urls": self.urls,
            "access": self.access,
            "linkedAt": iso_from_ms(self.linked_at_ms),
            "expiresAt": iso_from_ms(self.expires_at_ms),
            "lastReachedAt": self.last_reached_at_ms.map(iso_from_ms),
            "lastError": self.last_error,
        })
    }
}

#[derive(Default, Serialize, Deserialize)]
struct LinksFile {
    version: u32,
    links: Vec<Row>,
}

/// `PeerLinkCreateInput`, after the method table's decode.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkInput {
    pub url: String,
    #[serde(default)]
    pub alternate_urls: Option<Vec<String>>,
    pub pairing_code: String,
    pub access: String,
    #[serde(default)]
    pub expected_environment_id: Option<String>,
    #[serde(default)]
    pub expected_label: Option<String>,
}

/// A usable link: where the peer answers and the token to send there.
struct Resolved {
    url: String,
    token: String,
}

pub struct PeerLinks {
    environment: Arc<Environment>,
    engine: Arc<dyn Engine>,
    file: PathBuf,
    secrets_dir: PathBuf,
    /// Serializes changes to the file; reads take it too, so a read never sees half a write.
    disk: tokio::sync::Mutex<()>,
    sessions: Mutex<HashMap<String, String>>,
    answering: Mutex<HashSet<String>>,
    probes: Arc<tokio::sync::Semaphore>,
}

impl std::fmt::Debug for PeerLinks {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PeerLinks")
            .field("file", &self.file)
            .finish_non_exhaustive()
    }
}

fn now_ms() -> u64 {
    conn_support::time::now_ms()
}

fn normalize_host(host: &str) -> String {
    host.to_ascii_lowercase()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .trim_end_matches('.')
        .to_owned()
}

/// `isLocalLoopbackHost`.
pub fn is_loopback_host(host: &str) -> bool {
    let host = normalize_host(host);
    host == "localhost"
        || host == "::1"
        || host
            .parse::<std::net::Ipv4Addr>()
            .is_ok_and(|ip| ip.octets()[0] == 127)
}

/// `isTailnetHost`: a `.ts.net` name or Tailscale's IPv6 range.
fn is_tailnet_host(host: &str) -> bool {
    let host = normalize_host(host);
    host.ends_with(".ts.net")
        || host.parse::<std::net::Ipv6Addr>().is_ok_and(|ip| {
            let s = ip.segments();
            s[0] == 0xfd7a && s[1] == 0x115c && s[2] == 0xa1e0
        })
}

/// `isOrbitWireGuardHost`: Orbit's WireGuard network encrypts every packet between peers.
fn is_orbit_wireguard_host(host: &str) -> bool {
    host.starts_with("10.44.") && host.parse::<std::net::Ipv4Addr>().is_ok()
}

/// `peerOrigin`: the base URL a peer is reached at, as its origin. Plain http only where the
/// network already encrypts.
fn peer_origin(url: &str) -> Result<String, PeerLinkError> {
    let unreachable = |message: String| PeerLinkError::new("unreachable", message);
    let parsed = url::Url::parse(url)
        .ok()
        .filter(|u| matches!(u.scheme(), "http" | "https"))
        .ok_or_else(|| unreachable(format!("{url} is not an http or https address.")))?;
    let host = parsed.host_str().unwrap_or_default();
    if parsed.scheme() == "http"
        && !is_loopback_host(host)
        && !is_tailnet_host(host)
        && !is_orbit_wireguard_host(host)
    {
        return Err(unreachable(format!(
            "{url} is plain http, which would send the link's credentials unencrypted. Use its https address, its Tailscale address, or its Orbit WireGuard address."
        )));
    }
    Ok(parsed.origin().ascii_serialization())
}

/// `probeTimeout`: a tailnet or relayed route to a waking machine takes longer than loopback.
fn probe_timeout(origin: &str) -> Duration {
    let loopback = url::Url::parse(origin)
        .ok()
        .and_then(|u| u.host_str().map(is_loopback_host))
        .unwrap_or(false);
    Duration::from_secs(if loopback { 3 } else { 10 })
}

/// The system error under a failed connection, named as Node names it.
fn connection_code(message: &str) -> Option<&'static str> {
    let lower = message.to_ascii_lowercase();
    if lower.contains("refused") {
        Some("ECONNREFUSED")
    } else if lower.contains("lookup") || lower.contains("nodename") || lower.contains("not known")
    {
        Some("ENOTFOUND")
    } else if lower.contains("unreachable") {
        Some("EHOSTUNREACH")
    } else if lower.contains("reset") {
        Some("ECONNRESET")
    } else {
        None
    }
}

/// `linkLimitsHold`: the peer holds a linked agent to its limits and fences its work.
fn link_limits_hold(descriptor: &Value) -> bool {
    descriptor["capabilities"]["mcpModeLimitHeader"] == true
        && descriptor["capabilities"]["linkFence"] == true
}

fn random_b64(len: usize) -> String {
    let mut bytes = vec![0u8; len];
    getrandom::fill(&mut bytes).expect("the OS random source is available");
    base64::url_encode(&bytes)
}

/// The body of an MCP answer: JSON, or one server-sent event carrying JSON.
fn response_json(response: &HttpResponse) -> String {
    let text = response.text();
    if response
        .header("content-type")
        .is_some_and(|t| t.contains("text/event-stream"))
    {
        text.lines()
            .filter_map(|line| line.strip_prefix("data:"))
            .map(str::trim)
            .collect()
    } else {
        text
    }
}

impl PeerLinks {
    pub fn new(environment: Arc<Environment>, engine: Arc<dyn Engine>) -> Arc<Self> {
        Arc::new(Self {
            file: environment.state_dir.join(FILE),
            secrets_dir: environment.state_dir.join("secrets"),
            environment,
            engine,
            disk: tokio::sync::Mutex::new(()),
            sessions: Mutex::new(HashMap::new()),
            answering: Mutex::new(HashSet::new()),
            probes: Arc::new(tokio::sync::Semaphore::new(MAX_PROBES)),
        })
    }

    fn own_id(&self) -> &str {
        self.environment.environment_id()
    }

    fn own_label(&self) -> String {
        self.environment.descriptor["label"]
            .as_str()
            .unwrap_or_default()
            .to_owned()
    }

    /// Whether the Linked environments beta (Settings → Labs) is on here.
    pub fn enabled(&self) -> bool {
        self.environment
            .settings
            .raw()
            .get("linkedEnvironmentsEnabled")
            == Some(&json!(true))
    }

    async fn blocking<T: Send + 'static>(
        &self,
        work: impl FnOnce(PathBuf, PathBuf) -> Result<T, PeerLinkError> + Send + 'static,
    ) -> Result<T, PeerLinkError> {
        let (file, secrets) = (self.file.clone(), self.secrets_dir.clone());
        tokio::task::spawn_blocking(move || work(file, secrets))
            .await
            .map_err(storage)?
    }

    async fn read_rows(&self) -> Result<Vec<Row>, PeerLinkError> {
        let _disk = self.disk.lock().await;
        self.blocking(|file, _| read_file(&file)).await
    }

    async fn read_row(&self, environment_id: &str) -> Result<Option<Row>, PeerLinkError> {
        Ok(self
            .read_rows()
            .await?
            .into_iter()
            .find(|r| r.environment_id == environment_id))
    }

    /// Changes the rows under the file lock and saves them.
    async fn change<T: Send + 'static>(
        &self,
        change: impl FnOnce(&mut Vec<Row>) -> T + Send + 'static,
    ) -> Result<T, PeerLinkError> {
        let _disk = self.disk.lock().await;
        self.blocking(move |file, _| {
            // Another process (`environment link-orbit`) may change the file too: one lock
            // file holds every read-modify-write across processes. Released when dropped.
            let lock = std::fs::OpenOptions::new()
                .create(true)
                .truncate(false)
                .write(true)
                .open(file.with_extension("lock"))
                .map_err(storage)?;
            lock.lock().map_err(storage)?;
            let mut rows = read_file(&file)?;
            let out = change(&mut rows);
            write_file(&file, rows)?;
            Ok(out)
        })
        .await
    }

    /// The environment answering at `origin` (`probe`). Any failure but a rejected
    /// certificate is tried once more after a second, as T3 retries: a dropped request or a
    /// brief 503 must not list a live peer as down. The timeout bounds both tries.
    async fn probe(&self, origin: &str) -> Result<Value, PeerLinkError> {
        // Bounded: a link's addresses, and every link a listing probes, share the permits.
        let _permit = self.probes.clone().acquire_owned().await.map_err(storage)?;
        let timeout = probe_timeout(origin);
        let url = format!("{origin}/.well-known/t3/environment");
        let once = || async {
            match http::send(HttpRequest::new(Method::Get, url.clone()).timeout(timeout)).await {
                Ok(response) => descriptor_of(&response).ok_or(Probed::NotT3),
                Err(error) => Err(Probed::Http(error)),
            }
        };
        let attempt = async {
            match once().await {
                Err(error) if !error.rejected_certificate() => {
                    tokio::time::sleep(Duration::from_secs(1)).await;
                    once().await
                }
                first => first,
            }
        };
        let unreachable = |message: String| PeerLinkError::new("unreachable", message);
        match tokio::time::timeout(timeout, attempt).await {
            Ok(Ok(descriptor)) => Ok(descriptor),
            Err(_) | Ok(Err(Probed::Http(HttpError::Timeout { .. }))) => Err(unreachable(format!(
                "{origin} did not answer within {} seconds.",
                timeout.as_secs()
            ))),
            Ok(Err(Probed::Http(HttpError::Transport { message, .. })))
                if message.contains("certificate") =>
            {
                Err(unreachable(format!(
                    "{origin} presented a certificate this machine rejected (UNABLE_TO_VERIFY_LEAF_SIGNATURE)."
                )))
            }
            Ok(Err(Probed::Http(
                HttpError::Connect { message, .. } | HttpError::Transport { message, .. },
            ))) => Err(unreachable(match connection_code(&message) {
                Some(code) => format!("{origin} did not answer ({code})."),
                None => format!("{origin} did not answer."),
            })),
            Ok(Err(Probed::Http(HttpError::InvalidUrl))) => {
                Err(unreachable(format!("{origin} did not answer.")))
            }
            Ok(Err(Probed::NotT3)) => Err(PeerLinkError::new(
                "not_a_t3_environment",
                format!(
                    "{origin} answered, but not as a T3 Code environment this version understands."
                ),
            )),
        }
    }

    /// The descriptor `url` answers with, when it answers as `environment_id`.
    async fn answers_as(&self, url: String, environment_id: String) -> Option<(String, Value)> {
        let found = self.probe(&url).await.ok()?;
        (found["environmentId"] == environment_id.as_str()).then_some((url, found))
    }

    /// The first address that answers as `environment_id`; silent ones never delay it.
    async fn race_answers(
        self: &Arc<Self>,
        urls: &[String],
        environment_id: &str,
        limit: Option<Duration>,
    ) -> Option<(String, Value)> {
        let mut set = JoinSet::new();
        for url in urls {
            let (this, url, id) = (self.clone(), url.clone(), environment_id.to_owned());
            set.spawn(async move { this.answers_as(url, id).await });
        }
        let first = async {
            while let Some(done) = set.join_next().await {
                if let Ok(Some(found)) = done {
                    return Some(found);
                }
            }
            None
        };
        let found = match limit {
            Some(limit) => tokio::time::timeout(limit, first).await.ok().flatten(),
            None => first.await,
        };
        set.abort_all();
        found
    }

    /// `answeringAt`: every address checked for credentials, then the first one probed.
    async fn answering_at(
        &self,
        urls: &[String],
    ) -> Result<(String, Value, Vec<String>), PeerLinkError> {
        let mut origins: Vec<String> = Vec::new();
        for url in urls {
            let origin = peer_origin(url)?;
            if !origins.contains(&origin) {
                origins.push(origin);
            }
        }
        let primary = origins.first().cloned().unwrap_or_default();
        let peer = self.probe(&primary).await?;
        Ok((primary, peer, origins))
    }

    /// `answeringAs`: the addresses that answer as the machine the user picked.
    async fn answering_as(
        self: &Arc<Self>,
        urls: &[String],
        environment_id: &str,
        name: &str,
    ) -> Result<(String, Value, Vec<String>), PeerLinkError> {
        let mut set = JoinSet::new();
        for (index, url) in urls.iter().enumerate() {
            let (this, url, id, name) = (
                self.clone(),
                url.clone(),
                environment_id.to_owned(),
                name.to_owned(),
            );
            set.spawn(async move {
                let checked = async {
                    let origin = peer_origin(&url)?;
                    let host = url::Url::parse(&origin)
                        .ok()
                        .and_then(|u| u.host_str().map(str::to_owned))
                        .unwrap_or_default();
                    // Loopback is this machine, where anything may answer as the one picked.
                    if is_loopback_host(&host) {
                        return Err(PeerLinkError::new(
                            "unreachable",
                            format!("{origin} is this machine, not {name}."),
                        ));
                    }
                    let descriptor = this.probe(&origin).await?;
                    if descriptor["environmentId"] != id.as_str() {
                        return Err(PeerLinkError::new(
                            "unreachable",
                            format!(
                                "{origin} now answers as {} ({}), not {name}.",
                                descriptor["label"].as_str().unwrap_or_default(),
                                descriptor["environmentId"].as_str().unwrap_or_default()
                            ),
                        ));
                    }
                    Ok((origin, descriptor))
                };
                (index, checked.await)
            });
        }
        let mut results: Vec<Checked> = Vec::new();
        while let Some(done) = set.join_next().await {
            if let Ok(result) = done {
                results.push(result);
            }
        }
        results.sort_by_key(|(index, _)| *index);
        let matching: Vec<&(String, Value)> = results
            .iter()
            .filter_map(|(_, r)| r.as_ref().ok())
            .collect();
        let Some((primary, peer)) = matching.first().map(|(o, d)| (o.clone(), d.clone())) else {
            let reasons: Vec<String> = results
                .iter()
                .filter_map(|(_, r)| r.as_ref().err().map(|e| e.message.clone()))
                .collect();
            return Err(PeerLinkError::new(
                "unreachable",
                format!(
                    "This environment could not reach {name}: {}",
                    reasons.join(" ")
                ),
            ));
        };
        let mut origins: Vec<String> = Vec::new();
        for (origin, _) in matching {
            if !origins.contains(origin) {
                origins.push(origin.clone());
            }
        }
        Ok((primary, peer, origins))
    }

    /// `signIn`: register, decide with the pairing code, exchange the code for a token.
    async fn sign_in(
        &self,
        origin: &str,
        input: &LinkInput,
        client_name: &str,
    ) -> Result<(String, u64), PeerLinkError> {
        let incompatible = || {
            PeerLinkError::new(
                "incompatible",
                format!(
                    "{origin} answered in a shape this version does not understand. Update both environments."
                ),
            )
        };
        let stopped = || {
            PeerLinkError::new(
                "unreachable",
                format!("{origin} stopped answering while linking."),
            )
        };
        let post_json = |path: &str, body: Value| {
            HttpRequest::new(Method::Post, format!("{origin}{path}"))
                .header("content-type", "application/json")
                .body(body.to_string().into_bytes())
                .timeout(Duration::from_secs(30))
        };
        let registered = http::send(post_json(
            "/oauth/mcp/register",
            json!({
                "client_name": client_name,
                "redirect_uris": [LINK_REDIRECT_URI],
                "software_id": crate::oauth::MCP_PEER_LINK_SOFTWARE_ID,
            }),
        ))
        .await
        .map_err(|_| stopped())?;
        let body: Value = serde_json::from_slice(&registered.body).map_err(|_| incompatible())?;
        if registered.status == 400
            && let (Some(_), Some(description)) =
                (body["error"].as_str(), body["error_description"].as_str())
        {
            let reason = if description == crate::oauth::PEER_LINKS_OFF_DESCRIPTION {
                "peer_disabled"
            } else {
                "pairing_rejected"
            };
            return Err(PeerLinkError::new(
                reason,
                format!("The peer refused to register this environment: {description}"),
            ));
        }
        let Some(client_id) = body["client_id"]
            .as_str()
            .filter(|_| registered.status == 201)
        else {
            return Err(incompatible());
        };
        let verifier = random_b64(32);
        let challenge = base64::url_encode(&conn_support::hmac::sha256(verifier.as_bytes()));
        let state = random_b64(16);
        let resource = format!("{origin}/mcp");
        let decided = http::send(post_json(
            "/oauth/mcp/decision",
            json!({
                "authorization": {
                    "response_type": "code",
                    "client_id": client_id,
                    "redirect_uri": LINK_REDIRECT_URI,
                    "code_challenge": challenge,
                    "code_challenge_method": "S256",
                    "state": state,
                    "resource": resource,
                },
                "decision": {"_tag": "pairing-code", "access": input.access, "code": input.pairing_code},
            }),
        ))
        .await
        .map_err(|_| stopped())?;
        let body: Value = serde_json::from_slice(&decided.body).map_err(|_| incompatible())?;
        if decided.status == 400 && body["_tag"] == "AuthMcpApprovalError" {
            return Err(PeerLinkError::new(
                "pairing_rejected",
                body["message"].as_str().unwrap_or_default(),
            ));
        }
        let Some(redirect) = body["redirectTo"]
            .as_str()
            .filter(|_| decided.status == 200)
        else {
            return Err(incompatible());
        };
        let Ok(redirect) = url::Url::parse(redirect) else {
            return Err(PeerLinkError::new(
                "incompatible",
                format!(
                    "{origin} answered the sign-in with an address this version cannot read. Update both environments."
                ),
            ));
        };
        let param = |name: &str| {
            redirect
                .query_pairs()
                .find(|(k, _)| k == name)
                .map(|(_, v)| v.into_owned())
        };
        let (Some(code), true) = (param("code"), param("state").as_deref() == Some(&state)) else {
            return Err(PeerLinkError::new(
                "pairing_rejected",
                param("error_description").unwrap_or_else(|| {
                    "The peer did not approve the link. Check the pairing code and try again."
                        .to_owned()
                }),
            ));
        };
        let form = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("grant_type", "authorization_code")
            .append_pair("code", &code)
            .append_pair("redirect_uri", LINK_REDIRECT_URI)
            .append_pair("client_id", client_id)
            .append_pair("code_verifier", &verifier)
            .append_pair("resource", &resource)
            .finish();
        let token = http::send(
            HttpRequest::new(Method::Post, format!("{origin}/oauth/mcp/token"))
                .header("content-type", "application/x-www-form-urlencoded")
                .body(form.into_bytes())
                .timeout(Duration::from_secs(30)),
        )
        .await
        .map_err(|_| stopped())?;
        let body: Value = serde_json::from_slice(&token.body).map_err(|_| incompatible())?;
        if token.status == 400
            && let Some(description) = body["error_description"].as_str()
        {
            return Err(PeerLinkError::new(
                "pairing_rejected",
                format!("The peer refused the sign-in: {description}"),
            ));
        }
        match (
            body["access_token"].as_str(),
            body["expires_in"].as_f64(),
            token.status,
        ) {
            (Some(access_token), Some(expires_in), 200) if expires_in >= 0.0 => {
                Ok((access_token.to_owned(), expires_in as u64))
            }
            _ => Err(incompatible()),
        }
    }

    /// `PeerLinks.link`.
    pub async fn link(self: &Arc<Self>, input: LinkInput) -> Result<Value, PeerLinkError> {
        if !self.enabled() {
            return Err(PeerLinkError::new("disabled", conn_mcp::LINKS_OFF_HERE));
        }
        if !crate::auth::is_mcp_access(&input.access) {
            return Err(PeerLinkError::new(
                "pairing_rejected",
                "Unknown access level.",
            ));
        }
        let urls = link_addresses(&input);
        let (primary, peer, origins) = match &input.expected_environment_id {
            None => self.answering_at(&urls).await?,
            Some(expected) => {
                let name = input
                    .expected_label
                    .clone()
                    .unwrap_or_else(|| expected.clone());
                self.answering_as(&urls, expected, &name).await?
            }
        };
        let peer_id = peer["environmentId"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        let peer_label = peer["label"].as_str().unwrap_or_default().to_owned();
        // An address alone renews a link only where the link already reaches it.
        if input.expected_environment_id.is_none()
            && let Some(existing) = self.read_row(&peer_id).await?
            && !existing.expired(now_ms())
            && !existing.urls.contains(&primary)
        {
            return Err(PeerLinkError::new(
                "pairing_rejected",
                format!(
                    "{primary} answers as {}, which is already linked at another address. If {} moved, forget that link first.",
                    existing.label, existing.label
                ),
            ));
        }
        if peer_id == self.own_id() {
            return Err(PeerLinkError::new(
                "self",
                "That address is this environment.",
            ));
        }
        if !link_limits_hold(&peer) {
            return Err(PeerLinkError::new(
                "incompatible",
                format!(
                    "{peer_label} runs a T3 Code version that cannot keep a linked agent's limits. Update it, then link again."
                ),
            ));
        }
        let (token, expires_in) = self
            .sign_in(&primary, &input, &format!("T3 Code · {}", self.own_label()))
            .await?;
        let now = now_ms();
        let row = Row {
            environment_id: peer_id.clone(),
            secret_name: format!("peer-link-{}", crate::auth::random_hex(16)),
            label: peer_label,
            urls: origins,
            access: input.access.clone(),
            linked_at_ms: now,
            expires_at_ms: now.saturating_add(expires_in.saturating_mul(1000)),
            last_reached_at_ms: Some(now),
            last_error: None,
        };
        let link = row.to_link();
        // The token goes under a name of its own before the row points at it.
        let (secret, value) = (row.secret_name.clone(), token);
        self.blocking(move |_, dir| {
            conn_support::secret_store::write(&dir, &secret, value.as_bytes()).map_err(storage)
        })
        .await?;
        let new_secret = row.secret_name.clone();
        let saved = self
            .change(move |rows| {
                let previous = rows
                    .iter()
                    .position(|r| r.environment_id == row.environment_id)
                    .map(|i| rows.remove(i));
                // Full: nothing changes, and the caller removes the new token.
                if previous.is_none() && rows.len() >= MAX_LINKS {
                    return None;
                }
                rows.push(row);
                Some(previous)
            })
            .await;
        let previous = match saved {
            Ok(Some(previous)) => previous,
            Ok(None) | Err(_) => {
                let secret = new_secret.clone();
                let _ = self
                    .blocking(move |_, dir| {
                        conn_support::secret_store::remove(&dir, &secret).map_err(storage)
                    })
                    .await;
                return Err(match saved {
                    Err(error) => error,
                    _ => PeerLinkError::new(
                        "storage",
                        format!(
                            "This environment keeps at most {MAX_LINKS} links. Forget one first."
                        ),
                    ),
                });
            }
        };
        if let Some(previous) = previous.filter(|p| p.secret_name != new_secret) {
            let _ = self
                .blocking(move |_, dir| {
                    conn_support::secret_store::remove(&dir, &previous.secret_name).map_err(storage)
                })
                .await;
        }
        Ok(link)
    }

    /// A peer's label follows its machine name.
    async fn with_label(&self, row: &mut Row, label: &str) {
        if row.label == label {
            return;
        }
        row.label = label.to_owned();
        let (id, label) = (row.environment_id.clone(), label.to_owned());
        let _ = self
            .change(move |rows| {
                if let Some(r) = rows.iter_mut().find(|r| r.environment_id == id) {
                    r.label = label;
                }
            })
            .await;
    }

    /// `PeerLinks.list`: every link with whether it answers now.
    pub async fn list(self: &Arc<Self>) -> Result<Vec<Value>, PeerLinkError> {
        let mut rows = self.read_rows().await?;
        rows.sort_by(|a, b| {
            (a.label.as_str(), a.environment_id.as_str())
                .cmp(&(b.label.as_str(), b.environment_id.as_str()))
        });
        let now = now_ms();
        let mut set = JoinSet::new();
        for (index, row) in rows.into_iter().enumerate() {
            let this = self.clone();
            set.spawn(async move {
                let mut row = row;
                let status = if row.expired(now) {
                    "expired"
                } else {
                    match this
                        .race_answers(&row.urls, &row.environment_id, Some(LIST_PROBE_TIMEOUT))
                        .await
                    {
                        Some((_, peer)) => {
                            let label = peer["label"].as_str().unwrap_or_default().to_owned();
                            this.with_label(&mut row, &label).await;
                            "reachable"
                        }
                        None => "unreachable",
                    }
                };
                let mut link = row.to_link();
                link["status"] = json!(status);
                (index, link)
            });
        }
        let mut out = Vec::new();
        while let Some(done) = set.join_next().await {
            if let Ok(entry) = done {
                out.push(entry);
            }
        }
        out.sort_by_key(|(index, _)| *index);
        Ok(out.into_iter().map(|(_, link)| link).collect())
    }

    /// `PeerLinks.unlink`: forgets the link here. The peer lists its session until revoked there.
    pub async fn unlink(&self, environment_id: &str) -> Result<bool, PeerLinkError> {
        let id = environment_id.to_owned();
        let removed = self
            .change(move |rows| {
                let before = rows.len();
                let mut gone = Vec::new();
                rows.retain(|r| {
                    let keep = r.environment_id != id;
                    if !keep {
                        gone.push(r.secret_name.clone());
                    }
                    keep
                });
                (before != rows.len(), gone)
            })
            .await?;
        let (removed, secrets) = removed;
        for secret in secrets {
            self.blocking(move |_, dir| {
                conn_support::secret_store::remove(&dir, &secret).map_err(storage)
            })
            .await?;
        }
        crate::lock(&self.sessions)
            .retain(|key, _| !key.starts_with(&format!("{environment_id} ")));
        Ok(removed)
    }

    /// `PeerLinks.resolve`: an address that still answers as the peer, with its token.
    async fn resolve(self: &Arc<Self>, environment_id: &str) -> Result<Resolved, PeerLinkError> {
        let not_linked = || {
            PeerLinkError::new(
                "unknown_link",
                format!(
                    "This environment is not linked to {environment_id}. t3_environment_links lists the linked ones."
                ),
            )
        };
        let Some(mut row) = self.read_row(environment_id).await? else {
            return Err(not_linked());
        };
        if row.expired(now_ms()) {
            return Err(PeerLinkError::new(
                "expired",
                format!(
                    "The link to {} expired. Link it again with a new pairing code from {}.",
                    row.label, row.label
                ),
            ));
        }
        let secret = row.secret_name.clone();
        let stored = self
            .blocking(move |_, dir| {
                conn_support::secret_store::read(&dir, &secret).map_err(storage)
            })
            .await?;
        let Some(token) = stored.and_then(|b| String::from_utf8(b).ok()) else {
            if self.read_row(environment_id).await?.is_none() {
                return Err(not_linked());
            }
            return Err(PeerLinkError::new(
                "unknown_link",
                format!(
                    "The link to {} lost its credential. Link it again.",
                    row.label
                ),
            ));
        };
        let Some((url, peer)) = self.race_answers(&row.urls, environment_id, None).await else {
            return Err(PeerLinkError::new(
                "unreachable",
                format!("{} did not answer at {}.", row.label, row.urls.join(", ")),
            ));
        };
        if !link_limits_hold(&peer) {
            return Err(PeerLinkError::new(
                "incompatible",
                format!(
                    "{} runs a T3 Code version that cannot keep a linked agent's limits. Update it, then link again.",
                    row.label
                ),
            ));
        }
        let label = peer["label"].as_str().unwrap_or_default().to_owned();
        self.with_label(&mut row, &label).await;
        Ok(Resolved { url, token })
    }

    async fn record_outcome(&self, environment_id: &str, error: Option<String>) {
        let id = environment_id.to_owned();
        let now = now_ms();
        let _ = self
            .change(move |rows| {
                if let Some(row) = rows.iter_mut().find(|r| r.environment_id == id) {
                    match error {
                        None => {
                            row.last_reached_at_ms = Some(now);
                            row.last_error = None;
                        }
                        Some(error) => row.last_error = Some(error),
                    }
                }
            })
            .await;
    }

    fn mcp_request(
        url: &str,
        token: &str,
        body: &Value,
        headers: &[(&'static str, String)],
    ) -> HttpRequest {
        let mut request = HttpRequest::new(Method::Post, format!("{url}/mcp"))
            .header("accept", "application/json, text/event-stream")
            .header("content-type", "application/json")
            .secret_header("authorization", "Bearer ", Secret::new(token))
            .body(body.to_string().into_bytes());
        for (name, value) in headers {
            request = request.header(name, value.clone());
        }
        request
    }

    async fn open_session(
        &self,
        url: &str,
        token: &str,
        limit: &(&'static str, String),
    ) -> Result<String, PeerFailure> {
        let timeout = probe_timeout(url);
        let open = async {
            let initialized = http::send(
                Self::mcp_request(
                    url,
                    token,
                    &json!({"jsonrpc": "2.0", "id": 0, "method": "initialize", "params": {
                        "protocolVersion": PROTOCOL_VERSION, "capabilities": {},
                        "clientInfo": {"name": "t3code-peer", "version": "1"},
                    }}),
                    std::slice::from_ref(limit),
                )
                .timeout(timeout),
            )
            .await
            .map_err(|_| failure("orchestration_error", STOPPED_ANSWERING))?;
            if initialized.status == 403 {
                return Err(failure(
                    "orchestration_error",
                    LINKED_ENVIRONMENTS_OFF_THERE,
                ));
            }
            let session = initialized.header("mcp-session-id").map(str::to_owned);
            let Some(session) = session.filter(|_| initialized.status == 200) else {
                return Err(if initialized.status == 401 {
                    failure("capability_denied", NO_LONGER_ACCEPTED)
                } else {
                    failure(
                        "orchestration_error",
                        format!(
                            "The linked environment refused to start an MCP session (HTTP {}).",
                            initialized.status
                        ),
                    )
                });
            };
            let _ = http::send(
                Self::mcp_request(
                    url,
                    token,
                    &json!({"jsonrpc": "2.0", "method": "notifications/initialized"}),
                    &[
                        limit.clone(),
                        ("mcp-session-id", session.clone()),
                        ("mcp-protocol-version", PROTOCOL_VERSION.to_owned()),
                    ],
                )
                .timeout(timeout),
            )
            .await;
            Ok(session)
        };
        tokio::time::timeout(timeout, open)
            .await
            .unwrap_or_else(|_| Err(failure("orchestration_error", STOPPED_ANSWERING)))
    }

    /// `PeerMcpClient.call`: runs a tool on the peer and returns its structured result.
    pub async fn call(self: &Arc<Self>, call: PeerCall) -> Result<Value, PeerFailure> {
        let outcome = self.call_once(&call).await;
        match &outcome {
            // A refusal is still an answer: the link works, so only this call fails.
            Ok(_) | Err(Answered::Refused(_)) => {
                self.record_outcome(&call.environment_id, None).await
            }
            Err(Answered::Failed(error)) => {
                self.record_outcome(&call.environment_id, Some(error.message.clone()))
                    .await;
            }
        }
        outcome.map_err(|e| match e {
            Answered::Refused(f) | Answered::Failed(f) => f,
        })
    }

    async fn call_once(self: &Arc<Self>, call: &PeerCall) -> Result<Value, Answered> {
        let resolved = self.resolve(&call.environment_id).await.map_err(|error| {
            let code = match error.reason {
                "unknown_link" => "invalid_request",
                "expired" | "incompatible" => "capability_denied",
                _ => "orchestration_error",
            };
            Answered::Failed(failure(code, error.message))
        })?;
        let limit = (
            "t3-mode-limit",
            format!(
                "{}/{}",
                call.limits.runtime_mode, call.limits.interaction_mode
            ),
        );
        let mut headers = vec![limit.clone()];
        if let Some(sender) = &call.sender {
            let title: String = sender.title.chars().take(SENDER_TITLE_MAX_CHARS).collect();
            headers.push((
                "t3-sender-thread",
                [
                    sender.environment_id.as_str(),
                    sender.thread_id.as_str(),
                    title.as_str(),
                ]
                .map(enc)
                .join("/"),
            ));
        }
        let key = format!("{} {}", call.environment_id, resolved.url);
        let existing = crate::lock(&self.sessions).get(&key).cloned();
        let session = match existing {
            Some(session) => session,
            None => {
                let session = self
                    .open_session(&resolved.url, &resolved.token, &limit)
                    .await
                    .map_err(Answered::Failed)?;
                self.remember_session(&key, &session);
                session
            }
        };
        let body = json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": {"name": call.tool, "arguments": Value::Object(call.arguments.clone())}});
        let send = |session: String| {
            let mut headers = headers.clone();
            headers.push(("mcp-session-id", session));
            headers.push(("mcp-protocol-version", PROTOCOL_VERSION.to_owned()));
            http::send(
                Self::mcp_request(&resolved.url, &resolved.token, &body, &headers)
                    .timeout(CALL_TIMEOUT),
            )
        };
        let stopped = || Answered::Failed(failure("orchestration_error", STOPPED_ANSWERING));
        let mut response = send(session).await.map_err(|_| stopped())?;
        // The peer keeps sessions in memory: after a restart it answers 404.
        if response.status == 404 {
            let renewed = self
                .open_session(&resolved.url, &resolved.token, &limit)
                .await
                .map_err(Answered::Failed)?;
            self.remember_session(&key, &renewed);
            response = send(renewed).await.map_err(|_| stopped())?;
        }
        match response.status {
            401 => {
                return Err(Answered::Failed(failure(
                    "capability_denied",
                    NO_LONGER_ACCEPTED,
                )));
            }
            403 => {
                return Err(Answered::Failed(failure(
                    "orchestration_error",
                    LINKED_ENVIRONMENTS_OFF_THERE,
                )));
            }
            200 => {}
            status => {
                return Err(Answered::Failed(failure(
                    "orchestration_error",
                    format!("The linked environment answered HTTP {status}."),
                )));
            }
        }
        let unexpected = || {
            Answered::Failed(failure(
                "orchestration_error",
                "The linked environment answered in an unexpected shape.",
            ))
        };
        let reply: Value =
            serde_json::from_str(&response_json(&response)).map_err(|_| unexpected())?;
        if let Some(message) = reply.get("error").and_then(|e| e["message"].as_str()) {
            return Err(Answered::Refused(failure("invalid_request", message)));
        }
        let Some(result) = reply.get("result").filter(|r| r.is_object()) else {
            return Err(Answered::Failed(failure(
                "invalid_request",
                "The linked environment returned no result.",
            )));
        };
        let Some(content) = result["content"].as_array() else {
            return Err(unexpected());
        };
        let text: String = content
            .iter()
            .map(|part| part["text"].as_str().unwrap_or_default())
            .collect();
        if result["isError"] == true {
            // A refusal keeps the peer's own code, so the agent sees why it was refused.
            let refused = serde_json::from_str::<Value>(&text).ok().and_then(|v| {
                let code = v["code"].as_str()?;
                let message = v["message"].as_str()?;
                (conn_mcp_failure_code(code) == code).then(|| failure(code, message))
            });
            return Err(Answered::Refused(refused.unwrap_or_else(|| {
                failure(
                    "orchestration_error",
                    if text.is_empty() {
                        "The linked environment refused the call.".to_owned()
                    } else {
                        text.clone()
                    },
                )
            })));
        }
        // Decoded with the tool's success shape, as `PeerMcpClient` does: `{}` for a launch is
        // not a launch.
        serde_json::from_str::<Value>(&text)
            .ok()
            .filter(|value| conn_mcp::tool_result_matches(&call.tool, value))
            .ok_or_else(|| {
                Answered::Failed(failure(
                    "orchestration_error",
                    "The linked environment's answer did not match this version. Update both environments.",
                ))
            })
    }

    fn remember_session(&self, key: &str, session: &str) {
        let mut sessions = crate::lock(&self.sessions);
        if !sessions.contains_key(key)
            && sessions.len() >= MAX_SESSIONS
            && let Some(old) = sessions.keys().next().cloned()
        {
            sessions.remove(&old);
        }
        sessions.insert(key.to_owned(), session.to_owned());
    }

    /// The stored link, without asking the peer.
    async fn get(&self, environment_id: &str) -> Result<Option<Row>, PeerLinkError> {
        self.read_row(environment_id).await
    }

    /// A stored link that has not expired.
    async fn usable_link(&self, environment_id: &str) -> Result<Option<Row>, PeerLinkError> {
        Ok(self
            .read_row(environment_id)
            .await?
            .filter(|r| !r.expired(now_ms())))
    }
}

/// The addresses a link tries, every one in the order given (`[url, ...alternateUrls]`);
/// the origins they reach are kept once each.
fn link_addresses(input: &LinkInput) -> Vec<String> {
    std::iter::once(&input.url)
        .chain(input.alternate_urls.iter().flatten())
        .cloned()
        .collect()
}

/// Why one descriptor request did not answer as a T3 environment.
enum Probed {
    Http(HttpError),
    NotT3,
}

impl Probed {
    /// A certificate this machine rejected: trying again would not change it.
    fn rejected_certificate(&self) -> bool {
        matches!(self, Probed::Http(HttpError::Transport { message, .. }) if message.contains("certificate"))
    }
}

/// The `ExecutionEnvironmentDescriptor` a 200 answer carries, when it has every field the
/// contract requires (`packages/contracts/src/environment.ts`).
fn descriptor_of(response: &HttpResponse) -> Option<Value> {
    if response.status != 200 {
        return None;
    }
    let descriptor: Value = serde_json::from_slice(&response.body).ok()?;
    let text = |key: &str| {
        descriptor[key]
            .as_str()
            .is_some_and(|value| !value.trim().is_empty())
    };
    let platform = &descriptor["platform"];
    let platform_ok = platform["os"]
        .as_str()
        .is_some_and(|os| matches!(os, "darwin" | "linux" | "windows" | "unknown"))
        && platform["arch"]
            .as_str()
            .is_some_and(|arch| matches!(arch, "arm64" | "x64" | "other"));
    (text("environmentId")
        && text("label")
        && text("serverVersion")
        && platform_ok
        && descriptor["capabilities"].is_object())
    .then_some(descriptor)
}

/// One address checked in `answering_as`, by its place in the list.
type Checked = (usize, Result<(String, Value), PeerLinkError>);

/// A card being answered; dropped, it frees the card for another answer.
struct Reservation {
    peers: Arc<PeerLinks>,
    item: String,
}

impl Drop for Reservation {
    fn drop(&mut self) {
        crate::lock(&self.peers.answering).remove(&self.item);
    }
}

/// A forwarded call's end: the peer refused (the link works) or the call failed.
enum Answered {
    Refused(PeerFailure),
    Failed(PeerFailure),
}

fn failure(code: &str, message: impl Into<String>) -> PeerFailure {
    PeerFailure {
        code: code.to_owned(),
        message: message.into(),
    }
}

/// The failure code as `/mcp` keeps it; an unknown one becomes `orchestration_error`.
fn conn_mcp_failure_code(code: &str) -> &str {
    const CODES: &[&str] = &[
        "capability_denied",
        "parent_not_active",
        "provider_unavailable",
        "model_unavailable",
        "runtime_mode_escalation_denied",
        "interaction_mode_escalation_denied",
        "task_not_found",
        "task_not_cancellable",
        "thread_not_found",
        "run_not_found",
        "thread_not_sendable",
        "thread_not_interruptible",
        "invalid_request",
        "orchestration_error",
        "thread_credential_required",
        "target_required",
    ];
    CODES.iter().find(|c| **c == code).copied().unwrap_or("")
}

fn read_file(file: &std::path::Path) -> Result<Vec<Row>, PeerLinkError> {
    match std::fs::read(file) {
        Ok(bytes) => serde_json::from_slice::<LinksFile>(&bytes)
            .map(|f| f.links)
            .map_err(storage),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(storage(error)),
    }
}

fn write_file(file: &std::path::Path, links: Vec<Row>) -> Result<(), PeerLinkError> {
    let bytes = serde_json::to_vec_pretty(&LinksFile { version: 1, links }).map_err(storage)?;
    conn_support::fs::write_private(file, &bytes).map_err(storage)
}

// ---- Link cards (`PeerLinkRequests.ts`) ----

/// Turn item ids are global: scope the key to the thread and the provider session.
fn card_id(thread_id: &str, namespace: &str, key: &str) -> String {
    format!(
        "turn-item:link-request:{}:{}:{}",
        enc(thread_id),
        enc(namespace),
        enc(key)
    )
}

fn card_result(card: &Value) -> Value {
    match card["linkStatus"].as_str().unwrap_or_default() {
        "pending" => json!({"status": "pending", "turnItemId": card["id"]}),
        "linked" => json!({
            "status": "linked",
            "environmentId": card["linkedEnvironmentId"],
            "label": card["linkedLabel"].as_str().map_or_else(|| link_target(card), str::to_owned),
            "access": card["linkedAccess"],
        }),
        "failed" => json!({
            "status": "failed",
            "message": card["failure"].as_str().unwrap_or("The link could not be made."),
        }),
        other => json!({"status": other}),
    }
}

fn link_target(card: &Value) -> String {
    card["url"]
        .as_str()
        .or(card["environmentId"].as_str())
        .unwrap_or("a machine")
        .to_owned()
}

/// What the answer tells the agent; never the pairing code.
fn outcome_notice(card: &Value, outcome: &Map<String, Value>) -> (String, Value) {
    let target = link_target(card);
    match outcome.get("linkStatus").and_then(Value::as_str) {
        Some("linked") => {
            let label = outcome
                .get("linkedLabel")
                .and_then(Value::as_str)
                .map_or_else(|| target.clone(), str::to_owned);
            (
                format!(
                    "The user linked {label} with {} access. Pass environmentId {} to act there.",
                    outcome
                        .get("linkedAccess")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                    outcome
                        .get("linkedEnvironmentId")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                ),
                json!({"source": {"kind": "background_task"}, "outcome": "completed", "summary": format!("Linked {label}")}),
            )
        }
        Some("failed") => (
            format!(
                "Linking {target} failed: {}. Call t3_environment_link again if the user still wants it.",
                outcome
                    .get("failure")
                    .and_then(Value::as_str)
                    .unwrap_or("the other environment refused")
            ),
            json!({"source": {"kind": "background_task"}, "outcome": "failed", "summary": format!("Could not link {target}")}),
        ),
        _ => (
            format!("The user declined to link {target}."),
            json!({"source": {"kind": "background_task"}, "outcome": "cancelled", "summary": format!("Declined to link {target}")}),
        ),
    }
}

fn linked_outcome(link: &Row) -> Map<String, Value> {
    let mut out = Map::new();
    out.insert("linkStatus".into(), json!("linked"));
    out.insert("linkedEnvironmentId".into(), json!(link.environment_id));
    out.insert("linkedLabel".into(), json!(link.label));
    out.insert("linkedAccess".into(), json!(link.access));
    out
}

fn failed_outcome(message: &str) -> Map<String, Value> {
    let mut out = Map::new();
    out.insert("linkStatus".into(), json!("failed"));
    out.insert("failure".into(), json!(message));
    out
}

/// `PeerLinkRequestError`.
pub fn request_error(reason: &str) -> Value {
    json!({"_tag": "PeerLinkRequestError", "reason": reason})
}

impl PeerLinks {
    async fn read_card(&self, thread_id: &str, item_id: &str) -> Result<Option<Value>, String> {
        let projection = self
            .engine
            .get_thread_projection(conn_contract::ThreadId::from(thread_id))
            .await
            .map_err(|e| format!("{e:?}"))?;
        if !projection["thread"]["deletedAt"].is_null() {
            return Ok(None);
        }
        Ok(projection["turnItems"].as_array().and_then(|items| {
            items
                .iter()
                .find(|i| i["id"] == item_id && i["type"] == "link_request")
                .cloned()
        }))
    }

    /// Records a card with `outcome`; only the answer that closes it carries `wake`.
    async fn record_card(
        &self,
        card: &Value,
        outcome: &Map<String, Value>,
        command_id: String,
        wake: bool,
    ) -> Result<(), String> {
        let mut command = json!({
            "commandId": command_id,
            "threadId": card["threadId"],
            "runId": card["runId"],
            "nodeId": card["nodeId"],
            "turnItemId": card["id"],
            "reason": card["reason"].as_str().unwrap_or_default(),
        });
        for key in ["url", "environmentId", "hint", "requestedAccess"] {
            if let Some(value) = card.get(key).filter(|v| !v.is_null()) {
                command[key] = value.clone();
            }
        }
        for (key, value) in outcome {
            command[key] = value.clone();
        }
        let own = card["id"].as_str().unwrap_or_default();
        let answering: Vec<String> = crate::lock(&self.answering)
            .iter()
            .filter(|id| id.as_str() != own)
            .cloned()
            .collect();
        command["answeringTurnItemIds"] = json!(answering);
        if wake {
            let (text, notification) = outcome_notice(card, outcome);
            command["wake"] = json!({
                "messageId": format!("message:link-request:{}", card["id"].as_str().unwrap_or_default()),
                "text": text,
                "notification": notification,
            });
        }
        self.engine.record_link_request(command).await
    }

    /// `PeerLinkRequests.request`: a card in the calling thread, answered later.
    pub async fn request_link(self: &Arc<Self>, ask: LinkAsk) -> Result<Value, PeerFailure> {
        let arg = |key: &str| {
            ask.arguments
                .get(key)
                .and_then(Value::as_str)
                .map(str::to_owned)
        };
        let unreadable = |e: String| {
            failure(
                "orchestration_error",
                format!("Unable to read the link request: {e}"),
            )
        };
        if arg("url").is_some() && arg("environmentId").is_some() {
            return Err(failure(
                "invalid_request",
                "Pass either environmentId or url, not both. Pass neither to let the user pick the machine.",
            ));
        }
        if let Some(environment) = arg("environmentId")
            && let Some(link) = self
                .usable_link(&environment)
                .await
                .map_err(|e| failure("orchestration_error", e.message))?
        {
            if let Some(key) = arg("clientRequestId") {
                let id = card_id(&ask.thread_id, &ask.namespace, &key);
                if let Ok(Some(card)) = self.read_card(&ask.thread_id, &id).await
                    && card["linkStatus"] == "pending"
                    && card["runId"].is_string()
                    && card["nodeId"].is_string()
                {
                    let _ = self
                        .record_card(
                            &card,
                            &linked_outcome(&link),
                            format!("link-request:{id}:linked-on-retry"),
                            false,
                        )
                        .await;
                }
            }
            return Ok(json!({
                "status": "linked",
                "environmentId": link.environment_id,
                "label": link.label,
                "access": link.access,
            }));
        }
        let key = arg("clientRequestId").unwrap_or_else(conn_support::uuid_v4);
        let item_id = card_id(&ask.thread_id, &ask.namespace, &key);
        if arg("clientRequestId").is_some()
            && let Some(card) = self
                .read_card(&ask.thread_id, &item_id)
                .await
                .map_err(unreadable)?
        {
            return Ok(card_result(&card));
        }
        let projection = self
            .engine
            .get_thread_projection(conn_contract::ThreadId::from(ask.thread_id.as_str()))
            .await
            .map_err(|e| unreadable(format!("{e:?}")))?;
        let run = projection["runs"].as_array().and_then(|runs| {
            runs.iter()
                .filter(|r| {
                    matches!(
                        r["status"].as_str(),
                        Some("preparing" | "starting" | "running" | "waiting")
                    )
                })
                .max_by_key(|r| r["ordinal"].as_i64().unwrap_or_default())
                .cloned()
        });
        let Some(run) = run.filter(|r| {
            r["rootNodeId"].is_string()
                && r["providerInstanceId"].as_str() == Some(ask.provider_instance_id.as_str())
        }) else {
            return Err(failure(
                "parent_not_active",
                "Asking to link an environment requires an active run owned by this MCP provider session.",
            ));
        };
        let mut card = json!({
            "id": item_id,
            "threadId": ask.thread_id,
            "runId": run["id"],
            "nodeId": run["rootNodeId"],
            "reason": arg("reason").unwrap_or_default(),
        });
        for key in ["url", "environmentId", "hint", "requestedAccess"] {
            if let Some(value) = arg(key) {
                card[key] = json!(value);
            }
        }
        let mut pending = Map::new();
        pending.insert("linkStatus".into(), json!("pending"));
        self.record_card(
            &card,
            &pending,
            format!(
                "command:mcp:{}:link-pending:{}",
                enc(&ask.namespace),
                enc(&key)
            ),
            false,
        )
        .await
        .map_err(|e| {
            failure(
                "orchestration_error",
                format!("Could not record the link request: {e}"),
            )
        })?;
        Ok(json!({"status": "pending", "turnItemId": item_id}))
    }

    /// `PeerLinkRequests.answer`: links the machine the user picked and tells the agent.
    pub async fn answer(self: &Arc<Self>, input: Value) -> Result<(), Value> {
        let thread = input["threadId"].as_str().unwrap_or_default().to_owned();
        let item = input["turnItemId"].as_str().unwrap_or_default().to_owned();
        {
            let mut answering = crate::lock(&self.answering);
            if answering.contains(&item) || answering.len() >= MAX_ANSWERING {
                // A second answer racing on one card must not link twice.
                return Err(request_error("already_answered"));
            }
            answering.insert(item.clone());
        }
        let reservation = Reservation {
            peers: self.clone(),
            item: item.clone(),
        };
        // Its own task: once linking may spend the pairing code, the answer finishes and its
        // outcome is recorded even when the client that sent it goes away.
        let this = self.clone();
        let answer = input["answer"].clone();
        tokio::spawn(async move {
            let _reservation = reservation;
            this.answer_card(&thread, &item, &answer).await
        })
        .await
        .unwrap_or_else(|_| Err(request_error("record_failed")))
    }

    async fn answer_card(
        self: &Arc<Self>,
        thread: &str,
        item: &str,
        answer: &Value,
    ) -> Result<(), Value> {
        let card = self
            .read_card(thread, item)
            .await
            .map_err(|_| request_error("load_failed"))?;
        let Some(card) = card.filter(|c| c["runId"].is_string() && c["nodeId"].is_string()) else {
            return Err(request_error("not_found"));
        };
        if card["linkStatus"] != "pending" {
            return Err(request_error("already_answered"));
        }
        let outcome = if card["url"].is_string()
            && card["environmentId"].is_string()
            && answer["type"] == "link"
            && answer["environmentId"].is_string()
        {
            failed_outcome("This request is from before an update. Ask for the link again.")
        } else {
            match answer["type"].as_str() {
                Some("use-existing") => {
                    let id = answer["environmentId"].as_str().unwrap_or_default();
                    match self.usable_link(id).await {
                        Ok(Some(link)) => linked_outcome(&link),
                        Ok(None) => failed_outcome(
                            "That environment is no longer linked here, or its link expired. Link it again.",
                        ),
                        Err(error) => failed_outcome(&error.message),
                    }
                }
                Some("link") => {
                    let urls: Vec<String> = answer["urls"]
                        .as_array()
                        .map(|u| {
                            u.iter()
                                .filter_map(Value::as_str)
                                .map(str::to_owned)
                                .collect()
                        })
                        .unwrap_or_default();
                    let input = LinkInput {
                        url: urls.first().cloned().unwrap_or_default(),
                        alternate_urls: urls
                            .get(1..)
                            .filter(|rest| !rest.is_empty())
                            .map(<[String]>::to_vec),
                        pairing_code: answer["pairingCode"]
                            .as_str()
                            .unwrap_or_default()
                            .to_owned(),
                        access: answer["access"].as_str().unwrap_or_default().to_owned(),
                        expected_environment_id: answer["environmentId"]
                            .as_str()
                            .map(str::to_owned),
                        expected_label: answer["label"].as_str().map(str::to_owned),
                    };
                    match self.link(input).await {
                        Ok(link) => {
                            let mut out = Map::new();
                            out.insert("linkStatus".into(), json!("linked"));
                            out.insert("linkedEnvironmentId".into(), link["environmentId"].clone());
                            out.insert("linkedLabel".into(), link["label"].clone());
                            out.insert("linkedAccess".into(), link["access"].clone());
                            out
                        }
                        Err(error) => failed_outcome(&error.message),
                    }
                }
                _ => {
                    let mut out = Map::new();
                    out.insert("linkStatus".into(), json!("declined"));
                    out
                }
            }
        };
        let status = outcome
            .get("linkStatus")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        self.record_card(
            &card,
            &outcome,
            format!("link-request:{item}:{status}"),
            true,
        )
        .await
        .map_err(|_| request_error("record_failed"))
    }
}

/// `/mcp`'s view of the links.
#[derive(Debug)]
pub struct McpPeers(pub Arc<PeerLinks>);

impl Peers for McpPeers {
    fn enabled(&self) -> bool {
        self.0.enabled()
    }

    fn list(&self) -> BoxFuture<'_, Result<Vec<Value>, String>> {
        Box::pin(async move { self.0.list().await.map_err(|e| e.message) })
    }

    fn get(&self, environment_id: &str) -> BoxFuture<'_, Result<Option<LinkInfo>, String>> {
        let id = environment_id.to_owned();
        Box::pin(async move {
            let row = self.0.get(&id).await.map_err(|e| e.message)?;
            Ok(row.map(|r| LinkInfo {
                expired: r.expired(now_ms()),
                label: r.label,
                access: r.access,
            }))
        })
    }

    fn unlink(&self, environment_id: &str) -> BoxFuture<'_, Result<bool, String>> {
        let id = environment_id.to_owned();
        Box::pin(async move { self.0.unlink(&id).await.map_err(|e| e.message) })
    }

    fn call(&self, call: PeerCall) -> BoxFuture<'_, Result<Value, PeerFailure>> {
        Box::pin(async move { self.0.call(call).await })
    }

    fn request_link(&self, ask: LinkAsk) -> BoxFuture<'_, Result<Value, PeerFailure>> {
        Box::pin(async move { self.0.request_link(ask).await })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Peer links on a fresh state folder with links on, and an engine whose thread has an
    /// active run (the fake provider's `hang`). Returns the links and that thread's id.
    async fn links_with_a_running_thread(name: &str) -> (Arc<PeerLinks>, String) {
        let dir =
            std::env::temp_dir().join(format!("conn-peers-{name}-{}", conn_support::uuid_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("settings.json"),
            r#"{"linkedEnvironmentsEnabled":true}"#,
        )
        .unwrap();
        let environment = Arc::new(
            Environment::load(&dir, Some("Here".into()), dir.clone(), Default::default()).unwrap(),
        );
        let mut config = conn_engine::EngineConfig::new(dir.join("engine.sqlite"));
        config.projects = vec![conn_engine::ProjectConfig {
            title: "P".into(),
            workspace_root: "/tmp/conn-peers-p".into(),
        }];
        let fake: Arc<dyn conn_provider::Provider> =
            Arc::new(conn_engine::fake::FakeProvider::new("claudeAgent"));
        config.provider_set = Some(conn_provider::ProviderSet::from(vec![fake]));
        let engine: Arc<dyn Engine> = Arc::new(conn_engine::SqliteEngine::open(config).unwrap());
        let launched = engine
            .launch_thread(json!({
                "commandId": "launch", "threadId": "thread:card",
                "projectId": conn_engine::SqliteEngine::project_id_for("/tmp/conn-peers-p"),
                "title": "Agent", "runtimeMode": "full-access", "interactionMode": "default",
                "modelSelection": {"instanceId": "claudeAgent", "model": "claude-haiku-5-5"},
                "workspaceStrategy": {"type": "root"},
                "initialMessage": {"messageId": "m", "text": "hang", "attachments": []},
            }))
            .await
            .unwrap();
        let thread = launched["projection"]["thread"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        (PeerLinks::new(environment, engine), thread)
    }

    /// A loopback port that accepts connections and never answers; counts those open at once.
    async fn silent_peer(
        open: Arc<std::sync::atomic::AtomicUsize>,
        most: Arc<std::sync::atomic::AtomicUsize>,
    ) -> String {
        use std::sync::atomic::Ordering;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let now = open.fetch_add(1, Ordering::SeqCst) + 1;
                most.fetch_max(now, Ordering::SeqCst);
                let open = open.clone();
                tokio::spawn(async move {
                    use tokio::io::AsyncReadExt;
                    let mut buf = [0u8; 1024];
                    while matches!(socket.read(&mut buf).await, Ok(n) if n > 0) {}
                    open.fetch_sub(1, Ordering::SeqCst);
                });
            }
        });
        format!("http://{addr}")
    }

    /// A good `ExecutionEnvironmentDescriptor` for `environmentId` `environment:peer`.
    fn good_descriptor() -> Value {
        json!({
            "environmentId": "environment:peer", "label": "Peer",
            "platform": {"os": "linux", "arch": "x64"}, "serverVersion": "0.0.46",
            "capabilities": {"mcpModeLimitHeader": true, "linkFence": true},
        })
    }

    /// A loopback peer: `GET /.well-known/t3/environment` answers the next of `descriptors`
    /// (the last one repeats) and counts the requests; `POST /mcp` opens a session and answers
    /// `tools/call` with `tool_text` as its one text part.
    async fn fake_peer(
        descriptors: Vec<(u16, String)>,
        tool_text: &'static str,
    ) -> (String, Arc<std::sync::atomic::AtomicUsize>) {
        use std::sync::atomic::Ordering;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let probes = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counted = probes.clone();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let (counted, descriptors) = (counted.clone(), descriptors.clone());
                tokio::spawn(async move {
                    let mut bytes = Vec::new();
                    let mut buf = [0u8; 4096];
                    let (head, body) = loop {
                        let n = socket.read(&mut buf).await.unwrap_or(0);
                        if n == 0 {
                            return;
                        }
                        bytes.extend_from_slice(&buf[..n]);
                        let text = String::from_utf8_lossy(&bytes).into_owned();
                        if let Some((head, body)) = text.split_once("\r\n\r\n") {
                            let length = head
                                .lines()
                                .find_map(|l| {
                                    l.to_ascii_lowercase()
                                        .strip_prefix("content-length:")
                                        .map(|v| v.trim().parse::<usize>().unwrap_or(0))
                                })
                                .unwrap_or(0);
                            if body.len() >= length {
                                break (head.to_owned(), body.to_owned());
                            }
                        }
                    };
                    let (status, content_type, extra, reply) = if head.starts_with("GET ") {
                        let n = counted.fetch_add(1, Ordering::SeqCst);
                        let (status, body) = descriptors[n.min(descriptors.len() - 1)].clone();
                        (status, "application/json", "", body)
                    } else {
                        let request: Value = serde_json::from_str(&body).unwrap_or_default();
                        match request["method"].as_str() {
                            Some("initialize") => (
                                200,
                                "application/json",
                                "mcp-session-id: s1\r\n",
                                json!({"jsonrpc": "2.0", "id": 0, "result": {}}).to_string(),
                            ),
                            Some("tools/call") => (
                                200,
                                "application/json",
                                "",
                                json!({"jsonrpc": "2.0", "id": 1, "result": {
                                    "content": [{"type": "text", "text": tool_text}],
                                }})
                                .to_string(),
                            ),
                            _ => (202, "application/json", "", String::new()),
                        }
                    };
                    let response = format!(
                        "HTTP/1.1 {status} X\r\ncontent-type: {content_type}\r\n{extra}content-length: {}\r\nconnection: close\r\n\r\n{reply}",
                        reply.len()
                    );
                    let _ = socket.write_all(response.as_bytes()).await;
                    let _ = socket.shutdown().await;
                });
            }
        });
        (format!("http://{addr}"), probes)
    }

    /// One 503 from a live peer is retried, as T3 retries any failure but a rejected
    /// certificate (`PeerLinks.test.ts`: "one dropped descriptor request does not list a live
    /// peer as unreachable").
    #[tokio::test(flavor = "current_thread")]
    async fn one_dropped_descriptor_request_is_retried() {
        let (peers, _) = links_with_a_running_thread("retry").await;
        let (url, probes) = fake_peer(
            vec![(503, String::new()), (200, good_descriptor().to_string())],
            "{}",
        )
        .await;
        let found = peers.probe(&url).await.unwrap();
        assert_eq!(found["environmentId"], "environment:peer");
        assert_eq!(probes.load(std::sync::atomic::Ordering::SeqCst), 2);
    }

    /// A descriptor without a required field is not a T3 environment, before any sign-in
    /// (`ExecutionEnvironmentDescriptor`: `platform` and `serverVersion` are required).
    #[tokio::test(flavor = "current_thread")]
    async fn a_descriptor_missing_required_fields_is_refused() {
        let (peers, _) = links_with_a_running_thread("descriptor").await;
        for missing in ["platform", "serverVersion"] {
            let mut descriptor = good_descriptor();
            descriptor.as_object_mut().unwrap().remove(missing);
            let (url, _) = fake_peer(vec![(200, descriptor.to_string())], "{}").await;
            let refused = peers.probe(&url).await.unwrap_err();
            assert_eq!(refused.reason, "not_a_t3_environment", "without {missing}");
        }
        let mut descriptor = good_descriptor();
        descriptor["platform"]["os"] = json!("plan9");
        let (url, _) = fake_peer(vec![(200, descriptor.to_string())], "{}").await;
        assert_eq!(
            peers.probe(&url).await.unwrap_err().reason,
            "not_a_t3_environment"
        );
    }

    /// A forwarded result is decoded with the tool's success shape (`PeerMcpClient`): a peer
    /// answering `{}` to `t3_thread_launch` did not launch anything.
    #[tokio::test(flavor = "current_thread")]
    async fn a_forwarded_result_must_match_the_tool() {
        let (peers, _) = links_with_a_running_thread("shape").await;
        let (url, _) = fake_peer(vec![(200, good_descriptor().to_string())], "{}").await;
        let now = now_ms();
        peers
            .change(move |rows| {
                rows.push(Row {
                    environment_id: "environment:peer".into(),
                    secret_name: "peer-link-test".into(),
                    label: "Peer".into(),
                    urls: vec![url],
                    access: "auto".into(),
                    linked_at_ms: now,
                    expires_at_ms: now + 60_000,
                    last_reached_at_ms: None,
                    last_error: None,
                })
            })
            .await
            .unwrap();
        conn_support::secret_store::write(&peers.secrets_dir, "peer-link-test", b"token").unwrap();
        let refused = peers
            .call(PeerCall {
                environment_id: "environment:peer".into(),
                tool: "t3_thread_launch".into(),
                arguments: Map::new(),
                limits: conn_mcp::PeerLimits {
                    runtime_mode: "full-access".into(),
                    interaction_mode: "default".into(),
                },
                sender: None,
            })
            .await
            .unwrap_err();
        assert_eq!(refused.code, "orchestration_error");
        assert_eq!(
            refused.message,
            "The linked environment's answer did not match this version. Update both environments."
        );
    }

    /// The answer to a link card finishes, and frees the card, after the client that sent it
    /// went away mid-link.
    #[tokio::test(flavor = "current_thread")]
    async fn a_link_answer_outlives_its_client() {
        let (peers, thread) = links_with_a_running_thread("answer").await;
        let pending = peers
            .request_link(LinkAsk {
                thread_id: thread.clone(),
                provider_instance_id: "claudeAgent".into(),
                namespace: "p".into(),
                arguments: json!({"reason": "test", "clientRequestId": "k"})
                    .as_object()
                    .cloned()
                    .unwrap(),
            })
            .await
            .unwrap();
        let card = pending["turnItemId"].as_str().unwrap().to_owned();
        let counter = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let peer = silent_peer(counter.clone(), counter.clone()).await;
        let answer = json!({"threadId": thread, "turnItemId": card, "answer": {
            "type": "link", "urls": [peer], "access": "auto", "pairingCode": "ABCDEFGHJKLM",
        }});
        // The client goes away while the peer is still being probed.
        let dropped =
            tokio::time::timeout(Duration::from_millis(100), peers.answer(answer.clone())).await;
        assert!(dropped.is_err(), "the answer was still linking");
        let mut status = String::new();
        for _ in 0..200 {
            let found = peers.read_card(&thread, &card).await.unwrap().unwrap();
            status = found["linkStatus"].as_str().unwrap_or_default().to_owned();
            if status != "pending" {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert_eq!(
            status, "failed",
            "the outcome was recorded after the client left"
        );
        assert!(
            crate::lock(&peers.answering).is_empty(),
            "the card was freed"
        );
    }

    /// Every address supplied is checked (`PeerLinks.link` probes them all); probes in flight
    /// at once are bounded.
    #[tokio::test(flavor = "current_thread")]
    async fn every_address_is_checked_and_probes_bounded() {
        let (peers, _) = links_with_a_running_thread("caps").await;
        let mut alternates: Vec<String> = (0..30)
            .map(|n| format!("http://127.0.0.1:{}", 20_000 + n))
            .collect();
        alternates.extend(alternates.clone());
        let refused = peers
            .link(LinkInput {
                url: "http://127.0.0.1:20000".into(),
                alternate_urls: Some(alternates),
                pairing_code: "X".into(),
                access: "auto".into(),
                expected_environment_id: Some("environment:peer".into()),
                expected_label: Some("Peer".into()),
            })
            .await
            .unwrap_err();
        assert_eq!(
            refused.message.matches("is this machine").count(),
            61,
            "{}",
            refused.message
        );
        let (open, most) = (
            Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            Arc::new(std::sync::atomic::AtomicUsize::new(0)),
        );
        let mut set = JoinSet::new();
        for _ in 0..40 {
            let url = silent_peer(open.clone(), most.clone()).await;
            let peers = peers.clone();
            set.spawn(async move { peers.probe(&url).await.is_err() });
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert!(
            most.load(std::sync::atomic::Ordering::SeqCst) <= MAX_PROBES,
            "{} probes at once",
            most.load(std::sync::atomic::Ordering::SeqCst)
        );
        set.abort_all();
    }

    #[test]
    fn checks_which_addresses_may_receive_credentials() {
        assert_eq!(
            peer_origin("http://127.0.0.1:3773/x").unwrap(),
            "http://127.0.0.1:3773"
        );
        assert_eq!(
            peer_origin("http://10.44.0.7:3773").unwrap(),
            "http://10.44.0.7:3773"
        );
        assert_eq!(
            peer_origin("https://box.example.test").unwrap(),
            "https://box.example.test"
        );
        assert_eq!(
            peer_origin("http://box.tail1234.ts.net:3773").unwrap(),
            "http://box.tail1234.ts.net:3773"
        );
        let plain = peer_origin("http://192.168.1.5:3773").unwrap_err();
        assert_eq!(plain.reason, "unreachable");
        assert!(plain.message.contains("plain http"), "{}", plain.message);
        assert!(
            peer_origin("127.0.0.1:3773")
                .unwrap_err()
                .message
                .ends_with("is not an http or https address.")
        );
        assert!(is_loopback_host("[::1]"));
        assert!(!is_loopback_host("128.0.0.1"));
    }

    #[test]
    fn reads_sse_and_json_answers() {
        let sse = HttpResponse {
            status: 200,
            headers: vec![("content-type".into(), "text/event-stream".into())],
            body: b"event: message\ndata: {\"a\":1}\n\n".to_vec(),
            truncated: false,
        };
        assert_eq!(response_json(&sse), "{\"a\":1}");
        assert_eq!(card_id("t", "p:1", "k"), "turn-item:link-request:t:p%3A1:k");
    }
}
