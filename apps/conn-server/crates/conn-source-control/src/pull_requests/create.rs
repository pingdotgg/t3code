//! `GitManager.createPullRequest` on GitHub: open a pull request from the checkout's pushed
//! branch, or return the one already open (`openPrFromBranch` with the caller's title and
//! body), then make it a draft when asked.
//!
//! The order of the steps, and every request to GitHub, follow T3: read the branch (after the
//! upstream fetch T3's status read makes), work out where its head lives
//! (`resolveBranchHeadContext`), look for an open pull request on each head selector, refuse
//! unpushed commits, pick the base (`resolvePrBase`), `POST repos/{o}/{n}/pulls`, and look the
//! new pull request up again. `create-cases.json` holds T3's recorded runs; the test replays
//! them.

use std::path::Path;

use conn_vcs::process::GitCommand;
use serde_json::{Value, json};

use super::{Client, Error, normalize};
use crate::{
    hosts::{
        DiscoveryContext,
        github_graphql::generated,
        repositories::{self, Locator},
    },
    http::Method,
};

/// What `pull_request_create` asks for.
#[derive(Clone, Debug)]
pub struct CreateRequest<'a> {
    pub title: &'a str,
    pub body: &'a str,
    pub base: Option<&'a str>,
    pub draft: bool,
}

/// `GitManagerError` or `SourceControlProviderError`, as T3 words them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CreateError {
    Manager {
        operation: &'static str,
        detail: String,
    },
    Provider {
        operation: &'static str,
        detail: String,
    },
}

impl CreateError {
    fn manager(operation: &'static str, detail: impl Into<String>) -> Self {
        Self::Manager {
            operation,
            detail: detail.into(),
        }
    }

    fn provider(operation: &'static str, error: &Error) -> Self {
        Self::Provider {
            operation,
            detail: error.to_string(),
        }
    }

    /// The error's `message`, which `pull_request_create` shows.
    pub fn message(&self) -> String {
        match self {
            Self::Manager { operation, detail } => {
                format!("Git manager failed in {operation}: {detail}")
            }
            Self::Provider { operation, detail } => {
                format!("Source control provider github failed in {operation}: {detail}")
            }
        }
    }
}

/// The pull request `PullRequestService` makes a draft: its host, repository and number.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DraftTarget {
    pub host: String,
    pub repository: String,
    pub number: u64,
    pub url: String,
}

/// The two `PullRequestService` calls a draft needs. The error is the failure's message.
pub trait Drafts {
    /// `summary` with `allowStale: false`: whether the pull request is a draft now.
    fn is_draft(&self, target: &DraftTarget) -> impl Future<Output = Result<bool, String>>;
    /// `runAction` with `action: "draft"`.
    fn make_draft(&self, target: &DraftTarget) -> impl Future<Output = Result<(), String>>;
}

/// `createPullRequest`: the result T3 returns (`status`, and the pull request when GitHub lists
/// it), or its error.
pub async fn create_pull_request(
    ctx: DiscoveryContext<'_>,
    request: &CreateRequest<'_>,
    drafts: &impl Drafts,
) -> Result<Value, CreateError> {
    let result = Box::pin(open_from_branch(ctx, request)).await?;
    if request.draft && !draft_opened(&result, drafts).await? {
        // A retry finds the open pull request and makes it a draft then.
        return Err(CreateError::manager(
            "createPullRequest",
            "Opened the pull request, but the host does not list it yet to make it a draft.",
        ));
    }
    Ok(result)
}

/// `draftOpened`: false when the result names no pull request.
async fn draft_opened(result: &Value, drafts: &impl Drafts) -> Result<bool, CreateError> {
    let Some(target) = result["url"].as_str().and_then(draft_target) else {
        return Ok(false);
    };
    let failed = |message: String| {
        CreateError::manager(
            "createPullRequest",
            format!("Opened the pull request, but could not make it a draft: {message}"),
        )
    };
    let is_draft =
        result["status"] == "opened_existing" && drafts.is_draft(&target).await.map_err(failed)?;
    if !is_draft {
        drafts.make_draft(&target).await.map_err(failed)?;
    }
    Ok(true)
}

