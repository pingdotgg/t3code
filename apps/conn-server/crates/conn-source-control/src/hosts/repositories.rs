//! GitHub repository lookup and creation, behind [`crate::repository::RepositoryHosts`].
//! Requests follow `GitHubSourceControlProvider.ts`.

use std::path::Path;

use conn_contract::SourceControlRepositoryVisibility as Visibility;
use serde_json::Value;

use super::{DiscoveryContext, github};
use crate::{
    cli::{self, CliCall},
    http::{HttpResponse, Method},
    repository::{CloneUrls, HostFailure, HostResult, RepositoryHosts},
};

/// The server's hosts. `ctx.cwd` is the server's own folder; each call passes its own.
#[derive(Clone, Copy, Debug)]
pub struct Hosts<'a> {
    pub ctx: DiscoveryContext<'a>,
}

impl RepositoryHosts for Hosts<'_> {
    async fn clone_urls(&self, kind: &str, cwd: &Path, repository: &str) -> HostResult<CloneUrls> {
        let ctx = DiscoveryContext { cwd, ..self.ctx };
        match kind {
            github::KIND => github_clone_urls(ctx, repository).await,
            _ => Err(unregistered(kind)),
        }
    }

    async fn create_repository(
        &self,
        kind: &str,
        cwd: &Path,
        repository: &str,
        visibility: Visibility,
    ) -> HostResult<CloneUrls> {
        let ctx = DiscoveryContext { cwd, ..self.ctx };
        match kind {
            github::KIND => github_create(ctx, repository, &visibility).await,
            _ => Err(unregistered(kind)),
        }
    }
}

/// `unsupportedProvider`: a kind with no driver here.
fn unregistered(kind: &str) -> HostFailure {
    HostFailure::new(format!("No {kind} source control provider is registered."))
}

/// A JSON string literal.
fn json_text(text: &str) -> String {
    serde_json::to_string(text).unwrap_or_else(|_| "\"\"".into())
}

/// `TrimmedNonEmptyString`: present, a string, and not blank; decoded trimmed.
fn trimmed_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)?
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

fn decode_json(text: &str) -> HostResult<Value> {
    serde_json::from_str(text).map_err(|_| HostFailure::new("The host returned invalid JSON."))
}

// ---------------------------------------------------------------------------------------------
// GitHub: `GitHubSourceControlProvider.ts` `getRepositoryCloneUrls`, `createRepository`
// ---------------------------------------------------------------------------------------------

/// `GitHubRepositoryLocator`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Locator {
    pub(crate) host: String,
    pub(crate) owner: String,
    pub(crate) name: String,
}

/// `.git` off the end of a path, before trailing slashes (`/\.git\/*$/i`).
fn without_git_suffix(path: &str) -> &str {
    let trimmed = path.trim_end_matches('/');
    match trimmed.len().checked_sub(4).and_then(|i| trimmed.get(i..)) {
        Some(tail) if tail.eq_ignore_ascii_case(".git") => {
            trimmed.get(..trimmed.len() - 4).unwrap_or(trimmed)
        }
        _ => path,
    }
}

/// `new URL(text)` for an `http`/`https` URL: the host (with a port) in lower case and the path.
fn http_url_parts(text: &str) -> Option<(String, &str)> {
    let lower_scheme = text.get(..8)?.to_ascii_lowercase();
    let rest = if lower_scheme.starts_with("https://") {
        text.get(8..)?
    } else if lower_scheme.starts_with("http://") {
        text.get(7..)?
    } else {
        return None;
    };
    let rest = rest.trim_start_matches(['/', '\\']);
    let end = rest.find(['/', '?', '#', '\\']).unwrap_or(rest.len());
    let authority = rest.get(..end)?;
    let host = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    if host.is_empty() {
        return None;
    }
    let tail = rest.get(end..)?;
    let path_end = tail.find(['?', '#']).unwrap_or(tail.len());
    Some((host.to_lowercase(), tail.get(..path_end)?))
}

