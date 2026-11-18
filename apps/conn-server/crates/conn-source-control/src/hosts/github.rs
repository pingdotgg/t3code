//! GitHub (`packages/source-control-github`): discovery, and the REST request every later
//! operation sends.
//!
//! Discovery is the managed probe of `GitHubSourceControlProvider.makeDiscovery`: `gh --version`
//! and `gh auth status --json hosts`, then `GET /user` when a token is saved in Settings or set
//! in `GH_TOKEN`/`GITHUB_TOKEN`, because `gh auth status` may not know those.
//!
//! Not built: the GitHub App sign-in. This server behaves as a T3 server without
//! `T3CODE_GITHUB_APP_CLIENT_ID`: no `appSignIn` offer, and a saved sign-in is not used.

use conn_contract::{
    ServerProviderAuthStatus, SourceControlDiscoveryStatus, SourceControlProviderAuth,
    SourceControlProviderAuthAccountsItem, SourceControlProviderDiscoveryItem,
};
use serde::Deserialize;

use super::{DiscoveryContext, Environment};
use crate::{
    discovery::{
        CliSpec, DEFAULT_PROBE_TIMEOUT, ProbeContext, ProbeOutput, first_safe_auth_line, probe_cli,
        provider_auth,
    },
    http::{self, HttpRequest, HttpResponse, Method},
    secret::Secret,
    settings::HostSettings,
};

pub const KIND: &str = "github";
const INSTALL_HINT: &str = "Install the GitHub command-line tool (`gh`) via https://cli.github.com/ or your package manager (for example `brew install gh`).";
/// `REQUEST_HEADERS` in `GitHubRequestPolicy.ts`.
pub const API_VERSION: &str = "2022-11-28";
pub const USER_AGENT: &str = "t3code";

fn spec() -> CliSpec {
    CliSpec {
        kind: KIND,
        label: "GitHub",
        executable: "gh",
        version_args: &["--version"],
        auth_args: vec![
            "auth".into(),
            "status".into(),
            "--json".into(),
            "hosts".into(),
        ],
        probe_timeout: DEFAULT_PROBE_TIMEOUT,
        install_hint: INSTALL_HINT,
    }
}

/// One `gh auth status --json hosts` account (`GitHubAuthStatusAccount`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuthAccount {
    pub host: String,
    pub account: String,
    pub authenticated: bool,
    pub active: bool,
    pub error: Option<String>,
    pub environment_variable: Option<String>,
}

#[derive(Deserialize)]
struct RawAccount {
    state: String,
    #[serde(default)]
    error: Option<String>,
    active: bool,
    host: String,
    login: String,
    #[serde(default, rename = "tokenSource")]
    token_source: Option<String>,
}

/// `hosts` in JSON key order, as `Object.values` walks it.
struct OrderedHosts(Vec<Vec<RawAccount>>);

impl<'de> Deserialize<'de> for OrderedHosts {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Visit;
        impl<'de> serde::de::Visitor<'de> for Visit {
            type Value = OrderedHosts;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("an object of account lists")
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                mut map: A,
            ) -> Result<Self::Value, A::Error> {
                let mut out = Vec::new();
                while let Some((_, accounts)) = map.next_entry::<String, Vec<RawAccount>>()? {
                    out.push(accounts);
                }
                Ok(OrderedHosts(out))
            }
        }
        deserializer.deserialize_map(Visit)
    }
}

#[derive(Deserialize)]
struct RawStatus {
    hosts: OrderedHosts,
}

fn is_environment_token_source(source: &str) -> bool {
    // `/^(?:GH|GITHUB)_(?:ENTERPRISE_)?TOKEN$/u`
    let rest = source
        .strip_prefix("GH_")
        .or_else(|| source.strip_prefix("GITHUB_"));
    matches!(rest, Some("TOKEN" | "ENTERPRISE_TOKEN"))
}

/// `parseGitHubAuthStatus`: `None` when stdout is not that JSON shape.
pub fn parse_auth_status(stdout: &str) -> Option<Vec<AuthAccount>> {
    let status: RawStatus = serde_json::from_str(stdout).ok()?;
    Some(
        status
            .hosts
            .0
            .into_iter()
            .flatten()
            .filter_map(|raw| {
                let host = raw.host.trim();
                let login = raw.login.trim();
                if host.is_empty() || login.is_empty() {
                    return None;
                }
                Some(AuthAccount {
                    host: host.to_lowercase(),
                    account: login.to_owned(),
                    authenticated: raw.state == "success",
                    active: raw.active,
                    error: raw
                        .error
                        .map(|e| e.trim().to_owned())
                        .filter(|e| !e.is_empty()),
                    environment_variable: raw
                        .token_source
                        .filter(|s| is_environment_token_source(s)),
                })
            })
            .collect(),
    )
}

/// `findAuthenticatedGitHubAccount`.
fn find_authenticated<'a>(
    accounts: impl Iterator<Item = &'a AuthAccount> + Clone,
) -> Option<&'a AuthAccount> {
    accounts
        .clone()
        .find(|a| a.authenticated && a.active)
        .or_else(|| accounts.into_iter().find(|a| a.authenticated))
}

/// `effectiveGitHubAccount`.
fn effective_account<'a>(
    host: &str,
    accounts: &'a [AuthAccount],
    settings: &HostSettings<'_>,
) -> Option<&'a AuthAccount> {
    if !settings.host_enabled(host) {
        return None;
    }
    let usable = accounts
        .iter()
        .filter(|a| a.host == host && a.authenticated);
    usable
        .clone()
        .find(|a| a.environment_variable.is_some())
        .or_else(|| {
            settings
                .host_account(host)
                .and_then(|pinned| usable.clone().find(|a| a.account == pinned))
        })
        .or_else(|| find_authenticated(usable))
}

fn account_rows(accounts: &[AuthAccount]) -> Vec<SourceControlProviderAuthAccountsItem> {
    accounts
        .iter()
        .map(|a| SourceControlProviderAuthAccountsItem {
            host: a.host.clone(),
            account: a.account.clone(),
            active: a.active,
            authenticated: a.authenticated,
            error: a.error.clone(),
            environment_variable: a.environment_variable.clone(),
        })
        .collect()
}

