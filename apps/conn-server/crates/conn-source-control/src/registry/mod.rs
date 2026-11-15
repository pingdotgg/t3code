//! The host definition registry, the server's half: which host a remote is on, a change
//! request's URL in both directions, a repository's canonical key, and the predicates that say
//! whether a change request belongs to a project.
//!
//! T3: `packages/source-control-core/src/shared/definition.ts` (`makeSourceControlDefinitionRegistry`
//! and its helpers), `packages/source-control-definitions/src/registry.ts` (the order) and each
//! host's `src/shared/definition.ts`. URLs are read with the WHATWG parser (`url`), as `new URL`
//! reads them. What only clients use (icons, autolinks, media, checkout commands, settings
//! forms) is not here. `tools/registry-diff.mjs` runs T3's registry and this one on the same
//! cases and fails on any difference.

mod paths;
pub mod thread_keys;

use url::Url;

use crate::remote::{parse_git_remote_repository, repository_key_from_remote as remote_key};

/// The seven hosts, in the registry's display order (T3's `builtInSourceControlDefinitions`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum HostKind {
    GitHub,
    CursorOrigin,
    GitLab,
    GitCafe,
    Forgejo,
    Bitbucket,
    AzureDevOps,
}

impl HostKind {
    /// Display order; also the order hosts are probed in and the fallback for an unknown host.
    pub const ALL: [HostKind; 7] = [
        HostKind::GitHub,
        HostKind::CursorOrigin,
        HostKind::GitLab,
        HostKind::GitCafe,
        HostKind::Forgejo,
        HostKind::Bitbucket,
        HostKind::AzureDevOps,
    ];
    /// `claimChangeRequestUrlsFirst`: GitCafe, Cursor Origin and Azure DevOps, then the rest.
    const CLAIM_ORDER: [HostKind; 7] = [
        HostKind::GitCafe,
        HostKind::CursorOrigin,
        HostKind::AzureDevOps,
        HostKind::GitHub,
        HostKind::GitLab,
        HostKind::Forgejo,
        HostKind::Bitbucket,
    ];
    /// `recognizeRemotesIn`: host labels overlap, so remotes have their own order.
    const RECOGNITION_ORDER: [HostKind; 7] = [
        HostKind::GitCafe,
        HostKind::CursorOrigin,
        HostKind::Forgejo,
        HostKind::GitHub,
        HostKind::GitLab,
        HostKind::AzureDevOps,
        HostKind::Bitbucket,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            HostKind::GitHub => "github",
            HostKind::CursorOrigin => "cursor-origin",
            HostKind::GitLab => "gitlab",
            HostKind::GitCafe => "gitcafe",
            HostKind::Forgejo => "forgejo",
            HostKind::Bitbucket => "bitbucket",
            HostKind::AzureDevOps => "azure-devops",
        }
    }

    pub fn parse(kind: &str) -> Option<Self> {
        HostKind::ALL.into_iter().find(|k| k.as_str() == kind)
    }

    /// The definition's `label`.
    pub fn label(self) -> &'static str {
        match self {
            HostKind::GitHub => "GitHub",
            HostKind::CursorOrigin => "Cursor Origin",
            HostKind::GitLab => "GitLab",
            HostKind::GitCafe => "GitCafe",
            HostKind::Forgejo => "Forgejo",
            HostKind::Bitbucket => "Bitbucket",
            HostKind::AzureDevOps => "Azure DevOps",
        }
    }

    /// `changeRequest.singular`: "pull request", or "merge request" on GitLab.
    pub fn change_request_singular(self) -> &'static str {
        match self {
            HostKind::GitLab => "merge request",
            _ => "pull request",
        }
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

/// `userlessScpRemoteHost`: `/^([^@:/\\\s]{2,}):(?!:)\/?[^/\s]+(?:\/[^/\s]+)+\/?$/u`.
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
        parts.len() >= 2
            && parts
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

