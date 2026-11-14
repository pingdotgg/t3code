//! Forgejo / Gitea outside discovery: `ForgejoCli.resolveTarget` and `ForgejoCli.api`
//! (`packages/source-control-forgejo/src/server/ForgejoCli.ts`).
//!
//! A call picks the login that serves the repository: an fj login from fj's `keys.json` first
//! (verified with `fj --host <url> whoami`), else a `tea` login (`tea login list --output json`).
//! With fj the server sends the request itself, with the token fj keeps; with tea it runs
//! `tea api --include ...` and reads the status from tea's stderr. Every child and request is the
//! T3 driver's, in its order.
//!
//! One [`Session`] serves one operation. It remembers the fj logins it verified, as
//! `authenticateFj` remembers them for 30 s (see [`super::forgejo`]).

use std::{collections::HashSet, path::Path};

use conn_vcs::process::{GitCommand, OnLimit, ProcessError};

use super::{
    DiscoveryContext,
    forgejo::{
        self, CLI_AUTHENTICATION, CLI_FAILED, Env, Login, MISSING_CLI, MatchOptions,
        NO_CREDENTIALS, NOT_FOUND, Remote, Verified, match_login, parse_logins, parse_remote,
    },
};
use crate::{
    discovery::{ALL_EXIT_CODES, classify_exit_detail},
    http::Method,
};

/// `ForgejoCliError.command`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Program {
    Fj,
    Tea,
}

impl Program {
    fn name(self) -> &'static str {
        match self {
            Program::Fj => "fj",
            Program::Tea => "tea",
        }
    }
}

/// `ForgejoCliError.reason`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reason {
    MissingCli,
    Authentication,
    Forbidden,
    NotFound,
    RateLimit,
    InvalidResponse,
}

impl Reason {
    fn for_status(status: u16) -> Option<Self> {
        match status {
            401 => Some(Reason::Authentication),
            403 => Some(Reason::Forbidden),
            404 => Some(Reason::NotFound),
            429 => Some(Reason::RateLimit),
            _ => None,
        }
    }
}

/// `ForgejoCliError`, without its `cwd` and `cause`.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("{detail}")]
pub struct ForgejoError {
    pub command: Program,
    pub detail: String,
    pub reason: Option<Reason>,
    pub http_status: Option<u16>,
}

impl ForgejoError {
    fn new(command: Program, detail: impl Into<String>) -> Self {
        Self {
            command,
            detail: detail.into(),
            reason: None,
            http_status: None,
        }
    }

    fn with_reason(mut self, reason: Reason) -> Self {
        self.reason = Some(reason);
        self
    }
}

pub type ForgejoResult<T> = Result<T, ForgejoError>;

/// `ForgejoRepositoryInput`.
#[derive(Clone, Copy, Debug, Default)]
pub struct Input<'a> {
    pub repository: Option<&'a str>,
    pub reference: Option<&'a str>,
    pub host: Option<&'a str>,
    /// The checkout's remote (`context.remoteUrl`), its provider's base URL and the host the
    /// caller asked for.
    pub context_remote_url: Option<&'a str>,
    pub context_base_url: Option<&'a str>,
    pub requested_host: Option<&'a str>,
}

/// `ForgejoRepository`: the login that serves a repository, by the CLI that holds it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Resolved {
    pub command: Program,
    /// The login's name (fj: its host).
    pub login: String,
    /// `owner/name`; empty for a host-only call.
    pub repository: String,
    /// The login's URL without a trailing slash.
    pub base_url: String,
}

/// A successful `api` call: the body, and the HTTP status.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ApiOutput {
    pub stdout: String,
    pub status: u16,
    /// The `link` header of an fj answer (tea's answer carries it in its own stderr).
    pub link: Option<String>,
}

/// One operation's calls. `cwd` is the call's folder.
#[derive(Debug)]
pub struct Session<'a> {
    ctx: DiscoveryContext<'a>,
    env: Vec<(&'static str, std::ffi::OsString)>,
    verified: Verified,
}

impl<'a> Session<'a> {
    pub fn new(ctx: DiscoveryContext<'a>) -> Self {
        Self {
            env: ctx.probe_env(&[]),
            ctx,
            verified: Verified::default(),
        }
    }

    fn home(&self) -> &Path {
        self.ctx.home.unwrap_or(self.ctx.cwd)
    }