/// `parseGitHubRepositorySelector`.
pub(crate) fn parse_selector(selector: &str, default_host: &str) -> Option<Locator> {
    let trimmed = selector.trim();
    if let Some((host, path)) = http_url_parts(trimmed) {
        let parts: Vec<&str> = without_git_suffix(path)
            .split('/')
            .filter(|p| !p.is_empty())
            .collect();
        return match parts.as_slice() {
            [owner, name] => Some(Locator {
                host,
                owner: (*owner).to_owned(),
                name: (*name).to_owned(),
            }),
            _ => None,
        };
    }
    let parts: Vec<&str> = without_git_suffix(trimmed)
        .split('/')
        .filter(|p| !p.is_empty())
        .collect();
    match parts.as_slice() {
        [owner, name] => Some(Locator {
            host: default_host.to_owned(),
            owner: (*owner).to_owned(),
            name: (*name).to_owned(),
        }),
        [host, owner, name] if github::is_github_host(&host.to_lowercase()) => Some(Locator {
            host: host.to_lowercase(),
            owner: (*owner).to_owned(),
            name: (*name).to_owned(),
        }),
        _ => None,
    }
}

/// `gitHubApiHostForRemote`: an SSH alias of github.com (`github`, `github.com-work`) reads as
/// github.com; otherwise a host the GitHub definition recognises (github.com, `*.ghe.com`, or a
/// name with a `github` label, such as a GitHub Enterprise Server at `github.example.com`) is
/// its own API host, with its port.
pub(crate) fn api_host_for_remote(url: &str) -> Option<String> {
    let (hostname, _) = crate::remote::parse_git_remote_repository(url)?;
    let protocol = crate::remote::clone_url_protocol(url);
    let ssh = protocol == Some(crate::remote::CloneProtocol::Ssh);
    let host = if ssh {
        hostname.clone()
    } else {
        url::Url::parse(url).ok().map_or_else(
            || hostname.clone(),
            |u| match u.port() {
                Some(port) => format!("{}:{port}", u.host_str().unwrap_or(&hostname)),
                None => u.host_str().unwrap_or(&hostname).to_owned(),
            },
        )
    };
    if ssh && !host.contains('.') {
        return host.contains("github").then(|| "github.com".to_owned());
    }
    // `/^github\.com-[a-z0-9_-]+$/`.
    if ssh
        && host.strip_prefix("github.com-").is_some_and(|alias| {
            !alias.is_empty()
                && alias
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
        })
    {
        return Some("github.com".into());
    }
    let recognized = hostname == "github.com"
        || hostname.ends_with(".ghe.com")
        || hostname.split('.').any(|label| label == "github");
    recognized.then_some(host)
}

/// `parseFetchRemotes`.
fn fetch_remotes(stdout: &str) -> Vec<(String, String)> {
    stdout
        .split('\n')
        .filter_map(|line| {
            let mut words = line.split_whitespace();
            let name = words.next()?;
            let url = words.next()?;
            let direction = words.next()?;
            let filter = words.next();
            let ok = direction == "(fetch)"
                && words.next().is_none()
                && filter.is_none_or(|f| f.starts_with('[') && f.ends_with(']') && f.len() > 2);
            ok.then(|| (name.to_owned(), url.to_owned()))
        })
        .collect()
}

/// `readRemotes`: `git remote -v` and the `gh repo set-default` marks, each empty when git
/// fails.
pub(crate) async fn read_remotes(ctx: DiscoveryContext<'_>) -> (String, String) {
    let read = |args: Vec<String>| {
        let mut call = CliCall::new(
            "GitHubSourceControlProvider.resolveRepository",
            "git",
            args,
            ctx.cwd,
        );
        call.allow_non_zero_exit = true;
        call.timeout = std::time::Duration::from_secs(5);
        call.env = ctx.probe_env(&[]);
        cli::run(call)
    };
    let (remotes, resolved) = tokio::join!(
        read(vec!["remote".into(), "-v".into()]),
        read(vec![
            "config".into(),
            "--get-regexp".into(),
            "^remote\\..*\\.gh-resolved$".into()
        ]),
    );
    let stdout = |output: Result<cli::CliOutput, _>| {
        output
            .ok()
            .filter(|o: &cli::CliOutput| o.exit_code == 0)
            .map(|o| o.stdout)
            .unwrap_or_default()
    };
    (stdout(remotes), stdout(resolved))
}