/// `createdPullRequestKey`: the pull request a GitHub URL names.
fn draft_target(url: &str) -> Option<DraftTarget> {
    let parsed = url::Url::parse(url).ok()?;
    let host = match parsed.port() {
        Some(port) => format!("{}:{port}", parsed.host_str()?.to_lowercase()),
        None => parsed.host_str()?.to_lowercase(),
    };
    let mut parts = parsed.path_segments()?;
    let (owner, name, kind, number) = (parts.next()?, parts.next()?, parts.next()?, parts.next()?);
    let number: u64 = number.parse().ok().filter(|n| *n > 0)?;
    (kind == "pull" && !owner.is_empty() && !name.is_empty()).then(|| DraftTarget {
        host,
        repository: format!("{owner}/{name}"),
        number,
        url: url.to_owned(),
    })
}

/// The branch as T3's `statusDetails` reads it.
struct BranchDetails {
    branch: Option<String>,
    upstream_ref: Option<String>,
    ahead_count: u64,
}

/// `statusDetails`: the upstream fetch (failures ignored), then `git status --porcelain=2`.
async fn branch_details(cwd: &Path) -> Result<BranchDetails, CreateError> {
    let _ = conn_vcs::status::fetch_upstream_remote(cwd).await;
    let output = GitCommand::new(
        "GitVcsDriver.statusDetailsLocal.status",
        cwd,
        ["status", "--porcelain=2", "--branch", "-z"],
    )
    .max_stdout(16 * 1024 * 1024, conn_vcs::process::OnLimit::Fail)
    .run()
    .await
    .map_err(|_| CreateError::manager("statusDetails", "Failed to read git status."))?;
    let mut details = BranchDetails {
        branch: None,
        upstream_ref: None,
        ahead_count: 0,
    };
    let (mut upstream_exists, mut unborn) = (false, false);
    let text = output.stdout_text();
    let mut records = text.split('\0');
    while let Some(record) = records.next() {
        if record.starts_with("2 ") {
            // A rename's original path is the next record; it is a path, not a header.
            records.next();
        } else if record == "# branch.oid (initial)" {
            unborn = true;
        } else if let Some(head) = record.strip_prefix("# branch.head ") {
            let head = head.trim();
            details.branch = (!matches!(head, "(detached)" | "(unknown)")).then(|| head.to_owned());
        } else if let Some(upstream) = record.strip_prefix("# branch.upstream ") {
            let upstream = upstream.trim();
            details.upstream_ref = (!upstream.is_empty()).then(|| upstream.to_owned());
        } else if let Some(ab) = record.strip_prefix("# branch.ab ") {
            upstream_exists = true;
            details.ahead_count = ab
                .split_whitespace()
                .next()
                .and_then(|ahead| ahead.strip_prefix('+'))
                .and_then(|ahead| ahead.parse().ok())
                .unwrap_or(0);
        }
    }
    if !upstream_exists && !unborn {
        details.upstream_ref = None;
    }
    Ok(details)
}

/// Where a branch's pull request head lives (`BranchHeadContext`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct HeadContext {
    head_branch: String,
    head_selectors: Vec<String>,
    preferred_head_selector: String,
    head_repository: Option<String>,
    head_owner: Option<String>,
    cross_repository: bool,
}

/// `resolveRemoteRepositoryContext`.
#[derive(Clone, Debug, Default)]
struct RemoteRepository {
    url: Option<String>,
    url_key: Option<String>,
    repository: Option<String>,
    owner: Option<String>,
}

async fn config(cwd: &Path, key: &str) -> Option<String> {
    conn_vcs::repo::config_get(cwd, key).await.ok().flatten()
}

/// `readRemoteUrl`: the first `remote.<name>.url`.
async fn remote_url(cwd: &Path, remote: &str) -> Option<String> {
    let output = GitCommand::new(
        "GitManager.readRemoteUrl",
        cwd,
        [
            "config".to_owned(),
            "--get-all".into(),
            format!("remote.{remote}.url"),
        ],
    )
    .allow_exit(&[0, 1])
    .run()
    .await
    .ok()?;
    let text = output.stdout_text();
    let first = text.split('\n').next().unwrap_or_default().trim();
    (!first.is_empty()).then(|| first.to_owned())
}

