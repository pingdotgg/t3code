//! Local status, remote status and branch status of one checkout.
//!
//! Follows `readStatusDetailsLocal` / `readStatusDetailsRemote` in `GitVcsDriverCore.ts`.
//! Differences: no pull request lookup (`pr` is always null; that needs a forge CLI), and no
//! caches: the [`crate::hub::VcsHub`] keeps the last result per subscribed folder.

use std::{collections::BTreeMap, path::Path, time::Duration};

use conn_contract::{
    VcsBranchStatus, VcsStatusLocalResult, VcsStatusLocalResultWorkingTree,
    VcsStatusLocalResultWorkingTreeFilesItem, VcsStatusRemoteResult, VcsStatusResult,
    VcsStatusResultBranchChanges,
};

use crate::{
    error::{VcsError, VcsResult},
    process::{OnLimit, ProcessError},
    repo::{self, git},
    review::{self, METADATA_MAX_BYTES, UNTRACKED_TOTALS_MAX_BYTES},
};

/// How long a background fetch may run before status gives up on it.
pub const FETCH_TIMEOUT: Duration = Duration::from_secs(60);

pub fn non_repo_local() -> VcsStatusLocalResult {
    VcsStatusLocalResult {
        is_repo: false,
        source_control_provider: None,
        has_primary_remote: false,
        is_default_ref: false,
        ref_name: None,
        has_working_tree_changes: false,
        working_tree: VcsStatusLocalResultWorkingTree {
            root_path: None,
            files: Vec::new(),
            insertions: 0,
            deletions: 0,
        },
        branch_changes: None,
    }
}

fn is_non_repo_stderr(stderr: &str) -> bool {
    let s = stderr.to_ascii_lowercase();
    s.contains("not a git repository") || s.contains("cannot use bare repository")
}

fn is_unborn_stderr(stderr: &str) -> bool {
    let s = stderr.to_ascii_lowercase();
    s.contains("bad revision 'head'")
        || (s.contains("unknown revision") && s.contains("path not in the working tree"))
        || s.contains("ambiguous argument 'head'")
}

struct PorcelainStatus {
    ref_name: Option<String>,
    changed: bool,
    paths: Vec<String>,
}

/// Parses `git status --porcelain=2 --branch -z`.
fn parse_porcelain(output: &str) -> PorcelainStatus {
    let mut status = PorcelainStatus {
        ref_name: None,
        changed: false,
        paths: Vec::new(),
    };
    let mut records = output.split('\0');
    while let Some(record) = records.next() {
        if record.is_empty() {
            continue;
        }
        if let Some(head) = record.strip_prefix("# branch.head ") {
            status.ref_name = (head != "(detached)").then(|| head.to_owned());
            continue;
        }
        if record.starts_with('#') {
            continue;
        }
        status.changed = true;
        let skip = match record.as_bytes().first() {
            Some(b'1') => 8,
            Some(b'2') => 9,
            Some(b'u') => 10,
            _ => 1,
        };
        let path = record.splitn(skip + 1, ' ').nth(skip).unwrap_or_default();
        if !path.is_empty() {
            status.paths.push(path.to_owned());
        }
        if record.starts_with("2 ")
            && let Some(original) = records.next()
            && !original.is_empty()
        {
            status.paths.push(original.to_owned());
        }
    }
    status
}

pub async fn local_status(cwd: &Path) -> VcsResult<VcsStatusLocalResult> {
    Box::pin(local_status_inner(cwd)).await
}