/// `resolveRepository`: `GH_REPO`, else the repository `gh` would pick among the checkout's
/// remotes ([`resolve_github_repository`]). `host_hint` is a remote's host, when the caller
/// knows the remote.
pub(crate) async fn resolve_repository_on(
    ctx: DiscoveryContext<'_>,
    host_hint: Option<&str>,
) -> HostResult<Locator> {
    let default_host = host_hint
        .map(str::to_owned)
        .or_else(|| ctx.env.get("GH_HOST"))
        .unwrap_or_else(|| "github.com".into())
        .to_lowercase();
    if let Some(repository) = ctx.env.non_blank("GH_REPO")
        && let Some(locator) = parse_selector(&repository, &default_host)
    {
        return Ok(locator);
    }
    let (remotes, resolved) = read_remotes(ctx).await;
    let (host, locator) = resolve_github_repository(&remotes, &resolved, host_hint, &default_host);
    locator.ok_or_else(|| {
        HostFailure::new(format!(
            "No GitHub repository on {host} was found among this checkout's git remotes."
        ))
    })
}

/// [`resolve_repository_on`] without a host hint.
pub(crate) async fn resolve_repository(ctx: DiscoveryContext<'_>) -> HostResult<Locator> {
    resolve_repository_on(ctx, None).await
}

/// `isSshRemoteUrl`: `user@host:`, `ssh://`, or a user-less `host:path`.
pub(crate) fn is_ssh_remote_url(url: &str) -> bool {
    let trimmed = url.trim();
    // `/^[a-zA-Z0-9._-]+@([^:/]+):/`
    let scp = trimmed.split_once('@').is_some_and(|(user, rest)| {
        !user.is_empty()
            && user
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
            && rest
                .split_once(':')
                .is_some_and(|(host, _)| !host.is_empty() && !host.contains('/'))
    });
    scp || trimmed.to_lowercase().starts_with("ssh://") || userless_scp_host(trimmed)
}

/// `USERLESS_SCP_SSH_REMOTE_PATTERN`: `host:path`, a host of two or more characters, no `::`.
fn userless_scp_host(trimmed: &str) -> bool {
    let Some((host, path)) = trimmed.split_once(':') else {
        return false;
    };
    let host_ok = host.chars().count() >= 2
        && !host
            .chars()
            .any(|c| matches!(c, '@' | ':' | '/' | '\\') || c.is_whitespace());
    if !host_ok || path.starts_with(':') {
        return false;
    }
    let path = path.strip_prefix('/').unwrap_or(path);
    let path = path.strip_suffix('/').unwrap_or(path);
    !path.is_empty()
        && path
            .split('/')
            .all(|part| !part.is_empty() && !part.chars().any(char::is_whitespace))
}

/// `/^github\.com-[a-z0-9_-]+$/`.
fn is_github_dot_com_alias(host: &str) -> bool {
    host.strip_prefix("github.com-").is_some_and(|alias| {
        !alias.is_empty()
            && alias
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
    })
}

/// `apiHostForSshAlias`: `Some(None)` for an undotted host that is not GitHub's.
fn api_host_for_ssh_alias(host: &str) -> Option<Option<String>> {
    if !host.contains('.') {
        return Some(host.contains("github").then(|| "github.com".to_owned()));
    }
    is_github_dot_com_alias(host).then(|| Some("github.com".to_owned()))
}

fn normalized_host(url: &str) -> String {
    let normalized = crate::remote::normalize_git_remote_url(url);
    normalized.split('/').next().unwrap_or_default().to_owned()
}