/// `parseGitHubAuth`.
pub fn parse_auth(output: &ProbeOutput, settings: &HostSettings<'_>) -> SourceControlProviderAuth {
    use ServerProviderAuthStatus::{Authenticated, Unauthenticated, Unknown};
    let combined = output.combined();
    let parsed = parse_auth_status(&output.stdout);
    let accounts = parsed.as_deref().unwrap_or_default();
    let with_rows = |mut auth: SourceControlProviderAuth| {
        if parsed.is_some() {
            auth.accounts = Some(account_rows(accounts));
        }
        auth
    };
    let mut hosts: Vec<&str> = Vec::new();
    for account in accounts {
        if !hosts.contains(&account.host.as_str()) {
            hosts.push(&account.host);
        }
    }
    let fallback = find_authenticated(accounts.iter());
    let ordered = fallback.map(|f| f.host.as_str()).into_iter().chain(
        hosts
            .iter()
            .copied()
            .filter(|h| Some(*h) != fallback.map(|f| f.host.as_str())),
    );
    let chosen = ordered
        .into_iter()
        .find_map(|host| effective_account(host, accounts, settings));

    if let Some(chosen) = chosen {
        let detail = chosen.environment_variable.as_ref().map(|var| {
            format!("Using {var} from the server environment; it overrides the account chosen in Settings.")
        });
        return with_rows(provider_auth(
            Authenticated,
            Some(&chosen.account),
            Some(&chosen.host),
            detail.as_deref(),
        ));
    }
    if let Some(fallback) = fallback {
        return with_rows(provider_auth(
            Unauthenticated,
            None,
            Some(&fallback.host),
            Some(
                "Every GitHub host gh is signed in to is turned off in Settings → Source control & issues.",
            ),
        ));
    }
    if parsed.is_some() {
        let failed = accounts
            .iter()
            .find(|a| a.active)
            .or_else(|| accounts.first());
        return with_rows(provider_auth(
            Unauthenticated,
            None,
            failed.map(|a| a.host.as_str()),
            Some(failed.and_then(|a| a.error.as_deref()).unwrap_or(
                "Run `gh auth login` to authenticate GitHub CLI with an active account.",
            )),
        ));
    }
    if output.exit_code != 0 && combined.contains("unknown flag: --json") {
        return provider_auth(
            Unknown,
            None,
            None,
            Some(
                "GitHub CLI is too old to report sign-in status. Update `gh` to 2.81.0 or newer (for example `brew upgrade gh`) and rescan.",
            ),
        );
    }
    if output.exit_code != 0 {
        return provider_auth(
            Unauthenticated,
            None,
            None,
            Some(
                &first_safe_auth_line(&combined)
                    .unwrap_or_else(|| "Run `gh auth login` to authenticate GitHub CLI.".into()),
            ),
        );
    }
    provider_auth(
        Unknown,
        None,
        None,
        Some(
            &first_safe_auth_line(&combined)
                .unwrap_or_else(|| "GitHub CLI auth status could not be parsed.".into()),
        ),
    )
}

/// `gitHubApiUrls(host).rest`.
pub fn rest_root(host: &str) -> String {
    if host == "github.com" {
        "https://api.github.com".into()
    } else if host.ends_with(".ghe.com") {
        format!("https://api.{host}")
    } else {
        format!("https://{host}/api/v3")
    }
}

/// Why a REST request failed, with the T3 error's `message`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ApiError {
    /// `GitHubApiAuthenticationError` (401).
    Authentication {
        host: String,
    },
    RateLimit,
    NotFound {
        messages: Vec<String>,
    },
    Response {
        status: u16,
        messages: Vec<String>,
    },
    Request {
        host: String,
    },
}

impl ApiError {
    pub fn message(&self) -> String {
        match self {
            ApiError::Authentication { host } => format!(
                "GitHub refused the credential for {host}. Run `gh auth login --hostname {host}` and retry."
            ),
            ApiError::RateLimit => "GitHub API rate limit exceeded.".into(),
            ApiError::NotFound { messages } => {
                let missing = "GitHub could not find the requested resource, or the credential cannot see it.";
                if messages.is_empty() {
                    missing.into()
                } else {
                    format!("{missing} GitHub said: {}", messages.join("; "))
                }
            }
            ApiError::Response { status, messages } => {
                if messages.is_empty() {
                    format!("GitHub returned HTTP {status}.")
                } else {
                    format!("GitHub returned an error: {}", messages.join("; "))
                }
            }
            ApiError::Request { host } => format!("Could not reach GitHub at {host}."),
        }
    }
}

/// `restErrorMessages`: `message` and each of `errors[]` (a string, its `message`, or
/// `"<field> <code>"`).
fn rest_error_messages(body: &str) -> Vec<String> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Item {
        Text(String),
        Detail {
            message: Option<String>,
            field: Option<String>,
            code: Option<String>,
        },
    }
    #[derive(Deserialize)]
    struct Body {
        message: Option<String>,
        errors: Option<Vec<Item>>,
    }
    let Ok(body) = serde_json::from_str::<Body>(body) else {
        return Vec::new();
    };
    let details = body
        .errors
        .unwrap_or_default()
        .into_iter()
        .filter_map(|item| match item {
            Item::Text(text) => Some(text),
            Item::Detail {
                message: Some(m), ..
            } => Some(m),
            Item::Detail {
                field: Some(f),
                code: Some(c),
                ..
            } => Some(format!("{f} {c}")),
            Item::Detail { .. } => None,
        });
    body.message.into_iter().chain(details).collect()
}

/// `isRateLimited` for a REST answer.
fn is_rate_limited(response: &HttpResponse) -> bool {
    if response.status == 429 {
        return true;
    }
    if response.status != 403 {
        return false;
    }
    if response.header("x-ratelimit-remaining") == Some("0") {
        return true;
    }
    let text = response.text().to_lowercase();
    text.contains("rate limit") || text.contains("abuse detection mechanism")
}