const GITCAFE_HOSTS: [&str; 2] = ["git.cafe", "staging.git.cafe"];
const CURSOR_ORIGIN_GIT_HOST: &str = "origin.cursor.com";
const CURSOR_ORIGIN_WEB_BASE_URL: &str = "https://cursor.com/codebase";

fn is_github_host(hostname: &str) -> bool {
    let host = hostname.to_lowercase();
    host == "github.com" || host.ends_with(".ghe.com") || has_label(&host, "github")
}

fn is_bitbucket_host(hostname: &str) -> bool {
    let host = hostname.to_lowercase();
    host == "bitbucket.org" || host.ends_with(".bitbucket.org") || has_label(&host, "bitbucket")
}

impl HostKind {
    /// `recognizeRemote`.
    fn recognize_remote(self, remote: &GitRemoteHost) -> Option<ProviderInfo> {
        let GitRemoteHost {
            remote_url,
            host,
            hostname,
        } = remote;
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
            HostKind::CursorOrigin => (hostname == CURSOR_ORIGIN_GIT_HOST).then(|| {
                ProviderInfo::of(self, "Cursor Origin", CURSOR_ORIGIN_WEB_BASE_URL.to_owned())
            }),
            HostKind::GitLab => {
                (hostname == "gitlab.com" || has_label(hostname, "gitlab")).then(|| {
                    let name = if hostname == "gitlab.com" {
                        "GitLab"
                    } else {
                        "GitLab Self-Hosted"
                    };
                    ProviderInfo::of(self, name, base())
                })
            }
            HostKind::GitCafe => GITCAFE_HOSTS
                .contains(&hostname.as_str())
                .then(|| ProviderInfo::of(self, "GitCafe", format!("https://{hostname}"))),
            HostKind::Forgejo => (hostname == "codeberg.org"
                || has_label(hostname, "forgejo")
                || has_label(hostname, "gitea"))
            .then(|| {
                let http = remote_url
                    .get(..5)
                    .is_some_and(|p| p.eq_ignore_ascii_case("http:"))
                    || remote_url
                        .get(..6)
                        .is_some_and(|p| p.eq_ignore_ascii_case("https:"));
                let base_url = if http {
                    parse_url(remote_url).map(|u| u.origin().ascii_serialization())
                } else {
                    None
                };
                ProviderInfo::of(self, "Forgejo", base_url.unwrap_or_else(base))
            }),
            HostKind::Bitbucket => {
                (hostname == "bitbucket.org" || has_label(hostname, "bitbucket")).then(|| {
                    let name = if hostname == "bitbucket.org" {
                        "Bitbucket"
                    } else {
                        "Bitbucket Self-Hosted"
                    };
                    ProviderInfo::of(self, name, base())
                })
            }
            HostKind::AzureDevOps => (hostname == "dev.azure.com"
                || hostname.ends_with(".dev.azure.com")
                || hostname.ends_with(".visualstudio.com"))
            .then(|| ProviderInfo::of(self, "Azure DevOps", base())),
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
                    repository: m.repository.to_lowercase(),
                    number,
                    authority: None,
                },
                repository_url: format!("{}/{}", origin(url), m.repository),
            })
        };
        match self {
            HostKind::GitHub => parsed(paths::two_segment_route(path, None, &["pull"])),
            HostKind::GitLab => parsed(paths::nested_route(path, &["-", "merge_requests"])),
            HostKind::CursorOrigin => {
                if host != "cursor.com" && host != "www.cursor.com" {
                    return None;
                }
                let m = paths::two_segment_route(path, Some("codebase"), &["pull"])?;
                let number = paths::change_request_number(m.digits)?;
                Some(ParsedChangeRequestUrl {
                    link: ChangeRequestLink {
                        host: CURSOR_ORIGIN_GIT_HOST.to_owned(),
                        repository: m.repository.to_lowercase(),
                        number,
                        authority: None,
                    },
                    repository_url: format!("{CURSOR_ORIGIN_WEB_BASE_URL}/{}", m.repository),
                })
            }
            HostKind::GitCafe => GITCAFE_HOSTS
                .contains(&host.as_str())
                .then(|| parsed(paths::two_segment_route(path, None, &["pull", "pulls"])))
                .flatten(),
            HostKind::Forgejo => {
                let mut link = parsed(paths::nested_route(path, &["pulls"]))?;
                link.link.authority = Some(host_with_port(url).to_lowercase());
                Some(link)
            }
            HostKind::Bitbucket => is_bitbucket_host(&host)
                .then(|| parsed(paths::two_segment_route(path, None, &["pull-requests"])))
                .flatten(),
            HostKind::AzureDevOps => {
                let mut link = parsed(paths::azure_route(path))?;
                if url.port().is_some() {
                    link.link.authority = Some(host_with_port(url).to_lowercase());
                }
                Some(link)
            }
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
            HostKind::GitLab => Some(match web_url {
                Some(web) => below(web, &format!("-/merge_requests/{number}")),
                None => format!(
                    "{}/{repository}/-/merge_requests/{number}",
                    remote_web_origin(host, remote_url)
                ),
            }),
            HostKind::CursorOrigin => Some(format!(
                "{CURSOR_ORIGIN_WEB_BASE_URL}/{repository}/pull/{number}"
            )),
            HostKind::GitCafe => Some(match web_url {
                Some(web) => below(web, &format!("pulls/{number}")),
                None => format!("https://{host}/{repository}/pulls/{number}"),
            }),
            HostKind::Forgejo => Some(match web_url {
                Some(web) => below(web, &format!("pulls/{number}")),
                None => {
                    format!(
                        "{}/{repository}/pulls/{number}",
                        remote_web_origin(host, remote_url)
                    )
                }
            }),
            HostKind::Bitbucket => Some(match web_url {
                Some(web) => below(web, &format!("pull-requests/{number}")),
                None => format!("https://{host}/{repository}/pull-requests/{number}"),
            }),
            HostKind::AzureDevOps => {
                if let Some(web) = web_url {
                    return Some(below(web, &format!("pullrequest/{number}")));
                }
                let key = format!("{host}/{repository}").to_lowercase();
                let canonical = azure_canonical_repository_key(&key).unwrap_or(key);
                let mut parts = canonical.split('/');
                let canonical_host = parts.next().filter(|h| !h.is_empty()).unwrap_or(host);
                let path: Vec<&str> = parts.collect();
                Some(format!(
                    "{}/{}/pullrequest/{number}",
                    remote_web_origin(canonical_host, remote_url),
                    path.join("/")
                ))
            }
        }
    }

    /// `changeRequestHeadRef`: the ref the target repository publishes a change request's
    /// head under, where the host has one.
    pub fn change_request_head_ref(self, number: u64) -> Option<String> {
        match self {
            HostKind::GitHub | HostKind::Forgejo => Some(format!("refs/pull/{number}/head")),
            HostKind::GitLab => Some(format!("refs/merge-requests/{number}/head")),
            _ => None,
        }
    }

    /// `checkoutChangeRequestHost`.
    pub fn checkout_change_request_host(self, identity: &ProjectIdentity) -> Option<String> {
        match self {
            HostKind::GitHub | HostKind::CursorOrigin => Some(project_change_request_host(
                Some(&identity.canonical_key),
                self.as_str(),
            )),
            _ => None,
        }
    }

    /// `changeRequestHost`, falling back to `projectChangeRequestHost`.
    fn change_request_host(self, canonical_key: Option<&str>, remote_url: Option<&str>) -> String {
        if self == HostKind::Forgejo
            && let Some(remote) = remote_url.and_then(parse_url).filter(is_http)
        {
            return host_with_port(&remote).to_lowercase();
        }
        project_change_request_host(canonical_key, self.as_str())
    }

    /// `isChangeRequestInRepository`.
    pub fn is_change_request_in_repository(
        self,
        identity: &ProjectIdentity,
        link: &ChangeRequestLink,
    ) -> bool {
        match self {
            HostKind::Forgejo => {
                if !is_authority_of_project(identity, link) {
                    return false;
                }
                match resolved_web_url(identity) {
                    None => in_project_repository(
                        &self.change_request_host(
                            Some(&identity.canonical_key),
                            Some(&identity.remote_url),
                        ),
                        identity,
                        link,
                    ),
                    Some(web) => {
                        host_with_port(&web).to_lowercase()
                            == link
                                .authority
                                .as_deref()
                                .unwrap_or(&link.host)
                                .to_lowercase()
                            && web.path().trim_matches('/').to_lowercase()
                                == link.repository.to_lowercase()
                    }
                }
            }
            HostKind::AzureDevOps => {
                if !is_authority_of_project(identity, link) {
                    return false;
                }
                let project = identity.canonical_key.to_lowercase();
                let linked = format!("{}/{}", link.host, link.repository).to_lowercase();
                azure_canonical_repository_key(&project).unwrap_or(project)
                    == azure_canonical_repository_key(&linked).unwrap_or(linked)
            }
            _ => in_project_repository(
                &project_change_request_host(Some(&identity.canonical_key), self.as_str()),
                identity,
                link,
            ),
        }
    }

    /// `canReadChangeRequestOnHost`.
    pub fn can_read_change_request_on_host(
        self,
        identity: &ProjectIdentity,
        link: &ChangeRequestLink,
    ) -> bool {
        match self {
            HostKind::AzureDevOps => false,
            HostKind::Forgejo => match resolved_web_url(identity) {
                None => on_project_host(
                    &self.change_request_host(
                        Some(&identity.canonical_key),
                        Some(&identity.remote_url),
                    ),
                    identity,
                    link,
                ),
                Some(web) => {
                    let trimmed = web.path().trim_matches('/');
                    let parts: Vec<&str> = trimmed.split('/').collect();
                    let mount = parts
                        .get(..parts.len().saturating_sub(2))
                        .map(|p| p.join("/"))
                        .unwrap_or_default();
                    host_with_port(&web).to_lowercase()
                        == link
                            .authority
                            .as_deref()
                            .unwrap_or(&link.host)
                            .to_lowercase()
                        && (mount.is_empty()
                            || link
                                .repository
                                .to_lowercase()
                                .starts_with(&format!("{}/", mount.to_lowercase())))
                }
            },
            _ => on_project_host(
                &project_change_request_host(Some(&identity.canonical_key), self.as_str()),
                identity,
                link,
            ),
        }
    }
}