/// `apiHostForHint`.
fn api_host_for_hint(host: &str, remotes: &[(String, String)]) -> String {
    let normalized = host.to_lowercase();
    if is_github_dot_com_alias(&normalized) {
        let matching: Vec<&(String, String)> = remotes
            .iter()
            .filter(|(_, url)| normalized_host(url) == normalized)
            .collect();
        if matching.is_empty() || matching.iter().any(|(_, url)| !is_ssh_remote_url(url)) {
            return normalized;
        }
    }
    api_host_for_ssh_alias(&normalized)
        .flatten()
        .unwrap_or(normalized)
}

/// `selectGitHubBaseRepository`: `gh`'s pick of the base repository on `host`: the remote
/// `gh repo set-default` marked, else `upstream`, `github`, `origin`, else the only remote.
/// `None` when a remote is on another host or the pick is ambiguous.
fn select_base_repository(remotes: &str, resolved: &str, host: &str) -> Option<(String, String)> {
    let host = host.to_lowercase();
    let mut repositories: Vec<(String, (String, String))> = Vec::new();
    for (remote, url) in fetch_remotes(remotes) {
        let normalized = crate::remote::normalize_git_remote_url(&url);
        let mut parts = normalized.split('/');
        let normalized_host = parts.next().unwrap_or_default();
        let owner = parts.next().unwrap_or_default();
        let name = parts.next().unwrap_or_default();
        let remote_host = if !normalized_host.is_empty() && is_ssh_remote_url(&url) {
            api_host_for_ssh_alias(normalized_host)
                .flatten()
                .unwrap_or_else(|| normalized_host.to_owned())
        } else {
            normalized_host.to_owned()
        };
        if remote_host != host || owner.is_empty() || name.is_empty() || parts.next().is_some() {
            return None;
        }
        let value = (owner.to_owned(), name.to_owned());
        match repositories.iter_mut().find(|(n, _)| *n == remote) {
            Some(entry) => entry.1 = value,
            None => repositories.push((remote, value)),
        }
    }
    let marks: Vec<(&str, &str)> = resolved
        .split('\n')
        .filter_map(|line| {
            let rest = line.trim().strip_prefix("remote.")?;
            // `^remote\.(.+)\.gh-resolved\s+(\S+)$`, greedy on the name.
            let at = rest.rfind(".gh-resolved")?;
            let (name, tail) = (rest.get(..at)?, rest.get(at + ".gh-resolved".len()..)?);
            let value = tail.trim_start();
            let ok = !name.is_empty()
                && tail.starts_with(char::is_whitespace)
                && !value.is_empty()
                && !value.contains(char::is_whitespace);
            ok.then_some((name, value))
        })
        .filter(|(name, _)| repositories.iter().any(|(n, _)| n == name))
        .collect();
    if marks.len() > 1 {
        return None;
    }
    if let Some((name, value)) = marks.first() {
        if *value == "base" {
            return repositories
                .iter()
                .find(|(n, _)| n == name)
                .map(|(_, r)| r.clone());
        }
        let lower = value.to_lowercase();
        let parts: Vec<&str> = lower.split('/').collect();
        return match parts.as_slice() {
            [owner, name] if !owner.is_empty() && !name.is_empty() => {
                Some(((*owner).to_owned(), (*name).to_owned()))
            }
            _ => None,
        };
    }
    let score = |name: &str| match name.to_lowercase().as_str() {
        "origin" => 1,
        "github" => 2,
        "upstream" => 3,
        _ => 0,
    };
    repositories.sort_by_key(|(name, _)| std::cmp::Reverse(score(name)));
    match repositories.as_slice() {
        [] => None,
        [(_, top)] => Some(top.clone()),
        [(top_name, top), (next_name, _), ..] => {
            (score(top_name) > score(next_name)).then(|| top.clone())
        }
    }
}