/// A REST request (`GitHubRest.rest`): the T3 headers, a bearer token, 30 s, 8 MiB.
#[derive(Clone, Debug)]
pub struct RestRequest<'a> {
    pub host: &'a str,
    pub method: Method,
    /// Relative to the API root, query included.
    pub path: &'a str,
    pub body: Option<serde_json::Value>,
}

#[derive(Clone, Copy, Debug)]
pub struct RestOptions<'a> {
    pub accept: &'a str,
    pub limit: usize,
    pub timeout: std::time::Duration,
}
impl Default for RestOptions<'_> {
    fn default() -> Self {
        Self {
            accept: "application/vnd.github+json",
            limit: http::DEFAULT_MAX_RESPONSE_BYTES,
            timeout: http::DEFAULT_TIMEOUT,
        }
    }
}

pub async fn rest(
    request: RestRequest<'_>,
    token: Secret,
    root_override: Option<&str>,
    options: RestOptions<'_>,
) -> Result<HttpResponse, ApiError> {
    let root = root_override.map_or_else(|| rest_root(request.host), str::to_owned);
    let url = url::Url::parse(&format!("{root}/"))
        .and_then(|root| root.join(request.path.trim_start_matches('/')))
        .map_err(|_| ApiError::Request {
            host: request.host.into(),
        })?;
    let mut http_request = HttpRequest::new(request.method, url.to_string())
        .header("accept", options.accept)
        .header("x-github-api-version", API_VERSION)
        .header("user-agent", USER_AGENT)
        .secret_header("authorization", "Bearer ", token);
    http_request.max_response_bytes = options.limit;
    http_request.timeout = options.timeout;
    if let Some(body) = &request.body {
        http_request = http_request
            .header("content-type", "application/json")
            .body(serde_json::to_vec(body).unwrap_or_default());
    } else if matches!(request.method, Method::Post | Method::Put) {
        // Fetch sends `content-length: 0` for a POST or PUT without a body; GitHub asks for it
        // on `PUT user/starred`.
        http_request = http_request.body(Vec::new());
    }
    let response = http::send(http_request)
        .await
        .map_err(|_| ApiError::Request {
            host: request.host.to_owned(),
        })?;
    if is_rate_limited(&response) {
        return Err(ApiError::RateLimit);
    }
    match response.status {
        401 => Err(ApiError::Authentication {
            host: request.host.to_owned(),
        }),
        404 => Err(ApiError::NotFound {
            messages: rest_error_messages(&response.text()),
        }),
        200..=299 => Ok(response),
        status => Err(ApiError::Response {
            status,
            messages: rest_error_messages(&response.text()),
        }),
    }
}

/// `HOSTNAME` in `GitHubCredentials.ts`: a bare host name with an optional port. API URLs are
/// built from it, so anything else could send a token elsewhere.
pub fn is_github_host(host: &str) -> bool {
    let (name, port) = match host.rsplit_once(':') {
        Some((name, port)) => (name, Some(port)),
        None => (host, None),
    };
    let port_ok =
        port.is_none_or(|p| (1..=5).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_digit()));
    let label_ok = |label: &str| {
        let bytes = label.as_bytes();
        !bytes.is_empty()
            && bytes
                .iter()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
            && bytes.first().is_some_and(|b| *b != b'-')
            && bytes.last().is_some_and(|b| *b != b'-')
    };
    port_ok && name.split('.').all(label_ok)
}

/// `environmentToken`: `GH_TOKEN`/`GITHUB_TOKEN` for github.com and `*.ghe.com`;
/// `GH_ENTERPRISE_TOKEN`/`GITHUB_ENTERPRISE_TOKEN` only for the host `GH_HOST` names.
pub fn environment_token(host: &str, env: &Environment) -> Option<Secret> {
    if !is_github_host(host) {
        return None;
    }
    let names: &[&str] = if host == "github.com" || host.ends_with(".ghe.com") {
        &["GH_TOKEN", "GITHUB_TOKEN"]
    } else if env
        .get("GH_HOST")
        .map(|h| h.trim().to_lowercase())
        .as_deref()
        == Some(host)
    {
        &["GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]
    } else {
        &[]
    };
    names
        .iter()
        .find_map(|name| env.non_blank(name))
        .and_then(Secret::non_empty)
}

/// Why no credential was found, as `GitHubCredentials` errors.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CredentialError {
    NotSignedIn,
    HostDisabled,
    CliMissing,
    CliFailed,
    /// `SettingsSecretUnresolvedError`, with its message.
    Unresolved(String),
}

/// `gh auth token --hostname <host> [--user <account>]` (`fromGh`).
async fn token_from_gh(
    ctx: DiscoveryContext<'_>,
    host: &str,
    account: Option<&str>,
) -> Result<Secret, CredentialError> {
    let mut args = vec!["auth", "token", "--hostname", host];
    let user = account.map(|account| format!("--user={account}"));
    if let Some(user) = user.as_deref() {
        args.push(user);
    }
    let mut command =
        crate::discovery::ProbeCommand::new("GitHubCredentials.get", "gh", &args, ctx.cwd);
    command.timeout = std::time::Duration::from_secs(10);
    // Never let gh print the token into a debug log.
    command.env = ctx.probe_env(&[("GH_DEBUG", "".into()), ("GH_PROMPT_DISABLED", "1".into())]);
    match crate::discovery::run_probe(command).await {
        Ok(output) => Secret::non_empty(output.stdout).ok_or(CredentialError::NotSignedIn),
        Err(crate::discovery::ProbeFailure::Missing { .. }) => Err(CredentialError::CliMissing),
        Err(crate::discovery::ProbeFailure::Exit { .. }) => Err(CredentialError::NotSignedIn),
        Err(_) => Err(CredentialError::CliFailed),
    }
}

/// `GitHubCredentials.get` for a host: the token saved in Settings, else the environment's,
/// else `gh`'s (the account chosen in Settings first, then the active login). T3 keeps the
/// `gh` answer 5 minutes; this server asks `gh` on each call.
pub async fn credential(
    ctx: DiscoveryContext<'_>,
    raw_host: &str,
) -> Result<Secret, CredentialError> {
    credential_with_source(ctx, raw_host)
        .await
        .map(|(token, _)| token)
}

