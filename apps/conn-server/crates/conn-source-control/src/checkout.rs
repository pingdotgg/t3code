//! GitHub pull request resolution and checkout, with local work kept when heads diverge.
use crate::{
    hosts::{DiscoveryContext, github, github_graphql::generated, repositories},
    registry, remote,
};
use conn_contract::{
    GitPreparePullRequestThreadInput, GitPreparePullRequestThreadResult,
    GitPreparePullRequestThreadResultPullRequest as Resolved, PullRequestState, ThreadEnvMode,
};
use conn_vcs::{VcsError, process::ProcessError, repo, setup, worktree};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};

#[derive(Clone, Debug)]
pub struct PullRequest {
    pub resolved: Resolved,
    pub head_sha: Option<String>,
    pub head_repository: Option<String>,
    pub head_owner: Option<String>,
    pub cross_repository: bool,
}

#[derive(Debug, thiserror::Error)]
#[error("{detail}")]
pub struct Error {
    pub operation: &'static str,
    pub cwd: String,
    pub detail: String,
    provider: bool,
    git_error: Option<Box<conn_contract::GitCommandError>>,
    materialization: Option<Box<Value>>,
}
impl Error {
    fn provider(cwd: &Path, detail: impl Into<String>) -> Self {
        Self {
            operation: "getChangeRequest",
            cwd: cwd.to_string_lossy().into(),
            detail: detail.into(),
            provider: true,
            git_error: None,
            materialization: None,
        }
    }
    fn manager(cwd: &Path, detail: impl Into<String>) -> Self {
        Self {
            operation: "preparePullRequestThread",
            cwd: cwd.to_string_lossy().into(),
            detail: detail.into(),
            provider: false,
            git_error: None,
            materialization: None,
        }
    }
    pub fn to_contract(&self) -> Value {
        if let Some(error) = &self.materialization {
            return (**error).clone();
        }
        if let Some(error) = &self.git_error {
            return conn_contract::to_json(error);
        }
        if self.provider {
            json!({"_tag":"SourceControlProviderError", "provider":"github", "operation":self.operation, "cwd":self.cwd, "detail":self.detail})
        } else {
            json!({"_tag":"GitManagerError", "operation":self.operation, "cwd":self.cwd, "detail":self.detail})
        }
    }
}
impl From<VcsError> for Error {
    fn from(e: VcsError) -> Self {
        let e = e.to_git_command_error();
        let mut error = Self::manager(Path::new(&e.cwd), e.detail.clone());
        error.git_error = Some(Box::new(e));
        error
    }
}

impl From<crate::repository::HostFailure> for Error {
    fn from(error: crate::repository::HostFailure) -> Self {
        Self::provider(Path::new(""), error.detail)
    }
}

impl From<ProcessError> for Error {
    fn from(error: ProcessError) -> Self {
        Self::from(VcsError::from(error))
    }
}

pub async fn resolve(
    ctx: DiscoveryContext<'_>,
    cwd: &Path,
    reference: &str,
) -> Result<PullRequest, Error> {
    resolve_inner(ctx, cwd, reference)
        .await
        .map_err(|mut error| {
            error.cwd = cwd.to_string_lossy().into();
            error
        })
}