async fn local_status_inner(cwd: &Path) -> VcsResult<VcsStatusLocalResult> {
    if !cwd.is_dir() {
        return Ok(non_repo_local());
    }
    if let Ok(out) = git(
        "GitVcsDriver.statusDetails.indexPath",
        cwd,
        ["rev-parse", "--git-path", "index"],
    )
    .run()
    .await
    {
        let index = cwd.join(out.stdout_text().trim());
        let mut lock = index.into_os_string();
        lock.push(".lock");
        if Path::new(&lock).exists() {
            return Err(VcsError::invalid(
                "GitVcsDriver.statusDetails.indexPath",
                &cwd.to_string_lossy(),
                "Git index is locked. Status will resume when the index lock is removed.",
            ));
        }
    }

    let status = git(
        "GitVcsDriver.statusDetails.status",
        cwd,
        [
            "status",
            "--porcelain=2",
            "--branch",
            "-z",
            "--no-ahead-behind",
        ],
    )
    .max_stdout(METADATA_MAX_BYTES, OnLimit::Fail)
    .run();
    let numstat = git(
        "GitVcsDriver.statusDetails.numstat",
        cwd,
        ["diff-index", "-M", "--numstat", "-z", "HEAD", "--"],
    )
    .max_stdout(METADATA_MAX_BYTES, OnLimit::Fail)
    .run();
    // The remotes are read once and shared by the default branch and the Changes base.
    let (status, numstat, root, remotes) = tokio::join!(
        status,
        numstat,
        repo::toplevel(cwd),
        repo::Remotes::load(cwd)
    );
    let status = match status {
        Ok(out) => parse_porcelain(&out.stdout_text()),
        Err(ProcessError::Exit { stderr, .. }) if is_non_repo_stderr(&stderr) => {
            return Ok(non_repo_local());
        }
        Err(e) => return Err(e.into()),
    };
    let numstat = match numstat {
        Ok(out) => review::parse_numstat(&out.stdout_text()),
        // No commit yet: one net diff against the empty tree, as T3 does. Staged and unstaged
        // diffs summed would count a line replaced before the first commit twice.
        Err(ProcessError::Exit { stderr, .. }) if is_unborn_stderr(&stderr) => {
            let empty = repo::empty_tree(cwd).await?;
            let net = git(
                "GitVcsDriver.statusDetails.numstat",
                cwd,
                ["diff-index", "-M", "--numstat", "-z", empty.as_str(), "--"],
            )
            .max_stdout(METADATA_MAX_BYTES, OnLimit::Fail)
            .text()
            .await?;
            review::parse_numstat(&net)
        }
        Err(e) => return Err(e.into()),
    };

    let mut by_path: BTreeMap<String, (i64, i64)> = BTreeMap::new();
    let (mut insertions, mut deletions) = (0i64, 0i64);
    for file in &numstat {
        let entry = by_path.entry(file.path.clone()).or_default();
        entry.0 += file.additions as i64;
        entry.1 += file.deletions as i64;
        insertions += file.additions as i64;
        deletions += file.deletions as i64;
    }
    for path in &status.paths {
        by_path.entry(path.clone()).or_default();
    }
    let mut files: Vec<VcsStatusLocalResultWorkingTreeFilesItem> = by_path
        .into_iter()
        .map(
            |(path, (ins, del))| VcsStatusLocalResultWorkingTreeFilesItem {
                path,
                insertions: ins,
                deletions: del,
            },
        )
        .collect();
    files.sort_by_key(|f| f.path.to_lowercase());

    let default_branch = match &remotes {
        Ok(remotes) => repo::default_branch_with(cwd, remotes)
            .await
            .unwrap_or(None),
        Err(_) => None,
    };
    let is_default_ref = match (&status.ref_name, &default_branch) {
        (Some(name), Some(default)) => name == default,
        (Some(name), None) => name == "main" || name == "master",
        (None, _) => false,
    };
    let root = root.unwrap_or(None);
    let branch_changes = Box::pin(branch_changes(
        root.as_deref().unwrap_or(cwd),
        status.ref_name.as_deref(),
        remotes.as_ref().ok(),
    ))
    .await
    .ok();
    Ok(VcsStatusLocalResult {
        is_repo: true,
        source_control_provider: None,
        has_primary_remote: remotes.is_ok_and(|r| !r.names.is_empty()),
        is_default_ref,
        ref_name: status.ref_name,
        has_working_tree_changes: status.changed,
        working_tree: VcsStatusLocalResultWorkingTree {
            root_path: root.map(|r| r.to_string_lossy().into_owned()),
            files,
            insertions,
            deletions,
        },
        branch_changes,
    })
}

