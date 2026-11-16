//! The host definition registry, the server's half: which host a remote is on, a change
//! request's URL in both directions, a repository's canonical key, and the predicates that say
//! whether a change request belongs to a project.
//!
//! T3: `packages/source-control-core/src/shared/definition.ts` (`makeSourceControlDefinitionRegistry`
//! and its helpers), with only `packages/source-control-github/src/shared/definition.ts`.
//! URLs use the WHATWG parser (`url`), as `new URL` reads them. What only clients use (icons, autolinks, media, checkout commands, settings
//! forms) is not here. `tools/registry-diff.mjs` runs T3's registry and this one on the same
//! cases and fails on any difference.

mod paths;
pub mod thread_keys;

use url::Url;

use crate::remote::{
    canonical_repository_path, parse_git_remote_repository,
    repository_key_from_remote as remote_key,
};

/// GitHub is the only source-control host in Conn.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum HostKind {
    GitHub,
}

impl HostKind {
    /// The supported definitions, in display order.
    pub const ALL: [HostKind; 1] = [HostKind::GitHub];
    const CLAIM_ORDER: [HostKind; 1] = Self::ALL;
    const RECOGNITION_ORDER: [HostKind; 1] = Self::ALL;

    pub fn as_str(self) -> &'static str {
        "github"
    }
    pub fn parse(kind: &str) -> Option<Self> {
        (kind == "github").then_some(Self::GitHub)
    }
    /// The definition's display label.
    pub fn label(self) -> &'static str {
        "GitHub"
    }
    /// The singular change request name.
    pub fn change_request_singular(self) -> &'static str {
        "pull request"
    }
}

/// `SourceControlProviderInfo`: `kind` is a host's kind or `"unknown"`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderInfo {
    pub kind: String,
    pub name: String,
    pub base_url: String,
}

impl ProviderInfo {
    fn of(kind: HostKind, name: &str, base_url: String) -> Self {
        ProviderInfo {
            kind: kind.as_str().to_owned(),
            name: name.to_owned(),
            base_url,
        }
    }

    pub fn host_kind(&self) -> Option<HostKind> {
        HostKind::parse(&self.kind)
    }
}

/// `GitRemoteHost`: a remote's host as `recognizeRemote` reads it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GitRemoteHost {
    /// Trimmed.
    pub remote_url: String,
    /// Lower case; keeps the port of an HTTP remote, never an SSH one.
    pub host: String,
    /// `host` without its port.
    pub hostname: String,
}

/// `ChangeRequestLink`: lower case host and repository path, and the port when it matters.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChangeRequestLink {
    pub host: String,
    pub repository: String,
    pub number: u64,
    pub authority: Option<String>,
}

/// `ParsedChangeRequestUrl`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedChangeRequestUrl {
    pub link: ChangeRequestLink,
    /// The repository's browser URL, without query or hash.
    pub repository_url: String,
}

/// `ChangeRequestUrlInput`.
#[derive(Clone, Copy, Debug)]
pub struct ChangeRequestUrlInput<'a> {
    pub host: &'a str,
    pub repository: &'a str,
    pub number: u64,
    pub remote_url: Option<&'a str>,
    pub web_url: Option<&'a str>,
}

/// The parts of a project's `RepositoryIdentity` the predicates read
/// (`ChangeRequestProjectIdentity`, `RepositorySelectorIdentity`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ProjectIdentity {
    pub canonical_key: String,
    /// `locator.remoteUrl`.
    pub remote_url: String,
    pub web_url: Option<String>,
    pub display_name: Option<String>,
    pub owner: Option<String>,
    pub name: Option<String>,
    pub provider: Option<String>,
}

// ---- URL helpers -------------------------------------------------------------------------

/// `new URL(value)`, or `None` where it throws.
fn parse_url(value: &str) -> Option<Url> {
    Url::parse(value).ok()
}

fn is_http(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
}

/// `httpUrl`.
fn http_url(value: &str) -> Option<Url> {
    parse_url(value).filter(is_http)
}

/// `url.hostname`.
fn hostname(url: &Url) -> String {
    url.host_str().unwrap_or_default().to_owned()
}

/// `url.host`: the hostname with a port that is not the scheme's default.
fn host_with_port(url: &Url) -> String {
    match url.port() {
        Some(port) => format!("{}:{port}", hostname(url)),
        None => hostname(url),
    }
}

/// `url.origin` for an HTTP URL.
fn origin(url: &Url) -> String {
    url.origin().ascii_serialization()
}

/// `changeRequestUrlBelow`: `webUrl` without trailing slashes, then `/route`.
fn below(web_url: &str, route: &str) -> String {
    format!("{}/{route}", web_url.trim_end_matches('/'))
}