    /// `ForgejoCli.execute`: 30 s, 1,000,000 bytes, a non-zero exit is an error.
    pub async fn execute(
        &self,
        program: Program,
        cwd: &Path,
        args: Vec<String>,
        stdin: Option<String>,
    ) -> ForgejoResult<crate::cli::CliOutput> {
        execute(&self.env, program, cwd, args, stdin).await
    }

    async fn fj_logins(&self, remote_url: Option<&str>) -> ForgejoResult<Vec<Login>> {
        forgejo::list_logins(&self.ctx, &self.env, remote_url)
            .await
            .map_err(|e| cli_error(Program::Fj, e))
    }

    async fn tea_logins(&self) -> ForgejoResult<Vec<Login>> {
        let output = self
            .execute(
                Program::Tea,
                self.ctx.cwd,
                ["login", "list", "--output", "json"]
                    .map(str::to_owned)
                    .into(),
                None,
            )
            .await?;
        Ok(parse_logins(&output.stdout))
    }

    /// `git remote -v` (with a host) or `git remote get-url origin`, as `ForgejoCli.remote`.
    async fn read_remote(&self, host: Option<&str>) -> ForgejoResult<Option<String>> {
        let args: &[&str] = if host.is_some() {
            &["remote", "-v"]
        } else {
            &["remote", "get-url", "origin"]
        };
        let mut command = GitCommand::new("ForgejoCli.remote", self.ctx.cwd, args.iter().copied())
            .max_stdout(crate::cli::DEFAULT_MAX_OUTPUT_BYTES, OnLimit::Fail)
            .allow_exit(ALL_EXIT_CODES);
        command.env.clone_from(&self.env);
        let output = command.run().await.map_err(|_| {
            ForgejoError::new(
                Program::Tea,
                "Could not resolve the Forgejo repository remote.",
            )
        })?;
        let stdout = output.stdout_text();
        let Some(host) = host else {
            let url = stdout.trim();
            return Ok((!url.is_empty()).then(|| url.to_owned()));
        };
        let host = host.to_lowercase();
        let mut urls: Vec<&str> = Vec::new();
        for line in stdout.split('\n') {
            if let Some(url) = fetch_http_url(line.trim())
                && parse_remote(url).is_some_and(|remote| remote.host == host)
                && !urls.contains(&url)
            {
                urls.push(url);
            }
        }
        let mut origins: Vec<String> = Vec::new();
        for origin in urls.iter().filter_map(|url| url_origin(url)) {
            if !origins.contains(&origin) {
                origins.push(origin);
            }
        }
        Ok(match (urls.as_slice(), origins.as_slice()) {
            ([url], _) => Some((*url).to_owned()),
            (_, [origin]) => Some(origin.clone()),
            _ => None,
        })
    }

    async fn authenticate(&mut self, login: &Login) -> ForgejoResult<()> {
        let home = self.home().to_path_buf();
        forgejo::authenticate_fj(&self.ctx, &self.env, &home, login, &mut self.verified)
            .await
            .map(|_| ())
            .map_err(|e| cli_error(Program::Fj, e))
    }

    async fn account(&mut self, base_url: &str) -> ForgejoResult<String> {
        let home = self.home().to_path_buf();
        forgejo::get_account(&self.ctx, &self.env, &home, base_url, &mut self.verified)
            .await
            .map_err(|detail| {
                // `getAccount` fails with `authentication` for missing credentials and
                // `invalid-response` for an unreadable account; the detail says which.
                ForgejoError::new(Program::Fj, detail)
            })
    }

    /// `ForgejoCli.resolveRepository`.
    pub async fn resolve_repository(&mut self, input: &Input<'_>) -> ForgejoResult<Resolved> {
        self.resolve_target(input, false).await
    }