/// The Changes totals: the working tree, untracked files included, against the merge base.
async fn branch_changes(
    cwd: &Path,
    branch: Option<&str>,
    remotes: Option<&repo::Remotes>,
) -> VcsResult<VcsStatusResultBranchChanges> {
    let mut review = repo::merge_base_with(cwd, branch, None, remotes).await?;
    if let Some(branch) = branch
        && !repo::ref_exists(cwd, &format!("refs/heads/{branch}")).await?
    {
        review = repo::MergeBase {
            base_ref: None,
            merge_base: "HEAD".into(),
        };
    }
    let untracked =
        review::prepare_untracked(cwd, &[], None, Some(UNTRACKED_TOTALS_MAX_BYTES)).await?;
    let run = |reference: String| {
        let mut command = git(
            "GitVcsDriver.statusDetails.branchChanges",
            cwd,
            [
                "diff-index".to_owned(),
                "-M".into(),
                "--numstat".into(),
                "-z".into(),
                reference,
                "--".into(),
            ],
        )
        .max_stdout(METADATA_MAX_BYTES, OnLimit::Fail);
        if let Some(index) = untracked.index() {
            command = command.env("GIT_INDEX_FILE", index.as_os_str().to_owned());
        }
        command.run()
    };
    let out = match run(review.merge_base.clone()).await {
        Ok(out) => out,
        Err(ProcessError::Exit { stderr, .. })
            if review.merge_base == "HEAD" && is_unborn_stderr(&stderr) =>
        {
            run(repo::empty_tree(cwd).await?).await?
        }
        Err(e) => return Err(e.into()),
    };
    let files = review::parse_numstat(&out.stdout_text());
    Ok(VcsStatusResultBranchChanges {
        base_ref: review.base_ref,
        insertions: files.iter().map(|f| f.additions as i64).sum(),
        deletions: files.iter().map(|f| f.deletions as i64).sum(),
    })
}

/// The upstream of the checked-out branch, as `refs/remotes/<remote>/<branch>`.
async fn upstream_ref(cwd: &Path) -> VcsResult<Option<String>> {
    Ok(repo::optional_text(git(
        "GitVcsDriver.statusDetailsRemote.upstream",
        cwd,
        ["rev-parse", "--symbolic-full-name", "@{upstream}"],
    ))
    .await?
    .filter(|u| !u.is_empty() && u != "@{upstream}"))
}

async fn count(cwd: &Path, range: String) -> u64 {
    repo::optional_text(git(
        "GitVcsDriver.computeAheadCountAgainstBase",
        cwd,
        [
            "rev-list".to_owned(),
            "--count".into(),
            "--end-of-options".into(),
            range,
        ],
    ))
    .await
    .ok()
    .flatten()
    .and_then(|n| n.parse().ok())
    .unwrap_or(0)
}

async fn ahead_of_base(cwd: &Path, branch: &str, remotes: Option<&repo::Remotes>) -> u64 {
    match repo::resolve_base_with(cwd, Some(branch), None, remotes).await {
        Ok(Some(base)) => count(cwd, format!("{}..HEAD", base.comparison_ref)).await,
        _ => 0,
    }
}

/// Fetches the remote of the current branch's upstream. Quiet, no tags, no auto gc, never
/// prompts. Failures are the caller's to log.
pub async fn fetch_upstream_remote(cwd: &Path) -> VcsResult<()> {
    let Some(head) = repo::optional_text(git(
        "GitVcsDriver.fetch",
        cwd,
        ["symbolic-ref", "--quiet", "HEAD"],
    ))
    .await?
    .filter(|h| !h.is_empty()) else {
        return Ok(());
    };
    let Some(remote) = repo::optional_text(git(
        "GitVcsDriver.fetch",
        cwd,
        [
            "for-each-ref",
            "--format=%(upstream:remotename)",
            head.as_str(),
        ],
    ))
    .await?
    .filter(|r| !r.is_empty() && r != ".") else {
        return Ok(());
    };
    git(
        "GitVcsDriver.fetch",
        cwd,
        [
            "fetch",
            "--quiet",
            "--no-tags",
            "--no-auto-gc",
            "--no-write-fetch-head",
            "--",
            remote.as_str(),
        ],
    )
    .timeout(FETCH_TIMEOUT)
    .env("GCM_INTERACTIVE", "never")
    .env("GIT_ASKPASS", "")
    .env("SSH_ASKPASS", "")
    .env("SSH_ASKPASS_REQUIRE", "never")
    .run()
    .await?;
    Ok(())
}

