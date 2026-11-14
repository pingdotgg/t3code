//! Which host a checkout uses: T3's `SourceControlProviderRegistry` (`resolveHandle`,
//! `detectProviderContext`, `selectProviderContext`, `refineContext`) and
//! `refineUnknownRemoteProvider` (`source-control-core/src/server/discovery.ts`).
//!
//! - The checkout's remotes come from `git remote -v`; the registry recognises each one, and
//!   `origin` wins, then the first known host, then the first remote.
//! - A remote on a host no definition claims is asked of the host integrations, one after
//!   another in driver order: GitHub (a credential for that host), GitLab
//!   (`glab auth status --hostname <host>`) and Forgejo (fj's logins, then tea's). The first
//!   that claims it wins. Cursor Origin and GitCafe never claim one; Bitbucket and Azure DevOps
//!   have no refinement.
//! - Caches, as T3's: a checkout's answer 5 s (2,048 checkouts; failures not kept), an unknown
//!   server's verdict 5 minutes when every integration answered (512 servers), cleared when
//!   the settings change.
//!
//! Not ported: T3's VCS detection cache (5 minutes, stat-checked) and jj checkouts. Each
//! detection here runs `git rev-parse` before `git remote -v`; a warm T3 server runs only the
//! second.

use std::{
    path::{Path, PathBuf},
    time::Duration,
};

use conn_vcs::process::{GitCommand, OnLimit, ProcessError};

use crate::{
    cache::TtlCache,
    discovery::{ProbeCommand, ProbeFailure, run_probe},
    hosts::{
        DiscoveryContext,
        forgejo::{self, MatchOptions},
        forgejo_cli::{Program, Reason, Session},
        github::{self, CredentialError},
        gitlab,
    },
    registry::{self, ProviderInfo},
};

const DETECTION_CAPACITY: usize = 2_048;
const DETECTION_TTL: Duration = Duration::from_secs(5);
const UNKNOWN_REMOTE_CAPACITY: usize = 512;
const UNKNOWN_REMOTE_TTL: Duration = Duration::from_secs(5 * 60);
/// `probeTimeoutMs` for a CLI spec without its own.
const REFINE_TIMEOUT: Duration = Duration::from_secs(5);

/// `SourceControlProviderContext`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderContext {
    pub provider: ProviderInfo,
    pub remote_name: String,
    pub remote_url: String,
    pub requested_host: Option<String>,
}

/// One remote of `git remote -v` with a fetch URL.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Remote {
    pub name: String,
    pub url: String,
    pub push_url: Option<String>,
}

/// `detectProvider` failed: T3's `SourceControlProviderError` with this detail.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("Failed to detect source control provider.")]
pub struct DetectError;

/// `UnknownRemoteVerdict`.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Verdict {
    provider: Option<ProviderInfo>,
    settled: bool,
}

/// The detector and its two caches. One per server.
#[derive(Debug)]
pub struct Detector {
    detection: TtlCache<PathBuf, Result<Option<ProviderContext>, DetectError>>,
    unknown: TtlCache<String, Verdict>,
}

impl Default for Detector {
    fn default() -> Self {
        Self {
            detection: TtlCache::new(DETECTION_CAPACITY),
            unknown: TtlCache::new(UNKNOWN_REMOTE_CAPACITY),
        }
    }
}

/// `parseGitRemoteVerboseOutput`: `<name>\t<url> (fetch|push)`, with an optional promisor
/// filter after it.
pub fn parse_remote_verbose(output: &str) -> Vec<Remote> {
    let mut remotes: Vec<Remote> = Vec::new();
    let mut fetch: Vec<Option<String>> = Vec::new();
    for line in output.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        let Some((name, rest)) = line.split_once('\t') else {
            continue;
        };
        if name.is_empty() || name.chars().any(char::is_whitespace) {
            continue;
        }
        // `(.+) \((fetch|push)\)(?:\s+\[[^\]]+\])?$`: the last ` (fetch)` or ` (push)`.
        let rest = strip_filter(rest);
        let (url, direction) = if let Some(url) = rest.strip_suffix(" (fetch)") {
            (url, "fetch")
        } else if let Some(url) = rest.strip_suffix(" (push)") {
            (url, "push")
        } else {
            continue;
        };
        if url.is_empty() {
            continue;
        }
        let index = match remotes.iter().position(|r| r.name == name) {
            Some(index) => index,
            None => {
                remotes.push(Remote {
                    name: name.to_owned(),
                    url: String::new(),
                    push_url: None,
                });
                fetch.push(None);
                remotes.len() - 1
            }
        };
        if direction == "fetch" {
            if let Some(slot) = fetch.get_mut(index) {
                *slot = Some(url.to_owned());
            }
        } else if let Some(remote) = remotes.get_mut(index) {
            remote.push_url = Some(url.to_owned());
        }
    }
    remotes
        .into_iter()
        .zip(fetch)
        .filter_map(|(remote, url)| url.map(|url| Remote { url, ..remote }))
        .collect()
}

