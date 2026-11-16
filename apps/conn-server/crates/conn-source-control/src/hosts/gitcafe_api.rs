//! GitCafe outside discovery: `GitCafeCredentials.get`, `GitCafeApi.request` and the driver's
//! `resolveTarget` (`packages/source-control-gitcafe/src/server`).
//!
//! GitCafe lives on `git.cafe` and `staging.git.cafe` only; a token never goes anywhere else. The
//! credential is the token saved in Settings (git.cafe only), else `CAFE_TOKEN` when `CAFE_HOST`
//! names the host, else the one `cafe auth http credential ... get` hands over on stdout. The T3
//! server keeps a credential from the environment or `cafe` for 5 minutes (a missing one for
//! 10 s); this server asks on each call.

use std::path::Path;

use conn_vcs::process::{GitCommand, OnLimit, ProcessError};
use serde_json::Value;

use super::{DiscoveryContext, gitcafe::KIND};
use crate::{
    discovery::ALL_EXIT_CODES,
    http::{self, HttpRequest, Method},
    secret::Secret,
};

pub const GITCAFE_HOSTS: [&str; 2] = ["git.cafe", "staging.git.cafe"];
const DEFAULT_HOST: &str = "git.cafe";
const MAX_REDIRECTS: usize = 3;
const MAX_PROBLEM_TEXT: usize = 300;

/// `gitCafeHost`: the host when it is one of GitCafe's, in lower case.
pub fn gitcafe_host(host: &str) -> Option<&'static str> {
    let normalized = host.trim().to_lowercase();
    GITCAFE_HOSTS.into_iter().find(|h| *h == normalized)
}

/// `/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/`.
fn is_repository(text: &str) -> bool {
    let part = |p: &str| {
        !p.is_empty()
            && p.bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
    };
    text.split_once('/')
        .is_some_and(|(owner, name)| part(owner) && part(name))
}

/// `gitCafeRepositoryPath`: trimmed, trailing slashes and one `.git` off, then `owner/name`.
pub fn repository_path(path: &str) -> Option<String> {
    let trimmed = path.trim().trim_end_matches('/');
    let repository = trimmed.strip_suffix(".git").unwrap_or(trimmed);
    is_repository(repository).then(|| repository.to_owned())
}

/// A GitCafe repository on one of its hosts (`Target`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Target {
    pub host: &'static str,
    pub repository: String,
}

/// `parseGitCafeRemote`: the first of T3's three remote patterns that matches decides.
pub fn parse_remote(url: &str) -> Option<Target> {
    let text = url.trim();
    let (host, path) = match_http(text)
        .or_else(|| match_ssh_url(text))
        .or_else(|| match_scp(text))?;
    Some(Target {
        host: gitcafe_host(host)?,
        repository: repository_path(path)?,
    })
}

/// `[^/:]+` then an optional `:\d+`, then `/` and the rest (`.+`, no line terminator).
fn host_port_path(rest: &str) -> Option<(&str, &str)> {
    let host_end = rest.find(['/', ':']).unwrap_or(rest.len());
    let host = rest.get(..host_end)?;
    if host.is_empty() {
        return None;
    }
    let mut after = rest.get(host_end..)?;
    if let Some(port) = after.strip_prefix(':') {
        let digits = port.bytes().take_while(u8::is_ascii_digit).count();
        if digits == 0 {
            return None;
        }
        after = port.get(digits..)?;
    }
    let path = after.strip_prefix('/')?;
    (!path.is_empty() && !path.contains(['\n', '\r'])).then_some((host, path))
}

/// `/^https?:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/iu`.
fn match_http(text: &str) -> Option<(&str, &str)> {
    let lower = text
        .get(..8)
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    let rest = if lower.starts_with("https://") {
        text.get(8..)?
    } else if lower.starts_with("http://") {
        text.get(7..)?
    } else {
        return None;
    };
    let with_user = rest
        .split_once('@')
        .filter(|(user, _)| !user.is_empty() && !user.contains('/'))
        .and_then(|(_, after)| host_port_path(after));
    with_user.or_else(|| host_port_path(rest))
}

/// `/^ssh:\/\/[^@/]+@([^/:]+)(?::\d+)?\/(.+)$/iu`.
fn match_ssh_url(text: &str) -> Option<(&str, &str)> {
    let lower = text
        .get(..6)
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    if lower != "ssh://" {
        return None;
    }
    let (user, after) = text.get(6..)?.split_once('@')?;
    if user.is_empty() || user.contains('/') {
        return None;
    }
    host_port_path(after)
}