async fn remote_repository(cwd: &Path, remote: Option<&str>) -> RemoteRepository {
    let Some(remote) = remote else {
        return RemoteRepository::default();
    };
    let url = remote_url(cwd, remote).await;
    let repository = url.as_deref().and_then(repository_path_from_remote_url);
    RemoteRepository {
        url_key: url
            .as_deref()
            .map(crate::remote::repository_key_from_remote),
        owner: repository.as_deref().and_then(owner_of),
        url,
        repository,
    }
}

/// `parseRepositoryOwnerLogin`: the path's first segment.
fn owner_of(repository: &str) -> Option<String> {
    let owner = repository
        .trim()
        .split('/')
        .next()
        .unwrap_or_default()
        .trim();
    (!owner.is_empty()).then(|| owner.to_owned())
}

/// `repositoryPathFromRemoteUrl`: the path of `user@host:path`, `host:path` or
/// `scheme://host/path`, without `.git`, when it has two or more segments.
fn repository_path_from_remote_url(url: &str) -> Option<String> {
    let remote = url.trim();
    let lower = remote.to_lowercase();
    let schemes = ["ssh://", "http://", "https://", "git://"];
    let scheme = schemes.iter().find(|s| lower.starts_with(**s));
    let trimmed = match scheme {
        Some(_) => remote.split(['?', '#']).next().unwrap_or_default(),
        None => remote,
    };
    if trimmed.is_empty() {
        return None;
    }
    let bad_host = |c: char| c == '/' || c.is_whitespace();
    let mut rests = Vec::new();
    // `[^@/\s]+@[^:/\s]+:`
    if let Some((user, rest)) = trimmed.split_once('@')
        && !user.is_empty()
        && !user.chars().any(bad_host)
        && let Some((host, path)) = rest.split_once(':')
        && !host.is_empty()
        && !host.chars().any(bad_host)
    {
        rests.push(path);
    }
    // `[^@:/\\\s]{2,}:(?!:)`
    if let Some((host, path)) = trimmed.split_once(':')
        && host.chars().count() >= 2
        && !host
            .chars()
            .any(|c| matches!(c, '@' | '/' | '\\') || c.is_whitespace())
        && !path.starts_with(':')
    {
        rests.push(path);
    }
    // `(?:ssh|https?|git):\/\/[^/]+\/`
    if let Some(scheme) = scheme
        && let Some(after) = trimmed.get(scheme.len()..)
        && let Some((host, path)) = after.split_once('/')
        && !host.is_empty()
    {
        rests.push(path);
    }
    rests.into_iter().find_map(|rest| {
        let rest = rest.strip_suffix('/').unwrap_or(rest);
        let segments: Vec<&str> = rest.split('/').collect();
        let valid = segments.len() >= 2
            && segments
                .iter()
                .all(|s| !s.is_empty() && !s.chars().any(char::is_whitespace));
        if !valid {
            return None;
        }
        let path = match rest.len().checked_sub(4).and_then(|i| rest.get(i..)) {
            Some(tail)
                if tail.eq_ignore_ascii_case(".git")
                    && segments.last().is_some_and(|last| last.len() > 4) =>
            {
                rest.get(..rest.len() - 4).unwrap_or(rest)
            }
            _ => rest,
        };
        let path = path.trim();
        (!path.is_empty()).then(|| path.to_owned())
    })
}

/// `extractBranchNameFromRemoteRef` with the branch's remote.
fn branch_from_remote_ref(reference: &str, remote: Option<&str>) -> String {
    let normalized = reference.trim();
    if normalized.is_empty() {
        return String::new();
    }
    if let Some(rest) = normalized.strip_prefix("refs/remotes/") {
        return branch_from_remote_ref(rest, remote);
    }
    if let Some(remote) = remote
        && let Some(branch) = normalized.strip_prefix(&format!("{remote}/"))
    {
        let branch = branch.trim();
        if !branch.is_empty() {
            return branch.to_owned();
        }
    }
    match normalized.split_once('/') {
        Some((_, rest)) => rest.trim().to_owned(),
        None => normalized.to_owned(),
    }
}