/// Drops a trailing `\s+\[[^\]]+\]` (a partial clone's promisor filter).
fn strip_filter(rest: &str) -> &str {
    let Some(head) = rest.strip_suffix(']') else {
        return rest;
    };
    let Some(open) = head.rfind('[') else {
        return rest;
    };
    let inside = head.get(open + 1..).unwrap_or_default();
    if inside.is_empty() || inside.contains(']') {
        return rest;
    }
    let before = head.get(..open).unwrap_or_default();
    let trimmed = before.trim_end();
    if trimmed.len() == before.len() {
        return rest;
    }
    trimmed
}

/// `selectProviderContext`.
pub fn select_provider_context(remotes: &[Remote]) -> Option<ProviderContext> {
    let candidates: Vec<ProviderContext> = remotes
        .iter()
        .filter_map(|remote| {
            registry::recognize_remote(&remote.url).map(|provider| ProviderContext {
                provider,
                remote_name: remote.name.clone(),
                remote_url: remote.url.clone(),
                requested_host: None,
            })
        })
        .collect();
    let pick = candidates
        .iter()
        .position(|c| c.remote_name == "origin")
        .or_else(|| candidates.iter().position(|c| c.provider.kind != "unknown"))
        .or(if candidates.is_empty() { None } else { Some(0) })?;
    candidates.into_iter().nth(pick)
}

/// `UnknownRemoteLookup.key`: the server, not the repository.
fn unknown_remote_key(context: &ProviderContext) -> String {
    [
        context.provider.name.as_str(),
        context.provider.base_url.as_str(),
        &strip_repository(context.remote_url.trim()),
        context.requested_host.as_deref().unwrap_or_default(),
    ]
    .join("\n")
}

/// `remoteUrl.replace(/(?<!\/\/[^/]*)[^/:]+\/[^/:]+\/?$/u, "")`: drops a trailing
/// `owner/name` unless it sits inside the authority of a `scheme://` URL.
fn strip_repository(remote: &str) -> String {
    let body = remote.strip_suffix('/').unwrap_or(remote);
    let Some((head, name)) = body.rsplit_once('/') else {
        return remote.to_owned();
    };
    if name.is_empty() || name.contains(':') {
        return remote.to_owned();
    }
    // The owner: the segment before, back to the previous `/` or `:`.
    let owner_start = head.rfind(['/', ':']).map_or(0, |i| i + 1);
    let owner = head.get(owner_start..).unwrap_or_default();
    if owner.is_empty() {
        return remote.to_owned();
    }
    let prefix = head.get(..owner_start).unwrap_or_default();
    // The lookbehind: `//` followed by no `/` up to the match means the match is in the
    // authority.
    if let Some(index) = prefix.rfind("//")
        && !prefix.get(index + 2..).unwrap_or_default().contains('/')
    {
        return remote.to_owned();
    }
    prefix.to_owned()
}