/// `remoteWebOrigin`: an HTTP remote on `host` names the web origin, port included.
fn remote_web_origin(host: &str, remote_url: Option<&str>) -> String {
    if let Some(remote) = remote_url.and_then(parse_url).filter(is_http) {
        let lower = host.to_lowercase();
        if hostname(&remote).to_lowercase() == lower
            || host_with_port(&remote).to_lowercase() == lower
        {
            return origin(&remote);
        }
    }
    format!("https://{host}")
}

/// `/^[a-zA-Z0-9._-]+@([^:/]+):/`.
fn scp_remote_host(text: &str) -> Option<&str> {
    let (user, rest) = text.split_once('@')?;
    if user.is_empty()
        || !user
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
    {
        return None;
    }
    let end = rest.find([':', '/'])?;
    let host = rest.get(..end)?;
    (!host.is_empty() && rest.get(end..)?.starts_with(':')).then_some(host)
}

/// JavaScript's `\s`: Unicode white space and line terminators.
fn is_js_space(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}

/// `userlessScpRemoteHost`: `/^([^@:/\\\s]{2,}):(?!:)\/?[^/\s]+(?:\/[^/\s]+)*\/?$/u`.
pub fn userless_scp_remote_host(remote_url: &str) -> Option<&str> {
    let text = remote_url.trim_matches(is_js_space);
    let colon = text.find(':')?;
    let host = text.get(..colon)?;
    if host.chars().count() < 2
        || host
            .chars()
            .any(|c| matches!(c, '@' | '/' | '\\') || is_js_space(c))
    {
        return None;
    }
    let rest = text.get(colon + 1..)?;
    if rest.starts_with(':') {
        return None;
    }
    // `\/?` then segments; a trailing `/` is allowed once.
    let attempt = |path: &str| -> bool {
        let path = path.strip_suffix('/').unwrap_or(path);
        let parts: Vec<&str> = path.split('/').collect();
        // One segment or more: `host:repo` reads as SSH too.
        parts
            .iter()
            .all(|p| !p.is_empty() && !p.chars().any(is_js_space))
    };
    let ok = attempt(rest) || rest.strip_prefix('/').is_some_and(attempt);
    ok.then_some(host)
}

/// `parseGitRemoteHost`: `None` when the remote names no host, such as a local path.
pub fn parse_git_remote_host(remote_url: &str) -> Option<GitRemoteHost> {
    let trimmed = remote_url.trim_matches(is_js_space);
    if trimmed.is_empty() {
        return None;
    }
    let host =
        if let Some(scp) = scp_remote_host(trimmed).or_else(|| userless_scp_remote_host(trimmed)) {
            scp.to_lowercase()
        } else {
            let url = parse_url(trimmed)?;
            if url.scheme() == "ssh" {
                hostname(&url)
            } else {
                host_with_port(&url)
            }
            .to_lowercase()
        };
    if host.is_empty() {
        return None;
    }
    let hostname = match parse_url(&format!("https://{host}")) {
        Some(url) => hostname(&url).to_lowercase(),
        None => strip_port(&host).to_lowercase(),
    };
    Some(GitRemoteHost {
        remote_url: trimmed.to_owned(),
        host,
        hostname,
    })
}

/// `host.replace(/:\d+$/u, "")`.
fn strip_port(host: &str) -> &str {
    match host.rsplit_once(':') {
        Some((head, port)) if !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) => head,
        _ => host,
    }
}

/// `hostname.split(".").includes(label)`.
fn has_label(hostname: &str, label: &str) -> bool {
    hostname.split('.').any(|part| part == label)
}

// ---- Per-host definitions ----------------------------------------------------------------

fn is_github_host(hostname: &str) -> bool {
    let host = hostname.to_lowercase();
    host == "github.com" || host.ends_with(".ghe.com") || has_label(&host, "github")
}

impl HostKind {
    /// `recognizeRemote`.
    fn recognize_remote(self, remote: &GitRemoteHost) -> Option<ProviderInfo> {
        let GitRemoteHost { host, hostname, .. } = remote;
        let base = || format!("https://{host}");
        match self {
            HostKind::GitHub => is_github_host(hostname).then(|| {
                let name = if hostname == "github.com" {
                    "GitHub"
                } else {
                    "GitHub Self-Hosted"
                };
                ProviderInfo::of(self, name, base())
            }),
        }
    }