/// Divergence from the upstream and the default branch. `None` outside a repository.
pub async fn remote_status(cwd: &Path) -> VcsResult<Option<VcsStatusRemoteResult>> {
    Box::pin(remote_status_inner(cwd)).await
}

async fn remote_status_inner(cwd: &Path) -> VcsResult<Option<VcsStatusRemoteResult>> {
    if repo::toplevel(cwd).await?.is_none() {
        return Ok(None);
    }
    let branch = repo::current_branch(cwd).await?;
    let upstream = upstream_ref(cwd).await?;
    // Read once; shared by the default branch and both base lookups below.
    let remotes = repo::Remotes::load(cwd).await;
    let (ahead, behind) = match &upstream {
        Some(_) => {
            let counts = repo::optional_text(git(
                "GitVcsDriver.statusDetailsRemote.divergence",
                cwd,
                ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
            ))
            .await?
            .unwrap_or_default();
            let mut parts = counts
                .split_whitespace()
                .map(|n| n.parse::<u64>().unwrap_or(0));
            (parts.next().unwrap_or(0), parts.next().unwrap_or(0))
        }
        None => match &branch {
            Some(branch) => (ahead_of_base(cwd, branch, remotes.as_ref().ok()).await, 0),
            None => (0, 0),
        },
    };
    let default_branch = match &remotes {
        Ok(remotes) => repo::default_branch_with(cwd, remotes)
            .await
            .unwrap_or(None),
        Err(_) => None,
    };
    let is_default = match (&branch, &default_branch) {
        (Some(b), Some(d)) => b == d,
        (Some(b), None) => b == "main" || b == "master",
        _ => false,
    };
    let ahead_of_default = match &branch {
        None => 0,
        Some(_) if is_default => 0,
        Some(_) if upstream.is_none() => ahead,
        Some(branch) => ahead_of_base(cwd, branch, remotes.as_ref().ok()).await,
    };
    Ok(Some(VcsStatusRemoteResult {
        has_upstream: upstream.is_some(),
        ahead_count: ahead as i64,
        behind_count: behind as i64,
        ahead_of_default_count: Some(ahead_of_default as i64),
        pr: None,
    }))
}

pub async fn branch_status(cwd: &Path) -> VcsResult<VcsBranchStatus> {
    let ref_name = repo::current_branch(cwd).await?;
    let is_repo = ref_name.is_some() || repo::toplevel(cwd).await?.is_some();
    Ok(VcsBranchStatus {
        ref_name,
        is_repo: Some(is_repo),
    })
}

/// `mergeGitStatusParts`: a missing remote part counts as no upstream and no PR.
pub fn merge(
    local: VcsStatusLocalResult,
    remote: Option<VcsStatusRemoteResult>,
) -> VcsStatusResult {
    let remote = remote.unwrap_or(VcsStatusRemoteResult {
        has_upstream: false,
        ahead_count: 0,
        behind_count: 0,
        ahead_of_default_count: None,
        pr: None,
    });
    VcsStatusResult {
        is_repo: local.is_repo,
        source_control_provider: local.source_control_provider,
        has_primary_remote: local.has_primary_remote,
        is_default_ref: local.is_default_ref,
        ref_name: local.ref_name,
        has_working_tree_changes: local.has_working_tree_changes,
        working_tree: local.working_tree,
        branch_changes: local.branch_changes,
        has_upstream: remote.has_upstream,
        ahead_count: remote.ahead_count,
        behind_count: remote.behind_count,
        ahead_of_default_count: remote.ahead_of_default_count,
        pr: remote.pr,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn porcelain_reads_branch_changes_and_renames() {
        let out = "# branch.oid abc\0# branch.head feature/x\0\
                   1 .M N... 100644 100644 100644 a b src/a b.rs\0\
                   2 R. N... 100644 100644 100644 a b R100 new.rs\0old.rs\0\
                   ? notes.txt\0";
        let status = parse_porcelain(out);
        assert_eq!(status.ref_name.as_deref(), Some("feature/x"));
        assert!(status.changed);
        assert_eq!(
            status.paths,
            ["src/a b.rs", "new.rs", "old.rs", "notes.txt"]
        );

        let detached = parse_porcelain("# branch.head (detached)\0");
        assert_eq!(detached.ref_name, None);
        assert!(!detached.changed);
    }
}