/// `/^(?:[^@/:]+@)?([^/:]+):(.+)$/u`.
fn match_scp(text: &str) -> Option<(&str, &str)> {
    fn attempt(rest: &str) -> Option<(&str, &str)> {
        let (host, path) = rest.split_once(':')?;
        (!host.is_empty()
            && !host.contains('/')
            && !path.is_empty()
            && !path.contains(['\n', '\r']))
        .then_some((host, path))
    }
    let with_user = text
        .split_once('@')
        .filter(|(user, _)| !user.is_empty() && !user.contains(['/', ':']))
        .and_then(|(_, after)| attempt(after));
    with_user.or_else(|| attempt(text))
}

/// `GitCafeApiError` and the driver's `SourceControlProviderError`, without the cause.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("{detail}")]
pub struct GitCafeError {
    pub detail: String,
    pub status: Option<u16>,
}

impl GitCafeError {
    pub fn new(detail: impl Into<String>) -> Self {
        Self {
            detail: detail.into(),
            status: None,
        }
    }
}

pub type GitCafeResult<T> = Result<T, GitCafeError>;

/// One driver operation. `server_cwd` is the server's own folder
/// (`HostProcess.WorkingDirectory`), where `cafe` hands over its credential; `ctx.cwd` is the
/// call's folder. A token `cafe` handed over is kept for the operation (T3 keeps it 5 minutes
/// across operations).
#[derive(Debug)]
pub struct Client<'a> {
    pub ctx: DiscoveryContext<'a>,
    pub server_cwd: &'a Path,
    cafe_tokens: std::sync::Mutex<Vec<(&'static str, Secret)>>,
}

impl<'a> Client<'a> {
    pub fn new(ctx: DiscoveryContext<'a>, server_cwd: &'a Path) -> Self {
        Self {
            ctx,
            server_cwd,
            cafe_tokens: std::sync::Mutex::new(Vec::new()),
        }
    }

    /// `resolveTarget` for a call that names a repository (`input.repository` is set).
    pub async fn resolve_named(&self, repository: &str) -> GitCafeResult<Target> {
        if let Some(named) = parse_remote(repository) {
            return Ok(named);
        }
        let remote = self
            .primary_remote_url()
            .await
            .and_then(|url| parse_remote(&url));
        match repository_path(repository) {
            Some(repository) => Ok(Target {
                host: remote.map_or(DEFAULT_HOST, |r| r.host),
                repository,
            }),
            None => Err(GitCafeError::new(
                "A GitCafe repository is named owner/name or by its git.cafe URL.",
            )),
        }
    }

    fn git(&self, operation: &'static str, args: &[&str]) -> GitCommand {
        let mut command = GitCommand::new(operation, self.ctx.cwd, args.iter().copied());
        command.env = self.ctx.probe_env(&[]);
        command
    }

    /// `resolvePrimaryRemoteName` then `readConfigValue(remote.<name>.url)`, any failure `None`:
    /// `git remote get-url -- origin`, else the first of `git remote`, then `git config --get`.
    async fn primary_remote_url(&self) -> Option<String> {
        let origin = self
            .git(
                "GitVcsDriver.remoteExists",
                &["remote", "get-url", "--", "origin"],
            )
            .allow_exit(ALL_EXIT_CODES)
            .run()
            .await
            .ok()?;
        let name = if origin.code == 0 {
            "origin".to_owned()
        } else {
            let names = self
                .git("GitVcsDriver.listRemoteNames", &["remote"])
                .run()
                .await
                .ok()?
                .stdout_text();
            names
                .split('\n')
                .map(str::trim)
                .find(|n| !n.is_empty())?
                .to_owned()
        };
        let key = format!("remote.{name}.url");
        let value = self
            .git("GitVcsDriver.readConfigValue", &["config", "--get", &key])
            .allow_exit(ALL_EXIT_CODES)
            .run()
            .await
            .ok()?
            .stdout_text();
        let value = value.trim();
        (!value.is_empty()).then(|| value.to_owned())
    }