async fn resolve_inner(
    ctx: DiscoveryContext<'_>,
    cwd: &Path,
    reference: &str,
) -> Result<PullRequest, Error> {
    let reference = reference
        .trim()
        .strip_prefix('#')
        .unwrap_or(reference.trim());
    let (location, number) = if let Some((kind, url)) =
        registry::parse_change_request_url(reference)
    {
        if kind != registry::HostKind::GitHub {
            return Err(Error::provider(
                cwd,
                "Could not resolve the GitHub repository from this checkout.",
            ));
        }
        (
            repositories::parse_selector(&url.repository_url, &url.link.host)
                .ok_or_else(|| Error::provider(cwd, "GitHub returned an invalid pull request."))?,
            Some(url.link.number),
        )
    } else {
        (
            repositories::resolve_repository(DiscoveryContext { cwd, ..ctx }).await?,
            reference.parse::<u64>().ok().filter(|n| *n > 0),
        )
    };
    let response = if let Some(number) = number {
        github::api_json(ctx,cwd,&location.host,"graphql",Some(json!({"query":generated::PULL_REQUEST_BY_NUMBER.document,"variables":{"owner":location.owner,"name":location.name,"number":number}})),"Pull request not found. Check the PR number or URL and try again.").await?
    } else if reference.split_once(':').is_some_and(|(owner, branch)| {
        !owner.is_empty() && !owner.contains(['/', ' ', ':']) && !branch.is_empty()
    }) {
        let mut found = None;
        for state in ["open", "all"] {
            let path = format!(
                "repos/{}/{}/pulls?head={}&state={state}&sort=created&direction=desc&per_page=100",
                github::encode_uri_component(&location.owner),
                github::encode_uri_component(&location.name),
                github::encode_uri_component(reference)
            );
            let response = github::api_json(
                ctx,
                cwd,
                &location.host,
                &path,
                None,
                "Pull request not found. Check the PR number or URL and try again.",
            )
            .await?;
            if let Some(pr) = response.as_array().and_then(|rows| rows.first()) {
                found = Some(
                    json!({"number":pr.get("number"),"title":pr.get("title"),"url":pr.get("html_url"),"baseRefName":pr.pointer("/base/ref"),"headRefName":pr.pointer("/head/ref"),"headRefOid":pr.pointer("/head/sha"),"state":if pr.get("merged_at").is_some_and(|v| !v.is_null()) {"MERGED"} else if pr.get("state").and_then(Value::as_str)==Some("open") {"OPEN"} else {"CLOSED"},"isCrossRepository":pr.pointer("/head/repo/full_name")!=pr.pointer("/base/repo/full_name"),"headRepository":{"nameWithOwner":pr.pointer("/head/repo/full_name")},"headRepositoryOwner":{"login":pr.pointer("/head/user/login")}}),
                );
                break;
            }
        }
        json!({"data":{"repository":{"pullRequest":found}}})
    } else {
        let mut found = None;
        for states in [json!(["OPEN"]), json!(["OPEN", "CLOSED", "MERGED"])] {
            let response=github::api_json(ctx,cwd,&location.host,"graphql",Some(json!({"query":generated::PULL_REQUESTS_BY_HEAD.document,"variables":{"owner":location.owner,"name":location.name,"head":reference,"states":states,"first":1}})),"Pull request not found. Check the PR number or URL and try again.").await?;
            if let Some(node) = response
                .pointer("/data/repository/pullRequests/nodes")
                .and_then(Value::as_array)
                .and_then(|a| a.first())
                .filter(|n| !n.is_null())
            {
                found = Some(node.clone());
                break;
            }
        }
        json!({"data":{"repository":{"pullRequest":found}}})
    };
    let value = response
        .pointer("/data/repository/pullRequest")
        .filter(|v| !v.is_null())
        .ok_or_else(|| {
            Error::provider(
                cwd,
                "Pull request not found. Check the PR number or URL and try again.",
            )
        })?;
    let text = |key| {
        value
            .get(key)
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
            .map(str::to_owned)
    };
    let invalid = || Error::provider(cwd, "GitHub returned an invalid pull request.");
    Ok(PullRequest {
        resolved: Resolved {
            number: value
                .get("number")
                .and_then(Value::as_i64)
                .filter(|n| *n > 0)
                .ok_or_else(invalid)?,
            title: text("title").ok_or_else(invalid)?,
            url: text("url").ok_or_else(invalid)?,
            base_branch: text("baseRefName").ok_or_else(invalid)?,
            head_branch: text("headRefName").ok_or_else(invalid)?,
            state: match text("state").as_deref() {
                Some("OPEN") => PullRequestState::Open,
                Some("CLOSED") => PullRequestState::Closed,
                Some("MERGED") => PullRequestState::Merged,
                _ => return Err(invalid()),
            },
        },
        head_sha: text("headRefOid"),
        head_repository: value
            .pointer("/headRepository/nameWithOwner")
            .and_then(Value::as_str)
            .map(str::to_owned),
        head_owner: value
            .pointer("/headRepositoryOwner/login")
            .and_then(Value::as_str)
            .map(str::to_owned),
        cross_repository: value
            .get("isCrossRepository")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

async fn git(cwd: &Path, args: Vec<String>) -> Result<String, Error> {
    Ok(
        conn_vcs::process::GitCommand::new("GitManager.preparePullRequestThread", cwd, args)
            .timeout(Duration::from_secs(300))
            .text()
            .await?
            .trim()
            .into(),
    )
}
async fn revision(cwd: &Path, reference: &str) -> Option<String> {
    conn_vcs::process::GitCommand::new(
        "GitManager.preparePullRequestThread",
        cwd,
        ["rev-parse", "--verify", "--end-of-options", reference],
    )
    .text()
    .await
    .ok()
    .map(|s| s.trim().to_owned())
}
async fn canonical(path: &Path) -> PathBuf {
    let path = path.to_owned();
    tokio::task::spawn_blocking(move || std::fs::canonicalize(&path).unwrap_or(path))
        .await
        .unwrap_or_default()
}

async fn find_remote(cwd: &Path, host: &str, repository: &str) -> Result<Option<String>, Error> {
    for name in repo::remote_names(cwd).await? {
        if let Some(url) = repo::config_get(cwd, &format!("remote.{name}.url")).await?
            && repositories::api_host_for_remote(&url).as_deref() == Some(host)
            && remote::parse_git_remote_repository(&url)
                .is_some_and(|(_, p)| p.eq_ignore_ascii_case(repository))
        {
            return Ok(Some(name));
        }
    }
    Ok(None)
}

async fn head_remote(
    ctx: DiscoveryContext<'_>,
    cwd: &Path,
    pr: &PullRequest,
) -> Result<String, Error> {
    let Some(repository) = &pr.head_repository else {
        if pr.cross_repository {
            return Err(Error::manager(cwd, "The fork is gone."));
        }
        return Ok(repo::primary_remote(cwd)
            .await?
            .unwrap_or_else(|| "origin".into()));
    };
    let host = registry::parse_change_request_url(&pr.resolved.url)
        .map(|(_, p)| p.link.host)
        .unwrap_or_else(|| "github.com".into());
    if let Some(name) = find_remote(cwd, &host, repository).await? {
        return Ok(name);
    }
    let urls =
        repositories::checkout_clone_urls(DiscoveryContext { cwd, ..ctx }, &host, repository)
            .await?;
    let origin = repo::config_get(cwd, "remote.origin.url")
        .await?
        .unwrap_or_default();
    let url = if remote::clone_url_protocol(&origin) == Some(remote::CloneProtocol::Ssh) {
        urls.ssh_url
    } else {
        urls.url
    };
    let context = crate::repository::ServiceContext {
        server_cwd: cwd,
        process_cwd: cwd,
        home: ctx.home,
        child_env: ctx.child_env,
        clone_timeout: Duration::from_secs(300),
    };
    Ok(crate::repository::ensure_remote(
        context,
        cwd,
        pr.head_owner.as_deref().unwrap_or("fork"),
        &url,
    )
    .await?)
}

async fn fetch_upstream(
    ctx: DiscoveryContext<'_>,
    cwd: &Path,
    pr: &PullRequest,
) -> Result<(String, String), Error> {
    let remote = head_remote(ctx, cwd, pr).await?;
    let Some((sha, _)) = setup::fetch_remote_branch(cwd, &remote, &pr.resolved.head_branch).await?
    else {
        return Err(Error::manager(
            cwd,
            "The pull request head could not be resolved for this checkout.",
        ));
    };
    Ok((remote, sha))
}

async fn set_upstream(cwd: &Path, branch: &str, remote: &str, head: &str) -> Result<(), Error> {
    let args = vec![
        "branch".into(),
        "--set-upstream-to".into(),
        format!("refs/remotes/{remote}/{head}"),
        "--".into(),
        branch.into(),
    ];
    let first =
        conn_vcs::process::GitCommand::new("GitVcsDriver.setBranchUpstream", cwd, args.clone())
            .run()
            .await;
    if first.is_ok() {
        return Ok(());
    }
    let missing_mapping = matches!(&first, Err(ProcessError::Exit{stderr,..}) if stderr.contains("cannot set up tracking information") && stderr.contains("is not a branch"));
    if missing_mapping {
        git(
            cwd,
            vec![
                "config".into(),
                "--add".into(),
                format!("remote.{remote}.fetch"),
                format!("+refs/heads/{head}*:refs/remotes/{remote}/{head}*"),
            ],
        )
        .await?;
    }
    git(cwd, args).await?;
    Ok(())
}

async fn fetch_head(cwd: &Path, pr: &PullRequest) -> Result<String, Error> {
    let mut remote = repo::primary_remote(cwd)
        .await?
        .unwrap_or_else(|| "origin".into());
    if let Some((_, parsed)) = registry::parse_change_request_url(&pr.resolved.url)
        && let Some(name) = find_remote(cwd, &parsed.link.host, &parsed.link.repository).await?
    {
        remote = name;
    }
    git(
        cwd,
        vec![
            "fetch".into(),
            "--quiet".into(),
            "--no-tags".into(),
            "--".into(),
            remote,
            format!("refs/pull/{}/head", pr.resolved.number),
        ],
    )
    .await?;
    revision(cwd, "FETCH_HEAD").await.ok_or_else(|| {
        Error::manager(
            cwd,
            "The pull request head could not be resolved for this checkout.",
        )
    })
}

async fn refreshed_head(
    cwd: &Path,
    pr: &PullRequest,
    require_match: bool,
) -> Result<String, Error> {
    if let Ok(target) = fetch_head(cwd, pr).await
        && (!require_match || pr.head_sha.as_deref().is_none_or(|sha| sha == target))
    {
        return Ok(target);
    }
    let upstream = git(
        cwd,
        vec![
            "rev-parse".into(),
            "--symbolic-full-name".into(),
            "@{upstream}".into(),
        ],
    )
    .await?;
    if upstream.ends_with(&format!("/{}", pr.resolved.head_branch))
        && let Some(target) = revision(cwd, "@{upstream}").await
        && (!require_match || pr.head_sha.as_deref() == Some(&target))
    {
        return Ok(target);
    }
    Err(Error::manager(
        cwd,
        "The pull request head could not be resolved for this checkout.",
    ))
}

async fn refresh(cwd: &Path, target: &str, previous: Option<&str>) -> Result<bool, Error> {
    if !(7..=64).contains(&target.len()) || !target.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Ok(false);
    }
    let head = revision(cwd, "HEAD").await;
    if head.as_deref() == Some(target) {
        return Ok(true);
    }
    if !git(cwd, vec!["status".into(), "--porcelain".into()])
        .await?
        .is_empty()
    {
        return Ok(false);
    }
    let Some(head) = head else {
        return Ok(false);
    };
    let ancestor = conn_vcs::process::GitCommand::new(
        "GitManager.preparePullRequestThread",
        cwd,
        ["merge-base", "--is-ancestor", &head, target],
    )
    .allow_exit(&[1])
    .run()
    .await?
    .code
        == 0;
    if !ancestor && previous != Some(&head) {
        return Ok(false);
    }
    if !ancestor {
        git(
            cwd,
            vec!["update-ref".into(), "refs/t3code/pre-refresh".into(), head],
        )
        .await?;
    }
    git(
        cwd,
        vec![
            if ancestor { "merge" } else { "reset" }.into(),
            if ancestor { "--ff-only" } else { "--merge" }.into(),
            target.into(),
        ],
    )
    .await?;
    Ok(true)
}

async fn initialize_submodules(ctx: DiscoveryContext<'_>, cwd: &Path) -> Result<(), Error> {
    let configured = ctx.settings.worktree_submodules().map(str::to_owned);
    let path = cwd.join("t3.json");
    let project = tokio::task::spawn_blocking(move || {
        let file = std::fs::File::open(path).ok()?;
        use std::io::Read;
        let mut text = String::new();
        file.take(1_000_000).read_to_string(&mut text).ok()?;
        serde_json::from_str::<Value>(&text)
            .ok()?
            .get("worktreeSubmodules")?
            .as_str()
            .map(str::to_owned)
    })
    .await
    .ok()
    .flatten();
    let mode = configured.or(project).unwrap_or_else(|| "recursive".into());
    if mode != "none" {
        let mut args = vec!["submodule".into(), "update".into(), "--init".into()];
        if mode != "top-level" {
            args.push("--recursive".into());
        }
        git(cwd, args).await?;
    }
    Ok(())
}

pub async fn prepare(
    ctx: DiscoveryContext<'_>,
    input: &GitPreparePullRequestThreadInput,
    dir: &Path,
) -> Result<(GitPreparePullRequestThreadResult, bool), Error> {
    prepare_inner(ctx, input, dir).await.map_err(|mut error| {
        if error.cwd.is_empty() {
            error.cwd.clone_from(&input.cwd);
        }
        error
    })
}

async fn prepare_inner(
    ctx: DiscoveryContext<'_>,
    input: &GitPreparePullRequestThreadInput,
    dir: &Path,
) -> Result<(GitPreparePullRequestThreadResult, bool), Error> {
    let cwd = Path::new(&input.cwd);
    let pr = resolve(ctx, cwd, &input.reference).await?;
    let mut branch = pr.resolved.head_branch.clone();
    if branch.starts_with('-')
        || conn_vcs::process::GitCommand::new(
            "GitManager.preparePullRequestThread",
            cwd,
            ["check-ref-format", "--branch", &branch],
        )
        .run()
        .await
        .is_err()
    {
        return Err(Error::manager(
            cwd,
            "The pull request head branch is not valid.",
        ));
    }
    let (path, on_head, run_setup) = if input.mode == ThreadEnvMode::Local {
        if !git(
            cwd,
            vec![
                "status".into(),
                "--porcelain".into(),
                "--untracked-files=no".into(),
            ],
        )
        .await?
        .is_empty()
        {
            return Err(Error::manager(
                cwd,
                format!(
                    "This repository has uncommitted changes. Commit or stash them before checking out pull request #{} here, or check it out in its own folder.",
                    pr.resolved.number
                ),
            ));
        }
        if pr.cross_repository {
            let location =
                registry::parse_change_request_url(&pr.resolved.url).map(|(_, parsed)| parsed.link);
            if let Some(location) = location {
                let repository = github::api_json(
                    ctx,
                    cwd,
                    &location.host,
                    &format!("repos/{}", location.repository),
                    None,
                    "Repository not found. Check the owner and name and try again.",
                )
                .await?;
                if repository.get("default_branch").and_then(Value::as_str) == Some(branch.as_str())
                    && let Some(owner) = &pr.head_owner
                {
                    branch = format!("{owner}/{branch}");
                }
            }
        }
        let upstream = fetch_upstream(ctx, cwd, &pr).await;
        let target = match &upstream {
            Ok((_, sha)) => sha.clone(),
            Err(_) => fetch_head(cwd, &pr).await?,
        };
        let exists = repo::ref_exists(cwd, &format!("refs/heads/{branch}")).await?;
        if !exists {
            git(
                cwd,
                vec!["branch".into(), "--".into(), branch.clone(), target.clone()],
            )
            .await?;
        }
        git(cwd, vec!["checkout".into(), branch.clone(), "--".into()]).await?;
        if exists {
            git(
                cwd,
                vec![
                    "merge".into(),
                    "--ff-only".into(),
                    "--quiet".into(),
                    target.clone(),
                ],
            )
            .await
            .map_err(|_| {
                Error::provider(cwd, "The pull request could not be checked out with git.")
            })?;
        }
        if let Ok((remote, _)) = upstream {
            let _ = set_upstream(cwd, &branch, &remote, &pr.resolved.head_branch).await;
        }
        let on_head = if let Some(sha) = &pr.head_sha {
            refresh(cwd, sha, None).await.unwrap_or(false)
        } else {
            false
        };
        (None, on_head, false)
    } else {
        let names = git(
            cwd,
            vec![
                "for-each-ref".into(),
                "--format=%(refname:lstrip=2)".into(),
                "refs/heads".into(),
            ],
        )
        .await?
        .lines()
        .map(str::to_owned)
        .collect::<Vec<_>>();
        branch = conn_vcs::naming::worktree_branch(
            pr.resolved.number,
            &branch,
            pr.cross_repository,
            &names,
        );
        let worktrees = worktree::list_worktrees(cwd).await?;
        let root = canonical(cwd).await;
        let existing = worktrees
            .iter()
            .find(|w| w.ref_name.as_deref() == Some(&branch))
            .or_else(|| {
                worktrees.iter().find(|w| {
                    w.ref_name.as_deref() == Some(&pr.resolved.head_branch) && w.path != root
                })
            });
        if let Some(existing) = existing {
            if canonical(&existing.path).await == root {
                return Err(Error::manager(
                    cwd,
                    "This PR branch is already checked out in the main repo. Use Local, or switch the main repo off that branch before creating a worktree thread.",
                ));
            }
            let before = revision(&existing.path, "HEAD").await;
            let on_head = if existing.ref_name.as_deref() == Some(&branch) {
                let previous = revision(&existing.path, "@{upstream}").await;
                if let Ok((remote, _)) = fetch_upstream(ctx, &existing.path, &pr).await {
                    let _ =
                        set_upstream(&existing.path, &branch, &remote, &pr.resolved.head_branch)
                            .await;
                }
                match refreshed_head(&existing.path, &pr, false).await {
                    Ok(target) => refresh(&existing.path, &target, previous.as_deref())
                        .await
                        .unwrap_or(false),
                    Err(_) => false,
                }
            } else {
                false
            };
            let moved = before != revision(&existing.path, "HEAD").await;
            (
                Some(existing.path.to_string_lossy().into_owned()),
                on_head,
                moved,
            )
        } else {
            let exists = names.contains(&branch);
            let upstream = fetch_upstream(ctx, cwd, &pr).await;
            if !exists {
                let target = match &upstream {
                    Ok((_, sha)) => sha.clone(),
                    Err(_) => fetch_head(cwd, &pr).await.map_err(|mut e| {
                        e.detail = format!(
                            "Failed to materialize pull request #{} branch {} as {branch}.",
                            pr.resolved.number, pr.resolved.head_branch
                        );
                        e.materialization=Some(Box::new(json!({"_tag":"GitPullRequestMaterializationError","cwd":input.cwd,"pullRequestNumber":pr.resolved.number,"headRepository":pr.head_repository,"headBranch":pr.resolved.head_branch,"localBranch":branch,"cause":{"name":"Error","message":e.detail}})));
                        e
                    })?,
                };
                git(
                    cwd,
                    vec!["branch".into(), "--".into(), branch.clone(), target],
                )
                .await?;
            }
            let worktree = worktree::create_worktree(&worktree::CreateWorktree {
                cwd: cwd.into(),
                ref_name: branch.clone(),
                new_ref_name: None,
                base_ref_name: None,
                worktrees_dir: dir.into(),
            })
            .await?;
            let previous = revision(&worktree.path, "@{upstream}").await;
            if let Ok((remote, _)) = upstream {
                let _ =
                    set_upstream(&worktree.path, &branch, &remote, &pr.resolved.head_branch).await;
            }
            let on_head = if exists {
                match refreshed_head(&worktree.path, &pr, true).await {
                    Ok(target) => {
                        if pr.head_sha.as_deref().is_some_and(|sha| sha != target) {
                            false
                        } else {
                            let head = revision(&worktree.path, "HEAD").await;
                            let published = if let Some(head) = &head {
                                let refs = git(
                                    &worktree.path,
                                    vec![
                                        "for-each-ref".into(),
                                        "--contains".into(),
                                        head.clone(),
                                        "refs/remotes".into(),
                                    ],
                                )
                                .await
                                .unwrap_or_default();
                                let reflog = git(
                                    &worktree.path,
                                    vec![
                                        "log".into(),
                                        "--walk-reflogs".into(),
                                        "--format=%H".into(),
                                        "@{upstream}".into(),
                                    ],
                                )
                                .await
                                .unwrap_or_default();
                                !refs.is_empty() || reflog.lines().any(|line| line == head)
                            } else {
                                false
                            };
                            refresh(
                                &worktree.path,
                                &target,
                                if published {
                                    head.as_deref()
                                } else {
                                    previous.as_deref()
                                },
                            )
                            .await
                            .unwrap_or(false)
                        }
                    }
                    Err(_) => false,
                }
            } else {
                true
            };
            initialize_submodules(ctx, &worktree.path).await?;
            (
                Some(worktree.path.to_string_lossy().into_owned()),
                on_head,
                true,
            )
        }
    };
    let _ = git(
        cwd,
        vec![
            "config".into(),
            format!("branch.{branch}.t3-pull-request"),
            pr.resolved.url.clone(),
        ],
    )
    .await;
    Ok((
        GitPreparePullRequestThreadResult {
            pull_request: pr.resolved,
            branch,
            worktree_path: path,
            is_on_pull_request_head: Some(on_head),
        },
        run_setup,
    ))
}

#[cfg(test)]
#[path = "checkout_tests.rs"]
mod tests;