    /// `resolveTarget`.
    pub async fn resolve_target(
        &mut self,
        input: &Input<'_>,
        host_only: bool,
    ) -> ForgejoResult<Resolved> {
        let repository = present(input.repository);
        let reference = present(input.reference);
        let host = input.host;
        let reference_remote = reference.and_then(parse_remote);
        let mut remote_url: Option<String> = [reference, repository, input.context_remote_url]
            .into_iter()
            .flatten()
            .find(|value| !value.is_empty() && parse_remote(value).is_some())
            .map(str::to_owned);
        let mut remote: Option<Remote> = reference_remote
            .clone()
            .or_else(|| repository.and_then(parse_remote))
            .or_else(|| input.context_remote_url.and_then(parse_remote));
        if remote.is_none() && (repository.is_none() || host.is_some()) {
            remote_url = self.read_remote(host).await?;
            remote = remote_url.as_deref().and_then(parse_remote);
        }
        if let Some(host) = host {
            let wanted = host.to_lowercase();
            let names_host = remote
                .as_ref()
                .is_some_and(|r| r.ssh || r.host == wanted || r.hostname == wanted);
            if !names_host {
                remote = Some(Remote {
                    host: wanted,
                    hostname: host.split(':').next().unwrap_or(host).to_owned(),
                    ssh: false,
                    path: remote.map(|r| r.path).unwrap_or_default(),
                });
            }
        }
        let scheme_remote_url = match &remote {
            Some(r) if r.ssh => input.context_base_url.map(str::to_owned),
            _ => remote_url.clone(),
        };
        let fj_logins = self.fj_logins(scheme_remote_url.as_deref()).await?;
        let requested_host = host.or(input.requested_host);
        let match_host_only =
            host_only || (host.is_some() && remote.as_ref().is_none_or(|r| r.path.is_empty()));
        let options = |remote: &Remote| MatchOptions {
            requested_host: if remote.ssh { requested_host } else { None },
            host_only: match_host_only,
        };
        let select = |logins: &[Login]| -> Option<Login> {
            match &remote {
                Some(remote) => match_login(logins, remote, options(remote)).cloned(),
                None => logins
                    .iter()
                    .find(|login| login.default == "true")
                    .or_else(|| {
                        let names: HashSet<&str> = logins.iter().map(|l| l.name.as_str()).collect();
                        (names.len() == 1).then(|| logins.first()).flatten()
                    })
                    .cloned(),
            }
        };
        let mut login = select(&fj_logins);
        let mut command = Program::Fj;
        let some_match = fj_logins.iter().any(|item| match &remote {
            None => true,
            Some(remote) => {
                match_login(std::slice::from_ref(item), remote, options(remote)).is_some()
            }
        });
        if login.is_none() && some_match {
            match self
                .execute(Program::Fj, self.ctx.cwd, vec!["version".into()], None)
                .await
            {
                Ok(_) => {
                    return Err(ForgejoError::new(
                        Program::Fj,
                        "Multiple fj logins match this repository. Specify its full server URL.",
                    )
                    .with_reason(Reason::Authentication));
                }
                Err(error) if error.reason != Some(Reason::MissingCli) => return Err(error),
                Err(_) => {}
            }
        }
        if let Some(chosen) = login.clone() {
            match self.authenticate(&chosen).await {
                Ok(()) => {}
                Err(error) if error.reason == Some(Reason::MissingCli) => login = None,
                Err(error) => return Err(error),
            }
        }
        if login.is_none() {
            command = Program::Tea;
            login = select(&self.tea_logins().await?);
        }
        let Some(mut login) = login else {
            return Err(ForgejoError::new(
                Program::Tea,
                "No matching Forgejo login. Use `fj auth login`, `fj auth add-token`, or `tea login add` for this server; choose a default when multiple tea accounts match.",
            )
            .with_reason(Reason::Authentication));
        };
        let base_url = login.url.trim_end_matches('/').to_owned();
        if host_only {
            return Ok(Resolved {
                command,
                login: login.name,
                repository: String::new(),
                base_url,
            });
        }
        let path = match &reference_remote {
            Some(r) => r.path.clone(),
            None => match repository {
                Some(repository) if parse_remote(repository).is_none() => repository.to_owned(),
                _ => remote.as_ref().map(|r| r.path.clone()).unwrap_or_default(),
            },
        };
        let base_path = parse_remote(&login.url).map(|r| r.path).unwrap_or_default();
        let relative = match path.strip_prefix(&format!("{base_path}/")) {
            Some(rest) if !base_path.is_empty() && path.split('/').count() > 2 => rest,
            _ => path.as_str(),
        };
        let repository_path = without_pulls_suffix(relative);
        let repository_path = repository_path
            .strip_suffix(".git")
            .unwrap_or(repository_path);
        if command == Program::Fj && !repository_path.contains('/') {
            login.user = self.account(&login.url).await?;
        }
        let repository = if repository_path.contains('/') {
            repository_path.to_owned()
        } else {
            format!("{}/{repository_path}", login.user)
        };
        if !is_owner_and_name(&repository) {
            return Err(ForgejoError::new(
                command,
                "Specify a Forgejo repository as owner/repository or its full server URL.",
            ));
        }
        Ok(Resolved {
            command,
            login: login.name,
            repository,
            base_url,
        })
    }