/// `targetsRemote`: whether `gh` creates pull requests in this remote's repository. A remote
/// that is not on a GitHub host always counts.
async fn targets_remote(ctx: DiscoveryContext<'_>, remote: &RemoteRepository) -> bool {
    let Some(host) = remote
        .url
        .as_deref()
        .and_then(repositories::api_host_for_remote)
    else {
        return true;
    };
    let target = remote.repository.as_deref().map(str::to_lowercase);
    if let Some(selector) = ctx.env.get("GH_REPO")
        && let Some(locator) = repositories::parse_selector(&selector, &host)
    {
        return locator.host == host
            && Some(format!("{}/{}", locator.owner, locator.name).to_lowercase()) == target;
    }
    let (remotes, resolved) = repositories::read_remotes(ctx).await;
    match repositories::resolve_github_repository(&remotes, &resolved, Some(&host), &host).1 {
        None => true,
        Some(locator) => {
            Some(format!("{}/{}", locator.owner, locator.name).to_lowercase()) == target
        }
    }
}

/// `appendUnique`.
fn append_unique(values: &mut Vec<String>, next: Option<&str>) {
    let Some(trimmed) = next.map(str::trim).filter(|t| !t.is_empty()) else {
        return;
    };
    if !values.iter().any(|v| v == trimmed) {
        values.push(trimmed.to_owned());
    }
}

/// `resolveBranchHeadContext` for a branch and its upstream.
async fn head_context(
    ctx: DiscoveryContext<'_>,
    branch: &str,
    upstream_ref: Option<&str>,
) -> HeadContext {
    let cwd = ctx.cwd;
    let branch_remote = config(cwd, &format!("branch.{branch}.remote")).await;
    let remote_name = branch_remote.clone().filter(|r| r != ".");
    let from_upstream = match upstream_ref {
        Some(upstream) if branch_remote.as_deref() != Some(".") => {
            branch_from_remote_ref(upstream, remote_name.as_deref())
        }
        _ => String::new(),
    };
    let head_branch = if from_upstream.is_empty() {
        branch.to_owned()
    } else {
        from_upstream.clone()
    };
    let probe_local = from_upstream.is_empty() || head_branch == branch;
    let (remote, origin) = if remote_name.as_deref() == Some("origin") {
        let origin = remote_repository(cwd, Some("origin")).await;
        (origin.clone(), origin)
    } else {
        (
            remote_repository(cwd, remote_name.as_deref()).await,
            remote_repository(cwd, Some("origin")).await,
        )
    };
    let named_other = remote_name.as_deref().is_some_and(|r| r != "origin");
    let only_remote = named_other
        && origin.url_key.is_none()
        && conn_vcs::repo::remote_names(cwd)
            .await
            .map_or(0, |names| names.len())
            == 1
        && targets_remote(ctx, &remote).await;
    let foreign = named_other && !only_remote;
    let cross_repository = match (&remote.repository, &origin.repository) {
        (Some(head), Some(origin)) => !head.eq_ignore_ascii_case(origin),
        _ => foreign && remote.repository.is_some(),
    } || (remote_name.is_some()
        && !only_remote
        && remote.repository.is_some()
        && !targets_remote(ctx, &remote).await);
    let owner_selector = remote
        .owner
        .as_ref()
        .filter(|_| !head_branch.is_empty())
        .map(|owner| format!("{owner}:{head_branch}"));
    let alias_selector = remote_name
        .as_ref()
        .filter(|_| !head_branch.is_empty())
        .map(|remote| format!("{remote}:{head_branch}"));
    let remote_owned = cross_repository || foreign;
    let distinct_alias = alias_selector
        .as_deref()
        .filter(|a| Some(*a) != owner_selector.as_deref());
    let mut selectors = Vec::new();
    if cross_repository && remote_owned {
        append_unique(&mut selectors, owner_selector.as_deref());
        append_unique(&mut selectors, distinct_alias);
    }
    if probe_local {
        append_unique(&mut selectors, Some(branch));
    }
    append_unique(
        &mut selectors,
        (head_branch != branch).then_some(head_branch.as_str()),
    );
    if !cross_repository && remote_owned {
        append_unique(&mut selectors, owner_selector.as_deref());
        append_unique(&mut selectors, distinct_alias);
    }
    HeadContext {
        preferred_head_selector: match &owner_selector {
            Some(owner) if cross_repository => owner.clone(),
            _ => head_branch.clone(),
        },
        head_branch,
        head_selectors: selectors,
        head_repository: remote.repository,
        head_owner: remote.owner,
        cross_repository,
    }
}