/// `resolveGitHubRepository`: the API host and the repository `gh` would target, from
/// `git remote -v` and the `gh-resolved` marks.
pub(crate) fn resolve_github_repository(
    remotes: &str,
    resolved: &str,
    host_hint: Option<&str>,
    default_host: &str,
) -> (String, Option<Locator>) {
    let fetch: Vec<(String, String)> = fetch_remotes(remotes);
    let hosts: Vec<Option<String>> = fetch
        .iter()
        .map(|(_, url)| api_host_for_remote(url))
        .collect();
    let host = host_hint
        .map(|hint| api_host_for_hint(hint, &fetch))
        .or_else(|| {
            fetch
                .iter()
                .zip(&hosts)
                .find(|((name, _), host)| name == "origin" && host.is_some())
                .and_then(|(_, host)| host.clone())
        })
        .or_else(|| hosts.iter().flatten().next().cloned())
        .unwrap_or_else(|| default_host.to_owned());
    if let Some((owner, name)) = select_base_repository(remotes, resolved, &host) {
        let locator = Locator {
            host: host.clone(),
            owner,
            name,
        };
        return (host, Some(locator));
    }
    let rank = |name: &str| match name.to_lowercase().as_str() {
        "upstream" => 0,
        "github" => 1,
        "origin" => 2,
        _ => 99,
    };
    let mut candidates: Vec<&(String, String)> = fetch
        .iter()
        .zip(&hosts)
        .filter(|((_, url), remote_host)| match remote_host {
            Some(remote_host) => *remote_host == host,
            None => normalized_host(url) == host,
        })
        .map(|(remote, _)| remote)
        .collect();
    candidates.sort_by_key(|(name, _)| rank(name));
    for (_, url) in candidates {
        let normalized = crate::remote::normalize_git_remote_url(url);
        let parts: Vec<&str> = normalized.split('/').skip(1).collect();
        if let [owner, name] = parts.as_slice()
            && !owner.is_empty()
            && !name.is_empty()
        {
            let locator = Locator {
                host: host.clone(),
                owner: (*owner).to_owned(),
                name: (*name).to_owned(),
            };
            return (host, Some(locator));
        }
    }
    (host, None)
}

fn gh_host(ctx: DiscoveryContext<'_>) -> Option<String> {
    ctx.env.get("GH_HOST")
}

/// `api.rest` through `fromGitHubApiError`.
async fn github_rest(
    ctx: DiscoveryContext<'_>,
    host: &str,
    method: Method,
    path: &str,
    body: Option<String>,
) -> HostResult<HttpResponse> {
    let token = github::credential(ctx, host)
        .await
        .map_err(|e| HostFailure::new(format!("GitHub credential: {e:?}")))?;
    let root = (host == "github.com")
        .then_some(())
        .and(ctx.endpoints.github_rest.as_deref());
    let body = body.map(|b| serde_json::from_str::<Value>(&b).unwrap_or(Value::Null));
    github::rest(
        github::RestRequest {
            host,
            method,
            path,
            body,
        },
        token,
        root,
        github::RestOptions::default(),
    )
    .await
    .map_err(|e| HostFailure::new(e.message()))
}

/// `readViewerLogin`.
async fn github_viewer(ctx: DiscoveryContext<'_>, host: &str) -> HostResult<String> {
    let response = github_rest(ctx, host, Method::Get, "user", None).await?;
    let value = decode_json(&response.text())?;
    trimmed_field(&value, "login").ok_or_else(|| HostFailure::new("GitHub request failed."))
}

/// `RawRepositorySchema` and `repositoryCloneUrls`.
fn github_urls(response: &HttpResponse) -> HostResult<CloneUrls> {
    github_urls_value(&decode_json(&response.text())?)
}

pub(crate) fn github_urls_value(value: &Value) -> HostResult<CloneUrls> {
    match (
        trimmed_field(value, "full_name"),
        trimmed_field(value, "html_url"),
        trimmed_field(value, "ssh_url"),
    ) {
        (Some(name_with_owner), Some(url), Some(ssh_url)) => Ok(CloneUrls {
            name_with_owner,
            url,
            ssh_url,
        }),
        _ => Err(HostFailure::new("GitHub returned an invalid repository.")),
    }
}