    /// `parseChangeRequestUrl`; `url` is already an HTTP URL.
    fn parse_change_request_url(self, url: &Url) -> Option<ParsedChangeRequestUrl> {
        let path = url.path();
        let host = hostname(url).to_lowercase();
        let parsed = |m: Option<paths::RouteMatch<'_>>| -> Option<ParsedChangeRequestUrl> {
            let m = m?;
            let number = paths::change_request_number(m.digits)?;
            Some(ParsedChangeRequestUrl {
                link: ChangeRequestLink {
                    host: host.clone(),
                    repository: canonical_repository_path(m.repository),
                    number,
                    authority: None,
                },
                repository_url: format!("{}/{}", origin(url), m.repository),
            })
        };
        match self {
            HostKind::GitHub => parsed(paths::github_route(path)),
        }
    }

    /// `changeRequestUrl`.
    pub fn change_request_url(self, input: ChangeRequestUrlInput<'_>) -> Option<String> {
        let ChangeRequestUrlInput {
            host,
            repository,
            number,
            remote_url,
            web_url,
        } = input;
        let web_url = web_url.filter(|w| !w.is_empty());
        match self {
            HostKind::GitHub => {
                if !(1..=paths::MAX_SAFE_INTEGER).contains(&number) {
                    return None;
                }
                if let Some(web) = web_url {
                    return Some(below(web, &format!("pull/{number}")));
                }
                let segments: Vec<&str> = repository.split('/').collect();
                if segments.len() != 2 || !segments.iter().all(|s| paths::is_github_segment(s)) {
                    return None;
                }
                let base = parse_url(&remote_web_origin(host, remote_url))?;
                base.join(&format!("/{repository}/pull/{number}"))
                    .ok()
                    .map(String::from)
            }
        }
    }

    /// `changeRequestHeadRef`.
    pub fn change_request_head_ref(self, number: u64) -> Option<String> {
        Some(format!("refs/pull/{number}/head"))
    }

    /// `checkoutChangeRequestHost`.
    pub fn checkout_change_request_host(self, identity: &ProjectIdentity) -> Option<String> {
        Some(project_change_request_host(
            Some(&identity.canonical_key),
            self.as_str(),
        ))
    }

    fn change_request_host(
        self,
        _identity: &ProjectIdentity,
        canonical_key: Option<&str>,
    ) -> String {
        project_change_request_host(canonical_key, self.as_str())
    }

    /// `isChangeRequestInRepository`.
    pub fn is_change_request_in_repository(
        self,
        identity: &ProjectIdentity,
        link: &ChangeRequestLink,
    ) -> bool {
        in_project_repository(
            &project_change_request_host(Some(&identity.canonical_key), self.as_str()),
            identity,
            link,
        )
    }

    /// `canReadChangeRequestOnHost`.
    pub fn can_read_change_request_on_host(
        self,
        identity: &ProjectIdentity,
        link: &ChangeRequestLink,
    ) -> bool {
        on_project_host(
            &project_change_request_host(Some(&identity.canonical_key), self.as_str()),
            identity,
            link,
        )
    }
}

/// `projectChangeRequestHost`: the host of the project's repository key, or `kind`.
fn project_change_request_host(canonical_key: Option<&str>, kind: &str) -> String {
    let host = canonical_key
        .and_then(|k| k.split('/').next())
        .map(|h| h.trim_matches(is_js_space));
    match host {
        Some(h) if !h.is_empty() => h.to_lowercase(),
        _ => kind.to_owned(),
    }
}

/// `isChangeRequestAuthorityOfProject`.
fn is_authority_of_project(identity: &ProjectIdentity, link: &ChangeRequestLink) -> bool {
    let Some(authority) = &link.authority else {
        return true;
    };
    match parse_url(&identity.remote_url).filter(is_http) {
        Some(remote) => host_with_port(&remote).to_lowercase() == *authority,
        None => true,
    }
}

/// `isChangeRequestOnProjectHost`.
fn on_project_host(
    project_host: &str,
    identity: &ProjectIdentity,
    link: &ChangeRequestLink,
) -> bool {
    if !is_authority_of_project(identity, link) {
        return false;
    }
    project_host == link.host.to_lowercase() || Some(project_host) == link.authority.as_deref()
}

/// `isChangeRequestInProjectRepository`.
fn in_project_repository(
    project_host: &str,
    identity: &ProjectIdentity,
    link: &ChangeRequestLink,
) -> bool {
    let repository =
        identity
            .display_name
            .clone()
            .or_else(|| match (&identity.owner, &identity.name) {
                (Some(owner), Some(name)) if !owner.is_empty() && !name.is_empty() => {
                    Some(format!("{owner}/{name}"))
                }
                _ => None,
            });
    repository.is_some_and(|r| {
        canonical_repository_path(&r) == canonical_repository_path(&link.repository)
    }) && on_project_host(project_host, identity, link)
}