    /// `ForgejoCli.api`: `path` is relative to `<base>/api/v1/`; `body` is JSON text.
    pub async fn api(
        &mut self,
        input: &Input<'_>,
        path: &str,
        method: Method,
        body: Option<&str>,
    ) -> ForgejoResult<ApiOutput> {
        let host_only = path.trim_start_matches('/') == "user" && method == Method::Get;
        let resolved = self.resolve_target(input, host_only).await?;
        let mut path = path.trim_start_matches('/').to_owned();
        if let Some(requested) = input.repository.filter(|r| !r.is_empty())
            && requested != resolved.repository
        {
            // Repository identities retain the server mount path; API routes do not.
            let prefix = repository_api_path(requested);
            if let Some(rest) = path.strip_prefix(&prefix)
                && (rest.is_empty() || rest.starts_with('/') || rest.starts_with('?'))
            {
                path = format!("{}{rest}", repository_api_path(&resolved.repository));
            }
        }
        match resolved.command {
            Program::Fj => {
                let keys = forgejo::read_keys(&self.ctx)
                    .await
                    .map_err(|detail| ForgejoError::new(Program::Fj, detail))?;
                let Some(token) = keys.token(&resolved.login).cloned() else {
                    return Err(ForgejoError::new(Program::Fj, NO_CREDENTIALS)
                        .with_reason(Reason::Authentication));
                };
                let base = forgejo::api_base(&self.ctx, &resolved.base_url);
                let answer = forgejo::request_fj(&base, &token, method, &path, body)
                    .await
                    .map_err(|failure| ForgejoError {
                        command: Program::Fj,
                        reason: match failure.status {
                            Some(status) => Reason::for_status(status),
                            None if failure.detail.contains("oversized or invalid") => {
                                Some(Reason::InvalidResponse)
                            }
                            None => None,
                        },
                        http_status: failure.status,
                        detail: failure.detail,
                    })?;
                Ok(ApiOutput {
                    stdout: answer.text,
                    status: answer.status,
                    link: answer.link,
                })
            }
            Program::Tea => {
                let mut args: Vec<String> = vec![
                    "api".into(),
                    "--include".into(),
                    "--login".into(),
                    resolved.login.clone(),
                ];
                if !resolved.repository.is_empty() {
                    args.extend(["--repo".into(), resolved.repository.clone()]);
                }
                args.extend(["--method".into(), method.as_str().into()]);
                if body.is_some() {
                    args.extend(["--data".into(), "@-".into()]);
                }
                args.push(format!("{}/api/v1/{path}", resolved.base_url));
                let output = self
                    .execute(Program::Tea, self.ctx.cwd, args, body.map(str::to_owned))
                    .await?;
                // tea reports HTTP failures with exit code zero; use its response status.
                let status = tea_status(&output.stderr);
                match status {
                    Some(status) if status < 400 => Ok(ApiOutput {
                        stdout: output.stdout,
                        status,
                        link: None,
                    }),
                    _ => Err(tea_failure(status, output.stdout.trim())),
                }
            }
        }
    }
}

/// A value that is set and not empty (JavaScript's truthy string).
fn present(value: Option<&str>) -> Option<&str> {
    value.filter(|v| !v.is_empty())
}

/// `ForgejoCli.execute` for either CLI.
async fn execute(
    env: &Env,
    program: Program,
    cwd: &Path,
    args: Vec<String>,
    stdin: Option<String>,
) -> ForgejoResult<crate::cli::CliOutput> {
    let mut command = GitCommand::host_cli("ForgejoCli.execute", program.name(), cwd, args)
        .timeout(forgejo::EXECUTE_TIMEOUT)
        .max_stdout(crate::cli::DEFAULT_MAX_OUTPUT_BYTES, OnLimit::Fail);
    command.env = env.to_vec();
    command.stdin = stdin.map(String::into_bytes);
    match command.run().await {
        Ok(output) => Ok(crate::cli::CliOutput {
            stdout: output.stdout_text(),
            stderr: output.stderr,
            exit_code: output.code,
        }),
        Err(ProcessError::Spawn { .. }) => {
            Err(ForgejoError::new(program, MISSING_CLI).with_reason(Reason::MissingCli))
        }
        Err(ProcessError::Exit { stderr, .. })
            if classify_exit_detail(&stderr) == "Authentication failed." =>
        {
            Err(ForgejoError::new(program, CLI_AUTHENTICATION).with_reason(Reason::Authentication))
        }
        Err(_) => Err(ForgejoError::new(program, CLI_FAILED)),
    }
}

