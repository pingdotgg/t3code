//! Each host's `getRepositoryCloneUrls` and `createRepository`, behind
//! [`crate::repository::RepositoryHosts`]. One section per host, in the T3 server's order; each
//! names its T3 source.
//!
//! A host failure reaches the client only as T3's fixed text (see `repository.rs`), so the
//! failures here carry a detail for logs and tests, and a user-facing text only where the T3
//! error has one (Bitbucket's repository shape).

use std::{ffi::OsString, path::Path};

use conn_contract::SourceControlRepositoryVisibility as Visibility;
use serde::Deserialize;
use serde_json::Value;

use super::{
    DiscoveryContext, bitbucket, cursor_origin, forgejo,
    forgejo_cli::{self, Session},
    gitcafe,
    gitcafe_api::{self, Client},
    github,
};
use crate::{
    cli::{self, CliCall},
    http::{self, HttpRequest, HttpResponse, Method},
    repository::{CloneUrls, HostFailure, HostResult, RepositoryHosts},
    secret::Secret,
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
            cursor_origin::KIND => origin_clone_urls(ctx, repository).await,
            super::gitlab::KIND => gitlab_clone_urls(ctx, repository).await,
            gitcafe::KIND => gitcafe_clone_urls(&self.gitcafe(ctx), repository).await,
            forgejo::KIND => Box::pin(forgejo_clone_urls(ctx, repository)).await,
            bitbucket::KIND => bitbucket_clone_urls(ctx, repository).await,
            super::azure_devops::KIND => azure_clone_urls(ctx, repository).await,
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
            cursor_origin::KIND => origin_create(ctx, repository, &visibility).await,
            super::gitlab::KIND => gitlab_create(ctx, repository, &visibility).await,
            gitcafe::KIND => gitcafe_create(&self.gitcafe(ctx), repository, &visibility).await,
            forgejo::KIND => Box::pin(forgejo_create(ctx, repository, &visibility)).await,
            bitbucket::KIND => bitbucket_create(ctx, repository, &visibility).await,
            super::azure_devops::KIND => azure_create(ctx, repository).await,
            _ => Err(unregistered(kind)),
        }
    }
}