    /// `GitCafeCredentials.get`.
    async fn credential(&self, host: &'static str) -> GitCafeResult<Secret> {
        if host == DEFAULT_HOST {
            match self.ctx.settings.host(KIND).secret_field("token").require() {
                Ok(Some(token)) => return Ok(token),
                Ok(None) => {}
                Err(message) => return Err(GitCafeError::new(message)),
            }
        }
        if let Some(token) = environment_token(host, self.ctx.env) {
            return Ok(token);
        }
        let known = self.cafe_tokens.lock().ok().and_then(|tokens| {
            tokens
                .iter()
                .find(|(known, _)| *known == host)
                .map(|(_, token)| token.clone())
        });
        if let Some(token) = known {
            return Ok(token);
        }
        let token = self.cafe_credential(host).await?;
        if let Ok(mut tokens) = self.cafe_tokens.lock() {
            // At most one per GitCafe host.
            tokens.retain(|(known, _)| *known != host);
            tokens.push((host, token.clone()));
        }
        Ok(token)
    }

    /// `fromCafe`: cafe has no auth-token command; its credential helper keeps tokens out of
    /// argv and logs.
    async fn cafe_credential(&self, host: &str) -> GitCafeResult<Secret> {
        let api = format!("https://{host}/api");
        let mut command = GitCommand::host_cli(
            "GitCafeCredentials.get",
            "cafe",
            self.server_cwd,
            ["auth", "http", "credential", "--host", api.as_str(), "get"],
        )
        .timeout(std::time::Duration::from_secs(10))
        .max_stdout(crate::cli::DEFAULT_MAX_OUTPUT_BYTES, OnLimit::Fail)
        .stdin(format!("protocol=https\nhost={host}\n\n").into_bytes());
        command.env = self.ctx.probe_env(&[("CAFE_NO_UPDATE_CHECK", "1".into())]);
        let not_signed_in = || {
            GitCafeError::new(format!(
                "No GitCafe credential for {host}: run `cafe auth login --host https://{host}/api`."
            ))
        };
        match command.run().await {
            Ok(output) => credential_password(&output.stdout_text()).ok_or_else(not_signed_in),
            Err(ProcessError::Spawn {
                not_found: true, ..
            }) => Err(GitCafeError::new(format!(
                "No GitCafe credential for {host}: set CAFE_TOKEN, or install the GitCafe CLI and run `cafe auth login`."
            ))),
            Err(ProcessError::Exit { .. }) => Err(not_signed_in()),
            Err(_) => Err(GitCafeError::new(format!(
                "The GitCafe CLI could not hand over a credential for {host}. Check `cafe auth status` on the server."
            ))),
        }
    }

    /// `GitCafeApi.request`: `path` starts with `/` and goes under `https://<host>/api`; `body`
    /// is JSON text. The answer's text on a 2xx.
    pub async fn request(
        &self,
        host: &str,
        method: Method,
        path: &str,
        body: Option<&str>,
    ) -> GitCafeResult<String> {
        // Remote URLs must not send tokens outside GitCafe's hosts.
        let Some(host) = gitcafe_host(host) else {
            return Err(GitCafeError::new(format!(
                "GitCafe lives on {}, not {host}.",
                GITCAFE_HOSTS.join(" and ")
            )));
        };
        let token = self.credential(host).await?;
        let origin = self
            .ctx
            .endpoints
            .gitcafe_api
            .clone()
            .unwrap_or_else(|| format!("https://{host}"));
        let body = body.map(|b| b.as_bytes().to_vec());
        let send = |url: String| {
            let mut request = HttpRequest::new(method, url)
                .secret_header("authorization", "Bearer ", token.clone())
                .header("accept", "application/json")
                .header("user-agent", "t3code");
            if let Some(body) = &body {
                request = request
                    .header("content-type", "application/json")
                    .body(body.clone());
            }
            async move {
                http::send(request)
                    .await
                    .map_err(|_| GitCafeError::new("Could not reach GitCafe."))
            }
        };
        // A renumbered pull request (provisional number replaced by the synced GitHub one)
        // answers with a redirect; follow it only within this host's API.
        let mut url = format!("{origin}/api{path}");
        let mut response = send(url.clone()).await?;
        for _ in 0..MAX_REDIRECTS {
            let Some(next) = redirect_target(method, &origin, &url, &response) else {
                break;
            };
            url = next;
            response = send(url.clone()).await?;
        }
        let status = response.status;
        let text = response.text();
        if (200..300).contains(&status) {
            return Ok(text);
        }
        let detail =
            problem_text(&text).unwrap_or_else(|| format!("GitCafe answered HTTP {status}."));
        Err(GitCafeError {
            detail,
            status: Some(status),
        })
    }
}