#[derive(Clone, Copy, Debug)]
pub(crate) enum CredentialSource {
    Settings,
    Environment,
    Gh,
}
impl CredentialSource {
    pub(crate) fn access_hint(self) -> &'static str {
        match self {
            Self::Settings => {
                "Your saved GitHub token can't see it. Give it access, or change it in Settings → Source control & issues."
            }
            Self::Environment => {
                "The server's environment token can't see it. Give it access, or unset it."
            }
            Self::Gh => {
                "Your gh login can't see it. Give it access, or save a token in Settings → Source control & issues."
            }
        }
    }
}

pub(crate) async fn credential_with_source(
    ctx: DiscoveryContext<'_>,
    raw_host: &str,
) -> Result<(Secret, CredentialSource), CredentialError> {
    let host = raw_host.trim().to_lowercase();
    if !is_github_host(&host) {
        return Err(CredentialError::NotSignedIn);
    }
    let settings = ctx.settings.host(KIND);
    if !settings.host_enabled(&host) {
        return Err(CredentialError::HostDisabled);
    }
    if let Some(saved) = settings
        .keyed_secret("tokens", &host)
        .require()
        .map_err(CredentialError::Unresolved)?
    {
        return Ok((saved, CredentialSource::Settings));
    }
    if let Some(token) = environment_token(&host, ctx.env) {
        return Ok((token, CredentialSource::Environment));
    }
    let account = settings.host_account(&host);
    let token = match token_from_gh(ctx, &host, account).await {
        Err(CredentialError::NotSignedIn) if account.is_some() => {
            token_from_gh(ctx, &host, None).await
        }
        other => other,
    }?;
    Ok((token, CredentialSource::Gh))
}

/// `starredPath`: exactly `owner/name`, neither empty nor a dot segment, each part encoded.
fn starred_path(repository: &str) -> Option<String> {
    let segments: Vec<&str> = repository.split('/').collect();
    (segments.len() == 2 && segments.iter().all(|s| !matches!(*s, "" | "." | ".."))).then(|| {
        format!(
            "user/starred/{}",
            segments
                .iter()
                .map(|s| encode_uri_component(s))
                .collect::<Vec<_>>()
                .join("/")
        )
    })
}

/// `encodeURIComponent`.
pub fn encode_uri_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(char::from(byte));
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// `makeIsRepositoryStarred` / `makeStarRepository`: true only on 204; false on any failure.
pub async fn starred(ctx: DiscoveryContext<'_>, host: &str, repository: &str, star: bool) -> bool {
    let Some(path) = starred_path(repository) else {
        return false;
    };
    let Ok(token) = credential(ctx, host).await else {
        return false;
    };
    let host = host.trim().to_lowercase();
    let root = (host == "github.com")
        .then_some(())
        .and(ctx.endpoints.github_rest.as_deref());
    rest(
        RestRequest {
            host: &host,
            method: if star { Method::Put } else { Method::Get },
            path: &path,
            body: None,
        },
        token,
        root,
        RestOptions::default(),
    )
    .await
    .is_ok_and(|response| response.status == 204)
}

/// `environmentTokenVariable`: the first of `GH_TOKEN`, `GITHUB_TOKEN` that is set.
fn environment_token_variable(env: &Environment) -> Option<&'static str> {
    ["GH_TOKEN", "GITHUB_TOKEN"]
        .into_iter()
        .find(|name| env.non_blank(name).is_some())
}

/// `makeDiscovery(...).probe`.
pub async fn discover(ctx: DiscoveryContext<'_>) -> SourceControlProviderDiscoveryItem {
    use ServerProviderAuthStatus::{Authenticated, Unauthenticated, Unknown};
    let settings = ctx.settings.host(KIND);
    let env = ctx.probe_env(&[]);
    let probe = ProbeContext {
        cwd: ctx.cwd,
        env: &env,
    };
    let cli = probe_cli(probe, &spec(), |output| parse_auth(output, &settings)).await;
    let enabled = settings.host_enabled("github.com");
    let saved = settings.keyed_secret("tokens", "github.com").require();
    let saved = match saved {
        Err(message) if enabled => {
            return SourceControlProviderDiscoveryItem {
                status: SourceControlDiscoveryStatus::Available,
                auth: provider_auth(Unauthenticated, None, Some("github.com"), Some(&message)),
                ..cli
            };
        }
        Err(_) => None,
        Ok(saved) => saved,
    };
    let variable = environment_token_variable(ctx.env);
    let token = match (&saved, variable) {
        (Some(token), _) => token.clone(),
        (None, Some(name)) => match ctx.env.non_blank(name).and_then(Secret::non_empty) {
            Some(token) => token,
            None => return cli,
        },
        (None, None) => return cli,
    };
    if !enabled {
        return cli;
    }
    let token_source = if saved.is_some() {
        "the token saved in Settings".to_owned()
    } else {
        variable.unwrap_or_default().to_owned()
    };
    let viewer = rest(
        RestRequest {
            host: "github.com",
            method: Method::Get,
            path: "user",
            body: None,
        },
        token,
        ctx.endpoints.github_rest.as_deref(),
        RestOptions::default(),
    )
    .await;
    #[derive(Deserialize)]
    struct Viewer {
        login: String,
    }
    let login = viewer
        .as_ref()
        .ok()
        .and_then(|r| serde_json::from_slice::<Viewer>(&r.body).ok())
        .map(|v| v.login);
    let accounts = cli.auth.accounts.clone();
    let mut auth = match (&login, &viewer) {
        (Some(login), _) => provider_auth(
            Authenticated,
            Some(login),
            Some("github.com"),
            Some(&if saved.is_some() {
                "Using the token saved in Settings; it overrides GH_TOKEN and the gh login."
                    .to_owned()
            } else {
                format!(
                    "Using {token_source} from the server environment; it overrides the account chosen in Settings."
                )
            }),
        ),
        (None, Err(failure)) if !matches!(failure, ApiError::Authentication { .. }) => {
            let what = if saved.is_some() {
                token_source.clone()
            } else {
                format!("the token in {token_source}")
            };
            provider_auth(
                Unknown,
                None,
                Some("github.com"),
                Some(&format!("Could not check {what}: {}", failure.message())),
            )
        }
        _ => provider_auth(
            Unauthenticated,
            None,
            Some("github.com"),
            Some(&if saved.is_some() {
                "GitHub refused the token saved in Settings. Replace or remove it in Settings → Source control & issues.".to_owned()
            } else {
                format!(
                    "GitHub refused the token in {token_source}. Replace it, or unset it to use `gh auth login`."
                )
            }),
        ),
    };
    auth.accounts = accounts;
    SourceControlProviderDiscoveryItem {
        status: SourceControlDiscoveryStatus::Available,
        auth,
        ..cli
    }
}