// ---- The registry ------------------------------------------------------------------------

/// The registry's `recognizeRemote`: the first host in recognition order that claims the
/// remote, else an unknown host. `None` when the remote names no host.
pub fn recognize_remote(remote_url: &str) -> Option<ProviderInfo> {
    let remote = parse_git_remote_host(remote_url)?;
    Some(
        HostKind::RECOGNITION_ORDER
            .into_iter()
            .find_map(|kind| kind.recognize_remote(&remote))
            .unwrap_or_else(|| unknown_remote_provider(&remote)),
    )
}

/// `unknownRemoteProvider`.
pub fn unknown_remote_provider(remote: &GitRemoteHost) -> ProviderInfo {
    ProviderInfo {
        kind: "unknown".to_owned(),
        name: remote.host.clone(),
        base_url: format!("https://{}", remote.host),
    }
}

/// `recognizeRemoteWith`: what one host alone makes of a remote.
pub fn recognize_remote_with(kind: HostKind, remote_url: &str) -> Option<ProviderInfo> {
    kind.recognize_remote(&parse_git_remote_host(remote_url)?)
}

/// The registry's `parseChangeRequestUrl`: the first host in claim order that reads `url`.
pub fn parse_change_request_url(value: &str) -> Option<(HostKind, ParsedChangeRequestUrl)> {
    let url = http_url(value)?;
    HostKind::CLAIM_ORDER
        .into_iter()
        .find_map(|kind| kind.parse_change_request_url(&url).map(|link| (kind, link)))
}

/// `isSameChangeRequest`.
pub fn is_same_change_request(left: &str, right: &str) -> bool {
    match (
        parse_change_request_url(left),
        parse_change_request_url(right),
    ) {
        (Some((_, a)), Some((_, b))) => a.link == b.link,
        _ => false,
    }
}

/// `repositoryKeyFromRemote`: `normalizeGitRemoteUrl` in the spelling the host uses on the web.
pub fn repository_key_from_remote(remote_url: &str) -> String {
    remote_key(remote_url)
}

/// The registry's `canonicalKeyPath`: the key's path in `canonicalRepositoryPath`'s spelling, so
/// keys persisted before paths had one spelling still compare equal.
fn canonical_key_path(key: &str) -> String {
    match key.split_once('/') {
        Some((host, path)) => format!("{host}/{}", canonical_repository_path(path)),
        None => key.to_owned(),
    }
}

/// `canonicalRepositoryKey`.
pub fn canonical_repository_key(key: &str) -> String {
    canonical_key_path(key)
}

/// `findByRepositoryKey`: the host with more than one spelling of `key`.
pub fn find_by_repository_key(_key: &str) -> Option<HostKind> {
    None
}

/// `repositorySelector`: what a host's tools take to select the project's repository.
pub fn repository_selector(identity: &ProjectIdentity) -> Option<String> {
    let default = || {
        identity
            .display_name
            .clone()
            .filter(|d| !d.is_empty())
            .or_else(|| match (&identity.owner, &identity.name) {
                (Some(o), Some(n)) if !o.is_empty() && !n.is_empty() => Some(format!("{o}/{n}")),
                _ => None,
            })
    };
    default()
}

/// The registry's `changeRequestHost`: the host change requests in the project are listed and
/// keyed under.
pub fn change_request_host(identity: &ProjectIdentity, kind: Option<&str>) -> Option<String> {
    let canonical = Some(identity.canonical_key.as_str()).filter(|k| !k.is_empty());
    match kind.and_then(HostKind::parse) {
        Some(host) => Some(host.change_request_host(identity, canonical)),
        None => {
            let host = canonical
                .and_then(|k| k.split('/').next())
                .map(|h| h.trim_matches(is_js_space))
                .filter(|h| !h.is_empty());
            host.map(str::to_lowercase)
                .or_else(|| kind.map(str::to_owned))
        }
    }
}

impl HostKind {
    /// The definition's `publicHost`.
    pub fn public_host(self) -> Option<&'static str> {
        Some("github.com")
    }
}

/// `findByPublicHost`.
pub fn find_by_public_host(hostname: &str) -> Option<HostKind> {
    let host = hostname.to_lowercase();
    HostKind::ALL
        .into_iter()
        .find(|k| k.public_host() == Some(host.as_str()))
}

/// `parseGitRemoteRepository`, re-exported for callers of the registry.
pub fn git_remote_repository(remote_url: &str) -> Option<(String, String)> {
    parse_git_remote_repository(remote_url)
}

#[cfg(test)]
mod tests;