fn cli_error(program: Program, error: forgejo::CliError) -> ForgejoError {
    let failure = ForgejoError::new(program, error.detail);
    if error.missing_cli {
        failure.with_reason(Reason::MissingCli)
    } else if error.detail == CLI_FAILED {
        failure
    } else {
        failure.with_reason(Reason::Authentication)
    }
}

/// `/^HTTP\/\S+ (\d{3})/m` on tea's stderr.
fn tea_status(stderr: &str) -> Option<u16> {
    stderr.split('\n').find_map(|line| {
        let rest = line.strip_prefix("HTTP/")?;
        let space = rest.find(char::is_whitespace)?;
        if space == 0 || !rest.get(space..)?.starts_with(' ') {
            return None;
        }
        let digits = rest.get(space + 1..space + 4)?;
        digits
            .bytes()
            .all(|b| b.is_ascii_digit())
            .then(|| digits.parse().ok())
            .flatten()
    })
}

fn tea_failure(status: Option<u16>, body: &str) -> ForgejoError {
    let detail = match status {
        Some(401 | 403) => {
            "Forgejo denied access. Check this server's `tea login` credentials and permissions."
                .to_owned()
        }
        Some(404) => NOT_FOUND.to_owned(),
        Some(429) => "Forgejo API rate limit exceeded.".to_owned(),
        None => "Forgejo API request failed without an HTTP status.".to_owned(),
        Some(status) if body.is_empty() => format!("Forgejo API request failed (HTTP {status})."),
        Some(status) => format!("Forgejo API request failed (HTTP {status}): {body}"),
    };
    ForgejoError {
        command: Program::Tea,
        detail,
        reason: status.and_then(Reason::for_status),
        http_status: status,
    }
}

/// `repos/<owner>/<name>` with each segment encoded (`repositoryPath`).
pub fn repository_api_path(repository: &str) -> String {
    format!(
        "repos/{}",
        repository
            .split('/')
            .map(super::github::encode_uri_component)
            .collect::<Vec<_>>()
            .join("/")
    )
}

/// `/\/pulls\/\d+.*$/` removed.
fn without_pulls_suffix(path: &str) -> &str {
    let mut search = 0;
    while let Some(found) = path.get(search..).and_then(|rest| rest.find("/pulls/")) {
        let at = search + found;
        let after = path.get(at + 7..).unwrap_or_default();
        if after.starts_with(|c: char| c.is_ascii_digit())
            && !path.get(at..).unwrap_or_default().contains(['\n', '\r'])
        {
            return path.get(..at).unwrap_or(path);
        }
        search = at + 1;
    }
    path
}

/// `/^[^/\s]+\/[^/\s]+$/`.
fn is_owner_and_name(repository: &str) -> bool {
    let part = |p: &str| !p.is_empty() && !p.chars().any(|c| c == '/' || c.is_whitespace());
    repository
        .split_once('/')
        .is_some_and(|(owner, name)| part(owner) && part(name))
}

/// `/^\S+\s+(https?:\/\/\S+)\s+\(fetch\)(?:\s+\[[^\]]+\])?$/` on a trimmed `git remote -v` line.
fn fetch_http_url(line: &str) -> Option<&str> {
    let mut words = line.split_whitespace();
    let _name = words.next()?;
    let url = words.next()?;
    if words.next()? != "(fetch)" {
        return None;
    }
    if let Some(filter) = words.next() {
        let inner = filter.strip_prefix('[')?.strip_suffix(']')?;
        if inner.is_empty() || inner.contains(']') || words.next().is_some() {
            return None;
        }
    }
    let lower = url
        .get(..8)
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    (lower.starts_with("http://") || lower.starts_with("https://")).then_some(url)
}

/// `new URL(url).origin` for an `http`/`https` URL: the scheme, host and a port that is not the
/// default.
fn url_origin(url: &str) -> Option<String> {
    let remote = parse_remote(url)?;
    let scheme = url.split_once("://")?.0.to_ascii_lowercase();
    Some(format!("{scheme}://{}", remote.host))
}

#[cfg(test)]
#[path = "forgejo_cli_tests.rs"]
pub(crate) mod tests;