/// `git rev-parse --is-inside-work-tree --show-toplevel --git-common-dir`, then
/// `git remote -v` (`VcsDriverRegistry.resolve`, `GitVcsDriver.listRemotes`).
async fn list_remotes(
    cwd: &Path,
    child_env: &[(&'static str, std::ffi::OsString)],
) -> Result<Vec<Remote>, DetectError> {
    let mut probe = GitCommand::new(
        "GitVcsDriver.detectRepository",
        cwd,
        [
            "rev-parse",
            "--is-inside-work-tree",
            "--show-toplevel",
            "--git-common-dir",
        ],
    )
    .max_stdout(16_384, OnLimit::Fail);
    probe.env.extend(child_env.iter().cloned());
    let inside = match probe.run().await {
        Ok(output) => output.stdout_text().lines().next().map(str::trim) == Some("true"),
        Err(ProcessError::Exit { .. }) => false,
        Err(_) => return Err(DetectError),
    };
    if !inside {
        return Err(DetectError);
    }
    let mut command = GitCommand::new("GitVcsDriver.listRemotes", cwd, ["remote", "-v"])
        .timeout(Duration::from_secs(5))
        .max_stdout(64 * 1024, OnLimit::Fail);
    command.env.extend(child_env.iter().cloned());
    let output = command.run().await.map_err(|_| DetectError)?;
    Ok(parse_remote_verbose(&output.stdout_text()))
}

impl Detector {
    /// `resolveHandle`: the checkout's provider context, refined when its host is unknown.
    /// With `context` given (a caller-selected remote), only the refinement runs.
    pub async fn resolve(
        &self,
        ctx: DiscoveryContext<'_>,
        cwd: &Path,
        context: Option<ProviderContext>,
    ) -> Result<Option<ProviderContext>, DetectError> {
        match context {
            Some(context) => Ok(Some(self.refine(ctx, cwd, context).await)),
            None => {
                self.detection
                    .get_with(
                        cwd.to_path_buf(),
                        |answer| {
                            if answer.is_ok() {
                                DETECTION_TTL
                            } else {
                                Duration::ZERO
                            }
                        },
                        || async {
                            let remotes = list_remotes(cwd, ctx.child_env).await?;
                            match select_provider_context(&remotes) {
                                Some(context) => Ok(Some(self.refine(ctx, cwd, context).await)),
                                None => Ok(None),
                            }
                        },
                    )
                    .await
            }
        }
    }

    /// The settings changed: unknown servers are asked again (T3's `subscribeChanges`).
    pub fn settings_changed(&self) {
        self.unknown.invalidate_all();
    }

    /// `refineContext`.
    async fn refine(
        &self,
        ctx: DiscoveryContext<'_>,
        cwd: &Path,
        context: ProviderContext,
    ) -> ProviderContext {
        if context.provider.kind != "unknown" {
            return context;
        }
        let verdict = self
            .unknown
            .get_with(
                unknown_remote_key(&context),
                |v| {
                    if v.settled {
                        UNKNOWN_REMOTE_TTL
                    } else {
                        Duration::ZERO
                    }
                },
                || refine_unknown_remote(ctx, cwd, &context),
            )
            .await;
        match verdict.provider {
            Some(provider) => ProviderContext {
                provider,
                ..context
            },
            None => context,
        }
    }
}

/// One integration's answer: a claim, no claim, or no answer (not kept).
type Answer = Result<Option<ProviderInfo>, ()>;

/// `refineUnknownRemoteProvider`: every integration in driver order, one after another.
async fn refine_unknown_remote(
    ctx: DiscoveryContext<'_>,
    cwd: &Path,
    context: &ProviderContext,
) -> Verdict {
    let answers: [Answer; 3] = [
        refine_github(ctx, context).await,
        refine_gitlab(ctx, cwd, context).await,
        refine_forgejo(ctx, cwd, context).await,
    ];
    let mut settled = true;
    for answer in answers {
        match answer {
            Err(()) => settled = false,
            Ok(Some(provider)) => {
                return Verdict {
                    provider: Some(provider),
                    settled,
                };
            }
            Ok(None) => {}
        }
    }
    Verdict {
        provider: None,
        settled,
    }
}

/// GitHub's `refineUnknownRemote`: a credential for the server claims it, so errors name the
/// setting; a host turned off in Settings claims it too.
async fn refine_github(ctx: DiscoveryContext<'_>, context: &ProviderContext) -> Answer {
    let Some(base) = url::Url::parse(&context.provider.base_url).ok() else {
        return Ok(None);
    };
    let base_host = match (base.host_str(), base.port()) {
        (Some(h), Some(p)) if !h.is_empty() => format!("{h}:{p}"),
        (Some(h), None) if !h.is_empty() => h.to_owned(),
        _ => return Ok(None),
    };
    let host = crate::hosts::repositories::api_host_for_remote(&context.remote_url)
        .unwrap_or_else(|| base_host.clone());
    let known = match github::credential(ctx, &host).await {
        Ok(_) | Err(CredentialError::HostDisabled) => true,
        Err(CredentialError::CliMissing | CredentialError::NotSignedIn) => false,
        Err(CredentialError::CliFailed | CredentialError::Unresolved(_)) => return Err(()),
    };
    Ok(known.then(|| ProviderInfo {
        kind: "github".to_owned(),
        name: if host == "github.com" {
            "GitHub"
        } else {
            "GitHub Self-Hosted"
        }
        .to_owned(),
        base_url: if host == base_host {
            context.provider.base_url.clone()
        } else {
            format!("https://{host}")
        },
    }))
}

/// GitLab's `remoteRefinementArgs`: glab matches hosts by the remote's exact spelling.
fn gitlab_refinement_host(context: &ProviderContext) -> String {
    let remote = context.remote_url.trim();
    let authority = remote.split_once("://").and_then(|(scheme, rest)| {
        let valid = scheme
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic())
            && scheme
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'));
        let end = rest.find('/').unwrap_or(rest.len());
        let authority = rest.get(..end)?;
        (valid && !authority.is_empty()).then_some(authority)
    });
    let remote_host = match authority {
        Some(a) => a.rsplit_once('@').map_or(a, |(_, h)| h).to_owned(),
        None => match remote.split_once('@') {
            Some((user, rest)) if !user.is_empty() && !user.contains([':', '/']) => rest.to_owned(),
            _ => remote.to_owned(),
        },
    };
    let name = &context.provider.name;
    if remote_host.to_lowercase().starts_with(&name.to_lowercase()) {
        remote_host.get(..name.len()).unwrap_or(name).to_owned()
    } else {
        name.clone()
    }
}

/// `GITLAB_HOST_NOT_LOGGED_IN_PATTERN`: `\bnot (?:been )?authenticated with glab\b` or
/// `\bno gitlab instances? ha(?:s|ve) been authenticated\b`, case-insensitive.
fn gitlab_not_logged_in(text: &str) -> bool {
    let lower = text.to_lowercase();
    let word = |c: char| c.is_alphanumeric() || c == '_';
    let bounded = |phrase: &str| {
        lower.match_indices(phrase).any(|(index, _)| {
            let before = lower.get(..index).and_then(|s| s.chars().next_back());
            let after = lower
                .get(index + phrase.len()..)
                .and_then(|s| s.chars().next());
            !before.is_some_and(word) && !after.is_some_and(word)
        })
    };
    [
        "not authenticated with glab",
        "not been authenticated with glab",
        "no gitlab instance has been authenticated",
        "no gitlab instance have been authenticated",
        "no gitlab instances has been authenticated",
        "no gitlab instances have been authenticated",
    ]
    .into_iter()
    .any(bounded)
}

/// GitLab's CLI refinement: a glab login for the server claims it.
async fn refine_gitlab(ctx: DiscoveryContext<'_>, cwd: &Path, context: &ProviderContext) -> Answer {
    let host = gitlab_refinement_host(context);
    let mut command = ProbeCommand::new(
        "source-control.discovery.refine-unknown-remote",
        "glab",
        &["auth", "status", "--hostname", &host],
        cwd,
    );
    command.timeout = REFINE_TIMEOUT;
    command.allow_non_zero_exit = true;
    command.env = ctx.probe_env(&[]);
    let output = match run_probe(command).await {
        Ok(output) => output,
        Err(ProbeFailure::Missing { .. }) => return Ok(None),
        Err(_) => return Err(()),
    };
    let wanted = context.provider.name.to_lowercase();
    let combined = output.combined();
    let authenticated = gitlab::parse_auth_status_hosts(&combined)
        .iter()
        .any(|entry| entry.account.is_some() && entry.host == wanted);
    if !authenticated {
        return if gitlab_not_logged_in(&combined) {
            Ok(None)
        } else {
            Err(())
        };
    }
    Ok(Some(ProviderInfo {
        kind: "gitlab".to_owned(),
        name: "GitLab Self-Hosted".to_owned(),
        base_url: context.provider.base_url.clone(),
    }))
}

/// Forgejo's managed refinement: a fj login, else a tea login, for the server claims it.
async fn refine_forgejo(
    ctx: DiscoveryContext<'_>,
    cwd: &Path,
    context: &ProviderContext,
) -> Answer {
    let Some(remote) = forgejo::parse_remote(&context.remote_url) else {
        return Ok(None);
    };
    let session = Session::new(DiscoveryContext { cwd, ..ctx });
    let mut failed = false;
    for program in [Program::Fj, Program::Tea] {
        let logins = match session
            .list_logins(program, Some(&context.remote_url))
            .await
        {
            Ok(logins) => logins,
            Err(error) if error.reason == Some(Reason::MissingCli) => Vec::new(),
            Err(_) => {
                failed = true;
                continue;
            }
        };
        let options = MatchOptions {
            requested_host: context.requested_host.as_deref(),
            host_only: false,
        };
        if let Some(login) = forgejo::match_login(&logins, &remote, options) {
            return Ok(Some(ProviderInfo {
                kind: "forgejo".to_owned(),
                name: "Forgejo / Gitea".to_owned(),
                base_url: login.url.clone(),
            }));
        }
    }
    if failed { Err(()) } else { Ok(None) }
}

#[cfg(test)]
mod tests;