pub(crate) async fn api_json(
    ctx: DiscoveryContext<'_>,
    cwd: &std::path::Path,
    host: &str,
    endpoint: &str,
    body: Option<serde_json::Value>,
    not_found: &str,
) -> Result<serde_json::Value, crate::repository::HostFailure> {
    if !is_github_host(host) {
        return Err(crate::repository::HostFailure::new(
            "Could not resolve the GitHub repository from this checkout.",
        ));
    }
    let token = credential(ctx, host).await.map_err(|e| {
        let detail = match e {
            CredentialError::CliMissing => "No GitHub credential on the server. Set GH_TOKEN, or install the GitHub CLI and run `gh auth login`.".into(),
            CredentialError::NotSignedIn => match ctx.settings.host(KIND).host_account(host) {
                Some(account)=>format!("No GitHub credential for {account} on {host}: run `gh auth login --hostname {host}` for that account or pick another in Settings → Source control & issues."),
                None=>format!("No GitHub credential for {host}: run `gh auth login --hostname {host}`."),
            },
            CredentialError::HostDisabled => format!("GitHub host {host} is turned off in Settings → Source control & issues."),
            CredentialError::CliFailed => format!("The GitHub CLI could not hand over a credential for {host}. Check `gh auth status` on the server."),
            CredentialError::Unresolved(e) => e,
        }; crate::repository::HostFailure::new(detail)
    })?;
    let mut args = vec!["api", endpoint, "--hostname", host];
    args.extend(if body.is_some() {
        ["--input", "-"]
    } else {
        ["--method", "GET"]
    });
    let mut call = crate::cli::CliCall::new(
        "GitHubSourceControlProvider.getChangeRequest",
        "gh",
        args,
        cwd,
    );
    call.stdin = body.map(|body| body.to_string().into_bytes());
    call.env = ctx.probe_env(&[
        (
            if host == "github.com" || host.ends_with(".ghe.com") {
                "GH_TOKEN"
            } else {
                "GH_ENTERPRISE_TOKEN"
            },
            token.expose().into(),
        ),
        ("GH_DEBUG", "".into()),
        ("GH_PROMPT_DISABLED", "1".into()),
    ]);
    let output = crate::cli::run(call).await.map_err(|e| {
        let text = e.stderr().to_lowercase();
        crate::repository::HostFailure::new(if text.contains("401") {
            "GitHub is not authenticated. Run `gh auth login` (or set GH_TOKEN) and retry."
        } else if text.contains("404") {
            not_found
        } else if text.contains("rate limit") {
            "GitHub API rate limit exceeded. Requests resume when the limit resets."
        } else {
            "GitHub request failed."
        })
    })?;
    serde_json::from_str(&output.stdout).map_err(|_| {
        crate::repository::HostFailure::new("GitHub returned an invalid pull request.")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        discovery::{none, some, stub::StubDir},
        hosts::Endpoints,
        http::fake,
        settings::Settings,
    };

    fn output(stdout: &str, stderr: &str, exit_code: i32) -> ProbeOutput {
        ProbeOutput {
            stdout: stdout.into(),
            stderr: stderr.into(),
            exit_code,
        }
    }

    fn settings(json: &str) -> Settings {
        Settings::new(serde_json::from_str(json).expect("json"))
    }

    fn defaults() -> Settings {
        Settings::default()
    }

    const ACTIVE_AND_STALE: &str = r#"{"hosts":{"github.com":[
        {"state":"success","active":true,"host":"github.com","login":"active-user","tokenSource":"keyring","gitProtocol":"ssh"},
        {"state":"error","active":false,"host":"github.com","login":"stale-user","tokenSource":"keyring","gitProtocol":"ssh","error":"The token in keyring is invalid."}]}}"#;

    // GitHubSourceControlProvider.test.ts: "accepts active authenticated GitHub accounts when
    // another account fails" and "parses GitHub auth JSON from stdout when stderr has warnings".
    #[test]
    fn accepts_the_active_account() {
        let s = defaults();
        for stderr in ["", "warning: ignored diagnostic from gh\n"] {
            let auth = parse_auth(&output(ACTIVE_AND_STALE, stderr, 0), &s.host(KIND));
            assert_eq!(
                auth.status,
                ServerProviderAuthStatus::Authenticated,
                "{stderr}"
            );
            assert_eq!(auth.account, some("active-user"), "account");
            assert_eq!(auth.host, some("github.com"), "host");
        }
    }

    // "parses GitHub auth status accounts by host and active state"
    #[test]
    fn parses_accounts_by_host() {
        let json = r#"{"hosts":{"github.com":[
            {"state":"success","active":true,"host":"github.com","login":"active-user","tokenSource":"keyring","gitProtocol":"ssh"},
            {"state":"error","active":false,"host":"github.com","login":"stale-user","tokenSource":"keyring","gitProtocol":"ssh"}],
          "github.example.test":[{"state":"success","active":false,"host":"github.example.test","login":"enterprise-user","tokenSource":"keyring","gitProtocol":"ssh"}]}}"#;
        let accounts = parse_auth_status(json).expect("parses");
        let row = |host: &str, account: &str, authenticated, active| AuthAccount {
            host: host.into(),
            account: account.into(),
            authenticated,
            active,
            error: None,
            environment_variable: None,
        };
        assert_eq!(
            accounts,
            vec![
                row("github.com", "active-user", true, true),
                row("github.com", "stale-user", false, false),
                row("github.example.test", "enterprise-user", true, false),
            ],
            "in JSON order"
        );
    }

    // "reports unauthenticated when GitHub JSON has accounts but none are valid"
    #[test]
    fn none_valid_is_unauthenticated() {
        let json = r#"{"hosts":{"github.com":[{"state":"error","active":true,"host":"github.com","login":"stale-user","tokenSource":"keyring","gitProtocol":"ssh","error":"The token in keyring is invalid."}]}}"#;
        let auth = parse_auth(&output(json, "", 0), &defaults().host(KIND));
        assert_eq!(
            auth.status,
            ServerProviderAuthStatus::Unauthenticated,
            "status"
        );
        assert_eq!(auth.host, some("github.com"), "host");
        assert_eq!(
            auth.detail,
            some("The token in keyring is invalid."),
            "detail"
        );
    }

    // "reports an update hint instead of unauthenticated when gh predates --json"
    #[test]
    fn old_gh_gets_an_update_hint() {
        let auth = parse_auth(
            &output(
                "",
                "unknown flag: --json\n\nUsage:  gh auth status [flags]\n",
                1,
            ),
            &defaults().host(KIND),
        );
        assert_eq!(auth.status, ServerProviderAuthStatus::Unknown, "status");
        let VcsDetail(detail) = VcsDetail::of(&auth.detail);
        assert!(detail.contains("2.81.0"), "{detail}");
    }

    struct VcsDetail(String);
    impl VcsDetail {
        fn of(detail: &conn_contract::VcsDiscoveryItemDetail) -> Self {
            match detail {
                conn_contract::VcsDiscoveryItemDetail::Some(s) => Self(s.value.clone()),
                conn_contract::VcsDiscoveryItemDetail::None(_) => Self(String::new()),
            }
        }
    }

    fn multi_account(extra: &str) -> String {
        format!(
            r#"{{"hosts":{{"github.com":[
                {{"state":"success","active":true,"host":"github.com","login":"personal"}},
                {{"state":"success","active":false,"host":"github.com","login":"work"}}{extra}],
              "ghe.acme.test":[{{"state":"error","active":true,"host":"ghe.acme.test","login":"jm","error":"expired"}}]}}}}"#
        )
    }

    // "reports every gh login and leads with the account Settings pin"
    #[test]
    fn settings_pin_leads() {
        let s = settings(
            r#"{"sourceControlHosts":{"github":{"hosts":{"github.com":{"account":"work","enabled":true}}}}}"#,
        );
        let auth = parse_auth(&output(&multi_account(""), "", 0), &s.host(KIND));
        assert_eq!(auth.account, some("work"), "pinned account");
        let rows = auth.accounts.expect("rows");
        assert_eq!(rows.len(), 3, "every login");
        assert_eq!(
            rows.get(2).and_then(|r| r.error.as_deref()),
            Some("expired"),
            "error kept"
        );
    }

    // "reports unauthenticated when Settings turn off every signed-in host"
    #[test]
    fn every_host_turned_off() {
        let s = settings(
            r#"{"sourceControlHosts":{"github":{"hosts":{"github.com":{"enabled":false}}}}}"#,
        );
        let auth = parse_auth(&output(&multi_account(""), "", 0), &s.host(KIND));
        assert_eq!(
            auth.status,
            ServerProviderAuthStatus::Unauthenticated,
            "status"
        );
        assert_eq!(
            auth.detail,
            some(
                "Every GitHub host gh is signed in to is turned off in Settings → Source control & issues."
            ),
            "detail"
        );
    }

    // "names the environment token that overrides the Settings choice"
    #[test]
    fn environment_token_overrides() {
        let s = settings(
            r#"{"sourceControlHosts":{"github":{"hosts":{"github.com":{"account":"work","enabled":true}}}}}"#,
        );
        let extra = r#",{"state":"success","active":false,"host":"github.com","login":"bot","tokenSource":"GH_TOKEN"}"#;
        let auth = parse_auth(&output(&multi_account(extra), "", 0), &s.host(KIND));
        assert_eq!(auth.account, some("bot"), "env account");
        assert_eq!(
            auth.detail,
            some(
                "Using GH_TOKEN from the server environment; it overrides the account chosen in Settings."
            ),
            "detail"
        );
        assert_eq!(
            auth.accounts
                .as_ref()
                .and_then(|r| r.get(2))
                .and_then(|r| r.environment_variable.as_deref()),
            Some("GH_TOKEN"),
            "row names the variable"
        );
    }

    /// A `gh` that is installed and signed out, so only the token decides.
    fn signed_out_gh(stubs: &StubDir) -> String {
        stubs.executable(
            "gh",
            &["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"],
            "if [ \"$1\" = --version ]; then echo 'gh version 2.81.0 (2025-10-01)'; exit 0; fi; exit 1",
        )
    }

    // gitHubDiscovery.test.ts: "reports $name saved GitHub token instead of another
    // credential", with the request on a local fake server and `gh` on PATH as a stub.
    #[tokio::test(flavor = "current_thread")]
    async fn a_saved_token_wins_over_the_environment() {
        let stubs = StubDir::new("gh-discovery");
        let _gh = signed_out_gh(&stubs);
        let server = fake::serve(|_| (200, r#"{"login":"octocat"}"#.into())).await;
        let cases = [
            (
                "a readable",
                r#""resolved-token""#,
                "authenticated",
                "the token saved in Settings",
                Some("Bearer resolved-token"),
            ),
            (
                "no",
                r#""""#,
                "authenticated",
                "GH_TOKEN from the server environment",
                Some("Bearer environment-token"),
            ),
            (
                "an unreadable",
                r#"{"provider":"vault","reference":"op://v/gh"}"#,
                "unauthenticated",
                "secret provider \"vault\"",
                None,
            ),
        ];
        for (name, token, status, detail, authorization) in cases {
            let before = server.requests.lock().expect("lock").len();
            let s = settings(&format!(
                r#"{{"sourceControlHosts":{{"github":{{"tokens":{{"github.com":{token}}}}}}}}}"#
            ));
            let env = Environment::fixed([("GH_TOKEN", "environment-token")]);
            let endpoints = Endpoints {
                github_rest: Some(server.base.clone()),
            };
            let child_env = stubs.path_env();
            let item = discover(DiscoveryContext {
                cwd: &stubs.dir,
                home: None,
                settings: &s,
                env: &env,
                endpoints: &endpoints,
                child_env: &child_env,
            })
            .await;
            let VcsDetail(text) = VcsDetail::of(&item.auth.detail);
            assert!(text.contains(detail), "{name}: {text}");
            let expected_status = if status == "authenticated" {
                ServerProviderAuthStatus::Authenticated
            } else {
                ServerProviderAuthStatus::Unauthenticated
            };
            assert_eq!(item.auth.status, expected_status, "{name}");
            let requests = server.requests.lock().expect("lock").clone();
            let new = requests.get(before..).unwrap_or_default();
            match authorization {
                Some(authorization) => {
                    assert_eq!(item.auth.account, some("octocat"), "{name}");
                    let request = new.first().expect("one request");
                    assert_eq!(
                        (request.method.as_str(), request.path.as_str()),
                        ("GET", "/user"),
                        "{name}"
                    );
                    let header = |n: &str| {
                        request
                            .headers
                            .iter()
                            .find(|(k, _)| k == n)
                            .map(|(_, v)| v.as_str())
                    };
                    assert_eq!(
                        header("accept"),
                        Some("application/vnd.github+json"),
                        "{name}"
                    );
                    assert_eq!(header("x-github-api-version"), Some("2022-11-28"), "{name}");
                    assert_eq!(header("user-agent"), Some("t3code"), "{name}");
                    assert_eq!(header("authorization"), Some(authorization), "{name}");
                }
                None => {
                    assert!(new.is_empty(), "{name}: no request");
                    assert_eq!(item.auth.account, none(), "{name}");
                }
            }
        }
        let log = stubs.log("gh");
        assert!(log.contains("argv --version\n"), "{log}");
        assert!(log.contains("argv auth status --json hosts\n"), "{log}");
        assert!(
            log.contains("env GIT_CONFIG_KEY_0=safe.bareRepository"),
            "{log}"
        );
    }

    fn ctx<'a>(
        stubs: &'a StubDir,
        settings: &'a Settings,
        env: &'a Environment,
        endpoints: &'a Endpoints,
        child_env: &'a [(&'static str, std::ffi::OsString)],
    ) -> DiscoveryContext<'a> {
        DiscoveryContext {
            cwd: &stubs.dir,
            home: None,
            settings,
            env,
            endpoints,
            child_env,
        }
    }

    /// A `gh` whose `auth token` answers like GitHubCredentials.test.ts' harness: `--user <u>`
    /// gives `token-for-<u>` unless `<u>` is signed out (empty output), else `active-token`.
    fn token_gh(stubs: &StubDir, signed_out: &str) -> String {
        stubs.executable(
            "gh",
            &["GH_DEBUG", "GH_PROMPT_DISABLED"],
            &format!(
                "user=''; prev=''; for a in \"$@\"; do [ \"$prev\" = --user ] && user=\"$a\"; prev=\"$a\"; case \"$a\" in --user=*) user=${{a#--user=}};; esac; done\nif [ -n \"$user\" ]; then [ \"$user\" = '{signed_out}' ] && exit 0; echo \"token-for-$user\"; else echo active-token; fi"
            ),
        )
    }

    async fn token_of(c: DiscoveryContext<'_>, host: &str) -> Result<String, CredentialError> {
        credential(c, host).await.map(|t| t.expose().to_owned())
    }

    // GitHubCredentials.test.ts: "lets an environment token win over a pinned account, as gh does"
    #[tokio::test(flavor = "current_thread")]
    async fn environment_token_wins_over_a_pinned_account() {
        let stubs = StubDir::new("gh-cred-env");
        token_gh(&stubs, "");
        let s = settings(
            r#"{"sourceControlHosts":{"github":{"hosts":{"github.com":{"account":"work","enabled":true}}}}}"#,
        );
        let env = Environment::fixed([("GH_TOKEN", "from-env")]);
        let (endpoints, child_env) = (Endpoints::default(), stubs.path_env());
        let c = ctx(&stubs, &s, &env, &endpoints, &child_env);
        assert_eq!(
            token_of(c, "github.com").await,
            Ok("from-env".into()),
            "env"
        );
        assert_eq!(stubs.log("gh"), "", "gh not asked");
    }

    // "picks up a changed account on the next request without a restart" (T3 also checks its
    // 5-minute cache with a call count; this server has no cache).
    #[tokio::test(flavor = "current_thread")]
    async fn follows_the_account_chosen_in_settings() {
        let stubs = StubDir::new("gh-cred-account");
        token_gh(&stubs, "");
        let env = Environment::fixed([]);
        let (endpoints, child_env) = (Endpoints::default(), stubs.path_env());
        let cases = [
            ("{}", Ok("active-token".to_owned())),
            (
                r#"{"hosts":{"github.com":{"account":"work","enabled":true}}}"#,
                Ok("token-for-work".into()),
            ),
            (
                r#"{"hosts":{"github.com":{"enabled":false}}}"#,
                Err(CredentialError::HostDisabled),
            ),
            (
                r#"{"hosts":{"github.com":{"account":"-work","enabled":true}}}"#,
                Ok("token-for--work".into()),
            ),
            (r#"{"hosts":{}}"#, Ok("active-token".into())),
        ];
        for (github, expected) in cases {
            let s = settings(&format!(
                r#"{{"sourceControlHosts":{{"github":{github}}}}}"#
            ));
            let c = ctx(&stubs, &s, &env, &endpoints, &child_env);
            assert_eq!(token_of(c, "github.com").await, expected, "{github}");
        }
        assert!(
            stubs.log("gh").contains("--user=-work"),
            "pinned accounts are a single flag value"
        );
        assert!(
            stubs
                .log("gh")
                .contains("env GH_DEBUG=\n  env GH_PROMPT_DISABLED=1"),
            "{}",
            stubs.log("gh")
        );
    }

    // "falls back to the active login when the pinned one is no longer signed in"
    #[tokio::test(flavor = "current_thread")]
    async fn falls_back_to_the_active_login() {
        let stubs = StubDir::new("gh-cred-gone");
        token_gh(&stubs, "gone");
        let s = settings(
            r#"{"sourceControlHosts":{"github":{"hosts":{"github.com":{"account":"gone","enabled":true}}}}}"#,
        );
        let env = Environment::fixed([]);
        let (endpoints, child_env) = (Endpoints::default(), stubs.path_env());
        let c = ctx(&stubs, &s, &env, &endpoints, &child_env);
        assert_eq!(
            token_of(c, "github.com").await,
            Ok("active-token".into()),
            "fallback"
        );
        let argv: Vec<String> = stubs
            .log("gh")
            .lines()
            .filter(|l| l.starts_with("argv"))
            .map(str::to_owned)
            .collect();
        assert_eq!(
            argv,
            [
                "argv auth token --hostname github.com --user=gone",
                "argv auth token --hostname github.com"
            ],
            "T3's argv"
        );
    }

    // "uses a token saved in Settings before GH_TOKEN and gh", "keeps a host turned off even
    // with a token saved in Settings"
    #[tokio::test(flavor = "current_thread")]
    async fn a_saved_token_comes_first_unless_the_host_is_off() {
        let stubs = StubDir::new("gh-cred-saved");
        token_gh(&stubs, "");
        let env = Environment::fixed([("GH_TOKEN", "env-token")]);
        let (endpoints, child_env) = (Endpoints::default(), stubs.path_env());
        let s = settings(
            r#"{"sourceControlHosts":{"github":{"tokens":{"github.com":"saved-token"}}}}"#,
        );
        assert_eq!(
            token_of(ctx(&stubs, &s, &env, &endpoints, &child_env), "github.com").await,
            Ok("saved-token".into()),
            "saved"
        );
        let s = settings(
            r#"{"secretProviders":{"vault":{"kind":"one_password","label":"Work vault","config":{}}},"sourceControlHosts":{"github":{"tokens":{"github.com":{"provider":"vault","reference":"gh#token"}}}}}"#,
        );
        let Err(CredentialError::Unresolved(message)) =
            credential(ctx(&stubs, &s, &env, &endpoints, &child_env), "github.com").await
        else {
            panic!("unresolved")
        };
        assert!(message.contains("\"Work vault\""), "{message}");
        let s = settings(
            r#"{"sourceControlHosts":{"github":{"hosts":{"github.com":{"enabled":false}},"tokens":{"github.com":"saved-token"}}}}"#,
        );
        assert_eq!(
            token_of(ctx(&stubs, &s, &env, &endpoints, &child_env), "github.com").await,
            Err(CredentialError::HostDisabled),
            "off"
        );
        assert_eq!(stubs.log("gh"), "", "gh not asked");
    }

    // "never hands a token to a host that is not a plain hostname"
    #[tokio::test(flavor = "current_thread")]
    async fn never_hands_a_token_to_an_odd_host() {
        let stubs = StubDir::new("gh-cred-odd");
        token_gh(&stubs, "");
        let env = Environment::fixed([("GH_TOKEN", "env-token")]);
        let (endpoints, child_env, s) = (Endpoints::default(), stubs.path_env(), defaults());
        for host in ["evil.com#.ghe.com", "evil.com/.ghe.com", "user@x.ghe.com"] {
            assert!(environment_token(host, &env).is_none(), "{host}");
            assert_eq!(
                token_of(ctx(&stubs, &s, &env, &endpoints, &child_env), host).await,
                Err(CredentialError::NotSignedIn),
                "{host}"
            );
        }
        assert_eq!(stubs.log("gh"), "", "gh not asked");
    }

    // driver.test.ts: "checks and stars only a valid repository, true only on 204"
    #[tokio::test(flavor = "current_thread")]
    async fn stars_only_a_valid_repository() {
        let server = fake::serve(|r| {
            if r.path == "/user/starred/pingdotgg/t3code" {
                (204, String::new())
            } else {
                (404, r#"{"message":"Not Found"}"#.into())
            }
        })
        .await;
        let stubs = StubDir::new("gh-star");
        let env = Environment::fixed([("GH_TOKEN", "env-token")]);
        let endpoints = Endpoints {
            github_rest: Some(server.base.clone()),
        };
        let (child_env, s) = (stubs.path_env(), defaults());
        let c = ctx(&stubs, &s, &env, &endpoints, &child_env);
        for star in [false, true] {
            assert!(
                starred(c, "github.com", "pingdotgg/t3code", star).await,
                "{star}"
            );
            assert!(
                !starred(c, "github.com", "pingdotgg/uploadthing", star).await,
                "{star}"
            );
            assert!(
                !starred(c, "github.com", "pingdotgg/t3code/../../user", star).await,
                "{star}"
            );
            assert!(!starred(c, "github.com", "../repos", star).await, "{star}");
        }
        let requests = server.requests.lock().expect("lock").clone();
        let seen: Vec<String> = requests
            .iter()
            .map(|r| format!("{} {}", r.method, r.path))
            .collect();
        assert_eq!(
            seen,
            [
                "GET /user/starred/pingdotgg/t3code",
                "GET /user/starred/pingdotgg/uploadthing",
                "PUT /user/starred/pingdotgg/t3code",
                "PUT /user/starred/pingdotgg/uploadthing",
            ],
            "T3's requests"
        );
        let put = requests.get(2).expect("put");
        assert!(
            put.headers.contains(&("content-length".into(), "0".into())),
            "{:?}",
            put.headers
        );
        assert!(
            put.headers
                .contains(&("authorization".into(), "Bearer env-token".into())),
            "token"
        );
    }
}