fn repo_path(owner: &str, name: &str) -> String {
    format!(
        "repos/{}/{}",
        github::encode_uri_component(owner),
        github::encode_uri_component(name)
    )
}

async fn github_clone_urls(ctx: DiscoveryContext<'_>, repository: &str) -> HostResult<CloneUrls> {
    let env_default = gh_host(ctx).unwrap_or_else(|| "github.com".into());
    let fallback_host = resolve_repository(ctx)
        .await
        .map(|locator| locator.host)
        .unwrap_or(env_default)
        .to_lowercase();
    // `bareName`: `/\.git$/i` off the trimmed name.
    let trimmed = repository.trim();
    let bare = trimmed
        .len()
        .checked_sub(4)
        .and_then(|i| Some((trimmed.get(..i)?, trimmed.get(i..)?)))
        .filter(|(_, tail)| tail.eq_ignore_ascii_case(".git"))
        .map_or(trimmed, |(head, _)| head);
    let locator = match parse_selector(repository, &fallback_host) {
        Some(locator) => locator,
        None if !bare.is_empty()
            && !bare.contains('/')
            && !bare.chars().any(char::is_whitespace) =>
        {
            Locator {
                owner: github_viewer(ctx, &fallback_host).await?,
                host: fallback_host,
                name: bare.to_owned(),
            }
        }
        None => return Err(HostFailure::new("Repositories are named owner/name.")),
    };
    let response = github_rest(
        ctx,
        &locator.host,
        Method::Get,
        &repo_path(&locator.owner, &locator.name),
        None,
    )
    .await?;
    github_urls(&response)
}

async fn github_create(
    ctx: DiscoveryContext<'_>,
    repository: &str,
    visibility: &Visibility,
) -> HostResult<CloneUrls> {
    let default_host = gh_host(ctx)
        .unwrap_or_else(|| "github.com".into())
        .to_lowercase();
    let locator = parse_selector(repository, &default_host);
    let viewer = match &locator {
        Some(l) => Some(github_viewer(ctx, &l.host).await?),
        None => None,
    };
    let owner = locator.as_ref().map(|l| l.owner.clone()).or(viewer.clone());
    let name = locator
        .as_ref()
        .map_or_else(|| repository.trim().to_owned(), |l| l.name.clone());
    let host = locator.as_ref().map_or_else(
        || {
            gh_host(ctx)
                .map(|h| h.trim().to_lowercase())
                .filter(|h| !h.is_empty())
                .unwrap_or_else(|| "github.com".into())
        },
        |l| l.host.clone(),
    );
    let is_viewer =
        matches!((&viewer, &owner), (Some(v), Some(o)) if o.to_lowercase() == v.to_lowercase());
    let path = match &owner {
        Some(owner) if !is_viewer => format!("orgs/{}/repos", github::encode_uri_component(owner)),
        _ => "user/repos".into(),
    };
    let body = format!(
        "{{\"name\":{},\"private\":{}}}",
        json_text(&name),
        matches!(visibility, Visibility::Private)
    );
    let response = github_rest(ctx, &host, Method::Post, &path, Some(body)).await?;
    github_urls(&response)
}

pub(crate) async fn checkout_clone_urls(
    ctx: DiscoveryContext<'_>,
    host: &str,
    repository: &str,
) -> HostResult<CloneUrls> {
    let locator = parse_selector(repository, host)
        .ok_or_else(|| HostFailure::new("Repositories are named owner/name."))?;
    let value = github::api_json(
        ctx,
        ctx.cwd,
        &locator.host,
        &repo_path(&locator.owner, &locator.name),
        None,
        "Repository not found. Check the owner and name and try again.",
    )
    .await?;
    github_urls_value(&value)
}

#[cfg(test)]
#[path = "repositories_tests.rs"]
mod tests;
