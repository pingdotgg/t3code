//! GitHub pull request resolution and checkout, with local work kept when heads diverge.
use crate::{
    cli::{self, CliCall},
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

impl From<ProcessError> for Error {
    fn from(error: ProcessError) -> Self {
        Self::from(VcsError::from(error))
    }
}

async fn gh(
    ctx: DiscoveryContext<'_>,
    cwd: &Path,
    host: &str,
    endpoint: &str,
    body: Value,
) -> Result<Value, Error> {
    if !github::is_github_host(host) {
        return Err(Error::provider(
            cwd,
            "Could not resolve the GitHub repository from this checkout.",
        ));
    }
    let token = github::credential(ctx, host).await.map_err(|e| {
        let detail = match e {
            github::CredentialError::CliMissing => "No GitHub credential on the server. Set GH_TOKEN, or install the GitHub CLI and run `gh auth login`.".into(),
            github::CredentialError::NotSignedIn => match ctx.settings.host(github::KIND).host_account(host) {
                Some(account)=>format!("No GitHub credential for {account} on {host}: run `gh auth login --hostname {host}` for that account or pick another in Settings → Source Control."),
                None=>format!("No GitHub credential for {host}: run `gh auth login --hostname {host}`."),
            },
            github::CredentialError::HostDisabled => format!("GitHub host {host} is turned off in Settings → Source Control."),
            github::CredentialError::CliFailed => format!("The GitHub CLI could not hand over a credential for {host}. Check `gh auth status` on the server."),
            github::CredentialError::Unresolved(e) => e,
        }; Error::provider(cwd, detail)
    })?;
    let mut call = CliCall::new(
        "GitHubSourceControlProvider.getChangeRequest",
        "gh",
        ["api", endpoint, "--hostname", host, "--input", "-"],
        cwd,
    );
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
    if endpoint == "graphql" {
        call.stdin = Some(body.to_string().into_bytes());
    } else {
        call.args = vec![
            "api".into(),
            endpoint.into(),
            "--hostname".into(),
            host.into(),
            "--method".into(),
            "GET".into(),
        ];
    }
    let output = cli::run(call).await.map_err(|e| {
        let text = e.stderr().to_lowercase();
        Error::provider(
            cwd,
            if text.contains("401") {
                "GitHub is not authenticated. Run `gh auth login` (or set GH_TOKEN) and retry."
            } else if text.contains("404") {
                "Pull request not found. Check the PR number or URL and try again."
            } else if text.contains("rate limit") {
                "GitHub API rate limit exceeded. Requests resume when the limit resets."
            } else {
                "GitHub request failed."
            },
        )
    })?;
    serde_json::from_str(&output.stdout)
        .map_err(|_| Error::provider(cwd, "GitHub returned an invalid pull request."))
}

async fn locator(ctx: DiscoveryContext<'_>, cwd: &Path) -> Result<repositories::Locator, Error> {
    let host = ctx
        .env
        .non_blank("GH_HOST")
        .unwrap_or_else(|| "github.com".into());
    if let Some(selector) = ctx
        .env
        .non_blank("GH_REPO")
        .and_then(|s| repositories::parse_selector(&s, &host))
    {
        return Ok(selector);
    }
    let remotes = conn_vcs::process::GitCommand::new(
        "GitHubSourceControlProvider.resolveRepository",
        cwd,
        ["remote", "-v"],
    )
    .text()
    .await?;
    let mut remotes = crate::detect::parse_remote_verbose(&remotes);
    remotes.sort_by_key(|r| r.name != "origin");
    for r in remotes {
        if let Some(host) = repositories::api_host_for_remote(&r.url)
            && let Some((_, name)) = remote::parse_git_remote_repository(&r.url)
            && let Some(locator) = repositories::parse_selector(&name, &host)
        {
            return Ok(locator);
        }
    }
    Err(Error::provider(
        cwd,
        "Could not resolve the GitHub repository from this checkout.",
    ))
}

pub async fn resolve(
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
            locator(ctx, cwd).await?,
            reference.parse::<u64>().ok().filter(|n| *n > 0),
        )
    };
    let response = if let Some(number) = number {
        gh(ctx,cwd,&location.host,"graphql",json!({"query":generated::PULL_REQUEST_BY_NUMBER.document,"variables":{"owner":location.owner,"name":location.name,"number":number}})).await?
    } else {
        let mut found = None;
        for states in [json!(["OPEN"]), json!(["OPEN", "CLOSED", "MERGED"])] {
            let response=gh(ctx,cwd,&location.host,"graphql",json!({"query":generated::PULL_REQUESTS_BY_HEAD.document,"variables":{"owner":location.owner,"name":location.name,"head":reference.rsplit(':').next().unwrap_or(reference),"states":states,"first":1}})).await?;
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

pub fn worktree_branch(number: i64, head: &str, cross: bool, branches: &[String]) -> String {
    if !cross {
        return head.into();
    }
    let suffix = branch_fragment(head);
    let creatable = |name: &str| {
        !branches
            .iter()
            .any(|b| name.starts_with(&format!("{b}/")) || b.starts_with(&format!("{name}/")))
    };
    let preferred = format!("t3code/pr-{number}/{suffix}");
    if creatable(&preferred) {
        return preferred;
    }
    let flat = format!("t3code-pr-{number}-{}", suffix.replace('/', "-"));
    let mut name = flat.clone();
    for n in 2..=branches.len().saturating_add(2) {
        if creatable(&name) {
            return name;
        }
        name = format!("{flat}-{n}");
    }
    name
}

pub fn branch_fragment(raw: &str) -> String {
    let mut result = String::new();
    for c in raw.trim().to_lowercase().chars() {
        if matches!(c, '\'' | '"' | '`') {
            continue;
        }
        let c = if c.is_ascii_alphanumeric() || matches!(c, '/' | '_' | '-') {
            c
        } else {
            '-'
        };
        if matches!(c, '-' | '/') && result.ends_with(c) {
            continue;
        }
        result.push(c);
    }
    let result = result
        .trim_matches(['.', '/', '_', '-'])
        .chars()
        .take(64)
        .collect::<String>();
    let result = result.trim_end_matches(['.', '/', '_', '-']);
    if result.is_empty() {
        "update".into()
    } else {
        result.into()
    }
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

async fn head_remote(
    ctx: DiscoveryContext<'_>,
    cwd: &Path,
    pr: &PullRequest,
) -> Result<String, Error> {
    let Some(repository) = &pr.head_repository else {
        return Ok(repo::primary_remote(cwd)
            .await?
            .unwrap_or_else(|| "origin".into()));
    };
    let host = registry::parse_change_request_url(&pr.resolved.url)
        .map(|(_, p)| p.link.host)
        .unwrap_or_else(|| "github.com".into());
    for name in repo::remote_names(cwd).await? {
        if let Some(url) = repo::config_get(cwd, &format!("remote.{name}.url")).await?
            && repositories::api_host_for_remote(&url).as_deref() == Some(&host)
            && remote::parse_git_remote_repository(&url)
                .is_some_and(|(_, p)| p.eq_ignore_ascii_case(repository))
        {
            return Ok(name);
        }
    }
    let response = gh(ctx, cwd, &host, &format!("repos/{repository}"), json!({})).await?;
    let origin = repo::config_get(cwd, "remote.origin.url")
        .await?
        .unwrap_or_default();
    let key = if remote::clone_url_protocol(&origin) == Some(remote::CloneProtocol::Ssh) {
        "ssh_url"
    } else {
        "html_url"
    };
    let url = response
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| Error::provider(cwd, "GitHub returned an invalid repository."))?;
    let preferred = pr.head_owner.as_deref().unwrap_or("fork");
    let names = repo::remote_names(cwd).await?;
    let mut name = preferred.to_owned();
    for n in 2..=names.len().saturating_add(2) {
        if !names.contains(&name) {
            break;
        }
        name = format!("{preferred}-{n}");
    }
    git(
        cwd,
        vec![
            "remote".into(),
            "add".into(),
            "--".into(),
            name.clone(),
            url.into(),
        ],
    )
    .await?;
    Ok(name)
}

async fn configure(
    ctx: DiscoveryContext<'_>,
    cwd: &Path,
    pr: &PullRequest,
    branch: &str,
) -> Result<String, Error> {
    let remote = head_remote(ctx, cwd, pr).await?;
    let Some((sha, _)) =
        setup::fetch_base(cwd, &format!("{remote}/{}", pr.resolved.head_branch)).await?
    else {
        return Err(Error::manager(
            cwd,
            "The pull request head could not be resolved for this checkout.",
        ));
    };
    git(
        cwd,
        vec!["config".into(), format!("branch.{branch}.remote"), remote],
    )
    .await?;
    git(
        cwd,
        vec![
            "config".into(),
            format!("branch.{branch}.merge"),
            format!("refs/heads/{}", pr.resolved.head_branch),
        ],
    )
    .await?;
    Ok(sha)
}

async fn fetch_head(cwd: &Path, pr: &PullRequest) -> Result<String, Error> {
    let mut remote = repo::primary_remote(cwd)
        .await?
        .unwrap_or_else(|| "origin".into());
    if let Some((_, parsed)) = registry::parse_change_request_url(&pr.resolved.url) {
        for name in repo::remote_names(cwd).await? {
            if let Some(url) = repo::config_get(cwd, &format!("remote.{name}.url")).await?
                && repositories::api_host_for_remote(&url).as_deref() == Some(&parsed.link.host)
                && remote::parse_git_remote_repository(&url)
                    .is_some_and(|(_, path)| path.eq_ignore_ascii_case(&parsed.link.repository))
            {
                remote = name;
                break;
            }
        }
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
    let cwd = Path::new(&input.cwd);
    let pr = resolve(ctx, cwd, &input.reference).await?;
    let mut branch = pr.resolved.head_branch.clone();
    // Validate every remote-provided branch before passing it to git.
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
                let repository = gh(
                    ctx,
                    cwd,
                    &location.host,
                    &format!("repos/{}", location.repository),
                    json!({}),
                )
                .await?;
                if repository.get("default_branch").and_then(Value::as_str) == Some(branch.as_str())
                    && let Some(owner) = &pr.head_owner
                {
                    branch = format!("{owner}/{branch}");
                }
            }
        }
        let target = match configure(ctx, cwd, &pr, &branch).await {
            Ok(sha) => sha,
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
        if branch.starts_with('-') {
            return Err(Error::manager(
                cwd,
                "The pull request head branch is not valid.",
            ));
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
        let _ = configure(ctx, cwd, &pr, &branch).await;
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
        branch = worktree_branch(pr.resolved.number, &branch, pr.cross_repository, &names);
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
                let _ = configure(ctx, &existing.path, &pr, &branch).await;
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
            if !exists {
                let target = match configure(ctx, cwd, &pr, &branch).await {
                    Ok(sha) => sha,
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
            let _ = configure(ctx, &worktree.path, &pr, &branch).await;
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