/// `matchesBranchHeadContext` on a normalized node.
fn matches_head(node: &Value, head: &HeadContext) -> bool {
    if normalize::text(node, "headRefName").trim() != head.head_branch {
        return false;
    }
    let lower = |value: Option<&str>| {
        value
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_lowercase)
    };
    let expected_repository = lower(head.head_repository.as_deref());
    let expected_owner = lower(head.head_owner.as_deref())
        .or_else(|| expected_repository.as_deref().and_then(owner_of));
    let pr_repository = lower(
        node.pointer("/headRepository/nameWithOwner")
            .and_then(Value::as_str),
    );
    let pr_owner = lower(
        node.pointer("/headRepositoryOwner/login")
            .and_then(Value::as_str),
    )
    .or_else(|| pr_repository.as_deref().and_then(owner_of));
    if let Some(expected) = &expected_repository
        && let Some(actual) = &pr_repository
        && expected != actual
    {
        return false;
    }
    if let (Some(expected), Some(actual)) = (&expected_owner, &pr_owner)
        && expected != actual
    {
        return false;
    }
    let pr_cross = node.get("isCrossRepository").and_then(Value::as_bool);
    let expected_known = expected_repository.is_some() || expected_owner.is_some();
    let pr_known = pr_repository.is_some() || pr_owner.is_some();
    if head.cross_repository {
        return pr_cross != Some(false) && !(expected_known && !pr_known);
    }
    !(pr_cross == Some(true) && (!expected_known || !pr_known))
}

/// `toPullRequestRecord`'s filter: a node with a number, a title, a URL, both branches and a
/// time.
fn usable(node: &Value) -> bool {
    let present = |key: &str| !normalize::text(node, key).trim().is_empty();
    node.get("number")
        .and_then(Value::as_i64)
        .is_some_and(|n| n >= 1)
        && ["title", "url", "baseRefName", "headRefName", "updatedAt"]
            .iter()
            .all(|key| present(key))
}

/// The steps that talk to GitHub, with the repository read once per call as T3 reads it.
struct GitHub<'a> {
    ctx: DiscoveryContext<'a>,
}