/// `environmentToken`: `CAFE_TOKEN` only for the host `CAFE_HOST` names (default git.cafe).
fn environment_token(host: &str, env: &super::Environment) -> Option<Secret> {
    let configured_host = match env.get("CAFE_HOST").map(|v| v.trim().to_owned()) {
        Some(configured) if !configured.is_empty() => {
            let url = if configured.contains("://") {
                configured
            } else {
                format!("https://{configured}")
            };
            url_host(&url)?
        }
        _ => DEFAULT_HOST.to_owned(),
    };
    if configured_host.to_lowercase() != host.trim().to_lowercase() {
        return None;
    }
    Secret::non_empty(env.get("CAFE_TOKEN")?)
}

/// `new URL(url).host` for a URL with an authority: lower case, the port unless it is the
/// scheme's default.
fn url_host(url: &str) -> Option<String> {
    let (scheme, rest) = url.split_once("://")?;
    let scheme = scheme.to_ascii_lowercase();
    if matches!(scheme.as_str(), "http" | "https") {
        return super::forgejo::parse_remote(url).map(|r| r.host);
    }
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = rest.get(..end)?;
    let host = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    Some(host.to_lowercase())
}

/// `credentialPassword`: the first `password=` line, trimmed, when it is not blank.
fn credential_password(output: &str) -> Option<Secret> {
    let line = output
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .find_map(|line| line.strip_prefix("password="))?;
    Secret::non_empty(line)
}

/// `redirectTarget`: a redirect stays on the API's origin, under `/api/`, without credentials;
/// only 307 and 308 repeat a write.
fn redirect_target(
    method: Method,
    origin: &str,
    from: &str,
    response: &http::HttpResponse,
) -> Option<String> {
    if !matches!(response.status, 301 | 302 | 303 | 307 | 308) {
        return None;
    }
    if method != Method::Get && !matches!(response.status, 307 | 308) {
        return None;
    }
    let location = response.header("location")?;
    let target = if location.contains("://") {
        location.to_owned()
    } else if location.starts_with('/') && !location.starts_with("//") {
        format!("{origin}{location}")
    } else {
        let base = from.rsplit_once('/').map_or(from, |(head, _)| head);
        format!("{base}/{location}")
    };
    let target = target.split('#').next()?.to_owned();
    let after_origin = target.get(origin.len()..)?;
    let same_origin = target
        .get(..origin.len())
        .is_some_and(|o| o.eq_ignore_ascii_case(origin));
    let path = after_origin.split('?').next()?;
    let dotted = path.split('/').any(|segment| {
        let lower = segment.to_ascii_lowercase().replace("%2e", ".");
        lower == "." || lower == ".."
    });
    (same_origin && path.starts_with("/api/") && !dotted).then_some(target)
}

/// `decodeProblem` and `boundedProblemText`: the problem's `detail`, else its `title`, on one
/// line and at most 300 characters.
fn problem_text(text: &str) -> Option<String> {
    let value: Value = serde_json::from_str(text).ok()?;
    let object = value.as_object()?;
    let field = |key: &str| -> Option<Option<&str>> {
        match object.get(key) {
            None => Some(None),
            Some(Value::String(s)) => Some(Some(s.as_str())),
            Some(_) => None,
        }
    };
    let detail = field("detail")?;
    let title = field("title")?;
    let line = detail
        .or(title)?
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if line.is_empty() {
        return None;
    }
    let mut chars = line.chars();
    let head: String = chars.by_ref().take(MAX_PROBLEM_TEXT).collect();
    Some(if chars.next().is_some() {
        format!("{head}…")
    } else {
        head
    })
}

/// `SourceControlRepositoryCloneUrls` for a GitCafe repository (`cloneUrls`).
pub fn clone_urls(target: &Target) -> crate::repository::CloneUrls {
    crate::repository::CloneUrls {
        name_with_owner: target.repository.clone(),
        url: format!("https://{}/{}", target.host, target.repository),
        ssh_url: format!("ssh@{}:{}.git", target.host, target.repository),
    }
}

#[cfg(test)]
#[path = "gitcafe_api_tests.rs"]
mod tests;