impl<'a> Hosts<'a> {
    /// GitCafe asks `cafe` for its credential in the server's own folder.
    fn gitcafe(&self, ctx: DiscoveryContext<'a>) -> Client<'a> {
        Client::new(ctx, self.ctx.cwd)
    }
}

/// `unsupportedProvider`: a kind with no driver here.
fn unregistered(kind: &str) -> HostFailure {
    HostFailure::new(format!("No {kind} source control provider is registered."))
}

fn visibility_text(visibility: &Visibility) -> &'static str {
    match visibility {
        Visibility::Private => "private",
        Visibility::Public => "public",
    }
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

/// A host CLI call in the call's folder, with `extra` added to the environment.
async fn run_cli(
    ctx: DiscoveryContext<'_>,
    operation: &'static str,
    program: &str,
    args: Vec<String>,
    extra: &[(&'static str, OsString)],
) -> HostResult<String> {
    let mut call = CliCall::new(operation, program, args, ctx.cwd);
    call.env = ctx.probe_env(extra);
    cli::run(call)
        .await
        .map(|output| output.stdout)
        .map_err(|failure| HostFailure::new(failure.to_string()))
}

// ---------------------------------------------------------------------------------------------
// GitHub: `GitHubSourceControlProvider.ts` `getRepositoryCloneUrls`, `createRepository`
// ---------------------------------------------------------------------------------------------

/// `GitHubRepositoryLocator`.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Locator {
    host: String,
    owner: String,
    name: String,
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
fn parse_selector(selector: &str, default_host: &str) -> Option<Locator> {
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

/// `gitHubApiHostForRemote`, reduced: github.com (also through an SSH alias such as
/// `github.com-work`) and `*.ghe.com`. A GitHub Enterprise Server host is not recognised from a
/// remote here.
fn api_host_for_remote(url: &str) -> Option<String> {
    let (host, _) = crate::remote::parse_git_remote_repository(url)?;
    let ssh = crate::remote::clone_url_protocol(url) == Some(crate::remote::CloneProtocol::Ssh);
    if ssh && !host.contains('.') {
        return host.contains("github").then(|| "github.com".to_owned());
    }
    if ssh
        && host
            .strip_prefix("github.com-")
            .is_some_and(|alias| !alias.is_empty() && !alias.contains('.'))
    {
        return Some("github.com".into());
    }
    (host == "github.com" || host.ends_with(".ghe.com")).then_some(host)
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

/// The host part of `resolveRepository`: `GH_REPO`, else the checkout's GitHub remote
/// (origin first). `None` when neither names a repository.
async fn resolve_repository_host(ctx: DiscoveryContext<'_>, default_host: &str) -> Option<String> {
    if let Some(repository) = ctx.env.non_blank("GH_REPO")
        && let Some(locator) = parse_selector(&repository, default_host)
    {
        return Some(locator.host);
    }
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
    let (remotes, _resolved) = tokio::join!(
        read(vec!["remote".into(), "-v".into()]),
        read(vec![
            "config".into(),
            "--get-regexp".into(),
            "^remote\\..*\\.gh-resolved$".into()
        ]),
    );
    let remotes = remotes
        .ok()
        .filter(|o| o.exit_code == 0)
        .map(|o| fetch_remotes(&o.stdout))
        .unwrap_or_default();
    let hosts: Vec<(String, Option<String>)> = remotes
        .iter()
        .map(|(name, url)| (name.clone(), api_host_for_remote(url)))
        .collect();
    let host = hosts
        .iter()
        .find(|(name, host)| name == "origin" && host.is_some())
        .or_else(|| hosts.iter().find(|(_, host)| host.is_some()))
        .and_then(|(_, host)| host.clone())
        .unwrap_or_else(|| default_host.to_owned());
    let names_repository = remotes.iter().any(|(_, url)| {
        api_host_for_remote(url).as_deref() == Some(host.as_str())
            && crate::remote::parse_git_remote_repository(url)
                .is_some_and(|(_, path)| path.split('/').count() == 2)
    });
    names_repository.then_some(host)
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
    let value = decode_json(&response.text())?;
    match (
        trimmed_field(&value, "full_name"),
        trimmed_field(&value, "html_url"),
        trimmed_field(&value, "ssh_url"),
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
    let fallback_host = resolve_repository_host(ctx, &env_default.to_lowercase())
        .await
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

// ---------------------------------------------------------------------------------------------
// Cursor Origin: `OriginSourceControlProvider.ts`, `OriginCli.api`
// ---------------------------------------------------------------------------------------------

/// `originRepositoryPath`.
fn origin_repository_path(repository: &str) -> String {
    format!(
        "/v1/origin/repos/{}",
        repository
            .split('/')
            .map(github::encode_uri_component)
            .collect::<Vec<_>>()
            .join("/")
    )
}

/// `OriginCli.api`: the session token, one request, and after a 401 one more with a fresh
/// token. `Err` holds the status of a refused answer (0 when there was none).
async fn origin_api(
    ctx: DiscoveryContext<'_>,
    method: Method,
    path: &str,
    body: Option<String>,
) -> Result<Value, u16> {
    let base = ctx
        .endpoints
        .cursor_origin_api
        .as_deref()
        .unwrap_or(cursor_origin::DEFAULT_API_BASE);
    let send = |token: Secret| {
        let mut request = HttpRequest::new(method, format!("{base}{path}"))
            .secret_header("authorization", "Bearer ", token)
            .header("accept", "application/json");
        if let Some(body) = &body {
            request = request
                .header("content-type", "application/json")
                .body(body.clone().into_bytes());
        }
        http::send(request)
    };
    let token = cursor_origin::session_token(ctx).await.ok_or(401u16)?;
    let mut response = send(token).await.map_err(|_| 0u16)?;
    if response.status == 401 {
        let fresh = cursor_origin::session_token(ctx).await.ok_or(401u16)?;
        response = send(fresh).await.map_err(|_| 0u16)?;
    }
    if !(200..300).contains(&response.status) || response.truncated {
        return Err(response.status);
    }
    let text = response.text();
    let text = if text.trim().is_empty() {
        "{}".into()
    } else {
        text
    };
    serde_json::from_str(&text).map_err(|_| 0)
}

/// `OriginRepositorySchema` and `cloneUrls`.
fn origin_urls(value: &Value, fallback_name: &str) -> HostResult<CloneUrls> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Owner {
        slug: String,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Repository {
        name: String,
        full_name: Option<String>,
        owner: Option<Owner>,
        clone_url: Option<String>,
    }
    let repository: Repository = serde_json::from_value(value.clone()).map_err(|_| {
        HostFailure::new("Cursor Origin returned a response this version cannot read.")
    })?;
    let name_with_owner = repository
        .full_name
        .unwrap_or_else(|| match repository.owner {
            Some(owner) => format!("{}/{}", owner.slug, repository.name),
            None => fallback_name.to_owned(),
        });
    // Origin documents no SSH clone URL, and `origin auth login` configures git's HTTPS
    // credential helper, so HTTPS stands in for both.
    let url = repository
        .clone_url
        .unwrap_or_else(|| format!("https://origin.cursor.com/{name_with_owner}.git"));
    Ok(CloneUrls {
        name_with_owner,
        ssh_url: url.clone(),
        url,
    })
}

fn origin_failure(status: u16) -> HostFailure {
    HostFailure::new(format!("Cursor Origin answered HTTP {status}."))
}

async fn origin_clone_urls(ctx: DiscoveryContext<'_>, repository: &str) -> HostResult<CloneUrls> {
    let value = origin_api(ctx, Method::Get, &origin_repository_path(repository), None)
        .await
        .map_err(origin_failure)?;
    origin_urls(&value, repository)
}

async fn origin_create(
    ctx: DiscoveryContext<'_>,
    repository: &str,
    visibility: &Visibility,
) -> HostResult<CloneUrls> {
    if matches!(visibility, Visibility::Public) {
        return Err(HostFailure::new(
            "Cursor Origin repositories are private. Choose private visibility.",
        ));
    }
    let parts: Vec<&str> = repository.split('/').collect();
    if parts.len() > 2 || parts.iter().any(|p| p.trim().is_empty()) {
        return Err(HostFailure::new(
            "Specify an Origin repository as owner/name or name.",
        ));
    }
    let (owner, name) = match parts.as_slice() {
        [owner, name] => ((*owner).to_owned(), (*name).to_owned()),
        _ => {
            let list = origin_api(ctx, Method::Get, "/v1/origin/namespaces", None)
                .await
                .map_err(origin_failure)?;
            let owner = cursor_origin::personal_namespace_slug(&list.to_string()).ok_or_else(|| {
                HostFailure::new(
                    "This Cursor account has no Origin namespace. Claim one at cursor.com/codebase.",
                )
            })?;
            (owner, repository.to_owned())
        }
    };
    origin_api(
        ctx,
        Method::Post,
        &format!("/v1/origin/repos/{}", github::encode_uri_component(&owner)),
        Some(format!("{{\"name\":{}}}", json_text(&name))),
    )
    .await
    .map_err(origin_failure)?;
    // Origin creates repositories internal and takes a visibility only on update, so the
    // repository is made private straight after (up to three tries, a second apart).
    let full = format!("{owner}/{name}");
    let mut tries = 0;
    let made_private = loop {
        match origin_api(
            ctx,
            Method::Patch,
            &origin_repository_path(&full),
            Some("{\"visibility\":\"private\"}".into()),
        )
        .await
        {
            Ok(value) => break value,
            Err(status) if tries < 2 && status != 429 && status != 401 => {
                tries += 1;
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            }
            Err(_) => {
                return Err(HostFailure::new(format!(
                    "Created {full}, but could not make it private, so your Cursor team can still see it. Set it to private on cursor.com."
                )));
            }
        }
    };
    origin_urls(&made_private, &full)
}

// ---------------------------------------------------------------------------------------------
// GitLab: `GitLabCli.ts` `getRepositoryCloneUrls`, `createRepository`
// ---------------------------------------------------------------------------------------------

/// `RawGitLabRepositoryCloneUrlsSchema` and `normalizeRepositoryCloneUrls`.
fn gitlab_urls(stdout: &str) -> HostResult<CloneUrls> {
    let value = decode_json(stdout.trim())?;
    match (
        trimmed_field(&value, "path_with_namespace"),
        trimmed_field(&value, "web_url"),
        trimmed_field(&value, "http_url_to_repo"),
        trimmed_field(&value, "ssh_url_to_repo"),
    ) {
        (Some(name_with_owner), Some(url), Some(_), Some(ssh_url)) => Ok(CloneUrls {
            name_with_owner,
            url,
            ssh_url,
        }),
        _ => Err(HostFailure::new("GitLab returned an invalid project.")),
    }
}

async fn glab(ctx: DiscoveryContext<'_>, args: Vec<String>) -> HostResult<String> {
    run_cli(ctx, "GitLabCli.execute", "glab", args, &[]).await
}

async fn gitlab_clone_urls(ctx: DiscoveryContext<'_>, repository: &str) -> HostResult<CloneUrls> {
    let stdout = glab(
        ctx,
        vec![
            "api".into(),
            format!("projects/{}", github::encode_uri_component(repository)),
        ],
    )
    .await?;
    gitlab_urls(&stdout)
}

/// `parseRepositoryPath`: the last segment is the project, the rest its namespace.
fn gitlab_repository_path(repository: &str) -> (Option<String>, String) {
    let parts: Vec<&str> = repository
        .split('/')
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .collect();
    let project = parts
        .last()
        .map_or_else(|| repository.trim().to_owned(), |p| (*p).to_owned());
    let namespace =
        (parts.len() > 1).then(|| parts.get(..parts.len() - 1).unwrap_or_default().join("/"));
    (namespace, project)
}

async fn gitlab_create(
    ctx: DiscoveryContext<'_>,
    repository: &str,
    visibility: &Visibility,
) -> HostResult<CloneUrls> {
    let (namespace, project) = gitlab_repository_path(repository);
    let namespace_id = match namespace {
        Some(namespace) => {
            let stdout = glab(
                ctx,
                vec![
                    "api".into(),
                    format!("namespaces/{}", github::encode_uri_component(&namespace)),
                ],
            )
            .await?;
            let value = decode_json(stdout.trim())?;
            let id = value
                .get("id")
                .filter(|id| id.is_number())
                .ok_or_else(|| HostFailure::new("GitLab returned an invalid namespace."))?;
            Some(id.to_string())
        }
        None => None,
    };
    let mut args: Vec<String> = ["api", "--method", "POST", "projects", "--raw-field"]
        .map(str::to_owned)
        .into();
    args.push(format!("path={project}"));
    args.push("--raw-field".into());
    args.push(format!("name={project}"));
    args.push("--raw-field".into());
    args.push(format!("visibility={}", visibility_text(visibility)));
    if let Some(id) = namespace_id {
        args.push("--raw-field".into());
        args.push(format!("namespace_id={id}"));
    }
    gitlab_urls(&glab(ctx, args).await?)
}

// ---------------------------------------------------------------------------------------------
// GitCafe: `GitCafeSourceControlProvider.ts` `getRepositoryCloneUrls`, `createRepository`
// ---------------------------------------------------------------------------------------------

/// How long `createRepository` waits for GitCafe to admit a repository, and how often it asks.
const GITCAFE_ADMISSION_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
const GITCAFE_ADMISSION_POLL: std::time::Duration = std::time::Duration::from_millis(500);

fn gitcafe_failure(error: gitcafe_api::GitCafeError) -> HostFailure {
    HostFailure::new(error.detail)
}

fn gitcafe_unreadable() -> HostFailure {
    HostFailure::new("GitCafe returned an unreadable response.")
}

/// `TrimmedNonEmptyString` or `null` (`Schema.NullOr`), present.
fn trimmed_or_null(value: &Value, key: &str) -> Option<()> {
    match value.get(key)? {
        Value::Null => Some(()),
        Value::String(s) if !s.trim().is_empty() => Some(()),
        _ => None,
    }
}

async fn gitcafe_clone_urls(client: &Client<'_>, repository: &str) -> HostResult<CloneUrls> {
    let target = client
        .resolve_named(repository)
        .await
        .map_err(gitcafe_failure)?;
    let text = client
        .request(
            target.host,
            Method::Get,
            &format!("/repos/{}", target.repository),
            None,
        )
        .await
        .map_err(gitcafe_failure)?;
    // `Repository`: a name and a default branch (or null).
    let value = decode_json(&text).map_err(|_| gitcafe_unreadable())?;
    trimmed_field(&value, "name").ok_or_else(gitcafe_unreadable)?;
    trimmed_or_null(&value, "defaultBranch").ok_or_else(gitcafe_unreadable)?;
    Ok(gitcafe_api::clone_urls(&target))
}

/// `RepositoryAdmission`.
struct Admission {
    repo_id: String,
    state: String,
    owner: String,
    name: String,
}

fn decode_admission(text: &str) -> HostResult<Admission> {
    let value = decode_json(text).map_err(|_| gitcafe_unreadable())?;
    let state = value
        .get("state")
        .and_then(Value::as_str)
        .ok_or_else(gitcafe_unreadable)?
        .to_owned();
    match (
        trimmed_field(&value, "repoId"),
        trimmed_field(&value, "owner"),
        trimmed_field(&value, "name"),
    ) {
        (Some(repo_id), Some(owner), Some(name)) => Ok(Admission {
            repo_id,
            state,
            owner,
            name,
        }),
        _ => Err(gitcafe_unreadable()),
    }
}

async fn gitcafe_create(
    client: &Client<'_>,
    repository: &str,
    visibility: &Visibility,
) -> HostResult<CloneUrls> {
    let target = client
        .resolve_named(repository)
        .await
        .map_err(gitcafe_failure)?;
    let (owner, name) = target
        .repository
        .split_once('/')
        .unwrap_or((target.repository.as_str(), ""));
    // `bodyJsonUnsafe` keeps the key order of T3's object literal.
    let body = format!(
        "{{\"name\":{},\"requestKey\":{},\"visibility\":{},\"defaultBranch\":\"main\"}}",
        json_text(name),
        json_text(&conn_support::uuid_v4()),
        json_text(visibility_text(visibility)),
    );
    let pending = decode_admission(
        &client
            .request(
                target.host,
                Method::Post,
                &format!("/orgs/{owner}/repos"),
                Some(&body),
            )
            .await
            .map_err(gitcafe_failure)?,
    )?;
    // GitCafe admits a repository asynchronously and answers while admission is still running,
    // so wait for it to settle the way `cafe repo create --clone` does.
    let settled = |state: &str| state == "complete" || state == "blocked";
    let resource = if settled(&pending.state) {
        pending
    } else {
        let path = format!("/orgs/{}/admissions/{}", pending.owner, pending.repo_id);
        let poll = async {
            loop {
                let admission = decode_admission(
                    &client
                        .request(target.host, Method::Get, &path, None)
                        .await
                        .map_err(gitcafe_failure)?,
                )?;
                if settled(&admission.state) {
                    return Ok::<_, HostFailure>(admission);
                }
                tokio::time::sleep(GITCAFE_ADMISSION_POLL).await;
            }
        };
        match tokio::time::timeout(GITCAFE_ADMISSION_TIMEOUT, poll).await {
            Ok(result) => result?,
            Err(_) => pending,
        }
    };
    if resource.state != "complete" {
        return Err(HostFailure::new(format!(
            "GitCafe repository {} is {}. Check it on GitCafe before retrying.",
            target.repository, resource.state
        )));
    }
    Ok(gitcafe_api::clone_urls(&gitcafe_api::Target {
        host: target.host,
        repository: format!("{}/{}", resource.owner, resource.name),
    }))
}

// ---------------------------------------------------------------------------------------------
// Forgejo: `ForgejoSourceControlProvider.ts` `getRepositoryCloneUrls`, `createRepository`
// ---------------------------------------------------------------------------------------------

fn forgejo_failure(error: forgejo_cli::ForgejoError) -> HostFailure {
    HostFailure::new(error.detail)
}

fn forgejo_invalid() -> HostFailure {
    HostFailure::new("Forgejo API returned an invalid response.")
}

/// `RepositorySchema` and `cloneUrls`.
fn forgejo_urls(text: &str) -> HostResult<CloneUrls> {
    let value = decode_json(text).map_err(|_| forgejo_invalid())?;
    let field = |key: &str| {
        value
            .get(key)
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(forgejo_invalid)
    };
    match value.get("default_branch") {
        None | Some(Value::Null | Value::String(_)) => {}
        Some(_) => return Err(forgejo_invalid()),
    }
    Ok(CloneUrls {
        name_with_owner: field("full_name")?,
        url: field("clone_url")?,
        ssh_url: field("ssh_url")?,
    })
}

async fn forgejo_clone_urls(ctx: DiscoveryContext<'_>, repository: &str) -> HostResult<CloneUrls> {
    let mut session = Session::new(ctx);
    let input = forgejo_cli::Input {
        repository: Some(repository),
        ..forgejo_cli::Input::default()
    };
    let resolved = session
        .resolve_repository(&input)
        .await
        .map_err(forgejo_failure)?;
    let path = forgejo_cli::repository_api_path(&resolved.repository);
    let output = session
        .api(&input, &path, Method::Get, None)
        .await
        .map_err(forgejo_failure)?;
    forgejo_urls(&output.stdout)
}

async fn forgejo_create(
    ctx: DiscoveryContext<'_>,
    repository: &str,
    visibility: &Visibility,
) -> HostResult<CloneUrls> {
    let mut session = Session::new(ctx);
    let input = forgejo_cli::Input {
        repository: Some(repository),
        ..forgejo_cli::Input::default()
    };
    let resolved = session
        .resolve_repository(&input)
        .await
        .map_err(forgejo_failure)?;
    let user = session
        .api(&input, "user", Method::Get, None)
        .await
        .map_err(forgejo_failure)?;
    #[derive(Deserialize)]
    struct User {
        login: String,
    }
    let user: User = serde_json::from_str(&user.stdout).map_err(|_| forgejo_invalid())?;
    let mut parts = resolved.repository.split('/');
    let owner = parts.next().unwrap_or_default();
    let name = parts.next();
    let path = if owner == user.login {
        "user/repos".to_owned()
    } else {
        format!("orgs/{}/repos", github::encode_uri_component(owner))
    };
    // `{ name, private, auto_init }`; `JSON.stringify` drops an undefined name.
    let name = name.map_or_else(String::new, |n| format!("\"name\":{},", json_text(n)));
    let body = format!(
        "{{{name}\"private\":{},\"auto_init\":false}}",
        matches!(visibility, Visibility::Private)
    );
    let output = session
        .api(&input, &path, Method::Post, Some(&body))
        .await
        .map_err(forgejo_failure)?;
    forgejo_urls(&output.stdout)
}

// ---------------------------------------------------------------------------------------------
// Bitbucket: `BitbucketApi.ts` `getRepositoryCloneUrls`, `createRepository`
// ---------------------------------------------------------------------------------------------

/// `parseBitbucketRepositorySlug` / `requireRepositoryLocator`.
fn bitbucket_locator(repository: &str) -> HostResult<(String, String)> {
    let normalized = repository.trim();
    let normalized = normalized.strip_suffix(".git").unwrap_or(normalized);
    let parts: Vec<&str> = normalized.split('/').filter(|p| !p.is_empty()).collect();
    match parts.as_slice() {
        [.., workspace, slug] => Ok(((*workspace).to_owned(), (*slug).to_owned())),
        _ => Err(HostFailure::user_facing(
            "Bitbucket repositories must be specified as workspace/repository.",
        )),
    }
}

/// `RawBitbucketRepositorySchema` and `normalizeRepositoryCloneUrls`.
fn bitbucket_urls(response: &HttpResponse) -> HostResult<CloneUrls> {
    let invalid =
        || HostFailure::new("Bitbucket returned invalid JSON for the requested resource.");
    let value = decode_json(&response.text()).map_err(|_| invalid())?;
    let full_name = trimmed_field(&value, "full_name").ok_or_else(invalid)?;
    let links = value
        .get("links")
        .filter(|l| l.is_object())
        .ok_or_else(invalid)?;
    let html = match links.get("html") {
        None => None,
        Some(html) => Some(trimmed_field(html, "href").ok_or_else(invalid)?),
    };
    let clone = match links.get("clone") {
        None => Vec::new(),
        Some(Value::Array(entries)) => entries
            .iter()
            .map(|e| Some((trimmed_field(e, "name")?, trimmed_field(e, "href")?)))
            .collect::<Option<Vec<_>>>()
            .ok_or_else(invalid)?,
        Some(_) => return Err(invalid()),
    };
    let find = |kind: &str| {
        clone
            .iter()
            .find(|(name, _)| name.to_lowercase() == kind)
            .map(|(_, href)| href.clone())
    };
    let http_clone = find("https").or_else(|| html.clone());
    let ssh_clone = find("ssh");
    Ok(CloneUrls {
        url: http_clone
            .clone()
            .or(html)
            .unwrap_or_else(|| full_name.clone()),
        ssh_url: ssh_clone
            .or(http_clone)
            .unwrap_or_else(|| full_name.clone()),
        name_with_owner: full_name,
    })
}

async fn bitbucket_request(
    ctx: DiscoveryContext<'_>,
    method: Method,
    workspace: &str,
    slug: &str,
    body: Option<String>,
) -> HostResult<CloneUrls> {
    let url = format!(
        "{}/repositories/{}/{}",
        bitbucket::api_base(ctx.env),
        github::encode_uri_component(workspace),
        github::encode_uri_component(slug)
    );
    let mut request = HttpRequest::new(method, url).header("accept", "application/json");
    if let Some(body) = body {
        request = request
            .header("content-type", "application/json")
            .body(body.into_bytes());
    }
    let request = bitbucket::authorize(ctx, request).map_err(HostFailure::new)?;
    let response = http::send(request)
        .await
        .map_err(|_| HostFailure::new("Failed to send the Bitbucket request."))?;
    if !(200..300).contains(&response.status) {
        return Err(HostFailure::new(format!(
            "Bitbucket returned HTTP {}.",
            response.status
        )));
    }
    bitbucket_urls(&response)
}

async fn bitbucket_clone_urls(
    ctx: DiscoveryContext<'_>,
    repository: &str,
) -> HostResult<CloneUrls> {
    let (workspace, slug) = bitbucket_locator(repository)?;
    bitbucket_request(ctx, Method::Get, &workspace, &slug, None).await
}

async fn bitbucket_create(
    ctx: DiscoveryContext<'_>,
    repository: &str,
    visibility: &Visibility,
) -> HostResult<CloneUrls> {
    let (workspace, slug) = bitbucket_locator(repository)?;
    let body = format!(
        "{{\"scm\":\"git\",\"is_private\":{}}}",
        matches!(visibility, Visibility::Private)
    );
    bitbucket_request(ctx, Method::Post, &workspace, &slug, Some(body)).await
}

// ---------------------------------------------------------------------------------------------
// Azure DevOps: `AzureDevOpsCli.ts` `getRepositoryCloneUrls`, `createRepository`
// ---------------------------------------------------------------------------------------------

/// `parseRepositorySpecifier`: `[project/]name`, the last two segments.
fn azure_specifier(repository: &str) -> (Option<String>, String) {
    let parts: Vec<&str> = repository
        .split('/')
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .collect();
    let name = parts
        .last()
        .map_or_else(|| repository.trim().to_owned(), |p| (*p).to_owned());
    let project = (parts.len() > 1)
        .then(|| parts.get(parts.len() - 2).map(|p| (*p).to_owned()))
        .flatten();
    (project, name)
}

/// `RawAzureDevOpsRepositorySchema` and `normalizeRepositoryCloneUrls`.
fn azure_urls(stdout: &str) -> HostResult<CloneUrls> {
    let invalid = || HostFailure::new("Azure DevOps returned an invalid repository.");
    let value = decode_json(stdout.trim()).map_err(|_| invalid())?;
    let name = trimmed_field(&value, "name").ok_or_else(invalid)?;
    trimmed_field(&value, "webUrl").ok_or_else(invalid)?;
    let url = trimmed_field(&value, "remoteUrl").ok_or_else(invalid)?;
    let ssh_url = trimmed_field(&value, "sshUrl").ok_or_else(invalid)?;
    let project = match value.get("project") {
        None => None,
        Some(project) => Some(trimmed_field(project, "name").ok_or_else(invalid)?),
    };
    Ok(CloneUrls {
        name_with_owner: project.map_or_else(|| name.clone(), |p| format!("{p}/{name}")),
        url,
        ssh_url,
    })
}

/// `executeJson`: the caller's arguments, then `--only-show-errors --output json`.
async fn az_json(ctx: DiscoveryContext<'_>, mut args: Vec<String>) -> HostResult<CloneUrls> {
    args.extend(["--only-show-errors", "--output", "json"].map(str::to_owned));
    azure_urls(&run_cli(ctx, "AzureDevOpsCli.execute", "az", args, &[]).await?)
}

async fn azure_clone_urls(ctx: DiscoveryContext<'_>, repository: &str) -> HostResult<CloneUrls> {
    let (project, name) = azure_specifier(repository);
    let mut args: Vec<String> = ["repos", "show", "--detect", "true", "--repository"]
        .map(str::to_owned)
        .into();
    args.push(name);
    if let Some(project) = project {
        args.extend(["--project".to_owned(), project]);
    }
    az_json(ctx, args).await
}

/// Project and organization permissions decide visibility; `az repos create` has no flag.
async fn azure_create(ctx: DiscoveryContext<'_>, repository: &str) -> HostResult<CloneUrls> {
    let (project, name) = azure_specifier(repository);
    let mut args: Vec<String> = ["repos", "create", "--detect", "true", "--name"]
        .map(str::to_owned)
        .into();
    args.push(name);
    if let Some(project) = project {
        args.extend(["--project".to_owned(), project]);
    }
    az_json(ctx, args).await
}

#[cfg(test)]
#[path = "repositories_tests.rs"]
mod tests;