impl GitHub<'_> {
    async fn connect(&self, operation: &'static str) -> Result<(Client, Locator), CreateError> {
        // The provider resolves with its detected remote's host as the hint, so `GH_REPO`
        // names a repository on the checkout's own host.
        let hint = match conn_vcs::repo::primary_remote(self.ctx.cwd).await {
            Ok(Some(remote)) => remote_url(self.ctx.cwd, &remote)
                .await
                .as_deref()
                .and_then(repositories::api_host_for_remote),
            _ => None,
        };
        let locator = repositories::resolve_repository_on(self.ctx, hint.as_deref())
            .await
            .map_err(|e| CreateError::provider(operation, &Error::Failed(e.detail)))?;
        let client = Client::connect(self.ctx, &locator.host)
            .await
            .map_err(|e| CreateError::provider(operation, &e))?;
        Ok((client, locator))
    }

    /// `listChangeRequests` for open pull requests on one head (GitHub's limit 100).
    async fn open_on_head(&self, selector: &str) -> Result<Vec<Value>, CreateError> {
        const OPERATION: &str = "listChangeRequests";
        let (client, locator) = self.connect(OPERATION).await?;
        let failed = |e: Error| CreateError::provider(OPERATION, &e);
        let query = generated::PULL_REQUESTS_BY_HEAD
            .render_slices(1)
            .map_err(|_| {
                failed(Error::Failed(
                    "Could not build GitHub's head lookup.".into(),
                ))
            })?;
        let head = selector.trim();
        let body = json!({"operationName": "PullRequestsByHead", "query": query, "variables": {
            "_0_owner": locator.owner, "_0_name": locator.name, "_0_head": head,
            "_0_states": ["OPEN"], "_0_first": 100,
        }});
        let response = client
            .request(
                Method::Post,
                client.graphql_path(),
                Some(body),
                "application/vnd.github+json",
                16_000_000,
            )
            .await
            .map_err(failed)?;
        let raw: Value = serde_json::from_slice(&response.body).map_err(|_| {
            failed(Error::Failed(
                "GitHub returned an invalid change request list.".into(),
            ))
        })?;
        let repository = raw
            .pointer("/data/_0_repository")
            .filter(|r| !r.is_null())
            .ok_or_else(|| failed(Error::NotFound("The repository could not be read.".into())))?;
        Ok(normalize::nodes(&repository["pullRequests"])
            .iter()
            .filter(|node| usable(node))
            .cloned()
            .collect())
    }

    /// `findOpenPr`: the first open pull request on the head's selectors (without an owner,
    /// as `headBranchProbe` filters them) that is the branch's.
    async fn find_open(&self, head: &HeadContext) -> Result<Option<Value>, CreateError> {
        for selector in head.head_selectors.iter().filter(|s| !s.contains(':')) {
            let found = self
                .open_on_head(selector)
                .await?
                .into_iter()
                .find(|node| matches_head(node, head));
            if found.is_some() {
                return Ok(found);
            }
        }
        Ok(None)
    }

    /// `getDefaultBranch`: the repository's default branch; any failure is `None`.
    async fn default_branch(&self) -> Option<String> {
        let (client, locator) = self.connect("getDefaultBranch").await.ok()?;
        let repository = client
            .rest(&format!("repos/{}/{}", locator.owner, locator.name))
            .await
            .ok()?;
        let branch = normalize::text(&repository, "default_branch").trim();
        (!branch.is_empty()).then(|| branch.to_owned())
    }

    /// `createChangeRequest`.
    async fn create(
        &self,
        base: &str,
        head_selector: &str,
        title: &str,
        body: &str,
    ) -> Result<(), CreateError> {
        const OPERATION: &str = "createChangeRequest";
        let (client, locator) = self.connect(OPERATION).await?;
        let path = format!(
            "repos/{}/{}/pulls",
            encode_component(&locator.owner),
            encode_component(&locator.name)
        );
        client
            .request(
                Method::Post,
                &path,
                Some(
                    json!({"base": base, "head": head_selector, "title": title, "body": body,
                    "maintainer_can_modify": true}),
                ),
                "application/vnd.github+json",
                8 * 1024 * 1024,
            )
            .await
            .map(|_| ())
            .map_err(|e| CreateError::provider(OPERATION, &e))
    }
}

