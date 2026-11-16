//! Which host a checkout uses: T3's `SourceControlProviderRegistry` (`resolveHandle`,
//! `detectProviderContext`, `selectProviderContext`, `refineContext`) and
//! `refineUnknownRemoteProvider` (`source-control-core/src/server/discovery.ts`).
//!
//! - The checkout's remotes come from `git remote -v`; the registry recognises each one, and
//!   `origin` wins, then the first known host, then the first remote.
//! - A remote on an unknown host is refined only by GitHub credentials for that host.
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
    hosts::{
        DiscoveryContext,
        github::{self, CredentialError},
    },
    registry::{self, ProviderInfo},
};

const DETECTION_CAPACITY: usize = 2_048;
const DETECTION_TTL: Duration = Duration::from_secs(5);
const UNKNOWN_REMOTE_CAPACITY: usize = 512;
const UNKNOWN_REMOTE_TTL: Duration = Duration::from_secs(5 * 60);
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
            Some(context) => Ok(Some(self.refine(ctx, context).await)),
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
                                Some(context) => Ok(Some(self.refine(ctx, context).await)),
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
    async fn refine(&self, ctx: DiscoveryContext<'_>, context: ProviderContext) -> ProviderContext {
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
                || refine_unknown_remote(ctx, &context),
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

/// The only integration that can refine an unknown remote is GitHub.
async fn refine_unknown_remote(ctx: DiscoveryContext<'_>, context: &ProviderContext) -> Verdict {
    match refine_github(ctx, context).await {
        Ok(provider) => Verdict {
            provider,
            settled: true,
        },
        Err(()) => Verdict {
            provider: None,
            settled: false,
        },
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

#[cfg(test)]
mod tests;