/// Forgejo's `resolvedWebUrl`.
fn resolved_web_url(identity: &ProjectIdentity) -> Option<Url> {
    identity
        .web_url
        .as_deref()
        .filter(|w| !w.is_empty())
        .and_then(parse_url)
        .filter(is_http)
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
    repository.is_some_and(|r| r.to_lowercase() == link.repository.to_lowercase())
        && on_project_host(project_host, identity, link)
}

/// Azure DevOps's `canonicalRepositoryKey`: every spelling of a Services repository, on
/// `dev.azure.com`.
fn azure_canonical_repository_key(key: &str) -> Option<String> {
    let parts: Vec<&str> = key.split('/').collect();
    let mut canonical = key.to_owned();
    // `^(?:ssh\.dev\.azure\.com|vs-ssh\.visualstudio\.com)/v3/([^/]+)/([^/]+)/([^/]+)$`
    if let [host, "v3", org, project, repo] = parts.as_slice()
        && matches!(*host, "ssh.dev.azure.com" | "vs-ssh.visualstudio.com")
        && [org, project, repo].iter().all(|s| !s.is_empty())
    {
        canonical = format!("dev.azure.com/{org}/{project}/_git/{repo}");
    }
    // `^([^.]+)\.visualstudio\.com/(?:defaultcollection/)?([^/]+)/_git/([^/]+)$`
    // `[^.]+` may hold `/` and `:`: the organization is everything before the first `.`.
    let rewritten = canonical.split_once('.').and_then(|(org, tail)| {
        let rest = tail.strip_prefix("visualstudio.com/")?;
        if org.is_empty() {
            return None;
        }
        let parts: Vec<&str> = rest.split('/').collect();
        let parts = match parts.as_slice() {
            ["defaultcollection", tail @ ..] if tail.len() == 3 => tail.to_vec(),
            _ => parts,
        };
        match parts.as_slice() {
            [project, "_git", repo] if !project.is_empty() && !repo.is_empty() => {
                Some(format!("dev.azure.com/{org}/{project}/_git/{repo}"))
            }
            _ => None,
        }
    });
    if let Some(rewritten) = rewritten {
        canonical = rewritten;
    }
    canonical.starts_with("dev.azure.com/").then_some(canonical)
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

/// `canonicalRepositoryKey`.
pub fn canonical_repository_key(key: &str) -> String {
    azure_canonical_repository_key(key).unwrap_or_else(|| key.to_owned())
}

/// `findByRepositoryKey`: the host with more than one spelling of `key`.
pub fn find_by_repository_key(key: &str) -> Option<HostKind> {
    azure_canonical_repository_key(key).map(|_| HostKind::AzureDevOps)
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
    match identity.provider.as_deref().and_then(HostKind::parse) {
        Some(HostKind::AzureDevOps) => {
            let display = identity.display_name.clone().unwrap_or_default();
            let segments: Vec<&str> = display.split('/').filter(|p| *p != "_git").collect();
            let name = identity
                .name
                .clone()
                .filter(|n| !n.is_empty())
                .or_else(|| segments.last().map(|s| (*s).to_owned()))
                .filter(|n| !n.is_empty())?;
            Some(crate::remote::decode_uri_component(&name).unwrap_or(name))
        }
        _ => default(),
    }
}

/// The registry's `changeRequestHost`: the host change requests in the project are listed and
/// keyed under.
pub fn change_request_host(identity: &ProjectIdentity, kind: Option<&str>) -> Option<String> {
    let canonical = Some(identity.canonical_key.as_str()).filter(|k| !k.is_empty());
    match kind.and_then(HostKind::parse) {
        Some(host) => Some(host.change_request_host(canonical, Some(&identity.remote_url))),
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
    /// The definition's `publicHost`; Azure DevOps has none.
    pub fn public_host(self) -> Option<&'static str> {
        match self {
            HostKind::GitHub => Some("github.com"),
            HostKind::CursorOrigin => Some(CURSOR_ORIGIN_GIT_HOST),
            HostKind::GitLab => Some("gitlab.com"),
            HostKind::GitCafe => Some("git.cafe"),
            HostKind::Forgejo => Some("codeberg.org"),
            HostKind::Bitbucket => Some("bitbucket.org"),
            HostKind::AzureDevOps => None,
        }
    }
}

/// `findByPublicHost`.
pub fn find_by_public_host(hostname: &str) -> Option<HostKind> {
    let host = hostname.to_lowercase();
    HostKind::ALL
        .into_iter()
        .find(|k| k.public_host() == Some(host.as_str()))
}

/// `canonicalizeGitCafePullRequestUrl`: GitCafe's own spelling of one of its pull request URLs.
pub fn canonicalize_gitcafe_pull_request_url(value: &str) -> String {
    let parsed = parse_url(value).filter(is_http).and_then(|url| {
        GITCAFE_HOSTS
            .contains(&hostname(&url).to_lowercase().as_str())
            .then(|| HostKind::GitCafe.parse_change_request_url(&url))
            .flatten()
    });
    match parsed {
        Some(p) => HostKind::GitCafe
            .change_request_url(ChangeRequestUrlInput {
                host: &p.link.host,
                repository: &p.link.repository,
                number: p.link.number,
                remote_url: None,
                web_url: None,
            })
            .unwrap_or_else(|| value.to_owned()),
        None => value.to_owned(),
    }
}

/// `parseGitRemoteRepository`, re-exported for callers of the registry.
pub fn git_remote_repository(remote_url: &str) -> Option<(String, String)> {
    parse_git_remote_repository(remote_url)
}

#[cfg(test)]
mod tests;