/// `encodeURIComponent` for an owner or repository name.
fn encode_component(text: &str) -> String {
    text.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

/// `resolveBranchBase(...).branchName`: the branch a ref names, local or remote-tracking.
async fn branch_name(cwd: &Path, reference: &str) -> Option<String> {
    let output = GitCommand::new(
        "GitVcsDriver.resolveBranchName.resolveRef",
        cwd,
        [
            "rev-parse",
            "--symbolic-full-name",
            "--verify",
            "--end-of-options",
            reference,
        ],
    )
    .allow_exit(&[0, 1, 128])
    .run()
    .await
    .ok()?;
    if output.code != 0 {
        let remote = conn_vcs::repo::primary_remote(cwd).await.ok().flatten()?;
        let exists = GitCommand::new(
            "GitVcsDriver.remoteBranchExists",
            cwd,
            [
                "show-ref".to_owned(),
                "--verify".into(),
                "--quiet".into(),
                format!("refs/remotes/{remote}/{reference}"),
            ],
        )
        .allow_exit(&[0, 1, 128])
        .run()
        .await
        .is_ok_and(|o| o.code == 0);
        return exists.then(|| reference.to_owned());
    }
    let full = output.stdout_text().trim().to_owned();
    if let Some(branch) = full.strip_prefix("refs/heads/") {
        return Some(branch.to_owned());
    }
    let rest = full.strip_prefix("refs/remotes/")?;
    let mut names = conn_vcs::repo::remote_names(cwd).await.ok()?;
    names.sort_by_key(|name| std::cmp::Reverse(name.len()));
    names.iter().find_map(|name| {
        let branch = rest.strip_prefix(&format!("{name}/"))?.trim();
        (!branch.is_empty()).then(|| branch.to_owned())
    })
}

/// `resolvePrBase`: the base branch, and the ref it was read from.
async fn pr_base(
    github: &GitHub<'_>,
    branch: &str,
    upstream_ref: Option<&str>,
    head: &HeadContext,
    remote_name: Option<&str>,
) -> String {
    let cwd = github.ctx.cwd;
    if let Some(configured) = config(cwd, &format!("branch.{branch}.t3-merge-base-ref")).await
        && (configured.starts_with("refs/heads/") || configured.starts_with("refs/remotes/"))
        && let Some(base) = branch_name(cwd, &configured).await
    {
        return base;
    }
    let configured = match config(cwd, &format!("branch.{branch}.t3-merge-base")).await {
        Some(base) => Some(base),
        None => config(cwd, &format!("branch.{branch}.gh-merge-base")).await,
    };
    if let Some(configured) = configured {
        let local = if configured.starts_with("refs/") {
            configured.clone()
        } else {
            format!("refs/heads/{configured}")
        };
        if let Some(base) = branch_name(cwd, &local).await {
            return base;
        }
        if configured.contains('/')
            && !configured.starts_with("refs/")
            && let Some(base) = branch_name(cwd, &format!("refs/remotes/{configured}")).await
        {
            return base;
        }
        if let Some(base) = branch_name(cwd, &configured).await {
            return base;
        }
    }
    if let Some(upstream) = upstream_ref
        && !head.cross_repository
    {
        let upstream_branch = branch_from_remote_ref(upstream, remote_name);
        if !upstream_branch.is_empty() && upstream_branch != branch {
            return upstream_branch;
        }
    }
    if let Some(default) = github.default_branch().await {
        return default;
    }
    if let Ok(Some(remote)) = conn_vcs::repo::primary_remote(cwd).await
        && let Some(default) = remote_default_branch(cwd, &remote).await
    {
        return default;
    }
    "main".to_owned()
}

/// `resolveDefaultBranchName`: `refs/remotes/<remote>/HEAD`, which fails when the branch it
/// points at is gone.
async fn remote_default_branch(cwd: &Path, remote: &str) -> Option<String> {
    let output = GitCommand::new(
        "GitVcsDriver.resolveDefaultBranchName",
        cwd,
        [
            "rev-parse".to_owned(),
            "--verify".into(),
            "--quiet".into(),
            "--symbolic-full-name".into(),
            format!("refs/remotes/{remote}/HEAD"),
        ],
    )
    .allow_exit(&[0, 1, 128])
    .run()
    .await
    .ok()?;
    if output.code != 0 {
        return None;
    }
    let text = output.stdout_text();
    let branch = text
        .trim()
        .strip_prefix(&format!("refs/remotes/{remote}/"))?
        .trim();
    (!branch.is_empty() && branch != "HEAD").then(|| branch.to_owned())
}

/// The result for a pull request GitHub lists.
fn listed(status: &str, node: &Value) -> Value {
    json!({
        "status": status,
        "url": node["url"],
        "number": node["number"],
        "baseBranch": normalize::text(node, "baseRefName").trim(),
        "headBranch": normalize::text(node, "headRefName").trim(),
        "title": normalize::text(node, "title").trim(),
    })
}

/// `openPrFromBranch` with the caller's title and body.
async fn open_from_branch(
    ctx: DiscoveryContext<'_>,
    request: &CreateRequest<'_>,
) -> Result<Value, CreateError> {
    const STEP: &str = "runPrStep";
    let cwd = ctx.cwd;
    let details = branch_details(cwd).await?;
    let Some(branch) = details.branch else {
        return Err(CreateError::manager(
            STEP,
            "Cannot create a pull request from detached HEAD.",
        ));
    };
    let Some(upstream_ref) = details.upstream_ref else {
        return Err(CreateError::manager(
            STEP,
            "Current branch has not been pushed. Push before creating a PR.",
        ));
    };
    let head = head_context(ctx, &branch, Some(&upstream_ref)).await;
    let github = GitHub { ctx };
    if let Some(existing) = github.find_open(&head).await? {
        return Ok(listed("opened_existing", &existing));
    }
    // A pull request opened from the remote branch would leave out commits not pushed yet.
    if details.ahead_count > 0 {
        let plural = if details.ahead_count == 1 { "" } else { "s" };
        return Err(CreateError::manager(
            STEP,
            format!(
                "The branch has {} unpushed commit{plural}. Push before opening the PR.",
                details.ahead_count
            ),
        ));
    }
    let remote_name = config(cwd, &format!("branch.{branch}.remote"))
        .await
        .filter(|r| r != ".");
    let resolved = pr_base(
        &github,
        &branch,
        Some(&upstream_ref),
        &head,
        remote_name.as_deref(),
    )
    .await;
    let base = request.base.map_or(resolved, str::to_owned);
    github
        .create(
            &base,
            &head.preferred_head_selector,
            request.title,
            request.body,
        )
        .await?;
    // The pull request exists now, so a failed lookup only loses its details.
    match github.find_open(&head).await {
        Ok(Some(created)) => Ok(listed("created", &created)),
        _ => Ok(json!({
            "status": "created",
            "baseBranch": base,
            "headBranch": head.head_branch,
            "title": request.title,
        })),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repository_paths_follow_t3s_pattern() {
        for (url, expected) in [
            ("https://github.com/acme/web.git", Some("acme/web")),
            ("https://github.com/acme/web/", Some("acme/web")),
            ("git@github.com:acme/web.git", Some("acme/web")),
            ("github:acme/web", Some("acme/web")),
            (
                "ssh://git@host:22/group/sub/repo.git",
                Some("group/sub/repo"),
            ),
            ("https://github.com/acme", None),
            ("https://github.com/acme/web?x=1", Some("acme/web")),
            ("", None),
        ] {
            assert_eq!(
                repository_path_from_remote_url(url).as_deref(),
                expected,
                "{url}"
            );
        }
    }

    #[test]
    fn remote_refs_lose_their_remote() {
        assert_eq!(
            branch_from_remote_ref("origin/feature/x", Some("origin")),
            "feature/x"
        );
        assert_eq!(
            branch_from_remote_ref("refs/remotes/my/fork/x", Some("my/fork")),
            "x"
        );
        assert_eq!(branch_from_remote_ref("main", None), "main");
    }

    #[test]
    fn draft_targets_come_from_pull_request_urls() {
        assert_eq!(
            draft_target("https://github.com/acme/web/pull/7"),
            Some(DraftTarget {
                host: "github.com".into(),
                repository: "acme/web".into(),
                number: 7,
                url: "https://github.com/acme/web/pull/7".into(),
            })
        );
        assert_eq!(draft_target("https://github.com/acme/web/issues/7"), None);
        assert_eq!(
            draft_target("https://github.example.com:8443/acme/web/pull/7").map(|t| t.host),
            Some("github.example.com:8443".into())
        );
    }

    #[tokio::test]
    async fn a_renamed_path_is_not_read_as_a_branch_header() {
        let dir =
            std::env::temp_dir().join(format!("conn-pr-create-rename-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("dir");
        let git = |args: &[&str]| {
            let status = std::process::Command::new("git")
                .args(args)
                .current_dir(&dir)
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .stdout(std::process::Stdio::null())
                .status()
                .expect("git");
            assert!(status.success(), "git {args:?}");
        };
        git(&["init", "-q", "-b", "main"]);
        git(&["config", "user.name", "Fixture"]);
        git(&["config", "user.email", "fixture@example.com"]);
        git(&["config", "protocol.allow", "never"]);
        std::fs::write(dir.join("# branch.ab +0 -0"), "x\n").expect("write");
        git(&["add", "-A"]);
        git(&["commit", "-q", "-m", "one"]);
        git(&["remote", "add", "origin", "https://github.com/acme/web.git"]);
        git(&["update-ref", "refs/remotes/origin/main", "HEAD"]);
        git(&["config", "branch.main.remote", "origin"]);
        git(&["config", "branch.main.merge", "refs/heads/main"]);
        git(&["commit", "-q", "--allow-empty", "-m", "unpushed"]);
        git(&["mv", "# branch.ab +0 -0", "renamed"]);
        let details = branch_details(&dir).await.expect("status");
        assert_eq!(details.ahead_count, 1);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
